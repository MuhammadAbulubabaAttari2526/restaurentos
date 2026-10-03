import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

const [restaurantId, restaurantName, ownerEmail] = process.argv.slice(2)
if (!restaurantId || !restaurantName || !ownerEmail) {
  console.error('Usage: npm run provision-owner -- <restaurantId> <restaurantName> <verifiedOwnerEmail>')
  process.exit(1)
}
if (!/^[A-Za-z0-9_-]{1,80}$/.test(restaurantId)) throw new Error('Restaurant ID may contain letters, numbers, underscores, and hyphens only.')

initializeApp({ credential: applicationDefault(), projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID })
const auth = getAuth()
const db = getFirestore()
const owner = await auth.getUserByEmail(ownerEmail)
if (!owner.emailVerified) throw new Error('Verify the owner email in Firebase Authentication before provisioning.')
if (owner.customClaims?.restaurantId) throw new Error('This user is already assigned to a restaurant.')

const restaurantRef = db.doc(`restaurants/${restaurantId}`)
const memberRef = db.doc(`restaurants/${restaurantId}/users/${owner.uid}`)
const settingsRef = db.doc(`restaurants/${restaurantId}/settings/profile`)
const now = FieldValue.serverTimestamp()
await db.runTransaction(async (transaction) => {
  const restaurant = await transaction.get(restaurantRef)
  if (restaurant.exists) throw new Error('This restaurant ID already exists. Choose a new ID.')
  transaction.create(restaurantRef, { restaurantId, name: restaurantName.trim(), createdAt: now, updatedAt: now })
  transaction.create(memberRef, { email: owner.email, displayName: owner.displayName || restaurantName.trim(), role: 'owner', active: true, permissions: [], createdAt: now, createdBy: 'trusted-provisioning' })
  transaction.create(settingsRef, { name: restaurantName.trim(), currency: 'PKR', taxRate: 0, paymentMethods: ['cash', 'card', 'digital'], createdAt: now, updatedAt: now })
  transaction.create(db.collection(`restaurants/${restaurantId}/auditLogs`).doc(), { action: 'restaurant.owner_provisioned', entityId: owner.uid, actorId: 'trusted-provisioning', createdAt: now })
})

try {
  await auth.setCustomUserClaims(owner.uid, { restaurantId, role: 'owner' })
  await auth.revokeRefreshTokens(owner.uid)
} catch (error) {
  const batch = db.batch()
  batch.delete(restaurantRef)
  batch.delete(memberRef)
  batch.delete(settingsRef)
  await batch.commit()
  throw error
}

console.log(`Provisioned ${owner.email} as owner of ${restaurantId}. Sign out and back in to refresh claims.`)
