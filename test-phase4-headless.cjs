/**
 * Phase 4: Headless Electron test for POS local domain operations,
 * IPC channels, and SQLite ACID consistency.
 */

const { app } = require('electron')
const assert = require('assert')

const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const genericRepository = require('./database/repositories/genericRepository.cjs')
const { runLocalOperation } = require('./database/repositories/localOperations.cjs')
const { registerPosIpc } = require('./electron/ipc/posIpc.cjs')

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
  console.log('--- Phase 4 Headless Verification Tests ---')
  console.log('========================================\n')

  try {
    const db = getDb()
    const restId = 'rest_pos_local_test'

    // Clean test data
    db.prepare('DELETE FROM sync_queue WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM orders WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM order_financials WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM payments WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM tables WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM menu_items WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM inventory WHERE restaurant_id = ?').run(restId)
    db.prepare('DELETE FROM stock_movements WHERE restaurant_id = ?').run(restId)

    // Seed test menu item with recipe and options
    genericRepository.upsert(
      restId,
      'inventoryItems',
      { name: 'Chicken Meat', currentStock: 10, unit: 'kg' },
      'inv_chicken'
    )

    genericRepository.upsert(
      restId,
      'menuItems',
      {
        name: 'Chicken Karahi',
        priceCents: 120000,
        variants: [{ id: 'full', name: 'Full Size', priceDeltaCents: 80000 }],
        addOns: [{ id: 'extra_raita', name: 'Extra Raita', priceCents: 10000 }],
        recipe: [{ ingredientId: 'inv_chicken', quantity: 0.5 }],
        available: true,
      },
      'menu_karahi'
    )

    genericRepository.upsert(
      restId,
      'tables',
      { name: 'Table 5', capacity: 4, status: 'available' },
      'table_5'
    )

    genericRepository.upsert(
      restId,
      'tables',
      { name: 'Table 8', capacity: 6, status: 'available' },
      'table_8'
    )

    // ─── T1: createOrder Operation ──────────────────────────────────────
    console.log('[Suite 1: Local createOrder Operation]')
    let createdOrder = null
    await itAsync('creates order, financials, deducts recipe stock, and marks table occupied', async () => {
      createdOrder = runLocalOperation(restId, 'createOrder', {
        orderId: 'order_local_1',
        type: 'dine-in',
        tableId: 'table_5',
        items: [
          {
            itemId: 'menu_karahi',
            quantity: 2,
            selectedVariantId: 'full',
            selectedAddOnIds: ['extra_raita'],
          },
        ],
        taxRate: 15, // 15% tax
        discountType: 'fixed',
        discountValue: 10000, // 100 Rs discount
        dineInCoverCount: 3,
        note: 'Extra spicy',
      })

      assert(createdOrder.orderId === 'order_local_1')
      assert(createdOrder.orderNumber.startsWith('R-'))

      // Unit price: 120000 (base) + 80000 (variant) + 10000 (add-on) = 210000 cents
      // 2 qty * 210000 = 420000 subtotal
      // - 10000 discount = 410000 taxable subtotal
      // + 15% tax (61500) = 471500 total
      assert.strictEqual(createdOrder.totalCents, 471500)

      // Verify order record in SQLite
      const order = genericRepository.getById(restId, 'orders', 'order_local_1')
      assert.strictEqual(order.status, 'queued')
      assert.strictEqual(order.tableName, 'Table 5')
      assert.strictEqual(order.items.length, 1)

      // Verify financials record
      const fin = genericRepository.getById(restId, 'orderFinancials', 'order_local_1')
      assert.strictEqual(fin.subtotalCents, 420000)
      assert.strictEqual(fin.discountCents, 10000)
      assert.strictEqual(fin.taxCents, 61500)
      assert.strictEqual(fin.totalCents, 471500)
      assert.strictEqual(fin.paymentStatus, 'unpaid')

      // Verify table occupied
      const table = genericRepository.getById(restId, 'tables', 'table_5')
      assert.strictEqual(table.status, 'occupied')
      assert.strictEqual(table.currentOrderId, 'order_local_1')

      // Verify inventory stock deducted: 10 - (2 * 0.5) = 9
      const inv = genericRepository.getById(restId, 'inventoryItems', 'inv_chicken')
      assert.strictEqual(inv.currentStock, 9)
    })

    // ─── T2: transferOrderTable Operation ────────────────────────────────
    console.log('\n[Suite 2: transferOrderTable Operation]')
    await itAsync('moves order between tables and updates statuses', async () => {
      runLocalOperation(restId, 'transferOrderTable', {
        orderId: 'order_local_1',
        targetTableId: 'table_8',
      })

      const oldTable = genericRepository.getById(restId, 'tables', 'table_5')
      assert.strictEqual(oldTable.status, 'available')
      assert.strictEqual(oldTable.currentOrderId, null)

      const newTable = genericRepository.getById(restId, 'tables', 'table_8')
      assert.strictEqual(newTable.status, 'occupied')
      assert.strictEqual(newTable.currentOrderId, 'order_local_1')

      const updatedOrder = genericRepository.getById(restId, 'orders', 'order_local_1')
      assert.strictEqual(updatedOrder.tableId, 'table_8')
      assert.strictEqual(updatedOrder.tableName, 'Table 8')
    })

    // ─── T3: recordPayment Operation ────────────────────────────────────
    console.log('\n[Suite 3: recordPayment Operation]')
    await itAsync('records partial payment without freeing table', async () => {
      const payRes = runLocalOperation(restId, 'recordPayment', {
        orderId: 'order_local_1',
        paymentId: 'pay_part_1',
        amountCents: 200000,
        method: 'cash',
      })

      assert.strictEqual(payRes.paymentStatus, 'partially_paid')

      const fin = genericRepository.getById(restId, 'orderFinancials', 'order_local_1')
      assert.strictEqual(fin.paidCents, 200000)
      assert.strictEqual(fin.paymentStatus, 'partially_paid')
    })

    await itAsync('settles full payment and frees table if order is served', async () => {
      // First mark order as served
      runLocalOperation(restId, 'transitionOrder', {
        orderId: 'order_local_1',
        status: 'served',
      })

      // Pay remaining 271500 cents
      const payRes = runLocalOperation(restId, 'recordPayment', {
        orderId: 'order_local_1',
        paymentId: 'pay_final_1',
        amountCents: 271500,
        method: 'card',
      })

      assert.strictEqual(payRes.paymentStatus, 'paid')

      // Check table is now free!
      const table = genericRepository.getById(restId, 'tables', 'table_8')
      assert.strictEqual(table.status, 'available')
      assert.strictEqual(table.currentOrderId, null)
    })

    // ─── T4: recordRefund Operation ─────────────────────────────────────
    console.log('\n[Suite 4: recordRefund Operation]')
    await itAsync('records refund and updates financial status', async () => {
      const refundRes = runLocalOperation(restId, 'recordRefund', {
        orderId: 'order_local_1',
        refundId: 'ref_1',
        amountCents: 50000,
        reason: 'Customer complaint',
      })

      assert.strictEqual(refundRes.paymentStatus, 'partially_refunded')
      const fin = genericRepository.getById(restId, 'orderFinancials', 'order_local_1')
      assert.strictEqual(fin.refundedCents, 50000)
    })

    // ─── T5: Inventory Adjust & Stock Movements ──────────────────────────
    console.log('\n[Suite 5: Inventory Adjustments]')
    await itAsync('adjusts inventory stock and logs movement record', async () => {
      const adjRes = runLocalOperation(restId, 'adjustInventory', {
        ingredientId: 'inv_chicken',
        movementType: 'spoilage',
        quantity: -1.5,
        reason: 'Expired stock',
      })

      assert.strictEqual(adjRes.currentStock, 7.5)
      const movements = genericRepository.query(restId, 'stockMovements', [
        ['ingredientId', '==', 'inv_chicken'],
      ])
      assert(movements.length >= 2, 'Stock movements recorded')
    })

    // ─── T6: Dashboard Summary ──────────────────────────────────────────
    console.log('\n[Suite 6: Dashboard Summary Calculation]')
    it('aggregates revenue and order counts correctly from SQLite', () => {
      const summary = runLocalOperation(restId, 'getDashboardSummary')
      assert.strictEqual(summary.totalOrdersCount, 1)
      assert.strictEqual(summary.totalRevenueCents, 471500)
    })

    // ─── T7: IPC Registration ───────────────────────────────────────────
    console.log('\n[Suite 7: IPC Registration]')
    it('registers pos IPC handlers without error', () => {
      registerPosIpc()
      assert(true)
    })

    console.log('\n========================================')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('========================================\n')

    closeDb()
    process.exit(failed > 0 ? 1 : 0)
  } catch (fatal) {
    console.error('Fatal test error:', fatal)
    closeDb()
    process.exit(1)
  }
})
