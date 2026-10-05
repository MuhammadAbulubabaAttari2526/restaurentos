/**
 * authCache.cjs
 *
 * Offline login credential cache using Node's built-in crypto.scrypt.
 *
 * Design decisions:
 * - Passwords are NEVER stored in plaintext. Only an scrypt-derived key is stored.
 * - Timing-safe comparison via crypto.timingSafeEqual prevents timing attacks.
 * - After MAX_FAILED_ATTEMPTS consecutive failures, account is locked for LOCKOUT_DURATION_MS.
 * - Cache is populated/refreshed on every successful online Firebase login.
 * - A local session token (last Firebase ID token) is stored for cold-start session restore,
 *   so the app can resume the authenticated UI without requiring re-login immediately.
 *
 * IMPORTANT: This module runs in the Electron main process only. Never expose
 * raw hashes, salts, or session tokens to the renderer window.
 */

const crypto = require('crypto')
const { getDb } = require('../sqliteClient.cjs')

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Derives an scrypt key from a plaintext password and hex-encoded salt.
 * Returns the derived key as a hex string.
 */
function deriveKey(password, saltHex, N, r, p, keylen) {
  return new Promise((resolve, reject) => {
    const salt = Buffer.from(saltHex, 'hex')
    crypto.scrypt(password, salt, keylen, { N, r, p }, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey.toString('hex'))
    })
  })
}

/**
 * Hashes a password with a fresh random salt.
 * Returns { hash: string, salt: string }.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex')
  const hash = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN)
  return { hash, salt }
}

/**
 * Verifies a plaintext password against a stored hash+salt using timing-safe compare.
 * Returns true if the password matches, false otherwise.
 */
async function verifyPassword(password, storedHashHex, saltHex, N, r, p, keylen) {
  try {
    const derived = await deriveKey(password, saltHex, N, r, p, keylen)
    const derivedBuf = Buffer.from(derived, 'hex')
    const storedBuf = Buffer.from(storedHashHex, 'hex')
    if (derivedBuf.length !== storedBuf.length) return false
    return crypto.timingSafeEqual(derivedBuf, storedBuf)
  } catch {
    return false
  }
}

/**
 * Stores (or updates) a user's credentials in the auth_cache table.
 * Call this on every successful online Firebase login so the cache stays fresh.
 *
 * @param {object} opts
 * @param {string} opts.uid - Firebase UID
 * @param {string} opts.email - User email (will be lowercased)
 * @param {string} opts.displayName
 * @param {string} opts.role
 * @param {string} opts.restaurantId
 * @param {string[]} opts.permissions
 * @param {string} opts.password - Plaintext password for hashing (do not persist)
 * @param {string} [opts.lastToken] - Latest Firebase ID token to cache for session restore
 */
async function cacheCredentials({ uid, email, displayName, role, restaurantId, permissions, password, lastToken }) {
  if (!uid || !email || !restaurantId) throw new Error('uid, email, and restaurantId are required')

  const db = getDb()
  const nowIso = new Date().toISOString()
  const lowerEmail = email.toLowerCase()

  // Hash the password
  const { hash, salt } = await hashPassword(password)

  const existing = db.prepare('SELECT uid FROM auth_cache WHERE uid = ?').get(uid)

  if (existing) {
    db.prepare(`
      UPDATE auth_cache SET
        email               = ?,
        display_name        = ?,
        role                = ?,
        restaurant_id       = ?,
        permissions_json    = ?,
        scrypt_hash         = ?,
        scrypt_salt         = ?,
        scrypt_n            = ?,
        scrypt_r            = ?,
        scrypt_p            = ?,
        scrypt_keylen       = ?,
        failed_attempts     = 0,
        locked_until        = NULL,
        last_token          = ?,
        last_token_cached_at = ?,
        updated_at          = ?
      WHERE uid = ?
    `).run(
      lowerEmail,
      displayName || '',
      role,
      restaurantId,
      JSON.stringify(permissions || []),
      hash,
      salt,
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      SCRYPT_KEYLEN,
      lastToken || null,
      lastToken ? nowIso : null,
      nowIso,
      uid
    )
  } else {
    db.prepare(`
      INSERT INTO auth_cache (
        uid, email, display_name, role, restaurant_id, permissions_json,
        scrypt_hash, scrypt_salt, scrypt_n, scrypt_r, scrypt_p, scrypt_keylen,
        failed_attempts, locked_until,
        last_token, last_token_cached_at,
        cached_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
    `).run(
      uid,
      lowerEmail,
      displayName || '',
      role,
      restaurantId,
      JSON.stringify(permissions || []),
      hash,
      salt,
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      SCRYPT_KEYLEN,
      lastToken || null,
      lastToken ? nowIso : null,
      nowIso,
      nowIso
    )
  }

  return true
}

