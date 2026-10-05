// Headless Electron verification script
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { registerSystemIpc } = require('./electron/ipc/systemIpc.cjs')

async function runVerification() {
  console.log('--- Starting Electron Verification ---')
  registerSystemIpc()

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const indexPath = path.join(__dirname, 'dist/index.html')
  await win.loadFile(indexPath)
  console.log('Loaded dist/index.html successfully.')

  // Test 1: window.posApi existence
  const posApiType = await win.webContents.executeJavaScript('typeof window.posApi')
  console.log(`[TEST 1] window.posApi exists: ${posApiType === 'object' ? 'PASS' : 'FAIL'} (${posApiType})`)
  if (posApiType !== 'object') throw new Error('window.posApi is not exposed')

  // Test 2: posApi.isElectron flag
  const isElectron = await win.webContents.executeJavaScript('window.posApi.isElectron')
  console.log(`[TEST 2] posApi.isElectron === true: ${isElectron === true ? 'PASS' : 'FAIL'}`)
  if (isElectron !== true) throw new Error('isElectron flag is not true')

  // Test 3: IPC ping/pong invocation
  const pong = await win.webContents.executeJavaScript('window.posApi.system.ping()')
  console.log(`[TEST 3] posApi.system.ping() returns "pong": ${pong === 'pong' ? 'PASS' : 'FAIL'}`)
  if (pong !== 'pong') throw new Error(`Unexpected ping response: ${pong}`)

  // Test 4: IPC getInfo invocation
  const info = await win.webContents.executeJavaScript('window.posApi.system.getInfo()')
  console.log(`[TEST 4] posApi.system.getInfo() returns valid system info: ${info && info.electronVersion ? 'PASS' : 'FAIL'}`)
  if (!info || !info.electronVersion) throw new Error('Failed to retrieve system info via IPC')

  // Test 5: Verify Node integration is strictly disabled in renderer
  const processType = await win.webContents.executeJavaScript('typeof process')
  const requireType = await win.webContents.executeJavaScript('typeof require')
  const dirnameType = await win.webContents.executeJavaScript('typeof __dirname')
  const nodeSecPass = processType === 'undefined' && requireType === 'undefined' && dirnameType === 'undefined'
  console.log(`[TEST 5] Renderer Node isolation (process: ${processType}, require: ${requireType}, __dirname: ${dirnameType}): ${nodeSecPass ? 'PASS' : 'FAIL'}`)
  if (!nodeSecPass) throw new Error('Node APIs are leaked to renderer!')

  console.log('--- ALL ELECTRON VERIFICATION TESTS PASSED ---')
  win.close()
  app.quit()
  process.exit(0)
}

app.whenReady().then(runVerification).catch((err) => {
  console.error('Electron verification failed:', err)
  app.quit()
  process.exit(1)
})
