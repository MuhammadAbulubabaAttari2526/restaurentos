import readline from 'node:readline'
import { closeMongoConnection, FieldValue, getFirestoreCompat, getMongoDatabase } from '../mongoFirestoreCompat.js'
import { getMongoAuth } from '../mongoAuth.js'
import { loadLocalMongoConfig } from './load-local-mongo-config.js'

const [restaurantId, restaurantName, ownerEmail, directPassword] = process.argv.slice(2)
if (!restaurantId || !restaurantName || !ownerEmail) {
  console.error('Usage: npm run provision-owner -- <restaurantId> <restaurantName> <ownerEmail> [password]')
  process.exit(1)
}
if (!/^[A-Za-z0-9_-]{1,80}$/.test(restaurantId)) throw new Error('Restaurant ID may contain letters, numbers, underscores, and hyphens only.')

function readPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const output = process.stdout
    if (!input.isTTY || !input.setRawMode) return reject(new Error('Run this command in an interactive terminal to enter the owner password safely.'))
    output.write('New owner password (8+ characters): ')
    input.setRawMode(true)
    input.resume()
    let password = ''
    const finish = (error) => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      if (error) reject(error)
      else resolve(password)
    }
    const onData = (chunk) => {
      const key = chunk.toString('utf8')
      if (key === '\u0003') return finish(new Error('Password entry cancelled.'))
      if (key === '\r' || key === '\n') return finish()
      if (key === '\u007f' || key === '\b') password = password.slice(0, -1)
      else if (key >= ' ') password += key
    }
    input.on('data', onData)
  })
}

loadLocalMongoConfig()
const password = directPassword || process.env.OWNER_PASSWORD || await readPassword()
if (password.length < 8) throw new Error('Use a password with at least 8 characters.')

const normalizedEmail = ownerEmail.trim().toLowerCase()
const mongo = await getMongoDatabase()
const sourceMembers = await mongo.collection('restaurantDocuments')
  .find({ collectionPath: `restaurants/${restaurantId}/users` })
  .toArray()
const matchingMember = sourceMembers.find((entry) => String(entry.data?.email || '').trim().toLowerCase() === normalizedEmail)
const auth = getMongoAuth()
let account
try {
  account = await auth.getUserByEmail(normalizedEmail)
  await auth.setPassword(account.uid, password)
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error
  account = await auth.createUser({
    uid: matchingMember?.id,
    email: normalizedEmail,
    password,
    displayName: matchingMember?.data?.displayName || restaurantName.trim(),
    emailVerified: true,
  })
}

const db = getFirestoreCompat()
const restaurantRef = db.doc(`restaurants/${restaurantId}`)
const memberRef = db.doc(`restaurants/${restaurantId}/users/${account.uid}`)
const settingsRef = db.doc(`restaurants/${restaurantId}/settings/profile`)
const accountRef = db.doc(`accountMemberships/${account.uid}`)
const auditRef = db.collection(`restaurants/${restaurantId}/auditLogs`).doc()
const now = FieldValue.serverTimestamp()
await db.runTransaction(async (transaction) => {
  const [restaurant, member] = await transaction.getAll(restaurantRef, memberRef)
  if (restaurant.exists && restaurant.get('name') !== restaurantName.trim()) {
    throw new Error('This restaurant ID already belongs to another restaurant.')
  }
  if (!restaurant.exists) transaction.create(restaurantRef, { restaurantId, name: restaurantName.trim(), createdAt: now, updatedAt: now })
  transaction.set(memberRef, {
    email: account.email,
    displayName: account.displayName || restaurantName.trim(),
    role: 'owner',
    active: true,
    permissions: [],
    createdAt: member.exists ? member.get('createdAt') || now : now,
    createdBy: member.exists ? member.get('createdBy') || 'trusted-provisioning' : 'trusted-provisioning',
    updatedAt: now,
  })
  transaction.set(accountRef, { restaurantId, role: 'owner', active: true, updatedAt: now })
  const settings = await transaction.get(settingsRef)
  if (!settings.exists) transaction.create(settingsRef, { name: restaurantName.trim(), currency: 'PKR', taxRate: 0, paymentMethods: ['cash', 'card', 'digital'], createdAt: now, updatedAt: now })
  transaction.create(auditRef, { action: 'restaurant.owner_provisioned', entityId: account.uid, actorId: 'trusted-provisioning', createdAt: now })
})
await auth.setCustomUserClaims(account.uid, { ...(account.customClaims || {}), restaurantId, role: 'owner' })
await auth.revokeRefreshTokens(account.uid)
await closeMongoConnection()
console.log(`Provisioned ${account.email} as owner of ${restaurantId}. Sign in with the new password.`)
