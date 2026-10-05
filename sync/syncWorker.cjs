/**
 * syncWorker.cjs
 *
 * Background sync worker for RestaurantOS.
 * - Pushes queued changes (sync_queue) to Firestore REST API.
 * - Pulls incremental updates from Firestore into local SQLite.
 * - Handles exponential backoff and retries.
 * - Dispatches sync status changes to the Electron renderer.
 */

const EventEmitter = require('events')
const { getDb } = require('../database/sqliteClient.cjs')
const { getEntry } = require('../database/repositories/collectionRegistry.cjs')
const genericRepository = require('../database/repositories/genericRepository.cjs')
const localState = require('../database/repositories/localState.cjs')
const firestoreRest = require('./firestoreRest.cjs')
const { networkMonitor } = require('./networkMonitor.cjs')

const SYNCABLE_PULL_COLLECTIONS = [
  'menuItems',
  'categories',
  'tables',
  'settings',
  'inventoryItems',
  'suppliers',
  'taxes',
  'discounts',
]

class SyncWorker extends EventEmitter {
  constructor() {
    super()
    this.projectId = process.env.VITE_FIREBASE_PROJECT_ID || ''
    this.authToken = null
    this.restaurantId = null
    this.pollIntervalMs = 15000
    this.maxRetries = 5

    this._isSyncing = false
    this._interval = null
    this._window = null
    this.lastSyncTime = null
    this.lastError = null

    // Listen to network changes
    networkMonitor.on('status', ({ isOnline }) => {
      this.notifyStatus()
      if (isOnline) {
        this.triggerSync().catch(() => {})
      }
    })
  }

  setCredentials({ projectId, authToken, restaurantId }) {
    if (projectId) this.projectId = projectId
    if (authToken !== undefined) this.authToken = authToken
    if (restaurantId) this.restaurantId = restaurantId
    this.notifyStatus()
  }

  registerWindow(win) {
    this._window = win
  }

  getPendingCount() {
    try {
      const db = getDb()
      if (this.restaurantId) {
        const row = db
          .prepare("SELECT COUNT(*) AS cnt FROM sync_queue WHERE restaurant_id = ? AND status IN ('pending', 'failed')")
          .get(this.restaurantId)
        return row ? row.cnt : 0
      }
      const row = db
        .prepare("SELECT COUNT(*) AS cnt FROM sync_queue WHERE status IN ('pending', 'failed')")
        .get()
      return row ? row.cnt : 0
    } catch {
      return 0
    }
  }

  getStatus() {
    const isOnline = networkMonitor.isOnline()
    let status = 'idle'
    if (!isOnline) {
      status = 'offline'
    } else if (this._isSyncing) {
      status = 'syncing'
    } else if (this.lastError) {
      status = 'error'
    }

    return {
      status,
      isOnline,
      pendingCount: this.getPendingCount(),
      lastSyncTime: this.lastSyncTime,
      lastError: this.lastError,
      restaurantId: this.restaurantId,
      hasCredentials: Boolean(this.projectId && this.restaurantId),
    }
  }

  notifyStatus() {
    const status = this.getStatus()
    this.emit('status', status)
    if (this._window && !this._window.isDestroyed()) {
      this._window.webContents.send('sync:status-changed', status)
    }
  }

