// shopify-payout-sync
//
// Pulls Shopify Payments payouts and their line-level transactions.
// Upserts into channel_payouts + payout_line_items.
// Enqueues each new payout for reconciliation.
//
// Input:  { organization_id: string; since_date?: string }
// Output: { payouts_synced: number; line_items_synced: number }

import { getServiceClient } from "../_shared/db";
import { getShopifyConnection, fetchPayouts, fetchPayoutTransactions, ShopifyPayout, ShopifyPayoutTransaction } from "../_shared/shopify-client";
import { handler as reconcile } from "../reconcile-payout/index";

export async function handler(input: {
  organization_id: string;
  since_date?: string;
}) {
  const db = getServiceClient();
  const orgId = input.organization_id;
  const conn = await getShopifyConnection(db, orgId);

  // Default: sync last 90 days on first run
  const sinceDate = input.since_date ?? (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split("T")[0];
  })();

  const payouts = await fetchPayouts(conn, { sinceDateStr: sinceDate });

  let payoutsSynced = 0;
  let lineItemsSynced = 0;

  for (const payout of payouts) {
    // Upsert payout row
    const payoutRow = normalizeShopifyPayout(payout, orgId);
    const { data: upserted, error: payoutErr } = await db
      .from("channel_payouts")
      .upsert(payoutRow, { onConflict: "organization_id,external_id" })
      .select("id, reconciliation_status")
      .single();

    if (payoutErr || !upserted) {
      console.warn(`Payout upsert failed for ${payout.id}:`, payoutErr?.message);
      continue;
    }

    const payoutDbId: string = upserted.id;

    // Fetch and upsert line items
    let lineItems: ShopifyPayoutTransaction[];
    try {
      lineItems = await fetchPayoutTransactions(conn, payout.id);
    } catch (err) {
      console.warn(`Failed to fetch line items for payout ${payout.id}:`, err);
      continue;
    }

    const lineRows = lineItems.map((li) => normalizeLineItem(li, orgId, payoutDbId));

    if (lineRows.length > 0) {
      const BATCH = 100;
      for (let i = 0; i < lineRows.length; i += BATCH) {
        const { error } = await db
          .from("payout_line_items")
          .upsert(lineRows.slice(i, i + BATCH), {
            // No unique constraint on line items — use insert+ignore-duplicates
            ignoreDuplicates: false,
          });
        if (error) console.warn(`Line item upsert error:`, error.message);
        else lineItemsSynced += lineRows.slice(i, i + BATCH).length;
      }
    }

    // Enqueue reconciliation for newly seen payouts
    if (upserted.reconciliation_status === "pending") {
      reconcile({ payout_id: payoutDbId, organization_id: orgId }).catch((err) =>
        console.warn(`reconcile-payout failed for ${payoutDbId}:`, err)
      );
    }

    payoutsSynced++;
  }

  return { payouts_synced: payoutsSynced, line_items_synced: lineItemsSynced };
}

function normalizeShopifyPayout(p: ShopifyPayout, orgId: string) {
  const s = p.summary;
  const gross =
    parseFloat(s.charges_gross_amount) +
    parseFloat(s.adjustments_gross_amount) -
    parseFloat(s.refunds_gross_amount) -
    parseFloat(s.reserved_funds_gross_amount);

  const fees =
    parseFloat(s.charges_fee_amount) +
    parseFloat(s.adjustments_fee_amount) +
    parseFloat(s.refunds_fee_amount);

  const refunds = parseFloat(s.refunds_gross_amount);
  const adjustments = parseFloat(s.adjustments_gross_amount);
  const net = parseFloat(p.amount);

  return {
    organization_id: orgId,
    source: "shopify",
    external_id: String(p.id),
    payout_date: p.date,
    currency: p.currency,
    gross_amount: parseFloat(gross.toFixed(2)),
    fees_amount: parseFloat(fees.toFixed(2)),
    refunds_amount: parseFloat(refunds.toFixed(2)),
    adjustments_amount: parseFloat(adjustments.toFixed(2)),
    net_amount: parseFloat(net.toFixed(2)),
    status: p.status,
    reconciliation_status: "pending",
    raw_payload: p,
    synced_at: new Date().toISOString(),
  };
}

function normalizeLineItem(
  li: ShopifyPayoutTransaction,
  orgId: string,
  payoutDbId: string
) {
  const lineType = mapLineType(li.type);
  const description = buildLineDescription(li);

  return {
    organization_id: orgId,
    payout_id: payoutDbId,
    line_type: lineType,
    source_order_id: li.source_order_id ? String(li.source_order_id) : null,
    source_order_name: li.source_order_id ? `#${li.source_order_id}` : null,
    description,
    amount_usd: parseFloat(li.net),
    match_status: "unmatched",
  };
}

function mapLineType(shopifyType: string): string {
  switch (shopifyType) {
    case "payment": return "sale";
    case "refund":  return "refund";
    case "dispute": return "adjustment";
    case "reserve": return "reserve";
    case "adjustment": return "adjustment";
    case "payout":  return "sale";
    default:        return "adjustment";
  }
}

function buildLineDescription(li: ShopifyPayoutTransaction): string {
  if (li.source_order_id) return `${li.type} for order #${li.source_order_id}`;
  return `${li.type} (Shopify Payments)`;
}
