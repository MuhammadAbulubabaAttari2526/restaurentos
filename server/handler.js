import { createReadStream, existsSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as operations from '../functions/index.js'
import { getMongoAuth } from '../functions/mongoAuth.js'
import { getMongoDatabase } from '../functions/mongoFirestoreCompat.js'
import { checkRateLimit, getClientIp, recordAttempt, resetRateLimit } from '../functions/rateLimiter.js'
import { SecurityEvent, logSecurityEvent } from './securityLogger.js'

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
  'resource-exhausted': 429,
  'auth/too-many-requests': 429,
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
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function validateNoInjection(value, path = '') {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.includes('\0')) {
      throw Object.assign(new Error(`Input contains forbidden null bytes at ${path || 'root'}.`), { code: 'invalid-argument' })
    }
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateNoInjection(value[i], `${path}[${i}]`)
    }
    return
  }
  if (typeof value === 'object') {
    for (const [key, sub] of Object.entries(value)) {
      if (key.startsWith('$')) {
        throw Object.assign(new Error(`Property name '${key}' is forbidden (NoSQL operator injection detected).`), { code: 'invalid-argument' })
      }
      validateNoInjection(sub, path ? `${path}.${key}` : key)
    }
  }
}

async function readJson(request) {
  let parsed = {}
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'object') {
      validateNoInjection(request.body)
      return request.body
    }
    if (typeof request.body === 'string') {
      try {
        parsed = request.body ? JSON.parse(request.body) : {}
      } catch {
        throw Object.assign(new Error('The request body is not valid JSON.'), { code: 'invalid-argument' })
      }
      validateNoInjection(parsed)
      return parsed
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
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('The request body is not valid JSON.'), { code: 'invalid-argument' })
  }
  validateNoInjection(parsed)
  return parsed
}

function bearerToken(request) {
  return String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
}

async function authenticate(request) {
  const token = bearerToken(request)
  if (!token) return null
  const claims = await auth.verifyIdToken(token)
  return { uid: claims.uid, token: claims, sessionToken: token, expiresAt: claims.expiresAt }
}

async function invoke(name, data, actor) {
  const operation = operations[name]
  if (typeof operation !== 'function') throw Object.assign(new Error('This API operation was not found.'), { code: 'not-found' })
  return operation({ auth: actor, data })
}

