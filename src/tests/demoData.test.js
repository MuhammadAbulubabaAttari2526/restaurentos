import { afterEach, describe, expect, it } from 'vitest'
import {
  activateDemoSession, clearDemoSession, demoMembership, demoUser, isDemoSession,
  runDemoOperation, watchDemoRecords,
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
