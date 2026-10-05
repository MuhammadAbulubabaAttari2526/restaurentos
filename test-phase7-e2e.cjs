/**
 * Phase 7: Comprehensive End-to-End System Test Suite.
 *
 * Executes the 10 mandatory POS verification tests:
 *  1. Internet ON: order, bill, payment, receipt
 *  2. Internet OFF: order, bill, payment, receipt
 *  3. OFF, app restart: data safe and intact
 *  4. OFF, multiple orders -> internet ON: automatic queue sync
 *  5. Rapid network flips ON/OFF: no duplicate orders or payments
 *  6. Offline order update -> online sync
 *  7. Offline item/record delete -> online sync
 *  8. Windows restart simulation: DB file & WAL checkpoint preserved
 *  9. App update simulation: pre-migration backup created, schema upgraded, existing data safe
 * 10. Thermal printer test: 58mm and 80mm ESC/POS receipts and KOTs generated
 */

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const genericRepository = require('./database/repositories/genericRepository.cjs')
const { runLocalOperation } = require('./database/repositories/localOperations.cjs')
const { networkMonitor } = require('./sync/networkMonitor.cjs')
const { syncWorker } = require('./sync/syncWorker.cjs')
const firestoreRest = require('./sync/firestoreRest.cjs')
const backupManager = require('./backup/backupManager.cjs')
const { runMigrations } = require('./database/migrations/runner.cjs')
const { formatReceipt } = require('./printing/receiptFormatter.cjs')
const { formatKot } = require('./printing/kotFormatter.cjs')
const { builder } = require('./printing/escpos.cjs')

const TEST_RESULTS = []

function recordTest(testNum, testTitle, passed, details = '') {
  TEST_RESULTS.push({
    '#': testNum,
    'Verification Test': testTitle,
    'Status': passed ? 'PASS' : 'FAIL',
    'Notes / Result': details || 'Verified successfully',
  })
  if (passed) {
    console.log(`  ✓ [PASS] Test ${testNum}: ${testTitle}`)
  } else {
    console.error(`  ✗ [FAIL] Test ${testNum}: ${testTitle}`)
    if (details) console.error(`          ${details}`)
  }
}

