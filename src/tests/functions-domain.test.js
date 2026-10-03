import { describe, expect, it } from 'vitest'
import { applyPayment, applyRefund, priceMenuLine } from '../../functions/domain.js'

describe('trusted menu option pricing', () => {
  const item = {
    name: 'Pasta',
    priceCents: 1200,
    variants: [{ id: 'large', name: 'Large', priceDeltaCents: 300 }],
    addOns: [{ id: 'cheese', name: 'Extra cheese', priceCents: 125 }],
  }

  it('prices selected variants and add-ons from the saved menu', () => {
    expect(priceMenuLine(item, {
      itemId: 'pasta', quantity: 2, selectedVariantId: 'large', selectedAddOnIds: ['cheese'],
    })).toMatchObject({
      name: 'Pasta', unitPriceCents: 1625, quantity: 2,
      selectedVariant: { name: 'Large', priceDeltaCents: 300 },
      selectedAddOns: [{ name: 'Extra cheese', priceCents: 125 }],
    })
  })

  it('ignores forged browser prices and rejects unknown option IDs', () => {
    expect(priceMenuLine(item, { itemId: 'pasta', quantity: 1, unitPriceCents: 1 }).unitPriceCents).toBe(1200)
    expect(() => priceMenuLine(item, { itemId: 'pasta', quantity: 1, selectedVariantId: 'forged' }))
      .toThrow('A selected size or variant is no longer available.')
  })

  it('rejects duplicate add-ons and invalid negative final prices', () => {
    expect(() => priceMenuLine(item, { itemId: 'pasta', quantity: 1, selectedAddOnIds: ['cheese', 'cheese'] }))
      .toThrow('Choose up to 10 unique add-ons.')
    expect(() => priceMenuLine({ ...item, variants: [{ id: 'discount', name: 'Small', priceDeltaCents: -1300 }] }, {
      itemId: 'pasta', quantity: 1, selectedVariantId: 'discount',
    })).toThrow('The selected menu options produce an invalid price.')
  })

  it('rejects missing menu items and malformed financial records gracefully', () => {
    expect(() => priceMenuLine(null, { itemId: 'missing', quantity: 1 })).toThrow('A menu item is invalid. Ask a manager to review the menu.')
    expect(() => applyPayment(null, 100)).toThrow('Order financial details were not found.')
    expect(() => applyRefund(undefined, 100)).toThrow('Order financial details were not found.')
  })
})