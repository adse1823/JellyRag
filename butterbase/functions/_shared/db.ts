// Typed DB client. All functions import from here — one place to
// swap the underlying client if Butterbase diverges from Supabase.

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

export type DB = SupabaseClient;

let _client: DB | null = null;

export function getServiceClient(): DB {
  if (_client) return _client;
  const url = process.env.BUTTERBASE_URL;
  const key = process.env.BUTTERBASE_SERVICE_KEY;
  if (!url || !key) throw new Error("BUTTERBASE_URL and BUTTERBASE_SERVICE_KEY are required");
  _client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: ws },
  });
  return _client;
}

// ── Typed query helpers ────────────────────────────────────────

export async function getOrg(db: DB, orgId: string) {
  const { data, error } = await db
    .from("organizations")
    .select("id, name, settings")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`getOrg failed: ${error.message}`);
  return data as {
    id: string;
    name: string;
    settings: {
      hitl_amount_threshold_usd: number;
      hitl_confidence_threshold: number;
      strict_month_end: boolean;
      monthly_llm_budget_usd: number;
    };
  };
}

export async function getTransaction(db: DB, txId: string) {
  const { data, error } = await db
    .from("transactions")
    .select("*")
    .eq("id", txId)
    .single();
  if (error) throw new Error(`getTransaction failed: ${error.message}`);
  return data as {
    id: string;
    organization_id: string;
    source: string;
    external_id: string;
    date: string;
    description: string;
    vendor_name: string | null;
    amount_usd: number;
    transaction_type: string;
    category_status: string;
    account_id: string | null;
  };
}

export async function getActiveAccounts(db: DB, orgId: string) {
  const { data, error } = await db
    .from("chart_of_accounts")
    .select("id, name, account_type, account_subtype, full_name")
    .eq("organization_id", orgId)
    .eq("is_active", true);
  if (error) throw new Error(`getActiveAccounts failed: ${error.message}`);
  return data as Array<{
    id: string;
    name: string;
    account_type: string;
    account_subtype: string | null;
    full_name: string;
  }>;
}

export async function getVendorRules(db: DB, orgId: string) {
  const { data, error } = await db
    .from("vendor_rules")
    .select("id, vendor_pattern, match_type, account_id, confidence")
    .eq("organization_id", orgId);
  if (error) throw new Error(`getVendorRules failed: ${error.message}`);
  return data as Array<{
    id: string;
    vendor_pattern: string;
    match_type: "exact" | "prefix" | "contains";
    account_id: string;
    confidence: number;
  }>;
}

export async function getMonthlyBudget(db: DB, orgId: string, month: string) {
  const { data } = await db
    .from("monthly_budgets")
    .select("id, budget_usd, spent_usd, status")
    .eq("organization_id", orgId)
    .eq("month", month)
    .maybeSingle();
  return data as { id: string; budget_usd: number; spent_usd: number; status: string } | null;
}

export async function upsertMonthlyBudget(
  db: DB,
  orgId: string,
  month: string,
  budgetUsd: number
) {
  const { error } = await db.from("monthly_budgets").upsert(
    { organization_id: orgId, month, budget_usd: budgetUsd, spent_usd: 0, status: "active" },
    { onConflict: "organization_id,month", ignoreDuplicates: true }
  );
  if (error) throw new Error(`upsertMonthlyBudget failed: ${error.message}`);
}

export async function incrementBudgetSpend(
  db: DB,
  orgId: string,
  month: string,
  costUsd: number
) {
  const budget = await getMonthlyBudget(db, orgId, month);
  const current = budget ? Number(budget.spent_usd) : 0;
  const { error } = await db
    .from("monthly_budgets")
    .update({ spent_usd: current + costUsd })
    .eq("organization_id", orgId)
    .eq("month", month);
  if (error) throw new Error(`incrementBudgetSpend failed: ${error.message}`);
}

export async function insertCategorizationEvent(
  db: DB,
  event: {
    organization_id: string;
    transaction_id: string;
    triggered_by: "vendor_rule" | "rag_match" | "llm" | "human";
    vendor_rule_id?: string | null;
    account_id: string;
    confidence: number;
    reasoning?: string | null;
    model_id?: string | null;
    prompt_hash?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    llm_cost_usd?: number | null;
    rag_match_ids?: string[] | null;
    rag_scores?: number[] | null;
    reviewer_id?: string | null;
    reviewed_at?: string | null;
    overrode_suggestion?: string | null;
  }
) {
  const { data, error } = await db
    .from("categorization_events")
    .insert(event)
    .select("id")
    .single();
  if (error) throw new Error(`insertCategorizationEvent failed: ${error.message}`);
  return data.id as string;
}

export async function updateTransactionCategorized(
  db: DB,
  txId: string,
  accountId: string,
  status: "categorized" | "in_review"
) {
  const { error } = await db
    .from("transactions")
    .update({
      account_id: accountId,
      category_status: status,
      categorized_at: status === "categorized" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", txId);
  if (error) throw new Error(`updateTransactionCategorized failed: ${error.message}`);
}

export async function insertReviewQueueItem(
  db: DB,
  item: {
    organization_id: string;
    transaction_id: string;
    flag_reasons: string[];
    flag_metadata?: object;
    suggested_account_id?: string | null;
    suggested_confidence?: number | null;
    suggested_reasoning?: string | null;
    top_alternatives?: object | null;
  }
) {
  const { error } = await db.from("review_queue").insert(item);
  if (error) throw new Error(`insertReviewQueueItem failed: ${error.message}`);
}

export async function insertCostEvent(
  db: DB,
  event: {
    organization_id: string;
    categorization_event_id?: string | null;
    model_id: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    budget_month: string;
  }
) {
  const { error } = await db.from("cost_events").insert(event);
  if (error) throw new Error(`insertCostEvent failed: ${error.message}`);
}

export async function incrementVendorRuleApplyCount(db: DB, ruleId: string) {
  const { data: rule } = await db
    .from("vendor_rules")
    .select("apply_count")
    .eq("id", ruleId)
    .single();
  const { error } = await db
    .from("vendor_rules")
    .update({
      apply_count: (rule?.apply_count ?? 0) + 1,
      last_applied_at: new Date().toISOString(),
    })
    .eq("id", ruleId);
  if (error) throw new Error(`incrementVendorRuleApplyCount failed: ${error.message}`);
}
