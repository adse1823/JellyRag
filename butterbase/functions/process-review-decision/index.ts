// process-review-decision
//
// Handles a human reviewer's decision on a flagged transaction.
// Called from the frontend when the controller clicks Accept,
// Override, or adds a vendor rule.
//
// Input:
//   {
//     review_queue_id: string,
//     reviewer_id: string,
//     account_id: string,         // the accepted or overridden category
//     add_vendor_rule?: boolean,  // if true, create a vendor rule for this vendor
//   }
//
// Steps:
//   1. Load queue item + transaction
//   2. Insert categorization_event (triggered_by = 'human')
//   3. Update transaction: categorized
//   4. Close review queue item
//   5. Optionally create vendor rule
//   6. Check vendor rule inference (3+ same decisions = auto-rule)
//   7. Embed transaction for future RAG

import {
  getServiceClient,
  getTransaction,
  insertCategorizationEvent,
  updateTransactionCategorized,
} from "../_shared/db";
import { handler as generateEmbeddings } from "../generate-embeddings/index";

interface Input {
  review_queue_id: string;
  reviewer_id: string;
  account_id: string;
  add_vendor_rule?: boolean;
}

interface Output {
  ok: boolean;
  vendor_rule_created?: boolean;
  auto_rule_inferred?: boolean;
}

export async function handler(input: Input): Promise<Output> {
  const db = getServiceClient();

  // ── 1. Load queue item ────────────────────────────────────────
  const { data: queueItem, error: qErr } = await db
    .from("review_queue")
    .select("*, transactions(id, organization_id, vendor_name, amount_usd, transaction_type, date)")
    .eq("id", input.review_queue_id)
    .eq("status", "pending")
    .single();

  if (qErr || !queueItem) throw new Error(`Queue item not found: ${input.review_queue_id}`);

  const tx = await getTransaction(db, queueItem.transaction_id);
  const orgId = tx.organization_id;

  // Determine if this is an override (different from suggestion) or acceptance
  const wasOverride =
    queueItem.suggested_account_id && queueItem.suggested_account_id !== input.account_id;

  // ── 2. Insert categorization event ───────────────────────────
  const catEventId = await insertCategorizationEvent(db, {
    organization_id: orgId,
    transaction_id: tx.id,
    triggered_by: "human",
    account_id: input.account_id,
    confidence: 1.0,
    reasoning: wasOverride
      ? `Human override: changed from suggested category`
      : `Human accepted AI suggestion`,
    reviewer_id: input.reviewer_id,
    reviewed_at: new Date().toISOString(),
    overrode_suggestion: wasOverride ? queueItem.suggested_account_id : null,
  });

  // ── 3. Update transaction ─────────────────────────────────────
  await db
    .from("transactions")
    .update({
      account_id: input.account_id,
      category_status: "categorized",
      categorized_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tx.id);

  // ── 4. Close review queue item ────────────────────────────────
  await db
    .from("review_queue")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: input.reviewer_id,
      resolution_event_id: catEventId,
    })
    .eq("id", input.review_queue_id);

  // ── 5. Create vendor rule (explicit) ──────────────────────────
  let vendorRuleCreated = false;
  if (input.add_vendor_rule && tx.vendor_name) {
    const { error: ruleErr } = await db.from("vendor_rules").upsert(
      {
        organization_id: orgId,
        vendor_pattern: tx.vendor_name.toUpperCase().trim(),
        match_type: "exact",
        account_id: input.account_id,
        confidence: 1.0,
        created_by: input.reviewer_id,
      },
      { onConflict: "organization_id,vendor_pattern" }
    );
    if (!ruleErr) vendorRuleCreated = true;
  }

  // ── 6. Vendor rule inference (automatic) ─────────────────────
  // If the same vendor has been manually categorized the same way 3+ times
  // without an explicit rule, auto-create one.
  let autoRuleInferred = false;
  if (!vendorRuleCreated && tx.vendor_name) {
    autoRuleInferred = await inferVendorRule(db, orgId, tx.vendor_name, input.account_id);
  }

  // ── 7. Embed for future RAG ───────────────────────────────────
  await generateEmbeddings({ transaction_id: tx.id });

  return {
    ok: true,
    vendor_rule_created: vendorRuleCreated,
    auto_rule_inferred: autoRuleInferred,
  };
}

// Auto-infer a vendor rule when the same vendor has been human-categorized
// consistently 3+ times without an existing rule.
async function inferVendorRule(
  db: ReturnType<typeof getServiceClient>,
  orgId: string,
  vendorName: string,
  accountId: string
): Promise<boolean> {
  const normalizedVendor = vendorName.toUpperCase().trim();

  // Check if a rule already exists for this vendor
  const { data: existing } = await db
    .from("vendor_rules")
    .select("id")
    .eq("organization_id", orgId)
    .eq("vendor_pattern", normalizedVendor)
    .maybeSingle();

  if (existing) return false; // rule already exists

  // Count human decisions for this vendor + same account
  const { data: decisions, error } = await db
    .from("categorization_events")
    .select("id")
    .eq("organization_id", orgId)
    .eq("triggered_by", "human")
    .eq("account_id", accountId)
    .filter(
      "transaction_id",
      "in",
      `(SELECT id FROM transactions WHERE organization_id = '${orgId}' AND vendor_name ILIKE '${normalizedVendor}')`
    );

  if (error || !decisions || decisions.length < 3) return false;

  const { error: ruleErr } = await db.from("vendor_rules").insert({
    organization_id: orgId,
    vendor_pattern: normalizedVendor,
    match_type: "exact",
    account_id: accountId,
    confidence: 1.0,
    created_by: null, // system-inferred
  });

  return !ruleErr;
}
