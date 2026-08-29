// categorize-transaction
//
// The core agent pipeline. Given a transaction ID, runs:
//   Step 1: Load transaction + org settings
//   Step 2: Check monthly LLM budget
//   Step 3: Vendor rule lookup (deterministic, no LLM)
//   Step 4: RAG retrieval (semantic memory)
//   Step 5: LLM categorization (if RAG insufficient)
//   Step 6: HITL gate check
//   Step 7: Write decision + update transaction
//   Step 8: Enqueue embedding for future RAG
//
// Input:  { transaction_id: string }
// Output: { status: 'categorized' | 'in_review' | 'budget_exhausted'; account_id?: string }

import {
  getServiceClient,
  getOrg,
  getTransaction,
  getActiveAccounts,
  getVendorRules,
  insertCategorizationEvent,
  updateTransactionCategorized,
  insertReviewQueueItem,
  incrementVendorRuleApplyCount,
} from "../_shared/db";
import {
  resolveModel,
  categorizationLLMCall,
  buildCategorizationPrompt,
} from "../_shared/llm";
import {
  buildEmbeddedText,
  embed,
  findSimilarTransactions,
  resolveFromRag,
  RagMatch,
} from "../_shared/embeddings";
import { handler as generateEmbeddings } from "../generate-embeddings/index";

interface Input {
  transaction_id: string;
}

interface Output {
  status: "categorized" | "in_review" | "budget_exhausted";
  account_id?: string;
  triggered_by?: string;
  confidence?: number;
}

