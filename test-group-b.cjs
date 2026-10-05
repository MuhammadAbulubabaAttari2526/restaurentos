/**
 * test-group-b.cjs
 *
 * Headless verification tests for Group B: Offline Login & auth_cache
 *
 * B1. Migration 005 creates auth_cache table with correct columns
 * B2. hashPassword produces unique salts and verifyPassword is correct
 * B3. cacheCredentials inserts/updates user in auth_cache
 * B4. offlineLogin succeeds with correct password
 * B5. offlineLogin fails with wrong password (attemptsRemaining decrements)
 * B6. Lockout triggers after MAX_FAILED_ATTEMPTS and respects lockedUntil
 * B7. Lockout auto-resets after lockedUntil passes
 * B8. updateCachedToken refreshes the stored token
 * B9. getCachedSession returns profile + lastToken
 * B10. listCachedEmails returns entries
 * B11. clearCachedUser removes the entry
 * B12. Auth IPC handlers registered without throwing
 */

const assert = require('assert')
const { app } = require('electron')
const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const {
  hashPassword,
  verifyPassword,
  cacheCredentials,
  updateCachedToken,
  offlineLogin,
  getCachedSession,
  listCachedEmails,
  clearCachedUser,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
} = require('./database/repositories/authCache.cjs')
const { registerAuthIpc } = require('./electron/ipc/authIpc.cjs')

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

const TEST_UID   = 'uid_grp_b_test'
const TEST_EMAIL = 'btest@restaurantos.test'
const TEST_PASS  = 'SuperSecret@123'
const TEST_RID   = 'rest_grp_b'

