-- ============================================================
-- 001_tables.sql
-- Core schema for the Accounting Agent.
-- Apply in order: 001 → 002 → 003 → 004
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
-- uuid_generate_v4() alternative; gen_random_uuid() is built-in
-- in Postgres 13+. pgvector is handled in 004_embeddings.sql.

-- ── Organizations ────────────────────────────────────────────
-- Top-level tenant. One e-commerce company = one organization.

CREATE TABLE organizations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  settings   JSONB       NOT NULL DEFAULT '{
    "hitl_amount_threshold_usd": 500,
    "hitl_confidence_threshold": 0.85,
    "strict_month_end": false,
    "monthly_llm_budget_usd": 50
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Users ────────────────────────────────────────────────────
-- Controllers / CFOs. Scoped to one organization.

CREATE TABLE users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT        NOT NULL UNIQUE,
  role            TEXT        NOT NULL DEFAULT 'member'
                              CHECK (role IN ('owner', 'member')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Integration Connections ───────────────────────────────────
-- OAuth tokens for QBO and Shopify. One row per provider per org.
-- Tokens are encrypted at rest by Butterbase.

CREATE TABLE integration_connections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('qbo', 'shopify')),
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'expired', 'revoked')),

  -- QBO
  qbo_realm_id     TEXT,
  qbo_company_name TEXT,

  -- Shopify
  shopify_domain   TEXT,
  shopify_shop_name TEXT,

  -- OAuth tokens
  access_token     TEXT        NOT NULL,
  refresh_token    TEXT,
  token_expires_at TIMESTAMPTZ,
  token_scope      TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, provider)
);

-- ── Chart of Accounts ─────────────────────────────────────────
-- Pulled from QBO on connect. Defines the valid category space.

CREATE TABLE chart_of_accounts (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  qbo_account_id  TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  account_type    TEXT    NOT NULL,    -- 'Expense', 'Income', 'Asset', 'Liability', 'Equity'
  account_subtype TEXT,               -- 'CostOfGoodsSold', 'OfficeExpenses', etc.
  full_name       TEXT    NOT NULL,   -- 'Cost of Goods Sold:Inventory'
  is_active       BOOLEAN NOT NULL DEFAULT true,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, qbo_account_id)
);

-- ── Transactions ──────────────────────────────────────────────
-- All financial transactions, from QBO or Shopify. Central table.

CREATE TABLE transactions (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Source
  source          TEXT           NOT NULL CHECK (source IN ('qbo', 'shopify', 'manual')),
  external_id     TEXT           NOT NULL,
  source_url      TEXT,

  -- Transaction data
  date            DATE           NOT NULL,
  description     TEXT           NOT NULL,
  vendor_name     TEXT,
  amount_usd      NUMERIC(12, 2) NOT NULL,
  transaction_type TEXT          NOT NULL CHECK (
    transaction_type IN ('expense', 'income', 'refund', 'transfer', 'fee', 'adjustment', 'payout')
  ),

  -- Categorization state
  category_status TEXT           NOT NULL DEFAULT 'pending' CHECK (
    category_status IN ('pending', 'categorized', 'in_review', 'overridden')
  ),
  account_id      UUID           REFERENCES chart_of_accounts(id),
  categorized_at  TIMESTAMPTZ,

  -- Reconciliation state
  reconciliation_status TEXT     NOT NULL DEFAULT 'unreconciled' CHECK (
    reconciliation_status IN ('unreconciled', 'matched', 'unmatched', 'excluded')
  ),
  payout_line_item_id UUID,           -- FK added after payout_line_items is created

  -- QBO write-back state
  qbo_write_status TEXT           CHECK (qbo_write_status IN ('pending', 'written', 'failed')),
  qbo_write_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),

  UNIQUE (organization_id, source, external_id)
);

-- ── Vendor Rules ──────────────────────────────────────────────
-- Deterministic per-org rules. Match → no LLM call needed.

CREATE TABLE vendor_rules (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_pattern  TEXT           NOT NULL,
  match_type      TEXT           NOT NULL DEFAULT 'exact'
                                 CHECK (match_type IN ('exact', 'prefix', 'contains')),
  account_id      UUID           NOT NULL REFERENCES chart_of_accounts(id),
  confidence      NUMERIC(3, 2)  NOT NULL DEFAULT 1.00,
  created_by      UUID           REFERENCES users(id),  -- NULL = system-inferred
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  last_applied_at TIMESTAMPTZ,
  apply_count     INTEGER        NOT NULL DEFAULT 0,

  UNIQUE (organization_id, vendor_pattern)
);

-- ── Categorization Events (Audit Trail) ───────────────────────
-- Immutable. One row per decision. Never updated.

CREATE TABLE categorization_events (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID           NOT NULL REFERENCES transactions(id),

  triggered_by    TEXT           NOT NULL CHECK (
    triggered_by IN ('vendor_rule', 'rag_match', 'llm', 'human')
  ),
  vendor_rule_id  UUID           REFERENCES vendor_rules(id),

  -- Decision
  account_id      UUID           NOT NULL REFERENCES chart_of_accounts(id),
  confidence      NUMERIC(3, 2)  NOT NULL,
  reasoning       TEXT,

  -- LLM metadata (null when triggered_by != 'llm')
  model_id        TEXT,
  prompt_hash     TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  llm_cost_usd    NUMERIC(10, 6),

  -- RAG context (null when no RAG used)
  rag_match_ids   UUID[],
  rag_scores      NUMERIC(5, 4)[],

  -- Human review (null when triggered_by != 'human')
  reviewer_id     UUID           REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  overrode_suggestion UUID       REFERENCES categorization_events(id),

  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ── Review Queue (HITL) ───────────────────────────────────────
-- Transactions waiting for human decision.

CREATE TABLE review_queue (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID           NOT NULL REFERENCES transactions(id),

  flag_reasons    TEXT[]         NOT NULL,
  flag_metadata   JSONB,

  -- AI suggestion before human acts
  suggested_account_id UUID      REFERENCES chart_of_accounts(id),
  suggested_confidence NUMERIC(3, 2),
  suggested_reasoning  TEXT,
  top_alternatives     JSONB,    -- [{account_id, name, confidence}]

  -- Queue state
  status          TEXT           NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'resolved', 'skipped')
  ),
  assigned_to     UUID           REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID           REFERENCES users(id),
  resolution_event_id UUID       REFERENCES categorization_events(id),

  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ── Channel Payouts (Shopify) ─────────────────────────────────
