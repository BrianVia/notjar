CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  started_at   INTEGER NOT NULL,   -- ms epoch, first event
  last_at      INTEGER NOT NULL,   -- ms epoch, last event
  entry_url    TEXT,
  exit_url     TEXT,
  referrer     TEXT,
  ua           TEXT,
  country      TEXT,
  viewport     TEXT,
  pages        INTEGER NOT NULL DEFAULT 0,
  events       INTEGER NOT NULL DEFAULT 0,
  chunks       INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  rage_clicks  INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_site_started ON sessions (site, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions (last_at);
