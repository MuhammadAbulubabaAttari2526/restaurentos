import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { runMigrations } = require('../../database/migrations/runner.cjs')
let migrationDirectory

afterEach(() => {
  if (migrationDirectory) rmSync(migrationDirectory, { recursive: true, force: true })
  migrationDirectory = null
})

describe('SQLite migration backup safety', () => {
  it('aborts an existing database migration when backup creation fails', () => {
    migrationDirectory = mkdtempSync(path.join(tmpdir(), 'restaurantos-migrations-'))
    writeFileSync(path.join(migrationDirectory, '002_add_new_column.sql'), 'ALTER TABLE kept ADD COLUMN new_value TEXT;')
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES (1, '2026-01-01');
      CREATE TABLE kept (id TEXT PRIMARY KEY);`)

    expect(() => runMigrations(db, migrationDirectory, {
      createPreMigrationBackupSync: () => { throw new Error('disk full') },
      pruneOldBackups: () => {},
    })).toThrow(/pre-migration backup failed: disk full/)
    expect(db.prepare('PRAGMA table_info(kept)').all().some((column) => column.name === 'new_value')).toBe(false)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version).toBe(1)
    db.close()
  })

  it('allows a brand-new database to initialize when no backup can exist', () => {
    migrationDirectory = mkdtempSync(path.join(tmpdir(), 'restaurantos-migrations-'))
    mkdirSync(migrationDirectory, { recursive: true })
    writeFileSync(path.join(migrationDirectory, '001_initial.sql'), 'CREATE TABLE kept (id TEXT PRIMARY KEY);')
    const db = new Database(':memory:')

    runMigrations(db, migrationDirectory, {
      createPreMigrationBackupSync: () => { throw new Error('no existing file') },
      pruneOldBackups: () => {},
    })
    expect(db.prepare('SELECT version FROM schema_version').get().version).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kept'").get().name).toBe('kept')
    db.close()
  })
})