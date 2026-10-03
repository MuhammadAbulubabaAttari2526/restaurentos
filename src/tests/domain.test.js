import { describe, expect, it } from 'vitest'
import { calculateTotals, canTransitionOrder, formatMoney, friendlyError } from '../utils/domain.js'

describe('calculateTotals', () => {
  it('calculates subtotal and tax in integer cents', () => {
    expect(calculateTotals([
      { unitPriceCents: 1299, quantity: 2 },
      { unitPriceCents: 525, quantity: 1 },
    ], 0.0875)).toEqual({ subtotalCents: 3123, discountCents: 0, taxCents: 273, totalCents: 3396 })
  })

  it('caps discounts at the subtotal before tax', () => {
    expect(calculateTotals([{ unitPriceCents: 500, quantity: 1 }], 0.1, 900)).toEqual({
      subtotalCents: 500, discountCents: 500, taxCents: 0, totalCents: 0,
    })
  })
})

describe('order state transitions', () => {
  it('allows valid order progress and rejects skipped states', () => {
    expect(canTransitionOrder('queued', 'preparing')).toBe(true)
    expect(canTransitionOrder('preparing', 'ready')).toBe(true)
    expect(canTransitionOrder('queued', 'served')).toBe(false)
    expect(canTransitionOrder('served', 'cancelled')).toBe(false)
  })
})

describe('friendly errors', () => {
  it('translates invalid credentials into clear guidance', () => {
    expect(friendlyError({ code: 'auth/invalid-credential' })).toBe('Email or password is incorrect.')
  })

  it('handles missing or malformed error objects without crashing', () => {
    expect(friendlyError(null)).toBe('Something went wrong. Please try again.')
    expect(friendlyError({})).toBe('Something went wrong. Please try again.')
  })
})

describe('safe totals and formatting', () => {
  it('handles missing or invalid item arrays without crashing', () => {
    expect(calculateTotals(undefined)).toEqual({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 })
    expect(calculateTotals(null, 0.1, 100)).toEqual({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 })
    expect(formatMoney('bad')).toBe('Rs. 0.00')
  })
})

describe('Pakistani currency formatting', () => {
  it('renders new and legacy USD records as rupees', () => {
    expect(formatMoney(0, 'PKR')).toBe('Rs. 0.00')
    expect(formatMoney(12500, 'USD')).toBe('Rs. 125.00')
  })
})
