-- ============================================================
-- RestaurantOS Local SQLite Schema  v1
-- Mirrors Firestore subcollection structure per restaurant.
-- All monetary values in integer cents.
-- Timestamps stored as ISO-8601 UTC strings.
-- ============================================================

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- ============================================================
-- SYNC QUEUE (outbound Firebase sync buffer)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_queue (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL,
  collection_name TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK(action IN ('set','update','delete','operation')),
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','syncing','synced','failed')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status    ON sync_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_rec       ON sync_queue(collection_name, record_id);

-- ============================================================
-- USERS (local auth cache)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  restaurant_id      TEXT,
  email              TEXT UNIQUE NOT NULL,
  display_name       TEXT,
  password_hash      TEXT,
  salt               TEXT,
  role               TEXT NOT NULL DEFAULT 'waiter'
                         CHECK(role IN ('owner','manager','cashier','waiter')),
  permissions_json   TEXT NOT NULL DEFAULT '[]',
  active             INTEGER NOT NULL DEFAULT 1,
  session_token      TEXT,
  session_expires_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  sync_status        TEXT NOT NULL DEFAULT 'synced',
  version            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_restaurant   ON users(restaurant_id, active);

-- ============================================================
-- SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  id                    TEXT PRIMARY KEY,
  restaurant_id         TEXT NOT NULL,
  name                  TEXT NOT NULL DEFAULT '',
  currency              TEXT NOT NULL DEFAULT 'PKR',
  tax_rate              REAL NOT NULL DEFAULT 0.0,
  payment_methods_json  TEXT NOT NULL DEFAULT '["cash","card","digital"]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  sync_status           TEXT NOT NULL DEFAULT 'synced',
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_settings_restaurant ON settings(restaurant_id);

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_categories_restaurant ON categories(restaurant_id);

-- ============================================================
-- MENU ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS menu_items (
  id              TEXT PRIMARY KEY,
  restaurant_id   TEXT NOT NULL,
  category_id     TEXT,
  category_name   TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  price_cents     INTEGER NOT NULL DEFAULT 0,
  available       INTEGER NOT NULL DEFAULT 1,
  image_url       TEXT NOT NULL DEFAULT '',
  variants_json   TEXT NOT NULL DEFAULT '[]',
  add_ons_json    TEXT NOT NULL DEFAULT '[]',
  recipe_json     TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  sync_status     TEXT NOT NULL DEFAULT 'synced',
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_menu_items_category   ON menu_items(category_id, available);

-- ============================================================
-- TABLES (dining floor)
-- ============================================================
CREATE TABLE IF NOT EXISTS tables (
  id                      TEXT PRIMARY KEY,
  restaurant_id           TEXT NOT NULL,
  name                    TEXT NOT NULL,
  capacity                INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'available'
                              CHECK(status IN ('available','occupied','merged')),
  current_order_id        TEXT,
  current_reservation_id  TEXT,
  merged_table_ids_json   TEXT NOT NULL DEFAULT '[]',
  merged_table_names_json TEXT NOT NULL DEFAULT '[]',
  merged_into             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  sync_status             TEXT NOT NULL DEFAULT 'synced',
  version                 INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables(restaurant_id, deleted_at);

-- ============================================================
-- RESERVATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  table_id      TEXT NOT NULL,
  table_name    TEXT NOT NULL DEFAULT '',
  guest_name    TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  covers        INTEGER NOT NULL DEFAULT 1,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'booked'
                    CHECK(status IN ('booked','seated','cancelled','no-show')),
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_reservations_restaurant ON reservations(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_table      ON reservations(table_id, status, starts_at);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  order_number   TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'direct-bill'
                     CHECK(type IN ('dine-in','takeaway','delivery','direct-bill')),
  table_id       TEXT,
  table_name     TEXT NOT NULL DEFAULT '',
  covers         INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  items_json     TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','preparing','ready','served','cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
                     CHECK(payment_status IN
                       ('unpaid','partially_paid','paid','partially_refunded','refunded')),
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'pending',
  version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant  ON orders(restaurant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_orders_status_date ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_table       ON orders(table_id, status);

-- ============================================================
-- ORDER FINANCIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_financials (
  order_id               TEXT PRIMARY KEY,
  restaurant_id          TEXT NOT NULL,
  customer_id            TEXT,
  items_json             TEXT NOT NULL DEFAULT '[]',
  subtotal_cents         INTEGER NOT NULL DEFAULT 0,
  discount_cents         INTEGER NOT NULL DEFAULT 0,
  tax_cents              INTEGER NOT NULL DEFAULT 0,
  total_cents            INTEGER NOT NULL DEFAULT 0,
  paid_cents             INTEGER NOT NULL DEFAULT 0,
  refunded_cents         INTEGER NOT NULL DEFAULT 0,
  customer_visit_counted INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'active',
  payment_status         TEXT NOT NULL DEFAULT 'unpaid',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT,
  sync_status            TEXT NOT NULL DEFAULT 'pending',
  version                INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_financials_restaurant ON order_financials(restaurant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_financials_payment    ON order_financials(payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financials_customer   ON order_financials(customer_id, payment_status);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  order_id      TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  method        TEXT NOT NULL DEFAULT 'cash',
  kind          TEXT NOT NULL DEFAULT 'payment' CHECK(kind IN ('payment','refund')),
  reference     TEXT NOT NULL DEFAULT '',
  recorded_by   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'pending',
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_payments_order      ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_restaurant ON payments(restaurant_id, created_at DESC);

-- ============================================================
-- CUSTOMERS
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id                    TEXT PRIMARY KEY,
  restaurant_id         TEXT NOT NULL,
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  visit_count           INTEGER NOT NULL DEFAULT 0,
  total_spending_cents  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  sync_status           TEXT NOT NULL DEFAULT 'synced',
  version               INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_customers_restaurant ON customers(restaurant_id, deleted_at);

-- ============================================================
-- INVENTORY
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory (
  id                  TEXT PRIMARY KEY,
  restaurant_id       TEXT NOT NULL,
  name                TEXT NOT NULL,
  unit                TEXT NOT NULL DEFAULT 'kg',
  quantity_on_hand    REAL NOT NULL DEFAULT 0.0,
  reorder_level       REAL NOT NULL DEFAULT 0.0,
  average_cost_cents  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  sync_status         TEXT NOT NULL DEFAULT 'synced',
  version             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_inventory_restaurant ON inventory(restaurant_id, deleted_at);

-- ============================================================
-- STOCK MOVEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_movements (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  ingredient_id  TEXT NOT NULL,
  item_name      TEXT NOT NULL DEFAULT '',
  unit           TEXT NOT NULL DEFAULT '',
  movement_type  TEXT NOT NULL,
  quantity       REAL NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  sync_status    TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_stock_restaurant   ON stock_movements(restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ingredient   ON stock_movements(ingredient_id, created_at DESC);

-- ============================================================
-- SUPPLIERS
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  contact       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_suppliers_restaurant ON suppliers(restaurant_id, deleted_at);

-- ============================================================
-- PURCHASES
-- ============================================================
CREATE TABLE IF NOT EXISTS purchases (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  supplier_id    TEXT,
  supplier_name  TEXT NOT NULL DEFAULT '',
  items_json     TEXT NOT NULL DEFAULT '[]',
  total_cents    INTEGER NOT NULL DEFAULT 0,
  reference      TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'ordered',
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  received_at    TEXT,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'synced',
  version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_purchases_restaurant ON purchases(restaurant_id, deleted_at);

-- ============================================================
-- EXPENSES
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  category      TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  date          TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'cash',
  status        TEXT NOT NULL DEFAULT 'approved',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_expenses_restaurant ON expenses(restaurant_id, date DESC);

-- ============================================================
-- DRAFT ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS draft_orders (
  id             TEXT PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'direct-bill',
  table_id       TEXT,
  customer_id    TEXT,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  items_json     TEXT NOT NULL DEFAULT '[]',
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'synced',
  version        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_drafts_restaurant ON draft_orders(restaurant_id, created_by);

-- ============================================================
-- COUNTERS (daily order sequence)
-- ============================================================
CREATE TABLE IF NOT EXISTS counters (
  id             TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
  restaurant_id  TEXT NOT NULL,
  sequence_value INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_counters_restaurant ON counters(restaurant_id);

-- ============================================================
-- PRINTERS
-- ============================================================
CREATE TABLE IF NOT EXISTS printers (
  id               TEXT PRIMARY KEY,
  restaurant_id    TEXT NOT NULL,
  name             TEXT NOT NULL,
  connection_type  TEXT NOT NULL DEFAULT 'driver'
                       CHECK(connection_type IN ('driver','usb','network')),
  ip_address       TEXT NOT NULL DEFAULT '',
  port             INTEGER NOT NULL DEFAULT 9100,
  paper_width      INTEGER NOT NULL DEFAULT 80 CHECK(paper_width IN (58,80)),
  copies           INTEGER NOT NULL DEFAULT 1,
  auto_print       INTEGER NOT NULL DEFAULT 0,
  is_default       INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_printers_restaurant ON printers(restaurant_id);

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  action        TEXT NOT NULL,
  entity_id     TEXT,
  actor_id      TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  sync_status   TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_audit_restaurant ON audit_logs(restaurant_id, created_at DESC);

-- ============================================================
-- STAFF INVITATIONS (local cache)
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_invitations (
  id            TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  sync_status   TEXT NOT NULL DEFAULT 'synced',
  version       INTEGER NOT NULL DEFAULT 1
);
