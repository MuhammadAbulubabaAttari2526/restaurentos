function validOption(option, field, allowNegative = false) {
  if (!option || typeof option !== 'object' || typeof option.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(option.id)) {
    throw new Error('A configured menu option is invalid.')
  }
  if (typeof option.name !== 'string' || !option.name.trim() || option.name.length > 100) {
    throw new Error('A configured menu option name is invalid.')
  }
  const price = option[field]
  if (!Number.isSafeInteger(price) || (allowNegative ? Math.abs(price) > 100000000 : price < 0 || price > 100000000)) {
    throw new Error('A configured menu option price is invalid.')
  }
  return { id: option.id, name: option.name.trim(), price }
}

export function normalizeWeightOptions(options) {
  if (!Array.isArray(options)) throw new Error('This menu item has invalid weight settings.')
  const ids = new Set()
  const weights = new Set()
  return options.map((option) => {
    if (!option || typeof option !== 'object' || typeof option.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(option.id) || ids.has(option.id)) {
      throw new Error('A configured weight option is invalid.')
    }
    if (typeof option.weightValue !== 'number' || !Number.isFinite(option.weightValue) || option.weightValue <= 0) {
      throw new Error('Weight must be a positive number.')
    }
    if (!['g', 'kg'].includes(option.weightUnit)) throw new Error('Choose grams or kilograms for each weight.')
    const grams = option.weightValue * (option.weightUnit === 'kg' ? 1000 : 1)
    const milliGrams = Math.round(grams * 1000)
    if (!Number.isSafeInteger(milliGrams) || milliGrams < 1 || milliGrams > 1000000000 || Math.abs(grams * 1000 - milliGrams) > 0.000001) {
      throw new Error('Weight must be within 0.001 g and 1,000 kg.')
    }
    if (weights.has(milliGrams)) throw new Error('Each weight must be unique, including equivalent gram and kilogram values.')
    if (!Number.isSafeInteger(option.priceCents) || option.priceCents < 1 || option.priceCents > 100000000) {
      throw new Error('Each weight needs a valid positive price.')
    }
    ids.add(option.id)
    weights.add(milliGrams)
    return { id: option.id, weightValue: option.weightValue, weightUnit: option.weightUnit, priceCents: option.priceCents }
  })
}

export function formatWeightLabel(option) {
  return `${String(option.weightValue)} ${option.weightUnit}`
}

export function priceMenuLine(menuItem, line) {
  if (!menuItem || typeof menuItem !== 'object') {
    throw new Error('A menu item is invalid. Ask a manager to review the menu.')
  }
  if (!line || typeof line !== 'object') {
    throw new Error('This menu line is invalid.')
  }
  const itemType = menuItem.itemType || 'non-weight-wise'
  if (!['non-weight-wise', 'weight-wise'].includes(itemType)) throw new Error('This menu item type is invalid.')
  if (itemType === 'non-weight-wise' && (!Number.isSafeInteger(menuItem.priceCents) || menuItem.priceCents < 0)) {
    throw new Error('A menu price is invalid. Ask a manager to review the menu.')
  }
  const variants = Array.isArray(menuItem.variants) ? menuItem.variants : []
  const addOns = Array.isArray(menuItem.addOns) ? menuItem.addOns : []
  if (variants.length > 20 || addOns.length > 20) {
    throw new Error('This menu item has invalid option settings.')
  }

  const configuredVariants = variants.map((option) => validOption(option, 'priceDeltaCents', true))
  const configuredAddOns = addOns.map((option) => validOption(option, 'priceCents'))
  const weightOptions = itemType === 'weight-wise' ? normalizeWeightOptions(menuItem.weightOptions) : []
  if (itemType === 'weight-wise' && variants.length) throw new Error('Weight-wise items cannot also use size variants.')
  const variant = line.selectedVariantId
    ? configuredVariants.find((option) => option.id === line.selectedVariantId)
    : null
  if (line.selectedVariantId && !variant) throw new Error('A selected size or variant is no longer available.')
  const selectedWeightOptionId = line.selectedWeightOptionId || ''
  const weightOption = selectedWeightOptionId
    ? weightOptions.find((option) => option.id === selectedWeightOptionId)
    : null
  if (itemType === 'weight-wise' && !weightOption) throw new Error('Choose a valid weight for this item.')
  if (itemType !== 'weight-wise' && selectedWeightOptionId) throw new Error('This item does not use weight pricing.')
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new Error('Item quantity must be between 1 and 99.')

  const selectedIds = Array.isArray(line.selectedAddOnIds) ? line.selectedAddOnIds : []
  if (selectedIds.length > 10 || new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('Choose up to 10 unique add-ons.')
  }
  const selectedAddOns = selectedIds.map((id) => {
    const option = configuredAddOns.find((entry) => entry.id === id)
    if (!option) throw new Error('A selected add-on is no longer available.')
    return { id: option.id, name: option.name, priceCents: option.price }
  })
  const selectedVariant = variant
    ? { id: variant.id, name: variant.name, priceDeltaCents: variant.price }
    : null
  const unitPriceCents = (weightOption?.priceCents ?? menuItem.priceCents)
    + (selectedVariant?.priceDeltaCents || 0)
    + selectedAddOns.reduce((sum, option) => sum + option.priceCents, 0)
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 100000000) {
    throw new Error('The selected menu options produce an invalid price.')
  }

  return {
    itemId: line.itemId,
    name: menuItem.name,
    categoryId: menuItem.categoryId || null,
    categoryName: typeof menuItem.categoryName === 'string' ? menuItem.categoryName : '',
    unitPriceCents,
    lineTotalCents: unitPriceCents * line.quantity,
    quantity: line.quantity,
    note: typeof line.note === 'string' ? line.note.trim().slice(0, 300) : '',
    selectedWeight: weightOption ? {
      id: weightOption.id,
      value: weightOption.weightValue,
      unit: weightOption.weightUnit,
      label: formatWeightLabel(weightOption),
    } : null,
    selectedVariant,
    selectedAddOns,
  }
}

