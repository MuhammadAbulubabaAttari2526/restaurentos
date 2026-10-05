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

  ipcMain.handle('sync:setCredentials', async (_, credentials) => {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Invalid credentials payload')
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
