/**
 * syncIpc.cjs
 *
 * IPC handlers for synchronization between SQLite and Firebase.
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
    const { projectId, authToken, restaurantId, expiresAt } = credentials
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9-]{6,128}$/.test(projectId)) {
      throw new Error('projectId is invalid.')
    }
    if (typeof authToken !== 'string' || authToken.length < 100 || authToken.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(authToken)) {
      throw new Error('authToken is invalid.')
    }
    if (typeof restaurantId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(restaurantId)) {
      throw new Error('restaurantId is invalid.')
    }
    if (typeof expiresAt !== 'string' || expiresAt.length > 64 || !Number.isFinite(Date.parse(expiresAt))) {
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
