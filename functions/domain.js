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

export function priceMenuLine(menuItem, line) {
  if (!menuItem || typeof menuItem !== 'object') {
    throw new Error('A menu item is invalid. Ask a manager to review the menu.')
  }
  if (!line || typeof line !== 'object') {
    throw new Error('This menu line is invalid.')
  }
  if (!Number.isSafeInteger(menuItem.priceCents) || menuItem.priceCents < 0) {
    throw new Error('A menu price is invalid. Ask a manager to review the menu.')
  }
  const variants = Array.isArray(menuItem.variants) ? menuItem.variants : []
  const addOns = Array.isArray(menuItem.addOns) ? menuItem.addOns : []
  if (variants.length > 20 || addOns.length > 20) {
    throw new Error('This menu item has invalid option settings.')
  }

  const configuredVariants = variants.map((option) => validOption(option, 'priceDeltaCents', true))
  const configuredAddOns = addOns.map((option) => validOption(option, 'priceCents'))
  const variant = line.selectedVariantId
    ? configuredVariants.find((option) => option.id === line.selectedVariantId)
    : null
  if (line.selectedVariantId && !variant) throw new Error('A selected size or variant is no longer available.')

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
  const unitPriceCents = menuItem.priceCents
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
    quantity: line.quantity,
    note: typeof line.note === 'string' ? line.note.trim().slice(0, 300) : '',
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
      needs.set(ingredient.ingredientId, (needs.get(ingredient.ingredientId) || 0) + quantity * line.quantity)
    }
  }
  return needs
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
  return to === 'cancelled' || (to === 'served' && ['owner', 'manager', 'cashier', 'waiter'].includes(role))
}
