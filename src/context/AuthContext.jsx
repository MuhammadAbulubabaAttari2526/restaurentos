import { useEffect, useState } from 'react'
import { getApiBaseUrl, joinWithInvitation, loadAuthSession, loginWithPassword, logoutSession } from '../services/apiClient.js'
import { activateDemoSession, clearDemoSession, demoMembership, demoUser, isDemoSession } from '../services/demoData.js'
import AuthContext from './authContext.js'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => isDemoSession() ? demoUser : null)
  const [membership, setMembership] = useState(() => isDemoSession() ? demoMembership : null)
  const [loading, setLoading] = useState(() => !isDemoSession())

  async function updateSyncCredentials(nextUser, nextMembership, expiresAt) {
    if (!window.posApi?.sync) return
    if (nextUser && nextMembership?.restaurantId) {
      const { getSessionToken } = await import('../services/apiClient.js')
      await window.posApi.sync.setCredentials({
        apiBaseUrl: getApiBaseUrl() || 'http://localhost:8787',
        authToken: getSessionToken(),
        expiresAt: expiresAt || new Date(Date.now() + 30 * 86400000).toISOString(),
        restaurantId: nextMembership.restaurantId,
      })
    } else {
      await window.posApi.sync.setCredentials({ authToken: null, apiBaseUrl: getApiBaseUrl() || 'http://localhost:8787' }).catch(() => {})
    }
  }

  useEffect(() => {
    if (isDemoSession()) {
      setLoading(false)
      return undefined
    }
    let active = true
    loadAuthSession()
      .then(async (session) => {
        if (!active || !session) return
        setUser(session.user)
        setMembership(session.membership)
        if (session.membership?.restaurantId) {
          window.sessionStorage.setItem('activeRestaurantId', session.membership.restaurantId)
          window.sessionStorage.setItem('activeUserId', session.user.uid)
          await updateSyncCredentials(session.user, session.membership, session.expiresAt)
        }
      })
      .catch(() => {
        if (!active) return
        setUser(null)
        setMembership(null)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function login(email, password) {
    clearDemoSession()
    const session = await loginWithPassword(email, password)
    setUser(session.user)
    setMembership(session.membership)
    if (session.membership?.restaurantId) {
      window.sessionStorage.setItem('activeRestaurantId', session.membership.restaurantId)
      window.sessionStorage.setItem('activeUserId', session.user.uid)
    }
    await updateSyncCredentials(session.user, session.membership, session.expiresAt)
    setLoading(false)
    return session
  }

  async function joinInvitation(details) {
    clearDemoSession()
    const session = await joinWithInvitation(details)
    setUser(session.user)
    setMembership(session.membership)
    if (session.membership?.restaurantId) {
      window.sessionStorage.setItem('activeRestaurantId', session.membership.restaurantId)
      window.sessionStorage.setItem('activeUserId', session.user.uid)
    }
    await updateSyncCredentials(session.user, session.membership, session.expiresAt)
    setLoading(false)
    return session
  }

  function enterDemo() {
    activateDemoSession()
    setUser(demoUser)
    setMembership(demoMembership)
    setLoading(false)
  }

  async function refreshMembership() {
    if (isDemoSession()) return demoMembership
    const session = await loadAuthSession()
    if (!session) {
      setUser(null)
      setMembership(null)
      return null
    }
    setUser(session.user)
    setMembership(session.membership)
    await updateSyncCredentials(session.user, session.membership, session.expiresAt)
    return session.membership
  }

  async function logout() {
    clearDemoSession()
    window.sessionStorage.removeItem('activeUserId')
    window.sessionStorage.removeItem('activeRestaurantId')
    setUser(null)
    setMembership(null)
    await logoutSession()
    await updateSyncCredentials(null, null)
  }

  return (
    <AuthContext.Provider value={{ user, membership, loading, login, joinInvitation, logout, refreshMembership, enterDemo }}>
      {children}
    </AuthContext.Provider>
  )
}
