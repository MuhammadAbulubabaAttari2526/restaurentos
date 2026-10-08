export function getPosDraftKey(membership, user) {
  if (!membership?.restaurantId || !user?.uid) return ''
  const storageScope = membership.demo ? 'session' : 'local'
  return `restaurantos:pos-draft:${storageScope}:${encodeURIComponent(membership.restaurantId)}:${encodeURIComponent(user.uid)}`
}

function storageFor(key) {
  if (!key || typeof window === 'undefined') return null
  try {
    return key.includes(':session:') ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

export function readPosDraft(key) {
  const storage = storageFor(key)
  if (!storage) return null
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null')
    if (saved?.version !== 1 || !Array.isArray(saved.cart)) return null
    return saved
  } catch {
    return null
  }
}

export function writePosDraft(key, draft) {
  const storage = storageFor(key)
  if (!storage) return
  try {
    const hasWorkInProgress = draft.cart.length > 0
      || Boolean(String(draft.note || '').trim())
      || Boolean(String(draft.discount || '').trim())
      || Boolean(draft.tableId)
      || Boolean(draft.customerId)
      || Boolean(draft.waiterId)
      || Boolean(draft.activeDraftId)
      || draft.orderType !== 'direct-bill'
    if (!hasWorkInProgress) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify({ version: 1, ...draft }))
  } catch {
    // Keep POS usable when the browser blocks local storage or runs out of space.
  }
}
