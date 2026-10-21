import { randomBytes } from 'node:crypto'
import { MongoClient, ServerApiVersion } from 'mongodb'

const storageCollection = 'restaurantDocuments'
let clientPromise
let databasePromise

class FieldTransform {
  constructor(operation, value) {
    this.operation = operation
    this.value = value
  }
}

export const FieldValue = Object.freeze({
  serverTimestamp: () => new FieldTransform('serverTimestamp'),
  delete: () => new FieldTransform('delete'),
  increment: (value) => new FieldTransform('increment', value),
})

export const Timestamp = Object.freeze({
  fromDate: (value) => new Date(value),
  now: () => new Date(),
})

function failConfig(message) {
  const error = new Error(message)
  error.code = 'failed-precondition'
  return error
}

async function getDatabase() {
  const uri = process.env.MONGODB_URI
  const name = process.env.MONGODB_DB || 'restaurantos'
  if (!uri) throw failConfig('MongoDB is not configured. Set the server-side MONGODB_URI secret.')

  if (!clientPromise) {
    const client = new MongoClient(uri, {
      appName: 'RestaurantOS',
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      maxPoolSize: 20,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10000,
    })
    clientPromise = client.connect().then(() => client).catch((error) => {
      clientPromise = undefined
      throw error
    })
  }

  if (!databasePromise) {
    databasePromise = clientPromise.then(async (client) => {
      const database = client.db(name)
      const documents = database.collection(storageCollection)
      await Promise.all([
        documents.createIndex({ collectionPath: 1 }),
        documents.createIndex({ restaurantId: 1, collectionName: 1, 'data.createdAt': -1 }),
        documents.createIndex({ collectionPath: 1, 'data.customerId': 1, 'data.status': 1, 'data.createdAt': -1 }),
      ])
      return database
    }).catch((error) => {
      databasePromise = undefined
      throw error
    })
  }

  return databasePromise
}

export async function getMongoDatabase() {
  return getDatabase()
}

function validatePath(path, expectedSegments) {
  if (typeof path !== 'string') throw new TypeError('A MongoDB document path must be a string.')
  const parts = path.split('/')
  if (parts.some((part) => !part) || (expectedSegments && parts.length !== expectedSegments)) {
    throw new TypeError('The MongoDB document path is invalid.')
  }
  return parts
}

function scopeForPath(path) {
  const parts = path.split('/')
  const collectionPath = parts.slice(0, -1).join('/')
  const collectionParts = collectionPath.split('/')
  return {
    path,
    id: parts.at(-1),
    collectionPath,
    collectionName: collectionParts.at(-1),
    restaurantId: collectionParts[0] === 'restaurants' && collectionParts.length >= 3 ? collectionParts[1] : null,
  }
}

function cloneValue(value) {
  if (value instanceof FieldTransform) {
    if (value.operation === 'serverTimestamp') return new Date()
    return value
  }
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(cloneValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]))
  }
  return value
}

function buildUpdate(fields) {
  const $set = {}
  const $inc = {}
  const $unset = {}
  for (const [field, rawValue] of Object.entries(fields || {})) {
    const key = `data.${field}`
    if (rawValue instanceof FieldTransform && rawValue.operation === 'delete') {
      $unset[key] = ''
    } else if (rawValue instanceof FieldTransform && rawValue.operation === 'increment') {
      if (!Number.isFinite(rawValue.value)) throw new TypeError('MongoDB increment must use a finite number.')
      $inc[key] = rawValue.value
    } else {
      $set[key] = cloneValue(rawValue)
    }
  }
  const update = {}
  if (Object.keys($set).length) update.$set = $set
  if (Object.keys($inc).length) update.$inc = $inc
  if (Object.keys($unset).length) update.$unset = $unset
  return update
}

function snapshotFor(reference, document) {
  return new DocumentSnapshot(reference, document)
}

class DocumentSnapshot {
  constructor(reference, document) {
    this.ref = reference
    this.id = reference.id
    this.exists = Boolean(document)
    this.document = document || null
  }

