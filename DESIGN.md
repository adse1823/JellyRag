# Accounting Agent — Full System Design

## 0. Locked Decisions

| Decision | Answer |
|---|---|
| GTM model | Direct to in-house controller / CFO at the e-commerce company |
| Accounting system (v1) | QuickBooks Online (QBO) |
| E-commerce channel (v1) | Shopify |
| Backend platform | Butterbase (butterbase.ai) |
| LLM | Claude (Anthropic) via Butterbase LLM gateway |
| Training data | QBO sample company + synthetic generation |
| Frontend | Next.js (React) |

---

## 1. System Overview

A multi-tenant AI bookkeeping agent that ingests transactions from QBO and payouts from Shopify, categorizes them using a combination of deterministic vendor rules and LLM-backed RAG, flags ambiguous or high-value transactions for human review (HITL), and writes approved categorizations back to QBO. The system maintains a per-organization memory layer (vendor rules + past categorization embeddings) that compounds over time. Every decision is logged to an immutable audit trail.

**The thesis being demonstrated:** a production stack (memory, sandboxing, cost controls, observability, retry logic, HITL gates) wrapped around an LLM is the actual differentiator — not the model itself.

---

## 2. Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Backend infra | Butterbase | Postgres + auth + RLS + REST API + S3 storage + serverless TS functions + native RAG + LLM gateway, all MCP-drivable |
| Database | Postgres (via Butterbase) | Relational model fits accounting data; pgvector for embeddings |
| Auth | Butterbase Auth | JWT, email+password, org-scoped sessions |
| Functions | Serverless TypeScript (Butterbase) | Business logic, webhook handlers, agent pipelines |
| Storage | Butterbase S3-compatible | Payout report files, audit packet documents |
| Embeddings | Butterbase native RAG | Per-org transaction embeddings for categorization memory |
| LLM | Claude claude-sonnet-4-6 (categorization) / claude-haiku-4-5 (cheap tasks) | Via Butterbase LLM gateway |
| QBO API | QuickBooks Online REST API v3 | Transaction sync and write-back |
| Shopify API | Shopify Admin REST API + Shopify Payments Balance API | Payout ingestion |
| Frontend | Next.js 14 (App Router) | Dashboard, review queue, onboarding |
| Deployment | Vercel (frontend) + Butterbase (backend) | |

**Fallback note:** if Butterbase MCP tools are unavailable at build time, Supabase is a drop-in replacement (pgvector, auth, RLS, edge functions, storage — near-identical API surface). The schema SQL is written to be portable.

---

## 3. Data Model

### 3.1 Organizations

The top-level tenant. One e-commerce company = one organization. All other tables hang off this.

```sql
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb
  -- settings shape:
  -- {
  --   "hitl_amount_threshold_usd": 500,   -- flag transactions above this amount
  --   "hitl_confidence_threshold": 0.85,  -- flag below this confidence
  --   "strict_month_end": true,           -- require human review of all before close
  --   "monthly_llm_budget_usd": 50        -- hard cap on LLM spend per month
  -- }
);
```

### 3.2 Users

Controllers and CFOs. Role is scoped to their organization.

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.3 Integration Connections

OAuth tokens for QBO and Shopify. One row per integration per organization.

```sql
CREATE TABLE integration_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('qbo', 'shopify')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),

  -- QBO-specific
  qbo_realm_id    TEXT,                     -- QuickBooks company ID
  qbo_company_name TEXT,

  -- Shopify-specific
  shopify_domain  TEXT,                     -- e.g. mystore.myshopify.com
  shopify_shop_name TEXT,

  -- OAuth tokens (encrypted at rest by Butterbase)
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  token_scope     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, provider)
);
```

### 3.4 Chart of Accounts

Pulled from QBO on connect, refreshed on demand. Defines the valid category space for an organization.

```sql
CREATE TABLE chart_of_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  qbo_account_id  TEXT NOT NULL,
  name            TEXT NOT NULL,
  account_type    TEXT NOT NULL,       -- e.g. 'Expense', 'Income', 'Asset'
  account_subtype TEXT,               -- e.g. 'CostOfGoodsSold', 'OfficeExpenses'
  is_active       BOOLEAN NOT NULL DEFAULT true,
  full_name       TEXT NOT NULL,      -- e.g. "Cost of Goods Sold:Inventory"
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, qbo_account_id)
);
```

### 3.5 Transactions

All financial transactions, sourced from QBO or Shopify. This is the central table.

```sql
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Source
  source          TEXT NOT NULL CHECK (source IN ('qbo', 'shopify', 'manual')),
  external_id     TEXT NOT NULL,           -- QBO transaction ID or Shopify order/payout ID
  source_url      TEXT,                    -- deep link back to QBO/Shopify record

  -- Transaction data
  date            DATE NOT NULL,
  description     TEXT NOT NULL,           -- raw description from source
  vendor_name     TEXT,                    -- normalized vendor name (extracted or matched)
  amount_usd      NUMERIC(12, 2) NOT NULL, -- positive = debit/expense, negative = credit/income
  transaction_type TEXT NOT NULL CHECK (
    transaction_type IN ('expense', 'income', 'refund', 'transfer', 'fee', 'adjustment', 'payout')
  ),

  -- Categorization state
  category_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    category_status IN ('pending', 'categorized', 'in_review', 'overridden')
  ),
  account_id      UUID REFERENCES chart_of_accounts(id), -- assigned category (FK to CoA)
  categorized_at  TIMESTAMPTZ,

  -- Reconciliation state
  reconciliation_status TEXT NOT NULL DEFAULT 'unreconciled' CHECK (
    reconciliation_status IN ('unreconciled', 'matched', 'unmatched', 'excluded')
  ),
  payout_line_item_id UUID,               -- set when matched to a Shopify payout line (FK added below)

  -- Write-back state
  qbo_write_status TEXT CHECK (qbo_write_status IN ('pending', 'written', 'failed')),
  qbo_write_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, source, external_id)
);

CREATE INDEX transactions_org_status ON transactions (organization_id, category_status);
CREATE INDEX transactions_org_date ON transactions (organization_id, date DESC);
```

