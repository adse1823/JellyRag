-- ============================================================
-- 003_indexes.sql
-- Performance indexes. Apply after 001_tables.sql.
-- All indexes are non-unique (unique constraints live in 001).
-- ============================================================

-- ── transactions ─────────────────────────────────────────────
-- Hot path: fetch all pending/in_review transactions for an org
CREATE INDEX idx_transactions_org_status
  ON transactions (organization_id, category_status);

-- Hot path: dashboard date-range queries
CREATE INDEX idx_transactions_org_date
  ON transactions (organization_id, date DESC);

-- Hot path: reconciliation queries by source + org
CREATE INDEX idx_transactions_org_source
  ON transactions (organization_id, source);

-- Hot path: find unreconciled transactions
CREATE INDEX idx_transactions_reconciliation
  ON transactions (organization_id, reconciliation_status)
  WHERE reconciliation_status = 'unreconciled';

-- Hot path: QBO write-back queue
CREATE INDEX idx_transactions_qbo_write
  ON transactions (organization_id, qbo_write_status)
  WHERE qbo_write_status = 'pending';

-- ── categorization_events ────────────────────────────────────
-- Audit trail ordered by time for a transaction
CREATE INDEX idx_cat_events_transaction
  ON categorization_events (transaction_id, created_at DESC);

-- Audit trail feed for an org
CREATE INDEX idx_cat_events_org_date
  ON categorization_events (organization_id, created_at DESC);

-- Filter by triggered_by (for analytics / demo)
CREATE INDEX idx_cat_events_triggered_by
  ON categorization_events (organization_id, triggered_by);

-- ── review_queue ─────────────────────────────────────────────
-- Primary queue fetch: pending items for an org, oldest first
CREATE INDEX idx_review_queue_org_status
  ON review_queue (organization_id, status, created_at ASC)
  WHERE status = 'pending';

-- ── vendor_rules ─────────────────────────────────────────────
-- Lookup by org (full scan of small table per org is acceptable,
-- but index avoids seq scan on the full table)
CREATE INDEX idx_vendor_rules_org
  ON vendor_rules (organization_id);

-- ── chart_of_accounts ────────────────────────────────────────
-- Filter to active accounts only (used in every LLM prompt build)
CREATE INDEX idx_coa_org_active
  ON chart_of_accounts (organization_id, is_active)
  WHERE is_active = true;

-- ── channel_payouts ───────────────────────────────────────────
-- Pending reconciliation payouts
CREATE INDEX idx_payouts_org_reconciliation
  ON channel_payouts (organization_id, reconciliation_status)
  WHERE reconciliation_status = 'pending';

-- Date range queries on payouts
CREATE INDEX idx_payouts_org_date
  ON channel_payouts (organization_id, payout_date DESC);

-- ── payout_line_items ─────────────────────────────────────────
-- All line items for a given payout
CREATE INDEX idx_payout_lines_payout
  ON payout_line_items (payout_id);

-- Unmatched line items for an org
CREATE INDEX idx_payout_lines_unmatched
  ON payout_line_items (organization_id, match_status)
  WHERE match_status = 'unmatched';

-- ── cost_events ───────────────────────────────────────────────
-- Monthly rollup queries
CREATE INDEX idx_cost_events_org_month
  ON cost_events (organization_id, budget_month);

-- ── users ────────────────────────────────────────────────────
-- Lookup by org (small table but needed for RLS join paths)
CREATE INDEX idx_users_org
  ON users (organization_id);

-- ── integration_connections ───────────────────────────────────
-- Lookup active connection for a provider
CREATE INDEX idx_integrations_org_provider
  ON integration_connections (organization_id, provider)
  WHERE status = 'active';

-- ── qbo_write_log ────────────────────────────────────────────
-- Idempotency check by key (unique constraint already covers this,
-- but an explicit index makes the intent clear)
-- (already covered by the UNIQUE constraint on idempotency_key)

-- ── reconciliation_runs ───────────────────────────────────────
CREATE INDEX idx_recon_runs_org_status
  ON reconciliation_runs (organization_id, status);
