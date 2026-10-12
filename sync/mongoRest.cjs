let mockTransport = null

function setMockTransport(transport) {
  mockTransport = transport
}

function clearMockTransport() {
  mockTransport = null
}

function getEndpoint(apiBaseUrl) {
  const baseUrl = String(apiBaseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('A RestaurantOS API URL is required for MongoDB sync.')
  return `${baseUrl}/api/syncMongo`
}

async function request({ apiBaseUrl, authToken, body }) {
  if (mockTransport) return mockTransport({ apiBaseUrl, authToken, body })
  if (!authToken) throw Object.assign(new Error('Sign in to sync restaurant data.'), { status: 401 })
  const response = await fetch(getEndpoint(apiBaseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = result.message || result.error?.message || `MongoDB sync request failed with HTTP ${response.status}.`
    throw Object.assign(new Error(message), { status: response.status, details: result })
  }
  return result
}

async function readDoc({ apiBaseUrl, authToken, restaurantId, collection, docId }) {
  const result = await request({ apiBaseUrl, authToken, body: { action: 'read', restaurantId, collection, docId } })
  return result.document || null
}

function buildUpdateWrite({ restaurantId, collection, docId, data }) {
  if (!restaurantId || !collection || !docId || !data || typeof data !== 'object') throw new Error('MongoDB sync write details are incomplete.')
  return { restaurantId, collection, docId, data }
}

async function commitWrites({ apiBaseUrl, authToken, writes }) {
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 500) throw new Error('MongoDB sync expects 1-500 writes.')
  return request({ apiBaseUrl, authToken, body: { action: 'writeBatch', writes } })
}

async function queryUpdatedSince({ apiBaseUrl, authToken, restaurantId, collection, sinceIsoString }) {
  const result = await request({
    apiBaseUrl,
    authToken,
    body: { action: 'queryUpdatedSince', restaurantId, collection, sinceIsoString },
  })
  return Array.isArray(result.documents) ? result.documents : []
}

module.exports = { readDoc, buildUpdateWrite, commitWrites, queryUpdatedSince, setMockTransport, clearMockTransport }