### 3.6 Vendor Rules

Deterministic per-organization rules. When a rule matches, no LLM call is needed.

```sql
CREATE TABLE vendor_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_pattern  TEXT NOT NULL,           -- exact match or ILIKE pattern, e.g. 'COSTCO%'
  match_type      TEXT NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact', 'prefix', 'contains')),
  account_id      UUID NOT NULL REFERENCES chart_of_accounts(id),
  confidence      NUMERIC(3, 2) NOT NULL DEFAULT 1.00, -- always 1.0 for rules
  created_by      UUID REFERENCES users(id),  -- null = system-inferred, set = user-defined
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_applied_at TIMESTAMPTZ,
  apply_count     INTEGER NOT NULL DEFAULT 0,

  UNIQUE (organization_id, vendor_pattern)
);
```

### 3.7 Categorization Events (Audit Trail)

Immutable log of every categorization decision. Append-only; never updated.

```sql
CREATE TABLE categorization_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),

  -- What triggered this decision
  triggered_by    TEXT NOT NULL CHECK (
    triggered_by IN ('vendor_rule', 'rag_match', 'llm', 'human')
  ),
  vendor_rule_id  UUID REFERENCES vendor_rules(id), -- set if triggered_by = 'vendor_rule'

  -- The decision
  account_id      UUID NOT NULL REFERENCES chart_of_accounts(id),
  confidence      NUMERIC(3, 2) NOT NULL,   -- 0.00 to 1.00
  reasoning       TEXT,                     -- LLM explanation or rule description

  -- LLM metadata (null if triggered_by != 'llm')
  model_id        TEXT,
  prompt_hash     TEXT,                     -- SHA-256 of the prompt sent
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  llm_cost_usd    NUMERIC(10, 6),

  -- RAG context used (null if triggered_by != 'rag' or 'llm')
  rag_match_ids   UUID[],                   -- transaction IDs used as context
  rag_scores      NUMERIC(5, 4)[],          -- similarity scores for each match

  -- Human review (null if triggered_by != 'human')
  reviewer_id     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  overrode_suggestion UUID REFERENCES categorization_events(id), -- the event this overrides

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cat_events_transaction ON categorization_events (transaction_id, created_at DESC);
CREATE INDEX cat_events_org_date ON categorization_events (organization_id, created_at DESC);
```

### 3.8 Review Queue (HITL)

Transactions waiting for human decision. One active row per flagged transaction.

```sql
CREATE TABLE review_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),

  -- Why it was flagged
  flag_reasons    TEXT[] NOT NULL, -- e.g. ['low_confidence', 'high_amount', 'unknown_vendor']
  flag_metadata   JSONB,           -- e.g. {"confidence": 0.71, "amount_usd": 1250.00}

  -- Suggested categorization (from LLM or RAG, before human review)
  suggested_account_id  UUID REFERENCES chart_of_accounts(id),
  suggested_confidence  NUMERIC(3, 2),
  suggested_reasoning   TEXT,
  top_alternatives      JSONB, -- [{account_id, name, confidence}] top 3 alternatives

  -- Queue state
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'resolved', 'skipped')
  ),
  assigned_to     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  resolution_event_id UUID REFERENCES categorization_events(id),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (transaction_id, status) -- only one pending review per transaction
);

CREATE INDEX review_queue_org_status ON review_queue (organization_id, status, created_at);
```

### 3.9 Channel Payouts (Shopify)

One row per Shopify payout (the bank-transfer-level event).

```sql
CREATE TABLE channel_payouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source          TEXT NOT NULL DEFAULT 'shopify',
  external_id     TEXT NOT NULL,          -- Shopify payout ID

  payout_date     DATE NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  gross_amount    NUMERIC(12, 2) NOT NULL,
  fees_amount     NUMERIC(12, 2) NOT NULL,
  refunds_amount  NUMERIC(12, 2) NOT NULL,
  adjustments_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_amount      NUMERIC(12, 2) NOT NULL, -- what actually hit the bank

  status          TEXT NOT NULL CHECK (status IN ('scheduled', 'in_transit', 'paid', 'failed', 'cancelled')),
  reconciliation_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    reconciliation_status IN ('pending', 'matched', 'partial', 'unmatched')
  ),
  bank_transaction_id UUID REFERENCES transactions(id), -- the matching bank-side QBO tx

  raw_payload     JSONB,                  -- full Shopify API response for reference
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, external_id)
);
```

### 3.10 Payout Line Items

Individual charges, refunds, and fees within a Shopify payout.

