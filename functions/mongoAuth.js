import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { getMongoDatabase } from './mongoFirestoreCompat.js'

const scrypt = promisify(scryptCallback)

// Security defaults
const DEFAULT_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000 // 24 hours (OWASP recommended for POS/management)
const PASSWORD_RESET_LIFETIME_MS = 15 * 60 * 1000 // 15 minutes
const EMAIL_VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1000 // 24 hours

// Cryptographic scrypt parameters (OWASP recommended memory-hard configuration)
const SCRYPT_KEYLEN = 64
const SCRYPT_OPTIONS = {
  N: 16384, // CPU/memory cost
  r: 8, // Block size
  p: 1, // Parallelization
  maxmem: 64 * 1024 * 1024,
}

// Constant-time mitigation dummy values (prevents username enumeration via timing attacks)
const DUMMY_SALT = '0123456789abcdef0123456789abcdef'
const DUMMY_PASSWORD = 'Dummy_Timing_Defense_Password_99'

function getSessionLifetime() {
  const envMs = Number(process.env.SESSION_LIFETIME_MS)
  const envHours = Number(process.env.SESSION_LIFETIME_HOURS)
  if (Number.isFinite(envMs) && envMs >= 15 * 60 * 1000 && envMs <= 7 * 24 * 60 * 60 * 1000) {
    return envMs
  }
  if (Number.isFinite(envHours) && envHours >= 1 && envHours <= 168) {
    return envHours * 60 * 60 * 1000
  }
  return DEFAULT_SESSION_LIFETIME_MS
}

function authError(code, message) {
  return Object.assign(new Error(message), { code })
}

function tokenDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

async function hashPassword(password, salt) {
  return (await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS)).toString('hex')
}

function hasControlCharacters(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) return true
  }
  return false
}

function validatePasswordPolicy(password) {
  if (typeof password !== 'string') throw authError('invalid-argument', 'Password must be a string.')
  if (password.length < 8) throw authError('invalid-argument', 'Use a password with at least 8 characters.')
  if (password.length > 256) throw authError('invalid-argument', 'Password must not exceed 256 characters.')
  if (hasControlCharacters(password)) {
    throw authError('invalid-argument', 'Password contains invalid characters.')
  }
}

function publicUser(user) {
  return {
    uid: user._id,
    email: user.email,
    displayName: user.displayName || '',
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    customClaims: user.customClaims || {},
  }
}

let indexesEnsured = false
async function ensureAuthIndexes(database) {
  if (indexesEnsured) return
  try {
    const users = database.collection('authUsers')
    const sessions = database.collection('authSessions')
    const resetTokens = database.collection('authPasswordResetTokens')
    const verifyTokens = database.collection('authEmailVerificationTokens')
    const rateLimits = database.collection('authRateLimits')

    await Promise.all([
      users.createIndex({ emailNormalized: 1 }, { unique: true }).catch(() => {}),
      sessions.createIndex({ uid: 1 }).catch(() => {}),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
      resetTokens.createIndex({ uid: 1 }).catch(() => {}),
      resetTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
      verifyTokens.createIndex({ emailNormalized: 1 }).catch(() => {}),
      verifyTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
      rateLimits.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}),
    ])
    indexesEnsured = true
  } catch {
    // Index creation error ignored if user lacks administrative index privileges
  }
}

