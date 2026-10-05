const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')
const { runMigrations } = require('./migrations/runner.cjs')

let _db = null

/**
 * Returns the singleton better-sqlite3 database instance.
 * Initializes on first call: sets WAL mode, FK enforcement, and runs migrations.
 */
function getDb() {
  if (_db) return _db

  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'database')

  // Ensure directory exists
  const fs = require('fs')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  const dbPath = path.join(dbDir, 'restaurantos.db')
  console.log('[DB] Opening database at:', dbPath)

  _db = new Database(dbPath)

  // Performance and safety pragmas
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('cache_size = -16000')   // 16 MB page cache
  _db.pragma('temp_store = MEMORY')
  _db.pragma('mmap_size = 134217728') // 128 MB mmap

  // Run pending migrations
  runMigrations(_db)

  console.log('[DB] Database ready.')
  return _db
}

/**
 * Closes the database. Called on app shutdown.
 */
function closeDb() {
  if (_db) {
    _db.close()
    _db = null
    console.log('[DB] Database closed.')
  }
}

module.exports = { getDb, closeDb }
