/**
 * Generic repository — handles all collections via the collection registry.
 * Provides:
 *   query(restaurantId, collection, filters, max)  → records[]
 *   upsert(restaurantId, collection, values, id)   → id
 *   softDelete(restaurantId, collection, id)        → void
 *   getById(restaurantId, collection, id)          → record | null
 *
 * All writes add a corresponding sync_queue entry within the same SQLite transaction.
 */

const EventEmitter = require('events')
const { getDb } = require('../sqliteClient.cjs')
const { getEntry } = require('./collectionRegistry.cjs')
const { now, toIso, makeId } = require('./helpers.cjs')
const localWriteEvents = new EventEmitter()

// ─── SYNC QUEUE HELPERS ───────────────────────────────────────────────────────

function insertSyncQueueEntry(db, restaurantId, collection, recordId, action, payload) {
  const ts = now()
  db.prepare(`
    INSERT OR REPLACE INTO sync_queue
      (id, restaurant_id, collection_name, record_id, action, payload_json, status, retry_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(makeId(), restaurantId, collection, recordId, action, JSON.stringify(payload), ts, ts)
}

// ─── FILTER APPLICATION ───────────────────────────────────────────────────────
// filters: Array of [field, operator, value]  (same shape as Firestore queries in data.js)
// Supported operators: ==, !=, <, <=, >, >=, in, array-contains
// Fields use JS camelCase and are mapped here to SQL column names.

// Only columns used in the app's watchRecords calls need mapping.
const FIELD_MAP = {
  restaurantId:  'restaurant_id',
  status:        'status',
  paymentStatus: 'payment_status',
  createdBy:     'created_by',
  customerId:    'customer_id',
  tableId:       'table_id',
  categoryId:    'category_id',
  available:     'available',
  type:          'type',
  ingredientId:  'ingredient_id',
  supplierId:    'supplier_id',
  date:          'date',
  active:        'active',
  email:         'email',
  role:          'role',
  syncStatus:    'sync_status',
}

function sqlField(jsField) {
  return FIELD_MAP[jsField] || jsField
}

function buildWhere(filters, restaurantId, table) {
  const conditions = [`${table}.restaurant_id = ?`, `${table}.deleted_at IS NULL`]
  const params = [restaurantId]

  for (const [field, op, value] of (filters || [])) {
    const col = `${table}.${sqlField(field)}`
    if (op === '==' || op === '===') {
      conditions.push(`${col} = ?`)
      params.push(value === true ? 1 : value === false ? 0 : value)
    } else if (op === '!=' || op === '!==') {
      conditions.push(`${col} != ?`)
      params.push(value)
    } else if (op === '<')  { conditions.push(`${col} < ?`);  params.push(value) }
    else if (op === '<=') { conditions.push(`${col} <= ?`); params.push(value) }
    else if (op === '>')  { conditions.push(`${col} > ?`);  params.push(value) }
    else if (op === '>=') { conditions.push(`${col} >= ?`); params.push(value) }
    else if (op === 'in' && Array.isArray(value)) {
      if (value.length === 0) {
        conditions.push('0 = 1') // empty IN → no results
      } else {
        conditions.push(`${col} IN (${value.map(() => '?').join(',')})`)
        params.push(...value)
      }
    }
    // array-contains not applicable to SQL columns directly; skip silently
  }

  return { where: conditions.join(' AND '), params }
}

// ─── QUERY (replaces watchRecords reads) ─────────────────────────────────────

function query(restaurantId, collection, filters = [], max = 150) {
  const db = getDb()
  const { table, fromRow } = getEntry(collection)

  // audit_logs and stock_movements don't have restaurant_id on all rows
  // but our schema does have it. Handle tables without deleted_at:
  const noDeletedAt = ['stock_movements', 'audit_logs', 'counters', 'printers']
  const hasDeletedAt = !noDeletedAt.includes(table)

  const conditions = [`${table}.restaurant_id = ?`]
  const params = [restaurantId]

  if (hasDeletedAt) conditions.push(`${table}.deleted_at IS NULL`)

  for (const [field, op, value] of (filters || [])) {
    const col = `${table}.${sqlField(field)}`
    if (op === '==' || op === '===') {
      conditions.push(`${col} = ?`)
      params.push(value === true ? 1 : value === false ? 0 : value)
    } else if (op === '!=' || op === '!==') {
      conditions.push(`${col} != ?`)
      params.push(value)
    } else if (op === '<')  { conditions.push(`${col} < ?`);  params.push(value) }
    else if (op === '<=') { conditions.push(`${col} <= ?`); params.push(value) }
    else if (op === '>')  { conditions.push(`${col} > ?`);  params.push(value) }
    else if (op === '>=') { conditions.push(`${col} >= ?`); params.push(value) }
    else if (op === 'in' && Array.isArray(value)) {
      if (value.length === 0) {
        conditions.push('0 = 1')
      } else {
        conditions.push(`${col} IN (${value.map(() => '?').join(',')})`)
        params.push(...value)
      }
    }
  }

  // The existing app uses orderBy('createdAt', 'desc') universally.
  const hasCreatedAt = !['counters'].includes(table)
  const orderClause = hasCreatedAt ? `ORDER BY ${table}.created_at DESC` : ''
  const sql = `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')} ${orderClause} LIMIT ?`
  params.push(max)

  const rows = db.prepare(sql).all(...params)
  return rows.map(fromRow)
}

// ─── GET BY ID ────────────────────────────────────────────────────────────────

function getById(restaurantId, collection, id) {
  const db = getDb()
  const { table, fromRow } = getEntry(collection)
  const pkCol = table === 'order_financials' ? 'order_id' : 'id'
  const row = db.prepare(
    `SELECT * FROM ${table} WHERE ${pkCol} = ? AND restaurant_id = ?`
  ).get(id, restaurantId)
  return row ? fromRow(row) : null
}

// ─── UPSERT (replaces saveRecord writes) ──────────────────────────────────────

function upsert(restaurantId, collection, values, id) {
  const db = getDb()
  const { table, toRow, fromRow } = getEntry(collection)

  const recordId = id || makeId()
  const pkCol = table === 'order_financials' ? 'order_id' : 'id'

  // Merge existing row so partial updates don't lose unset fields
  const existing = db.prepare(
    `SELECT * FROM ${table} WHERE ${pkCol} = ? AND restaurant_id = ?`
  ).get(recordId, restaurantId)

  const existingJs = existing ? fromRow(existing) : {}
  const merged = { ...existingJs, ...values }
  const row = toRow(restaurantId, recordId, merged)
  row.uuid = existing?.uuid || merged.uuid || recordId
  row.sync_status = 'pending'
  row.updated_at = row.updated_at || now()
  row.synced = 0
  row.deleted = merged.deletedAt ? 1 : 0

  const cols = Object.keys(row)
  const placeholders = cols.map(() => '?').join(', ')
  const updates = cols.filter((c) => c !== pkCol).map((c) => `${c} = excluded.${c}`).join(', ')

  const insertSql = `
    INSERT INTO ${table} (${cols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(${pkCol}) DO UPDATE SET ${updates}
  `

  const syncPayload = {
    id: recordId,
    uuid: row.uuid,
    restaurantId,
    ...merged,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  }
  const action = existing ? 'update' : 'set'

  const transact = db.transaction(() => {
    db.prepare(insertSql).run(...cols.map((c) => row[c]))
    insertSyncQueueEntry(db, restaurantId, collection, recordId, action, syncPayload)
  })
  transact()
  localWriteEvents.emit('write', { restaurantId, collection, recordId })

  return recordId
}

// ─── SOFT DELETE ──────────────────────────────────────────────────────────────

function softDelete(restaurantId, collection, id) {
  const db = getDb()
  const { table } = getEntry(collection)

  const pkCol = table === 'order_financials' ? 'order_id' : 'id'
  const ts = now()
  const existing = db.prepare(
    `SELECT uuid FROM ${table} WHERE ${pkCol} = ? AND restaurant_id = ?`
  ).get(id, restaurantId)

  const transact = db.transaction(() => {
    db.prepare(
      `UPDATE ${table} SET deleted_at = ?, updated_at = ?, sync_status = 'pending', synced = 0, deleted = 1
       WHERE ${pkCol} = ? AND restaurant_id = ?`
    ).run(ts, ts, id, restaurantId)
    insertSyncQueueEntry(db, restaurantId, collection, id, 'delete', {
      id,
      uuid: existing?.uuid || id,
      restaurantId,
      deletedAt: ts,
      updatedAt: ts,
    })
  })
  transact()
  localWriteEvents.emit('write', { restaurantId, collection, recordId: id })
}

// ─── BULK UPSERT (used by initial Firestore import) ───────────────────────────
// Records imported from Firestore are marked sync_status='synced' (no queue entry needed).

function bulkUpsertSynced(restaurantId, collection, records) {
  const db = getDb()
  const { table, toRow } = getEntry(collection)
  const pkCol = table === 'order_financials' ? 'order_id' : 'id'

  const transact = db.transaction(() => {
    for (const record of records) {
      const rid = record.id || record.orderId
      if (!rid) continue
      const current = db.prepare(`SELECT * FROM ${table} WHERE ${pkCol} = ? AND restaurant_id = ?`).get(rid, restaurantId)
      const remoteUpdatedAt = record.updatedAt ? toIso(record.updatedAt) : ''
      if (current && (!remoteUpdatedAt || current.updated_at >= remoteUpdatedAt)) continue
      const row = toRow(restaurantId, rid, { ...record, syncStatus: 'synced' })
      row.uuid = record.uuid || rid
      row.updated_at = remoteUpdatedAt || row.updated_at || now()
      row.synced = 1
      row.deleted = record.deletedAt ? 1 : 0
      if (Object.hasOwn(row, 'deleted_at')) row.deleted_at = record.deletedAt ? toIso(record.deletedAt) : null
      const cols = Object.keys(row)
      const placeholders = cols.map(() => '?').join(', ')
      const updates = cols.filter((c) => c !== pkCol).map((c) => `${c} = excluded.${c}`).join(', ')
      db.prepare(`
        INSERT INTO ${table} (${cols.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT(${pkCol}) DO UPDATE SET ${updates}
      `).run(...cols.map((c) => row[c]))
    }
  })
  transact()
}

module.exports = {
  query,
  getById,
  upsert,
  softDelete,
  bulkUpsertSynced,
  onLocalWrite: (listener) => {
    localWriteEvents.on('write', listener)
    return () => localWriteEvents.off('write', listener)
  },
}