```sql
CREATE TABLE payout_line_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payout_id       UUID NOT NULL REFERENCES channel_payouts(id) ON DELETE CASCADE,

  line_type       TEXT NOT NULL CHECK (
    line_type IN ('sale', 'refund', 'fee', 'adjustment', 'reserve', 'reserve_release')
  ),
  source_order_id TEXT,                   -- Shopify order ID if applicable
  source_order_name TEXT,                 -- human-readable order number e.g. #1042
  description     TEXT NOT NULL,
  amount_usd      NUMERIC(12, 2) NOT NULL,

  -- Matched to a QBO transaction (or left null if unmatched)
  transaction_id  UUID REFERENCES transactions(id),
  match_status    TEXT NOT NULL DEFAULT 'unmatched' CHECK (
    match_status IN ('matched', 'unmatched', 'excluded')
  ),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add FK back from transactions to payout_line_items
ALTER TABLE transactions
  ADD CONSTRAINT fk_payout_line_item
  FOREIGN KEY (payout_line_item_id) REFERENCES payout_line_items(id);

CREATE INDEX payout_lines_payout ON payout_line_items (payout_id);
```

### 3.11 Reconciliation Runs

A recorded month-end reconciliation session.

```sql
CREATE TABLE reconciliation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'pending_review', 'approved', 'closed')
  ),
  initiated_by    UUID REFERENCES users(id),
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,

  -- Summary stats (computed at run time)
  total_transactions  INTEGER,
  auto_categorized    INTEGER,
  human_reviewed      INTEGER,
  unresolved          INTEGER,
  total_matched_usd   NUMERIC(12, 2),
  total_unmatched_usd NUMERIC(12, 2),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);
```

### 3.12 Cost Tracking

Per-LLM-call cost events and per-organization monthly budget enforcement.

```sql
CREATE TABLE cost_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  categorization_event_id UUID REFERENCES categorization_events(id),
  model_id        TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cost_usd        NUMERIC(10, 6) NOT NULL,
  budget_month    TEXT NOT NULL,          -- e.g. '2025-08' — for easy monthly rollup
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cost_events_org_month ON cost_events (organization_id, budget_month);

-- Monthly budget state (updated by trigger or function after each cost event)
CREATE TABLE monthly_budgets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,          -- e.g. '2025-08'
  budget_usd      NUMERIC(10, 2) NOT NULL,
  spent_usd       NUMERIC(10, 6) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'warning', 'exhausted')
  ),

  UNIQUE (organization_id, month)
);
```

### 3.13 Transaction Embeddings (RAG)

Managed by Butterbase native RAG. Each row is an embedded past transaction used as memory.

```sql
CREATE TABLE transaction_embeddings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES chart_of_accounts(id),

  -- The text that was embedded (constructed from transaction data)
  embedded_text   TEXT NOT NULL,
  -- e.g. "COSTCO WHOLESALE #1234 | 2024-03-15 | $127.43 | Expense"

  embedding       VECTOR(1536),           -- pgvector; dimension matches embedding model
  embedded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (transaction_id)
);

CREATE INDEX transaction_embeddings_org ON transaction_embeddings (organization_id);
-- IVFFlat index for approximate nearest-neighbor search
CREATE INDEX transaction_embeddings_vector ON transaction_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 3.14 QBO Write Log (Idempotency)

Prevents double-writes to QBO on retries.

```sql
CREATE TABLE qbo_write_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  transaction_id      UUID NOT NULL REFERENCES transactions(id),
  idempotency_key     TEXT NOT NULL UNIQUE, -- hash of (transaction_id + categorization_event_id)
  qbo_response_id     TEXT,                 -- QBO's returned ID confirming success
  status              TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Row-Level Security (RLS)

Every table with `organization_id` gets an RLS policy. The JWT carries `organization_id` in a custom claim set at login.

```sql
-- Enable RLS on all org-scoped tables
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE qbo_write_log ENABLE ROW LEVEL SECURITY;

-- Standard policy pattern — repeat for each table
CREATE POLICY "org_isolation" ON transactions
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- Service role (used by serverless functions) bypasses RLS
-- Functions run with service key, not user JWT
```

---

## 5. Auth Architecture

### Flow

1. User signs up → Butterbase Auth creates a user record
2. On first sign-up (owner), an `organizations` row is created and `users.organization_id` is set
3. On login, Butterbase issues a JWT with standard claims + `organization_id` in the payload
4. Frontend stores the JWT; all API calls include `Authorization: Bearer <jwt>`
5. RLS enforces org isolation at the DB layer — no application-level filtering needed

### Invite Flow (for adding additional users to an org)

- Owner generates an invite link (server-side token stored in a `pending_invites` table, not defined above but trivial to add)
- Invitee clicks link → signs up → automatically joins the organization

### Integration OAuth Tokens

- QBO and Shopify OAuth tokens are stored in `integration_connections` encrypted at rest
- Functions access them with the service key, never exposed to the frontend
- Token refresh is handled by the sync functions before each API call

---

## 6. Integrations

### 6.1 QuickBooks Online (QBO)

