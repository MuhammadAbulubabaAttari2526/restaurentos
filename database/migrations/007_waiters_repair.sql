-- Migration 007: converge waiter schema across older desktop builds.
-- The runner skips ADD COLUMN statements already applied by an earlier build.

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

ALTER TABLE waiters ADD COLUMN uuid TEXT;
ALTER TABLE waiters ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE waiters ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE waiters SET uuid = id,
  synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END,
  deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX IF NOT EXISTS idx_waiters_uuid ON waiters(uuid);

ALTER TABLE orders ADD COLUMN waiter_id TEXT;
ALTER TABLE orders ADD COLUMN waiter_name TEXT NOT NULL DEFAULT '';
