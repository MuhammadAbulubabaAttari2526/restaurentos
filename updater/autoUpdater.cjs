/**
 * autoUpdater.cjs
 *
 * Safe, non-intrusive auto-update subsystem using `electron-updater` with GitHub Releases.
 *
 * Rules:
 *  1. Silent background download; never interrupts active POS sales.
 *  2. Silent fail-over if offline: POS continues running normally with zero error dialogs.
 *  3. Creates a fresh database backup immediately before applying an update.
 *  4. Install happens either on application quit or when cashier explicitly clicks "Restart to update".
 */

const { autoUpdater } = require('electron-updater')
const { app } = require('electron')
const { createBackup } = require('../backup/backupManager.cjs')
const { getDb } = require('../database/sqliteClient.cjs')

let _updateState = {
  status: 'idle', // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version: null,
  progress: 0,
  error: null,
  updateInfo: null,
}

let _statusCallback = null
let _checkInterval = null

/**
 * Configure electron-updater settings.
 */
function initAutoUpdater(onStatusChange) {
  _statusCallback = onStatusChange

  // Logging configuration
  autoUpdater.logger = {
    info: (msg) => console.log('[Updater]', msg),
    warn: (msg) => console.warn('[Updater Warning]', msg),
    error: (msg) => console.error('[Updater Error]', msg),
  }

  // Non-intrusive background download
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  // Event Listeners
  autoUpdater.on('checking-for-update', () => {
    updateState({ status: 'checking', error: null })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update found: v${info.version}`)
    updateState({
      status: 'available',
      version: info.version,
      updateInfo: info,
      error: null,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    updateState({ status: 'not-available', version: info?.version || null, error: null })
  })

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj.percent)
    updateState({ status: 'downloading', progress: percent })
  })

  autoUpdater.on('update-downloaded', async (info) => {
    console.log(`[Updater] Update v${info.version} downloaded successfully.`)
    updateState({
      status: 'downloaded',
      version: info.version,
      progress: 100,
    })

    // Take a pre-update safety backup right when update is ready
    try {
      const db = getDb()
      if (db) {
        console.log('[Updater] Creating pre-update safety backup...')
        await createBackup(db, 'pre_update')
      }
    } catch (err) {
      console.warn('[Updater] Pre-update backup warning:', err.message)
    }
  })

  autoUpdater.on('error', (err) => {
    // If network is offline or release is not reachable, do not crash or throw dialogs
    const isNetworkError = /ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(
      err.message || ''
    )

    if (isNetworkError) {
      console.log('[Updater] Network offline or unreachable. Skipping update check silently.')
      updateState({ status: 'idle', error: 'Network offline' })
    } else {
      console.warn('[Updater Error]', err.message)
      updateState({ status: 'error', error: err.message })
    }
  })

  // Start periodic check: delay initial check by 10s, then check every 4 hours
  setTimeout(() => {
    checkForUpdatesSilently()
  }, 10000)

  _checkInterval = setInterval(() => {
    checkForUpdatesSilently()
  }, 4 * 60 * 60 * 1000)
}

function updateState(partial) {
  _updateState = { ..._updateState, ...partial }
  if (typeof _statusCallback === 'function') {
    try {
      _statusCallback(_updateState)
    } catch {}
  }
}

/**
 * Checks for updates silently without throwing unhandled exceptions.
 */
async function checkForUpdatesSilently() {
  try {
    updateState({ status: 'checking', error: null })
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      updateState({ status: 'idle' })
    }
  } catch (err) {
    console.log('[Updater] Check update skipped:', err.message)
    updateState({ status: 'idle', error: err.message })
  }
}

/**
 * Cashier or administrator explicitly requests to restart and install downloaded update.
 */
async function installUpdateNow() {
  if (_updateState.status !== 'downloaded') {
    return { success: false, error: 'No downloaded update is ready to install.' }
  }

  try {
    const db = getDb()
    if (db) {
      console.log('[Updater] Creating final pre-install backup before restart...')
      await createBackup(db, 'pre_update')
    }
  } catch (err) {
    console.warn('[Updater] Pre-install backup warning:', err.message)
  }

  // Quit and install immediately
  autoUpdater.quitAndInstall(false, true)
  return { success: true }
}

function getUpdateStatus() {
  return { ..._updateState }
}

function stopUpdateTimers() {
  if (_checkInterval) {
    clearInterval(_checkInterval)
    _checkInterval = null
  }
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesSilently,
  installUpdateNow,
  getUpdateStatus,
  stopUpdateTimers,
}