  data() {
    return this.document ? cloneValue(this.document.data) : undefined
  }

  get(field) {
    return field.split('.').reduce((value, key) => value?.[key], this.document?.data)
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs
    this.size = docs.length
    this.empty = docs.length === 0
  }

  forEach(callback) {
    this.docs.forEach(callback)
  }
}

class DocumentReference {
  constructor(path) {
    const parts = validatePath(path)
    if (parts.length % 2 !== 0) throw new TypeError('A MongoDB document path must have an even number of segments.')
    Object.assign(this, scopeForPath(path))
  }

  collection(name) {
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new TypeError('The collection name is invalid.')
    return new CollectionReference(`${this.path}/${name}`)
  }

  async get() {
    const database = await getDatabase()
    const document = await database.collection(storageCollection).findOne({ _id: this.path })
    return snapshotFor(this, document)
  }

  async set(data, options = {}) {
    const database = await getDatabase()
    const collection = database.collection(storageCollection)
    if (options.merge) {
      const update = buildUpdate(data)
      if (!Object.keys(update).length) return
      await collection.updateOne({ _id: this.path }, { ...update, $setOnInsert: this.metadata() }, { upsert: true })
      return
    }
    await collection.replaceOne({ _id: this.path }, { ...this.metadata(), data: cloneValue(data) }, { upsert: true })
  }

  async update(data) {
    const database = await getDatabase()
    const result = await database.collection(storageCollection).updateOne({ _id: this.path }, buildUpdate(data))
    if (!result.matchedCount) throw Object.assign(new Error(`Document ${this.path} does not exist.`), { code: 'not-found' })
  }

  async delete() {
    const database = await getDatabase()
    await database.collection(storageCollection).deleteOne({ _id: this.path })
  }

  metadata() {
    const { path, id, collectionPath, collectionName, restaurantId } = this
    return { _id: path, path, id, collectionPath, collectionName, ...(restaurantId ? { restaurantId } : {}) }
  }
}

class QueryReference {
  constructor(collectionPath, filters = [], order = null, max = null) {
    const parts = validatePath(collectionPath)
    if (parts.length % 2 !== 1) throw new TypeError('A MongoDB collection path must have an odd number of segments.')
    this.collectionPath = collectionPath
    this.filters = filters
    this.order = order
    this.max = max
  }

  where(field, operator, value) {
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field)) throw new TypeError('The query field is invalid.')
    if (!['==', '<', '<=', '>', '>=', 'in'].includes(operator)) throw new TypeError(`The query operator ${operator} is not supported.`)
    if (operator === 'in') {
      if (!Array.isArray(value) || value.length > 30) throw new TypeError('The in query must contain at most 30 values.')
      for (const item of value) {
        if (item && typeof item === 'object' && !(item instanceof Date)) {
          throw new TypeError('The in query values must be primitives or Dates.')
        }
      }
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (Object.keys(value).some((k) => k.startsWith('$'))) {
        throw new TypeError('Query values cannot contain MongoDB operator keys.')
      }
    }
    return new QueryReference(this.collectionPath, [...this.filters, [field, operator, cloneValue(value)]], this.order, this.max)
  }

  orderBy(field, direction = 'asc') {
    if (!['asc', 'desc'].includes(direction)) throw new TypeError('The query sort direction is invalid.')
    return new QueryReference(this.collectionPath, this.filters, [field, direction], this.max)
  }

  limit(max) {
    if (!Number.isInteger(max) || max < 1 || max > 10000) throw new TypeError('The query limit is invalid.')
    return new QueryReference(this.collectionPath, this.filters, this.order, max)
  }

  async get(session = null) {
    const database = await getDatabase()
    let cursor = database.collection(storageCollection)
      .find(this.mongoFilter(), { session })
    if (this.order) cursor = cursor.sort({ [`data.${this.order[0]}`]: this.order[1] === 'desc' ? -1 : 1 })
    if (this.max) cursor = cursor.limit(this.max)
    const documents = await cursor.toArray()
    return new QuerySnapshot(documents.map((document) => snapshotFor(new DocumentReference(document.path), document)))
  }

  mongoFilter() {
    const filter = { collectionPath: this.collectionPath }
    for (const [field, operator, value] of this.filters) {
      const mongoOperator = { '==': null, '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte', in: '$in' }[operator]
      if (operator === '==') filter[`data.${field}`] = cloneValue(value)
      else filter[`data.${field}`] = { [mongoOperator]: cloneValue(value) }
    }
    return filter
  }
}

