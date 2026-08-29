-- ============================================================
-- 002_rls.sql
-- Row-Level Security policies for all org-scoped tables.
--
-- How it works:
--   The JWT issued by Butterbase Auth carries a custom claim:
--     { "organization_id": "<uuid>" }
--   Every policy extracts this claim and compares it to the
--   row's organization_id. Org A cannot see Org B's rows.
--
--   Serverless functions run with the service role key, which
--   bypasses RLS entirely — functions are trusted to scope
--   their own queries correctly.
-- ============================================================

-- ── Helper: extract org ID from JWT ──────────────────────────
-- Used in every policy. Centralise as an inline expression so
-- there's one place to update if the claim name changes.
--
--   (auth.jwt() ->> 'organization_id')::uuid
--
-- ── Enable RLS ────────────────────────────────────────────────

ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_rules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorization_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue            ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_payouts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_line_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_budgets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_write_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_ground_truth       ENABLE ROW LEVEL SECURITY;

-- organizations itself: a user can only see their own org
ALTER TABLE organizations           ENABLE ROW LEVEL SECURITY;

-- ── Policies ─────────────────────────────────────────────────
-- Pattern: SELECT/INSERT/UPDATE/DELETE all scoped to the JWT org.
-- We use a single permissive policy per table (covers all ops).
-- Split into per-operation policies only if access rules diverge
-- (e.g., members can read but not delete).

-- organizations
CREATE POLICY org_isolation ON organizations
  USING (id = (auth.jwt() ->> 'organization_id')::uuid);

-- users
CREATE POLICY org_isolation ON users
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- integration_connections
-- Only owners can view/modify integrations — enforced at the
-- application layer; RLS just enforces org scope here.
CREATE POLICY org_isolation ON integration_connections
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- chart_of_accounts
CREATE POLICY org_isolation ON chart_of_accounts
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- transactions
CREATE POLICY org_isolation ON transactions
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- vendor_rules
CREATE POLICY org_isolation ON vendor_rules
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- categorization_events — read-only for users (append-only audit trail)
-- Functions write via service key; users can only SELECT.
CREATE POLICY org_read ON categorization_events
  FOR SELECT
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- review_queue
CREATE POLICY org_isolation ON review_queue
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- channel_payouts
CREATE POLICY org_isolation ON channel_payouts
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- payout_line_items (join through payout's org)
CREATE POLICY org_isolation ON payout_line_items
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- reconciliation_runs
CREATE POLICY org_isolation ON reconciliation_runs
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- cost_events — read-only for users
CREATE POLICY org_read ON cost_events
  FOR SELECT
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- monthly_budgets
CREATE POLICY org_isolation ON monthly_budgets
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- qbo_write_log — read-only for users
CREATE POLICY org_read ON qbo_write_log
  FOR SELECT
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- test_ground_truth — only accessible within the org
CREATE POLICY org_isolation ON test_ground_truth
  USING (
    transaction_id IN (
      SELECT id FROM transactions
      WHERE organization_id = (auth.jwt() ->> 'organization_id')::uuid
    )
  );