export async function handler(input: Input): Promise<Output> {
  const db = getServiceClient();

  // ── Step 1: Load transaction + org ────────────────────────────
  const tx = await getTransaction(db, input.transaction_id);

  if (tx.category_status === "categorized") {
    return { status: "categorized", account_id: tx.account_id ?? undefined };
  }

  const org = await getOrg(db, tx.organization_id);
  const settings = org.settings;

  // ── Step 2: Check monthly budget ──────────────────────────────
  const { allowed, model } = await resolveModel(
    db,
    tx.organization_id,
    settings.monthly_llm_budget_usd
  );

  if (!allowed) {
    await flagForReview(db, tx, org, ["budget_exhausted"], null);
    return { status: "budget_exhausted" };
  }

  // ── Step 3: Vendor rule lookup ─────────────────────────────────
  const rules = await getVendorRules(db, tx.organization_id);
  const ruleMatch = matchVendorRule(rules, tx.vendor_name ?? tx.description);

  if (ruleMatch) {
    const catEventId = await insertCategorizationEvent(db, {
      organization_id: tx.organization_id,
      transaction_id: tx.id,
      triggered_by: "vendor_rule",
      vendor_rule_id: ruleMatch.id,
      account_id: ruleMatch.account_id,
      confidence: ruleMatch.confidence,
      reasoning: `Matched vendor rule: "${ruleMatch.vendor_pattern}" (${ruleMatch.match_type})`,
    });

    await updateTransactionCategorized(db, tx.id, ruleMatch.account_id, "categorized");
    await incrementVendorRuleApplyCount(db, ruleMatch.id);
    await generateEmbeddings({ transaction_id: tx.id });

    return {
      status: "categorized",
      account_id: ruleMatch.account_id,
      triggered_by: "vendor_rule",
      confidence: ruleMatch.confidence,
    };
  }

  // ── Step 4: RAG retrieval ──────────────────────────────────────
  const queryText = buildEmbeddedText({
    vendor_name: tx.vendor_name,
    date: tx.date,
    amount_usd: tx.amount_usd,
    transaction_type: tx.transaction_type,
  });
  const queryEmbedding = await embed(queryText);
  const ragMatches = await findSimilarTransactions(db, tx.organization_id, queryEmbedding, {
    limit: 10,
    minSimilarity: 0.75,
  });

  const ragResolution = resolveFromRag(ragMatches, settings.hitl_confidence_threshold);

  if (ragResolution && !hitlTriggered(tx, ragResolution.confidence, settings, ragMatches)) {
    const catEventId = await insertCategorizationEvent(db, {
      organization_id: tx.organization_id,
      transaction_id: tx.id,
      triggered_by: "rag_match",
      account_id: ragResolution.account_id,
      confidence: ragResolution.confidence,
      reasoning: `High-confidence RAG match (top similarity: ${ragMatches[0]?.similarity.toFixed(2)})`,
      rag_match_ids: ragResolution.match_ids,
      rag_scores: ragResolution.scores,
    });

    await updateTransactionCategorized(db, tx.id, ragResolution.account_id, "categorized");
    await generateEmbeddings({ transaction_id: tx.id });

    return {
      status: "categorized",
      account_id: ragResolution.account_id,
      triggered_by: "rag_match",
      confidence: ragResolution.confidence,
    };
  }

  // ── Step 5: LLM categorization ────────────────────────────────
  const accounts = await getActiveAccounts(db, tx.organization_id);

  // Build partial rule hints for prompt context (rules that partially match)
  const ruleHints = rules
    .filter((r) => partiallyMatches(r, tx.vendor_name ?? tx.description))
    .map((r) => {
      const account = accounts.find((a) => a.id === r.account_id);
      return { vendor_pattern: r.vendor_pattern, account_name: account?.name ?? "" };
    });

  // Build RAG context for prompt (top 5 matches with account names resolved)
  const ragContext = ragMatches.slice(0, 5).map((m) => {
    const account = accounts.find((a) => a.id === m.account_id);
    return { embedded_text: m.embedded_text, account_name: account?.name ?? "", similarity: m.similarity };
  });

  const prompt = buildCategorizationPrompt({
    transaction: {
      description: tx.description,
      vendor_name: tx.vendor_name,
      amount_usd: tx.amount_usd,
      date: tx.date,
      transaction_type: tx.transaction_type,
    },
    accounts,
    ragMatches: ragContext,
    vendorRuleHints: ruleHints,
  });

  const llmResult = await categorizationLLMCall(db, tx.organization_id, prompt, model);

  // Validate LLM returned a real account ID
  const validAccount = accounts.find((a) => a.id === llmResult.account_id);
  if (!validAccount) {
    // LLM hallucinated an account ID — flag for review
    await flagForReview(db, tx, org, ["llm_invalid_account"], null);
    return { status: "in_review" };
  }

  // ── Step 6: HITL gate check ────────────────────────────────────
  const flagReasons = collectFlagReasons(tx, llmResult.confidence, settings, ragMatches, llmResult.alternatives);

  if (flagReasons.length > 0) {
    const catEventId = await insertCategorizationEvent(db, {
      organization_id: tx.organization_id,
      transaction_id: tx.id,
      triggered_by: "llm",
      account_id: llmResult.account_id,
      confidence: llmResult.confidence,
      reasoning: llmResult.reasoning,
      model_id: llmResult.model_id,
      prompt_hash: llmResult.prompt_hash,
      input_tokens: llmResult.input_tokens,
      output_tokens: llmResult.output_tokens,
      llm_cost_usd: llmResult.cost_usd,
      rag_match_ids: ragMatches.map((m) => m.transaction_id),
      rag_scores: ragMatches.map((m) => m.similarity),
    });

    await flagForReview(db, tx, org, flagReasons, {
      suggested_account_id: llmResult.account_id,
      suggested_confidence: llmResult.confidence,
      suggested_reasoning: llmResult.reasoning,
      top_alternatives: llmResult.alternatives,
    });

    return { status: "in_review", triggered_by: "llm", confidence: llmResult.confidence };
  }

  // ── Step 7: Write decision ─────────────────────────────────────
  const catEventId = await insertCategorizationEvent(db, {
    organization_id: tx.organization_id,
    transaction_id: tx.id,
    triggered_by: "llm",
    account_id: llmResult.account_id,
    confidence: llmResult.confidence,
    reasoning: llmResult.reasoning,
    model_id: llmResult.model_id,
    prompt_hash: llmResult.prompt_hash,
    input_tokens: llmResult.input_tokens,
    output_tokens: llmResult.output_tokens,
    llm_cost_usd: llmResult.cost_usd,
    rag_match_ids: ragMatches.map((m) => m.transaction_id),
    rag_scores: ragMatches.map((m) => m.similarity),
  });

  await updateTransactionCategorized(db, tx.id, llmResult.account_id, "categorized");

  // ── Step 8: Embed for future RAG ───────────────────────────────
  await generateEmbeddings({ transaction_id: tx.id });

  return {
    status: "categorized",
    account_id: llmResult.account_id,
    triggered_by: "llm",
    confidence: llmResult.confidence,
  };
}