class CollectionReference extends QueryReference {
  constructor(path) {
    super(path)
  }

  doc(id = randomBytes(10).toString('hex')) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new TypeError('The document ID is invalid.')
    return new DocumentReference(`${this.collectionPath}/${id}`)
  }
}

class Transaction {
  constructor(database, session) {
    this.database = database
    this.session = session
    this.writes = []
  }

  get(reference) {
    if (reference instanceof DocumentReference) return this.getDocument(reference)
    if (reference instanceof QueryReference) return reference.get(this.session)
    throw new TypeError('Unsupported MongoDB transaction read.')
  }

  async getDocument(reference) {
    const document = await this.database.collection(storageCollection).findOne({ _id: reference.path }, { session: this.session })
    return snapshotFor(reference, document)
  }

  async getAll(...references) {
    const snapshots = []
    for (const reference of references) snapshots.push(await this.getDocument(reference))
    return snapshots
  }

  create(reference, data) {
    this.writes.push({ kind: 'create', reference, data })
  }

  set(reference, data, options = {}) {
    this.writes.push({ kind: 'set', reference, data, options })
  }

  update(reference, data) {
    this.writes.push({ kind: 'update', reference, data })
  }

  delete(reference) {
    this.writes.push({ kind: 'delete', reference })
  }

  async flush() {
    const collection = this.database.collection(storageCollection)
    for (const write of this.writes) {
      const { reference } = write
      if (write.kind === 'create') {
        await collection.insertOne({ ...reference.metadata(), data: cloneValue(write.data) }, { session: this.session })
      } else if (write.kind === 'delete') {
        await collection.deleteOne({ _id: reference.path }, { session: this.session })
      } else if (write.kind === 'set' && !write.options.merge) {
        await collection.replaceOne({ _id: reference.path }, { ...reference.metadata(), data: cloneValue(write.data) }, { upsert: true, session: this.session })
      } else {
        const update = buildUpdate(write.data)
        if (!Object.keys(update).length) continue
        const options = write.kind === 'set' ? { upsert: true, session: this.session } : { session: this.session }
        const result = await collection.updateOne({ _id: reference.path }, { ...update, ...(write.kind === 'set' ? { $setOnInsert: reference.metadata() } : {}) }, options)
        if (write.kind === 'update' && !result.matchedCount) throw Object.assign(new Error(`Document ${reference.path} does not exist.`), { code: 'not-found' })
      }
    }
  }
}

class WriteBatch extends Transaction {
  constructor() {
    super(null, null)
  }

  async commit() {
    const database = await getDatabase()
    const client = await clientPromise
    const session = client.startSession()
    try {
      await session.withTransaction(async () => {
        this.database = database
        this.session = session
        await this.flush()
      })
    } finally {
      await session.endSession()
    }
  }
}

export function getFirestoreCompat() {
  return {
    collection: (path) => new CollectionReference(path),
    doc: (path) => new DocumentReference(path),
    batch: () => new WriteBatch(),
    async runTransaction(handler) {
      const database = await getDatabase()
      const client = await clientPromise
      const session = client.startSession()
      let result
      try {
        await session.withTransaction(async () => {
          const transaction = new Transaction(database, session)
          result = await handler(transaction)
          await transaction.flush()
        })
        return result
      } finally {
        await session.endSession()
      }
    },
  }
}

export async function closeMongoConnection() {
  const client = clientPromise ? await clientPromise.catch(() => null) : null
  clientPromise = undefined
  databasePromise = undefined
  if (client) await client.close()
}
