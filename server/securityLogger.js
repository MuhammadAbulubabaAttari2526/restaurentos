import { getMongoDatabase } from '../functions/mongoFirestoreCompat.js'

/**
 * Security audit logger for RestaurantOS.
 * Provides structured stdout logging for SIEM / APM monitoring,
 * and records critical security events to MongoDB for admin auditing.
 */

export const SecurityEvent = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_RATE_LIMITED: 'auth.login.rate_limited',
  LOGOUT: 'auth.logout',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset.requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset.completed',
  EMAIL_VERIFICATION_REQUESTED: 'auth.email_verification.requested',
  EMAIL_VERIFICATION_COMPLETED: 'auth.email_verification.completed',
  STAFF_JOIN_ATTEMPT: 'auth.staff_join.attempt',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit.exceeded',
  IDOR_ATTEMPT: 'security.idor.attempt',
  INJECTION_ATTEMPT: 'security.injection.attempt',
  UNAUTHORIZED_ACCESS: 'security.unauthorized_access',
  SERVER_ERROR: 'api.server_error',
}

export function logSecurityEvent(type, details = {}) {
  const timestamp = new Date().toISOString()
  const entry = {
    timestamp,
    event: type,
    ...details,
  }

  // Structured log for monitoring systems (Render, Datadog, CloudWatch)
  const prefix = type.startsWith('security.') ? '🚨 [SECURITY ALERT]' : '[SECURITY AUDIT]'
  console.log(`${prefix} ${JSON.stringify(entry)}`)

  // Persist high-priority security events to MongoDB asynchronously
  persistSecurityAudit(entry).catch((err) => {
    // Non-blocking: never crash request handler if logging fails
    console.warn('[SecurityLogger Warning] Failed to persist audit to MongoDB:', err?.message)
  })
}

async function persistSecurityAudit(entry) {
  // Only persist security alerts, auth failures, and rate limit triggers to avoid DB bloat
  const persistable = [
    SecurityEvent.LOGIN_FAILURE,
    SecurityEvent.LOGIN_RATE_LIMITED,
    SecurityEvent.RATE_LIMIT_EXCEEDED,
    SecurityEvent.IDOR_ATTEMPT,
    SecurityEvent.INJECTION_ATTEMPT,
    SecurityEvent.PASSWORD_RESET_COMPLETED,
  ]
  if (!persistable.includes(entry.event)) return

  try {
    const database = await getMongoDatabase()
    await database.collection('securityAuditLogs').insertOne({
      ...entry,
      createdAt: new Date(),
    })
  } catch {
    // In dev or when database is connecting, ignore silently
  }
}