**OAuth 2.0 setup:**
- App registered at developer.intuit.com
- Scopes: `com.intuit.quickbooks.accounting`
- Redirect URI: `https://<app>/api/auth/qbo/callback`
- Keys stored in environment variables: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`

**Connect flow (function: `qbo-oauth-init`):**
1. User clicks "Connect QuickBooks"
2. Function generates OAuth state token, stores it in a short-lived DB row
3. Redirects user to Intuit OAuth URL with state + scopes
4. Intuit redirects back to callback URL with `code` + `realmId`
5. Function (`qbo-oauth-callback`) exchanges code for access + refresh tokens
6. Stores tokens in `integration_connections`
7. Immediately triggers `qbo-initial-sync`

**Initial sync (function: `qbo-initial-sync`):**
1. Pull full chart of accounts → populate `chart_of_accounts`
2. Pull transactions for last 12 months (QBO Query API: `SELECT * FROM Purchase WHERE ...`)
3. Upsert into `transactions` table
4. Enqueue each transaction for categorization

**Transaction sync (function: `qbo-webhook-handler`):**
- QBO sends webhooks on transaction create/update
- Validate webhook signature (HMAC-SHA256)
- Fetch changed entity from QBO API
- Upsert into `transactions`
- Enqueue for categorization if not yet categorized

**Write-back (function: `qbo-write-categorization`):**
- Called after human approves or auto-categorization is confident
- Check `qbo_write_log` for existing idempotency key; skip if already written
- PATCH the QBO transaction with the new account ID
- On success: write to `qbo_write_log`, update `transactions.qbo_write_status = 'written'`
- On failure: log failure, schedule retry with exponential backoff

**Retry logic:**
```
Attempt 1: immediate
Attempt 2: 30 seconds
Attempt 3: 5 minutes
After 3 failures: mark transaction qbo_write_status = 'failed', alert reviewer
```

**Token refresh:**
- Before any QBO API call, check `token_expires_at`
- If within 5 minutes of expiry: refresh using `refresh_token`
- Update `integration_connections` with new tokens

### 6.2 Shopify

**OAuth 2.0 setup:**
- App registered at partners.shopify.com (custom app for the merchant)
- Scopes: `read_orders`, `read_financial`, `read_payments` (Shopify Payments Balance API)
- Redirect URI: `https://<app>/api/auth/shopify/callback`

**Connect flow (function: `shopify-oauth-init` / `shopify-oauth-callback`):**
- Same pattern as QBO

**Payout sync (function: `shopify-payout-sync`):**
1. Call Shopify Payments Balance API: `GET /admin/api/2024-01/shopify_payments/payouts.json`
2. For each payout not yet in `channel_payouts`: insert
3. For each payout, fetch line-level transactions: `GET /admin/api/2024-01/shopify_payments/transactions.json?payout_id=<id>`
4. Upsert into `payout_line_items`
5. Enqueue payout for reconciliation

**Shopify payout structure (important for parsing):**
```
Payout (channel_payouts row)
├── sales: sum of all order payouts in this period
├── refunds: sum of all refunds
├── fees: Shopify Payments processing fees (2.6% + 10¢ per transaction typically)
├── adjustments: chargebacks, reserve holds, reserve releases
└── net: what actually hits the bank

Each line item (payout_line_items row):
  type: "payout" | "refund" | "dispute" | "reserve" | "adjustment"
  source_order_id: Shopify order ID
  source_order_name: "#1042"
  amount: signed decimal (positive = credit, negative = debit)
  fee: associated fee for this line
  net: amount - fee
```

---

## 7. Core Agent — Categorization Pipeline

This is the central function: `categorize-transaction`. Called for each transaction that needs a category.

### 7.1 Full Pipeline (step by step)

```
Input: transaction_id

Step 1: Load transaction
  - Fetch transaction row
  - Fetch organization settings (thresholds, budget status)

Step 2: Check monthly budget
  - Query monthly_budgets for current month
  - If status = 'exhausted':
    → flag for review with reason 'budget_exhausted'
    → exit (no LLM call)

Step 3: Vendor rule lookup (deterministic, no LLM)
  - Normalize vendor_name (uppercase, strip punctuation, trim)
  - Query vendor_rules for this organization
  - Try match types in order: exact → prefix → contains
  - If match found:
    → assign category (account_id from rule)
    → confidence = 1.00
    → triggered_by = 'vendor_rule'
    → skip to Step 7 (no LLM call)

Step 4: RAG retrieval (semantic memory)
  - Construct embedded_text from transaction:
      "{vendor_name} | {date} | ${amount} | {transaction_type}"
  - Query transaction_embeddings for this org:
      ORDER BY embedding <=> query_vector
      LIMIT 10
      WHERE cosine_similarity > 0.75
  - If top result similarity > 0.92 AND top 3 all agree on same account_id:
    → triggered_by = 'rag_match'
    → confidence = weighted average of similarity scores
    → assign majority account_id
    → skip to Step 6 if confidence > hitl_confidence_threshold

Step 5: LLM categorization
  - Build prompt (see Section 7.2)
  - Call Claude via Butterbase LLM gateway
  - Parse response: {account_id, confidence, reasoning, alternatives[]}
  - Log cost to cost_events
  - Update monthly_budgets.spent_usd

Step 6: HITL gate check
  - Flag for review if ANY of the following:
    a) confidence < organization.settings.hitl_confidence_threshold (default 0.85)
    b) ABS(amount_usd) > organization.settings.hitl_amount_threshold_usd (default 500)
    c) vendor_name not found in any vendor_rule AND no RAG match > 0.80 (unknown vendor)
    d) alternatives[0].confidence - alternatives[1].confidence < 0.15 (too close to call)
    e) organization.settings.strict_month_end = true (flag everything before close)
  - If flagged:
    → insert into review_queue with flag_reasons[]
    → set transaction.category_status = 'in_review'
    → insert categorization_event with triggered_by and suggestion
    → exit

Step 7: Write decision
  - Insert categorization_event (full audit trail)
  - Update transaction.account_id, category_status = 'categorized', categorized_at = now()
  - If transaction.source = 'qbo': enqueue qbo-write-categorization

Step 8: Embed transaction for future RAG
  - Generate embedding for this transaction's embedded_text
  - Insert into transaction_embeddings
  - This is the memory: every categorized transaction improves future accuracy for this org
```

### 7.2 LLM Prompt Structure

