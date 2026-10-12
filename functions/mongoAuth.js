import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { getMongoDatabase } from './mongoFirestoreCompat.js'

const scrypt = promisify(scryptCallback)
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

function authError(code, message) {
  return Object.assign(new Error(message), { code })
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex')
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

export function getMongoAuth() {
  async function collections() {
    const database = await getMongoDatabase()
    const users = database.collection('authUsers')
    const sessions = database.collection('authSessions')
    await Promise.all([
      users.createIndex({ emailNormalized: 1 }, { unique: true }),
      sessions.createIndex({ uid: 1 }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ])
    return { users, sessions }
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
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw authError('invalid-argument', 'Use a password with at least 8 characters.')
    const { users } = await collections()
    const salt = randomBytes(16).toString('hex')
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex')
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
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw authError('invalid-argument', 'Use a password with at least 8 characters.')
    const { users } = await collections()
    const salt = randomBytes(16).toString('hex')
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex')
    const result = await users.updateOne({ _id: String(uid) }, { $set: { passwordSalt: salt, passwordHash, disabled: false, updatedAt: new Date() } })
    if (!result.matchedCount) throw authError('auth/user-not-found', 'This account does not exist.')
    await revokeRefreshTokens(uid)
  }

  async function createSession(uid) {
    const { users, sessions } = await collections()
    const user = await users.findOne({ _id: String(uid) })
    if (!user || user.disabled) throw authError('permission-denied', 'This account is disabled. Contact the owner.')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS)
    await sessions.insertOne({ _id: tokenDigest(token), uid: user._id, createdAt: new Date(), expiresAt })
    return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user) }
  }

  async function signIn(email, password) {
    const { users } = await collections()
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const user = await users.findOne({ emailNormalized: normalizedEmail })
    if (!user || typeof password !== 'string' || !user.passwordSalt || !user.passwordHash) {
      throw authError('auth/invalid-credential', 'Email or password is incorrect.')
    }
    const candidate = await scrypt(password, user.passwordSalt, 64)
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
    return { uid: user._id, email: user.email, email_verified: user.emailVerified === true, ...user.customClaims }
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
    const result = await users.findOneAndUpdate({ _id: String(uid) }, { $set: changes }, { returnDocument: 'after' })
    const user = result?.value || result
    if (!user) throw authError('auth/user-not-found', 'This account does not exist.')
    return publicUser(user)
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
    const { users, sessions } = await collections()
    await Promise.all([users.deleteOne({ _id: String(uid) }), sessions.deleteMany({ uid: String(uid) })])
  }

  return { getUser, getUserByEmail, createUser, setPassword, createSession, signIn, verifyIdToken, setCustomUserClaims, updateUser, revokeRefreshTokens, signOut, deleteUser }
}
