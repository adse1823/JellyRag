// approve-month-end
//
// Controller approves and closes a reconciliation run.
// Bulk-enqueues all categorized transactions in the period for QBO write-back.
//
// Input:  { run_id: string; approved_by: string }
// Output: { ok: boolean; transactions_queued: number }

import { getServiceClient } from "../_shared/db";
import { handler as qboWrite } from "../qbo-write-categorization/index";

export async function handler(input: { run_id: string; approved_by: string }) {
  const db = getServiceClient();
  const { run_id, approved_by } = input;

  // Load and validate the run
  const { data: run, error: runErr } = await db
    .from("reconciliation_runs")
    .select("*")
    .eq("id", run_id)
    .in("status", ["pending_review", "approved"])
    .single();

  if (runErr || !run) throw new Error(`Run ${run_id} not found or not in approvable state`);

  // Fetch all categorized transactions in the period
  const { data: transactions, error: txErr } = await db
    .from("transactions")
    .select("id, organization_id, source")
    .eq("organization_id", run.organization_id)
    .eq("category_status", "categorized")
    .in("qbo_write_status", ["pending", "failed"]) // only unwritten or failed ones
    .gte("date", run.period_start)
    .lte("date", run.period_end);

  if (txErr) throw new Error(`Transaction fetch failed: ${txErr.message}`);

  // Fetch the most recent categorization event ID for each transaction
  // (needed for idempotency key generation)
  const txIds = (transactions ?? []).map((t: { id: string }) => t.id);
  const { data: latestEvents } = await db
    .from("categorization_events")
    .select("transaction_id, id, created_at")
    .in("transaction_id", txIds)
    .order("created_at", { ascending: false });

  const latestEventByTx = new Map<string, string>();
  for (const e of latestEvents ?? []) {
    if (!latestEventByTx.has(e.transaction_id)) {
      latestEventByTx.set(e.transaction_id, e.id);
    }
  }

  // Enqueue QBO write-back for each QBO-sourced transaction
  let queued = 0;
  for (const tx of transactions ?? []) {
    if (tx.source !== "qbo") continue; // Shopify transactions don't write back to QBO

    const catEventId = latestEventByTx.get(tx.id);
    if (!catEventId) continue;

    // Fire-and-forget with error logging — don't block approval on write failures
    qboWrite({ transaction_id: tx.id, categorization_event_id: catEventId }).catch((err) =>
      console.warn(`qbo-write failed for ${tx.id}:`, err)
    );
    queued++;
  }

  // Close the run
  await db
    .from("reconciliation_runs")
    .update({
      status: "closed",
      approved_by,
      approved_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
    })
    .eq("id", run_id);

  return { ok: true, transactions_queued: queued };
}