```
System:
You are a bookkeeping assistant for an e-commerce company using QuickBooks Online.
Your job is to assign the correct QBO account category to a financial transaction.
You must respond with valid JSON only. No prose.

User:
## Transaction to categorize
Vendor: {vendor_name}
Description: {raw_description}
Amount: ${amount_usd}
Date: {date}
Type: {transaction_type}

## Chart of accounts (valid categories)
{chart_of_accounts as JSON array: [{id, name, account_type, account_subtype, full_name}]}
(filtered to active accounts relevant to transaction_type — expenses for debits, income for credits)

## Similar past transactions (memory)
{top_k RAG results as JSON array:
  [{description, vendor_name, amount, date, assigned_category_name, similarity_score}]}
(only included if RAG found matches with score > 0.75)

## Vendor rules for this organization
{matching vendor rules if partial match found}

## Response format
{
  "account_id": "<UUID from chart of accounts>",
  "confidence": <0.00 to 1.00>,
  "reasoning": "<one sentence>",
  "alternatives": [
    {"account_id": "<UUID>", "name": "<account name>", "confidence": <0.00 to 1.00>},
    {"account_id": "<UUID>", "name": "<account name>", "confidence": <0.00 to 1.00>}
  ]
}
```

**Model selection by task:**
- Complex/ambiguous transactions, large amounts: `claude-sonnet-4-6`
- Batch processing of clearly-similar transactions: `claude-haiku-4-5`
- Never use a model for transactions that a vendor rule or high-confidence RAG match can handle deterministically

### 7.3 Vendor Rule Inference

After a human reviewer resolves a transaction, the system checks whether to auto-create a vendor rule:

```
After human review resolves a transaction:
  - If the same vendor_name has been categorized the same way by humans 3+ times
    → auto-create a vendor_rule (created_by = null to indicate system-inferred)
    → notify reviewer: "Vendor rule created: COSTCO WHOLESALE → Office Supplies"
  - reviewer can override or delete the auto-rule from the UI
```

---

## 8. Reconciliation Engine

### 8.1 Shopify Payout Reconciliation (function: `reconcile-payout`)

Called when a new `channel_payouts` row arrives.

```
Input: payout_id

Step 1: Load payout and all payout_line_items

Step 2: Find matching bank-side transaction in QBO
  - Query transactions where:
      source = 'qbo'
      amount_usd ≈ payout.net_amount (within $0.01 tolerance)
      date BETWEEN payout.payout_date - 3 days AND payout.payout_date + 3 days
      description ILIKE '%SHOPIFY%' OR '%shopify payout%'
  - If exactly one match: set channel_payouts.bank_transaction_id, mark matched
  - If zero or multiple matches: flag payout for review

Step 3: Match line items to QBO transactions
  - For each payout_line_item:
    - If type = 'sale': look for QBO income transaction matching order amount
    - If type = 'refund': look for QBO refund transaction
    - If type = 'fee': these become expense transactions (Shopify Fees account)
    - If type = 'dispute': flag for human review always
    - Mark match_status accordingly

Step 4: Auto-categorize matched line items
  - Fees → "Shopify Fees" account (deterministic, always the same)
  - Sales → "Shopify Sales" income account (or per-product if product data available)
  - Refunds → reverse the original sale category
  - Disputes → human review (always)

Step 5: Generate reconciliation summary
  - Total payout gross vs net
  - Matched vs unmatched line item count and amounts
  - Unmatched items go into review_queue with flag_reasons = ['unmatched_payout_line']
```

### 8.2 Month-End Close Flow (function: `initiate-month-end`)

```
Input: organization_id, period_start, period_end, initiated_by

Step 1: Create reconciliation_runs row (status = 'in_progress')

Step 2: Check all transactions in period
  - Count pending: category_status = 'pending'
  - Count in_review: category_status = 'in_review'
  - Count categorized: category_status = 'categorized'

Step 3: If pending or in_review > 0:
  - Set run status = 'pending_review'
  - Return summary to controller: "X transactions need attention before close"

Step 4: If all categorized:
  - Compute summary stats (total matched/unmatched amounts)
  - If strict_month_end = true: require explicit approval even if all categorized
  - Set status = 'pending_review' and require human sign-off

Step 5: On approval (function: `approve-month-end`):
  - Write all approved categorizations to QBO (bulk enqueue qbo-write-categorization)
  - Set reconciliation_runs.status = 'closed', approved_by, approved_at
  - All transactions in period: qbo_write_status confirmed
```

---

## 9. HITL Review Interface (what the controller sees)

### Review Queue Item — data available per item

When a controller opens a review queue item, the UI must show:

```
Transaction details:
  - Date, description, vendor name, amount, type
  - Source (QBO / Shopify)
  - Why flagged (low confidence / high amount / unknown vendor / ambiguous)

AI suggestion:
  - Suggested category (account name + type)
  - Confidence score (as %)
  - Reasoning (one sentence from LLM)

Alternatives:
  - Top 2 alternative categories with confidence

Memory context:
  - Top 3 similar past transactions shown:
    "COSTCO WHOLESALE #456 | $112.34 | → Office Supplies | 3 months ago"

Actions:
  - Accept suggestion
  - Override: pick from chart of accounts (searchable dropdown)
  - Split transaction (advanced — mark as future TODO)
  - Add vendor rule: "Always categorize this vendor as [X]"
  - Skip (defer to later)
```

### After Human Decision

```
function: process-review-decision
Input: review_queue_id, decision: {account_id, add_vendor_rule: bool}

1. Insert categorization_event (triggered_by = 'human', reviewer_id, account_id)
2. Update transaction.account_id, category_status = 'categorized'
3. Update review_queue.status = 'resolved', resolved_by, resolved_at
4. If add_vendor_rule: insert into vendor_rules (created_by = reviewer)
5. Enqueue qbo-write-categorization
6. Enqueue generate-embeddings (embed this transaction for future RAG)
7. Check vendor rule inference (Section 7.3)
```