// ── Vendor rule matching ───────────────────────────────────────

interface VendorRule {
  id: string;
  vendor_pattern: string;
  match_type: "exact" | "prefix" | "contains";
  account_id: string;
  confidence: number;
}

function matchVendorRule(
  rules: VendorRule[],
  vendorName: string
): VendorRule | null {
  const normalized = vendorName.toUpperCase().trim();

  // Priority: exact > prefix > contains
  for (const matchType of ["exact", "prefix", "contains"] as const) {
    for (const rule of rules) {
      if (rule.match_type !== matchType) continue;
      const pattern = rule.vendor_pattern.toUpperCase();
      if (matchType === "exact" && normalized === pattern) return rule;
      if (matchType === "prefix" && normalized.startsWith(pattern)) return rule;
      if (matchType === "contains" && normalized.includes(pattern)) return rule;
    }
  }
  return null;
}

function partiallyMatches(rule: VendorRule, vendorName: string): boolean {
  const normalized = vendorName.toUpperCase().trim();
  const pattern = rule.vendor_pattern.toUpperCase();
  // Partial: the first 4+ chars of the pattern appear in the vendor name
  return pattern.length >= 4 && normalized.includes(pattern.slice(0, 4));
}

// ── HITL gate ─────────────────────────────────────────────────

interface OrgSettings {
  hitl_amount_threshold_usd: number;
  hitl_confidence_threshold: number;
  strict_month_end: boolean;
}

function hitlTriggered(
  tx: { amount_usd: number },
  confidence: number,
  settings: OrgSettings,
  ragMatches: RagMatch[]
): boolean {
  return collectFlagReasons(tx, confidence, settings, ragMatches, []).length > 0;
}

function collectFlagReasons(
  tx: { amount_usd: number; vendor_name: string | null },
  confidence: number,
  settings: OrgSettings,
  ragMatches: RagMatch[],
  alternatives: Array<{ confidence: number }>
): string[] {
  const reasons: string[] = [];

  if (confidence < settings.hitl_confidence_threshold) {
    reasons.push("low_confidence");
  }

  if (Math.abs(tx.amount_usd) > settings.hitl_amount_threshold_usd) {
    reasons.push("high_amount");
  }

  const hasNoRagMatch = ragMatches.length === 0 || ragMatches[0].similarity < 0.80;
  const hasNoVendorName = !tx.vendor_name;
  if (hasNoRagMatch && hasNoVendorName) {
    reasons.push("unknown_vendor");
  }

  // Too close to call: top two alternatives within 15 percentage points
  if (alternatives.length >= 2) {
    const gap = confidence - alternatives[0].confidence;
    if (gap < 0.15) reasons.push("ambiguous");
  }

  if (settings.strict_month_end) {
    reasons.push("strict_month_end");
  }

  return reasons;
}

// ── Flag for review ───────────────────────────────────────────

async function flagForReview(
  db: ReturnType<typeof getServiceClient>,
  tx: { id: string; organization_id: string; amount_usd: number },
  org: { settings: OrgSettings },
  flagReasons: string[],
  suggestion: {
    suggested_account_id?: string;
    suggested_confidence?: number;
    suggested_reasoning?: string;
    top_alternatives?: unknown;
  } | null
) {
  await updateTransactionCategorized(db, tx.id, tx.id, "in_review"); // account_id not set yet

  // Fix: update just the status without setting account_id
  await db
    .from("transactions")
    .update({ category_status: "in_review", updated_at: new Date().toISOString() })
    .eq("id", tx.id);

  await insertReviewQueueItem(db, {
    organization_id: tx.organization_id,
    transaction_id: tx.id,
    flag_reasons: flagReasons,
    flag_metadata: {
      amount_usd: tx.amount_usd,
      hitl_threshold: org.settings.hitl_confidence_threshold,
    },
    ...(suggestion ?? {}),
  });
}
