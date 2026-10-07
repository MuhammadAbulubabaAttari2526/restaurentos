/**
 * Safe desktop updates through electron-updater and GitHub Releases.
 * Checks are automatic, downloads need a user click, and installation is
 * always explicit so a POS operation is never interrupted by an update.
 */

const { autoUpdater } = require('electron-updater')
const { app } = require('electron')
const { createBackup } = require('../backup/backupManager.cjs')
const { getDb } = require('../database/sqliteClient.cjs')
const { syncWorker } = require('../sync/syncWorker.cjs')
const { beginUpdateInstall, cancelUpdateInstall, hasActiveOperations } = require('../electron/activityMonitor.cjs')

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const INITIAL_UPDATE_CHECK_DELAY_MS = 10 * 1000

let _updateState = {
  status: 'idle',
  version: null,
  progress: 0,
  error: null,
  updateInfo: null,
}

let _statusCallback = null
let _checkInterval = null
let _initialCheckTimeout = null
let _initialized = false
let _checkInProgress = false
let _downloadRequested = false

function getUpdateStatus() {
  return { ..._updateState, currentVersion: app.getVersion() }
}

function updateState(partial) {
  _updateState = { ..._updateState, ...partial }
  if (typeof _statusCallback === 'function') {
    try {
      _statusCallback(getUpdateStatus())
    } catch {}
  }
}

/** Configure automatic checks for packaged desktop builds only. */
function initAutoUpdater(onStatusChange) {
  _statusCallback = onStatusChange
  if (!app.isPackaged || _initialized) return
  _initialized = true

  autoUpdater.logger = {
    info: (message) => console.log('[Updater]', message),
    warn: (message) => console.warn('[Updater Warning]', message),
    error: (message) => console.warn('[Updater Error]', message),
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    updateState({ status: 'checking', error: null })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update found: v${info.version}`)
    updateState({ status: 'available', version: info.version, updateInfo: info, progress: 0, error: null })
  })

  autoUpdater.on('update-not-available', (info) => {
    updateState({ status: 'not-available', version: info?.version || null, progress: 0, error: null })
  })

  autoUpdater.on('download-progress', (progress) => {
    updateState({ status: 'downloading', progress: Math.max(0, Math.min(100, Math.round(progress.percent))) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    _downloadRequested = false
    console.log(`[Updater] Update v${info.version} downloaded successfully.`)
    updateState({ status: 'downloaded', version: info.version, progress: 100, error: null })
  })

  autoUpdater.on('error', (error) => {
    const message = error?.message || String(error)
    const downloadFailed = _downloadRequested || _updateState.status === 'downloading'
    _downloadRequested = false
    // An unavailable network or release feed should never interrupt POS use.
    console.warn('[Updater] Update request failed silently:', message)
    updateState({
      status: downloadFailed && _updateState.version ? 'available' : 'idle',
      progress: downloadFailed ? 0 : _updateState.progress,
      error: null,
    })
  })

  _initialCheckTimeout = setTimeout(() => {
    checkForUpdatesSilently()
  }, INITIAL_UPDATE_CHECK_DELAY_MS)
  _initialCheckTimeout.unref?.()

  _checkInterval = setInterval(() => {
    checkForUpdatesSilently()
  }, UPDATE_CHECK_INTERVAL_MS)
  _checkInterval.unref?.()
}

/** Checks for updates quietly; it never downloads or installs one. */
async function checkForUpdatesSilently() {
  if (!app.isPackaged || _checkInProgress) return { success: true, data: getUpdateStatus() }
  if (['available', 'downloading', 'downloaded'].includes(_updateState.status)) {
    return { success: true, data: getUpdateStatus() }
  }

  _checkInProgress = true
  updateState({ status: 'checking', error: null })
  try {
    await autoUpdater.checkForUpdates()
    return { success: true, data: getUpdateStatus() }
  } catch (error) {
    console.warn('[Updater] Check skipped; RestaurantOS will keep working:', error?.message || error)
    updateState({ status: 'idle', error: null })
    return { success: false, error: error?.message || 'Update check failed.' }
  } finally {
    _checkInProgress = false
  }
}

/** Starts a download only after the user chooses Update Now. */
async function downloadUpdateNow() {
  if (!app.isPackaged) return { success: false, error: 'Updates are available in the installed desktop app.' }
  if (_updateState.status === 'downloading') return { success: true }
  if (_updateState.status !== 'available') return { success: false, error: 'No update is ready to download.' }

  _downloadRequested = true
  updateState({ status: 'downloading', progress: 0, error: null })
  try {
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (error) {
    _downloadRequested = false
    console.warn('[Updater] Download failed; it can be retried later:', error?.message || error)
    updateState({ status: 'available', progress: 0, error: null })
    return { success: false, error: 'The update download failed. Check your connection and try again.' }
  }
}

function countOpenOrders(db) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM orders
    WHERE status IN ('queued', 'preparing', 'ready')
      OR (status = 'served' AND payment_status IN ('unpaid', 'partially_paid'))
  `).get()?.count || 0
}

