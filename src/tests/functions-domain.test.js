import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { applyPayment, applyRefund, normalizeWeightOptions, priceMenuLine } from '../../functions/domain.js'

const { priceMenuLine: priceLocalMenuLine } = createRequire(import.meta.url)('../../database/domain.cjs')

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

describe('weight-wise menu pricing', () => {
  const chicken = {
    name: 'Chicken',
    priceCents: 60000,
    itemType: 'weight-wise',
    weightOptions: [
      { id: '250g', weightValue: 250, weightUnit: 'g', priceCents: 60000 },
      { id: 'halfkg', weightValue: 0.5, weightUnit: 'kg', priceCents: 110000 },
      { id: '1kg', weightValue: 1, weightUnit: 'kg', priceCents: 220000 },
    ],
    variants: [],
    addOns: [],
  }

  it('uses the saved price for the selected weight and stores its label and line total', () => {
    expect(priceMenuLine(chicken, {
      itemId: 'chicken', quantity: 2, selectedWeightOptionId: 'halfkg', unitPriceCents: 1,
    })).toMatchObject({
      unitPriceCents: 110000,
      quantity: 2,
      lineTotalCents: 220000,
      selectedWeight: { id: 'halfkg', value: 0.5, unit: 'kg', label: '0.5 kg' },
    })
  })

  it('rejects a missing or forged weight selection instead of using the base price', () => {
    expect(() => priceMenuLine(chicken, { itemId: 'chicken', quantity: 1 })).toThrow('Choose a valid weight for this item.')
    expect(() => priceMenuLine(chicken, { itemId: 'chicken', quantity: 1, selectedWeightOptionId: 'forged' })).toThrow('Choose a valid weight for this item.')
  })

  it('rejects equivalent gram and kilogram options, non-positive weights, and prices', () => {
    expect(() => normalizeWeightOptions([
      { id: 'one', weightValue: 500, weightUnit: 'g', priceCents: 100 },
      { id: 'two', weightValue: 0.5, weightUnit: 'kg', priceCents: 100 },
    ])).toThrow('Each weight must be unique')
    expect(() => normalizeWeightOptions([{ id: 'zero', weightValue: 0, weightUnit: 'g', priceCents: 100 }])).toThrow('Weight must be a positive number.')
    expect(() => normalizeWeightOptions([{ id: 'free', weightValue: 10, weightUnit: 'g', priceCents: 0 }])).toThrow('Each weight needs a valid positive price.')
  })

  it('keeps legacy standard items on base pricing and rejects weight IDs on them', () => {
    const legacyItem = { name: 'Tea', priceCents: 2500 }
    expect(priceMenuLine(legacyItem, { itemId: 'tea', quantity: 2 }).lineTotalCents).toBe(5000)
    expect(() => priceMenuLine(legacyItem, { itemId: 'tea', quantity: 1, selectedWeightOptionId: 'forged' })).toThrow('This item does not use weight pricing.')
  })

  it('uses the same trusted weight price in the offline SQLite domain', () => {
    expect(priceLocalMenuLine(chicken, { itemId: 'chicken', quantity: 2, selectedWeightOptionId: 'halfkg' }))
      .toMatchObject({ unitPriceCents: 110000, lineTotalCents: 220000, selectedWeight: { label: '0.5 kg' } })
  })
})
