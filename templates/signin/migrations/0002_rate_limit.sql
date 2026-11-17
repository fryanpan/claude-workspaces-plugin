-- One row per counted sign-in attempt. src/rate-limit.ts inserts with a
-- condition and sweeps rows older than the longest window, so the table
-- holds at most 15 minutes of attempts.
CREATE TABLE rate_limit_hit (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX rate_limit_hit_key_at ON rate_limit_hit (key, at);
CREATE INDEX rate_limit_hit_at ON rate_limit_hit (at);
