export const ORDER_TRANSITIONS = {
  draft: ['queued', 'cancelled'],
  queued: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: [],
  cancelled: [],
}

export function calculateTotals(items, taxRate = 0, discountCents = 0) {
  const safeItems = Array.isArray(items) ? items : []
  const safeTaxRate = Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0
  const safeDiscountCents = Number.isFinite(Number(discountCents)) ? Number(discountCents) : 0

  const subtotalCents = safeItems.reduce((sum, item) => {
    if (!item || typeof item !== 'object') return sum
    const unitPriceCents = Number(item.unitPriceCents) || 0
    const quantity = Number(item.quantity) || 0
    return sum + unitPriceCents * quantity
  }, 0)

  const discount = Math.min(Math.max(0, safeDiscountCents), subtotalCents)
  const taxableCents = subtotalCents - discount
  const taxCents = Math.round(taxableCents * safeTaxRate)
  return {
    subtotalCents,
    discountCents: discount,
    taxCents,
    totalCents: taxableCents + taxCents,
  }
}

export function canTransitionOrder(from, to) {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false
}

export const DEFAULT_CURRENCY = 'PKR'

export function normalizeCurrency(currency) {
  const normalized = typeof currency === 'string' && currency.trim() ? currency.trim() : DEFAULT_CURRENCY
  const code = normalized.toUpperCase()
  return code === 'USD' ? DEFAULT_CURRENCY : code
}

export function formatMoney(cents, currency = DEFAULT_CURRENCY) {
  const safeCents = Number.isFinite(Number(cents)) ? Number(cents) : 0
  const amount = safeCents / 100
  const code = normalizeCurrency(currency)
  if (code === 'PKR') {
    return `Rs. ${new Intl.NumberFormat('en-PK', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)}`
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
  }).format(amount)
}

export function friendlyError(error) {
  const messages = {
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/network-request-failed': 'Connection problem. Check your internet and try again.',
    'permission-denied': 'You do not have permission to do that.',
    'functions/unauthenticated': 'Your session expired. Sign in again.',
  }
  const code = error && typeof error === 'object' ? error.code : undefined
  const message = error && typeof error === 'object' ? error.message : undefined
  return messages[code] || message || 'Something went wrong. Please try again.'
}
