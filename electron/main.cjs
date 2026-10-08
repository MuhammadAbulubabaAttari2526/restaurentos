const { app, BrowserWindow, dialog, shell } = require('electron')
const fs = require('fs')
const path = require('path')

let mainWindow = null
let databaseInitialized = false
let fatalDialogShown = false
let startupComplete = false

function getMainLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'main.log')
}

function writeMainLog(message, error) {
  const details = error
    ? `\n${error.stack || error.message || String(error)}`
    : ''
  const entry = `[${new Date().toISOString()}] ${message}${details}\n`

  try {
    const logPath = getMainLogPath()
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, entry, 'utf8')
  } catch (logError) {
    console.error('[RestaurantOS] Could not write the startup log:', logError)
    console.error(entry)
  }
}

function handleFatalError(context, error) {
  const reason = error instanceof Error ? error : new Error(String(error))
  writeMainLog(context, reason)
  if (fatalDialogShown) return
  fatalDialogShown = true

  const showDialogAndQuit = () => {
    try {
      dialog.showErrorBox(
        'RestaurantOS could not start',
        `${context}\n\n${reason.message}\n\nMore details were saved to:\n${getMainLogPath()}\n\nTo open DevTools on the next launch, set RESTAURANTOS_OPEN_DEVTOOLS=1 or press Ctrl+Shift+I after the window opens.`,
      )
    } catch (dialogError) {
      writeMainLog('Could not display the startup error dialog.', dialogError)
    }
    app.quit()
  }

  if (app.isReady()) {
    showDialogAndQuit()
  } else {
    app.whenReady().then(showDialogAndQuit, () => process.exit(1))
  }
}

// Register handlers before loading native modules so ABI/load errors are logged too.
process.on('uncaughtException', (error) => {
  handleFatalError('An uncaught main-process exception occurred.', error)
})
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  writeMainLog('An unhandled main-process promise rejection occurred.', error)
  if (!startupComplete) handleFatalError('The app failed while starting.', error)
})

// Respect an explicit Chromium user-data-dir before taking the single-instance
// lock so isolated launches use their own database, logs, and lock file.
const requestedUserDataDir = app.commandLine.getSwitchValue('user-data-dir')
if (requestedUserDataDir) {
  const userDataDir = path.resolve(requestedUserDataDir)
  fs.mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
}

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

function openRendererDevTools(event) {
  if (event.type !== 'keyDown') return false
  if (event.key === 'F12') return true

  const isDevToolsShortcut = event.key?.toLowerCase() === 'i'
    && event.shift
    && (process.platform === 'darwin' ? event.meta && event.alt : event.control)
  return Boolean(isDevToolsShortcut)
}

function createWindow() {
  const appRoot = app.getAppPath()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: 'RestaurantOS POS',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(appRoot, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The renderer uses file:// URLs for its production assets.
      webSecurity: false,
    },
  })

  syncWorker.registerWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (openRendererDevTools(input)) {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
  })

  mainWindow.webContents.on('console-message', (_event, details) => {
    const level = Number(details?.level || 0)
    if (level >= 2) {
      const location = details?.sourceId
        ? ` (${details.sourceId}:${details.lineNumber || 0})`
        : ''
      writeMainLog(`Renderer console warning/error${location}: ${details?.message || 'Unknown renderer message'}`)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    handleFatalError(
      'The RestaurantOS window could not load its interface.',
      new Error(`${errorDescription} (${errorCode}) while loading ${failedUrl}`),
    )
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      handleFatalError('The RestaurantOS renderer process stopped unexpectedly.', new Error(JSON.stringify(details)))
    }
  })

  mainWindow.webContents.once('did-finish-load', () => {
    const windowForCheck = mainWindow
    if (!windowForCheck || windowForCheck.isDestroyed()) return
    writeMainLog(`Renderer document loaded: ${windowForCheck.webContents.getURL()}`)

    const rootMountCheck = `new Promise((resolve) => {
      const startedAt = Date.now()
      const inspectRoot = () => {
        const root = document.getElementById('root')
        if (root && root.childElementCount > 0) {
          resolve({ mounted: true, title: document.title })
        } else if (Date.now() - startedAt >= 15000) {
          resolve({ mounted: false, title: document.title })
        } else {
          setTimeout(inspectRoot, 100)
        }
      }
      inspectRoot()
    })`

    windowForCheck.webContents.executeJavaScript(rootMountCheck)
      .then((result) => {
        if (!result?.mounted) {
          handleFatalError('The window opened, but the React interface did not render.', new Error('The renderer root stayed empty for 15 seconds.'))
          return
        }
        startupComplete = true
        writeMainLog(`Renderer UI mounted successfully: ${result.title}`)
      })
      .catch((error) => handleFatalError('The app could not verify its renderer interface.', error))
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    syncWorker.registerWindow(null)
  })

  const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : ''
  const startUrl = !app.isPackaged ? process.env.ELECTRON_START_URL : ''
  const loadPromise = devUrl
    ? mainWindow.loadURL(devUrl)
    : startUrl
      ? mainWindow.loadURL(startUrl)
      : mainWindow.loadFile(path.join(appRoot, 'dist', 'index.html'))

  loadPromise.catch((error) => handleFatalError('The RestaurantOS window failed to open.', error))

  if (process.env.RESTAURANTOS_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools({ mode: 'detach' })
    })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    writeMainLog(`Starting RestaurantOS ${app.getVersion()} (${process.arch}, N-API ${process.versions.napi || 'unavailable'}, packaged=${app.isPackaged}).`)

    const missingStatus = checkMissingDatabase()
    if (missingStatus.missing && missingStatus.hasBackups) {
      writeMainLog('The primary database is missing, but backups are available in userData/backups.')
    }

    const db = getDb()
    databaseInitialized = true
    const schemaVersion = db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version || 0
    const databasePath = path.join(app.getPath('userData'), 'database', 'restaurantos.db')
    writeMainLog(`SQLite ready at ${databasePath}; migrations applied through version ${schemaVersion}.`)

    registerSystemIpc()
    registerDbIpc()
    registerSyncIpc()
    registerPosIpc()
    registerPrintIpc()
    registerReportsIpc()
    registerBackupIpc()
    registerUpdaterIpc()

    syncWorker.start()
    initAutoUpdater((updateState) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:status-changed', updateState)
      }
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error) => handleFatalError('RestaurantOS startup initialization failed.', error))

  app.on('window-all-closed', () => {
    syncWorker.stop()
    stopUpdateTimers()

    try {
      if (databaseInitialized) {
        createBackupSync(getDb(), 'on_close')
      }
    } catch (error) {
      writeMainLog('The on-close database backup could not be created.', error)
    } finally {
      closeDb()
      databaseInitialized = false
    }

    if (process.platform !== 'darwin') app.quit()
  })
}
