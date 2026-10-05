-- Migration 002: Local state key-value store for sync metadata
-- Stores lastPullAt per collection, app preferences, etc.
CREATE TABLE IF NOT EXISTS local_state (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_at TEXT NOT NULL
);
