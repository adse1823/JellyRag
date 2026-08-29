// initiate-month-end
//
// Starts the month-end close process for a given period.
// Implements Section 8.2 of DESIGN.md.
//
// Input:  { organization_id; period_start; period_end; initiated_by }
// Output: { run_id; status; summary }

import { getServiceClient, getOrg } from "../_shared/db";

interface Input {
  organization_id: string;
  period_start: string;   // YYYY-MM-DD
  period_end: string;     // YYYY-MM-DD
  initiated_by: string;   // user id
}

export async function handler(input: Input) {
  const db = getServiceClient();
  const { organization_id, period_start, period_end, initiated_by } = input;

  const org = await getOrg(db, organization_id);

  // ── Step 1: Create reconciliation_runs row ─────────────────────
  const { data: run, error: runErr } = await db
    .from("reconciliation_runs")
    .insert({
      organization_id,
      period_start,
      period_end,
      status: "in_progress",
      initiated_by,
    })
    .select("id")
    .single();

  if (runErr || !run) throw new Error(`Failed to create reconciliation run: ${runErr?.message}`);
  const runId: string = run.id;

  // ── Step 2: Count transaction statuses in period ───────────────
  const { data: counts } = await db.rpc("count_transactions_by_status", {
    p_organization_id: organization_id,
    p_period_start: period_start,
    p_period_end: period_end,
  });

  const summary = (counts?.[0] ?? { pending: 0, in_review: 0, categorized: 0 }) as {
    pending: number;
    in_review: number;
    categorized: number;
  };
  const total = summary.pending + summary.in_review + summary.categorized;

  // ── Step 3: If work remains, set pending_review and return ─────
  if (summary.pending > 0 || summary.in_review > 0) {
    await db
      .from("reconciliation_runs")
      .update({ status: "pending_review", total_transactions: total, unresolved: summary.pending + summary.in_review })
      .eq("id", runId);

    return {
      run_id: runId,
      status: "pending_review",
      summary: {
        total,
        categorized: summary.categorized,
        in_review: summary.in_review,
        pending: summary.pending,
        message: `${summary.pending + summary.in_review} transactions need attention before close.`,
      },
    };
  }

  // ── Step 4: All categorized — compute summary stats ────────────
  const { data: stats } = await db
    .from("transactions")
    .select("reconciliation_status, amount_usd")
    .eq("organization_id", organization_id)
    .eq("category_status", "categorized")
    .gte("date", period_start)
    .lte("date", period_end);

  const matchedUsd = (stats ?? [])
    .filter((t: { reconciliation_status: string }) => t.reconciliation_status === "matched")
    .reduce((s: number, t: { amount_usd: number }) => s + t.amount_usd, 0);

  const unmatchedUsd = (stats ?? [])
    .filter((t: { reconciliation_status: string }) => t.reconciliation_status !== "matched")
    .reduce((s: number, t: { amount_usd: number }) => s + t.amount_usd, 0);

  // Human review: auto-categorized stats
  const { data: catEvents } = await db
    .from("categorization_events")
    .select("triggered_by")
    .eq("organization_id", organization_id)
    .gte("created_at", period_start)
    .lte("created_at", period_end + "T23:59:59Z");

  const autoCat = (catEvents ?? []).filter((e: { triggered_by: string }) =>
    ["vendor_rule", "rag_match", "llm"].includes(e.triggered_by)
  ).length;
  const humanReviewed = (catEvents ?? []).filter((e: { triggered_by: string }) => e.triggered_by === "human").length;

  const runStatus = org.settings.strict_month_end ? "pending_review" : "pending_review";

  await db
    .from("reconciliation_runs")
    .update({
      status: runStatus,
      total_transactions: total,
      auto_categorized: autoCat,
      human_reviewed: humanReviewed,
      unresolved: 0,
      total_matched_usd: parseFloat(matchedUsd.toFixed(2)),
      total_unmatched_usd: parseFloat(unmatchedUsd.toFixed(2)),
    })
    .eq("id", runId);

  return {
    run_id: runId,
    status: runStatus,
    summary: {
      total,
      categorized: summary.categorized,
      auto_categorized: autoCat,
      human_reviewed: humanReviewed,
      matched_usd: matchedUsd,
      unmatched_usd: unmatchedUsd,
      message: "All transactions categorized. Awaiting controller approval to close.",
    },
  };
}