---

## 10. Observability

Every categorization event row is the audit trail. The UI's audit view queries `categorization_events` joined to `transactions` and `users`.

**What's always available per transaction:**
- When it was categorized, by what method
- If LLM: the prompt hash, model, tokens, cost, reasoning
- If RAG: which past transactions were used as context, similarity scores
- If vendor rule: which rule, when the rule was created and by whom
- If human: who, when, what they overrode

**Alerting (via Butterbase functions + scheduled jobs):**
- Daily: flag organizations with > 20 transactions stuck in review_queue
- Monthly: send cost summary vs budget to org owner
- On budget warning (80% spent): notify owner, switch to haiku model
- On budget exhausted: pause LLM calls, route everything to review queue, notify owner

---

## 11. Cost Controls Implementation

### Before every LLM call

```typescript
async function checkBudgetAndGetModel(orgId: string): Promise<{
  allowed: boolean;
  model: string;
  remainingUsd: number;
}> {
  const month = new Date().toISOString().slice(0, 7); // '2025-08'
  const budget = await db.monthly_budgets.findOne({ organization_id: orgId, month });
  const settings = await db.organizations.findOne({ id: orgId });

  if (!budget) {
    // First call this month — create budget row
    await db.monthly_budgets.insert({
      organization_id: orgId,
      month,
      budget_usd: settings.settings.monthly_llm_budget_usd,
      spent_usd: 0,
      status: 'active'
    });
    return { allowed: true, model: 'claude-sonnet-4-6', remainingUsd: settings.settings.monthly_llm_budget_usd };
  }

  if (budget.status === 'exhausted') return { allowed: false, model: null, remainingUsd: 0 };

  const remaining = budget.budget_usd - budget.spent_usd;
  const pctUsed = budget.spent_usd / budget.budget_usd;

  return {
    allowed: true,
    model: pctUsed > 0.8 ? 'claude-haiku-4-5' : 'claude-sonnet-4-6', // downgrade model at 80%
    remainingUsd: remaining
  };
}
```

### After every LLM call

```typescript
async function recordCost(orgId: string, catEventId: string, model: string, inputTokens: number, outputTokens: number) {
  const PRICES = {
    'claude-sonnet-4-6':  { input: 3.00 / 1e6, output: 15.00 / 1e6 },
    'claude-haiku-4-5':   { input: 0.25 / 1e6, output: 1.25 / 1e6 }
  };
  const cost = (inputTokens * PRICES[model].input) + (outputTokens * PRICES[model].output);
  const month = new Date().toISOString().slice(0, 7);

  await db.cost_events.insert({ organization_id: orgId, categorization_event_id: catEventId, model_id: model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost, budget_month: month });

  // Atomic increment on monthly_budgets
  await db.query(`
    UPDATE monthly_budgets
    SET spent_usd = spent_usd + $1,
        status = CASE
          WHEN spent_usd + $1 >= budget_usd THEN 'exhausted'
          WHEN spent_usd + $1 >= budget_usd * 0.8 THEN 'warning'
          ELSE 'active'
        END
    WHERE organization_id = $2 AND month = $3
  `, [cost, orgId, month]);
}
```

---

## 12. Test Data Strategy

### Seed Script 1: Chart of Accounts (QBO standard for e-commerce)

Hard-code the standard QBO chart of accounts categories relevant to an e-commerce seller:
- Income: Shopify Sales, Amazon Sales, Etsy Sales, Wholesale Revenue, Shipping Income
- COGS: Inventory / Product Cost, Shipping Cost of Goods
- Expenses: Shopify Fees, Payment Processing Fees, Advertising (Meta/Google), Office Supplies, Software & Subscriptions, Shipping Supplies, Returns & Allowances
- Assets: Inventory Asset, Accounts Receivable
- Liabilities: Accounts Payable, Sales Tax Payable

Seed one organization (`org_demo`) with this chart.

### Seed Script 2: Synthetic Transactions

Generate 2,000 transactions using this distribution:
- 60% clear-cut (high confidence expected): known vendors like COSTCO, USPS, GOOGLE ADS, SHOPIFY*, STRIPE TRANSFER
- 25% ambiguous: vendors that could be multiple categories (AMAZON — is it COGS or Office Supplies?), split amounts
- 10% unknown vendors: realistic-looking but not in any rule
- 5% edge cases: large amounts, negative amounts, duplicate-looking

Each transaction row has `expected_account_id` (ground truth) stored in a separate seed table `test_ground_truth` — not in `transactions` itself, only used for eval.

```typescript
// Example synthetic transaction shapes
const VENDOR_TEMPLATES = [
  { pattern: 'SHOPIFY* PAYOUT',            type: 'payout',  category: 'Shopify Sales',         clarity: 'clear' },
  { pattern: 'STRIPE TRANSFER',            type: 'transfer', category: 'Shopify Sales',         clarity: 'clear' },
  { pattern: 'COSTCO WHOLESALE #${n}',     type: 'expense', category: 'Office Supplies',        clarity: 'clear' },
  { pattern: 'USPS ${tracking}',           type: 'expense', category: 'Shipping Cost of Goods', clarity: 'clear' },
  { pattern: 'GOOGLE ADS ${id}',           type: 'expense', category: 'Advertising',            clarity: 'clear' },
  { pattern: 'AMZN MKTP US*${id}',         type: 'expense', category: 'AMBIGUOUS',              clarity: 'ambiguous' },
  { pattern: 'AMAZON WEB SERVICES',        type: 'expense', category: 'Software & Subscriptions', clarity: 'clear' },
  { pattern: 'META PLATFORMS',             type: 'expense', category: 'Advertising',            clarity: 'clear' },
  { pattern: 'SHOPIFY SUBSCRIPTION',       type: 'expense', category: 'Software & Subscriptions', clarity: 'clear' },
  { pattern: 'FEDEX ${id}',                type: 'expense', category: 'Shipping Cost of Goods', clarity: 'clear' },
  { pattern: 'ZOOM.US 888-799-9666',       type: 'expense', category: 'Software & Subscriptions', clarity: 'clear' },
  { pattern: 'UNKNOWN VENDOR ${n}',        type: 'expense', category: null,                     clarity: 'unknown' },
];
```

