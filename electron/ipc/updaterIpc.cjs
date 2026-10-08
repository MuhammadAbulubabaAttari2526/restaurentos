/**
 * updaterIpc.cjs
 *
 * IPC handlers for auto-updater status queries, manual check, and user-initiated install.
 */

const { ipcMain } = require('electron')
const {
  getUpdateStatus,
  checkForUpdatesSilently,
  downloadUpdateNow,
  installUpdateNow,
} = require('../../updater/autoUpdater.cjs')

function registerUpdaterIpc() {
  ipcMain.handle('updater:getStatus', async () => {
    return { success: true, data: getUpdateStatus() }
  })

  ipcMain.handle('updater:check', async () => {
    try {
      await checkForUpdatesSilently()
      return { success: true, data: getUpdateStatus() }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      return await downloadUpdateNow()
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('updater:installNow', async () => {
    try {
      const res = await installUpdateNow()
      return res
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerUpdaterIpc }
