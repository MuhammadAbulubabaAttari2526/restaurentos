import { afterEach, describe, expect, it } from 'vitest'
import {
  activateDemoSession, clearDemoSession, demoMembership, demoUser, isDemoSession,
  runDemoOperation, saveDemoRecord, watchDemoRecords,
} from '../services/demoData.js'

afterEach(() => clearDemoSession())

describe('isolated sample workspace', () => {
  it('identifies a demo-only owner session and offers sample records', () => {
    activateDemoSession()
    expect(isDemoSession()).toBe(true)
    expect(demoUser.uid).toBe('demo-owner')
    expect(demoMembership.demo).toBe(true)
    let menu = []
    const unsubscribe = watchDemoRecords('menuItems', (rows) => { menu = rows })
    expect(menu.length).toBeGreaterThan(0)
    expect(menu[0].restaurantId).toBeUndefined()
    unsubscribe()
  })

  it('creates sample orders and records payment without Firebase', async () => {
    const requestId = `test-order-${crypto.randomUUID()}`
    const order = await runDemoOperation('createOrder', {
      requestId, type: 'takeaway', items: [{ itemId: 'lemonade', quantity: 1 }],
    })
    expect(order).toMatchObject({ orderId: requestId, duplicate: false })

    const payment = await runDemoOperation('recordPayment', {
      paymentId: `test-payment-${crypto.randomUUID()}`, orderId: requestId, amountCents: 33600, method: 'cash',
    })
    expect(payment).toMatchObject({ paidCents: 33600, paymentStatus: 'paid', duplicate: false })
  })

  it('preserves a demo draft creation time when saving it again', async () => {
    const draft = {
      draftId: `test-draft-${crypto.randomUUID()}`,
      type: 'takeaway',
      items: [{ itemId: 'lemonade', quantity: 1 }],
    }
    await runDemoOperation('saveOrderDraft', draft)
    let drafts = []
    const unsubscribe = watchDemoRecords('draftOrders', (rows) => { drafts = rows })
    const createdAt = drafts.find((entry) => entry.id === draft.draftId).createdAt

    await runDemoOperation('saveOrderDraft', draft)

    expect(drafts.find((entry) => entry.id === draft.draftId).createdAt.getTime()).toBe(createdAt.getTime())
    unsubscribe()
  })

  it('allows demo users to delete only their own drafts', async () => {
    const ownDraftId = `test-draft-${crypto.randomUUID()}`
    await runDemoOperation('saveOrderDraft', {
      draftId: ownDraftId, type: 'takeaway', items: [{ itemId: 'lemonade', quantity: 1 }],
    })
    expect(await runDemoOperation('deleteOrderDraft', { draftId: ownDraftId })).toMatchObject({ deleted: true })

    const foreignDraftId = saveDemoRecord('draftOrders', { createdBy: 'other-user' }, null)
    await expect(runDemoOperation('deleteOrderDraft', { draftId: foreignDraftId })).rejects.toThrow('This draft belongs to another team member.')
  })

  it('soft-removes demo staff while keeping the record inactive', async () => {
    activateDemoSession()
    await runDemoOperation('deleteStaffMember', { userId: 'demo-cashier' })
    let staff = []
    const unsubscribe = watchDemoRecords('users', (rows) => { staff = rows })
    const removed = staff.find((entry) => entry.id === 'demo-cashier')

    expect(removed.active).toBe(false)
    expect(removed.removedAt).toBeInstanceOf(Date)
    unsubscribe()
  })

  it('mirrors payment status onto demo orders and releases a served paid table', async () => {
    activateDemoSession()
    let orders = []
    let tables = []
    const unsubscribeOrders = watchDemoRecords('orders', (rows) => { orders = rows })
    const unsubscribeTables = watchDemoRecords('tables', (rows) => { tables = rows })
    const created = await runDemoOperation('createOrder', {
      requestId: 'served-demo-order', type: 'dine-in', tableId: 'table-2',
      items: [{ itemId: 'lemonade', quantity: 1 }],
    })
    await runDemoOperation('recordPayment', {
      paymentId: 'served-demo-payment', orderId: created.orderId, amountCents: created.totalCents, method: 'cash',
    })
    await runDemoOperation('transitionOrder', { orderId: created.orderId, to: 'preparing', requestId: 'served-demo-preparing' })
    await runDemoOperation('transitionOrder', { orderId: created.orderId, to: 'ready', requestId: 'served-demo-ready' })
    await runDemoOperation('transitionOrder', { orderId: created.orderId, to: 'served', requestId: 'served-demo-served' })

    expect(orders.find((entry) => entry.id === created.orderId).paymentStatus).toBe('paid')
    expect(tables.find((entry) => entry.id === 'table-2').status).toBe('available')
    unsubscribeOrders()
    unsubscribeTables()
  })

  it('restores demo recipe stock once when cancelling an order', async () => {
    activateDemoSession()
    let inventory = []
    let movements = []
    const unsubscribeInventory = watchDemoRecords('inventory', (rows) => { inventory = rows })
    const unsubscribeMovements = watchDemoRecords('stockMovements', (rows) => { movements = rows })
    const startingChicken = inventory.find((entry) => entry.id === 'chicken').quantityOnHand
    const created = await runDemoOperation('createOrder', {
      requestId: 'cancel-demo-order', type: 'takeaway',
      items: [{ itemId: 'grilled-chicken', quantity: 1 }],
    })
    const cancellation = { orderId: created.orderId, requestId: 'cancel-demo-request', to: 'cancelled', reason: 'Guest changed plans' }

    const first = await runDemoOperation('transitionOrder', cancellation)
    const second = await runDemoOperation('transitionOrder', cancellation)

    expect(first).toMatchObject({ status: 'cancelled', duplicate: false })
    expect(second).toMatchObject({ duplicate: true })
    expect(inventory.find((entry) => entry.id === 'chicken').quantityOnHand).toBe(startingChicken)
    expect(movements.find((entry) => entry.id === 'cancel-demo-order_cancel_chicken')).toMatchObject({
      movementType: 'order_cancel_restock', quantity: 0.18, orderId: created.orderId,
    })
    unsubscribeInventory()
    unsubscribeMovements()
  })

  it('releases demo tables for all settled payment states, including payment after serving', async () => {
    activateDemoSession()
    let tables = []
    let orders = []
    const unsubscribeTables = watchDemoRecords('tables', (rows) => { tables = rows })
    const unsubscribeOrders = watchDemoRecords('orders', (rows) => { orders = rows })
    const cases = [
      { tableId: 'table-2', status: 'paid', refundCents: 0 },
      { tableId: 'table-3', status: 'partially_refunded', refundCents: 100 },
      { tableId: 'patio-1', status: 'refunded', refundCents: null },
    ]

    for (const [index, scenario] of cases.entries()) {
      const orderId = `settled-demo-order-${index}`
      const paymentId = `settled-demo-payment-${index}`
      const created = await runDemoOperation('createOrder', {
        requestId: orderId, type: 'dine-in', tableId: scenario.tableId,
        items: [{ itemId: 'lemonade', quantity: 1 }],
      })
      await runDemoOperation('recordPayment', {
        paymentId, orderId, amountCents: created.totalCents, method: 'cash',
      })
      if (scenario.status !== 'paid') {
        await runDemoOperation('recordRefund', {
          refundId: `settled-demo-refund-${index}`, orderId,
          amountCents: scenario.refundCents ?? created.totalCents, reason: 'Settlement status test',
        })
      }
      for (const [transitionIndex, to] of ['preparing', 'ready', 'served'].entries()) {
        await runDemoOperation('transitionOrder', {
          orderId, requestId: `${orderId}-transition-${transitionIndex}`, to,
        })
      }
      expect(orders.find((entry) => entry.id === orderId).paymentStatus).toBe(scenario.status)
      expect(tables.find((entry) => entry.id === scenario.tableId).status).toBe('available')
    }

    const afterServe = await runDemoOperation('createOrder', {
      requestId: 'settled-demo-order-after-serve', type: 'dine-in', tableId: 'table-2',
      items: [{ itemId: 'lemonade', quantity: 1 }],
    })
    await runDemoOperation('transitionOrder', { orderId: afterServe.orderId, requestId: 'after-serve-preparing', to: 'preparing' })
    await runDemoOperation('transitionOrder', { orderId: afterServe.orderId, requestId: 'after-serve-ready', to: 'ready' })
    await runDemoOperation('transitionOrder', { orderId: afterServe.orderId, requestId: 'after-serve-served', to: 'served' })
    await runDemoOperation('recordPayment', {
      paymentId: 'after-serve-payment', orderId: afterServe.orderId,
      amountCents: afterServe.totalCents, method: 'cash',
    })

    expect(tables.find((entry) => entry.id === 'table-2').status).toBe('available')
    unsubscribeTables()
    unsubscribeOrders()
  })

  it('keeps demo order totals populated for display and payments', () => {
    activateDemoSession()
    let records = []
    const unsubscribe = watchDemoRecords('orderFinancials', (rows) => { records = rows })

    expect(records.length).toBeGreaterThan(0)
    expect(records[0].totalCents).toBeGreaterThan(0)
    expect(records[0].items[0].unitPriceCents).toBeGreaterThan(0)

    unsubscribe()
  })
})