### Eval Harness

A function `run-categorization-eval` that:
1. Runs the categorization pipeline on all 2,000 transactions
2. Compares assigned `account_id` to `test_ground_truth.expected_account_id`
3. Outputs:
   - Overall accuracy (exact match %)
   - Accuracy by clarity tier (clear / ambiguous / unknown)
   - HITL trigger rate (% flagged for review)
   - HITL precision (of flagged, % that actually were wrong)
   - HITL recall (of wrong ones, % that were flagged)
   - Average confidence score by outcome (correct vs incorrect)
   - LLM cost for the full eval run

**Target metrics for a demo-ready system:**
- Clear transactions: > 95% exact match
- Ambiguous: > 75% (remaining go to HITL correctly)
- HITL precision: > 80% (not too many false alarms)
- HITL recall: > 90% (catches most actual errors)

---

## 13. Frontend — Screen Inventory

All screens are in Next.js App Router under `/app/`.

### `/app/onboarding/`
- Step 1: Create organization (name field)
- Step 2: Connect QBO (OAuth redirect button)
- Step 3: Connect Shopify (OAuth redirect button)
- Step 4: Set preferences (HITL thresholds, monthly budget)
- Step 5: Done — redirect to dashboard

### `/app/dashboard/`
Key metrics at a glance:
- Transactions this period: total / categorized / in review / pending
- Shopify payouts: matched / unmatched
- LLM spend this month: $X of $Y budget (progress bar)
- Review queue: count with "Go to review" CTA (badge shows urgency)
- Recent activity feed: last 10 categorization events

### `/app/review/`
HITL review queue. Sorted by: disputes first → high-amount → low-confidence → oldest.

Per-item view (described in Section 9). Keyboard shortcut support for fast triaging:
- `A` = Accept suggestion
- `O` = Open override picker
- `S` = Skip
- `R` = Add vendor rule and accept

### `/app/transactions/`
Full transaction list with filters: date range, category, status, source, amount range.
Each row links to transaction detail view showing full audit trail.

### `/app/reconciliation/`
- List of reconciliation runs (past months + current)
- Per-run: payout breakdown table, matched/unmatched status per payout
- "Initiate month-end close" button (only enabled when queue is empty or strict_mode off)
- Approval flow for close

### `/app/audit/`
Audit trail feed. Filters: date, triggered_by (vendor_rule / rag / llm / human), category.
Per-event: full detail expandable — if LLM, shows reasoning. If human, shows who and when.

### `/app/settings/`
- Organization name
- HITL thresholds (amount, confidence)
- Monthly LLM budget
- Connected integrations (QBO + Shopify, with re-connect / disconnect)
- Vendor rules list (view, edit, delete)

---

## 14. File and Folder Structure

```
/
├── butterbase/
│   ├── schema/
│   │   ├── 001_tables.sql           — all CREATE TABLE statements
│   │   ├── 002_rls.sql              — all RLS policies
│   │   ├── 003_indexes.sql          — performance indexes
│   │   └── 004_embeddings.sql       — pgvector setup + embedding table
│   ├── functions/
│   │   ├── categorize-transaction/
│   │   │   └── index.ts             — main categorization pipeline (Section 7.1)
│   │   ├── generate-embeddings/
│   │   │   └── index.ts             — embed transaction text, upsert to transaction_embeddings
│   │   ├── qbo-oauth-init/
│   │   │   └── index.ts             — generate QBO OAuth URL
│   │   ├── qbo-oauth-callback/
│   │   │   └── index.ts             — exchange code for tokens, trigger initial sync
│   │   ├── qbo-initial-sync/
│   │   │   └── index.ts             — pull CoA + last 12mo transactions
│   │   ├── qbo-webhook-handler/
│   │   │   └── index.ts             — handle QBO webhook events
│   │   ├── qbo-write-categorization/
│   │   │   └── index.ts             — idempotent write-back to QBO
│   │   ├── shopify-oauth-init/
│   │   │   └── index.ts
│   │   ├── shopify-oauth-callback/
│   │   │   └── index.ts
│   │   ├── shopify-payout-sync/
│   │   │   └── index.ts             — pull payouts + line items
│   │   ├── reconcile-payout/
│   │   │   └── index.ts             — reconciliation engine (Section 8.1)
│   │   ├── process-review-decision/
│   │   │   └── index.ts             — HITL resolution handler (Section 9)
│   │   ├── initiate-month-end/
│   │   │   └── index.ts             — month-end close flow
│   │   ├── approve-month-end/
│   │   │   └── index.ts
│   │   ├── run-categorization-eval/
│   │   │   └── index.ts             — eval harness (Section 12)
│   │   └── _shared/
│   │       ├── db.ts                — typed DB client helpers
│   │       ├── qbo-client.ts        — QBO REST API wrapper (with token refresh)
│   │       ├── shopify-client.ts    — Shopify API wrapper
│   │       ├── llm.ts               — LLM call wrapper (budget check + cost recording)
│   │       ├── embeddings.ts        — embedding generation + RAG query helpers
│   │       └── idempotency.ts       — idempotency key generation + check
│   └── seed/
│       ├── 01_chart_of_accounts.ts  — standard e-commerce QBO chart
│       ├── 02_synthetic_transactions.ts — 2,000 synthetic transactions + ground truth
│       └── 03_vendor_rules.ts       — initial vendor rules for demo org
│
└── web/
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx                 — redirect to /dashboard or /onboarding
    │   ├── onboarding/
    │   │   └── page.tsx
    │   ├── dashboard/
    │   │   └── page.tsx
    │   ├── review/
    │   │   ├── page.tsx             — queue list
    │   │   └── [id]/page.tsx        — individual review item
    │   ├── transactions/
    │   │   ├── page.tsx
    │   │   └── [id]/page.tsx
    │   ├── reconciliation/
    │   │   ├── page.tsx
    │   │   └── [id]/page.tsx
    │   ├── audit/
    │   │   └── page.tsx
    │   └── settings/
    │       └── page.tsx
    ├── components/
    │   ├── TransactionRow.tsx
    │   ├── ReviewItem.tsx
    │   ├── AuditEntry.tsx
    │   ├── BudgetMeter.tsx
    │   ├── ReconciliationTable.tsx
    │   └── ui/                      — shared primitives (buttons, inputs, badges)
    └── lib/
        ├── butterbase-client.ts     — typed API client for Butterbase REST
        └── utils.ts
```

