import { describe, expect, it, vi } from 'vitest'
import { SecurityEvent, logSecurityEvent } from '../../server/securityLogger.js'

describe('API & Data Security Guard Suite', () => {
  it('detects and logs security events with structured attributes', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSecurityEvent(SecurityEvent.IDOR_ATTEMPT, {
      clientIp: '198.51.100.1',
      uid: 'user-123',
      userRestaurantId: 'rest-A',
      requestedRestaurantId: 'rest-B',
      pathname: '/api/getRecords',
    })

    expect(consoleSpy).toHaveBeenCalled()
    const logCall = consoleSpy.mock.calls.find((call) => call[0].includes('IDOR_ATTEMPT') || call[0].includes('security.idor.attempt'))
    expect(logCall).toBeTruthy()
    expect(logCall[0]).toContain('rest-A')
    expect(logCall[0]).toContain('rest-B')
    consoleSpy.mockRestore()
  })

  it('rejects NoSQL injection operator keys in query builders', async () => {
    const { getFirestoreCompat } = await import('../../functions/mongoFirestoreCompat.js')
    const db = getFirestoreCompat()
    const collection = db.collection('restaurants/rest-1/menuItems')

    // Attempting to query with a NoSQL operator like {$ne: null} must throw
    expect(() => {
      collection.where('name', '==', { $ne: null })
    }).toThrow(/MongoDB operator keys/)
  })

  it('rejects non-primitive values in in queries', async () => {
    const { getFirestoreCompat } = await import('../../functions/mongoFirestoreCompat.js')
    const db = getFirestoreCompat()
    const collection = db.collection('restaurants/rest-1/menuItems')

    expect(() => {
      collection.where('status', 'in', [{ malicious: true }])
    }).toThrow(/primitives or Dates/)
  })

  it('permits valid safe query parameters', async () => {
    const { getFirestoreCompat } = await import('../../functions/mongoFirestoreCompat.js')
    const db = getFirestoreCompat()
    const collection = db.collection('restaurants/rest-1/menuItems')

    expect(() => {
      collection.where('status', '==', 'active')
      collection.where('priceCents', '>=', 500)
      collection.where('status', 'in', ['queued', 'preparing'])
    }).not.toThrow()
  })
})
