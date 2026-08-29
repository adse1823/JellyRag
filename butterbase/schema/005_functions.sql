-- ============================================================
-- 005_functions.sql
-- Postgres helper functions called via RPC from serverless functions.
-- Apply after 001_tables.sql.
-- ============================================================

-- ── increment_budget_spend ────────────────────────────────────
-- Atomically adds a cost to monthly_budgets.spent_usd and
-- updates the status (active → warning → exhausted).
-- Called after every LLM response.

CREATE OR REPLACE FUNCTION increment_budget_spend(
  p_organization_id UUID,
  p_month           TEXT,
  p_cost_usd        NUMERIC
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE monthly_budgets
  SET
    spent_usd = spent_usd + p_cost_usd,
    status = CASE
      WHEN spent_usd + p_cost_usd >= budget_usd        THEN 'exhausted'
      WHEN spent_usd + p_cost_usd >= budget_usd * 0.8  THEN 'warning'
      ELSE 'active'
    END
  WHERE
    organization_id = p_organization_id
    AND month = p_month;
$$;

-- ── increment_vendor_rule_count ───────────────────────────────
-- Atomically increments vendor_rules.apply_count.
-- Called every time a vendor rule categorizes a transaction.

CREATE OR REPLACE FUNCTION increment_vendor_rule_count(
  p_rule_id UUID
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE vendor_rules
  SET apply_count = apply_count + 1
  WHERE id = p_rule_id;
$$;

-- ── count_transactions_by_status ──────────────────────────────
-- Returns pending / in_review / categorized counts for a period.
-- Called by initiate-month-end before deciding whether close can proceed.

CREATE OR REPLACE FUNCTION count_transactions_by_status(
  p_organization_id UUID,
  p_period_start    DATE,
  p_period_end      DATE
)
RETURNS TABLE (
  pending     BIGINT,
  in_review   BIGINT,
  categorized BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) FILTER (WHERE category_status = 'pending')     AS pending,
    COUNT(*) FILTER (WHERE category_status = 'in_review')   AS in_review,
    COUNT(*) FILTER (WHERE category_status = 'categorized') AS categorized
  FROM transactions
  WHERE
    organization_id = p_organization_id
    AND date BETWEEN p_period_start AND p_period_end;
$$;
