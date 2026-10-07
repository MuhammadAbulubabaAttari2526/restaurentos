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
const firestoreRest = require('./firestoreRest.cjs')
const { networkMonitor } = require('./networkMonitor.cjs')

const SYNCABLE_PULL_COLLECTIONS = [
  'settings', 'categories', 'menuItems', 'tables', 'reservations', 'orders',
  'orderFinancials', 'payments', 'customers', 'waiters', 'inventory',
  'stockMovements', 'suppliers', 'purchases', 'expenses', 'draftOrders',
]
const BACKOFF_MS = [15000, 30000, 60000, 300000, 900000]
const ATTENTION_ERROR = /^REJECTED \d{3}:/
const LOCAL_ONLY_FIELDS = new Set(['id', 'uuid', 'syncStatus', 'version', 'deleted', 'updated_at'])
const FIRESTORE_FIELDS = {
  settings: ['name', 'currency', 'taxRate', 'paymentMethods', 'updatedAt'],
  orders: ['restaurantId', 'orderNumber', 'type', 'tableId', 'tableName', 'covers', 'waiterId', 'waiterName', 'note', 'items', 'status', 'paymentStatus', 'createdBy', 'createdAt', 'updatedAt'],
  orderFinancials: ['restaurantId', 'orderId', 'customerId', 'items', 'subtotalCents', 'discountCents', 'taxCents', 'totalCents', 'paidCents', 'refundedCents', 'customerVisitCounted', 'status', 'paymentStatus', 'createdAt', 'updatedAt', 'lastPaymentId'],
  payments: ['restaurantId', 'orderId', 'amountCents', 'method', 'kind', 'reference', 'recordedBy', 'createdAt', 'updatedAt'],
  reservations: ['restaurantId', 'tableId', 'tableName', 'guestName', 'phone', 'covers', 'startsAt', 'endsAt', 'status', 'createdBy', 'createdAt', 'updatedAt'],
  waiters: ['restaurantId', 'name', 'phone', 'status', 'createdBy', 'createdAt', 'updatedAt'],
  draftOrders: ['restaurantId', 'createdBy', 'status', 'type', 'tableId', 'customerId', 'note', 'items', 'discountCents', 'createdAt', 'updatedAt'],
}

function toFirestoreData(collection, payload, action) {
  const allowedFields = FIRESTORE_FIELDS[collection]
  const data = {}
  for (const [key, value] of Object.entries(payload)) {
    if (LOCAL_ONLY_FIELDS.has(key) || key === 'updatedAt') continue
    if (!allowedFields || allowedFields.includes(key)) data[key] = value
  }
  if (collection === 'orders') {
    if (data.type === 'dine-in') data.covers = Number(data.covers ?? payload.dineInCoverCount ?? 1)
    else delete data.covers
  }
  if (action === 'delete') {
    if (allowedFields && !allowedFields.includes('deletedAt')) {
      const error = new Error(`The Firestore rules for ${collection} do not allow soft-delete fields.`)
      error.status = 400
      throw error
    }
    data.deletedAt = payload.deletedAt || new Date().toISOString()
  }
  return data
}

function isRemoteNewer(localTime, remoteTime) {
  if (!remoteTime) return false
  const local = Date.parse(localTime || '')
  const remote = Date.parse(remoteTime)
  return Number.isFinite(local) && Number.isFinite(remote)
    ? remote >= local
    : String(remoteTime) >= String(localTime || '')
}

class SyncWorker extends EventEmitter {
  constructor(dependencies = {}) {
    super()
    this.getDatabase = dependencies.getDb || getDb
    this.repository = dependencies.repository || genericRepository
    this.firestore = dependencies.firestoreRest || firestoreRest
    this.network = dependencies.networkMonitor || networkMonitor
    this.projectId = process.env.VITE_FIREBASE_PROJECT_ID || ''
    this.authToken = null
    this.tokenExpiresAt = null
    this.restaurantId = null
    this.pollIntervalMs = 30000
    this.authRequired = false

    this._isSyncing = false
    this._syncAgain = false
    this._didRecoverQueue = false
    this._interval = null
    this._debounce = null
    this._window = null
    this.lastSyncTime = null
    this.lastError = null
    this._unsubscribeLocalWrites = this.repository.onLocalWrite(() => {
      clearTimeout(this._debounce)
      this._debounce = setTimeout(() => this.triggerSync().catch(() => {}), 500)
      if (this._debounce.unref) this._debounce.unref()
    })

    // Listen to network changes
    this.network.on('status', ({ isOnline }) => {
      this.notifyStatus()
      if (isOnline) {
        this.triggerSync().catch(() => {})
      }
    })
  }

  setCredentials({ projectId, authToken, restaurantId, expiresAt }) {
    if (projectId) this.projectId = projectId
    if (authToken !== undefined) this.authToken = authToken
    if (expiresAt !== undefined) this.tokenExpiresAt = expiresAt ? Date.parse(expiresAt) : null
    if (restaurantId) this.restaurantId = restaurantId
    if (authToken) {
      this.authRequired = false
      this.lastError = null
      try {
        this.getDatabase().prepare("UPDATE sync_queue SET status = 'pending', last_error = NULL WHERE status = 'pending' AND last_error LIKE 'AUTH_REQUIRED:%'").run()
      } catch {}
      this.triggerSync().catch(() => {})
    }
    this.notifyStatus()
  }

