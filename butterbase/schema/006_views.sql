-- ============================================================
-- 006_views.sql
-- Read-side views for the frontend.
-- Apply after 001–005.
-- ============================================================

-- ── audit_trail_view ──────────────────────────────────────────
-- Joins categorization_events with all referenced entities so
-- the frontend can render the full audit trail in one query.

CREATE OR REPLACE VIEW audit_trail_view AS
SELECT
  ce.id                        AS event_id,
  ce.organization_id,
  ce.transaction_id,
  ce.triggered_by,
  ce.confidence,
  ce.reasoning,
  ce.created_at                AS decided_at,

  -- Transaction details
  t.date                       AS tx_date,
  t.description                AS tx_description,
  t.vendor_name                AS tx_vendor,
  t.amount_usd                 AS tx_amount,
  t.transaction_type           AS tx_type,
  t.source                     AS tx_source,

  -- Assigned account
  a.id                         AS account_id,
  a.name                       AS account_name,
  a.account_type               AS account_type,
  a.full_name                  AS account_full_name,

  -- LLM metadata (null when triggered_by != 'llm')
  ce.model_id,
  ce.input_tokens,
  ce.output_tokens,
  ce.llm_cost_usd,

  -- RAG context (null when no RAG used)
  ce.rag_match_ids,
  ce.rag_scores,

  -- Vendor rule (null when triggered_by != 'vendor_rule')
  vr.vendor_pattern            AS rule_pattern,
  vr.match_type                AS rule_match_type,

  -- Human reviewer (null when triggered_by != 'human')
  ce.reviewer_id,
  u.email                      AS reviewer_email,
  ce.reviewed_at,
  ce.overrode_suggestion

FROM categorization_events ce
JOIN transactions t           ON t.id = ce.transaction_id
JOIN chart_of_accounts a      ON a.id = ce.account_id
LEFT JOIN vendor_rules vr     ON vr.id = ce.vendor_rule_id
LEFT JOIN users u             ON u.id = ce.reviewer_id;

-- ── review_queue_view ─────────────────────────────────────────
-- Pending review items with all data the UI needs pre-joined.

CREATE OR REPLACE VIEW review_queue_view AS
SELECT
  rq.id                        AS queue_id,
  rq.organization_id,
  rq.transaction_id,
  rq.flag_reasons,
  rq.flag_metadata,
  rq.status,
  rq.created_at                AS flagged_at,
  rq.assigned_to,

  -- Transaction details
  t.date                       AS tx_date,
  t.description                AS tx_description,
  t.vendor_name                AS tx_vendor,
  t.amount_usd                 AS tx_amount,
  t.transaction_type           AS tx_type,
  t.source                     AS tx_source,

  -- AI suggestion
  rq.suggested_account_id,
  sa.name                      AS suggested_account_name,
  sa.full_name                 AS suggested_account_full_name,
  rq.suggested_confidence,
  rq.suggested_reasoning,
  rq.top_alternatives

FROM review_queue rq
JOIN transactions t            ON t.id = rq.transaction_id
LEFT JOIN chart_of_accounts sa ON sa.id = rq.suggested_account_id;

-- ── dashboard_summary (function, not a view) ─────────────────
-- Returns a single-row summary for the dashboard metrics widget.
-- Called per-org via RPC: SELECT * FROM dashboard_summary('org-uuid', '2024-01', '2024-12')

CREATE OR REPLACE FUNCTION dashboard_summary(
  p_organization_id UUID,
  p_period_start    DATE,
  p_period_end      DATE
)
RETURNS TABLE (
  total_transactions     BIGINT,
  categorized            BIGINT,
  in_review              BIGINT,
  pending                BIGINT,
  auto_categorized       BIGINT,
  human_reviewed         BIGINT,
  payouts_matched        BIGINT,
  payouts_unmatched      BIGINT,
  llm_spend_this_month   NUMERIC,
  llm_budget_this_month  NUMERIC,
  budget_status          TEXT,
  review_queue_count     BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    -- Transaction counts
    COUNT(*)                                                         AS total_transactions,
    COUNT(*) FILTER (WHERE category_status = 'categorized')         AS categorized,
    COUNT(*) FILTER (WHERE category_status = 'in_review')           AS in_review,
    COUNT(*) FILTER (WHERE category_status = 'pending')             AS pending,

    -- Auto vs human (join to most recent categorization_event per transaction)
    COUNT(*) FILTER (WHERE category_status = 'categorized'
      AND (SELECT triggered_by FROM categorization_events ce
           WHERE ce.transaction_id = t.id
           ORDER BY ce.created_at DESC LIMIT 1) IN ('vendor_rule', 'rag_match', 'llm')
    )                                                                AS auto_categorized,
    COUNT(*) FILTER (WHERE category_status = 'categorized'
      AND (SELECT triggered_by FROM categorization_events ce
           WHERE ce.transaction_id = t.id
           ORDER BY ce.created_at DESC LIMIT 1) = 'human'
    )                                                                AS human_reviewed,

    -- Payout reconciliation
    (SELECT COUNT(*) FROM channel_payouts cp
     WHERE cp.organization_id = p_organization_id
       AND cp.payout_date BETWEEN p_period_start AND p_period_end
       AND cp.reconciliation_status = 'matched')                    AS payouts_matched,
    (SELECT COUNT(*) FROM channel_payouts cp
     WHERE cp.organization_id = p_organization_id
       AND cp.payout_date BETWEEN p_period_start AND p_period_end
       AND cp.reconciliation_status IN ('pending', 'unmatched'))    AS payouts_unmatched,

    -- Budget
    (SELECT spent_usd FROM monthly_budgets mb
     WHERE mb.organization_id = p_organization_id
       AND mb.month = to_char(now(), 'YYYY-MM'))                    AS llm_spend_this_month,
    (SELECT budget_usd FROM monthly_budgets mb
     WHERE mb.organization_id = p_organization_id
       AND mb.month = to_char(now(), 'YYYY-MM'))                    AS llm_budget_this_month,
    (SELECT status FROM monthly_budgets mb
     WHERE mb.organization_id = p_organization_id
       AND mb.month = to_char(now(), 'YYYY-MM'))                    AS budget_status,

    -- Review queue
    (SELECT COUNT(*) FROM review_queue rq
     WHERE rq.organization_id = p_organization_id
       AND rq.status = 'pending')                                   AS review_queue_count

  FROM transactions t
  WHERE t.organization_id = p_organization_id
    AND t.date BETWEEN p_period_start AND p_period_end;
$$;
