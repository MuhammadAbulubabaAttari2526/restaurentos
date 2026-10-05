/**
 * Database IPC handlers.
 *
 * Exposes safe, validated database operations over Electron IPC.
 * The renderer can only access these via window.posApi (contextBridge).
 *
 * Channels:
 *   db:query    (restaurantId, collection, filters, max)  → records[]
 *   db:upsert   (restaurantId, collection, values, id)    → id
 *   db:delete   (restaurantId, collection, id)            → void
 *   db:getById  (restaurantId, collection, id)            → record | null
 */

const { ipcMain } = require('electron')
const { query, upsert, softDelete, getById } = require('../../database/repositories/genericRepository.cjs')
const { REGISTRY } = require('../../database/repositories/collectionRegistry.cjs')

const VALID_COLLECTIONS = Object.keys(REGISTRY)

function validateCollection(name) {
  if (!VALID_COLLECTIONS.includes(name)) {
    throw new Error(`Collection "${name}" is not whitelisted.`)
  }
}

function validateRestaurantId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new Error('restaurantId is invalid.')
  }
}

function registerDbIpc() {
  ipcMain.handle('db:query', async (_event, restaurantId, collection, filters, max) => {
    validateRestaurantId(restaurantId)
    validateCollection(collection)
    const safeMax = Math.min(Math.max(1, Number(max) || 150), 1000)
    const safeFilters = Array.isArray(filters) ? filters : []
    return query(restaurantId, collection, safeFilters, safeMax)
  })

  ipcMain.handle('db:upsert', async (_event, restaurantId, collection, values, id) => {
    validateRestaurantId(restaurantId)
    validateCollection(collection)
    if (typeof values !== 'object' || values === null) throw new Error('values must be an object.')
    const safeId = (id && typeof id === 'string') ? id : null
    return upsert(restaurantId, collection, values, safeId)
  })

  ipcMain.handle('db:delete', async (_event, restaurantId, collection, id) => {
    validateRestaurantId(restaurantId)
    validateCollection(collection)
    if (typeof id !== 'string' || !id) throw new Error('id is required.')
    softDelete(restaurantId, collection, id)
  })

  ipcMain.handle('db:getById', async (_event, restaurantId, collection, id) => {
    validateRestaurantId(restaurantId)
    validateCollection(collection)
    if (typeof id !== 'string' || !id) throw new Error('id is required.')
    return getById(restaurantId, collection, id)
  })
}

module.exports = { registerDbIpc }
