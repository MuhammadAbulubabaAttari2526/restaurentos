-- Store weight-based menu configuration without changing historical order lines.
ALTER TABLE menu_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'non-weight-wise';
ALTER TABLE menu_items ADD COLUMN weight_options_json TEXT NOT NULL DEFAULT '[]';
