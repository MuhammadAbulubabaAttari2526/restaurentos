-- Migration 005: Waiters management module and order waiter assignment
-- Non-destructive: adds waiters table and waiter columns to orders

CREATE TABLE IF NOT EXISTS waiters (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'synced',
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_waiters_restaurant ON waiters(restaurant_id, deleted_at);

ALTER TABLE orders ADD COLUMN waiter_id TEXT;
ALTER TABLE orders ADD COLUMN waiter_name TEXT NOT NULL DEFAULT '';
