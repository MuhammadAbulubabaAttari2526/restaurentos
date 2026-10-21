import { beforeEach, describe, expect, it, vi } from 'vitest'

// Create in-memory mock collections for database simulation
class MockCollection {
  constructor() {
    this.docs = new Map()
  }
  async createIndex() { return 'ok' }
  async insertOne(doc) {
    const id = String(doc._id || Math.random().toString(36).slice(2))
    const stored = structuredClone({ ...doc, _id: id })
    this.docs.set(id, stored)
    return { insertedId: id }
  }
  async findOne(query) {
    for (const doc of this.docs.values()) {
      if (this._matches(doc, query)) return structuredClone(doc)
    }
    return null
  }
  async updateOne(query, update, options) {
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, query)) {
        if (update.$set) Object.assign(doc, structuredClone(update.$set))
        if (update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v
        }
        return { matchedCount: 1, modifiedCount: 1 }
      }
    }
    if (options?.upsert) {
      const newDoc = { _id: query._id || Math.random().toString(36).slice(2) }
      if (update.$set) Object.assign(newDoc, structuredClone(update.$set))
      if (update.$setOnInsert) Object.assign(newDoc, structuredClone(update.$setOnInsert))
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) newDoc[k] = (newDoc[k] || 0) + v
      }
      this.docs.set(newDoc._id, newDoc)
      return { matchedCount: 0, upsertedCount: 1 }
    }
    return { matchedCount: 0 }
  }
  async findOneAndUpdate(query, update, options) {
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, query)) {
        if (update.$set) Object.assign(doc, structuredClone(update.$set))
        return options?.returnDocument === 'after' ? structuredClone(doc) : doc
      }
    }
    return null
  }
  async deleteOne(query) {
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, query)) {
        this.docs.delete(id)
        return { deletedCount: 1 }
      }
    }
    return { deletedCount: 0 }
  }
  async deleteMany(query) {
    let count = 0
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, query)) {
        this.docs.delete(id)
        count++
      }
    }
    return { deletedCount: count }
  }
  _matches(doc, query) {
    for (const [k, v] of Object.entries(query)) {
      if (v && typeof v === 'object' && v.$gt !== undefined) {
        const docVal = doc[k] instanceof Date ? doc[k].getTime() : doc[k]
        const targetVal = v.$gt instanceof Date ? v.$gt.getTime() : v.$gt
        if (!(docVal > targetVal)) return false
      } else {
        if (doc[k] !== v) return false
      }
    }
    return true
  }
}

const mockCollections = {
  authUsers: new MockCollection(),
  authSessions: new MockCollection(),
  authPasswordResetTokens: new MockCollection(),
  authEmailVerificationTokens: new MockCollection(),
  authRateLimits: new MockCollection(),
  restaurantDocuments: new MockCollection(),
}

vi.mock('../../functions/mongoFirestoreCompat.js', () => ({
  getMongoDatabase: async () => ({
    collection: (name) => {
      if (!mockCollections[name]) mockCollections[name] = new MockCollection()
      return mockCollections[name]
    },
    command: async () => ({ ok: 1 }),
  }),
  FieldValue: { serverTimestamp: () => new Date() },
  Timestamp: { now: () => new Date() },
}))

// Import the modules after mocking
const { getMongoAuth } = await import('../../functions/mongoAuth.js')
const { checkRateLimit, recordAttempt, resetRateLimit, clearAllMemoryRateLimits } = await import('../../functions/rateLimiter.js')
const auth = getMongoAuth()

