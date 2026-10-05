/**
 * backupManager.cjs
 *
 * Enterprise-grade SQLite Backup and Restore subsystem for RestaurantOS.
 * Uses better-sqlite3's online `db.backup()` API for zero-lock, WAL-safe snapshots.
 *
 * Rules:
 *  1. All backups strictly reside in Electron's `userData/backups` directory.
 *  2. Online backup API ensures ACID-consistent point-in-time snapshots.
 *  3. Automated retention policy keeps the latest 14 backups to prevent disk saturation.
 *  4. Before any restore, a safety backup of the current database is automatically created.
 *  5. Before any schema migration, a pre-migration backup is created.
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const MAX_BACKUP_RETENTION = 14

/**
 * Returns the directory path for backups in userData.
 */
function getBackupDir() {
  const userData = app.getPath('userData')
  const backupDir = path.join(userData, 'backups')
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true })
  }
  return backupDir
}

/**
 * Formats current UTC timestamp for safe file names: YYYYMMDD-HHmmss
 */
function getTimestampString() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const yyyy = now.getUTCFullYear()
  const mm = pad(now.getUTCMonth() + 1)
  const dd = pad(now.getUTCDate())
  const hh = pad(now.getUTCHours())
  const min = pad(now.getUTCMinutes())
  const ss = pad(now.getUTCSeconds())
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`
}

/**
 * Performs an online SQLite backup using SQLite VACUUM INTO or db.backup().
 * Zero-locking, safe during active WAL transactions.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} destPath
 * @returns {Promise<void>}
 */
async function performSqliteBackup(db, destPath) {
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath)
  }

  if (typeof db.backup === 'function') {
    await db.backup(destPath)
  } else {
    performSqliteBackupSync(db, destPath)
  }
}

/**
 * Synchronous version of SQLite online backup using VACUUM INTO.
 * Used during startup migrations when synchronous execution is required.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} destPath
 */
function performSqliteBackupSync(db, destPath) {
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath)
  }
  db.prepare('VACUUM INTO ?').run(destPath)
}

/**
 * Creates a backup of the current database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [reason='manual'] - 'manual' | 'daily' | 'on_close' | 'pre_update' | 'pre_restore' | 'pre_migration'
 * @param {object} [extraMeta]
 * @returns {Promise<{ success: boolean, backupPath: string, filename: string, sizeBytes: number }>}
 */
async function createBackup(db, reason = 'manual', extraMeta = {}) {
  try {
    const backupDir = getBackupDir()
    const ts = getTimestampString()
    let filename = `backup-${reason}-${ts}.db`

    if (reason === 'pre_migration' && extraMeta.fromVersion !== undefined && extraMeta.toVersion !== undefined) {
      filename = `backup-before-v${extraMeta.fromVersion}-to-v${extraMeta.toVersion}-${ts}.db`
    } else if (reason === 'pre_restore') {
      filename = `backup-before-restore-${ts}.db`
    }

    const destPath = path.join(backupDir, filename)
    await performSqliteBackup(db, destPath)

    const stats = fs.statSync(destPath)
    console.log(`[Backup] Successfully created ${filename} (${stats.size} bytes)`)

    // Enforce retention limit
    pruneOldBackups(MAX_BACKUP_RETENTION)

    return {
      success: true,
      backupPath: destPath,
      filename,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
      reason,
    }
  } catch (err) {
    console.error('[Backup Error] Failed to create backup:', err)
    throw err
  }
}

/**
 * Synchronous backup creation.
 */
function createBackupSync(db, reason = 'manual', extraMeta = {}) {
  try {
    const backupDir = getBackupDir()
    const ts = getTimestampString()
    let filename = `backup-${reason}-${ts}.db`

    if (reason === 'pre_migration' && extraMeta.fromVersion !== undefined && extraMeta.toVersion !== undefined) {
      filename = `backup-before-v${extraMeta.fromVersion}-to-v${extraMeta.toVersion}-${ts}.db`
    } else if (reason === 'pre_restore') {
      filename = `backup-before-restore-${ts}.db`
    }

    const destPath = path.join(backupDir, filename)
    performSqliteBackupSync(db, destPath)

    const stats = fs.statSync(destPath)
    console.log(`[Backup] Created synchronous backup: ${filename} (${stats.size} bytes)`)
    pruneOldBackups(MAX_BACKUP_RETENTION)

    return {
      success: true,
      backupPath: destPath,
      filename,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
      reason,
    }
  } catch (err) {
    console.error('[Backup Error] Failed to create sync backup:', err)
    throw err
  }
}

/**
 * Synchronous pre-migration backup.
 */
function createPreMigrationBackupSync(db, fromVersion, toVersion) {
  return createBackupSync(db, 'pre_migration', { fromVersion, toVersion })
}

/**
 * Creates pre-migration backup before applying a schema upgrade.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} fromVersion
 * @param {number} toVersion
 */
async function createPreMigrationBackup(db, fromVersion, toVersion) {
  return createBackup(db, 'pre_migration', { fromVersion, toVersion })
}

/**
 * Lists all existing database backups in userData/backups sorted by date (newest first).
 *
 * @returns {Array<{ filename: string, fullPath: string, sizeBytes: number, createdAt: string, reason: string }>}
 */
function listBackups() {
  const backupDir = getBackupDir()
  if (!fs.existsSync(backupDir)) return []

  const files = fs.readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((filename) => {
      const fullPath = path.join(backupDir, filename)
      const stats = fs.statSync(fullPath)
      let reason = 'manual'
      if (filename.includes('daily')) reason = 'daily'
      else if (filename.includes('on_close')) reason = 'on_close'
      else if (filename.includes('pre_update')) reason = 'pre_update'
      else if (filename.includes('before-restore')) reason = 'pre_restore'
      else if (filename.includes('before-v')) reason = 'pre_migration'

      return {
        filename,
        fullPath,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
        reason,
      }
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

  return files
}

/**
 * Prunes backups exceeding the maximum retention limit. Keeps the newest maxKeep files.
 *
 * @param {number} [maxKeep=14]
 */
function pruneOldBackups(maxKeep = MAX_BACKUP_RETENTION) {
  const backups = listBackups()
  if (backups.length <= maxKeep) return

  const toDelete = backups.slice(maxKeep)
  for (const item of toDelete) {
    try {
      fs.unlinkSync(item.fullPath)
      console.log(`[Backup] Pruned old backup: ${item.filename}`)
    } catch (err) {
      console.warn(`[Backup] Could not prune ${item.filename}:`, err.message)
    }
  }
}

/**
 * Verifies that a file is a valid SQLite 3 database header.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isValidSqliteFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(16)
    fs.readSync(fd, buffer, 0, 16, 0)
    fs.closeSync(fd)
    const header = buffer.toString('utf8')
    return header.startsWith('SQLite format 3')
  } catch {
    return false
  }
}

/**
 * Restores a backup file to become the active database.
 *
 * Process:
 *  1. Validates the backup file.
 *  2. Creates a pre-restore backup of the current database.
 *  3. Closes current database connection.
 *  4. Copies backup file into place and removes stale WAL/SHM journal files.
 *  5. Re-opens database and verifies integrity check.
 *
 * @param {string} backupFileNameOrPath
 * @param {Function} getDbFn - returns current db
 * @param {Function} closeDbFn - closes current db
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function restoreBackup(backupFileNameOrPath, getDbFn, closeDbFn) {
  const backupDir = getBackupDir()
  const sourcePath = path.isAbsolute(backupFileNameOrPath)
    ? backupFileNameOrPath
    : path.join(backupDir, backupFileNameOrPath)

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Backup file not found: ${sourcePath}`)
  }

  if (!isValidSqliteFile(sourcePath)) {
    throw new Error('Target file is not a valid SQLite database.')
  }

  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'database')
  const targetDbPath = path.join(dbDir, 'restaurantos.db')

  // 1. Take safety pre-restore backup if current DB exists
  let preRestoreBackup = null
  const currentDb = getDbFn()
  if (currentDb) {
    console.log('[Restore] Creating safety pre-restore backup of current DB...')
    preRestoreBackup = await createBackup(currentDb, 'pre_restore')
  }

  // 2. Close current DB
  closeDbFn()

  // 3. Remove stale WAL & SHM files to prevent corruption from older transaction logs
  const walPath = `${targetDbPath}-wal`
  const shmPath = `${targetDbPath}-shm`
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)

  // 4. Copy restored database over target
  fs.copyFileSync(sourcePath, targetDbPath)
  console.log(`[Restore] Database file replaced from ${sourcePath}`)

  // 5. Re-open DB and run integrity check
  const restoredDb = getDbFn()
  const check = restoredDb.pragma('integrity_check')
  if (!check || check[0]?.integrity_check !== 'ok') {
    throw new Error(`Restored database failed integrity check: ${JSON.stringify(check)}`)
  }

  console.log('[Restore] Database restored and integrity check PASSED.')
  return {
    success: true,
    message: 'Database restored successfully.',
    preRestoreBackup,
  }
}

/**
 * Checks if the primary database is missing at startup.
 * If missing, scans for existing backups to warn/prompt restore.
 *
 * @returns {{ missing: boolean, hasBackups: boolean, latestBackup: object|null }}
 */
function checkMissingDatabase() {
  const userDataPath = app.getPath('userData')
  const targetDbPath = path.join(userDataPath, 'database', 'restaurantos.db')
  const exists = fs.existsSync(targetDbPath)

  if (exists) {
    return { missing: false, hasBackups: false, latestBackup: null }
  }

  const backups = listBackups()
  return {
    missing: true,
    hasBackups: backups.length > 0,
    latestBackup: backups[0] || null,
  }
}

module.exports = {
  getBackupDir,
  createBackup,
  createBackupSync,
  createPreMigrationBackup,
  createPreMigrationBackupSync,
  listBackups,
  pruneOldBackups,
  restoreBackup,
  checkMissingDatabase,
  isValidSqliteFile,
  MAX_BACKUP_RETENTION,
}
