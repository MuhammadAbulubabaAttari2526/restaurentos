/**
 * syncWorker.cjs
 *
 * Background sync worker for RestaurantOS.
 * - Pushes queued changes (sync_queue) to Firestore REST API.
 * - Pulls incremental updates from Firestore into local SQLite.
 * - Handles exponential backoff and retries without dropping items.
 * - Handles auth expiry (401/403) by setting status 'auth-required' and pausing queue without burning retries.
 * - Resets stuck 'syncing' items on startup.
 * - Routes delete actions for collections with strict rules to soft-deletes.
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

// Collections where firestore.rules disallows hard DELETE (allow delete: if false)
const SOFT_DELETE_COLLECTIONS = new Set([
  'orders',
  'orderFinancials',
  'payments',
  'expenses',
  'stockMovements',
  'purchases',
  'reservations',
  'users',
  'settings',
  'auditLogs',
  'operationKeys',
  'counters',
])

// Backoff delay schedule in seconds based on retry_count (15s, 30s, 1m, 5m, max 15m)
const BACKOFF_SCHEDULE_SECONDS = [15, 30, 60, 300, 900]

function getBackoffMs(retryCount) {
  const count = Math.max(1, retryCount || 1)
  const idx = Math.min(count - 1, BACKOFF_SCHEDULE_SECONDS.length - 1)
  return BACKOFF_SCHEDULE_SECONDS[idx] * 1000
}

function isAuthError(err) {
  if (!err) return false
  const status = err.status || (err.details && err.details.error && err.details.error.code)
  if (status === 401) return true
  const msg = (err.message || '').toLowerCase()
  return (
    status === 403 &&
    (msg.includes('unauthenticated') ||
      msg.includes('auth credential') ||
      msg.includes('token') ||
      msg.includes('jwt') ||
      msg.includes('expired'))
  )
}

function isNetworkOrServerError(err) {
  if (!err) return false
  const status = err.status || 0
  if (status >= 500 && status < 600) return true
  const msg = (err.message || '').toLowerCase()
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  )
}

class SyncWorker extends EventEmitter {
  constructor() {
    super()
    this.projectId = process.env.VITE_FIREBASE_PROJECT_ID || ''
    this.authToken = null
    this.tokenExpiresAt = null
    this.restaurantId = null
    this.pollIntervalMs = 15000

    this._isSyncing = false
    this._authRequired = false
    this._interval = null
    this._window = null
    this.lastSyncTime = null
    this.lastError = null

    // Reset stuck items on initialization
    this.resetStuckItems()

    // Listen to network changes
    networkMonitor.on('status', ({ isOnline }) => {
      this.notifyStatus()
      if (isOnline && !this._authRequired) {
        this.triggerSync().catch(() => {})
      }
    })
  }

  /**
   * Reset any items left in 'syncing' status on startup (e.g. if app crashed or closed mid-sync)
   */
  resetStuckItems() {
    try {
      const db = getDb()
      const nowIso = new Date().toISOString()
      const result = db
        .prepare(`UPDATE sync_queue SET status = 'pending', updated_at = ? WHERE status = 'syncing'`)
        .run(nowIso)
      return result.changes
    } catch {
      return 0
    }
  }

  setCredentials({ projectId, authToken, restaurantId, tokenExpiresAt }) {
    if (projectId) this.projectId = projectId
    if (authToken !== undefined) {
      const hadAuthRequired = this._authRequired
      this.authToken = authToken
      if (authToken) {
        this._authRequired = false
      }
      if (hadAuthRequired && authToken) {
        // Auto-resume sync when new token arrives
        this.triggerSync().catch(() => {})
      }
    }
    if (restaurantId) this.restaurantId = restaurantId
    if (tokenExpiresAt) this.tokenExpiresAt = tokenExpiresAt
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
          .prepare(
            "SELECT COUNT(*) AS cnt FROM sync_queue WHERE restaurant_id = ? AND status IN ('pending', 'failed')"
          )
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

  getAttentionCount() {
    try {
      const db = getDb()
      if (this.restaurantId) {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM sync_queue WHERE restaurant_id = ? AND status = 'failed'"
          )
          .get(this.restaurantId)
        return row ? row.cnt : 0
      }
      const row = db
        .prepare("SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'failed'")
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
    } else if (this._authRequired) {
      status = 'auth-required'
    } else if (this._isSyncing) {
      status = 'syncing'
    } else if (this.lastError) {
      status = 'error'
    }

    return {
      status,
      isOnline,
      pendingCount: this.getPendingCount(),
      attentionCount: this.getAttentionCount(),
      lastSyncTime: this.lastSyncTime,
      lastError: this.lastError,
      restaurantId: this.restaurantId,
      hasCredentials: Boolean(this.projectId && this.restaurantId && this.authToken),
      authRequired: this._authRequired,
    }
  }

  notifyStatus() {
    const status = this.getStatus()
    this.emit('status', status)
    if (this._window && !this._window.isDestroyed()) {
      this._window.webContents.send('sync:status-changed', status)
    }
  }

  /**
   * Process pending or backoff-ready failed items in the queue
   */
  async processQueue(batchSize = 25) {
    if (!networkMonitor.isOnline()) return 0
    if (!this.projectId) return 0
    if (this._authRequired) return 0

    const db = getDb()
    let rawItems
    if (this.restaurantId) {
      rawItems = db
        .prepare(
          `SELECT * FROM sync_queue
           WHERE restaurant_id = ? AND status IN ('pending', 'failed')
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(this.restaurantId, batchSize * 2)
    } else {
      rawItems = db
        .prepare(
          `SELECT * FROM sync_queue
           WHERE status IN ('pending', 'failed')
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(batchSize * 2)
    }

    if (!rawItems || rawItems.length === 0) return 0

    // Filter items based on backoff schedule
    const nowMs = Date.now()
    const eligibleItems = []
    for (const item of rawItems) {
      if (item.status === 'pending') {
        eligibleItems.push(item)
      } else if (item.status === 'failed') {
        const updatedAtMs = new Date(item.updated_at || item.created_at).getTime()
        const backoffMs = getBackoffMs(item.retry_count)
        if (nowMs - updatedAtMs >= backoffMs) {
          eligibleItems.push(item)
        }
      }
      if (eligibleItems.length >= batchSize) break
    }

    if (eligibleItems.length === 0) return 0

    const updateStatusStmt = db.prepare(
      `UPDATE sync_queue SET status = ?, updated_at = ? WHERE id = ?`
    )
    const revertPendingStmt = db.prepare(
      `UPDATE sync_queue SET status = 'pending', updated_at = ? WHERE id = ?`
    )
    const markFailedStmt = db.prepare(
      `UPDATE sync_queue SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`
    )

    let processedCount = 0

    for (const item of eligibleItems) {
      const nowIso = new Date().toISOString()
      updateStatusStmt.run('syncing', nowIso, item.id)

      try {
        const payload = JSON.parse(item.payload_json || '{}')

        if (item.action === 'delete') {
          if (SOFT_DELETE_COLLECTIONS.has(item.collection_name)) {
            // Strict firestore rules disallow hard delete. Dispatch soft-delete payload
            const softDeleteData = {
              ...payload,
              deletedAt: nowIso,
              isDeleted: true,
              updatedAt: nowIso,
            }
            await firestoreRest.writeDoc({
              projectId: this.projectId,
              authToken: this.authToken,
              restaurantId: item.restaurant_id,
              collection: item.collection_name,
              docId: item.record_id,
              data: softDeleteData,
            })
          } else {
            await firestoreRest.deleteDoc({
              projectId: this.projectId,
              authToken: this.authToken,
              restaurantId: item.restaurant_id,
              collection: item.collection_name,
              docId: item.record_id,
            })
          }
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
        const errorMsg = err.message || String(err)
        this.lastError = errorMsg

        if (isAuthError(err)) {
          // Auth expired/invalid: pause queue, set auth-required, DO NOT increment retry_count
          revertPendingStmt.run(new Date().toISOString(), item.id)
          this._authRequired = true
          this.notifyStatus()
          break // Stop processing further items until credentials refresh
        } else if (isNetworkOrServerError(err)) {
          // Transient network / 5xx error: leave as pending, DO NOT increment retry_count
          revertPendingStmt.run(new Date().toISOString(), item.id)
          break // Stop batch on network interruption
        } else {
          // Actual validation/rules/rejection error: mark failed with exponential backoff
          markFailedStmt.run(errorMsg, new Date().toISOString(), item.id)
        }
      }
    }

    return processedCount
  }

  async pullIncremental() {
    if (!networkMonitor.isOnline()) return
    if (!this.projectId || !this.restaurantId || !this.authToken) return
    if (this._authRequired) return

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
        if (isAuthError(err)) {
          this._authRequired = true
          this.notifyStatus()
          break
        }
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
    if (this._authRequired) {
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
      if (isAuthError(err)) {
        this._authRequired = true
      }
    } finally {
      this._isSyncing = false
      this.notifyStatus()
    }

    return this.getStatus()
  }

  start(intervalMs) {
    if (intervalMs) this.pollIntervalMs = intervalMs
    this.resetStuckItems()
    networkMonitor.start()

    if (!this._interval) {
      this._interval = setInterval(() => {
        if (!this._authRequired) {
          this.triggerSync().catch(() => {})
        }
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
  SOFT_DELETE_COLLECTIONS,
  BACKOFF_SCHEDULE_SECONDS,
  getBackoffMs,
  isAuthError,
  isNetworkOrServerError,
}