function verifyDatabase(db) {
  const result = db.prepare('PRAGMA quick_check').all()
  return result.length === 1 && result[0].quick_check === 'ok'
}

function countDurableQueuedChanges(db) {
  const restaurantId = syncWorker.restaurantId
  const result = restaurantId
    ? db.prepare("SELECT COUNT(*) AS count FROM sync_queue WHERE restaurant_id = ? AND status IN ('pending', 'failed', 'syncing')").get(restaurantId)
    : db.prepare("SELECT COUNT(*) AS count FROM sync_queue WHERE status IN ('pending', 'failed', 'syncing')").get()
  return result?.count || 0
}

/** Installs only from an explicit button, with order and SQLite safety checks. */
async function installUpdateNow() {
  if (_updateState.status !== 'downloaded') {
    return { success: false, error: 'No downloaded update is ready to install.' }
  }
  if (hasActiveOperations()) {
    return { success: false, error: 'Finish the active order, payment, or print before restarting.' }
  }

  const db = getDb()
  if (countOpenOrders(db) > 0) {
    return { success: false, error: 'Finish active orders and payments before restarting to install the update.' }
  }

  // Try to sync first. If the connection is offline or Firebase rejects a row,
  // the durable queue and all POS records remain in SQLite and are backed up.
  try {
    await syncWorker.triggerSync()
  } catch (error) {
    console.warn('[Updater] Sync before install did not finish; local SQLite data will be preserved:', error?.message || error)
  }

  const pendingCount = countDurableQueuedChanges(db)
  if (pendingCount > 0) {
    console.log(`[Updater] ${pendingCount} change(s) remain queued in SQLite; continuing only after a verified backup.`)
  }

  if (!verifyDatabase(db)) {
    return { success: false, error: 'The local database needs attention. The update was not installed.' }
  }

  try {
    await createBackup(db, 'pre_update')
  } catch (error) {
    console.warn('[Updater] Safety backup failed:', error?.message || error)
    return { success: false, error: 'A safety backup could not be created. The update was not installed.' }
  }

  // Recheck after sync and backup; then reserve the app synchronously so no
  // new order, payment, or print operation can start before the restart.
  if (hasActiveOperations()) {
    return { success: false, error: 'Finish the active order, payment, or print before restarting.' }
  }
  if (countOpenOrders(db) > 0) {
    return { success: false, error: 'Finish active orders and payments before restarting to install the update.' }
  }
  if (!beginUpdateInstall()) {
    return { success: false, error: 'Finish the active order, payment, or print before restarting.' }
  }

  try {
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  } catch (error) {
    cancelUpdateInstall()
    console.warn('[Updater] Could not start the installer:', error?.message || error)
    return { success: false, error: 'The installer could not be started. Please try again.' }
  }
}

function stopUpdateTimers() {
  if (_checkInterval) clearInterval(_checkInterval)
  if (_initialCheckTimeout) clearTimeout(_initialCheckTimeout)
  _checkInterval = null
  _initialCheckTimeout = null
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesSilently,
  downloadUpdateNow,
  installUpdateNow,
  getUpdateStatus,
  stopUpdateTimers,
}
