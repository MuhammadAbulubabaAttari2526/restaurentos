/**
 * runner.cjs
 *
 * Safe SQLite migration runner with enterprise safeguards:
 *  1. Version Compatibility Guard: If DB schema > app version, halts to prevent data damage.
 *  2. Pre-Migration Backups: Creates `backup-before-v<from>-to-v<to>-<timestamp>.db` before any migration.
 *  3. Strict Transactions: Every migration runs inside a transaction with automatic rollback on error.
 *  4. Schema Versioning: Records applied migrations in `schema_version`.
 */

const fs = require('fs')
const path = require('path')
const { createPreMigrationBackupSync, pruneOldBackups } = require('../../backup/backupManager.cjs')

/**
 * Runs all pending SQL migration files in order with full safety guarantees.
 *
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db, migrationsDir = __dirname) {
  // 1. Ensure schema_version table exists before querying it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `)

  // 2. Discover available migration files
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()

  const maxAppVersion = files.length > 0
    ? Math.max(...files.map((f) => parseInt(f.slice(0, 3), 10)))
    : 0

  // 3. Check current applied versions
  const rows = db.prepare('SELECT version FROM schema_version ORDER BY version ASC').all()
  const appliedVersions = new Set(rows.map((r) => r.version))
  const maxApplied = rows.length > 0 ? rows[rows.length - 1].version : 0

  // 4. Version compatibility safety check:
  // If the database has a higher version than the application knows about, STOP immediately.
  if (maxApplied > maxAppVersion) {
    const errorMsg = `[DB Incompatibility] Database schema version (v${maxApplied}) is newer than application schema version (v${maxAppVersion}). Please update RestaurantOS to the latest version before proceeding.`
    console.error(errorMsg)
    throw new Error(errorMsg)
  }

  // 5. Apply any pending migrations
  for (const file of files) {
    const targetVersion = parseInt(file.slice(0, 3), 10)
    if (appliedVersions.has(targetVersion)) continue

    const currentVersion = rows.length > 0 ? rows[rows.length - 1].version : 0

    console.log(`[DB Migration] Preparing upgrade from v${currentVersion} to v${targetVersion}...`)

    // Step A: Create pre-migration backup before touching schema
    try {
      createPreMigrationBackupSync(db, currentVersion, targetVersion)
    } catch (bErr) {
      if (currentVersion > 0) {
        throw new Error(`[DB Migration] Cannot migrate from v${currentVersion} to v${targetVersion}: pre-migration backup failed: ${bErr.message}`)
      }
      console.warn(`[DB Migration] Skipping backup for new database: ${bErr.message}`)
    }

    // Step B: Load migration SQL
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    console.log(`[DB Migration] Applying migration ${file}...`)

    // Step C: Execute in strict transaction
    try {
      const applyMigration = db.transaction(() => {
        // Clean out redundant schema_version definitions if present in script
        const cleanedSql = sql.replace(
          /CREATE TABLE IF NOT EXISTS schema_version[\s\S]*?;\n/i,
          ''
        )
        db.exec(cleanedSql)
        db.prepare(
          'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
        ).run(targetVersion, new Date().toISOString())
      })

      applyMigration()
      appliedVersions.add(targetVersion)
      rows.push({ version: targetVersion })
      console.log(`[DB Migration] Migration ${file} successfully applied.`)
    } catch (mErr) {
      const failureMsg = `[DB Migration Error] Migration ${file} FAILED: ${mErr.message}. All changes rolled back safely. Database remains at v${currentVersion}.`
      console.error(failureMsg)
      throw new Error(failureMsg)
    }
  }

  // Prune any backups exceeding retention limit
  pruneOldBackups()
}

module.exports = { runMigrations }
