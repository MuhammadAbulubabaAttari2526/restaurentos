/**
 * authIpc.cjs
 *
 * IPC handlers for offline authentication:
 * - auth:offlineLogin      — Verify email+password against local scrypt cache
 * - auth:sessionRestore    — Restore last session from cached token on cold start
 * - auth:cacheCredentials  — Called on successful online login to populate/refresh cache
 * - auth:updateToken       — Update only the cached token (no password re-hash needed)
 * - auth:clearSession      — Remove cached data for a user (logout / account removal)
 * - auth:listCachedEmails  — Return emails with cached credentials (for UI suggestions)
 *
 * SECURITY:
 * - This IPC only runs in the Electron main process.
 * - Raw hashes, salts, and full session tokens are NEVER forwarded to the renderer.
 * - offlineLogin returns only the user profile fields needed for the authenticated UI.
 * - sessionRestore returns lastToken ONCE so renderer can submit to Firebase for
 *   background re-verification; subsequent calls do not repeat the token.
 */

const { ipcMain } = require('electron')
const {
  cacheCredentials,
  updateCachedToken,
  offlineLogin,
  getCachedSession,
  listCachedEmails,
  clearCachedUser,
} = require('../../database/repositories/authCache.cjs')

let _registered = false

function registerAuthIpc() {
  if (_registered) return
  _registered = true

  /**
   * auth:offlineLogin
   * Payload: { email: string, password: string }
   * Returns: { ok: boolean, user?: {...}, reason?: string, lockedUntil?: string }
   */
  ipcMain.handle('auth:offlineLogin', async (_, payload) => {
    if (!payload || typeof payload.email !== 'string' || typeof payload.password !== 'string') {
      return { ok: false, reason: 'invalid_request' }
    }
    return offlineLogin(payload.email, payload.password)
  })

  /**
   * auth:sessionRestore
   * Payload: { uid: string }
   * Returns: { ok: boolean, session?: { uid, email, displayName, role, restaurantId, permissions, lastToken } }
   * NOTE: returns lastToken so renderer can attempt online re-verification in the background.
   */
  ipcMain.handle('auth:sessionRestore', async (_, payload) => {
    if (!payload || typeof payload.uid !== 'string') {
      return { ok: false, reason: 'invalid_request' }
    }
    const session = getCachedSession(payload.uid)
    if (!session) return { ok: false, reason: 'no_session' }
    return { ok: true, session }
  })

  /**
   * auth:cacheCredentials
   * Payload: { uid, email, displayName, role, restaurantId, permissions, password, lastToken }
   * Called by renderer after successful online Firebase login.
   * Returns: { ok: boolean }
   */
  ipcMain.handle('auth:cacheCredentials', async (_, payload) => {
    if (!payload || !payload.uid || !payload.email || !payload.restaurantId || !payload.password) {
      return { ok: false, reason: 'missing_fields' }
    }
    try {
      await cacheCredentials({
        uid: payload.uid,
        email: payload.email,
        displayName: payload.displayName || '',
        role: payload.role || 'waiter',
        restaurantId: payload.restaurantId,
        permissions: payload.permissions || [],
        password: payload.password,
        lastToken: payload.lastToken || null,
      })
      return { ok: true }
    } catch (err) {
      console.error('[authIpc] cacheCredentials error:', err.message)
      return { ok: false, reason: err.message }
    }
  })

  /**
   * auth:updateToken
   * Payload: { uid: string, token: string }
   * Called when a token refresh happens so the cached session stays warm.
   * Returns: { ok: boolean }
   */
  ipcMain.handle('auth:updateToken', async (_, payload) => {
    if (!payload || !payload.uid || !payload.token) {
      return { ok: false, reason: 'missing_fields' }
    }
    const ok = updateCachedToken(payload.uid, payload.token)
    return { ok }
  })

  /**
   * auth:clearSession
   * Payload: { uid: string }
   * Returns: { ok: boolean }
   */
  ipcMain.handle('auth:clearSession', async (_, payload) => {
    if (!payload || typeof payload.uid !== 'string') {
      return { ok: false, reason: 'invalid_request' }
    }
    const ok = clearCachedUser(payload.uid)
    return { ok }
  })

  /**
   * auth:listCachedEmails
   * Returns: Array<{ email, displayName, restaurantId }>
   */
  ipcMain.handle('auth:listCachedEmails', async () => {
    return listCachedEmails()
  })
}

module.exports = { registerAuthIpc }
