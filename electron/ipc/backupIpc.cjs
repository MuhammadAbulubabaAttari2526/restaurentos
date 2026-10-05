/**
 * backupIpc.cjs
 *
 * IPC handlers for SQLite backup creation, listing, restoration, and missing database checks.
 */

const { ipcMain } = require('electron')
const backupManager = require('../../backup/backupManager.cjs')
const { getDb, closeDb } = require('../../database/sqliteClient.cjs')

function registerBackupIpc() {
  ipcMain.handle('backup:create', async (_event, reason = 'manual') => {
    try {
      const db = getDb()
      const result = await backupManager.createBackup(db, reason)
      return { success: true, data: result }
    } catch (err) {
      console.error('[backup:create error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('backup:list', async () => {
    try {
      const list = backupManager.listBackups()
      return { success: true, data: list }
    } catch (err) {
      console.error('[backup:list error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('backup:restore', async (_event, filenameOrPath) => {
    try {
      const result = await backupManager.restoreBackup(filenameOrPath, getDb, closeDb)
      return { success: true, data: result }
    } catch (err) {
      console.error('[backup:restore error]', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('backup:checkMissing', async () => {
    try {
      const status = backupManager.checkMissingDatabase()
      return { success: true, data: status }
    } catch (err) {
      console.error('[backup:checkMissing error]', err)
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerBackupIpc }
