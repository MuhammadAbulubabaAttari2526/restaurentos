/**
 * localState.cjs
 * Thin wrapper around the `local_state` key-value table.
 * Used by the sync worker to track lastPullAt per collection, etc.
 */

const { getDb } = require('../sqliteClient.cjs')

function get(key, fallback = null) {
  const db = getDb()
  const row = db.prepare('SELECT value_json FROM local_state WHERE key = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.value_json) } catch { return fallback }
}

function set(key, value) {
  const db = getDb()
  db.prepare(`
    INSERT INTO local_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString())
}

module.exports = { get, set }
