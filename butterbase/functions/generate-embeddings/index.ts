// generate-embeddings
//
// Embeds a categorized transaction and upserts it into
// transaction_embeddings so future RAG queries can use it.
//
// Called after every successful categorization (auto or human).
// Can also be run in batch to seed embeddings for existing data.
//
// Input:
//   { transaction_id: string }   — single transaction
//   { batch_org_id: string }     — embed all categorized transactions for an org

import { getServiceClient, getTransaction } from "../_shared/db";
import { upsertTransactionEmbedding } from "../_shared/embeddings";

interface Input {
  transaction_id?: string;
  batch_org_id?: string;
}

export async function handler(input: Input) {
  const db = getServiceClient();

  if (input.transaction_id) {
    await embedSingle(db, input.transaction_id);
    return { ok: true, embedded: 1 };
  }

  if (input.batch_org_id) {
    const count = await embedBatch(db, input.batch_org_id);
    return { ok: true, embedded: count };
  }

  throw new Error("Provide either transaction_id or batch_org_id");
}

async function embedSingle(db: ReturnType<typeof getServiceClient>, txId: string) {
  const tx = await getTransaction(db, txId);

  if (tx.category_status !== "categorized" || !tx.account_id) {
    throw new Error(`Transaction ${txId} is not yet categorized`);
  }

  // Fetch account name for the embedded text
  const { data: account, error } = await db
    .from("chart_of_accounts")
    .select("name")
    .eq("id", tx.account_id)
    .single();
  if (error || !account) throw new Error(`Account not found for ${tx.account_id}`);

  await upsertTransactionEmbedding(db, {
    organization_id: tx.organization_id,
    transaction_id: tx.id,
    account_id: tx.account_id,
    account_name: account.name,
    vendor_name: tx.vendor_name,
    date: tx.date,
    amount_usd: tx.amount_usd,
    transaction_type: tx.transaction_type,
  });
}

async function embedBatch(db: ReturnType<typeof getServiceClient>, orgId: string): Promise<number> {
  // Fetch all categorized transactions that don't have embeddings yet
  const { data: transactions, error } = await db
    .from("transactions")
    .select("id, organization_id, account_id, vendor_name, date, amount_usd, transaction_type")
    .eq("organization_id", orgId)
    .eq("category_status", "categorized")
    .not("account_id", "is", null);

  if (error) throw new Error(`Batch fetch failed: ${error.message}`);
  if (!transactions || transactions.length === 0) return 0;

  // Find which ones already have embeddings
  const { data: existing } = await db
    .from("transaction_embeddings")
    .select("transaction_id")
    .eq("organization_id", orgId);

  const existingIds = new Set((existing ?? []).map((e: { transaction_id: string }) => e.transaction_id));
  const pending = transactions.filter((t: { id: string }) => !existingIds.has(t.id));

  if (pending.length === 0) return 0;

  // Fetch all accounts once
  const { data: accounts } = await db
    .from("chart_of_accounts")
    .select("id, name")
    .eq("organization_id", orgId);
  const accountMap = new Map((accounts ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));

  let count = 0;
  for (const tx of pending) {
    const accountName = accountMap.get(tx.account_id) ?? "Unknown";
    try {
      await upsertTransactionEmbedding(db, {
        organization_id: tx.organization_id,
        transaction_id: tx.id,
        account_id: tx.account_id,
        account_name: accountName,
        vendor_name: tx.vendor_name,
        date: tx.date,
        amount_usd: tx.amount_usd,
        transaction_type: tx.transaction_type,
      });
      count++;
    } catch (err) {
      console.warn(`Failed to embed transaction ${tx.id}:`, err);
    }

    // Throttle: OpenAI embedding API allows ~3000 RPM on tier 1
    // For a batch seed run, a small delay avoids rate-limit errors
    await new Promise((r) => setTimeout(r, 20));
  }

  return count;
}