/**
 * Updates only the cached token for a user (no password re-hash needed).
 * Called on every token refresh without re-asking for the password.
 */
function updateCachedToken(uid, token) {
  if (!uid || !token) return false
  const db = getDb()
  const nowIso = new Date().toISOString()
  const result = db.prepare(`
    UPDATE auth_cache SET last_token = ?, last_token_cached_at = ?, updated_at = ?
    WHERE uid = ?
  `).run(token, nowIso, nowIso, uid)
  return result.changes > 0
}

/**
 * Attempts an offline login with email + password.
 *
 * Returns:
 *   { ok: true, user: { uid, email, displayName, role, restaurantId, permissions } }
 * or
 *   { ok: false, reason: 'not_cached' | 'locked' | 'invalid_credentials', lockedUntil?: string }
 *
 * NEVER throws — all errors are returned as structured results.
 */
async function offlineLogin(email, password) {
  if (!email || !password) {
    return { ok: false, reason: 'invalid_credentials' }
  }

  const db = getDb()
  const lowerEmail = email.toLowerCase()
  const row = db.prepare('SELECT * FROM auth_cache WHERE email = ?').get(lowerEmail)

  if (!row || !row.scrypt_hash) {
    // No cached credentials for this user
    return { ok: false, reason: 'not_cached' }
  }

  // Check lockout
  if (row.locked_until) {
    const lockedUntilMs = new Date(row.locked_until).getTime()
    if (Date.now() < lockedUntilMs) {
      return { ok: false, reason: 'locked', lockedUntil: row.locked_until }
    }
    // Lockout expired — reset
    db.prepare("UPDATE auth_cache SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE uid = ?")
      .run(new Date().toISOString(), row.uid)
    row.failed_attempts = 0
    row.locked_until = null
  }

  // Verify password
  const valid = await verifyPassword(
    password,
    row.scrypt_hash,
    row.scrypt_salt,
    row.scrypt_n,
    row.scrypt_r,
    row.scrypt_p,
    row.scrypt_keylen
  )

  if (!valid) {
    const newAttempts = (row.failed_attempts || 0) + 1
    let lockedUntil = null
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
    }
    db.prepare("UPDATE auth_cache SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE uid = ?")
      .run(newAttempts, lockedUntil, new Date().toISOString(), row.uid)

    if (lockedUntil) {
      return { ok: false, reason: 'locked', lockedUntil }
    }
    return { ok: false, reason: 'invalid_credentials', attemptsRemaining: MAX_FAILED_ATTEMPTS - newAttempts }
  }

  // Success — reset failure counter
  db.prepare("UPDATE auth_cache SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE uid = ?")
    .run(new Date().toISOString(), row.uid)

  let permissions = []
  try { permissions = JSON.parse(row.permissions_json || '[]') } catch { permissions = [] }

  return {
    ok: true,
    user: {
      uid: row.uid,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      restaurantId: row.restaurant_id,
      permissions,
      isOfflineSession: true,
    },
  }
}

/**
 * Retrieves the cached token for a user by UID (for session restore on startup).
 * Returns null if not found or expired.
 *
 * NOTE: The cached token may have already expired (Firebase tokens last 1h).
 * The renderer should treat this as a "soft restore" and trigger background re-verification.
 */
function getCachedSession(uid) {
  if (!uid) return null
  const db = getDb()
  const row = db.prepare('SELECT * FROM auth_cache WHERE uid = ?').get(uid)
  if (!row || !row.last_token) return null

  let permissions = []
  try { permissions = JSON.parse(row.permissions_json || '[]') } catch { permissions = [] }

  return {
    uid: row.uid,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    restaurantId: row.restaurant_id,
    permissions,
    lastToken: row.last_token,
    lastTokenCachedAt: row.last_token_cached_at,
  }
}

/**
 * Returns a list of emails with cached credentials (for offline login UI suggestions).
 */
function listCachedEmails() {
  try {
    const db = getDb()
    const rows = db.prepare('SELECT email, display_name, restaurant_id FROM auth_cache ORDER BY updated_at DESC').all()
    return rows.map((r) => ({ email: r.email, displayName: r.display_name, restaurantId: r.restaurant_id }))
  } catch {
    return []
  }
}

/**
 * Clears all cached data for a user (logout / account removal).
 */
function clearCachedUser(uid) {
  if (!uid) return false
  const db = getDb()
  const result = db.prepare('DELETE FROM auth_cache WHERE uid = ?').run(uid)
  return result.changes > 0
}

module.exports = {
  cacheCredentials,
  updateCachedToken,
  offlineLogin,
  getCachedSession,
  listCachedEmails,
  clearCachedUser,
  hashPassword,
  verifyPassword,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
}