---

## 15. Build Order (with dependencies)

Dependencies flow top-to-bottom. Each phase can start once the one above it is complete.

```
Phase 1 — Schema + Auth
  1a. Write and apply schema SQL (001–004)
  1b. Configure Butterbase auth (org-scoped JWT claim)
  1c. Apply RLS policies
  1d. Verify: create test org, create user, confirm RLS blocks cross-org reads

Phase 2 — Seed Data
  2a. Seed chart of accounts for demo org
  2b. Seed 2,000 synthetic transactions (with ground truth table)
  2c. Seed initial vendor rules (clear-cut ones)
  → At end of Phase 2: demo org has a realistic dataset, no integrations needed yet

Phase 3 — Core Categorization (no integrations)
  3a. _shared/llm.ts + _shared/embeddings.ts
  3b. generate-embeddings function
  3c. categorize-transaction function (all steps: vendor rule → RAG → LLM → HITL gate)
  3d. Run eval harness on seeded data — establish baseline metrics
  → This is the core value. Everything else is delivery mechanism and UI.

Phase 4 — HITL + Review Queue
  4a. process-review-decision function
  4b. Vendor rule inference logic
  4c. Re-embed transactions after human decision

Phase 5 — Production Stack
  5a. Cost controls (monthly_budgets + cost_events + model downgrade)
  5b. Audit trail queries
  5c. QBO write-back with idempotency (qbo-write-categorization)
  5d. Retry logic wrapper in _shared/

Phase 6 — QBO Integration
  6a. qbo-client.ts (API wrapper, token refresh)
  6b. OAuth init + callback functions
  6c. qbo-initial-sync (CoA pull + transaction backfill)
  6d. qbo-webhook-handler
  → Can now run against a real QBO sandbox company (developer.intuit.com provides one)

Phase 7 — Shopify Integration
  7a. shopify-client.ts
  7b. OAuth init + callback
  7c. shopify-payout-sync
  7d. reconcile-payout
  7e. Month-end close flow

Phase 8 — Frontend
  8a. Butterbase client + auth wiring
  8b. Onboarding flow
  8c. Dashboard
  8d. Review queue (most important screen — shows the HITL gate working)
  8e. Audit trail view (shows observability)
  8f. Transactions list
  8g. Reconciliation view
  8h. Settings (vendor rules, thresholds, integrations)

Phase 9 — Demo Polish
  9a. Run full eval harness, document results
  9b. Seed a "3 months in" state: org with many vendor rules, good RAG memory
  9c. Create a demo script: walk through a new transaction arriving → auto-categorized,
      then a flagged one → reviewed by human → vendor rule auto-created
```

---

## 16. Notes for Implementation

- **Butterbase MCP tools:** use them to define schema, RLS, and functions directly from this document. If MCP tools are unavailable, fall back to Supabase CLI (`supabase db push` for schema, `supabase functions deploy` for edge functions).

- **QBO sandbox:** developer.intuit.com provides a free sandbox company with sample data. Use this for all QBO integration testing — no real money, no real OAuth user needed.

- **Shopify dev store:** partners.shopify.com provides free development stores. Use one for Shopify OAuth + payout testing. Shopify Payments in sandbox mode generates fake payouts.

- **LLM costs in dev:** use `claude-haiku-4-5` exclusively during development to keep eval runs cheap. Switch to `claude-sonnet-4-6` only for final eval and demo.

- **Embedding model:** use whatever Butterbase exposes natively. If they use `text-embedding-3-small` (OpenAI), the vector dimension is 1536 — matches the schema above. If different, update the `VECTOR(1536)` dimension accordingly.

- **The demo narrative:** the system's story is told by showing three things: (1) a clear transaction auto-categorized instantly with a vendor rule, zero LLM cost; (2) an ambiguous transaction flagged for review with the LLM's reasoning and top RAG matches shown; (3) a human resolving it and a vendor rule being auto-created so it never flags again. That arc is the thesis.
