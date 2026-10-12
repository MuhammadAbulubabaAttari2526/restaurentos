import { readFileSync } from 'node:fs'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { MongoClient, ServerApiVersion } from 'mongodb'
import { loadLocalMongoConfig } from './load-local-mongo-config.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const resume = args.includes('--resume')
const projectIndex = args.indexOf('--project')
const projectFromArgs = projectIndex >= 0 ? args[projectIndex + 1] : ''
if (projectIndex >= 0 && (!projectFromArgs || projectFromArgs.startsWith('--'))) {
  throw new Error('Pass a Firebase project ID after --project.')
}

function projectFromConfig() {
  if (projectFromArgs || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID) {
    return projectFromArgs || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID
  }
  try {
    const firebaseConfig = JSON.parse(readFileSync(new URL('../../.firebaserc', import.meta.url), 'utf8'))
    return firebaseConfig.projects?.default || ''
  } catch {
    return ''
  }
}

function normalizeValue(value) {
  if (value instanceof Date) return value
  if (value && typeof value.toDate === 'function') return value.toDate()
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === 'object') {
    if (typeof value.toUint8Array === 'function') return Buffer.from(value.toUint8Array())
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]))
  }
  return value
}

function toMongoDocument(snapshot) {
  const path = snapshot.ref.path
  const segments = path.split('/')
  const collectionPath = segments.slice(0, -1).join('/')
  const collectionSegments = collectionPath.split('/')
  return {
    _id: path,
    path,
    id: snapshot.id,
    collectionPath,
    collectionName: collectionSegments.at(-1),
    ...(collectionSegments[0] === 'restaurants' && collectionSegments.length >= 3
      ? { restaurantId: collectionSegments[1] }
      : {}),
    data: normalizeValue(snapshot.data()),
  }
}

async function* visitCollection(collection) {
  const references = await collection.listDocuments()
  for (const reference of references) {
    const snapshot = await reference.get()
    if (snapshot.exists) yield snapshot
    // Enumerate child collections even when the parent document is an orphan.
    for (const child of await reference.listCollections()) yield* visitCollection(child)
  }
}

async function* visitDatabase(firestore) {
  for (const collection of await firestore.listCollections()) yield* visitCollection(collection)
}

loadLocalMongoConfig()
const projectId = projectFromConfig()
if (!projectId) throw new Error('Firebase project ID is missing. Pass --project <project-id>.')

initializeApp({ credential: applicationDefault(), projectId })
const firestore = getFirestore()
const client = new MongoClient(process.env.MONGODB_URI, {
  appName: 'RestaurantOS-Firestore-Migration',
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  serverSelectionTimeoutMS: 10000,
})

const storage = 'restaurantDocuments'
const migrationId = 'firestore-to-mongo-v1'
const databaseName = process.env.MONGODB_DB || 'restaurantos'

try {
  await client.connect()
  const database = client.db(databaseName)
  const documents = database.collection(storage)
  const migrations = database.collection('migrationRuns')

  if (!apply) {
    let sourceCount = 0
    for await (const _snapshot of visitDatabase(firestore)) sourceCount += 1
    const targetCount = await documents.countDocuments({})
    console.log(`Dry run complete for Firebase project ${projectId}.`)
    console.log(`Firestore documents found: ${sourceCount}`)
    console.log(`MongoDB documents already present in ${storage}: ${targetCount}`)
    console.log('No data was written. Pause app writes before rerunning with --apply.')
  } else {
    const existingRun = await migrations.findOne({ _id: migrationId })
    const targetCount = await documents.countDocuments({})
    if (existingRun?.status === 'complete') throw new Error('This Firestore import is already marked complete.')
    if (existingRun && (existingRun.projectId !== projectId || existingRun.databaseName !== databaseName)) {
      throw new Error('The interrupted import belongs to a different Firebase project or MongoDB database.')
    }
    if (existingRun?.status === 'running' && !resume) {
      throw new Error('A prior import was interrupted. Verify app writes are paused, then pass --resume to continue.')
    }
    if (!existingRun && targetCount > 0) {
      throw new Error(`The target ${storage} collection is not empty. No records were overwritten.`)
    }

    await migrations.updateOne(
      { _id: migrationId },
      { $set: { status: 'running', projectId, databaseName, startedAt: existingRun?.startedAt || new Date(), updatedAt: new Date() } },
      { upsert: true },
    )

    let count = 0
    let batch = []
    const flush = async () => {
      if (!batch.length) return
      await documents.bulkWrite(batch, { ordered: false })
      count += batch.length
      batch = []
      await migrations.updateOne({ _id: migrationId }, { $set: { importedCount: count, updatedAt: new Date() } })
    }

    for await (const snapshot of visitDatabase(firestore)) {
      const document = toMongoDocument(snapshot)
      batch.push({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })
      if (batch.length >= 300) await flush()
    }
    await flush()
    await documents.createIndex({ collectionPath: 1 })
    await documents.createIndex({ restaurantId: 1, collectionName: 1, 'data.createdAt': -1 })
    await documents.createIndex({ collectionPath: 1, 'data.customerId': 1, 'data.status': 1, 'data.createdAt': -1 })
    await migrations.updateOne(
      { _id: migrationId },
      { $set: { status: 'complete', importedCount: count, completedAt: new Date(), updatedAt: new Date() } },
    )
    console.log(`Imported ${count} Firestore documents from ${projectId} into MongoDB database ${databaseName}.`)
    console.log('Firestore source data was left unchanged. Review the counts before deploying the MongoDB-backed app.')
  }
} finally {
  await client.close()
  await firestore.terminate()
}