async function handleAuth(path, request, body, actor) {
  const clientIp = getClientIp(request)

  // ─── LOGIN WITH PASSWORD ──────────────────────────────────────────────────
  if (path === '/api/auth/login' && request.method === 'POST') {
    const email = String(body?.email || '').trim().toLowerCase()
    const ipKey = `login:ip:${clientIp}`
    const accountKey = `login:acc:${clientIp}:${email}`

    // Strict rate limits: 20 per IP, 5 failed per account per 15 min window
    try {
      await checkRateLimit(ipKey, 20, 15 * 60 * 1000)
      await checkRateLimit(accountKey, 5, 15 * 60 * 1000)
    } catch (rateErr) {
      logSecurityEvent(SecurityEvent.LOGIN_RATE_LIMITED, { clientIp, email, userAgent: request.headers['user-agent'] })
      throw rateErr
    }

    try {
      const session = await auth.signIn(email, body?.password)
      // Successful login resets failed attempts for this account
      await resetRateLimit(accountKey)
      const claims = await auth.verifyIdToken(session.token)
      const membership = await invoke('getMembership', {}, { uid: claims.uid, token: claims })
      logSecurityEvent(SecurityEvent.LOGIN_SUCCESS, { clientIp, uid: claims.uid, email, restaurantId: claims.restaurantId, role: claims.role })
      return { ...session, membership }
    } catch (error) {
      await recordAttempt(ipKey, 15 * 60 * 1000)
      await recordAttempt(accountKey, 15 * 60 * 1000)
      logSecurityEvent(SecurityEvent.LOGIN_FAILURE, { clientIp, email, error: error?.message, code: error?.code })
      throw error
    }
  }

  // ─── SESSION INSPECTION ───────────────────────────────────────────────────
  if (path === '/api/auth/session' && request.method === 'GET') {
    if (!actor) throw Object.assign(new Error('Sign in to continue.'), { code: 'unauthenticated' })
    const user = await auth.getUser(actor.uid)
    const membership = await invoke('getMembership', {}, actor)
    const expiresAt = actor.expiresAt || (await auth.getSessionExpiry(actor.sessionToken))
    return { user, membership, expiresAt }
  }

  // ─── LOGOUT ───────────────────────────────────────────────────────────────
  if (path === '/api/auth/logout' && request.method === 'POST') {
    if (actor?.sessionToken) await auth.signOut(actor.sessionToken)
    logSecurityEvent(SecurityEvent.LOGOUT, { clientIp, uid: actor?.uid })
    return { ok: true }
  }

  // ─── JOIN VIA INVITATION ──────────────────────────────────────────────────
  if (path === '/api/auth/join' && request.method === 'POST') {
    await checkRateLimit(`join:ip:${clientIp}`, 10, 15 * 60 * 1000)
    logSecurityEvent(SecurityEvent.STAFF_JOIN_ATTEMPT, { clientIp, email: body?.email, restaurantId: body?.restaurantId })

    const invitation = await invoke('getStaffInvitation', { restaurantId: body?.restaurantId, invitationId: body?.invitationId }, null)
    if (String(body?.email || '').trim().toLowerCase() !== invitation.email.toLowerCase()) {
      throw Object.assign(new Error(`This invitation is for ${invitation.email}.`), { code: 'permission-denied' })
    }
    const database = await getMongoDatabase()
    const sourceMembers = await database.collection('restaurantDocuments')
      .find({ collectionPath: `restaurants/${body?.restaurantId}/users` }, { projection: { id: 1, 'data.email': 1 } })
      .toArray()
    const existingMember = sourceMembers.find((entry) => String(entry.data?.email || '').trim().toLowerCase() === invitation.email.toLowerCase())
    const user = await auth.createUser({
      uid: existingMember?.id,
      email: invitation.email,
      password: body?.password,
      displayName: body?.displayName || invitation.displayName,
      emailVerified: true, // Delivered via cryptographic invitation token
    })
    try {
      await invoke('completeStaffInvite', { restaurantId: body?.restaurantId, invitationId: body?.invitationId }, { uid: user.uid, token: { email: user.email } })
      const session = await auth.createSession(user.uid)
      const claims = await auth.verifyIdToken(session.token)
      const membership = await invoke('getMembership', {}, { uid: claims.uid, token: claims })
      return { ...session, membership }
    } catch (error) {
      await auth.deleteUser(user.uid).catch(() => {})
      throw error
    }
  }

  // ─── PASSWORD RESET REQUEST ───────────────────────────────────────────────
  if (path === '/api/auth/request-password-reset' && request.method === 'POST') {
    const email = String(body?.email || '').trim().toLowerCase()
    await checkRateLimit(`pwd_reset_req:ip:${clientIp}`, 5, 15 * 60 * 1000)
    await checkRateLimit(`pwd_reset_req:email:${email}`, 3, 15 * 60 * 1000)
    await recordAttempt(`pwd_reset_req:ip:${clientIp}`, 15 * 60 * 1000)
    await recordAttempt(`pwd_reset_req:email:${email}`, 15 * 60 * 1000)

    logSecurityEvent(SecurityEvent.PASSWORD_RESET_REQUESTED, { clientIp, email })
    const result = await auth.createPasswordResetToken(email)
    const isDev = process.env.NODE_ENV !== 'production'
    return {
      ok: true,
      message: result.message,
      // Authentication secrets are NEVER exposed in production responses
      ...(isDev && result.token ? { devResetToken: result.token, expiresAt: result.expiresAt } : {}),
    }
  }

  // ─── COMPLETE PASSWORD RESET ─────────────────────────────────────────────
  if (path === '/api/auth/reset-password' && request.method === 'POST') {
    const ipKey = `pwd_reset_sub:ip:${clientIp}`
    await checkRateLimit(ipKey, 5, 15 * 60 * 1000)

    try {
      const result = await auth.resetPasswordWithToken(body?.token, body?.password)
      logSecurityEvent(SecurityEvent.PASSWORD_RESET_COMPLETED, { clientIp })
      return result
    } catch (error) {
      await recordAttempt(ipKey, 15 * 60 * 1000)
      throw error
    }
  }

  // ─── REQUEST EMAIL VERIFICATION ──────────────────────────────────────────
  if (path === '/api/auth/send-verification-email' && request.method === 'POST') {
    const email = String(actor?.token?.email || body?.email || '').trim().toLowerCase()
    await checkRateLimit(`email_verif_req:ip:${clientIp}`, 5, 15 * 60 * 1000)
    await checkRateLimit(`email_verif_req:email:${email}`, 3, 15 * 60 * 1000)
    await recordAttempt(`email_verif_req:ip:${clientIp}`, 15 * 60 * 1000)
    await recordAttempt(`email_verif_req:email:${email}`, 15 * 60 * 1000)

    logSecurityEvent(SecurityEvent.EMAIL_VERIFICATION_REQUESTED, { clientIp, email })
    const result = await auth.createEmailVerificationToken(email)
    const isDev = process.env.NODE_ENV !== 'production'
    return {
      ok: true,
      message: result.message,
      alreadyVerified: result.alreadyVerified || false,
      // Authentication secrets are NEVER exposed in production responses
      ...(isDev && result.token ? { devVerificationToken: result.token, expiresAt: result.expiresAt } : {}),
    }
  }

  // ─── COMPLETE EMAIL VERIFICATION ──────────────────────────────────────────
  if (path === '/api/auth/verify-email' && request.method === 'POST') {
    const ipKey = `email_verif_sub:ip:${clientIp}`
    await checkRateLimit(ipKey, 10, 15 * 60 * 1000)

    try {
      const result = await auth.verifyEmailToken(body?.token)
      logSecurityEvent(SecurityEvent.EMAIL_VERIFICATION_COMPLETED, { clientIp })
      return { ok: true, emailVerified: true, user: result.user }
    } catch (error) {
      await recordAttempt(ipKey, 15 * 60 * 1000)
      throw error
    }
  }

  throw Object.assign(new Error('This authentication route was not found.'), { code: 'not-found' })
}

