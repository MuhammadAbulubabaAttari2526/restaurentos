/*
RestaurantOS (Electron + SQLite + Firebase sync) ke review mein ye bugs/gaps mile hain. Inko ek-ek karke fix karo. Existing UI/design, web (Firebase) version, aur jo kaam kar raha hai usay mat todna. Sirf zaroori, minimal changes. Har fix ke baad test chalao (npm test, npm run test:electron, aur related headless tests), aur result report karo. Har group (A, B, C, D) ke baad ruko aur meri approval lo.

SHURU KARNE SE PEHLE
- Git branch banao (fix/review-bugs). Pehle sab pending changes commit karo.
- Kuch bhi Firebase par deploy ya delete mat karna.

GROUP A: SYNC KI RELIABILITY (sabse zaroori)

A1. Firebase token expire hone ka masla
- Abhi token sirf login par main process ko jata hai (src/context/AuthContext.jsx, onAuthStateChanged). ~1 ghante baad token expire ho jata hai aur sync ruk jata hai.
- onIdTokenChanged use karo taake har token refresh par window.posApi.sync.setCredentials dobara call ho. Token ko main process mein expiry ke saath rakho.
- Renderer window khuli ho tab tak har ~45 min mein token force refresh karke bhejo.
- Agar token invalid ho (REST 401/403), to syncWorker status 'auth-required' dikhaye, queue pause kare aur retry_count BADHAYE NAHI. Naya token milte hi sync khud resume ho.

A2. Retry logic (sync/syncWorker.cjs)
- Abhi retry_count 5 hone par item hamesha ke liye skip ho jata hai. Isay badlo: failed items par time-based exponential backoff (e.g. 15s, 30s, 1m, 5m, max 15 min), lekin item kabhi permanently drop na ho. (sync_queue ka status CHECK constraint ('pending','syncing','synced','failed') hai, isay mat tod na. Backoff updated_at + retry_count se compute karo.)
- Network errors aur 5xx par retry_count mat badhao jab tak actual rejection na ho. Validation/permission rejection (400/403 rules wali) ko 'failed' rakho aur last_error mein wajah likho, aur UI mein "N items need attention" dikhao.

A3. Stuck 'syncing' items
- App startup par sync_queue mein jo items 'syncing' status mein hon (app beech mein band hui) unhein 'pending' karo. Ye worker start hone se pehle ek baar ho.

A4. Firestore rules aur sync payload verify karo
- firestore.rules bohot strict hain (validOrder, validFinancial, orders par delete: false, wagera). Ye jaanchne ke liye emulator test likho (npm run test:rules wale setup ke saath): sync worker jo payload bhejta hai (firestoreRest.writeDoc/deleteDoc) wo har syncable collection par rules se pass hota hai ya nahi.
- Jahan rules reject karein (e.g. orders/payments ka delete), wahan sync mein DELETE ke bajaye soft-delete (deletedAt ke saath update) bhejo, ya jo rules allow karein wahi operation use karo. Rules ko dheela mat karo bina mujhse poochhe; agar rules badalna zaroori ho to pehle mujhe batao.
- Test: har collection ke liye create, update, delete sync (online) emulator ke against.

GROUP B: OFFLINE LOGIN (requirement ka core hissa)

B1. Abhi internet band ho to restart par login screen aati hai aur membership load nahi hoti (AuthContext sirf Firebase use karta hai). Fix:
- Naya migration 00X (agla number) add karo: auth_cache table (uid, email, restaurant_id, role, permissions_json, password_hash, salt, kdf_params, last_online_login_at, failed_attempts, locked_until).
- Online login kamyab hone par: password main process mein scrypt (Node crypto, per-user random salt, strong params) se hash karke cache karo. Plaintext password kabhi store ya log mat karo, aur sirf us ek IPC call mein jao jo hash karne ke liye zaroori hai.
- Naye IPC channels (preload mein whitelisted): auth:cacheCredentials, auth:offlineLogin, auth:clearCache. Inputs validate karo.
- Offline login: email + password ko cached hash se compare karo (timing-safe compare). 5 galat attempts par temporary lockout. Cache expiry (e.g. 30 din last online login se); expire hone par online login zaroori. Jab internet wapas aaye to background mein Firebase se membership/role dobara verify karo, aur agar user inactive/removed ho to cache hata kar logout karo.
- AuthContext: Electron mein agar Firebase unreachable ho to offline login path use karo; web version ka behavior bilkul na badle. Roles (owner/manager/cashier/waiter) aur permissions cache se wahi rahein.
- Restart par bhi session restore ho (internet band ho tab bhi) via secure local session (expiry ke saath). Session token plaintext password na ho.
- Tests: internet OFF + restart + login; galat password; lockout; expiry; role cache.

GROUP C: UI WIRING (ESC/POS, reports, backup abhi UI se connect nahi)

C1. Receipt printing: src/components/ReceiptDialog.jsx abhi window.print() use karta hai.
- Electron mein: window.posApi.print.receipt(...) use karo (printing/ aur electron/ipc/printIpc.cjs pehle se bane hain). Browser (web) mein window.print() fallback rahe. Print UI ko block na kare, error par clear message dikhao, order data safe rahe.
- Auto-print option aur KOT (kot) printing bhi settings ke mutabiq wire karo.

C2. Printer settings screen (existing Settings/Operations page ke andar, UI style wahi): printer name (Windows printers list se), paper width 58/80mm, copies, auto print, font/character settings, Test Print button. Print IPC se jo available hai wahi use karo.

C3. Reports: existing reports screen ko Electron mein posApi.reports.* (SQLite) se chalao, taake Firebase query ka wait na ho. Web mein purana behavior.

C4. Backup/Restore UI: Settings mein "Backup now", backups ki list, "Restore" (confirm dialog ke saath, pehle current DB ka auto backup), aur last backup time. Updater ka status (version, update available, "Restart to update" button) bhi dikhao. Ye sab posApi.backup.* aur posApi.updater.* se.

C5. Online/Offline/Syncing/Synced indicator (AppLayout.jsx) mein "Last Sync" aur "Pending Sync" dikhana verify karo, aur naye states bhi: 'auth-required' aur "N need attention".

GROUP D: CHHOTE FIXES

D1. database/migrations/005_test_feature_column.sql ek test migration hai (settings.loyalty_points_enabled). Isay DELETE karo (abhi koi release nahi hui). Note: development machine ka DB agar v5 par hai to naye app mein "database newer than app" error aayega, isliye README mein likho ke dev DB (userData/database/restaurantos.db) delete karni hogi. Test files jo is column ko refer karti hon unhein update karo. Naye migrations ka numbering fix rahe (purani files edit nahi, hamesha nayi add).

D2. Migration safety (database/migrations/runner.cjs):
- Pre-migration backup fail ho to migration ABORT karo (sirf warning nahi), siwaye jab DB bilkul naya/khali ho (version 0).
- Migration fail ho to user ko dialog.showErrorBox se clear message dikhao (electron/main.cjs mein getDb() ko try/catch mein lapeto), aur app safe tareeqe se band ho. DB touch na ho.

D3. electron/main.cjs: getDb() ka unused variable hatao, startup errors handle karo. will-navigate par external navigation block karo, aur ek strict Content-Security-Policy set karo jo Firebase Auth/Firestore aur app ke liye zaroori domains allow kare (test karo ke login phir bhi chale).

D4. electron/ipc/syncIpc.cjs mein 'sync:setMockOnline' test hook production mein register na ho (sirf jab NODE_ENV=test ya env flag ho). posIpc.cjs mein restaurantId ko dbIpc jaisa validate karo (regex), aur 'sync:setCredentials' ke inputs validate karo (types, lengths).

D5. package.json build.publish: source repo private rahega. Releases ke liye alag PUBLIC repo use karo: owner MuhammadAbulubabaAttari2526, repo restaurantos-releases. App mein koi GitHub token embed mat karo. Publish sirf GH_TOKEN env variable se local machine par ho.

D6. oxlint ke 15 warnings saaf karo (unused functions jaise genericRepository.cjs ka buildWhere), bina behavior badle.

D7. README update: Windows par run/test/build/installer ke exact commands, dev DB reset ka tareeqa, release/publish ka process, aur .env.local ke baare mein note (kabhi commit/share na ho).

END MEIN
- Sab tests chalao: npm test, npm run test:electron, test-phase*-headless scripts, aur naye tests (token refresh, retry/backoff, stuck syncing reset, rules emulator, offline login, migration failure).
- Final report do: kya fix hua, kaunsi file badli, kaun sa test pass/fail, aur jo kaam abhi bhi manual hardware testing maangta hai (thermal printer, Windows installer, update).
*/
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
