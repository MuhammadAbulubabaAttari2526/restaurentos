/**
 * posIpc.cjs
 *
 * Exposes POS operations (createOrder, recordPayment, etc.) over IPC.
 */

const { ipcMain } = require('electron')
const { runLocalOperation } = require('../../database/repositories/localOperations.cjs')

let _registered = false

function registerPosIpc() {
  if (_registered) return
  _registered = true

  ipcMain.handle('pos:runOperation', async (_, restaurantId, name, payload) => {
    if (!restaurantId || typeof restaurantId !== 'string') {
      throw new Error('restaurantId must be a non-empty string')
    }
    if (!name || typeof name !== 'string') {
      throw new Error('operation name must be a non-empty string')
    }
    return runLocalOperation(restaurantId, name, payload)
  })
}

module.exports = { registerPosIpc }
