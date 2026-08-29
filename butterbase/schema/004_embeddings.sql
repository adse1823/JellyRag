-- ============================================================
-- 004_embeddings.sql
-- pgvector setup and the transaction_embeddings table.
-- Apply last (after 001, 002, 003).
--
-- This table is the per-org memory layer.
-- Each row is an embedded past transaction used for RAG lookup
-- when categorizing new transactions.
--
-- Embedding model: text-embedding-3-small (OpenAI) → dim 1536
-- If Butterbase uses a different model, update VECTOR(1536).
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Transaction Embeddings ────────────────────────────────────

CREATE TABLE transaction_embeddings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_id  UUID        NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id      UUID        NOT NULL REFERENCES chart_of_accounts(id),

  -- The text that was embedded, for debugging / re-embedding if model changes
  -- Format: "{vendor_name} | {date} | ${amount_usd} | {transaction_type} | {account_name}"
  -- Example: "COSTCO WHOLESALE #1234 | 2024-03-15 | $127.43 | expense | Office Supplies"
  embedded_text   TEXT        NOT NULL,

  embedding       VECTOR(1536) NOT NULL,
  embedded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (transaction_id)
);

-- Org-scoped filter (applied before ANN search to restrict to this org's memory)
CREATE INDEX idx_embeddings_org
  ON transaction_embeddings (organization_id);

-- IVFFlat approximate nearest-neighbor index.
-- lists = 100 is appropriate for up to ~1M rows per org.
-- For the demo scale (~2000 rows total), even a flat scan is fast;
-- this index exists to show production-readiness.
-- Rebuild with REINDEX after bulk inserts to maintain accuracy.
CREATE INDEX idx_embeddings_vector
  ON transaction_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- RLS
ALTER TABLE transaction_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON transaction_embeddings
  USING (organization_id = (auth.jwt() ->> 'organization_id')::uuid);

-- ── RAG Query Helper ──────────────────────────────────────────
-- A Postgres function that finds the top-k most similar
-- past transactions for a given embedding, scoped to one org.
-- Called by the categorize-transaction serverless function
-- via a single RPC call rather than raw SQL from the function.

CREATE OR REPLACE FUNCTION find_similar_transactions(
  p_organization_id UUID,
  p_embedding       VECTOR(1536),
  p_limit           INTEGER DEFAULT 10,
  p_min_similarity  FLOAT   DEFAULT 0.75
)
RETURNS TABLE (
  transaction_id  UUID,
  account_id      UUID,
  embedded_text   TEXT,
  similarity      FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    te.transaction_id,
    te.account_id,
    te.embedded_text,
    1 - (te.embedding <=> p_embedding) AS similarity
  FROM transaction_embeddings te
  WHERE
    te.organization_id = p_organization_id
    AND 1 - (te.embedding <=> p_embedding) >= p_min_similarity
  ORDER BY te.embedding <=> p_embedding
  LIMIT p_limit;
$$;