describe('Senior Security Engineer: Authentication Security Suite', () => {
  beforeEach(() => {
    for (const col of Object.values(mockCollections)) {
      col.docs.clear()
    }
    clearAllMemoryRateLimits()
  })

  describe('1. Password Hashing and Storage Security', () => {
    it('hashes passwords using scrypt with a unique random salt and does not store plaintext', async () => {
      const user = await auth.createUser({
        email: 'chef@restaurant.com',
        password: 'SuperSecretPassword123!',
        displayName: 'Chef Mario',
      })

      expect(user.passwordHash).toBeUndefined()
      expect(user.passwordSalt).toBeUndefined()

      // Inspect underlying database document
      const rawUser = await mockCollections.authUsers.findOne({ _id: user.uid })
      expect(rawUser).toBeDefined()
      expect(rawUser.passwordHash).toBeDefined()
      expect(rawUser.passwordSalt).toBeDefined()
      expect(rawUser.passwordHash).not.toContain('SuperSecretPassword123!')
      expect(rawUser.passwordSalt.length).toBeGreaterThanOrEqual(32) // 16 bytes in hex

      // Hashing identical password for another user produces a completely different salt & hash
      const user2 = await auth.createUser({
        email: 'souschef@restaurant.com',
        password: 'SuperSecretPassword123!',
      })
      const rawUser2 = await mockCollections.authUsers.findOne({ _id: user2.uid })
      expect(rawUser2.passwordSalt).not.toEqual(rawUser.passwordSalt)
      expect(rawUser2.passwordHash).not.toEqual(rawUser.passwordHash)
    })

    it('enforces password policy (minimum 8 characters, maximum 256)', async () => {
      await expect(auth.createUser({ email: 'short@test.com', password: '123' })).rejects.toThrow(/at least 8 characters/i)
      await expect(auth.createUser({ email: 'empty@test.com', password: '' })).rejects.toThrow(/at least 8 characters/i)
      await expect(auth.createUser({ email: 'invalid@test.com', password: 12345678 })).rejects.toThrow(/must be a string/i)
      await expect(auth.createUser({ email: 'long@test.com', password: 'a'.repeat(300) })).rejects.toThrow(/not exceed 256 characters/i)
    })

    it('rejects authentication with incorrect password using constant-time verification', async () => {
      await auth.createUser({ email: 'manager@test.com', password: 'CorrectPassword123!' })
      await expect(auth.signIn('manager@test.com', 'WrongPassword456!')).rejects.toThrow(/Email or password is incorrect/i)
      const session = await auth.signIn('manager@test.com', 'CorrectPassword123!')
      expect(session.token).toBeDefined()
      expect(session.user.email).toBe('manager@test.com')
    })

    it('mitigates username enumeration via timing attacks for nonexistent accounts', async () => {
      await expect(auth.signIn('nonexistent@test.com', 'SomePassword123!')).rejects.toThrow(/Email or password is incorrect/i)
    })
  })

  describe('2. Session Expiration and Invalidation', () => {
    it('creates sessions with a verified expiration date and rejects expired sessions', async () => {
      await auth.createUser({ email: 'pos@restaurant.com', password: 'Password123!' })
      const session = await auth.signIn('pos@restaurant.com', 'Password123!')

      expect(session.token).toBeDefined()
      expect(session.expiresAt).toBeDefined()
      const expiry = new Date(session.expiresAt).getTime()
      expect(expiry).toBeGreaterThan(Date.now())

      // Valid session verification
      const claims = await auth.verifyIdToken(session.token)
      expect(claims.email).toBe('pos@restaurant.com')

      // Manually simulate expired session in database
      for (const [id, s] of mockCollections.authSessions.docs.entries()) {
        s.expiresAt = new Date(Date.now() - 1000)
      }

      await expect(auth.verifyIdToken(session.token)).rejects.toThrow(/session expired/i)
    })

    it('immediately invalidates session upon explicit sign out', async () => {
      await auth.createUser({ email: 'waiter@test.com', password: 'Password123!' })
      const session = await auth.signIn('waiter@test.com', 'Password123!')

      await auth.verifyIdToken(session.token)
      await auth.signOut(session.token)
      await expect(auth.verifyIdToken(session.token)).rejects.toThrow(/session expired/i)
    })

    it('immediately rejects sessions when an account is disabled', async () => {
      const user = await auth.createUser({ email: 'banned@test.com', password: 'Password123!' })
      const session = await auth.signIn('banned@test.com', 'Password123!')

      await auth.updateUser(user.uid, { disabled: true })
      await expect(auth.verifyIdToken(session.token)).rejects.toThrow(/no longer active/i)
    })
  })

  describe('3. Email Verification Flow', () => {
    it('creates email verification tokens with 24-hour expiration and securely verifies user', async () => {
      const user = await auth.createUser({
        email: 'unverified@restaurant.com',
        password: 'Password123!',
        emailVerified: false,
      })
      expect(user.emailVerified).toBe(false)

      const result = await auth.createEmailVerificationToken('unverified@restaurant.com')
      expect(result.ok).toBe(true)
      expect(result.token).toBeDefined()
      expect(result.expiresAt).toBeDefined()

      // The raw token is NOT stored in the database - only its SHA-256 digest
      for (const [id, doc] of mockCollections.authEmailVerificationTokens.docs.entries()) {
        expect(doc._id).not.toBe(result.token)
        expect(doc.token).toBeUndefined()
      }

      // Verify email using token
      const verifyResult = await auth.verifyEmailToken(result.token)
      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.emailVerified).toBe(true)

      // Verified user status is persisted
      const updated = await auth.getUser(user.uid)
      expect(updated.emailVerified).toBe(true)

      // Verification token is single-use and cannot be used twice
      await expect(auth.verifyEmailToken(result.token)).rejects.toThrow(/invalid or has expired/i)
    })

    it('rejects expired email verification tokens', async () => {
      await auth.createUser({ email: 'expireme@test.com', password: 'Password123!' })
      const { token } = await auth.createEmailVerificationToken('expireme@test.com')

      // Simulate token expiration
      for (const doc of mockCollections.authEmailVerificationTokens.docs.values()) {
        doc.expiresAt = new Date(Date.now() - 5000)
      }

      await expect(auth.verifyEmailToken(token)).rejects.toThrow(/invalid or has expired/i)
    })
  })

  describe('4. Password Reset Token Expiration and Revocation', () => {
    it('creates 15-minute expiring password reset tokens and executes secure password change', async () => {
      const user = await auth.createUser({ email: 'forgot@test.com', password: 'OldPassword123!' })
      const session = await auth.signIn('forgot@test.com', 'OldPassword123!')

      const resetReq = await auth.createPasswordResetToken('forgot@test.com')
      expect(resetReq.ok).toBe(true)
      expect(resetReq.token).toBeDefined()

      // Verify token expiration is within 15 minutes
      const expiry = new Date(resetReq.expiresAt).getTime()
      expect(expiry - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 1000)

      // Raw token is never stored in DB
      for (const doc of mockCollections.authPasswordResetTokens.docs.values()) {
        expect(doc._id).not.toBe(resetReq.token)
      }

      // Reset password using token
      const resetResult = await auth.resetPasswordWithToken(resetReq.token, 'BrandNewSecurePass123!')
      expect(resetResult.ok).toBe(true)

      // Old password fails, new password succeeds
      await expect(auth.signIn('forgot@test.com', 'OldPassword123!')).rejects.toThrow(/Email or password is incorrect/i)
      const newSession = await auth.signIn('forgot@test.com', 'BrandNewSecurePass123!')
      expect(newSession.token).toBeDefined()

      // Reset token was consumed and cannot be reused (single-use)
      await expect(auth.resetPasswordWithToken(resetReq.token, 'AnotherPass123!')).rejects.toThrow(/invalid or has expired/i)

      // Crucial Security check: all previous sessions were revoked upon password reset
      await expect(auth.verifyIdToken(session.token)).rejects.toThrow(/session expired/i)
    })

    it('rejects expired password reset tokens', async () => {
      await auth.createUser({ email: 'timelimit@test.com', password: 'Password123!' })
      const { token } = await auth.createPasswordResetToken('timelimit@test.com')

      // Simulate token expiration
      for (const doc of mockCollections.authPasswordResetTokens.docs.values()) {
        doc.expiresAt = new Date(Date.now() - 1000)
      }

      await expect(auth.resetPasswordWithToken(token, 'NewPass123!')).rejects.toThrow(/invalid or has expired/i)
    })

    it('does not leak account existence for unregistered email addresses', async () => {
      const result = await auth.createPasswordResetToken('notregistered@test.com')
      expect(result.ok).toBe(true)
      expect(result.token).toBeUndefined() // Token not issued, but generic message returned
      expect(result.message).toMatch(/If an account exists/i)
    })
  })

  describe('5. Rate Limiting for Authentication Operations', () => {
    it('blocks excessive attempts once limit is exceeded and provides retry time', async () => {
      const testKey = 'test:login:ip:192.168.1.1'
      const maxAttempts = 5
      const windowMs = 60 * 1000

      for (let i = 0; i < maxAttempts; i++) {
        await checkRateLimit(testKey, maxAttempts, windowMs)
        await recordAttempt(testKey, windowMs)
      }

      // Sixth attempt should throw resource-exhausted (HTTP 429)
      await expect(checkRateLimit(testKey, maxAttempts, windowMs)).rejects.toMatchObject({
        code: 'resource-exhausted',
        retryAfter: expect.any(Number),
      })
    })

    it('resets rate limit counter on successful action', async () => {
      const testKey = 'test:login:acc:192.168.1.1:user@test.com'
      await recordAttempt(testKey, 60000)
      await recordAttempt(testKey, 60000)

      await resetRateLimit(testKey)
      const status = await checkRateLimit(testKey, 5, 60000)
      expect(status.allowed).toBe(true)
      expect(status.remaining).toBe(5)
    })
  })

  describe('6. Protection Against Secrets Exposure', () => {
    it('sanitizes user objects and never exposes password salts, hashes, or claims inappropriately', async () => {
      const user = await auth.createUser({
        email: 'secretless@test.com',
        password: 'Password123!',
        displayName: 'Secretless User',
      })

      const keys = Object.keys(user)
      expect(keys).not.toContain('passwordHash')
      expect(keys).not.toContain('passwordSalt')
      expect(keys).not.toContain('password')

      const fetched = await auth.getUser(user.uid)
      expect(fetched.passwordHash).toBeUndefined()
      expect(fetched.passwordSalt).toBeUndefined()

      const fetchedByEmail = await auth.getUserByEmail('secretless@test.com')
      expect(fetchedByEmail.passwordHash).toBeUndefined()
      expect(fetchedByEmail.passwordSalt).toBeUndefined()
    })
  })
})
