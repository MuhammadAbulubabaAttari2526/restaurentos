/**
 * Phase 2: Headless Electron test for SQLite + migrations + data layer.
 *
 * Tests:
 *   T1  - database file created in userData/database/restaurantos.db
 *   T2  - schema_version table exists and migration 001 was applied
 *   T3  - all expected tables exist
 *   T4  - db:query IPC returns empty array for a fresh collection
 *   T5  - db:upsert creates a record and db:query returns it
 *   T6  - db:upsert updates an existing record (partial update)
 *   T7  - db:delete soft-deletes a record (no longer returned by query)
 *   T8  - db:getById returns a specific record
 *   T9  - WAL mode is enabled
 *   T10 - sync_queue entry created on upsert
 *   T11 - sync_queue entry created on delete
 *   T12 - App restart → data persists (simulated by closing and reopening db)
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { registerSystemIpc } = require('./electron/ipc/systemIpc.cjs')
const { registerDbIpc } = require('./electron/ipc/dbIpc.cjs')
const { getDb, closeDb } = require('./database/sqliteClient.cjs')

let pass = 0
let fail = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ [PASS] ${name}${detail ? ' — ' + detail : ''}`)
    pass++
  } else {
    console.error(`  ✗ [FAIL] ${name}${detail ? ' — ' + detail : ''}`)
    fail++
  }
}

async function runPhase2Tests() {
  console.log('\n━━━ Phase 2: SQLite + Migrations + Data Layer ━━━\n')

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  registerSystemIpc()
  registerDbIpc()
  const db = getDb()

  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'database', 'restaurantos.db')

  // T1 — DB file created
  check('T1  DB file exists on disk', fs.existsSync(dbPath), dbPath)

  // T2 — schema_version has migration 001
  const schemaRows = db.prepare('SELECT version FROM schema_version ORDER BY version').all()
  check('T2  Migration 001 recorded in schema_version', schemaRows.some(r => r.version === 1))

  // T3 — all critical tables exist
  const allTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(r => r.name)
  const required = [
    'schema_version','sync_queue','users','settings','categories','menu_items',
    'tables','reservations','orders','order_financials','payments','customers',
    'inventory','stock_movements','suppliers','purchases','expenses',
    'draft_orders','counters','printers','audit_logs','staff_invitations'
  ]
  for (const t of required) {
    check(`T3  Table "${t}" exists`, allTables.includes(t))
  }

  // T4 — WAL mode
  const walMode = db.pragma('journal_mode', { simple: true })
  check('T9  WAL mode enabled', walMode === 'wal', `journal_mode=${walMode}`)

  // ── IPC Tests via hidden BrowserWindow ──────────────────────────────────────
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  await win.loadFile(path.join(__dirname, 'dist/index.html'))

  const TEST_RESTAURANT = 'test-restaurant-phase2'
  const TEST_ID = `test-menu-item-001`

  // T4 — query empty collection
  const emptyResult = await win.webContents.executeJavaScript(
    `window.posApi.db.query('${TEST_RESTAURANT}', 'menuItems', [], 10)`
  )
  check('T4  db:query returns array for empty collection',
    Array.isArray(emptyResult) && emptyResult.length === 0)

  // T5 — upsert creates record
  await win.webContents.executeJavaScript(`
    window.posApi.db.upsert('${TEST_RESTAURANT}', 'menuItems', {
      name: 'Test Burger',
      priceCents: 120000,
      available: true,
      categoryId: 'cat-1',
      categoryName: 'Mains'
    }, '${TEST_ID}')
  `)
  const afterInsert = await win.webContents.executeJavaScript(
    `window.posApi.db.query('${TEST_RESTAURANT}', 'menuItems', [], 10)`
  )
  check('T5  db:upsert creates record + db:query returns it',
    afterInsert.length >= 1 && afterInsert.some(r => r.id === TEST_ID && r.name === 'Test Burger'))

  // T6 — upsert updates record (partial update)
  await win.webContents.executeJavaScript(`
    window.posApi.db.upsert('${TEST_RESTAURANT}', 'menuItems', {
      priceCents: 150000
    }, '${TEST_ID}')
  `)
  const afterUpdate = await win.webContents.executeJavaScript(
    `window.posApi.db.getById('${TEST_RESTAURANT}', 'menuItems', '${TEST_ID}')`
  )
  check('T6  db:upsert partial update preserves name, updates price',
    afterUpdate && afterUpdate.name === 'Test Burger' && afterUpdate.priceCents === 150000)

  // T8 — getById returns record
  check('T8  db:getById returns correct record',
    afterUpdate && afterUpdate.id === TEST_ID)

  // T7 — soft delete
  await win.webContents.executeJavaScript(
    `window.posApi.db.delete('${TEST_RESTAURANT}', 'menuItems', '${TEST_ID}')`
  )
  const afterDelete = await win.webContents.executeJavaScript(
    `window.posApi.db.query('${TEST_RESTAURANT}', 'menuItems', [], 10)`
  )
  check('T7  db:delete soft-deletes (not returned by query)',
    !afterDelete.some(r => r.id === TEST_ID))

  // Verify deleted_at was set in raw DB
  const rawRow = db.prepare('SELECT deleted_at FROM menu_items WHERE id = ?').get(TEST_ID)
  check('T7b Raw row has deleted_at set', rawRow && rawRow.deleted_at !== null)

  // T10 — sync_queue entry on upsert
  const syncEntries = db.prepare(
    "SELECT * FROM sync_queue WHERE collection_name = 'menuItems' AND record_id = ?"
  ).all(TEST_ID)
  check('T10 sync_queue entry created on upsert',
    syncEntries.some(e => e.action === 'set' || e.action === 'update'))

  // T11 — sync_queue entry on delete
  check('T11 sync_queue entry created on delete',
    syncEntries.some(e => e.action === 'delete'))

  // T12 — data persists after DB close/reopen (simulated)
  // Insert a persistent record, close, reopen, check it's there
  const PERSIST_ID = 'persist-test-settings-001'
  db.prepare(`
    INSERT OR REPLACE INTO settings
      (id, restaurant_id, name, currency, tax_rate, payment_methods_json, created_at, updated_at, sync_status, version)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'synced', 1)
  `).run(PERSIST_ID, TEST_RESTAURANT, 'Persist Test Restaurant', 'PKR', 0.1, '["cash"]')

  closeDb()
  const { getDb: getDb2 } = require('./database/sqliteClient.cjs')
  const db2 = getDb2()
  const persisted = db2.prepare('SELECT name FROM settings WHERE id = ?').get(PERSIST_ID)
  check('T12 Data persists after close/reopen', persisted && persisted.name === 'Persist Test Restaurant')

  // Clean up test data
  db2.prepare("DELETE FROM settings WHERE id = ?").run(PERSIST_ID)
  db2.prepare("DELETE FROM menu_items WHERE restaurant_id = ?").run(TEST_RESTAURANT)
  db2.prepare("DELETE FROM sync_queue WHERE restaurant_id = ?").run(TEST_RESTAURANT)

  win.close()

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n━━━ Phase 2 Results: ${pass} passed, ${fail} failed ━━━\n`)
  closeDb()
  app.quit()
  process.exit(fail > 0 ? 1 : 0)
}

app.whenReady().then(runPhase2Tests).catch((err) => {
  console.error('Phase 2 test failed with exception:', err)
  app.quit()
  process.exit(1)
})
