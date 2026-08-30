// Embedding generation and RAG retrieval — routes through Butterbase AI gateway.
// Uses openai/text-embedding-3-small (dim 1536) to match the
// pgvector column dimension in 004_embeddings.sql.
//
// Requires env vars:
//   BUTTERBASE_API_KEY  — personal key with ai:gateway scope
//   BUTTERBASE_APP_ID   — app ID (e.g. app_4sbi6bot2fkq)
//   BUTTERBASE_API_URL  — optional, defaults to https://api.butterbase.ai

import OpenAI from "openai";
import { DB } from "./db";

const BB_API_URL = process.env.BUTTERBASE_API_URL ?? "https://api.butterbase.ai";
const BB_APP_ID  = process.env.BUTTERBASE_APP_ID!;

const openai = new OpenAI({
  apiKey:  process.env.BUTTERBASE_API_KEY,
  baseURL: `${BB_API_URL}/v1/${BB_APP_ID}`,
});

const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIM = 1536;

export interface RagMatch {
  transaction_id: string;
  account_id: string;
  embedded_text: string;
  similarity: number;
}

// Build the canonical text representation of a transaction for embedding.
// Same format is used at insert time and at query time — must be identical.
export function buildEmbeddedText(args: {
  vendor_name: string | null;
  date: string;
  amount_usd: number;
  transaction_type: string;
  account_name?: string; // included when embedding a completed transaction for storage
}): string {
  const vendor = args.vendor_name ?? "UNKNOWN";
  const sign = args.amount_usd < 0 ? "-" : "";
  const amount = `$${sign}${Math.abs(args.amount_usd).toFixed(2)}`;
  const base = `${vendor} | ${args.date} | ${amount} | ${args.transaction_type}`;
  return args.account_name ? `${base} | ${args.account_name}` : base;
}

// Generate an embedding vector for a text string.
export async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// Query the transaction_embeddings table for semantically similar past
// transactions for a given org. Calls the find_similar_transactions()
// Postgres function defined in 004_embeddings.sql.
export async function findSimilarTransactions(
  db: DB,
  orgId: string,
  queryEmbedding: number[],
  opts: { limit?: number; minSimilarity?: number } = {}
): Promise<RagMatch[]> {
  const { limit = 10, minSimilarity = 0.75 } = opts;

  const { data, error } = await db.rpc("find_similar_transactions", {
    p_organization_id: orgId,
    p_embedding: queryEmbedding,
    p_limit: limit,
    p_min_similarity: minSimilarity,
  });

  if (error) throw new Error(`RAG query failed: ${error.message}`);
  return (data ?? []) as RagMatch[];
}

// Upsert an embedding for a categorized transaction.
// Called after every successful categorization so future transactions
// can learn from it (the memory layer).
export async function upsertTransactionEmbedding(
  db: DB,
  args: {
    organization_id: string;
    transaction_id: string;
    account_id: string;
    account_name: string;
    vendor_name: string | null;
    date: string;
    amount_usd: number;
    transaction_type: string;
  }
) {
  const embeddedText = buildEmbeddedText({
    vendor_name: args.vendor_name,
    date: args.date,
    amount_usd: args.amount_usd,
    transaction_type: args.transaction_type,
    account_name: args.account_name,
  });

  const embedding = await embed(embeddedText);

  const { error } = await db.from("transaction_embeddings").upsert(
    {
      organization_id: args.organization_id,
      transaction_id: args.transaction_id,
      account_id: args.account_id,
      embedded_text: embeddedText,
      embedding,
    },
    { onConflict: "transaction_id" }
  );

  if (error) throw new Error(`upsertTransactionEmbedding failed: ${error.message}`);
}

// Check whether RAG matches alone are confident enough to categorize,
// without an LLM call. Returns the winning account_id or null.
export function resolveFromRag(
  matches: RagMatch[],
  confidenceThreshold: number
): { account_id: string; confidence: number; match_ids: string[]; scores: number[] } | null {
  if (matches.length === 0) return null;

  // Count votes per account_id, weighted by similarity
  const votes = new Map<string, number>();
  for (const m of matches) {
    votes.set(m.account_id, (votes.get(m.account_id) ?? 0) + m.similarity);
  }

  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const totalWeight = [...votes.values()].reduce((s, v) => s + v, 0);
  const topWeight = sorted[0][1];
  const confidence = topWeight / totalWeight;

  if (confidence < confidenceThreshold) return null;

  // Verify top result similarity is strong enough on its own
  const topMatch = matches.find((m) => m.account_id === sorted[0][0]);
  if (!topMatch || topMatch.similarity < 0.88) return null;

  return {
    account_id: sorted[0][0],
    confidence,
    match_ids: matches.map((m) => m.transaction_id),
    scores: matches.map((m) => m.similarity),
  };
}