export function calculateRecipeNeeds(orderLines, menuItems) {
  const needs = new Map()
  const safeOrderLines = Array.isArray(orderLines) ? orderLines : []
  for (const line of safeOrderLines) {
    if (!line || typeof line !== 'object') throw new Error('A menu line is invalid.')
    const menuItem = menuItems && menuItems.get ? menuItems.get(line.itemId) : undefined
    if (!menuItem) throw new Error('A menu recipe is invalid.')
    const recipe = menuItem.recipe || []
    if (!Array.isArray(recipe)) throw new Error('A menu recipe is invalid.')
    if (recipe.length > 30) throw new Error('A menu recipe is invalid.')
    const seen = new Set()
    for (const ingredient of recipe) {
      if (!ingredient || typeof ingredient.ingredientId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(ingredient.ingredientId)) {
        throw new Error('A recipe references an invalid stock item.')
      }
      const quantity = Number(ingredient.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw new Error('Recipe quantities must be positive and within the allowed range.')
      if (seen.has(ingredient.ingredientId)) throw new Error('A recipe cannot contain the same stock item twice.')
      seen.add(ingredient.ingredientId)
      needs.set(ingredient.ingredientId, roundStockQuantity((needs.get(ingredient.ingredientId) || 0) + quantity * line.quantity))
    }
  }
  return needs
}

export function roundStockQuantity(quantity) {
  return Math.round((Number(quantity) + Number.EPSILON) * 1000) / 1000
}

export function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

export function applyPayment(financial, amountCents) {
  if (!financial || typeof financial !== 'object') throw new Error('Order financial details were not found.')
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('Enter a valid payment amount.')
  const paidCents = (financial.paidCents || 0) + amountCents
  if (paidCents > financial.totalCents) throw new Error('Payment is greater than the remaining balance.')
  const paymentStatus = paidCents === financial.totalCents ? 'paid' : 'partially_paid'
  return {
    paidCents,
    paymentStatus,
    customerVisitCounted: paymentStatus === 'paid' && !financial.customerVisitCounted,
  }
}

export function applyRefund(financial, amountCents) {
  if (!financial || typeof financial !== 'object') throw new Error('Order financial details were not found.')
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error('Enter a valid refund amount.')
  const remainingRefundable = Math.max(0, (financial.paidCents || 0) - (financial.refundedCents || 0))
  if (amountCents > remainingRefundable) throw new Error('Refund cannot exceed the amount paid and not already refunded.')
  const refundedCents = (financial.refundedCents || 0) + amountCents
  const fullyRefunded = refundedCents === (financial.paidCents || 0)
  return { refundedCents, fullyRefunded, paymentStatus: fullyRefunded ? 'refunded' : 'partially_refunded' }
}

export function isSettledPaymentStatus(status) {
  return ['paid', 'partially_refunded', 'refunded'].includes(status)
}

export function shouldLoadFinancialForTransition(to, role) {
  return to === 'cancelled' || (to === 'served' && ['owner', 'manager', 'cashier'].includes(role))
}
