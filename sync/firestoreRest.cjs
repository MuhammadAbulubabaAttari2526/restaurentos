/**
 * firestoreRest.cjs
 *
 * Minimal, zero-dependency Firestore REST API client for Electron main process.
 * Handles value encoding/decoding and HTTP communication with Google Firestore REST endpoint.
 * Supports mock transport for unit testing and offline simulation.
 */

const https = require('https')
const http = require('http')

let _mockTransport = null

function setMockTransport(fn) {
  _mockTransport = fn
}

function clearMockTransport() {
  _mockTransport = null
}

/**
 * Encodes a JavaScript value into Firestore REST Value proto
 */
function encodeValue(val) {
  if (val === null || val === undefined) {
    return { nullValue: null }
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val }
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) }
    }
    return { doubleValue: val }
  }
  if (typeof val === 'string') {
    // If it looks like an ISO timestamp string, keep as string or timestamp
    return { stringValue: val }
  }
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() }
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(encodeValue),
      },
    }
  }
  if (typeof val === 'object') {
    const fields = {}
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = encodeValue(v)
      }
    }
    return { mapValue: { fields } }
  }
  return { stringValue: String(val) }
}

/**
 * Decodes a Firestore REST Value proto into a standard JavaScript value
 */
function decodeValue(val) {
  if (!val || typeof val !== 'object') return val
  if ('nullValue' in val) return null
  if ('booleanValue' in val) return val.booleanValue
  if ('integerValue' in val) return parseInt(val.integerValue, 10)
  if ('doubleValue' in val) return Number(val.doubleValue)
  if ('stringValue' in val) return val.stringValue
  if ('timestampValue' in val) return val.timestampValue
  if ('arrayValue' in val) {
    const arr = val.arrayValue?.values || []
    return arr.map(decodeValue)
  }
  if ('mapValue' in val) {
    const fields = val.mapValue?.fields || {}
    const out = {}
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeValue(v)
    }
    return out
  }
  return val
}

function encodeFields(obj) {
  const fields = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      fields[key] = encodeValue(value)
    }
  }
  return fields
}

function decodeFields(fields) {
  if (!fields || typeof fields !== 'object') return {}
  const obj = {}
  for (const [key, val] of Object.entries(fields)) {
    obj[key] = decodeValue(val)
  }
  return obj
}

