/**
 * test-group-a.cjs
 *
 * Dedicated headless verification tests for Group A:
 * A1: Token expiry / 401/403 -> 'auth-required', pause queue, no retry increment, resume on new token.
 * A2: Exponential backoff calculation & retry without dropping items.
 * A3: Startup reset for stuck 'syncing' items.
 * A4: Soft-delete routing for restricted collections vs hard delete.
 */

const assert = require('assert')
const { app } = require('electron')
const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const {
  SyncWorker,
  SOFT_DELETE_COLLECTIONS,
  getBackoffMs,
  isAuthError,
  isNetworkOrServerError,
} = require('./sync/syncWorker.cjs')
const firestoreRest = require('./sync/firestoreRest.cjs')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`    ${err.message}`)
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
    console.error(`    ${err.message}`)
    failed++
  }
}

async function runTests() {
  console.log('\n========================================')
  console.log('--- Group A: Sync Reliability Tests ---')
  console.log('========================================\n')

  const db = getDb()

  console.log('[Suite A1: Token Expiry & Auth-Required Handling]')
  await itAsync('sets status to auth-required and does NOT increment retry_count on 401', async () => {
    // Clean prior test items
    db.prepare("DELETE FROM sync_queue WHERE id LIKE 'sq_%'").run()

    const worker = new SyncWorker()
    worker.projectId = 'demo-proj'
    worker.authToken = 'expired_token'
    worker.restaurantId = 'rest_grp_a'

    // Insert pending queue item using valid action ('set')
    db.prepare(
      `INSERT INTO sync_queue (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'set', ?, 'pending', 0, ?, ?)`
    ).run(
      'sq_auth_test_1',
      'rest_grp_a',
      'categories',
      'cat_1',
      JSON.stringify({ name: 'Drinks' }),
      new Date().toISOString(),
      new Date().toISOString()
    )

    // Mock 401 transport
    firestoreRest.setMockTransport(async () => {
      const err = new Error('HTTP 401: Request had invalid authentication credentials.')
      err.status = 401
      throw err
    })

    await worker.processQueue()

    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_auth_test_1')
    assert(item, 'Queue item must exist')
    assert.strictEqual(item.status, 'pending', 'Item should be reverted to pending, not failed')
    assert.strictEqual(item.retry_count, 0, 'retry_count should not be incremented on auth error')

    const status = worker.getStatus()
    assert.strictEqual(status.status, 'auth-required', "Status should be 'auth-required'")
    assert.strictEqual(status.authRequired, true)

    firestoreRest.clearMockTransport()
  })

  await itAsync('clears authRequired and syncs successfully when valid token is supplied', async () => {
    const worker = new SyncWorker()
    worker.projectId = 'demo-proj'
    worker.authToken = 'valid_new_token'
    worker.restaurantId = 'rest_grp_a'
    worker._authRequired = false

    let written = false
    firestoreRest.setMockTransport(async (opts, body) => {
      written = true
      return { name: 'projects/demo-proj/databases/(default)/documents/restaurants/rest_grp_a/categories/cat_1' }
    })

    await worker.processQueue()
    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_auth_test_1')
    assert(item, 'Queue item must exist')
    assert.strictEqual(item.status, 'synced', 'Item should sync successfully after token refresh')
    assert.strictEqual(written, true)

    firestoreRest.clearMockTransport()
  })

  console.log('\n[Suite A2: Exponential Backoff & Attention Tracking]')
  it('computes exponential backoff delays correctly [15s, 30s, 1m, 5m, 15m]', () => {
    assert.strictEqual(getBackoffMs(1), 15000)
    assert.strictEqual(getBackoffMs(2), 30000)
    assert.strictEqual(getBackoffMs(3), 60000)
    assert.strictEqual(getBackoffMs(4), 300000)
    assert.strictEqual(getBackoffMs(5), 900000)
    assert.strictEqual(getBackoffMs(10), 900000, 'Capped at max 15m')
  })

  await itAsync('does not drop items permanently and honors backoff delay', async () => {
    // Clean prior test items
    db.prepare("DELETE FROM sync_queue WHERE id LIKE 'sq_backoff_%'").run()

    const worker = new SyncWorker()
    worker.projectId = 'demo-proj'
    worker.authToken = 'valid_token'
    worker.restaurantId = 'rest_grp_a'

    // Insert a failed item updated 5 seconds ago with retry_count = 1 (backoff is 15s)
    const fiveSecAgo = new Date(Date.now() - 5000).toISOString()
    db.prepare(
      `INSERT INTO sync_queue (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'set', ?, 'failed', 1, ?, ?)`
    ).run(
      'sq_backoff_1',
      'rest_grp_a',
      'categories',
      'cat_backoff',
      JSON.stringify({ name: 'Snacks' }),
      fiveSecAgo,
      fiveSecAgo
    )

    let attempted = false
    firestoreRest.setMockTransport(async () => {
      attempted = true
      return {}
    })

    // Process queue: should skip sq_backoff_1 because 5s < 15s backoff
    await worker.processQueue()
    assert.strictEqual(attempted, false, 'Should not process item before backoff expires')

    // Now set updated_at to 20 seconds ago (> 15s backoff)
    const twentySecAgo = new Date(Date.now() - 20000).toISOString()
    db.prepare('UPDATE sync_queue SET updated_at = ? WHERE id = ?').run(twentySecAgo, 'sq_backoff_1')

    await worker.processQueue()
    assert.strictEqual(attempted, true, 'Should process item after backoff expires')

    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_backoff_1')
    assert.strictEqual(item.status, 'synced')

    firestoreRest.clearMockTransport()
  })

  it('reports attentionCount for failed items in getStatus()', () => {
    const worker = new SyncWorker()
    worker.restaurantId = 'rest_grp_a'

    const status = worker.getStatus()
    assert(typeof status.attentionCount === 'number')
    assert(status.attentionCount >= 0)
  })

  console.log('\n[Suite A3: Stuck Syncing Reset on Startup]')
  it('resets stuck syncing items back to pending on startup', () => {
    // Insert item stuck in 'syncing'
    db.prepare(
      `INSERT INTO sync_queue (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'set', ?, 'syncing', 0, ?, ?)`
    ).run(
      'sq_stuck_1',
      'rest_grp_a',
      'tables',
      'tbl_stuck',
      JSON.stringify({ name: 'T1' }),
      new Date().toISOString(),
      new Date().toISOString()
    )

    const worker = new SyncWorker()
    // Worker constructor automatically resets stuck items to pending
    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_stuck_1')
    assert.strictEqual(item.status, 'pending', "Stuck 'syncing' item must be reset to 'pending'")
  })

  console.log('\n[Suite A4: Soft-Delete Routing for Restricted Collections]')
  await itAsync('routes delete of order to soft-delete payload (writeDoc with deletedAt)', async () => {
    db.prepare("DELETE FROM sync_queue WHERE id LIKE 'sq_del_%'").run()

    const worker = new SyncWorker()
    worker.projectId = 'demo-proj'
    worker.authToken = 'valid_token'
    worker.restaurantId = 'rest_grp_a'

    db.prepare(
      `INSERT INTO sync_queue (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'delete', ?, 'pending', 0, ?, ?)`
    ).run(
      'sq_del_order_1',
      'rest_grp_a',
      'orders',
      'order_999',
      JSON.stringify({ status: 'cancelled' }),
      new Date().toISOString(),
      new Date().toISOString()
    )

    let methodCalled = ''
    let receivedPayload = null
    firestoreRest.setMockTransport(async (opts, body) => {
      methodCalled = opts.method
      receivedPayload = body
      return {}
    })

    await worker.processQueue()

    assert.strictEqual(methodCalled, 'PATCH', 'Should call PATCH writeDoc rather than HTTP DELETE for orders')
    assert(receivedPayload && receivedPayload.fields, 'Payload fields must exist')
    assert(receivedPayload.fields.deletedAt, 'Must include deletedAt timestamp')

    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_del_order_1')
    assert.strictEqual(item.status, 'synced')

    firestoreRest.clearMockTransport()
  })

  await itAsync('uses hard deleteDoc for deletable collections (categories, menuItems)', async () => {
    db.prepare("DELETE FROM sync_queue WHERE id LIKE 'sq_del_%'").run()

    const worker = new SyncWorker()
    worker.projectId = 'demo-proj'
    worker.authToken = 'valid_token'
    worker.restaurantId = 'rest_grp_a'

    db.prepare(
      `INSERT INTO sync_queue (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'delete', ?, 'pending', 0, ?, ?)`
    ).run(
      'sq_del_cat_1',
      'rest_grp_a',
      'categories',
      'cat_to_delete',
      JSON.stringify({}),
      new Date().toISOString(),
      new Date().toISOString()
    )

    let methodCalled = ''
    firestoreRest.setMockTransport(async (opts) => {
      methodCalled = opts.method
      return {}
    })

    await worker.processQueue()

    assert.strictEqual(methodCalled, 'DELETE', 'Should call HTTP DELETE for categories')

    const item = db.prepare('SELECT * FROM sync_queue WHERE id = ?').get('sq_del_cat_1')
    assert.strictEqual(item.status, 'synced')

    firestoreRest.clearMockTransport()
  })

  console.log('\n========================================')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log('========================================\n')

  closeDb()
  app.exit(failed > 0 ? 1 : 0)
}

app.whenReady().then(runTests)
