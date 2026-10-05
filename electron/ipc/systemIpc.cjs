const { ipcMain, app } = require('electron')

function registerSystemIpc() {
  ipcMain.handle('system:ping', async () => {
    return 'pong'
  })

  ipcMain.handle('system:getInfo', async () => {
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      userDataPath: app.getPath('userData'),
    }
  })
}

module.exports = { registerSystemIpc }