function httpRequest(options, body) {
  if (_mockTransport) {
    return _mockTransport(options, body)
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(options.url)
    const client = urlObj.protocol === 'http:' ? http : https

    const req = client.request(
      urlObj,
      {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        timeout: options.timeoutMs || 10000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {}
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed)
            } else {
              const err = new Error(
                parsed.error?.message || `HTTP ${res.statusCode}: ${res.statusMessage}`
              )
              err.status = res.statusCode
              err.details = parsed
              reject(err)
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({})
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data || res.statusMessage}`))
            }
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })

    req.on('error', (err) => {
      reject(err)
    })

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

function getBaseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
}

function getDocumentName(projectId, restaurantId, collection, docId) {
  return `projects/${projectId}/databases/(default)/documents/restaurants/${restaurantId}/${collection}/${docId}`
}

function getDocumentUrl(projectId, restaurantId, collection, docId) {
  return `https://firestore.googleapis.com/v1/${getDocumentName(projectId, restaurantId, collection, docId)}`
}

async function readDoc({ projectId, authToken, restaurantId, collection, docId }) {
  const headers = {}
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  try {
    const result = await httpRequest({
      url: getDocumentUrl(projectId, restaurantId, collection, docId),
      method: 'GET',
      headers,
    })
    return {
      id: docId,
      data: decodeFields(result.fields),
      updateTime: result.updateTime || null,
    }
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

function buildUpdateWrite({ projectId, restaurantId, collection, docId, data, updateTime, exists }) {
  const fields = { ...data }
  delete fields.updatedAt
  const serverCreatedAt = exists === false && ['orders', 'orderFinancials', 'payments', 'inventory', 'stockMovements'].includes(collection)
  if (serverCreatedAt) delete fields.createdAt

  const write = {
    update: {
      name: getDocumentName(projectId, restaurantId, collection, docId),
      fields: encodeFields(fields),
    },
    updateMask: { fieldPaths: Object.keys(fields) },
    updateTransforms: [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }

  if (serverCreatedAt) {
    write.updateTransforms.push({ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' })
  }
  if (exists === false) {
    write.currentDocument = { exists: false }
  } else if (updateTime) {
    write.currentDocument = { updateTime }
  }

  return write
}

async function commitWrites({ projectId, authToken, writes }) {
  if (!projectId || !Array.isArray(writes) || writes.length === 0 || writes.length > 500) {
    throw new Error('commitWrites requires 1-500 writes and a projectId.')
  }

  const headers = {}
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  return httpRequest({
    url: `${getBaseUrl(projectId)}:commit`,
    method: 'POST',
    headers,
  }, { writes })
}

/**
 * Writes (sets/updates) a Firestore document
 */
async function writeDoc({ projectId, authToken, restaurantId, collection, docId, data }) {
  if (!projectId || !restaurantId || !collection || !docId) {
    throw new Error('Missing required arguments for writeDoc')
  }

  const baseUrl = getBaseUrl(projectId)
  const docPath = `restaurants/${restaurantId}/${collection}/${docId}`
  const url = `${baseUrl}/${docPath}`

  const fields = encodeFields(data)
  const body = { fields }

  const headers = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  return httpRequest(
    {
      url,
      method: 'PATCH',
      headers,
    },
    body
  )
}

/**
 * Deletes a Firestore document
 */
async function deleteDoc({ projectId, authToken, restaurantId, collection, docId }) {
  if (!projectId || !restaurantId || !collection || !docId) {
    throw new Error('Missing required arguments for deleteDoc')
  }

  const baseUrl = getBaseUrl(projectId)
  const docPath = `restaurants/${restaurantId}/${collection}/${docId}`
  const url = `${baseUrl}/${docPath}`

  const headers = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  return httpRequest({
    url,
    method: 'DELETE',
    headers,
  })
}

/**
 * Queries documents updated since a specific ISO timestamp
 */
async function queryUpdatedSince({
  projectId,
  authToken,
  restaurantId,
  collection,
  sinceIsoString,
}) {
  if (!projectId || !restaurantId || !collection) {
    throw new Error('Missing required arguments for queryUpdatedSince')
  }

  const baseUrl = getBaseUrl(projectId)
  const parentPath = `projects/${projectId}/databases/(default)/documents/restaurants/${restaurantId}`
  const url = `${baseUrl}:runQuery`

  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: sinceIsoString
      ? {
          fieldFilter: {
            field: { fieldPath: 'updatedAt' },
            op: 'GREATER_THAN_OR_EQUAL',
            value: { timestampValue: new Date(sinceIsoString).toISOString() },
          },
        }
      : undefined,
    orderBy: [
      {
        field: { fieldPath: 'updatedAt' },
        direction: 'ASCENDING',
      },
    ],
    limit: 100,
  }

  if (!sinceIsoString) {
    delete structuredQuery.where
  }

  const headers = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  const res = await httpRequest(
    {
      url,
      method: 'POST',
      headers,
    },
    {
      parent: parentPath,
      structuredQuery,
    }
  )

  // runQuery returns an array of objects like [{ document: { name, fields, createTime, updateTime } }]
  const items = []
  if (Array.isArray(res)) {
    for (const item of res) {
      if (item.document && item.document.fields) {
        const docName = item.document.name || ''
        const id = docName.split('/').pop()
        const data = decodeFields(item.document.fields)
        items.push({ id, ...data })
      }
    }
  }

  return items
}

module.exports = {
  encodeValue,
  decodeValue,
  encodeFields,
  decodeFields,
  readDoc,
  buildUpdateWrite,
  commitWrites,
  writeDoc,
  deleteDoc,
  queryUpdatedSince,
  setMockTransport,
  clearMockTransport,
}
