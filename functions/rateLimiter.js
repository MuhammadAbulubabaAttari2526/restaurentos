import { getMongoDatabase } from './mongoFirestoreCompat.js'

// In-memory fallback and fast cache for rate limiting
const memoryLimits = new Map()

// Periodic cleanup of expired in-memory entries (every 5 minutes)
if (typeof setInterval !== 'undefined') {
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, record] of memoryLimits.entries()) {
      if (record.resetAt <= now) {
        memoryLimits.delete(key)
      }
    }
  }, 5 * 60 * 1000)
  if (cleanupTimer?.unref) cleanupTimer.unref()
}

export function getClientIp(request) {
  if (!request) return '127.0.0.1'
  const forwarded = request.headers?.['x-forwarded-for']
  if (forwarded) {
    const ips = String(forwarded).split(',')
    const first = ips[0]?.trim()
    if (first && !first.includes('unknown')) return first
  }
  const realIp = request.headers?.['x-real-ip']
  if (realIp) return String(realIp).trim()
  return request.socket?.remoteAddress || request.connection?.remoteAddress || '127.0.0.1'
}

export async function checkRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now()
  let record = memoryLimits.get(key)

  // Try MongoDB if available
  try {
    const database = await getMongoDatabase()
    const rateLimits = database.collection('authRateLimits')
    const doc = await rateLimits.findOne({ _id: key })
    if (doc) {
      const resetTime = doc.resetAt instanceof Date ? doc.resetAt.getTime() : Number(doc.resetAt)
      if (resetTime > now) {
        record = { count: doc.count, resetAt: resetTime }
      }
    }
  } catch {
    // Fall back cleanly to memory
  }

  if (record && record.resetAt > now) {
    if (record.count >= maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000))
      const error = new Error(`Too many requests. Please wait ${retryAfterSeconds} seconds before trying again.`)
      error.code = 'resource-exhausted'
      error.retryAfter = retryAfterSeconds
      throw error
    }
    return { allowed: true, remaining: maxAttempts - record.count, resetAt: new Date(record.resetAt) }
  }

  return { allowed: true, remaining: maxAttempts, resetAt: new Date(now + windowMs) }
}

export async function recordAttempt(key, windowMs) {
  const now = Date.now()
  let current = memoryLimits.get(key)
  let count = 1
  let resetAt = now + windowMs

  if (current && current.resetAt > now) {
    count = current.count + 1
    resetAt = current.resetAt
  }

  memoryLimits.set(key, { count, resetAt })

  try {
    const database = await getMongoDatabase()
    const rateLimits = database.collection('authRateLimits')
    await rateLimits.updateOne(
      { _id: key },
      {
        $inc: { count: 1 },
        $setOnInsert: { resetAt: new Date(resetAt) },
      },
      { upsert: true }
    )
  } catch {
    // Memory limit recorded
  }

  return { count, resetAt: new Date(resetAt) }
}

export async function resetRateLimit(key) {
  memoryLimits.delete(key)
  try {
    const database = await getMongoDatabase()
    const rateLimits = database.collection('authRateLimits')
    await rateLimits.deleteOne({ _id: key })
  } catch {
    // Memory limit deleted
  }
}

export function clearAllMemoryRateLimits() {
  memoryLimits.clear()
}
