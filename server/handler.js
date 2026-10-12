import { createReadStream, existsSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as operations from '../functions/index.js'
import { getMongoAuth } from '../functions/mongoAuth.js'
import { getMongoDatabase } from '../functions/mongoFirestoreCompat.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const webRoot = resolve(root, 'dist')
const auth = getMongoAuth()
const callableNames = new Set(Object.keys(operations).filter((name) => name !== 'syncMongo'))
const statusByCode = {
  unauthenticated: 401,
  'permission-denied': 403,
  'invalid-argument': 400,
  'not-found': 404,
  'failed-precondition': 409,
  'already-exists': 409,
  'auth/invalid-credential': 401,
  'auth/user-not-found': 404,
  'auth/email-already-in-use': 409,
}
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'object') return request.body
    if (typeof request.body === 'string') {
      try {
        return request.body ? JSON.parse(request.body) : {}
      } catch {
        throw Object.assign(new Error('The request body is not valid JSON.'), { code: 'invalid-argument' })
      }
    }
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw Object.assign(new Error('Request is too large.'), { code: 'invalid-argument' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('The request body is not valid JSON.'), { code: 'invalid-argument' })
  }
}

function bearerToken(request) {
  return String(request.headers.authorization || '').replace(/^Bearer\s+/i, '')
}

async function authenticate(request) {
  const token = bearerToken(request)
  if (!token) return null
  const claims = await auth.verifyIdToken(token)
  return { uid: claims.uid, token: claims, sessionToken: token }
}

async function invoke(name, data, actor) {
  const operation = operations[name]
  if (typeof operation !== 'function') throw Object.assign(new Error('This API operation was not found.'), { code: 'not-found' })
  return operation({ auth: actor, data })
}

async function handleAuth(path, request, body, actor) {
  if (path === '/api/auth/login' && request.method === 'POST') {
    const session = await auth.signIn(body.email, body.password)
    const claims = await auth.verifyIdToken(session.token)
    const membership = await invoke('getMembership', {}, { uid: claims.uid, token: claims })
    return { ...session, membership }
  }

  if (path === '/api/auth/session' && request.method === 'GET') {
    if (!actor) throw Object.assign(new Error('Sign in to continue.'), { code: 'unauthenticated' })
    const user = await auth.getUser(actor.uid)
    const membership = await invoke('getMembership', {}, actor)
    return { user, membership, expiresAt: (await getSessionExpiry(actor.sessionToken)) }
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    if (actor?.sessionToken) await auth.signOut(actor.sessionToken)
    return { ok: true }
  }

  if (path === '/api/auth/join' && request.method === 'POST') {
    const invitation = await invoke('getStaffInvitation', { restaurantId: body.restaurantId, invitationId: body.invitationId }, null)
    if (String(body.email || '').trim().toLowerCase() !== invitation.email.toLowerCase()) {
      throw Object.assign(new Error(`This invitation is for ${invitation.email}.`), { code: 'permission-denied' })
    }
    const database = await getMongoDatabase()
    const sourceMembers = await database.collection('restaurantDocuments')
      .find({ collectionPath: `restaurants/${body.restaurantId}/users` }, { projection: { id: 1, 'data.email': 1 } })
      .toArray()
    const existingMember = sourceMembers.find((entry) => String(entry.data?.email || '').trim().toLowerCase() === invitation.email.toLowerCase())
    const user = await auth.createUser({
      uid: existingMember?.id,
      email: invitation.email,
      password: body.password,
      displayName: body.displayName || invitation.displayName,
    })
    try {
      await invoke('completeStaffInvite', { restaurantId: body.restaurantId, invitationId: body.invitationId }, { uid: user.uid, token: { email: user.email } })
      const session = await auth.createSession(user.uid)
      const claims = await auth.verifyIdToken(session.token)
      const membership = await invoke('getMembership', {}, { uid: claims.uid, token: claims })
      return { ...session, membership }
    } catch (error) {
      await auth.deleteUser(user.uid).catch(() => {})
      throw error
    }
  }

  throw Object.assign(new Error('This authentication route was not found.'), { code: 'not-found' })
}

async function getSessionExpiry(token) {
  const database = await getMongoDatabase()
  const { createHash } = await import('node:crypto')
  const session = await database.collection('authSessions').findOne({ _id: createHash('sha256').update(token).digest('hex') })
  return session?.expiresAt?.toISOString?.() || null
}

function sendStaticFile(response, filePath) {
  response.writeHead(200, {
    'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(response)
}

export async function handleRequest(request, response) {
  response.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*')
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    return response.end()
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const rawPath = request.headers['x-matched-path'] || url.pathname
  const pathname = rawPath.split('?')[0]

  try {
    if (pathname === '/api/health' && ['GET', 'HEAD'].includes(request.method)) {
      const database = await getMongoDatabase()
      await database.command({ ping: 1 })
      if (request.method === 'HEAD') {
        response.writeHead(204, { 'cache-control': 'no-store' })
        return response.end()
      }
      return sendJson(response, 200, { ok: true, database: 'connected' })
    }

    if (pathname.startsWith('/api/')) {
      const body = request.method === 'POST' ? await readJson(request) : {}
      const isLogin = pathname === '/api/auth/login' || pathname === '/api/auth/join'
      const actor = isLogin || pathname === '/api/auth/logout' ? await authenticate(request).catch(() => null) : await authenticate(request)

      if (pathname.startsWith('/api/auth/')) {
        const result = await handleAuth(pathname, request, body, actor)
        return sendJson(response, 200, result)
      }

      if (pathname === '/api/syncMongo' && request.method === 'POST') {
        const fakeResponse = {
          status(code) { this.statusCode = code; return this },
          json(value) { sendJson(response, this.statusCode || 200, value); return this },
        }
        request.body = body
        request.auth = actor
        request.get = (name) => request.headers[String(name).toLowerCase()]
        await operations.syncMongo(request, fakeResponse)
        return
      }

      const name = pathname.slice('/api/'.length)
      if (name.includes('/') || !callableNames.has(name)) throw Object.assign(new Error('This API operation was not found.'), { code: 'not-found' })
      const result = await invoke(name, body, actor)
      return sendJson(response, 200, { data: result })
    }

    if (existsSync(webRoot)) {
      const requested = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const candidate = resolve(webRoot, requested || 'index.html')
      const insideWebRoot = candidate === webRoot || candidate.startsWith(`${webRoot}${sep}`)
      if (!insideWebRoot) return sendJson(response, 404, { message: 'Page not found.' })
      if (existsSync(candidate)) return sendStaticFile(response, candidate)
      return sendStaticFile(response, resolve(webRoot, 'index.html'))
    }
    return sendJson(response, 404, { message: 'Page not found.' })
  } catch (error) {
    const status = statusByCode[error.code] || 500
    if (status >= 500) console.error('RestaurantOS API request failed', error)
    return sendJson(response, status, {
      message: status >= 500 ? 'The request could not be completed. Check the server connection and try again.' : error.message,
      error: { status: error.code || 'internal' },
    })
  }
}
