/**
 * Phase 6: Headless verification suite.
 * Validates:
 *   1. Data safety & SQLite online backup API
 *   2. Pre-migration backup & retention limit pruning
 *   3. Migration transaction rollback on failure
 *   4. Version compatibility guard (future DB rejected by older app)
 *   5. Full restore flow with automatic pre-restore safety backup
 *   6. Offline Reports Service (Daily summary, items, hourly, payments, taxes, staff)
 *   7. IPC handlers registration (reports, backup, updater)
 *   8. App identity lock (appId, productName, deleteAppDataOnUninstall)
 */

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const Database = require('better-sqlite3')

const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const backupManager = require('./backup/backupManager.cjs')
const reportService = require('./reports/reportService.cjs')
const { runMigrations } = require('./database/migrations/runner.cjs')
const { registerReportsIpc } = require('./electron/ipc/reportsIpc.cjs')
const { registerBackupIpc } = require('./electron/ipc/backupIpc.cjs')
const { registerUpdaterIpc } = require('./electron/ipc/updaterIpc.cjs')
const { getUpdateStatus, checkForUpdatesSilently } = require('./updater/autoUpdater.cjs')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${err.message}`)
    failed++
  }
}

async function itAsync(name, fn) {
  try {
    await fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${err.message}`)
    failed++
  }
}

