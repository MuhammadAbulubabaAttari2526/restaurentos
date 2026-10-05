const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const { registerSystemIpc } = require('./ipc/systemIpc.cjs')
const { registerDbIpc } = require('./ipc/dbIpc.cjs')
const { registerSyncIpc } = require('./ipc/syncIpc.cjs')
const { registerPosIpc } = require('./ipc/posIpc.cjs')
const { registerPrintIpc } = require('./ipc/printIpc.cjs')
const { registerReportsIpc } = require('./ipc/reportsIpc.cjs')
const { registerBackupIpc } = require('./ipc/backupIpc.cjs')
const { registerUpdaterIpc } = require('./ipc/updaterIpc.cjs')
const { getDb, closeDb } = require('../database/sqliteClient.cjs')
const { createBackupSync, checkMissingDatabase } = require('../backup/backupManager.cjs')
const { initAutoUpdater, stopUpdateTimers } = require('../updater/autoUpdater.cjs')
const { syncWorker } = require('../sync/syncWorker.cjs')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: 'RestaurantOS POS',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,            // false: preload ko Node access chahiye
      spellcheck: false,
      // file:// protocol mein type="module" + crossorigin work karne ke liye
      webSecurity: false,
    },
  })

  syncWorker.registerWindow(mainWindow)

  // Prevent navigation to external or untrusted URLs
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else if (!app.isPackaged && process.env.ELECTRON_START_URL) {
    mainWindow.loadURL(process.env.ELECTRON_START_URL)
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html')
    mainWindow.loadFile(indexPath)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    syncWorker.registerWindow(null)
  })
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // 1. Check for missing database warning before opening
    const missingStatus = checkMissingDatabase()
    if (missingStatus.missing && missingStatus.hasBackups) {
      console.warn('[DB Warning] Primary database missing, but valid backups found in userData/backups!')
    }

    // 2. Initialize SQLite (runs migrations with pre-migration backups)
    const db = getDb()

    // 3. Register IPC handlers
    registerSystemIpc()
    registerDbIpc()
    registerSyncIpc()
    registerPosIpc()
    registerPrintIpc()
    registerReportsIpc()
    registerBackupIpc()
    registerUpdaterIpc()

    // 4. Start background sync worker
    syncWorker.start()

    // 5. Initialize background auto-updater
    initAutoUpdater((updateState) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status-changed', updateState)
      }
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    syncWorker.stop()
    stopUpdateTimers()

    // Take an on_close safety backup before shutdown
    try {
      const db = getDb()
      if (db) {
        console.log('[App Shutdown] Creating automatic on_close backup...')
        createBackupSync(db, 'on_close')
      }
    } catch (err) {
      console.warn('[App Shutdown] On-close backup warning:', err.message)
    }

    closeDb()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