function sendStaticFile(response, filePath) {
  response.writeHead(200, {
    'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(response)
}

function resolvePath(request, url) {
  const matchedHeader = request.headers?.['x-matched-path']
  if (matchedHeader && !matchedHeader.includes('/api/index')) {
    return matchedHeader.split('?')[0]
  }

  const queryMatch = request.query?.match
  if (Array.isArray(queryMatch) && queryMatch.length > 0) {
    return `/api/${queryMatch.join('/')}`
  }
  if (typeof queryMatch === 'string' && queryMatch.length > 0) {
    return `/api/${queryMatch.replace(/^\/+/, '')}`
  }

  const matchParam = url.searchParams.getAll('match')
  if (matchParam.length > 0) {
    return `/api/${matchParam.join('/')}`
  }

  const raw = url.pathname || '/'
  return raw.split('?')[0]
}

function configureCors(request, response) {
  const origin = request.headers.origin
  const configured = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean)

  if (configured.length > 0) {
    if (origin && (configured.includes(origin) || configured.includes('*'))) {
      response.setHeader('access-control-allow-origin', configured.includes('*') ? '*' : origin)
      if (origin) response.setHeader('vary', 'Origin')
    }
  } else {
    // Development or local fallback
    if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:') || origin === 'null') {
      response.setHeader('access-control-allow-origin', origin || '*')
      if (origin) response.setHeader('vary', 'Origin')
    }
  }

  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
  response.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload')
  response.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()')
}

export async function handleRequest(request, response) {
  // ─── HTTPS ENFORCEMENT IN PRODUCTION ──────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    const proto = request.headers['x-forwarded-proto']
    if (proto && proto === 'http') {
      const host = request.headers.host || 'restaurantos.app'
      response.writeHead(301, {
        Location: `https://${host}${request.url}`,
        'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      })
      return response.end()
    }
  }

  configureCors(request, response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    return response.end()
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const pathname = resolvePath(request, url)

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
      const clientIp = getClientIp(request)
      // ─── ABUSE & BOT PROTECTION: GENERAL API RATE LIMITING ────────────────
      const isSync = pathname === '/api/syncMongo'
      const apiLimit = isSync ? 60 : 180
      const limitWindow = 60 * 1000
      try {
        await checkRateLimit(`api:ip:${clientIp}${isSync ? ':sync' : ''}`, apiLimit, limitWindow)
        await recordAttempt(`api:ip:${clientIp}${isSync ? ':sync' : ''}`, limitWindow)
      } catch (rateErr) {
        logSecurityEvent(SecurityEvent.RATE_LIMIT_EXCEEDED, { clientIp, pathname, limit: apiLimit })
        throw rateErr
      }

      const body = request.method === 'POST' ? await readJson(request) : {}
      const isPublicAuth = [
        '/api/auth/login',
        '/api/auth/join',
        '/api/auth/logout',
        '/api/auth/request-password-reset',
        '/api/auth/reset-password',
        '/api/auth/verify-email',
        '/api/auth/send-verification-email',
      ].includes(pathname)

      const actor = isPublicAuth
        ? await authenticate(request).catch(() => null)
        : await authenticate(request)

      // ─── USER-LEVEL RATE LIMITING (AUTHENTICATED SESSIONS) ────────────────
      if (actor?.uid) {
        try {
          await checkRateLimit(`api:user:${actor.uid}`, 300, 60 * 1000)
          await recordAttempt(`api:user:${actor.uid}`, 60 * 1000)
        } catch (rateErr) {
          logSecurityEvent(SecurityEvent.RATE_LIMIT_EXCEEDED, { clientIp, uid: actor.uid, pathname, limit: 300 })
          throw rateErr
        }
      }

      // ─── IDOR PROTECTION: CROSS-TENANT VERIFICATION ───────────────────────
      if (body?.restaurantId && actor?.token?.restaurantId && body.restaurantId !== actor.token.restaurantId) {
        logSecurityEvent(SecurityEvent.IDOR_ATTEMPT, {
          clientIp,
          uid: actor.uid,
          userRestaurantId: actor.token.restaurantId,
          requestedRestaurantId: body.restaurantId,
          pathname,
        })
        throw Object.assign(new Error('Cross-tenant resource access is forbidden (IDOR protection).'), { code: 'permission-denied' })
      }

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
    if (status === 429 && error.retryAfter) {
      response.setHeader('retry-after', String(error.retryAfter))
    }
    if (status >= 500) {
      console.error('RestaurantOS API request failed', error)
      logSecurityEvent(SecurityEvent.SERVER_ERROR, {
        pathname,
        clientIp: getClientIp(request),
        error: error?.message,
        code: error?.code,
      })
    }
    return sendJson(response, status, {
      message: status >= 500 ? 'The request could not be completed. Check the server connection and try again.' : error.message,
      error: { status: error.code || 'internal' },
    })
  }
}
