-- ============================================================
-- 007_oauth_states.sql
-- Short-lived table for OAuth CSRF state tokens.
-- Rows are deleted immediately after use (single-use).
-- Expired rows are cleaned up by a periodic job or on read.
-- ============================================================

CREATE TABLE oauth_states (
  state           TEXT        PRIMARY KEY,
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        TEXT        NOT NULL CHECK (provider IN ('qbo', 'shopify')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-expire: Postgres doesn't do TTL natively, but this index
-- makes a cleanup job efficient:
--   DELETE FROM oauth_states WHERE expires_at < now();
CREATE INDEX idx_oauth_states_expires ON oauth_states (expires_at);
