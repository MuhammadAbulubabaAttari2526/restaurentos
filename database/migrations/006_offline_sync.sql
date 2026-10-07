-- Migration 006: durable sync metadata for registry-backed collections.
-- Preserve existing primary keys so deployed Firestore document IDs do not change.

ALTER TABLE settings ADD COLUMN uuid TEXT;
ALTER TABLE settings ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE settings ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE settings SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_settings_uuid ON settings(uuid);

ALTER TABLE categories ADD COLUMN uuid TEXT;
ALTER TABLE categories ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE categories ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE categories SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_categories_uuid ON categories(uuid);

ALTER TABLE menu_items ADD COLUMN uuid TEXT;
ALTER TABLE menu_items ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE menu_items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE menu_items SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_menu_items_uuid ON menu_items(uuid);

ALTER TABLE tables ADD COLUMN uuid TEXT;
ALTER TABLE tables ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE tables ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE tables SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_tables_uuid ON tables(uuid);

ALTER TABLE reservations ADD COLUMN uuid TEXT;
ALTER TABLE reservations ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE reservations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE reservations SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_reservations_uuid ON reservations(uuid);

ALTER TABLE orders ADD COLUMN uuid TEXT;
ALTER TABLE orders ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE orders ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE orders SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_orders_uuid ON orders(uuid);

ALTER TABLE order_financials ADD COLUMN uuid TEXT;
ALTER TABLE order_financials ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE order_financials ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE order_financials SET uuid = order_id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_order_financials_uuid ON order_financials(uuid);

ALTER TABLE payments ADD COLUMN uuid TEXT;
ALTER TABLE payments ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE payments ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE payments SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_payments_uuid ON payments(uuid);

ALTER TABLE customers ADD COLUMN uuid TEXT;
ALTER TABLE customers ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE customers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE customers SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_customers_uuid ON customers(uuid);

ALTER TABLE waiters ADD COLUMN uuid TEXT;
ALTER TABLE waiters ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE waiters ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE waiters SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_waiters_uuid ON waiters(uuid);

ALTER TABLE inventory ADD COLUMN uuid TEXT;
ALTER TABLE inventory ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE inventory ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE inventory SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_inventory_uuid ON inventory(uuid);

ALTER TABLE stock_movements ADD COLUMN uuid TEXT;
ALTER TABLE stock_movements ADD COLUMN updated_at TEXT;
ALTER TABLE stock_movements ADD COLUMN deleted_at TEXT;
ALTER TABLE stock_movements ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
ALTER TABLE stock_movements ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
UPDATE stock_movements SET uuid = id, updated_at = created_at, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_stock_movements_uuid ON stock_movements(uuid);

ALTER TABLE suppliers ADD COLUMN uuid TEXT;
ALTER TABLE suppliers ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE suppliers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE suppliers SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_suppliers_uuid ON suppliers(uuid);

ALTER TABLE purchases ADD COLUMN uuid TEXT;
ALTER TABLE purchases ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE purchases ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE purchases SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_purchases_uuid ON purchases(uuid);

ALTER TABLE expenses ADD COLUMN uuid TEXT;
ALTER TABLE expenses ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE expenses ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE expenses SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_expenses_uuid ON expenses(uuid);

ALTER TABLE draft_orders ADD COLUMN uuid TEXT;
ALTER TABLE draft_orders ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE draft_orders ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE draft_orders SET uuid = id, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END, deleted = CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_draft_orders_uuid ON draft_orders(uuid);

ALTER TABLE audit_logs ADD COLUMN uuid TEXT;
ALTER TABLE audit_logs ADD COLUMN updated_at TEXT;
ALTER TABLE audit_logs ADD COLUMN deleted_at TEXT;
ALTER TABLE audit_logs ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
ALTER TABLE audit_logs ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
UPDATE audit_logs SET uuid = id, updated_at = created_at, synced = CASE WHEN sync_status = 'pending' THEN 0 ELSE 1 END;
CREATE UNIQUE INDEX idx_audit_logs_uuid ON audit_logs(uuid);

ALTER TABLE printers ADD COLUMN uuid TEXT;
ALTER TABLE printers ADD COLUMN deleted_at TEXT;
ALTER TABLE printers ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced';
ALTER TABLE printers ADD COLUMN synced INTEGER NOT NULL DEFAULT 1 CHECK (synced IN (0, 1));
ALTER TABLE printers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1));
UPDATE printers SET uuid = id;
CREATE UNIQUE INDEX idx_printers_uuid ON printers(uuid);

CREATE TABLE IF NOT EXISTS sync_meta (
  collection_name TEXT PRIMARY KEY,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL
);