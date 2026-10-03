const stableIds = new Map()

function makeId(prefix) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

export function createStableIntentId(prefix = 'intent') {
  const safePrefix = String(prefix || 'intent').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'intent'
  if (!stableIds.has(safePrefix)) {
    stableIds.set(safePrefix, makeId(safePrefix))
  }
  return stableIds.get(safePrefix)
}

export function resetStableIntentId(prefix = 'intent') {
  const safePrefix = String(prefix || 'intent').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'intent'
  stableIds.delete(safePrefix)
}