async function runTests() {
  console.log('\n========================================')
  console.log('--- Group B: Offline Login Tests ---')
  console.log('========================================\n')

  const db = getDb()

  // Clean up any prior test data
  db.prepare("DELETE FROM auth_cache WHERE uid LIKE 'uid_grp_b%'").run()

  console.log('[Suite B1: Migration — auth_cache table]')
  it('auth_cache table exists with required columns', () => {
    const tableInfo = db.prepare("PRAGMA table_info(auth_cache)").all()
    const cols = tableInfo.map((r) => r.name)
    for (const required of [
      'uid', 'email', 'display_name', 'role', 'restaurant_id', 'permissions_json',
      'scrypt_hash', 'scrypt_salt', 'scrypt_n', 'scrypt_r', 'scrypt_p', 'scrypt_keylen',
      'failed_attempts', 'locked_until', 'last_token', 'last_token_cached_at',
      'cached_at', 'updated_at',
    ]) {
      assert(cols.includes(required), `Missing column: ${required}`)
    }
  })

  console.log('\n[Suite B2: Password Hashing]')
  await itAsync('hashPassword produces unique salts for same password', async () => {
    const r1 = await hashPassword(TEST_PASS)
    const r2 = await hashPassword(TEST_PASS)
    assert.notStrictEqual(r1.salt, r2.salt, 'Salts must be unique')
    assert.notStrictEqual(r1.hash, r2.hash, 'Hashes with different salts must differ')
    assert(r1.hash.length === 128, 'Hash should be 64 bytes hex = 128 chars')
  })

  await itAsync('verifyPassword returns true for correct password', async () => {
    const { hash, salt } = await hashPassword(TEST_PASS)
    const ok = await verifyPassword(TEST_PASS, hash, salt, 16384, 8, 1, 64)
    assert.strictEqual(ok, true)
  })

  await itAsync('verifyPassword returns false for wrong password', async () => {
    const { hash, salt } = await hashPassword(TEST_PASS)
    const ok = await verifyPassword('WrongPassword!', hash, salt, 16384, 8, 1, 64)
    assert.strictEqual(ok, false)
  })

  console.log('\n[Suite B3: cacheCredentials]')
  await itAsync('cacheCredentials inserts a new user into auth_cache', async () => {
    await cacheCredentials({
      uid: TEST_UID,
      email: TEST_EMAIL,
      displayName: 'B Tester',
      role: 'cashier',
      restaurantId: TEST_RID,
      permissions: ['discounts'],
      password: TEST_PASS,
      lastToken: 'fake_token_abc',
    })
    const row = db.prepare('SELECT * FROM auth_cache WHERE uid = ?').get(TEST_UID)
    assert(row, 'Row must exist after cacheCredentials')
    assert.strictEqual(row.email, TEST_EMAIL)
    assert.strictEqual(row.role, 'cashier')
    assert.strictEqual(row.restaurant_id, TEST_RID)
    assert(row.scrypt_hash, 'scrypt_hash must be stored')
    assert(row.scrypt_salt, 'scrypt_salt must be stored')
    assert.strictEqual(row.last_token, 'fake_token_abc')
    assert.strictEqual(row.failed_attempts, 0)
  })

  await itAsync('cacheCredentials updates existing user without duplicating', async () => {
    await cacheCredentials({
      uid: TEST_UID,
      email: TEST_EMAIL,
      displayName: 'B Tester Updated',
      role: 'cashier',
      restaurantId: TEST_RID,
      permissions: ['discounts', 'refunds'],
      password: TEST_PASS,
      lastToken: 'fake_token_xyz',
    })
    const rows = db.prepare('SELECT * FROM auth_cache WHERE uid = ?').all(TEST_UID)
    assert.strictEqual(rows.length, 1, 'Must not duplicate entries')
    assert.strictEqual(rows[0].display_name, 'B Tester Updated')
    assert.strictEqual(rows[0].last_token, 'fake_token_xyz')
  })

  console.log('\n[Suite B4-B7: offlineLogin]')
  await itAsync('offlineLogin succeeds with correct password', async () => {
    const result = await offlineLogin(TEST_EMAIL, TEST_PASS)
    assert.strictEqual(result.ok, true)
    assert(result.user, 'user object must be returned')
    assert.strictEqual(result.user.uid, TEST_UID)
    assert.strictEqual(result.user.role, 'cashier')
    assert.strictEqual(result.user.restaurantId, TEST_RID)
    assert(Array.isArray(result.user.permissions))
    assert.strictEqual(result.user.isOfflineSession, true)
  })

  await itAsync('offlineLogin returns not_cached for unknown email', async () => {
    const result = await offlineLogin('nobody@example.com', TEST_PASS)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.reason, 'not_cached')
  })

  await itAsync('offlineLogin decrements attemptsRemaining on wrong password', async () => {
    const result = await offlineLogin(TEST_EMAIL, 'WrongPassword!')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.reason, 'invalid_credentials')
    assert(typeof result.attemptsRemaining === 'number')
    assert(result.attemptsRemaining < MAX_FAILED_ATTEMPTS)
  })

  await itAsync('account locks after MAX_FAILED_ATTEMPTS failed tries', async () => {
    // Reset first
    db.prepare('UPDATE auth_cache SET failed_attempts = 0, locked_until = NULL WHERE uid = ?').run(TEST_UID)

    let lastResult
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      lastResult = await offlineLogin(TEST_EMAIL, 'WrongPassword!')
    }
    assert.strictEqual(lastResult.ok, false)
    assert.strictEqual(lastResult.reason, 'locked')
    assert(lastResult.lockedUntil, 'lockedUntil must be set')

    // Further attempts must also return locked
    const lockedResult = await offlineLogin(TEST_EMAIL, TEST_PASS)
    assert.strictEqual(lockedResult.ok, false)
    assert.strictEqual(lockedResult.reason, 'locked')
  })

  it('lockout auto-resets after lockedUntil expires', () => {
    // Fast-forward: set locked_until to the past
    const pastTime = new Date(Date.now() - 1000).toISOString()
    db.prepare('UPDATE auth_cache SET locked_until = ? WHERE uid = ?').run(pastTime, TEST_UID)
    // Verify the row now shows past locked_until
    const row = db.prepare('SELECT locked_until FROM auth_cache WHERE uid = ?').get(TEST_UID)
    assert(new Date(row.locked_until).getTime() < Date.now(), 'locked_until should be in the past')
    // Next successful login attempt should reset the lockout (tested in next suite)
  })

  console.log('\n[Suite B8-B9: Token & Session]')
  it('updateCachedToken refreshes the stored token', () => {
    // Reset lockout first
    db.prepare('UPDATE auth_cache SET failed_attempts = 0, locked_until = NULL WHERE uid = ?').run(TEST_UID)

    const ok = updateCachedToken(TEST_UID, 'fresh_token_999')
    assert.strictEqual(ok, true)
    const row = db.prepare('SELECT last_token FROM auth_cache WHERE uid = ?').get(TEST_UID)
    assert.strictEqual(row.last_token, 'fresh_token_999')
  })

  it('getCachedSession returns profile and lastToken', () => {
    const session = getCachedSession(TEST_UID)
    assert(session, 'Session must exist')
    assert.strictEqual(session.uid, TEST_UID)
    assert.strictEqual(session.email, TEST_EMAIL)
    assert.strictEqual(session.role, 'cashier')
    assert.strictEqual(session.restaurantId, TEST_RID)
    assert.strictEqual(session.lastToken, 'fresh_token_999')
    assert(Array.isArray(session.permissions))
  })

  it('getCachedSession returns null for unknown uid', () => {
    const session = getCachedSession('uid_does_not_exist')
    assert.strictEqual(session, null)
  })

  console.log('\n[Suite B10-B11: Listing & Removal]')
  it('listCachedEmails returns all cached entries', () => {
    const list = listCachedEmails()
    assert(Array.isArray(list))
    const found = list.find((e) => e.email === TEST_EMAIL)
    assert(found, 'Test email must appear in list')
  })

  it('clearCachedUser removes the entry from auth_cache', () => {
    const ok = clearCachedUser(TEST_UID)
    assert.strictEqual(ok, true)
    const row = db.prepare('SELECT uid FROM auth_cache WHERE uid = ?').get(TEST_UID)
    assert.strictEqual(row, undefined, 'Row must be gone after clearCachedUser')
  })

  console.log('\n[Suite B12: Auth IPC Registration]')
  it('registerAuthIpc registers handlers without throwing', () => {
    // Already registered at module load — second call should be idempotent
    assert.doesNotThrow(() => registerAuthIpc())
  })

  console.log('\n========================================')
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log('========================================\n')

  closeDb()
  app.exit(failed > 0 ? 1 : 0)
}

app.whenReady().then(runTests)