-- One row per Shopify payout (the bank-transfer-level event).

CREATE TABLE channel_payouts (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source                TEXT           NOT NULL DEFAULT 'shopify',
  external_id           TEXT           NOT NULL,

  payout_date           DATE           NOT NULL,
  currency              TEXT           NOT NULL DEFAULT 'USD',
  gross_amount          NUMERIC(12, 2) NOT NULL,
  fees_amount           NUMERIC(12, 2) NOT NULL,
  refunds_amount        NUMERIC(12, 2) NOT NULL,
  adjustments_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_amount            NUMERIC(12, 2) NOT NULL,

  status                TEXT           NOT NULL CHECK (
    status IN ('scheduled', 'in_transit', 'paid', 'failed', 'cancelled')
  ),
  reconciliation_status TEXT           NOT NULL DEFAULT 'pending' CHECK (
    reconciliation_status IN ('pending', 'matched', 'partial', 'unmatched')
  ),
  bank_transaction_id   UUID           REFERENCES transactions(id),

  raw_payload           JSONB,
  synced_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),

  UNIQUE (organization_id, external_id)
);

-- ── Payout Line Items ─────────────────────────────────────────
-- Individual charges, refunds, and fees within a Shopify payout.

CREATE TABLE payout_line_items (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payout_id         UUID           NOT NULL REFERENCES channel_payouts(id) ON DELETE CASCADE,

  line_type         TEXT           NOT NULL CHECK (
    line_type IN ('sale', 'refund', 'fee', 'adjustment', 'reserve', 'reserve_release')
  ),
  source_order_id   TEXT,
  source_order_name TEXT,
  description       TEXT           NOT NULL,
  amount_usd        NUMERIC(12, 2) NOT NULL,

  transaction_id    UUID           REFERENCES transactions(id),
  match_status      TEXT           NOT NULL DEFAULT 'unmatched' CHECK (
    match_status IN ('matched', 'unmatched', 'excluded')
  ),

  created_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- FK from transactions back to payout_line_items
ALTER TABLE transactions
  ADD CONSTRAINT fk_payout_line_item
  FOREIGN KEY (payout_line_item_id) REFERENCES payout_line_items(id);

-- ── Reconciliation Runs ───────────────────────────────────────
-- A recorded month-end reconciliation session.

CREATE TABLE reconciliation_runs (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start    DATE           NOT NULL,
  period_end      DATE           NOT NULL,
  status          TEXT           NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'pending_review', 'approved', 'closed')
  ),
  initiated_by    UUID           REFERENCES users(id),
  approved_by     UUID           REFERENCES users(id),
  approved_at     TIMESTAMPTZ,

  -- Summary stats
  total_transactions  INTEGER,
  auto_categorized    INTEGER,
  human_reviewed      INTEGER,
  unresolved          INTEGER,
  total_matched_usd   NUMERIC(12, 2),
  total_unmatched_usd NUMERIC(12, 2),

  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);

-- ── Cost Events ───────────────────────────────────────────────
-- Per-LLM-call cost tracking.

CREATE TABLE cost_events (
  id                      UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  categorization_event_id UUID           REFERENCES categorization_events(id),
  model_id                TEXT           NOT NULL,
  input_tokens            INTEGER        NOT NULL,
  output_tokens           INTEGER        NOT NULL,
  cost_usd                NUMERIC(10, 6) NOT NULL,
  budget_month            TEXT           NOT NULL,  -- 'YYYY-MM', e.g. '2025-08'
  created_at              TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ── Monthly Budgets ───────────────────────────────────────────
-- Per-org monthly LLM budget state. Updated after each cost_event.

CREATE TABLE monthly_budgets (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month           TEXT           NOT NULL,  -- 'YYYY-MM'
  budget_usd      NUMERIC(10, 2) NOT NULL,
  spent_usd       NUMERIC(10, 6) NOT NULL DEFAULT 0,
  status          TEXT           NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'warning', 'exhausted')
  ),

  UNIQUE (organization_id, month)
);

-- ── QBO Write Log (Idempotency) ───────────────────────────────
-- Prevents double-writes to QBO on retry.

CREATE TABLE qbo_write_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id),
  transaction_id   UUID        NOT NULL REFERENCES transactions(id),
  idempotency_key  TEXT        NOT NULL UNIQUE,  -- SHA-256(transaction_id + cat_event_id)
  qbo_response_id  TEXT,
  status           TEXT        NOT NULL CHECK (status IN ('success', 'failed')),
  attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Test Ground Truth (eval only) ────────────────────────────
-- Stores expected categories for synthetic seed data.
-- Not used in production query paths.

CREATE TABLE test_ground_truth (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  expected_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  clarity         TEXT NOT NULL CHECK (clarity IN ('clear', 'ambiguous', 'unknown')),
  UNIQUE (transaction_id)
);
