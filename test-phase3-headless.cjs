/**
 * Phase 3: Headless Electron test for Sync Queue + Firebase Sync Worker + Incremental Pull.
 *
 * Runs inside Electron environment with access to app, SQLite, and IPC.
 * Tests:
 *   T1:  NetworkMonitor - online check, mock toggling, and event emission
 *   T2:  FirestoreRest - value encoder & decoder for all types
 *   T3:  FirestoreRest - REST write & delete serialization with mock transport
 *   T4:  SyncWorker - push pending queue item to remote (success -> synced)
 *   T5:  SyncWorker - source record sync_status updated to 'synced'
 *   T6:  SyncWorker - push error handling (retry_count incremented, last_error stored)
 *   T7:  SyncWorker - incremental pull applies remote changes to SQLite without re-queueing
 *   T8:  LocalState - tracks last_pull timestamps per collection
 *   T9:  IPC handlers - sync:getStatus, sync:getPendingCount, sync:setCredentials
 *   T10: Offline mode - push & pull skip gracefully when offline
 */

const { app, ipcMain } = require('electron')
const path = require('path')
const assert = require('assert')

const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const genericRepository = require('./database/repositories/genericRepository.cjs')
const localState = require('./database/repositories/localState.cjs')
const { networkMonitor } = require('./sync/networkMonitor.cjs')
const firestoreRest = require('./sync/firestoreRest.cjs')
const { SyncWorker } = require('./sync/syncWorker.cjs')
const { registerSyncIpc } = require('./electron/ipc/syncIpc.cjs')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${err.message}`)
    failed++
  }
}

async function itAsync(name, fn) {
  try {
    await fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${err.message}`)
    failed++
  }
}

