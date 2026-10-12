/**
 * syncIpc.cjs
 *
 * IPC handlers for synchronization between SQLite and the RestaurantOS API.
 * Exposes channels to check sync status, trigger sync, and supply credentials.
 */

const { ipcMain } = require('electron')
const { syncWorker } = require('../../sync/syncWorker.cjs')
const { networkMonitor } = require('../../sync/networkMonitor.cjs')

let _registered = false

function registerSyncIpc() {
  if (_registered) return
  _registered = true

  ipcMain.handle('sync:getStatus', async () => {
    return syncWorker.getStatus()
  })

  ipcMain.handle('sync:trigger', async () => {
    return syncWorker.triggerSync()
  })

  ipcMain.handle('sync:checkNetwork', async () => {
    await networkMonitor.checkNow()
    return syncWorker.getStatus()
  })

  ipcMain.handle('sync:setCredentials', async (_, credentials) => {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new Error('Invalid credentials payload')
    }
    const { apiBaseUrl, authToken, restaurantId, expiresAt } = credentials
    if (apiBaseUrl !== undefined) {
      let parsedUrl
      try { parsedUrl = new URL(apiBaseUrl) } catch { throw new Error('apiBaseUrl is invalid.') }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('apiBaseUrl must use HTTP or HTTPS.')
    }
    if (authToken !== null && (typeof authToken !== 'string' || authToken.length < 32 || authToken.length > 256 || !/^[A-Za-z0-9_-]+$/.test(authToken))) {
      throw new Error('authToken is invalid.')
    }
    if (restaurantId !== undefined && (typeof restaurantId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(restaurantId))) {
      throw new Error('restaurantId is invalid.')
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || expiresAt.length > 64 || !Number.isFinite(Date.parse(expiresAt)))) {
      throw new Error('expiresAt is invalid.')
    }
    syncWorker.setCredentials(credentials)
    return syncWorker.getStatus()
  })

  ipcMain.handle('sync:getPendingCount', async () => {
    return syncWorker.getPendingCount()
  })

  ipcMain.handle('sync:setMockOnline', async (_, isOnline) => {
    networkMonitor.setMockStatus(isOnline)
    return syncWorker.getStatus()
  })
}

module.exports = { registerSyncIpc }
