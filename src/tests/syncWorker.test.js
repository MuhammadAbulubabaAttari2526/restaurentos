import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  db: null,
  readDoc: vi.fn(),
  buildUpdateWrite: vi.fn(),
  commitWrites: vi.fn(),
  queryUpdatedSince: vi.fn(),
  bulkUpsertSynced: vi.fn(),
}))

import { SyncWorker } from '../../sync/syncWorker.cjs'

function makeQueueItem(overrides = {}) {
  const timestamp = new Date().toISOString()
  const payload = {
    id: 'category-1',
    uuid: 'category-1',
    restaurantId: 'restaurant-1',
    name: 'Drinks',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  mocks.db.prepare(`INSERT INTO sync_queue
    (id, restaurant_id, collection_name, record_id, action, payload_json, status,
     retry_count, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      overrides.id || 'queue-1',
      'restaurant-1',
      'categories',
      'category-1',
      'set',
      JSON.stringify(payload),
      overrides.status || 'pending',
      overrides.retryCount || 0,
      overrides.lastError || null,
      timestamp,
      overrides.updatedAt || timestamp,
    )
  return payload
}

describe('SyncWorker queue reliability', () => {
  let worker

  beforeEach(() => {
    mocks.db = new Database(':memory:')
    for (let version = 1; version <= 6; version += 1) {
      const prefix = `${String(version).padStart(3, '0')}_`
      const migration = readdirSync('database/migrations').find((file) => file.startsWith(prefix))
      mocks.db.exec(readFileSync(`database/migrations/${migration}`, 'utf8'))
    }
    mocks.db.prepare(`INSERT INTO categories
      (id, restaurant_id, name, created_at, updated_at, sync_status, version, uuid, synced, deleted)
      VALUES ('category-1', 'restaurant-1', 'Drinks', '2026-01-01', '2026-01-01', 'pending', 1, 'category-1', 0, 0)`).run()

    mocks.readDoc.mockReset().mockResolvedValue(null)
    mocks.buildUpdateWrite.mockReset().mockImplementation((write) => write)
    mocks.commitWrites.mockReset().mockResolvedValue({})
    mocks.queryUpdatedSince.mockReset().mockResolvedValue([])
    mocks.bulkUpsertSynced.mockReset()
    worker = new SyncWorker({
      getDb: () => mocks.db,
      repository: {
        onLocalWrite: () => () => {},
        bulkUpsertSynced: mocks.bulkUpsertSynced,
      },
      firestoreRest: {
        readDoc: mocks.readDoc,
        buildUpdateWrite: mocks.buildUpdateWrite,
        commitWrites: mocks.commitWrites,
        queryUpdatedSince: mocks.queryUpdatedSince,
      },
      networkMonitor: {
        on: vi.fn(),
        isOnline: () => true,
        checkNow: async () => true,
        start: vi.fn(),
        stop: vi.fn(),
      },
    })
    worker.projectId = 'test-project'
    worker.authToken = 'valid-token'
    worker.restaurantId = 'restaurant-1'
  })

  afterEach(() => {
    worker?.stop()
    mocks.db?.close()
    mocks.db = null
  })

  it('marks a queue item synced only after Firestore confirms the batch', async () => {
    makeQueueItem()
    await worker.processQueue()

    expect(mocks.commitWrites).toHaveBeenCalledOnce()
    expect(mocks.commitWrites.mock.calls[0][0].writes).toHaveLength(1)
    expect(mocks.db.prepare('SELECT status FROM sync_queue').get().status).toBe('synced')
    expect(mocks.db.prepare('SELECT synced FROM categories').get().synced).toBe(1)
  })

  it('does not increment retry count for network failures and applies backoff', async () => {
    makeQueueItem()
    mocks.commitWrites.mockRejectedValueOnce(new Error('connection reset'))

    await worker.processQueue()
    const failed = mocks.db.prepare('SELECT status, retry_count, last_error FROM sync_queue').get()
    expect(failed.status).toBe('pending')
    expect(failed.retry_count).toBe(0)
    expect(failed.last_error).toMatch(/^TRANSIENT:/)

    const readCount = mocks.readDoc.mock.calls.length
    await worker.processQueue()
    expect(mocks.readDoc).toHaveBeenCalledTimes(readCount)
  })

  it('pauses the queue on expired credentials without increasing retries', async () => {
    makeQueueItem()
    mocks.readDoc.mockRejectedValueOnce(Object.assign(new Error('expired token'), { status: 401 }))

    await worker.processQueue()

    expect(worker.getStatus().status).toBe('auth-required')
    expect(mocks.db.prepare('SELECT status, retry_count FROM sync_queue').get()).toEqual({
      status: 'pending',
      retry_count: 0,
    })
  })

  it('marks rejected writes for attention', async () => {
    makeQueueItem()
    mocks.commitWrites.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { status: 403 }))

    await worker.processQueue()

    expect(worker.getNeedsAttentionCount()).toBe(1)
    expect(mocks.db.prepare('SELECT status, retry_count, last_error FROM sync_queue').get()).toMatchObject({
      status: 'failed',
      retry_count: 1,
      last_error: expect.stringMatching(/^REJECTED 403:/),
    })
  })

  it('keeps newer cloud data instead of committing an older local row', async () => {
    const payload = makeQueueItem()
    mocks.readDoc.mockResolvedValueOnce({
      id: 'category-1',
      data: { id: 'category-1', name: 'Cloud newer', updatedAt: '2099-01-01T00:00:00.000Z' },
      updateTime: '2099-01-01T00:00:00.000Z',
    })

    await worker.processQueue()

    expect(mocks.commitWrites).not.toHaveBeenCalled()
    expect(mocks.bulkUpsertSynced).toHaveBeenCalledWith('restaurant-1', 'categories', [{
      id: 'category-1',
      name: 'Cloud newer',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }])
    expect(mocks.db.prepare('SELECT status FROM sync_queue').get().status).toBe('synced')
    expect(payload.name).toBe('Drinks')
  })

  it('resumes after a refreshed token and clears the auth-required queue marker', () => {
    makeQueueItem({ lastError: 'AUTH_REQUIRED: expired' })
    worker.authRequired = true
    worker.network.checkNow = async () => false

    worker.setCredentials({
      projectId: 'test-project',
      authToken: 'refreshed-token',
      restaurantId: 'restaurant-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })

    expect(worker.authRequired).toBe(false)
    expect(mocks.db.prepare('SELECT status, last_error FROM sync_queue').get()).toEqual({
      status: 'pending',
      last_error: null,
    })
  })

  it('recovers rows left syncing when the app stopped', () => {
    makeQueueItem({ status: 'syncing' })

    worker.recoverStuckQueue()

    expect(mocks.db.prepare('SELECT status FROM sync_queue').get().status).toBe('pending')
  })

  it('requeues the known malformed Firestore document-name rejection', () => {
    makeQueueItem({
      status: 'failed',
      retryCount: 1,
      lastError: 'REJECTED 400: Document name "https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/restaurants/r/orders/o" lacks "projects" at index 0.',
    })

    worker.recoverStuckQueue()

    expect(mocks.db.prepare('SELECT status, retry_count, last_error FROM sync_queue').get()).toEqual({
      status: 'pending',
      retry_count: 0,
      last_error: null,
    })
  })
})