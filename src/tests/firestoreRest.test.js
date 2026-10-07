import { afterEach, describe, expect, it } from 'vitest'
import { clearMockTransport, commitWrites, queryUpdatedSince, setMockTransport } from '../../sync/firestoreRest.cjs'

afterEach(() => clearMockTransport())

describe('Firestore REST sync transport', () => {
  it('queries incremental timestamps as Firestore timestamps', async () => {
    let requestBody
    setMockTransport(async (_options, body) => {
      requestBody = body
      return []
    })

    await queryUpdatedSince({
      projectId: 'test-project',
      authToken: 'test-token',
      restaurantId: 'restaurant-1',
      collection: 'orders',
      sinceIsoString: '2026-01-02T03:04:05.000Z',
    })

    expect(requestBody.structuredQuery.where.fieldFilter.value).toEqual({
      timestampValue: '2026-01-02T03:04:05.000Z',
    })
  })

  it('rejects commits larger than Firestore’s 500-write limit', async () => {
    await expect(commitWrites({ projectId: 'test-project', writes: Array(501).fill({}) }))
      .rejects.toThrow('1-500 writes')
  })
})