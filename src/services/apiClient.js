const SESSION_KEY = 'restaurantos.session'
const DEFAULT_DESKTOP_API_BASE_URL = 'https://restaurentos-rosy.vercel.app'

export function getApiBaseUrl() {
  const configured = import.meta.env?.VITE_API_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.posApi?.isElectron) {
    return import.meta.env.DEV ? 'http://localhost:8787' : DEFAULT_DESKTOP_API_BASE_URL
  }
  return ''
}

export function getSessionToken() {
  try { return localStorage.getItem(SESSION_KEY) || '' } catch { return '' }
}

export function saveSessionToken(token) {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token)
    else localStorage.removeItem(SESSION_KEY)
  } catch {}
}

export async function apiRequest(path, { method = 'GET', body, token = getSessionToken() } = {}) {
  const base = getApiBaseUrl()
  if (!base && typeof window !== 'undefined' && window.location.protocol === 'file:') {
    throw new Error('The RestaurantOS server address is not configured in this desktop build.')
  }
  const response = await fetch(`${base}/api/${path.replace(/^\/+/, '')}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.message || `The server returned HTTP ${response.status}.`)
    error.code = result.error?.status || 'internal'
    error.status = response.status
    error.details = result
    throw error
  }
  return result
}

export async function loginWithPassword(email, password) {
  const session = await apiRequest('auth/login', { method: 'POST', body: { email, password }, token: '' })
  saveSessionToken(session.token)
  return session
}

export async function joinWithInvitation({ restaurantId, invitationId, email, password, displayName }) {
  const session = await apiRequest('auth/join', {
    method: 'POST',
    body: { restaurantId, invitationId, email, password, displayName },
    token: '',
  })
  saveSessionToken(session.token)
  return session
}

export async function loadAuthSession() {
  const token = getSessionToken()
  if (!token) return null
  try {
    return await apiRequest('auth/session', { token })
  } catch (error) {
    saveSessionToken('')
    throw error
  }
}

export async function logoutSession() {
  const token = getSessionToken()
  try {
    if (token) await apiRequest('auth/logout', { method: 'POST', body: {}, token })
  } finally {
    saveSessionToken('')
  }
}

export async function requestPasswordReset(email) {
  return apiRequest('auth/request-password-reset', { method: 'POST', body: { email }, token: '' })
}

export async function resetPasswordWithToken(token, password) {
  return apiRequest('auth/reset-password', { method: 'POST', body: { token, password }, token: '' })
}

export async function sendEmailVerification(email) {
  return apiRequest('auth/send-verification-email', { method: 'POST', body: email ? { email } : {} })
}

export async function verifyEmailWithToken(token) {
  return apiRequest('auth/verify-email', { method: 'POST', body: { token }, token: '' })
}
