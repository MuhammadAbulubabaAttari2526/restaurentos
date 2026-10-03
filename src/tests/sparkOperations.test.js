import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  currentUser: { uid: 'owner-1', getIdTokenResult: vi.fn() },
  denyFinanceReads: false,
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  records: new Map(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(),
}))

vi.mock('../lib/firebase.js', () => ({ auth: { currentUser: mocks.currentUser }, db: {} }))
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
      collection: (_database, ...segments) => ({ path: segments.join('/') }),
      doc: (databaseOrCollection, ...segments) => ({
        path: segments.length ? segments.join('/') : `${databaseOrCollection.path}/generated`,
      }),
    getDocs: mocks.getDocs,
    getDoc: mocks.getDoc,
    limit: (count) => ({ type: 'limit', count }),
    orderBy: (field, direction) => ({ type: 'orderBy', field, direction }),
    query: (reference, ...constraints) => ({ collectionPath: reference.path, constraints }),
    runTransaction: mocks.runTransaction,
    serverTimestamp: mocks.serverTimestamp,
    where: (field, operation, value) => ({ type: 'where', field, operation, value }),
  }
})

import { runSparkOperation } from '../services/sparkOperations.js'

describe('Spark order draft persistence', () => {
  beforeEach(() => {
    mocks.records = new Map([
      ['restaurants/restaurant-1/users/owner-1', { active: true, role: 'owner' }],
      ['restaurants/restaurant-1/menuItems/menu-1', { available: true, priceCents: 500 }],
    ])
    mocks.denyFinanceReads = false
    mocks.currentUser.uid = 'owner-1'
    mocks.getDocs.mockReset()
    mocks.getDocs.mockResolvedValue({ docs: [] })
    mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { restaurantId: 'restaurant-1', role: 'owner' } })
    mocks.getDoc.mockImplementation(async (reference) => snapshotFor(reference.path))
    mocks.serverTimestamp.mockImplementation(() => ({ timestamp: Symbol('server timestamp') }))
    mocks.runTransaction.mockImplementation(async (_database, operation) => {
      const writes = []
      const transaction = {
        get: async (reference) => {
          if (mocks.denyFinanceReads && reference.path.includes('/orderFinancials/')) throw new Error('Permission denied')
          return snapshotFor(reference.path)
        },
        set: (reference, value) => writes.push([reference.path, value]),
        delete: (reference) => writes.push([reference.path, undefined]),
        update: (reference, value) => writes.push([reference.path, value, true]),
      }
      const result = await operation(transaction)
      for (const [path, value, merge] of writes) {
        if (value === undefined) mocks.records.delete(path)
        else mocks.records.set(path, merge ? { ...mocks.records.get(path), ...value } : value)
      }
      return result
    })
  })

  it('preserves createdAt when saving the same draft again', async () => {
    const draft = {
      draftId: 'draft-1',
      type: 'takeaway',
      items: [{ itemId: 'menu-1', quantity: 1 }],
    }

    await runSparkOperation('saveOrderDraft', draft)
    const createdAt = mocks.records.get('restaurants/restaurant-1/draftOrders/draft-1').createdAt
    await runSparkOperation('saveOrderDraft', draft)

    expect(mocks.records.get('restaurants/restaurant-1/draftOrders/draft-1').createdAt).toBe(createdAt)
  })

  it('allows a cashier to delete their own draft', async () => {
    mocks.currentUser.uid = 'cashier-1'
    mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { restaurantId: 'restaurant-1', role: 'cashier' } })
    mocks.records.set('restaurants/restaurant-1/draftOrders/cashier-draft', { createdBy: 'cashier-1' })

    const result = await runSparkOperation('deleteOrderDraft', { draftId: 'cashier-draft' })

    expect(result).toEqual({ draftId: 'cashier-draft', deleted: true })
    expect(mocks.records.has('restaurants/restaurant-1/draftOrders/cashier-draft')).toBe(false)
  })

  it('lets a waiter mark an order served without reading its finance record', async () => {
    mocks.currentUser.uid = 'waiter-1'
    mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { restaurantId: 'restaurant-1', role: 'waiter' } })
    mocks.records.set('restaurants/restaurant-1/users/waiter-1', { active: true, role: 'waiter' })
    mocks.records.set('restaurants/restaurant-1/orders/order-1', {
      status: 'ready', tableId: 'table-1', paymentStatus: 'unpaid',
    })
    mocks.denyFinanceReads = true

    const result = await runSparkOperation('transitionOrder', {
      orderId: 'order-1', requestId: 'transition-1', to: 'served',
    })

    expect(result).toMatchObject({ orderId: 'order-1', status: 'served', duplicate: false })
    expect(mocks.records.get('restaurants/restaurant-1/orders/order-1').status).toBe('served')
  })

  it('soft-removes a staff member without deleting their membership', async () => {
    mocks.records.set('restaurants/restaurant-1/users/staff-1', { role: 'cashier', active: true })
    mocks.records.set('accountMemberships/staff-1', { restaurantId: 'restaurant-1', role: 'cashier', active: true })

    await runSparkOperation('deleteStaffMember', { userId: 'staff-1' })

    expect(mocks.records.get('restaurants/restaurant-1/users/staff-1')).toMatchObject({ active: false })
    expect(mocks.records.get('restaurants/restaurant-1/users/staff-1').removedAt).toBeDefined()
    expect(mocks.records.get('accountMemberships/staff-1').active).toBe(true)
  })

  it('restores recipe stock once when an order is cancelled', async () => {
    mocks.records.set('restaurants/restaurant-1/orders/order-1', {
      status: 'queued', tableId: null, items: [{ itemId: 'menu-1', quantity: 2 }],
    })
    mocks.records.set('restaurants/restaurant-1/orderFinancials/order-1', { paidCents: 0, paymentStatus: 'unpaid' })
    mocks.records.set('restaurants/restaurant-1/menuItems/menu-1', {
      available: true, priceCents: 500, recipe: [{ ingredientId: 'stock-1', quantity: 0.5 }],
    })
    mocks.records.set('restaurants/restaurant-1/inventory/stock-1', {
      name: 'Rice', unit: 'kg', quantityOnHand: 1, averageCostCents: 300,
    })
    const cancellation = { orderId: 'order-1', requestId: 'cancel-1', to: 'cancelled', reason: 'Guest changed plans' }

    const first = await runSparkOperation('transitionOrder', cancellation)
    const second = await runSparkOperation('transitionOrder', cancellation)

    expect(first).toMatchObject({ status: 'cancelled', duplicate: false })
    expect(second).toMatchObject({ duplicate: true })
    expect(mocks.records.get('restaurants/restaurant-1/inventory/stock-1').quantityOnHand).toBe(2)
    expect(mocks.records.get('restaurants/restaurant-1/stockMovements/order-1_cancel_stock-1')).toMatchObject({
      movementType: 'order_cancel_restock', quantity: 1, orderId: 'order-1',
    })
  })

  it('resolves a legacy menu category name while creating an order', async () => {
    mocks.records.set('restaurants/restaurant-1/settings/profile', { taxRate: 0, paymentMethods: ['cash'] })
    mocks.records.set('restaurants/restaurant-1/menuItems/legacy-menu', {
      name: 'Legacy soup', categoryId: 'soups', priceCents: 500, available: true,
    })
    mocks.records.set('restaurants/restaurant-1/categories/soups', { name: 'Soup & starters' })

    await runSparkOperation('createOrder', {
      requestId: 'legacy-category-order', type: 'takeaway',
      items: [{ itemId: 'legacy-menu', quantity: 1 }],
    })

    expect(mocks.records.get('restaurants/restaurant-1/orderFinancials/legacy-category-order').items[0])
      .toMatchObject({ itemId: 'legacy-menu', categoryId: 'soups', categoryName: 'Soup & starters' })
  })

  it('marks a report truncated when a mocked query returns exactly its cap', async () => {
    const now = new Date()
    mocks.getDocs.mockImplementation(async ({ collectionPath }) => {
      const count = collectionPath.endsWith('/orderFinancials') ? 1000
        : collectionPath.endsWith('/expenses') ? 1000
          : 2000
      const row = collectionPath.endsWith('/orderFinancials')
        ? { status: 'active', createdAt: now, items: [], subtotalCents: 0, taxCents: 0, refundedCents: 0, discountCents: 0 }
        : collectionPath.endsWith('/expenses')
          ? { status: 'pending', date: '2026-10-01', amountCents: 0 }
          : { kind: 'payment', method: 'cash', amountCents: 1, createdAt: now }
      return { docs: Array.from({ length: count }, () => ({ data: () => row })) }
    })

    const report = await runSparkOperation('exportReport', { range: 'week' })

    expect(report.truncated).toBe(true)
  })

  it('blocks reservation creation when the mocked overlap query finds a booking', async () => {
    mocks.records.set('restaurants/restaurant-1/tables/table-1', { name: 'Table 1', capacity: 4, status: 'available' })
    mocks.getDocs.mockResolvedValue({ empty: false, docs: [{ id: 'existing-booking' }] })

    await expect(runSparkOperation('createReservation', {
      reservationId: 'overlap-reservation', tableId: 'table-1', guestName: 'Guest', covers: 2,
      startsAtMillis: Date.now() + 86400000, durationMinutes: 90,
    })).rejects.toThrow('That table already has a reservation during this time.')
  })

  it('marks the table occupied and links it when seating a reservation', async () => {
    const startsAt = { toMillis: () => Date.now() - 60000 }
    mocks.records.set('restaurants/restaurant-1/reservations/reservation-1', {
      status: 'booked', tableId: 'table-1', startsAt,
    })
    mocks.records.set('restaurants/restaurant-1/tables/table-1', { status: 'available', capacity: 4 })

    await runSparkOperation('seatReservation', { reservationId: 'reservation-1' })

    expect(mocks.records.get('restaurants/restaurant-1/reservations/reservation-1').status).toBe('seated')
    expect(mocks.records.get('restaurants/restaurant-1/tables/table-1')).toMatchObject({
      status: 'occupied', currentOrderId: null, currentReservationId: 'reservation-1',
    })
  })

  it('allows a future reservation on an occupied table when times do not overlap', async () => {
    mocks.records.set('restaurants/restaurant-1/tables/table-1', {
      name: 'Table 1', capacity: 4, status: 'occupied', currentOrderId: 'active-order',
    })
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] })

    const result = await runSparkOperation('createReservation', {
      reservationId: 'future-reservation', tableId: 'table-1', guestName: 'Future guest', covers: 2,
      startsAtMillis: Date.now() + 86400000, durationMinutes: 90,
    })

    expect(result).toMatchObject({ reservationId: 'future-reservation', duplicate: false })
    expect(mocks.records.get('restaurants/restaurant-1/reservations/future-reservation').status).toBe('booked')
  })

  it('lets the next POS order consume a seated reservation table link', async () => {
    mocks.records.set('restaurants/restaurant-1/settings/profile', { taxRate: 0, paymentMethods: ['cash'] })
    mocks.records.set('restaurants/restaurant-1/menuItems/menu-1', { name: 'Soup', priceCents: 500, available: true })
    mocks.records.set('restaurants/restaurant-1/tables/table-1', {
      name: 'Table 1', capacity: 4, status: 'occupied', currentOrderId: null, currentReservationId: 'reservation-1',
    })
    mocks.records.set('restaurants/restaurant-1/reservations/reservation-1', {
      status: 'seated', tableId: 'table-1',
    })
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] })

    const result = await runSparkOperation('createOrder', {
      requestId: 'reservation-pos-order', type: 'dine-in', tableId: 'table-1',
      items: [{ itemId: 'menu-1', quantity: 1 }],
    })

    expect(result).toMatchObject({ orderId: 'reservation-pos-order', duplicate: false })
    expect(mocks.records.get('restaurants/restaurant-1/tables/table-1')).toMatchObject({
      status: 'occupied', currentOrderId: 'reservation-pos-order', currentReservationId: null,
    })
  })

  it('stores the dine-in cover count on a newly created order', async () => {
    mocks.records.set('restaurants/restaurant-1/settings/profile', { taxRate: 0, paymentMethods: ['cash'] })
    mocks.records.set('restaurants/restaurant-1/menuItems/menu-1', { name: 'Soup', priceCents: 500, available: true })
    mocks.records.set('restaurants/restaurant-1/tables/table-1', { name: 'Table 1', capacity: 4, status: 'available' })
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] })

    await runSparkOperation('createOrder', {
      requestId: 'covers-order', type: 'dine-in', tableId: 'table-1', covers: 3,
      items: [{ itemId: 'menu-1', quantity: 1 }],
    })

    expect(mocks.records.get('restaurants/restaurant-1/orders/covers-order').covers).toBe(3)
  })

  it('uses covers instead of item count when transferring a table', async () => {
    mocks.records.set('restaurants/restaurant-1/orders/transfer-order', {
      status: 'ready', type: 'dine-in', tableId: 'old-table', covers: 2,
      items: [{ itemId: 'menu-1', quantity: 4 }],
    })
    mocks.records.set('restaurants/restaurant-1/tables/old-table', { status: 'occupied', currentOrderId: 'transfer-order' })
    mocks.records.set('restaurants/restaurant-1/tables/target-table', { name: 'Target', status: 'available', capacity: 3 })
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] })

    const result = await runSparkOperation('transferOrderTable', { orderId: 'transfer-order', targetTableId: 'target-table' })

    expect(result).toMatchObject({ targetTableId: 'target-table', duplicate: false })
    expect(mocks.records.get('restaurants/restaurant-1/orders/transfer-order').tableId).toBe('target-table')
  })

  it('skips transfer capacity checks for legacy orders without covers', async () => {
    mocks.records.set('restaurants/restaurant-1/orders/legacy-transfer-order', {
      status: 'ready', type: 'dine-in', tableId: 'old-table',
      items: [{ itemId: 'menu-1', quantity: 4 }],
    })
    mocks.records.set('restaurants/restaurant-1/tables/old-table', { status: 'occupied', currentOrderId: 'legacy-transfer-order' })
    mocks.records.set('restaurants/restaurant-1/tables/target-table', { name: 'Target', status: 'available', capacity: 1 })
    mocks.getDocs.mockResolvedValue({ empty: true, docs: [] })

    const result = await runSparkOperation('transferOrderTable', { orderId: 'legacy-transfer-order', targetTableId: 'target-table' })

    expect(result).toMatchObject({ targetTableId: 'target-table', duplicate: false })
  })
})

function snapshotFor(path) {
  return {
    exists: () => mocks.records.has(path),
    data: () => mocks.records.get(path),
  }
}