  registerWindow(win) {
    this._window = win
  }

  getPendingCount() {
    try {
      const db = this.getDatabase()
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

  getNeedsAttentionCount() {
    try {
      const db = this.getDatabase()
      const row = this.restaurantId
        ? db.prepare("SELECT COUNT(*) AS cnt FROM sync_queue WHERE restaurant_id = ? AND status = 'failed' AND last_error LIKE 'REJECTED %'").get(this.restaurantId)
        : db.prepare("SELECT COUNT(*) AS cnt FROM sync_queue WHERE status = 'failed' AND last_error LIKE 'REJECTED %'").get()
      return row?.cnt || 0
    } catch {
      return 0
    }
  }

  getLastSyncTime() {
    try {
      return this.getDatabase().prepare('SELECT MAX(last_sync_at) AS last_sync_at FROM sync_meta').get()?.last_sync_at || null
    } catch {
      return null
    }
  }

  getStatus() {
    const isOnline = this.network.isOnline()
    let status = 'idle'
    if (!isOnline) {
      status = 'offline'
    } else if (this.authRequired || (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt)) {
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
      needsAttentionCount: this.getNeedsAttentionCount(),
      lastSyncTime: this.lastSyncTime || this.getLastSyncTime(),
      lastError: this.lastError,
      restaurantId: this.restaurantId,
      hasCredentials: Boolean(this.projectId && this.restaurantId),
      authExpiresAt: this.tokenExpiresAt,
    }
  }

  recoverStuckQueue() {
    const now = new Date().toISOString()
    this.getDatabase().prepare("UPDATE sync_queue SET status = 'pending', updated_at = ? WHERE status = 'syncing'").run(now)
    this._didRecoverQueue = true
  }

  notifyStatus() {
    const status = this.getStatus()
    this.emit('status', status)
    if (this._window && !this._window.isDestroyed()) {
      this._window.webContents.send('sync:status-changed', status)
    }
  }

  async processQueue(batchSize = 500) {
    if (!this.network.isOnline()) return 0
    if (!this.projectId || !this.authToken) return 0
    if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt) {
      this.authRequired = true
      this.notifyStatus()
      return 0
    }

    const db = this.getDatabase()
    batchSize = Math.min(Math.max(1, Number(batchSize) || 500), 500)
    const queued = this.restaurantId
      ? db.prepare("SELECT * FROM sync_queue WHERE restaurant_id = ? AND status IN ('pending','failed') ORDER BY created_at ASC LIMIT ?").all(this.restaurantId, batchSize)
      : db.prepare("SELECT * FROM sync_queue WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT ?").all(batchSize)
    const now = Date.now()
    const items = queued.filter((item) => {
      if (ATTENTION_ERROR.test(item.last_error || '')) return false
      if (!item.last_error) return true
      const delay = BACKOFF_MS[Math.min(item.retry_count || 0, BACKOFF_MS.length - 1)]
      const updatedAt = Date.parse(item.updated_at || item.created_at)
      return !Number.isFinite(updatedAt) || now - updatedAt >= delay
    })
    if (!items.length) return 0

    const timestamp = new Date().toISOString()
    const markSyncing = db.prepare("UPDATE sync_queue SET status = 'syncing', updated_at = ? WHERE id = ?")
    const markSynced = db.prepare("UPDATE sync_queue SET status = 'synced', last_error = NULL, updated_at = ? WHERE id = ?")
    db.transaction(() => items.forEach((item) => markSyncing.run(timestamp, item.id)))()

    try {
      const writes = []
      for (const item of items) {
        const payload = JSON.parse(item.payload_json || '{}')
        const remote = await this.firestore.readDoc({
          projectId: this.projectId,
          authToken: this.authToken,
          restaurantId: item.restaurant_id,
          collection: item.collection_name,
          docId: payload.uuid || item.record_id,
        })
        if (remote && isRemoteNewer(payload.updatedAt || item.created_at, remote.data.updatedAt)) {
          const record = { ...remote.data, id: remote.id }
          this.repository.bulkUpsertSynced(item.restaurant_id, item.collection_name, [record])
          continue
        }

        const data = toFirestoreData(item.collection_name, payload, item.action)
        writes.push(this.firestore.buildUpdateWrite({
          projectId: this.projectId,
          restaurantId: item.restaurant_id,
          collection: item.collection_name,
          docId: payload.uuid || item.record_id,
          data,
          updateTime: remote?.updateTime,
          exists: Boolean(remote),
        }))
      }

      if (writes.length) {
        await this.firestore.commitWrites({
          projectId: this.projectId,
          authToken: this.authToken,
          writes,
        })
      }

      const completedAt = new Date().toISOString()
      const markRecordSynced = (item) => {
        try {
          const { table } = getEntry(item.collection_name)
          const pkCol = table === 'order_financials' ? 'order_id' : 'id'
          const payload = JSON.parse(item.payload_json || '{}')
          db.prepare(`UPDATE ${table} SET sync_status = 'synced', synced = 1 WHERE ${pkCol} = ? AND restaurant_id = ? AND updated_at <= ?`)
            .run(item.record_id, item.restaurant_id, payload.updatedAt || completedAt)
        } catch {}
      }
      db.transaction(() => {
        for (const item of items) markSynced.run(completedAt, item.id)
        for (const item of items) markRecordSynced(item)
      })()
      this.lastError = null
      return items.length
    } catch (error) {
      const code = Number(error.status || 0)
      const unauthenticated = code === 401 || error.details?.error?.status === 'UNAUTHENTICATED'
      const rejected = !unauthenticated && code >= 400 && code < 500 && code !== 408 && code !== 409 && code !== 429
      const failedAt = new Date().toISOString()
      const message = error.message || String(error)
      this.lastError = message
      if (unauthenticated) this.authRequired = true
      const update = unauthenticated
        ? db.prepare("UPDATE sync_queue SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ?")
        : rejected
          ? db.prepare("UPDATE sync_queue SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?")
          : db.prepare("UPDATE sync_queue SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ?")
      const failure = unauthenticated ? `AUTH_REQUIRED: ${message}` : rejected ? `REJECTED ${code}: ${message}` : `TRANSIENT: ${message}`
      db.transaction(() => items.forEach((item) => update.run(failure, failedAt, item.id)))()
      return 0
    }
  }

  async pullIncremental() {
    if (!this.network.isOnline()) return
    if (!this.projectId || !this.restaurantId) return

    for (const col of SYNCABLE_PULL_COLLECTIONS) {
      const db = this.getDatabase()
      const lastPullAt = db.prepare('SELECT last_sync_at FROM sync_meta WHERE collection_name = ?').get(col)?.last_sync_at || null

      try {
        const remoteItems = await this.firestore.queryUpdatedSince({
          projectId: this.projectId,
          authToken: this.authToken,
          restaurantId: this.restaurantId,
          collection: col,
          sinceIsoString: lastPullAt,
        })

        if (remoteItems && remoteItems.length > 0) {
          this.repository.bulkUpsertSynced(this.restaurantId, col, remoteItems)

          // Find the latest updatedAt among the pulled items
          let latest = lastPullAt
          for (const item of remoteItems) {
            if (item.updatedAt && (!latest || item.updatedAt > latest)) {
              latest = item.updatedAt
            }
          }
          db.prepare(`INSERT INTO sync_meta (collection_name, last_sync_at, updated_at)
            VALUES (?, ?, ?) ON CONFLICT(collection_name) DO UPDATE SET
            last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at`)
            .run(col, latest || new Date().toISOString(), new Date().toISOString())
        } else {
          const checkpoint = new Date(Date.now() - 5000).toISOString()
          db.prepare(`INSERT INTO sync_meta (collection_name, last_sync_at, updated_at)
            VALUES (?, ?, ?) ON CONFLICT(collection_name) DO UPDATE SET
            last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at`)
            .run(col, checkpoint, new Date().toISOString())
        }
      } catch (err) {
        if (Number(err.status) === 401 || err.details?.error?.status === 'UNAUTHENTICATED') {
          this.authRequired = true
          this.lastError = err.message || String(err)
          break
        }
        this.lastError = `Pull failed for ${col}: ${err.message}`
      }
    }
  }

  async triggerSync() {
    if (this._isSyncing) {
      this._syncAgain = true
      return this.getStatus()
    }
    if (this.authRequired || (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt)) {
      this.authRequired = true
      this.notifyStatus()
      return this.getStatus()
    }
    if (!await this.network.checkNow()) {
      this.notifyStatus()
      return this.getStatus()
    }

    this._isSyncing = true
    this.lastError = null
    this.notifyStatus()

    try {
      await this.processQueue()
      if (!this.authRequired) await this.pullIncremental()
      this.lastSyncTime = new Date().toISOString()
    } catch (err) {
      this.lastError = err.message || String(err)
    } finally {
      this._isSyncing = false
      this.notifyStatus()
      if (this._syncAgain) {
        this._syncAgain = false
        queueMicrotask(() => this.triggerSync().catch(() => {}))
      }
    }

    return this.getStatus()
  }

  start(intervalMs) {
    if (intervalMs) this.pollIntervalMs = intervalMs
    if (!this._didRecoverQueue) {
      try {
        this.recoverStuckQueue()
      } catch (error) {
        this.lastError = `Could not recover interrupted sync queue: ${error.message}`
      }
    }
    this.network.start()

    if (!this._interval) {
      this._interval = setInterval(() => {
        if (this.getPendingCount() > 0) this.triggerSync().catch(() => {})
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
    if (this._debounce) {
      clearTimeout(this._debounce)
      this._debounce = null
    }
    this.network.stop()
  }
}

const syncWorker = new SyncWorker()

module.exports = {
  SyncWorker,
  syncWorker,
}
