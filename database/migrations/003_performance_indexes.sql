-- Migration 003: Performance indexes for high-speed local offline reports and queries
-- Non-destructive: creates composite indexes only

CREATE INDEX IF NOT EXISTS idx_orders_reports
  ON orders(restaurant_id, created_at, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_financials_lookup
  ON order_financials(order_id, restaurant_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_payments_reports
  ON payments(restaurant_id, created_at, method)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sync_queue_poll
  ON sync_queue(restaurant_id, status, retry_count);

CREATE INDEX IF NOT EXISTS idx_menu_items_pos
  ON menu_items(restaurant_id, category_id, available)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_time
  ON audit_logs(restaurant_id, created_at);
