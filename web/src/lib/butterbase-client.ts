import { createClient } from '@butterbase/sdk';

export const butterbase = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID as string,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL as string,
  anonKey: import.meta.env.VITE_BUTTERBASE_ANON_KEY as string,
});

// ── DB types ──────────────────────────────────────────────────────

export interface OrgSettings {
  hitl_amount_threshold_usd: number;
  hitl_confidence_threshold: number;
  strict_month_end: boolean;
  monthly_llm_budget_usd: number;
}

export interface Organization {
  id: string;
  name: string;
  owner_id: string;
  settings: OrgSettings;
  created_at: string;
}

export interface BBUser {
  id: string;
  email: string;
}

export interface Transaction {
  id: string;
  organization_id: string;
  source: 'qbo' | 'shopify' | 'manual';
  external_id: string;
  date: string;
  description: string;
  vendor_name: string | null;
  amount_usd: number;
  transaction_type: string;
  category_status: 'pending' | 'in_review' | 'categorized';
  account_id: string | null;
  reconciliation_status: 'unreconciled' | 'matched' | 'unmatched' | 'excluded';
  qbo_write_status: 'pending' | 'written' | 'failed' | null;
  categorized_at: string | null;
  payout_line_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewQueueItem {
  id: string;
  organization_id: string;
  transaction_id: string;
  status: 'pending' | 'resolved' | 'skipped';
  flag_reasons: string[];
  flag_metadata: Record<string, unknown> | null;
  suggested_account_id: string | null;
  suggested_confidence: number | null;
  suggested_reasoning: string | null;
  top_alternatives: unknown | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  // joined
  transactions?: Transaction;
}

export interface CategorizationEvent {
  id: string;
  organization_id: string;
  transaction_id: string;
  triggered_by: 'vendor_rule' | 'rag_match' | 'llm' | 'human';
  account_id: string;
  confidence: number;
  reasoning: string | null;
  model_id: string | null;
  llm_cost_usd: number | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  overrode_suggestion: string | null;
  created_at: string;
  // joined
  transactions?: Pick<Transaction, 'id' | 'description' | 'vendor_name' | 'amount_usd' | 'date'>;
  chart_of_accounts?: Pick<Account, 'id' | 'name' | 'full_name'>;
}

export interface Account {
  id: string;
  organization_id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  full_name: string;
  is_active: boolean;
}

export interface VendorRule {
  id: string;
  organization_id: string;
  vendor_pattern: string;
  match_type: 'exact' | 'prefix' | 'contains';
  account_id: string;
  confidence: number;
  apply_count: number;
  last_applied_at: string | null;
  created_at: string;
  // joined
  chart_of_accounts?: Pick<Account, 'name' | 'full_name'>;
}

export interface ChannelPayout {
  id: string;
  organization_id: string;
  source: string;
  external_id: string;
  payout_date: string;
  currency: string;
  gross_amount: number;
  fees: number;
  net_amount: number;
  reconciliation_status: 'pending' | 'matched' | 'partial' | 'unmatched';
  bank_transaction_id: string | null;
  created_at: string;
}

export interface ReconciliationRun {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  status: 'in_progress' | 'pending_review' | 'closed';
  total_transactions: number | null;
  auto_categorized: number | null;
  human_reviewed: number | null;
  unresolved: number | null;
  total_matched_usd: number | null;
  total_unmatched_usd: number | null;
  initiated_by: string;
  approved_by: string | null;
  approved_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface IntegrationConnection {
  id: string;
  organization_id: string;
  provider: 'qbo' | 'shopify';
  status: 'active' | 'expired' | 'disconnected';
  shopify_domain: string | null;
  shopify_shop_name: string | null;
  qbo_realm_id: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MonthlyBudget {
  id: string;
  organization_id: string;
  month: string;
  budget_usd: number;
  spent_usd: number;
  status: 'active' | 'warning' | 'exhausted';
}

// ── Helpers ───────────────────────────────────────────────────────

export async function getCurrentOrg(): Promise<Organization | null> {
  const { data } = await (butterbase as any)
    .from('organizations')
    .select('id, name, owner_id, settings, created_at')
    .maybeSingle();
  return data as Organization | null;
}

export async function getCurrentUser(): Promise<BBUser | null> {
  const { data } = await (butterbase as any).auth.getUser();
  return (data ?? null) as BBUser | null;
}

export async function invokeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown>
): Promise<T> {
  const { data, error } = await (butterbase as any).functions.invoke(name, { body });
  if (error) throw new Error(typeof error === 'string' ? error : error.message ?? 'Function error');
  return data as T;
}

export function fmt$$(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