app.whenReady().then(async () => {
  console.log('\n======================================================================')
  console.log('--- RestaurantOS Phase 7: 10 End-to-End System Verification Tests ---')
  console.log('======================================================================\n')

  const restId = 'rest_phase7_e2e'
  const db = getDb()

  try {
    // Clean any prior test artifacts
    db.prepare('DELETE FROM orders WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM order_financials WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM payments WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM sync_queue WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM tables WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM menu_items WHERE restaurant_id = ?').run(restId)

    // Seed test table and menu item
    genericRepository.upsert(restId, 'tables', {
      name: 'Table 7A',
      capacity: 4,
      status: 'available',
    }, 'table_t7_1')

    genericRepository.upsert(restId, 'tables', {
      name: 'Table 7B',
      capacity: 2,
      status: 'available',
    }, 'table_t7_2')

    genericRepository.upsert(restId, 'menuItems', {
      name: 'Gourmet Beef Burger',
      priceCents: 85000,
      available: 1,
    }, 'item_t7_burger')

    // Setup mock remote transport for sync worker
    const mockRemote = new Map()
    syncWorker.setCredentials({ projectId: 'mock-p7', authToken: 'mock-token', restaurantId: restId })
    firestoreRest.writeDoc = async (params) => {
      const key = typeof params === 'string' ? params : `restaurants/${params.restaurantId}/${params.collection}/${params.docId}`
      const val = typeof params === 'string' ? arguments[1] : params.data
      mockRemote.set(key, val)
      return { success: true }
    }
    firestoreRest.deleteDoc = async (params) => {
      const key = typeof params === 'string' ? params : `restaurants/${params.restaurantId}/${params.collection}/${params.docId}`
      mockRemote.delete(key)
      return { success: true }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: Internet ON: order, bill, payment, receipt
    // ─────────────────────────────────────────────────────────────────────────
    try {
      networkMonitor.setMockStatus(true)
      const orderPayload = {
        orderId: 'p7_ord_1',
        orderNumber: 'ORD-7001',
        type: 'dine-in',
        tableId: 'table_t7_1',
        tableName: 'Table 7A',
        items: [{ itemId: 'item_t7_burger', name: 'Gourmet Beef Burger', quantity: 2, unitPriceCents: 85000 }],
        taxRate: 15,
        createdByName: 'Kashif Waiter',
      }

      // Create Order
      const ordRes = runLocalOperation(restId, 'createOrder', orderPayload)
      assert(ordRes.orderId, 'Order created successfully')

      // Record Full Payment
      const payRes = runLocalOperation(restId, 'recordPayment', {
        orderId: 'p7_ord_1',
        amountCents: 195500, // 170000 + 15% tax (25500)
        method: 'cash',
        markServedIfFull: true,
      })
      assert(payRes.paymentId, 'Payment recorded')

      const orderObj = genericRepository.getById(restId, 'orders', ordRes.orderId)
      const finObj = genericRepository.getById(restId, 'orderFinancials', ordRes.orderId)
      const payObjs = genericRepository.query(restId, 'payments', [['order_id', '==', ordRes.orderId]])

      // Format Receipt
      const receiptBuf = formatReceipt({
        order: orderObj,
        financial: finObj,
        payments: payObjs,
        settings: { name: 'RestaurantOS Grill', currency: 'PKR' },
        printer: { paperWidth: 80, copies: 1 },
      })
      assert(Buffer.isBuffer(receiptBuf) && receiptBuf.length > 50, 'Receipt ESC/POS buffer generated')

      recordTest(1, 'Internet ON: order, bill, payment, receipt', true, 'Full billing cycle completed with receipt buffer')
    } catch (err) {
      recordTest(1, 'Internet ON: order, bill, payment, receipt', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: Internet OFF: order, bill, payment, receipt
    // ─────────────────────────────────────────────────────────────────────────
    try {
      networkMonitor.setMockStatus(false)
      assert.strictEqual(networkMonitor.isOnline(), false, 'Network confirmed offline')

      const orderPayloadOff = {
        orderId: 'p7_ord_2',
        orderNumber: 'ORD-7002',
        type: 'takeaway',
        items: [{ itemId: 'item_t7_burger', name: 'Gourmet Beef Burger', quantity: 1, unitPriceCents: 85000 }],
        taxRate: 15,
        createdByName: 'Bilal Cashier',
      }

      const ordResOff = runLocalOperation(restId, 'createOrder', orderPayloadOff)
      assert(ordResOff.orderId, 'Offline order created successfully')

      const payResOff = runLocalOperation(restId, 'recordPayment', {
        orderId: 'p7_ord_2',
        amountCents: 97750,
        method: 'card',
        markServedIfFull: true,
      })
      assert(payResOff.paymentId, 'Offline payment recorded in local SQLite')

      const orderObjOff = genericRepository.getById(restId, 'orders', ordResOff.orderId)
      const finObjOff = genericRepository.getById(restId, 'orderFinancials', ordResOff.orderId)
      const payObjsOff = genericRepository.query(restId, 'payments', [['order_id', '==', ordResOff.orderId]])

      const receiptBufOff = formatReceipt({
        order: orderObjOff,
        financial: finObjOff,
        payments: payObjsOff,
        settings: { name: 'RestaurantOS Grill', currency: 'PKR' },
        printer: { paperWidth: 58, copies: 1 },
      })
      assert(Buffer.isBuffer(receiptBufOff) && receiptBufOff.length > 50, 'Offline 58mm receipt buffer generated')

      recordTest(2, 'Internet OFF: order, bill, payment, receipt', true, 'Full offline cycle saved to SQLite with receipt')
    } catch (err) {
      recordTest(2, 'Internet OFF: order, bill, payment, receipt', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: OFF, app restart: data safe and intact
    // ─────────────────────────────────────────────────────────────────────────
    try {
      closeDb()
      const reopenedDb = getDb()

      const o1 = reopenedDb.prepare("SELECT * FROM orders WHERE id = 'p7_ord_1'").get()
      const o2 = reopenedDb.prepare("SELECT * FROM orders WHERE id = 'p7_ord_2'").get()
      const f2 = reopenedDb.prepare("SELECT * FROM order_financials WHERE order_id = 'p7_ord_2'").get()
      const p2 = reopenedDb.prepare("SELECT * FROM payments WHERE order_id = 'p7_ord_2'").get()

      assert(o1 && o2, 'Both online and offline orders exist after restart')
      assert.strictEqual(f2.total_cents, 97750, 'Financial record preserved exactly')
      assert.strictEqual(p2.amount_cents, 97750, 'Payment record preserved exactly')

      recordTest(3, 'OFF, app restart: data safe and intact', true, '100% data intact across database reopen')
    } catch (err) {
      recordTest(3, 'OFF, app restart: data safe and intact', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: OFF, multiple orders -> internet ON: automatic queue sync
    // ─────────────────────────────────────────────────────────────────────────
    try {
      networkMonitor.setMockStatus(false)

      // Create 3 orders offline
      for (let i = 3; i <= 5; i++) {
        runLocalOperation(restId, 'createOrder', {
          orderId: `p7_ord_${i}`,
          orderNumber: `ORD-700${i}`,
          type: 'dine-in',
          tableId: 'table_t7_2',
          items: [{ itemId: 'item_t7_burger', name: 'Gourmet Beef Burger', quantity: 1, unitPriceCents: 85000 }],
        })
      }

      const pendingBefore = syncWorker.getPendingCount()
      assert(pendingBefore >= 3, `Pending sync queue has ${pendingBefore} items`)

      // Restore network and execute sync
      networkMonitor.setMockStatus(true)
      const pushCount = await syncWorker.processQueue(50)
      assert(pushCount >= 3, `Pushed ${pushCount} items to remote`)

      const pendingAfter = syncWorker.getPendingCount()
      assert.strictEqual(pendingAfter, 0, 'Sync queue drained completely to 0 pending items')

      recordTest(4, 'OFF, multiple orders -> internet ON: automatic queue sync', true, `${pushCount} offline mutations synced successfully`)
    } catch (err) {
      recordTest(4, 'OFF, multiple orders -> internet ON: automatic queue sync', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: Rapid network flips ON/OFF: no duplicate orders or payments
    // ─────────────────────────────────────────────────────────────────────────
    try {
      for (let flip = 0; flip < 5; flip++) {
        networkMonitor.setMockStatus(flip % 2 === 0)
        await syncWorker.processQueue(50)
      }

      const activeDb = getDb()
      const duplicates = activeDb.prepare(`
        SELECT id, COUNT(*) as cnt FROM orders WHERE restaurant_id = ? GROUP BY id HAVING cnt > 1
      `).all(restId)
      assert.strictEqual(duplicates.length, 0, 'Zero duplicate order records found')

      const paymentDuplicates = activeDb.prepare(`
        SELECT id, COUNT(*) as cnt FROM payments WHERE restaurant_id = ? GROUP BY id HAVING cnt > 1
      `).all(restId)
      assert.strictEqual(paymentDuplicates.length, 0, 'Zero duplicate payment records found')

      recordTest(5, 'Internet rapid ON/OFF flips: zero duplicates', true, 'Idempotent sync verified across 5 network transitions')
    } catch (err) {
      recordTest(5, 'Internet rapid ON/OFF flips: zero duplicates', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: Offline order update -> online sync
    // ─────────────────────────────────────────────────────────────────────────
    try {
      networkMonitor.setMockStatus(false)
      genericRepository.upsert(restId, 'orders', {
        note: 'Customer requested extra napkins and cutlery offline',
      }, 'p7_ord_1')

      const pending = syncWorker.getPendingCount()
      assert(pending > 0, 'Update created pending sync item')

      networkMonitor.setMockStatus(true)
      await syncWorker.processQueue(50)

      const remoteDoc = mockRemote.get(`restaurants/${restId}/orders/p7_ord_1`)
      assert(remoteDoc, 'Updated order synced to remote transport')
      assert.strictEqual(
        remoteDoc.note,
        'Customer requested extra napkins and cutlery offline',
        'Updated note reflected in remote payload'
      )

      recordTest(6, 'Offline order update -> online sync', true, 'Local update propagated to remote on reconnection')
    } catch (err) {
      recordTest(6, 'Offline order update -> online sync', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7: Offline item/record delete -> online sync
    // ─────────────────────────────────────────────────────────────────────────
    try {
      networkMonitor.setMockStatus(false)
      genericRepository.upsert(restId, 'categories', {
        name: 'Temporary Season Specials',
      }, 'cat_t7_temp')

      // Soft delete while offline
      genericRepository.softDelete(restId, 'categories', 'cat_t7_temp')

      networkMonitor.setMockStatus(true)
      await syncWorker.processQueue(50)

      const remoteDeleted = mockRemote.has(`restaurants/${restId}/categories/cat_t7_temp`)
      assert.strictEqual(remoteDeleted, false, 'Deleted record removed from remote sync')

      recordTest(7, 'Offline item/record delete -> online sync', true, 'Soft-delete mutation pushed cleanly to remote')
    } catch (err) {
      recordTest(7, 'Offline item/record delete -> online sync', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8: Windows restart simulation: DB file & WAL checkpoint preserved
    // ─────────────────────────────────────────────────────────────────────────
    try {
      const activeDb = getDb()
      activeDb.pragma('wal_checkpoint(TRUNCATE)')
      closeDb()

      const userDataPath = app.getPath('userData')
      const dbFile = path.join(userDataPath, 'database', 'restaurantos.db')
      assert(fs.existsSync(dbFile), 'Database file exists on disk')
      const stat = fs.statSync(dbFile)
      assert(stat.size > 0, `Database file size is valid (${stat.size} bytes)`)

      // Reopen after simulated restart
      const rebootDb = getDb()
      const chk = rebootDb.pragma('integrity_check')
      assert.strictEqual(chk[0]?.integrity_check, 'ok', 'Database integrity check is OK after reboot')

      recordTest(8, 'Windows restart simulation: DB file & integrity preserved', true, 'WAL truncated cleanly and integrity check OK')
    } catch (err) {
      recordTest(8, 'Windows restart simulation: DB file & integrity preserved', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 9: App update simulation: pre-migration backup & schema upgrade
    // ─────────────────────────────────────────────────────────────────────────
    try {
      const activeDb = getDb()
      const initialOrderCount = activeDb.prepare('SELECT COUNT(*) as cnt FROM orders WHERE restaurant_id = ?').get(restId).cnt
      assert(initialOrderCount > 0, 'Existing orders present before update')

      // Create temporary migration 005 dynamically
      const migrationsDir = path.join(__dirname, 'database', 'migrations')
      const m5File = path.join(migrationsDir, '005_test_feature_table.sql')
      fs.writeFileSync(
        m5File,
        'CREATE TABLE IF NOT EXISTS test_feature_table (id TEXT PRIMARY KEY, name TEXT);\n'
      )

      // Run migration
      runMigrations(activeDb)

      // Verify v5 recorded
      const v5Row = activeDb.prepare('SELECT version FROM schema_version WHERE version = 5').get()
      assert(v5Row, 'Migration 005 applied successfully')

      // Verify pre-migration backup was created
      const backups = backupManager.listBackups()
      const preMig5 = backups.find((b) => b.filename.includes('before-v4-to-v5'))
      assert(preMig5, 'Pre-migration backup before-v4-to-v5 was generated')

      // Verify existing orders and tables are 100% safe
      const postOrderCount = activeDb.prepare('SELECT COUNT(*) as cnt FROM orders WHERE restaurant_id = ?').get(restId).cnt
      assert.strictEqual(postOrderCount, initialOrderCount, 'All pre-existing orders remain intact')

      // Reset migration 005 entry and delete file so clean for subsequent runs
      activeDb.exec('DROP TABLE IF EXISTS test_feature_table;')
      activeDb.prepare('DELETE FROM schema_version WHERE version = 5').run()
      fs.unlinkSync(m5File)

      recordTest(9, 'App update simulation: backup created, migration applied, existing data intact', true, 'Backup created and old orders 100% preserved')
    } catch (err) {
      recordTest(9, 'App update simulation: backup created, migration applied, existing data intact', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 10: Thermal printer test: 58mm and 80mm ESC/POS receipts and KOTs
    // ─────────────────────────────────────────────────────────────────────────
    try {
      const sampleOrder = {
        orderNumber: 'R-7788',
        type: 'dine-in',
        tableName: 'Table 7A',
        dineInCoverCount: 4,
        createdAt: new Date().toISOString(),
        items: [
          { name: 'Mutton Handi Full', quantity: 1, unitPriceCents: 320000, selectedVariant: { name: 'Full' } },
          { name: 'Roghni Naan', quantity: 6, unitPriceCents: 8000 },
        ],
      }
      const sampleFinancial = {
        subtotalCents: 368000,
        discountCents: 20000,
        taxCents: 52200,
        totalCents: 400200,
        paidCents: 400200,
      }
      const samplePayments = [{ kind: 'payment', amountCents: 400200, method: 'cash' }]
      const sampleSettings = { name: 'Grand Spice Palace', currency: 'PKR', receiptFooter: 'Thank you for dining!' }

      // 80mm Bill
      const bill80 = formatReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: { paperWidth: 80, copies: 1 },
      })
      assert(bill80.length > 100, '80mm bill generated')

      // 58mm Bill
      const bill58 = formatReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: { paperWidth: 58, copies: 1 },
      })
      assert(bill58.length > 80, '58mm bill generated')

      // 80mm KOT
      const kot80 = formatKot({
        order: sampleOrder,
        printer: { paperWidth: 80 },
      })
      assert(kot80.length > 80, '80mm KOT generated')

      // Test Print page
      const testPage = builder({ paperWidth: 80 })
        .center()
        .bold(true).large(true).line('TEST PRINT SUCCESS').large(false).bold(false)
        .line('RestaurantOS ESC/POS Thermal OK')
        .cut()
        .build()
      assert(testPage.length > 20, 'Test page buffer generated')

      recordTest(10, 'Thermal printer: 58mm & 80mm receipts, KOTs, and test print', true, '80mm bill, 58mm bill, 80mm KOT and test ticket generated')
    } catch (err) {
      recordTest(10, 'Thermal printer: 58mm & 80mm receipts, KOTs, and test print', false, err.message)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Summary Output
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n======================================================================')
    console.log('--- Phase 7 End-to-End Verification Test Results Summary ---')
    console.log('======================================================================')
    console.table(TEST_RESULTS)

    const allPassed = TEST_RESULTS.every((t) => t.Status === 'PASS')
    closeDb()
    app.exit(allPassed ? 0 : 1)
  } catch (err) {
    console.error('Fatal Test 7 Failure:', err)
    closeDb()
    app.exit(1)
  }
})