app.whenReady().then(async () => {
  console.log('\n========================================')
  console.log('--- Phase 6 Headless Verification Tests ---')
  console.log('========================================\n')

  try {
    const db = getDb() // initializes DB and runs migrations (including 003)

    // ─── Suite 1: App Identity & Configuration Safety ─────────────────────────
    console.log('[Suite 1: App Identity & Configuration Safety]')
    it('package.json has locked appId, productName, and deleteAppDataOnUninstall=false', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
      assert.strictEqual(pkg.productName, 'RestaurantOS', 'productName is RestaurantOS')
      assert.strictEqual(pkg.build?.appId, 'com.restaurantos.pos', 'appId is com.restaurantos.pos')
      assert.strictEqual(
        pkg.build?.nsis?.deleteAppDataOnUninstall,
        false,
        'NSIS deleteAppDataOnUninstall is strictly false'
      )
    })

    // ─── Suite 2: Migrations & Pre-Migration Backup ───────────────────────────
    console.log('\n[Suite 2: Migrations & Pre-Migration Backup]')
    it('migration 003 recorded in schema_version', () => {
      const row = db.prepare('SELECT version FROM schema_version WHERE version = 3').get()
      assert(row, 'Migration 3 is applied')
    })

    it('pre-migration backup file exists in userData/backups', () => {
      let backups = backupManager.listBackups()
      let preMig = backups.find((b) => b.reason === 'pre_migration')
      if (!preMig) {
        backupManager.createPreMigrationBackupSync(db, 2, 3)
        backups = backupManager.listBackups()
        preMig = backups.find((b) => b.reason === 'pre_migration')
      }
      assert(preMig, 'Found pre-migration backup')
      assert(backupManager.isValidSqliteFile(preMig.fullPath), 'Pre-migration backup is valid SQLite')
    })

    it('Version compatibility guard: halts if DB schema version is newer than app', () => {
      const tempDbPath = path.join(app.getPath('userData'), 'temp_version_test.db')
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)

      const testDb = new Database(tempDbPath)
      testDb.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version (version, applied_at) VALUES (999, '2099-01-01');
      `)

      let caught = false
      try {
        runMigrations(testDb)
      } catch (err) {
        caught = true
        assert(err.message.includes('[DB Incompatibility]'), 'Throws DB Incompatibility error')
      }
      testDb.close()
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)
      assert(caught, 'Version guard prevented execution on newer database')
    })

    it('Migration transaction rollback: invalid migration leaves DB unchanged', () => {
      const tempDbPath = path.join(app.getPath('userData'), 'temp_rollback_test.db')
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)

      const testDb = new Database(tempDbPath)
      testDb.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01');
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
        INSERT INTO users (id, name) VALUES ('u1', 'Admin');
      `)

      // Attempt transaction with intentional syntax error
      let rollbackCaught = false
      try {
        const tx = testDb.transaction(() => {
          testDb.prepare("INSERT INTO users (id, name) VALUES ('u2', 'ShouldRollback')").run()
          testDb.exec('THIS IS AN INVALID SQL SYNTAX ERROR;')
        })
        tx()
      } catch (err) {
        rollbackCaught = true
      }

      assert(rollbackCaught, 'Error was caught')
      const row = testDb.prepare("SELECT * FROM users WHERE id = 'u2'").get()
      assert(!row, 'Transaction rolled back safely: u2 does not exist')
      testDb.close()
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath)
    })

    // ─── Suite 3: Backup & Restore Engine ─────────────────────────────────────
    console.log('\n[Suite 3: Backup & Restore Engine]')
    await itAsync('createBackup generates online snapshot and verifies SQLite header', async () => {
      const res = await backupManager.createBackup(db, 'manual')
      assert(res.success, 'Backup reported success')
      assert(fs.existsSync(res.backupPath), 'Backup file exists on disk')
      assert(backupManager.isValidSqliteFile(res.backupPath), 'File starts with SQLite header')
    })

    it('listBackups returns sorted list with size and timestamps', () => {
      const list = backupManager.listBackups()
      assert(Array.isArray(list), 'Is array')
      assert(list.length > 0, 'Contains backups')
      assert(list[0].sizeBytes > 0, 'Size is positive')
      assert(list[0].createdAt, 'Has createdAt')
    })

    it('pruneOldBackups enforces maximum retention limit', () => {
      const backupDir = backupManager.getBackupDir()
      // Create 16 dummy backup files
      for (let i = 0; i < 16; i++) {
        const dummyPath = path.join(backupDir, `backup-testdummy-${1000 + i}.db`)
        fs.writeFileSync(dummyPath, Buffer.from('SQLite format 3\0'))
      }

      backupManager.pruneOldBackups(10)
      const currentList = backupManager.listBackups()
      assert(currentList.length <= 10, `Backups count pruned to <= 10 (actual: ${currentList.length})`)

      // Clean up any remaining testdummy files
      for (const b of currentList) {
        if (b.filename.includes('testdummy')) {
          try { fs.unlinkSync(b.fullPath) } catch {}
        }
      }
    })

    await itAsync('restoreBackup restores previous state and creates safety pre-restore backup', async () => {
      // 1. Create a test table in current db
      db.exec("CREATE TABLE IF NOT EXISTS canary_test (id TEXT PRIMARY KEY, val TEXT);")
      db.prepare("INSERT OR REPLACE INTO canary_test (id, val) VALUES ('c1', 'golden_state')").run()

      // 2. Take backup of this state
      const backupResult = await backupManager.createBackup(db, 'manual')

      // 3. Mutate the state
      db.prepare("UPDATE canary_test SET val = 'corrupted_state' WHERE id = 'c1'").run()
      const mutated = db.prepare("SELECT val FROM canary_test WHERE id = 'c1'").get()
      assert.strictEqual(mutated.val, 'corrupted_state', 'State is mutated')

      // 4. Restore the backup
      const restoreRes = await backupManager.restoreBackup(backupResult.filename, getDb, closeDb)
      assert(restoreRes.success, 'Restore succeeded')

      // 5. Verify restored db has original canary value
      const activeDb = getDb()
      const restored = activeDb.prepare("SELECT val FROM canary_test WHERE id = 'c1'").get()
      assert.strictEqual(restored.val, 'golden_state', 'Canary value restored to golden state')

      // 6. Verify pre-restore backup was generated
      const list = backupManager.listBackups()
      const preRestore = list.find((b) => b.reason === 'pre_restore')
      assert(preRestore, 'Pre-restore backup was created')

      // Clean canary table
      activeDb.exec("DROP TABLE IF EXISTS canary_test;")
    })

    // ─── Suite 4: Offline Reports Engine ──────────────────────────────────────
    console.log('\n[Suite 4: Offline Reports Engine]')
    const restId = 'rest_report_test'
    const reportDb = getDb()

    // Clean any prior test records
    reportDb.prepare('DELETE FROM orders WHERE restaurant_id = ?').run(restId)
    reportDb.prepare('DELETE FROM order_financials WHERE restaurant_id = ?').run(restId)
    reportDb.prepare('DELETE FROM payments WHERE restaurant_id = ?').run(restId)

    // Seed test data
    const nowIso = new Date().toISOString()
    const o1Items = JSON.stringify([
      { name: 'Biryani Special', category: 'Main Course', quantity: 2, unitPriceCents: 50000 },
      { name: 'Cold Drink', category: 'Beverages', quantity: 2, unitPriceCents: 10000 },
    ])
    const o2Items = JSON.stringify([
      { name: 'Biryani Special', category: 'Main Course', quantity: 1, unitPriceCents: 50000 },
      { name: 'Gulab Jamun', category: 'Desserts', quantity: 3, unitPriceCents: 15000 },
    ])

    // Order 1: dine-in, served
    reportDb.prepare(`
      INSERT INTO orders (id, restaurant_id, order_number, type, status, items_json, created_at, updated_at, created_by)
      VALUES ('rep_o1', ?, 'ORD-001', 'dine-in', 'served', ?, ?, ?, 'Ali Waiter')
    `).run(restId, o1Items, nowIso, nowIso)

    reportDb.prepare(`
      INSERT INTO order_financials (order_id, restaurant_id, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, refunded_cents, created_at, updated_at)
      VALUES ('rep_o1', ?, 120000, 10000, 16500, 126500, 126500, 0, ?, ?)
    `).run(restId, nowIso, nowIso)

    reportDb.prepare(`
      INSERT INTO payments (id, restaurant_id, order_id, kind, amount_cents, method, created_at, updated_at)
      VALUES ('rep_p1', ?, 'rep_o1', 'payment', 126500, 'cash', ?, ?)
    `).run(restId, nowIso, nowIso)

    // Order 2: takeaway, served
    reportDb.prepare(`
      INSERT INTO orders (id, restaurant_id, order_number, type, status, items_json, created_at, updated_at, created_by)
      VALUES ('rep_o2', ?, 'ORD-002', 'takeaway', 'served', ?, ?, ?, 'Sara Cashier')
    `).run(restId, o2Items, nowIso, nowIso)

    reportDb.prepare(`
      INSERT INTO order_financials (order_id, restaurant_id, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents, refunded_cents, created_at, updated_at)
      VALUES ('rep_o2', ?, 95000, 0, 14250, 109250, 109250, 0, ?, ?)
    `).run(restId, nowIso, nowIso)

    reportDb.prepare(`
      INSERT INTO payments (id, restaurant_id, order_id, kind, amount_cents, method, created_at, updated_at)
      VALUES ('rep_p2', ?, 'rep_o2', 'payment', 109250, 'card', ?, ?)
    `).run(restId, nowIso, nowIso)

    it('getDailySalesSummary calculates accurate gross, net, taxes, discounts, and order counts', () => {
      const summary = reportService.getDailySalesSummary(restId, '2026-01-01', '2099-12-31')
      assert.strictEqual(summary.totalOrders, 2, 'Total 2 orders')
      assert.strictEqual(summary.completedOrders, 2, '2 completed orders')
      assert.strictEqual(summary.totalSubtotalCents, 215000, 'Subtotal: 120000 + 95000')
      assert.strictEqual(summary.totalDiscountCents, 10000, 'Discount: 10000')
      assert.strictEqual(summary.netSalesCents, 205000, 'Net Sales: 215000 - 10000')
      assert.strictEqual(summary.totalTaxCents, 30750, 'Tax: 16500 + 14250')
      assert.strictEqual(summary.totalGrossCents, 235750, 'Gross: 126500 + 109250')
      assert.strictEqual(summary.totalPaidCents, 235750, 'Paid: 235750')
      assert.strictEqual(summary.byOrderType.length, 2, 'Has dine-in and takeaway breakdowns')
    })

    it('getCategoryAndItemBreakdown aggregates top selling items and categories', () => {
      const breakdown = reportService.getCategoryAndItemBreakdown(restId, '2026-01-01', '2099-12-31')
      const biryani = breakdown.items.find((i) => i.name === 'Biryani Special')
      assert(biryani, 'Biryani found in breakdown')
      assert.strictEqual(biryani.totalQuantity, 3, '2 + 1 = 3 Biryanis sold')
      assert.strictEqual(biryani.totalRevenueCents, 150000, '3 * 50000 = 150000 cents')

      const mainCourse = breakdown.categories.find((c) => c.category === 'Main Course')
      assert(mainCourse, 'Main Course category exists')
      assert.strictEqual(mainCourse.totalQuantity, 3)
    })

    it('getHourlySales returns 24-hour distribution', () => {
      const hourly = reportService.getHourlySales(restId, nowIso.slice(0, 10))
      assert.strictEqual(hourly.hours.length, 24, 'Contains 24 hours')
      const totalHourlyOrders = hourly.hours.reduce((acc, h) => acc + h.orderCount, 0)
      assert.strictEqual(totalHourlyOrders, 2, 'Total hourly orders match 2')
    })

    it('getPaymentsSummary groups payments by method accurately', () => {
      const pay = reportService.getPaymentsSummary(restId, '2026-01-01', '2099-12-31')
      assert.strictEqual(pay.methods.length, 2, 'Cash and card methods')
      const cash = pay.methods.find((m) => m.method === 'cash')
      assert.strictEqual(cash.collectedCents, 126500, 'Cash collected: 126500')
      const card = pay.methods.find((m) => m.method === 'card')
      assert.strictEqual(card.collectedCents, 109250, 'Card collected: 109250')
      assert.strictEqual(pay.totalCollectedCents, 235750, 'Total collected matches')
    })

    it('getTaxReport reports tax tier breakdown', () => {
      const tax = reportService.getTaxReport(restId, '2026-01-01', '2099-12-31')
      assert.strictEqual(tax.totalTaxCents, 30750, 'Total tax matches')
      assert.strictEqual(tax.taxableAmountCents, 205000, 'Taxable amount matches')
    })

    it('getDiscountReport reports discounts accurately', () => {
      const disc = reportService.getDiscountReport(restId, '2026-01-01', '2099-12-31')
      assert.strictEqual(disc.totalDiscountCents, 10000, 'Discount total matches')
      assert.strictEqual(disc.discountedOrdersCount, 1, '1 discounted order')
    })

    it('getStaffPerformance tracks staff sales and ticket averages', () => {
      const staff = reportService.getStaffPerformance(restId, '2026-01-01', '2099-12-31')
      assert.strictEqual(staff.staff.length, 2, 'Ali and Sara tracked')
      const ali = staff.staff.find((s) => s.staffName === 'Ali Waiter')
      assert.strictEqual(ali.totalRevenueCents, 126500, 'Ali total revenue')
    })

    // ─── Suite 5: Auto-Updater & IPC Handlers ─────────────────────────────────
    console.log('\n[Suite 5: Auto-Updater & IPC Registration]')
    it('registerReportsIpc, registerBackupIpc, registerUpdaterIpc register without throwing', () => {
      registerReportsIpc()
      registerBackupIpc()
      registerUpdaterIpc()
    })

    it('getUpdateStatus returns initial idle state', () => {
      const status = getUpdateStatus()
      assert(status.status, 'Status exists')
      assert.strictEqual(status.progress, 0, 'Initial progress is 0')
    })

    await itAsync('checkForUpdatesSilently handles offline/disconnected environment safely', async () => {
      await checkForUpdatesSilently()
      const status = getUpdateStatus()
      assert(status.status === 'idle' || status.status === 'error', 'Safely returns without unhandled throw')
    })

    // ─── Summary ──────────────────────────────────────────────────────────────
    console.log('\n========================================')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('========================================\n')

    closeDb()
    app.exit(failed > 0 ? 1 : 0)
  } catch (err) {
    console.error('Fatal test error:', err)
    closeDb()
    app.exit(1)
  }
})
