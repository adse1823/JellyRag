// reconcile-payout
//
// Reconciles a Shopify payout against QBO bank-side transactions.
// Implements Section 8.1 of DESIGN.md step-by-step.
//
// Input:  { payout_id: string; organization_id: string }
// Output: { matched: number; unmatched: number; flagged: number }

import { getServiceClient, insertReviewQueueItem } from "../_shared/db";

const AMOUNT_TOLERANCE = 0.01; // $0.01 tolerance for floating-point differences
const DATE_WINDOW_DAYS = 3;    // payout_date ± 3 days to find the bank transaction

export async function handler(input: {
  payout_id: string;
  organization_id: string;
}) {
  const db = getServiceClient();
  const { payout_id, organization_id } = input;

  // ── Step 1: Load payout + line items ──────────────────────────
  const { data: payout, error: payoutErr } = await db
    .from("channel_payouts")
    .select("*")
    .eq("id", payout_id)
    .eq("organization_id", organization_id)
    .single();

  if (payoutErr || !payout) throw new Error(`Payout ${payout_id} not found`);

  const { data: lineItems, error: lineErr } = await db
    .from("payout_line_items")
    .select("*")
    .eq("payout_id", payout_id);

  if (lineErr) throw new Error(`Line items fetch failed: ${lineErr.message}`);

  // ── Step 2: Find matching bank-side QBO transaction ───────────
  const payoutDate = new Date(payout.payout_date);
  const dateMin = new Date(payoutDate);
  dateMin.setDate(dateMin.getDate() - DATE_WINDOW_DAYS);
  const dateMax = new Date(payoutDate);
  dateMax.setDate(dateMax.getDate() + DATE_WINDOW_DAYS);

  const { data: candidates } = await db
    .from("transactions")
    .select("id, amount_usd, date, description")
    .eq("organization_id", organization_id)
    .eq("source", "qbo")
    .eq("transaction_type", "payout")
    .gte("date", dateMin.toISOString().split("T")[0])
    .lte("date", dateMax.toISOString().split("T")[0]);

  const bankMatch = (candidates ?? []).find(
    (t: { amount_usd: number; description: string }) =>
      Math.abs(t.amount_usd - payout.net_amount) <= AMOUNT_TOLERANCE &&
      (t.description.toUpperCase().includes("SHOPIFY") ||
        t.description.toUpperCase().includes("STRIPE"))
  );

  if (bankMatch) {
    await db
      .from("channel_payouts")
      .update({ bank_transaction_id: bankMatch.id, reconciliation_status: "matched" })
      .eq("id", payout_id);
  } else {
    // Flag the payout-level mismatch — but continue to reconcile line items
    await db
      .from("channel_payouts")
      .update({ reconciliation_status: "unmatched" })
      .eq("id", payout_id);

    await insertReviewQueueItem(db, {
      organization_id,
      transaction_id: payout_id, // using payout_id as a stand-in for the review queue
      flag_reasons: ["unmatched_payout"],
      flag_metadata: {
        payout_date: payout.payout_date,
        net_amount: payout.net_amount,
        note: "No matching bank transaction found in QBO within 3-day window",
      },
    });
  }

  // ── Step 3 + 4: Match and auto-categorize line items ──────────
  let matched = 0;
  let unmatched = 0;
  let flagged = 0;

  // Load Shopify Fees and Shopify Sales account IDs once
  const { data: feeAccount } = await db
    .from("chart_of_accounts")
    .select("id")
    .eq("organization_id", organization_id)
    .ilike("name", "%shopify fee%")
    .maybeSingle();

  const { data: salesAccount } = await db
    .from("chart_of_accounts")
    .select("id")
    .eq("organization_id", organization_id)
    .ilike("name", "%shopify sales%")
    .maybeSingle();

  const { data: refundAccount } = await db
    .from("chart_of_accounts")
    .select("id")
    .eq("organization_id", organization_id)
    .ilike("name", "%returns%")
    .maybeSingle();

  for (const line of lineItems ?? []) {
    // Disputes: always flag for human review
    if (line.line_type === "adjustment" && line.description?.toLowerCase().includes("dispute")) {
      await db
        .from("payout_line_items")
        .update({ match_status: "unmatched" })
        .eq("id", line.id);

      await insertReviewQueueItem(db, {
        organization_id,
        transaction_id: line.id,
        flag_reasons: ["dispute"],
        flag_metadata: { amount_usd: line.amount_usd, description: line.description },
      });
      flagged++;
      continue;
    }

    // Fees: deterministic — always Shopify Fees account
    if (line.line_type === "fee" && feeAccount) {
      await db
        .from("payout_line_items")
        .update({ match_status: "matched" })
        .eq("id", line.id);

      // Create a corresponding transaction for the fee
      await db.from("transactions").insert({
        organization_id,
        source: "shopify",
        external_id: `shopify-fee-${line.id}`,
        date: payout.payout_date,
        description: line.description,
        vendor_name: "SHOPIFY FEES",
        amount_usd: Math.abs(line.amount_usd),
        transaction_type: "fee",
        category_status: "categorized",
        account_id: feeAccount.id,
        categorized_at: new Date().toISOString(),
        payout_line_item_id: line.id,
      });
      matched++;
      continue;
    }

    // Sales: match to Shopify Sales income account
    if (line.line_type === "sale" && salesAccount) {
      await db
        .from("payout_line_items")
        .update({ match_status: "matched" })
        .eq("id", line.id);
      matched++;
      continue;
    }

    // Refunds: match to Returns & Allowances
    if (line.line_type === "refund" && refundAccount) {
      await db
        .from("payout_line_items")
        .update({ match_status: "matched" })
        .eq("id", line.id);
      matched++;
      continue;
    }

    // Reserve holds: flag for visibility (not an error, but unusual)
    if (line.line_type === "reserve" || line.line_type === "reserve_release") {
      await insertReviewQueueItem(db, {
        organization_id,
        transaction_id: line.id,
        flag_reasons: ["reserve_hold"],
        flag_metadata: { amount_usd: line.amount_usd, description: line.description },
      });
      flagged++;
      continue;
    }

    // Anything else: flag as unmatched
    await db
      .from("payout_line_items")
      .update({ match_status: "unmatched" })
      .eq("id", line.id);
    unmatched++;
  }

  // ── Step 5: Update payout reconciliation status ───────────────
  if (unmatched === 0 && flagged === 0 && bankMatch) {
    await db
      .from("channel_payouts")
      .update({ reconciliation_status: "matched" })
      .eq("id", payout_id);
  } else if (matched > 0) {
    await db
      .from("channel_payouts")
      .update({ reconciliation_status: "partial" })
      .eq("id", payout_id);
  }

  return { matched, unmatched, flagged };
}