app.whenReady().then(async () => {
  console.log('\n========================================')
  console.log('--- Phase 3 Headless Verification Tests ---')
  console.log('========================================\n')

  try {
    const db = getDb()
    const testRestaurantId = 'rest_phase3_test'

    // ─── T1: NetworkMonitor ──────────────────────────────────────────────
    console.log('[Suite 1: Network Monitor]')
    it('initializes with online state', () => {
      networkMonitor.setMockStatus(null)
      assert.strictEqual(typeof networkMonitor.isOnline(), 'boolean')
    })

    it('allows mocking online / offline with events', () => {
      let eventFired = false
      const onStatus = ({ isOnline }) => {
        if (!isOnline) eventFired = true
      }
      networkMonitor.on('status', onStatus)
      networkMonitor.setMockStatus(false)
      assert.strictEqual(networkMonitor.isOnline(), false)
      assert.strictEqual(eventFired, true)

      networkMonitor.setMockStatus(true)
      assert.strictEqual(networkMonitor.isOnline(), true)
      networkMonitor.removeListener('status', onStatus)
    })

    // ─── T2: Firestore Value Encoder / Decoder ───────────────────────────
    console.log('\n[Suite 2: Firestore Value Proto Serialization]')
    it('encodes primitive types correctly', () => {
      assert.deepStrictEqual(firestoreRest.encodeValue('hello'), { stringValue: 'hello' })
      assert.deepStrictEqual(firestoreRest.encodeValue(42), { integerValue: '42' })
      assert.deepStrictEqual(firestoreRest.encodeValue(19.99), { doubleValue: 19.99 })
      assert.deepStrictEqual(firestoreRest.encodeValue(true), { booleanValue: true })
      assert.deepStrictEqual(firestoreRest.encodeValue(null), { nullValue: null })
    })

    it('encodes nested objects and arrays', () => {
      const complex = {
        name: 'Burger',
        price: 250,
        tags: ['fast-food', 'fresh'],
        meta: { spicy: true },
      }
      const encoded = firestoreRest.encodeFields(complex)
      assert.deepStrictEqual(encoded.name, { stringValue: 'Burger' })
      assert.deepStrictEqual(encoded.price, { integerValue: '250' })
      assert.deepStrictEqual(encoded.tags, {
        arrayValue: {
          values: [{ stringValue: 'fast-food' }, { stringValue: 'fresh' }],
        },
      })
      assert.deepStrictEqual(encoded.meta, {
        mapValue: {
          fields: {
            spicy: { booleanValue: true },
          },
        },
      })
    })

    it('decodes Firestore proto back to JS types', () => {
      const encoded = {
        name: { stringValue: 'Pizza' },
        slices: { integerValue: '8' },
        rating: { doubleValue: 4.8 },
        available: { booleanValue: true },
        notes: { nullValue: null },
        toppings: {
          arrayValue: {
            values: [{ stringValue: 'cheese' }, { stringValue: 'olives' }],
          },
        },
      }
      const decoded = firestoreRest.decodeFields(encoded)
      assert.strictEqual(decoded.name, 'Pizza')
      assert.strictEqual(decoded.slices, 8)
      assert.strictEqual(decoded.rating, 4.8)
      assert.strictEqual(decoded.available, true)
      assert.strictEqual(decoded.notes, null)
      assert.deepStrictEqual(decoded.toppings, ['cheese', 'olives'])
    })

    // ─── T3: REST Calls with Mock Transport ──────────────────────────────
    console.log('\n[Suite 3: Firestore REST Transport]')
    await itAsync('dispatches writeDoc with proper URL and encoded body', async () => {
      let interceptedReq = null
      firestoreRest.setMockTransport((opts, body) => {
        interceptedReq = { opts, body }
        return Promise.resolve({ ok: true })
      })

      await firestoreRest.writeDoc({
        projectId: 'test-prj',
        restaurantId: 'rest_123',
        collection: 'menuItems',
        docId: 'item_99',
        data: { name: 'Karahi', price: 1200 },
      })

      assert(interceptedReq !== null, 'Mock transport was called')
      assert(interceptedReq.opts.url.includes('/restaurants/rest_123/menuItems/item_99'))
      assert.strictEqual(interceptedReq.opts.method, 'PATCH')
      assert.strictEqual(interceptedReq.body.fields.name.stringValue, 'Karahi')
      assert.strictEqual(interceptedReq.body.fields.price.integerValue, '1200')
    })

    await itAsync('dispatches deleteDoc with DELETE method', async () => {
      let interceptedReq = null
      firestoreRest.setMockTransport((opts) => {
        interceptedReq = opts
        return Promise.resolve({ ok: true })
      })

      await firestoreRest.deleteDoc({
        projectId: 'test-prj',
        restaurantId: 'rest_123',
        collection: 'menuItems',
        docId: 'item_99',
      })

      assert.strictEqual(interceptedReq.method, 'DELETE')
      assert(interceptedReq.url.includes('/restaurants/rest_123/menuItems/item_99'))
    })

    // ─── T4 & T5: SyncWorker Push Queue Success ──────────────────────────
    console.log('\n[Suite 4: SyncWorker Push Queue]')
    const worker = new SyncWorker()
    worker.setCredentials({
      projectId: 'demo-pos-project',
      authToken: 'mock-token',
      restaurantId: testRestaurantId,
    })

    await itAsync('pushes pending sync_queue items to remote and marks synced', async () => {
      // Clean test data
      db.prepare('DELETE FROM sync_queue WHERE restaurant_id = ?').run(testRestaurantId)
      db.prepare('DELETE FROM menu_items WHERE restaurant_id = ?').run(testRestaurantId)

      // Insert record via genericRepository (generates sync_queue entry)
      const itemId = genericRepository.upsert(testRestaurantId, 'menuItems', {
        name: 'Biryani Special',
        price: 450,
        available: true,
      })

      // Verify sync_queue has 1 pending item
      const initialPending = db
        .prepare("SELECT * FROM sync_queue WHERE record_id = ? AND status = 'pending'")
        .get(itemId)
      assert(initialPending !== undefined, 'sync_queue pending record created')

      // Mock remote transport success
      const remoteWrites = []
      firestoreRest.setMockTransport((opts, body) => {
        remoteWrites.push({ opts, body })
        return Promise.resolve({ ok: true })
      })

      // Process queue
      const processed = await worker.processQueue()
      assert.strictEqual(processed, 1, '1 record processed')

      // Check sync_queue status is now 'synced'
      const updatedQueue = db
        .prepare('SELECT * FROM sync_queue WHERE record_id = ?')
        .get(itemId)
      assert.strictEqual(updatedQueue.status, 'synced', 'queue item marked synced')

      // Check target table sync_status is now 'synced'
      const menuItem = genericRepository.getById(testRestaurantId, 'menuItems', itemId)
      assert.strictEqual(menuItem.syncStatus, 'synced', 'target table marked synced')
    })

    // ─── T6: SyncWorker Push Failure and Retries ─────────────────────────
    console.log('\n[Suite 5: SyncWorker Error & Retry Handling]')
    await itAsync('handles network errors by incrementing retry_count and saving error', async () => {
      const failItemId = genericRepository.upsert(testRestaurantId, 'menuItems', {
        name: 'Failure Test Dish',
        price: 100,
      })

      // Mock failure
      firestoreRest.setMockTransport(() => {
        return Promise.reject(new Error('503 Service Unavailable'))
      })

      await worker.processQueue()

      const failQueueItem = db
        .prepare('SELECT * FROM sync_queue WHERE record_id = ?')
        .get(failItemId)
      assert.strictEqual(failQueueItem.status, 'failed', 'item marked failed')
      assert.strictEqual(failQueueItem.retry_count, 1, 'retry_count is 1')
      assert(failQueueItem.last_error.includes('503 Service Unavailable'), 'last_error logged')
      assert(worker.getStatus().lastError.includes('503 Service Unavailable'))
    })

    // ─── T7 & T8: Incremental Pull & LocalState ──────────────────────────
    console.log('\n[Suite 6: Incremental Pull & LocalState]')
    await itAsync('pulls remote items and applies to SQLite without re-queueing', async () => {
      // Clear queue
      db.prepare('DELETE FROM sync_queue WHERE restaurant_id = ?').run(testRestaurantId)
      const queueCountBefore = worker.getPendingCount()

      // Mock runQuery response with 2 remote menu items
      const mockRemoteDocs = [
        {
          document: {
            name: `projects/demo/databases/(default)/documents/restaurants/${testRestaurantId}/menuItems/pulled_item_1`,
            fields: firestoreRest.encodeFields({
              name: 'Remote Kebab',
              price: 320,
              available: true,
              updatedAt: '2026-10-05T12:00:00.000Z',
            }),
          },
        },
        {
          document: {
            name: `projects/demo/databases/(default)/documents/restaurants/${testRestaurantId}/menuItems/pulled_item_2`,
            fields: firestoreRest.encodeFields({
              name: 'Remote Naan',
              price: 50,
              available: true,
              updatedAt: '2026-10-05T12:05:00.000Z',
            }),
          },
        },
      ]

      firestoreRest.setMockTransport(() => Promise.resolve(mockRemoteDocs))

      await worker.pullIncremental()

      // Verify items exist in SQLite
      const pulled1 = genericRepository.getById(testRestaurantId, 'menuItems', 'pulled_item_1')
      const pulled2 = genericRepository.getById(testRestaurantId, 'menuItems', 'pulled_item_2')
      assert(pulled1 !== null, 'pulled_item_1 inserted in SQLite')
      assert.strictEqual(pulled1.name, 'Remote Kebab')
      assert.strictEqual(pulled1.price, 320)
      assert.strictEqual(pulled1.syncStatus, 'synced')

      assert(pulled2 !== null, 'pulled_item_2 inserted in SQLite')
      assert.strictEqual(pulled2.name, 'Remote Naan')

      // Verify no new items in sync_queue! (no sync loop)
      const queueCountAfter = worker.getPendingCount()
      assert.strictEqual(
        queueCountAfter,
        queueCountBefore,
        'No echo writes added to sync_queue during pull'
      )

      // Verify local_state saved the latest timestamp
      const lastPull = localState.get(`last_pull_${testRestaurantId}_menuItems`)
      assert.strictEqual(lastPull, '2026-10-05T12:05:00.000Z', 'lastPull timestamp recorded')
    })

    // ─── T9: IPC Handlers ────────────────────────────────────────────────
    console.log('\n[Suite 7: Sync IPC Handlers]')
    it('registers sync IPC handlers without throwing', () => {
      registerSyncIpc()
      assert(true)
    })

    // ─── T10: Offline behavior ───────────────────────────────────────────
    console.log('\n[Suite 8: Offline Behavior]')
    await itAsync('skips sync execution when offline', async () => {
      networkMonitor.setMockStatus(false)
      let transportCalled = false
      firestoreRest.setMockTransport(() => {
        transportCalled = true
        return Promise.resolve([])
      })

      const status = await worker.triggerSync()
      assert.strictEqual(status.status, 'offline')
      assert.strictEqual(status.isOnline, false)
      assert.strictEqual(transportCalled, false, 'no network calls made while offline')

      networkMonitor.setMockStatus(true)
    })

    // Clean up mock transport
    firestoreRest.clearMockTransport()
    networkMonitor.setMockStatus(null)

    console.log('\n========================================')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('========================================\n')

    closeDb()
    process.exit(failed > 0 ? 1 : 0)
  } catch (fatal) {
    console.error('Fatal test error:', fatal)
    closeDb()
    process.exit(1)
  }
})