export function getMongoAuth() {
  async function collections() {
    const database = await getMongoDatabase()
    await ensureAuthIndexes(database)
    return {
      users: database.collection('authUsers'),
      sessions: database.collection('authSessions'),
      passwordResetTokens: database.collection('authPasswordResetTokens'),
      emailVerificationTokens: database.collection('authEmailVerificationTokens'),
      rateLimits: database.collection('authRateLimits'),
    }
  }

  async function getUser(uid) {
    const { users } = await collections()
    const user = await users.findOne({ _id: String(uid) })
    if (!user) throw authError('auth/user-not-found', 'This account does not exist.')
    return publicUser(user)
  }

  async function getUserByEmail(email) {
    const { users } = await collections()
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const user = await users.findOne({ emailNormalized: normalizedEmail })
    if (!user) throw authError('auth/user-not-found', 'This account does not exist.')
    return publicUser(user)
  }

  async function createUser({ uid, email, password, displayName = '', emailVerified = false }) {
    const normalizedEmail = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw authError('invalid-argument', 'Enter a valid email address.')
    validatePasswordPolicy(password)
    const { users } = await collections()
    const salt = randomBytes(16).toString('hex')
    const passwordHash = await hashPassword(password, salt)
    const user = {
      _id: uid || randomBytes(18).toString('base64url'),
      email: normalizedEmail,
      emailNormalized: normalizedEmail,
      displayName: String(displayName || '').trim().slice(0, 100),
      passwordSalt: salt,
      passwordHash,
      emailVerified: emailVerified === true,
      disabled: false,
      customClaims: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    try {
      await users.insertOne(user)
    } catch (error) {
      if (error.code === 11000) throw authError('auth/email-already-in-use', 'An account already exists for this email.')
      throw error
    }
    return publicUser(user)
  }

  async function setPassword(uid, password) {
    validatePasswordPolicy(password)
    const { users } = await collections()
    const salt = randomBytes(16).toString('hex')
    const passwordHash = await hashPassword(password, salt)
    const result = await users.updateOne({ _id: String(uid) }, { $set: { passwordSalt: salt, passwordHash, disabled: false, updatedAt: new Date() } })
    if (!result.matchedCount) throw authError('auth/user-not-found', 'This account does not exist.')
    await revokeRefreshTokens(uid)
  }

  async function createSession(uid) {
    const { users, sessions } = await collections()
    const user = await users.findOne({ _id: String(uid) })
    if (!user || user.disabled) throw authError('permission-denied', 'This account is disabled. Contact the owner.')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + getSessionLifetime())
    await sessions.insertOne({ _id: tokenDigest(token), uid: user._id, createdAt: new Date(), expiresAt })
    return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) }
  }

  async function signIn(email, password) {
    const { users } = await collections()
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const user = await users.findOne({ emailNormalized: normalizedEmail })

    // Timing-attack mitigation: compute dummy scrypt when user is missing or password invalid
    if (!user || typeof password !== 'string' || !user.passwordSalt || !user.passwordHash) {
      await hashPassword(typeof password === 'string' ? password : DUMMY_PASSWORD, DUMMY_SALT).catch(() => {})
      throw authError('auth/invalid-credential', 'Email or password is incorrect.')
    }

    const candidate = await scrypt(password, user.passwordSalt, SCRYPT_KEYLEN, SCRYPT_OPTIONS)
    const expected = Buffer.from(user.passwordHash, 'hex')
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw authError('auth/invalid-credential', 'Email or password is incorrect.')
    }
    if (user.disabled) throw authError('permission-denied', 'This account is disabled. Contact the owner.')
    return createSession(user._id)
  }

  async function verifyIdToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw authError('unauthenticated', 'Your session is invalid. Sign in again.')
    const { users, sessions } = await collections()
    const session = await sessions.findOne({ _id: tokenDigest(token), expiresAt: { $gt: new Date() } })
    if (!session) throw authError('unauthenticated', 'Your session expired. Sign in again.')
    const user = await users.findOne({ _id: session.uid })
    if (!user || user.disabled) throw authError('unauthenticated', 'Your session is no longer active. Sign in again.')
    return {
      uid: user._id,
      email: user.email,
      email_verified: user.emailVerified === true,
      expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : new Date(session.expiresAt).toISOString(),
      ...user.customClaims,
    }
  }

  async function getSessionExpiry(token) {
    if (!token || typeof token !== 'string') return null
    const { sessions } = await collections()
    const session = await sessions.findOne({ _id: tokenDigest(token) })
    if (!session?.expiresAt) return null
    return session.expiresAt instanceof Date ? session.expiresAt.toISOString() : new Date(session.expiresAt).toISOString()
  }

  async function setCustomUserClaims(uid, customClaims) {
    const { users } = await collections()
    await users.updateOne({ _id: String(uid) }, { $set: { customClaims: customClaims || {}, updatedAt: new Date() } })
  }

  async function updateUser(uid, updates) {
    const { users } = await collections()
    const changes = { updatedAt: new Date() }
    if (typeof updates.disabled === 'boolean') changes.disabled = updates.disabled
    if (typeof updates.displayName === 'string') changes.displayName = updates.displayName.slice(0, 100)
    if (typeof updates.emailVerified === 'boolean') changes.emailVerified = updates.emailVerified
    const result = await users.findOneAndUpdate({ _id: String(uid) }, { $set: changes }, { returnDocument: 'after' })
    const user = result?.value || result
    if (!user) throw authError('auth/user-not-found', 'This account does not exist.')
    return publicUser(user)
  }

  async function setEmailVerified(uid, verified = true) {
    const { users } = await collections()
    const result = await users.updateOne({ _id: String(uid) }, { $set: { emailVerified: Boolean(verified), updatedAt: new Date() } })
    if (!result.matchedCount) throw authError('auth/user-not-found', 'This account does not exist.')
  }

  async function revokeRefreshTokens(uid) {
    const { sessions } = await collections()
    await sessions.deleteMany({ uid: String(uid) })
  }

  async function signOut(token) {
    if (!token) return
    const { sessions } = await collections()
    await sessions.deleteOne({ _id: tokenDigest(token) })
  }

  async function deleteUser(uid) {
    const { users, sessions, passwordResetTokens, emailVerificationTokens } = await collections()
    await Promise.all([
      users.deleteOne({ _id: String(uid) }),
      sessions.deleteMany({ uid: String(uid) }),
      passwordResetTokens.deleteMany({ uid: String(uid) }),
      emailVerificationTokens.deleteMany({ uid: String(uid) }),
    ])
  }

  // ─── PASSWORD RESET TOKEN LIFECYCLE ──────────────────────────────────────────

  async function createPasswordResetToken(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw authError('invalid-argument', 'Enter a valid email address.')
    }
    const { users, passwordResetTokens } = await collections()
    const user = await users.findOne({ emailNormalized: normalizedEmail })

    // Dummy computation to mitigate email enumeration via timing side-channels
    if (!user || user.disabled) {
      await hashPassword(DUMMY_PASSWORD, DUMMY_SALT).catch(() => {})
      return {
        ok: true,
        message: 'If an account exists with this email address, password reset instructions have been sent.',
      }
    }

    // Invalidate any previously issued unused reset tokens for this user
    await passwordResetTokens.deleteMany({ uid: user._id })

    // Generate cryptographically secure random token (256 bits)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_LIFETIME_MS)

    // Store only the SHA-256 hash in database; raw token is never persisted
    await passwordResetTokens.insertOne({
      _id: tokenDigest(token),
      uid: user._id,
      emailNormalized: normalizedEmail,
      createdAt: new Date(),
      expiresAt,
    })

    return {
      ok: true,
      message: 'If an account exists with this email address, password reset instructions have been sent.',
      token, // Returned for mailer dispatch or dev logging
      expiresAt: expiresAt.toISOString(),
    }
  }

  async function resetPasswordWithToken(token, newPassword) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw authError('auth/invalid-credential', 'Password reset token is invalid or has expired.')
    }
    validatePasswordPolicy(newPassword)

    const { users, passwordResetTokens, sessions } = await collections()
    const tokenDoc = await passwordResetTokens.findOne({
      _id: tokenDigest(token),
      expiresAt: { $gt: new Date() },
    })

    if (!tokenDoc) {
      throw authError('auth/invalid-credential', 'Password reset token is invalid or has expired.')
    }

    // Immediately consume the token to prevent reuse (single-use token)
    await passwordResetTokens.deleteOne({ _id: tokenDoc._id })

    // Update password with new salt and scrypt hash
    const salt = randomBytes(16).toString('hex')
    const passwordHash = await hashPassword(newPassword, salt)
    const result = await users.updateOne(
      { _id: tokenDoc.uid },
      { $set: { passwordSalt: salt, passwordHash, disabled: false, updatedAt: new Date() } }
    )

    if (!result.matchedCount) {
      throw authError('auth/user-not-found', 'This account does not exist.')
    }

    // Revoke all existing sessions for this user on password reset
    await sessions.deleteMany({ uid: String(tokenDoc.uid) })

    return { ok: true, message: 'Your password has been reset successfully. Please sign in with your new password.' }
  }

  // ─── EMAIL VERIFICATION TOKEN LIFECYCLE ──────────────────────────────────────

  async function createEmailVerificationToken(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw authError('invalid-argument', 'Enter a valid email address.')
    }
    const { users, emailVerificationTokens } = await collections()
    const user = await users.findOne({ emailNormalized: normalizedEmail })

    if (!user || user.disabled) {
      await hashPassword(DUMMY_PASSWORD, DUMMY_SALT).catch(() => {})
      return {
        ok: true,
        message: 'If an account exists with this email address, a verification link has been sent.',
      }
    }

    if (user.emailVerified) {
      return {
        ok: true,
        message: 'This email address is already verified.',
        alreadyVerified: true,
      }
    }

    // Invalidate existing verification tokens for this email
    await emailVerificationTokens.deleteMany({ emailNormalized: normalizedEmail })

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_LIFETIME_MS)

    // Store only the SHA-256 hash in database
    await emailVerificationTokens.insertOne({
      _id: tokenDigest(token),
      uid: user._id,
      emailNormalized: normalizedEmail,
      createdAt: new Date(),
      expiresAt,
    })

    return {
      ok: true,
      message: 'If an account exists with this email address, a verification link has been sent.',
      token, // Returned for mailer dispatch or dev logging
      expiresAt: expiresAt.toISOString(),
    }
  }

  async function verifyEmailToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw authError('invalid-argument', 'Email verification token is invalid or has expired.')
    }
    const { users, emailVerificationTokens } = await collections()
    const tokenDoc = await emailVerificationTokens.findOne({
      _id: tokenDigest(token),
      expiresAt: { $gt: new Date() },
    })

    if (!tokenDoc) {
      throw authError('invalid-argument', 'Email verification token is invalid or has expired.')
    }

    // Immediately consume the token to prevent reuse (single-use)
    await emailVerificationTokens.deleteOne({ _id: tokenDoc._id })

    const result = await users.findOneAndUpdate(
      { _id: tokenDoc.uid },
      { $set: { emailVerified: true, updatedAt: new Date() } },
      { returnDocument: 'after' }
    )
    const updatedUser = result?.value || result
    if (!updatedUser) {
      throw authError('auth/user-not-found', 'This account does not exist.')
    }

    return { ok: true, emailVerified: true, user: publicUser(updatedUser) }
  }

  return {
    getUser,
    getUserByEmail,
    createUser,
    setPassword,
    createSession,
    signIn,
    verifyIdToken,
    getSessionExpiry,
    setCustomUserClaims,
    updateUser,
    setEmailVerified,
    revokeRefreshTokens,
    signOut,
    deleteUser,
    createPasswordResetToken,
    resetPasswordWithToken,
    createEmailVerificationToken,
    verifyEmailToken,
  }
}
