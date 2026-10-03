import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  currentUser: { uid: 'owner-1', getIdTokenResult: vi.fn() },
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
    doc: (_database, ...segments) => ({ path: segments.join('/') }),
    getDoc: mocks.getDoc,
    runTransaction: mocks.runTransaction,
    serverTimestamp: mocks.serverTimestamp,
  }
})

import { runSparkOperation } from '../services/sparkOperations.js'

describe('Spark order draft persistence', () => {
  beforeEach(() => {
    mocks.records = new Map([
      ['restaurants/restaurant-1/users/owner-1', { active: true, role: 'owner' }],
      ['restaurants/restaurant-1/menuItems/menu-1', { available: true, priceCents: 500 }],
    ])
    mocks.currentUser.getIdTokenResult.mockResolvedValue({ claims: { restaurantId: 'restaurant-1', role: 'owner' } })
    mocks.getDoc.mockImplementation(async (reference) => snapshotFor(reference.path))
    mocks.serverTimestamp.mockImplementation(() => ({ timestamp: Symbol('server timestamp') }))
    mocks.runTransaction.mockImplementation(async (_database, operation) => {
      const writes = []
      const transaction = {
        get: async (reference) => snapshotFor(reference.path),
        set: (reference, value) => writes.push([reference.path, value]),
        delete: (reference) => writes.push([reference.path, undefined]),
      }
      const result = await operation(transaction)
      for (const [path, value] of writes) {
        if (value === undefined) mocks.records.delete(path)
        else mocks.records.set(path, value)
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
})

function snapshotFor(path) {
  return {
    exists: () => mocks.records.has(path),
    data: () => mocks.records.get(path),
  }
}