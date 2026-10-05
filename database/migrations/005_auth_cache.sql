-- Migration 005: auth_cache table for offline login support
-- Stores scrypt-hashed credentials so users can log in when Firebase is unreachable.
-- timing-safe compare is done in the main process (Node crypto.timingSafeEqual).
-- IMPORTANT: appId and productName in package.json MUST remain 'com.restaurantos.pos' / 'RestaurantOS'
--            so that this file lives in the correct Electron userData path across updates.

CREATE TABLE IF NOT EXISTS auth_cache (
  uid               TEXT PRIMARY KEY,               -- Firebase UID
  email             TEXT UNIQUE NOT NULL,           -- lowercase email
  display_name      TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'waiter'
                        CHECK(role IN ('owner','manager','cashier','waiter')),
  restaurant_id     TEXT NOT NULL,
  permissions_json  TEXT NOT NULL DEFAULT '[]',

  -- scrypt hash of last known Firebase password
  scrypt_hash       TEXT,                           -- hex-encoded derived key
  scrypt_salt       TEXT,                           -- hex-encoded random salt (32 bytes)
  scrypt_n          INTEGER NOT NULL DEFAULT 16384, -- CPU cost (N)
  scrypt_r          INTEGER NOT NULL DEFAULT 8,     -- block size (r)
  scrypt_p          INTEGER NOT NULL DEFAULT 1,     -- parallelization (p)
  scrypt_keylen     INTEGER NOT NULL DEFAULT 64,    -- output length in bytes

  -- Lockout tracking (prevents brute-force offline attacks)
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,                           -- ISO-8601 UTC; NULL = not locked

  -- Online/offline token for local session restore
  last_token        TEXT,                           -- last known Firebase ID token (encrypted)
  last_token_cached_at TEXT,                        -- ISO-8601 UTC when token was cached

  -- Timestamps
  cached_at         TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_cache_email ON auth_cache(email);
CREATE INDEX IF NOT EXISTS idx_auth_cache_restaurant ON auth_cache(restaurant_id);