  async processQueue(batchSize = 25) {
    if (!networkMonitor.isOnline()) return 0
    if (!this.projectId) return 0

    const db = getDb()
    let items
    if (this.restaurantId) {
      items = db
        .prepare(
          `SELECT * FROM sync_queue
           WHERE restaurant_id = ? AND status IN ('pending', 'failed') AND retry_count < ?
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(this.restaurantId, this.maxRetries, batchSize)
    } else {
      items = db
        .prepare(
          `SELECT * FROM sync_queue
           WHERE status IN ('pending', 'failed') AND retry_count < ?
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(this.maxRetries, batchSize)
    }

    if (items.length === 0) return 0

    const updateStatusStmt = db.prepare(
      `UPDATE sync_queue SET status = ?, updated_at = ? WHERE id = ?`
    )
    const markFailedStmt = db.prepare(
      `UPDATE sync_queue SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`
    )

    let processedCount = 0

    for (const item of items) {
      const nowIso = new Date().toISOString()
      updateStatusStmt.run('syncing', nowIso, item.id)

      try {
        const payload = JSON.parse(item.payload_json || '{}')

        if (item.action === 'delete') {
          await firestoreRest.deleteDoc({
            projectId: this.projectId,
            authToken: this.authToken,
            restaurantId: item.restaurant_id,
            collection: item.collection_name,
            docId: item.record_id,
          })
        } else {
          await firestoreRest.writeDoc({
            projectId: this.projectId,
            authToken: this.authToken,
            restaurantId: item.restaurant_id,
            collection: item.collection_name,
            docId: item.record_id,
            data: payload,
          })
        }

        // On success: mark synced
        updateStatusStmt.run('synced', new Date().toISOString(), item.id)

        // Update record in source table
        try {
          const { table } = getEntry(item.collection_name)
          const pkCol = table === 'order_financials' ? 'order_id' : 'id'
          db.prepare(
            `UPDATE ${table} SET sync_status = 'synced' WHERE ${pkCol} = ? AND restaurant_id = ?`
          ).run(item.record_id, item.restaurant_id)
        } catch {
          // Table may not have sync_status or getEntry may throw; safe to continue
        }

        processedCount++
      } catch (err) {
        markFailedStmt.run(err.message || String(err), new Date().toISOString(), item.id)
        this.lastError = err.message || String(err)
      }
    }

    return processedCount
  }

  async pullIncremental() {
    if (!networkMonitor.isOnline()) return
    if (!this.projectId || !this.restaurantId) return

    for (const col of SYNCABLE_PULL_COLLECTIONS) {
      const stateKey = `last_pull_${this.restaurantId}_${col}`
      const lastPullAt = localState.get(stateKey, null)

      try {
        const remoteItems = await firestoreRest.queryUpdatedSince({
          projectId: this.projectId,
          authToken: this.authToken,
          restaurantId: this.restaurantId,
          collection: col,
          sinceIsoString: lastPullAt,
        })

        if (remoteItems && remoteItems.length > 0) {
          genericRepository.bulkUpsertSynced(this.restaurantId, col, remoteItems)

          // Find the latest updatedAt among the pulled items
          let latest = lastPullAt
          for (const item of remoteItems) {
            if (item.updatedAt && (!latest || item.updatedAt > latest)) {
              latest = item.updatedAt
            }
          }
          localState.set(stateKey, latest || new Date().toISOString())
        }
      } catch (err) {
        // Individual collection pull error doesn't block the rest
        this.lastError = `Pull failed for ${col}: ${err.message}`
      }
    }
  }

  async triggerSync() {
    if (this._isSyncing) return this.getStatus()
    if (!networkMonitor.isOnline()) {
      this.notifyStatus()
      return this.getStatus()
    }

    this._isSyncing = true
    this.lastError = null
    this.notifyStatus()

    try {
      await this.processQueue()
      await this.pullIncremental()
      this.lastSyncTime = new Date().toISOString()
    } catch (err) {
      this.lastError = err.message || String(err)
    } finally {
      this._isSyncing = false
      this.notifyStatus()
    }

    return this.getStatus()
  }

  start(intervalMs) {
    if (intervalMs) this.pollIntervalMs = intervalMs
    networkMonitor.start()

    if (!this._interval) {
      this._interval = setInterval(() => {
        this.triggerSync().catch(() => {})
      }, this.pollIntervalMs)
      if (this._interval.unref) {
        this._interval.unref()
      }
    }

    this.notifyStatus()
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    networkMonitor.stop()
  }
}

const syncWorker = new SyncWorker()

module.exports = {
  SyncWorker,
  syncWorker,
}
