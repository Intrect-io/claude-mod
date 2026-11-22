-- The OAuth token pair, also kept in KV (TOKENS): it is written to both and the copy with the
-- later saved_at wins on read, so a refreshed pair survives when one of the two writes fails.
CREATE TABLE IF NOT EXISTS oauth_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);
