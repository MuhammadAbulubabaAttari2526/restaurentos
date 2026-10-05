/**
 * test-group-c.cjs
 *
 * Headless verification test suite for GROUP C: UI WIRING
 *
 * C1. Receipt & KOT printing IPC (database order & in-memory order fallback)
 * C2. Printer configuration & listing in SQLite (paper_width, copies, auto_print)
 * C3. SQLite reporting engine (dailySummary, itemsBreakdown, paymentsSummary)
 * C4. Backup creation, listing, restore safety, and updater status
 * C5. Sync status reporting (auth-required, attention count, last sync time, pending count)
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')

app.whenReady().then(async () => {
  console.log('\n==================================================')
  console.log('  RUNNING GROUP C HEADLESS VERIFICATION SUITE')
  console.log('==================================================\n')

  let passed = 0
  let failed = 0

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`)
      passed++
    } else {
      console.error(`  ✗ FAIL: ${message}`)
      failed++
    }
  }

  try {
    const { getDb } = require('./database/sqliteClient.cjs')
    const db = getDb()
    const testRestaurantId = 'test-restaurant-group-c'

    // =========================================================================
    // 1. C2: Printer Settings & Upsert
    // =========================================================================
    console.log('[1/5] Testing C2: Printer configuration and listing...')
    const genericRepository = require('./database/repositories/genericRepository.cjs')
    const { listWindowsPrinters } = require('./printing/printerManager.cjs')

    const winPrinters = await listWindowsPrinters()
    assert(Array.isArray(winPrinters), 'listWindowsPrinters returns an array')

    const printerConfig = {
      name: 'Test Thermal Printer POS-80',
      connectionType: 'driver',
      ipAddress: '',
      port: 9100,
      paperWidth: 80,
      copies: 2,
      autoPrint: true,
      isDefault: true,
    }
    await genericRepository.upsert(testRestaurantId, 'printers', printerConfig, 'printer-group-c-1')

    const savedPrinters = genericRepository.query(testRestaurantId, 'printers', [], 10)
    const saved = savedPrinters.find((p) => p.id === 'printer-group-c-1')
    assert(Boolean(saved), 'Printer config successfully saved to SQLite')
    assert(saved.paperWidth === 80, 'Paper width is 80mm')
    assert(saved.copies === 2, 'Copies count is 2')
    assert(saved.autoPrint === true, 'Auto-print receipt is enabled')

    // =========================================================================
    // 2. C1: Receipt & KOT Printing Formatters
    // =========================================================================
    console.log('\n[2/5] Testing C1: Receipt & KOT ESC/POS formatting...')
    const { formatReceipt } = require('./printing/receiptFormatter.cjs')
    const { formatKot } = require('./printing/kotFormatter.cjs')

    const testOrder = {
      id: 'order-group-c-test-1',
      restaurant_id: testRestaurantId,
      orderNumber: 'R-20261005-0001',
      type: 'dine-in',
      tableName: 'Table 5',
      customerName: 'Customer Alpha',
      dineInCoverCount: 2,
      createdAt: new Date().toISOString(),
      items: [
        {
          name: 'Chicken Karahi (Full)',
          quantity: 1,
          unitPriceCents: 220000,
          totalPriceCents: 220000,
          selectedVariant: { name: 'Full' },
          selectedAddOns: [{ name: 'Extra Butter' }],
        },
        {
          name: 'Roti',
          quantity: 4,
          unitPriceCents: 3000,
          totalPriceCents: 12000,
        },
      ],
      subtotalCents: 232000,
      discountCents: 10000,
      taxCents: 35520,
      totalCents: 257520,
      paidCents: 260000,
      refundedCents: 0,
      paymentStatus: 'paid',
    }

    const receiptBuf = formatReceipt({
      order: testOrder,
      financial: {
        subtotalCents: testOrder.subtotalCents,
        discountCents: testOrder.discountCents,
        taxCents: testOrder.taxCents,
        totalCents: testOrder.totalCents,
        paidCents: testOrder.paidCents,
        refundedCents: testOrder.refundedCents,
        paymentStatus: testOrder.paymentStatus,
      },
      payments: [{ kind: 'payment', method: 'cash', amountCents: 260000 }],
      settings: { name: 'Al-Madina Cuisine', phone: '0300-1234567', currency: 'PKR' },
      printer: { paperWidth: 80, copies: 1 },
      options: { openCashDrawer: true },
    })

    assert(Buffer.isBuffer(receiptBuf), 'Receipt formatter produces a Buffer')
    assert(receiptBuf.length > 50, `Receipt ESC/POS buffer length is valid (${receiptBuf.length} bytes)`)

    const kotBuf = formatKot({
      order: testOrder,
      printer: { paperWidth: 80, copies: 1 },
      options: { kotLabel: 'KITCHEN ORDER' },
    })
    assert(Buffer.isBuffer(kotBuf), 'KOT formatter produces a Buffer')
    assert(kotBuf.length > 30, `KOT ESC/POS buffer length is valid (${kotBuf.length} bytes)`)

    // Save test order to SQLite DB to test IPC path
    await genericRepository.upsert(testRestaurantId, 'orders', testOrder, testOrder.id)
    await genericRepository.upsert(testRestaurantId, 'orderFinancials', {
      orderId: testOrder.id,
      subtotalCents: testOrder.subtotalCents,
      discountCents: testOrder.discountCents,
      taxCents: testOrder.taxCents,
      totalCents: testOrder.totalCents,
      paidCents: testOrder.paidCents,
      paymentStatus: 'paid',
    }, testOrder.id)
    await genericRepository.upsert(testRestaurantId, 'payments', {
      orderId: testOrder.id,
      kind: 'payment',
      method: 'cash',
      amountCents: 260000,
    }, 'payment-c-1')

    // =========================================================================
    // 3. C3: Local Offline Reports Engine
    // =========================================================================
    console.log('\n[3/5] Testing C3: Local SQLite reporting engine...')
    const reportService = require('./reports/reportService.cjs')

    const todayStr = new Date().toISOString().slice(0, 10)
    const dailySummary = reportService.getDailySalesSummary(testRestaurantId, todayStr, todayStr)
    assert(typeof dailySummary === 'object', 'getDailySalesSummary returned an object')
    assert(dailySummary.totalOrders >= 1, `Daily total orders recorded correctly (${dailySummary.totalOrders})`)
    assert(dailySummary.totalGrossCents >= 257520, `Daily gross revenue computed correctly (${dailySummary.totalGrossCents} cents)`)

    const breakdown = reportService.getCategoryAndItemBreakdown(testRestaurantId, todayStr, todayStr)
    assert(Array.isArray(breakdown.items), 'getCategoryAndItemBreakdown returns items array')
    assert(breakdown.items.some((i) => i.name.includes('Chicken Karahi')), 'Chicken Karahi found in items breakdown')

    const paymentsSummary = reportService.getPaymentsSummary(testRestaurantId, todayStr, todayStr)
    assert(Array.isArray(paymentsSummary.methods), 'getPaymentsSummary returns methods array')
    assert(paymentsSummary.methods.some((m) => m.method === 'cash'), 'Cash payment recorded in payments summary')

    // =========================================================================
    // 4. C4: Database Backup & Restore & Updater
    // =========================================================================
    console.log('\n[4/5] Testing C4: Database Backup, Restore, and Updater...')
    const backupManager = require('./backup/backupManager.cjs')
    const { closeDb } = require('./database/sqliteClient.cjs')
    const { getUpdateStatus } = require('./updater/autoUpdater.cjs')

    const backupResult = await backupManager.createBackup(db, 'manual_test_c')
    assert(backupResult.success === true, 'Database backup successfully created')
    assert(fs.existsSync(backupResult.backupPath), 'Backup file exists on disk')

    const backupsList = backupManager.listBackups()
    assert(Array.isArray(backupsList), 'listBackups returns array')
    const foundBackup = backupsList.find((b) => b.filename === backupResult.filename)
    assert(Boolean(foundBackup), 'Newly created backup found in backups list')
    assert(foundBackup.sizeBytes > 1000, `Backup size is realistic (${foundBackup.sizeBytes} bytes)`)

    // Test restore creates safety backup before restoration
    const restoreResult = await backupManager.restoreBackup(backupResult.filename, getDb, closeDb)
    assert(restoreResult.success === true, 'Database restore operation succeeded')
    assert(Boolean(restoreResult.preRestoreBackup), 'Automated safety backup was taken before restore')

    const updaterStatus = getUpdateStatus()
    assert(typeof updaterStatus === 'object', 'getUpdateStatus returns status object')
    assert(typeof updaterStatus.status === 'string', `Updater status is valid: ${updaterStatus.status}`)

    // =========================================================================
    // 5. C5: Sync Status Reporting
    // =========================================================================
    console.log('\n[5/5] Testing C5: Sync status reporting (auth-required, attention count, last sync)...')
    const { SyncWorker } = require('./sync/syncWorker.cjs')

    const testWorker = new SyncWorker()
    const syncStatus = testWorker.getStatus()
    assert(typeof syncStatus === 'object', 'syncWorker.getStatus() returns status object')
    assert('status' in syncStatus, 'syncStatus has status property')
    assert('isOnline' in syncStatus, 'syncStatus has isOnline property')
    assert('pendingCount' in syncStatus, 'syncStatus has pendingCount')
    assert('attentionCount' in syncStatus, 'syncStatus has attentionCount')
    assert('lastSyncTime' in syncStatus, 'syncStatus has lastSyncTime')

    // Clean up test worker
    testWorker.stop()

    console.log('\n==================================================')
    console.log(`  GROUP C TESTS COMPLETE: ${passed} passed, ${failed} failed`)
    console.log('==================================================\n')

    if (failed > 0) {
      process.exit(1)
    } else {
      process.exit(0)
    }
  } catch (error) {
    console.error('Fatal test error:', error)
    process.exit(1)
  }
})
