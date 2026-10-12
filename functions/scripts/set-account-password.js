import { randomBytes } from 'node:crypto'
import { closeMongoConnection, getMongoDatabase, getFirestoreCompat } from '../mongoFirestoreCompat.js'
import { getMongoAuth } from '../mongoAuth.js'
import { loadLocalMongoConfig } from './load-local-mongo-config.js'

const [emailArgument, directPassword] = process.argv.slice(2)
const email = String(emailArgument || '').trim().toLowerCase()
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run set-password -- <accountEmail> [password]')
  process.exit(1)
}

function readPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const output = process.stdout
    if (!input.isTTY || !input.setRawMode) return reject(new Error('Run this command in an interactive terminal to enter the password safely.'))
    output.write('New account password (8+ characters): ')
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
const password = directPassword || process.env.ACCOUNT_PASSWORD || await readPassword()
if (password.length < 8) throw new Error('Use a password with at least 8 characters.')

const database = await getMongoDatabase()
const auth = getMongoAuth()
let account
try {
  account = await auth.getUserByEmail(email)
  await auth.setPassword(account.uid, password)
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error
  const allMembers = await database.collection('restaurantDocuments')
    .find({ collectionName: 'users' }, { projection: { id: 1, 'data.email': 1, 'data.displayName': 1, restaurantId: 1 } })
    .toArray()
  const member = allMembers.find((entry) => String(entry.data?.email || '').trim().toLowerCase() === email)
  const uid = member?.id || randomBytes(18).toString('base64url')
  account = await auth.createUser({ uid, email, password, displayName: member?.data?.displayName || '' })
  const membership = await getFirestoreCompat().doc(`accountMemberships/${uid}`).get()
  if (membership.exists) await auth.setCustomUserClaims(uid, { restaurantId: membership.get('restaurantId'), role: membership.get('role') })
}

await auth.revokeRefreshTokens(account.uid)
await closeMongoConnection()
console.log(`Password updated for ${email}. Existing sessions were signed out.`)
