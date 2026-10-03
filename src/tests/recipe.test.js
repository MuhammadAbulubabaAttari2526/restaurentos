import { describe, expect, it } from 'vitest'
import { calculateRecipeNeeds } from '../../functions/domain.js'

describe('recipe inventory consumption', () => {
  it('aggregates ingredient needs across menu lines and quantities', () => {
    const menu = new Map([
      ['soup', { recipe: [{ ingredientId: 'stock-a', quantity: 0.2 }] }],
      ['stew', { recipe: [{ ingredientId: 'stock-a', quantity: 0.3 }, { ingredientId: 'stock-b', quantity: 1 }] }],
    ])
    expect(calculateRecipeNeeds([
      { itemId: 'soup', quantity: 2 }, { itemId: 'stew', quantity: 1 },
    ], menu)).toEqual(new Map([['stock-a', 0.7], ['stock-b', 1]]))
  })

  it('rejects invalid recipe references and non-positive ingredient quantities', () => {
    expect(() => calculateRecipeNeeds([{ itemId: 'meal', quantity: 1 }], new Map([
      ['meal', { recipe: [{ ingredientId: '../other-tenant', quantity: 1 }] }],
    ]))).toThrow('A recipe references an invalid stock item.')
    expect(() => calculateRecipeNeeds([{ itemId: 'meal', quantity: 1 }], new Map([
      ['meal', { recipe: [{ ingredientId: 'stock-a', quantity: 0 }] }],
    ]))).toThrow('Recipe quantities must be positive and within the allowed range.')
  })
})