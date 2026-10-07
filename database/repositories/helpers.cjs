/**
 * Repository helper utilities.
 * All date values entering SQLite are normalized to ISO strings.
 * All date values leaving SQLite are kept as ISO strings (React components handle display).
 */

function now() {
  return new Date().toISOString()
}

/**
 * Converts a Firestore Timestamp, Date, or ISO string to an ISO string.
 * Falls back to current time if the value is invalid.
 */
function toIso(value) {
  if (!value) return now()
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value.toDate === 'function') return value.toDate().toISOString()
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000).toISOString()
  }
  return now()
}

/**
 * Safely parse a JSON column; returns fallback on failure.
 */
function parseJson(str, fallback = null) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

/**
 * Serialize a value to a JSON string for storage.
 */
function toJson(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * Build a unique ID.
 */
function makeId() {
  return require('crypto').randomUUID()
}

module.exports = { now, toIso, parseJson, toJson, makeId }
