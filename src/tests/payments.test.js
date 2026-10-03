import { describe, expect, it } from 'vitest'
import { applyPayment, applyRefund, isSettledPaymentStatus, shouldLoadFinancialForTransition } from '../../functions/domain.js'

describe('trusted payment transitions', () => {
  it('supports partial tender and counts a visit exactly on final payment', () => {
    expect(applyPayment({ totalCents: 1000, paidCents: 0 }, 400)).toMatchObject({ paidCents: 400, paymentStatus: 'partially_paid', customerVisitCounted: false })
    expect(applyPayment({ totalCents: 1000, paidCents: 400 }, 600)).toMatchObject({ paidCents: 1000, paymentStatus: 'paid', customerVisitCounted: true })
    expect(applyPayment({ totalCents: 1000, paidCents: 900 }, 100).customerVisitCounted).toBe(true)
    expect(() => applyPayment({ totalCents: 1000, paidCents: 1000, customerVisitCounted: true }, 1)).toThrow('Payment is greater than the remaining balance.')
  })

  it('rejects overpayment and invalid amounts', () => {
    expect(() => applyPayment({ totalCents: 1000, paidCents: 950 }, 100)).toThrow('Payment is greater than the remaining balance.')
    expect(() => applyPayment({ totalCents: 1000, paidCents: 0 }, 0)).toThrow('Enter a valid payment amount.')
  })

  it('retains partial refunds and marks full reversals distinctly', () => {
    expect(applyRefund({ paidCents: 1000, refundedCents: 0 }, 300)).toEqual({ refundedCents: 300, fullyRefunded: false, paymentStatus: 'partially_refunded' })
    expect(applyRefund({ paidCents: 1000, refundedCents: 300 }, 700)).toEqual({ refundedCents: 1000, fullyRefunded: true, paymentStatus: 'refunded' })
    expect(() => applyRefund({ paidCents: 1000, refundedCents: 500 }, 501)).toThrow('Refund cannot exceed the amount paid and not already refunded.')
  })

  it('treats paid, partial refunds and full refunds as settled for the table and dashboard', () => {
    expect(isSettledPaymentStatus('paid')).toBe(true)
    expect(isSettledPaymentStatus('partially_refunded')).toBe(true)
    expect(isSettledPaymentStatus('refunded')).toBe(true)
    expect(isSettledPaymentStatus('unpaid')).toBe(false)
    expect(isSettledPaymentStatus('partially_paid')).toBe(false)
  })
})

describe('order transition reads', () => {
  it('loads finance for served transitions when payment status decides whether the table can clear', () => {
    expect(shouldLoadFinancialForTransition('preparing', 'waiter')).toBe(false)
    expect(shouldLoadFinancialForTransition('ready', 'waiter')).toBe(false)
    expect(shouldLoadFinancialForTransition('cancelled', 'waiter')).toBe(true)
    expect(shouldLoadFinancialForTransition('served', 'waiter')).toBe(true)
    expect(shouldLoadFinancialForTransition('served', 'cashier')).toBe(true)
  })
})
