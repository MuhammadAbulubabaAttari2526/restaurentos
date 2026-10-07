import { useEffect, useState } from 'react'
import { onIdTokenChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, firebaseConfigured } from '../lib/firebase.js'
import { activateDemoSession, clearDemoSession, demoMembership, demoUser, isDemoSession } from '../services/demoData.js'
import AuthContext from './authContext.js'

async function getMembership(nextUser, forceRefresh = false) {
  const token = await nextUser.getIdTokenResult(forceRefresh)
  let restaurantId = token.claims.restaurantId
  let role = token.claims.role
  if ((!restaurantId || !role) && db) {
    const accountSnapshot = await getDoc(doc(db, 'accountMemberships', nextUser.uid))
    if (accountSnapshot.exists() && accountSnapshot.data().active === true) {
      restaurantId = accountSnapshot.data().restaurantId
      role = accountSnapshot.data().role
    }
  }
  if (!restaurantId || !['owner', 'manager', 'cashier', 'waiter'].includes(role) || !db) return null
  const memberSnapshot = await getDoc(doc(db, 'restaurants', restaurantId, 'users', nextUser.uid))
  if (!memberSnapshot.exists() || memberSnapshot.data().active !== true || memberSnapshot.data().role !== role) return null
  return { restaurantId, role, permissions: memberSnapshot.data().permissions || [] }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => isDemoSession() ? demoUser : null)
  const [membership, setMembership] = useState(() => isDemoSession() ? demoMembership : null)
  const [loading, setLoading] = useState(() => firebaseConfigured && !isDemoSession())

  useEffect(() => {
    if (isDemoSession()) return undefined
    if (!auth || !db) return undefined
    let activeUid = null
    let activeMembership = null

    async function updateSyncCredentials(nextUser, nextMembership, forceRefresh = false) {
      if (!window.posApi?.sync || !nextMembership?.restaurantId) return
      const token = await nextUser.getIdTokenResult(forceRefresh)
      await window.posApi.sync.setCredentials({
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        authToken: token.token,
        expiresAt: token.expirationTime,
        restaurantId: nextMembership.restaurantId,
      })
    }

    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      if (isDemoSession()) {
        setUser(demoUser)
        setMembership(demoMembership)
        setLoading(false)
        return
      }
      setLoading(true)
      setUser(nextUser)
      if (!nextUser) {
        activeUid = null
        activeMembership = null
        setMembership(null)
        setLoading(false)
        return
      }

      if (activeUid === nextUser.uid && activeMembership) {
        setMembership(activeMembership)
        try {
          await updateSyncCredentials(nextUser, activeMembership)
        } catch {}
        setLoading(false)
        return
      }

      try {
        const mem = await getMembership(nextUser)
        activeUid = nextUser.uid
        activeMembership = mem
        setMembership(mem)
        if (mem?.restaurantId) {
          window.sessionStorage.setItem('activeRestaurantId', mem.restaurantId)
          window.sessionStorage.setItem('activeUserId', nextUser.uid)
          await updateSyncCredentials(nextUser, mem)
        }
      } catch {
        if (activeUid !== nextUser.uid) setMembership(null)
      } finally {
        setLoading(false)
      }
    })

    const refreshInterval = setInterval(() => {
      if (auth.currentUser && activeMembership) {
        updateSyncCredentials(auth.currentUser, activeMembership, true).catch(() => {})
      }
    }, 45 * 60 * 1000)

    return () => {
      unsubscribe()
      clearInterval(refreshInterval)
    }
  }, [])

  async function login(email, password) {
    if (!auth) throw new Error('Firebase is not configured. Add the required values to .env.local.')
    clearDemoSession()
    const result = await signInWithEmailAndPassword(auth, email, password)
    const verifiedMembership = await getMembership(result.user, true)
    if (!verifiedMembership && !result.user.emailVerified) {
      await signOut(auth)
      throw new Error('Verify your email before continuing.')
    }
    setUser(result.user)
    setMembership(verifiedMembership)
    return result
  }

  function enterDemo() {
    activateDemoSession()
    setUser(demoUser)
    setMembership(demoMembership)
    setLoading(false)
  }

  async function refreshMembership(nextUser = auth?.currentUser) {
    if (isDemoSession()) return demoMembership
    if (!nextUser) {
      setUser(null)
      setMembership(null)
      return null
    }
    setUser(nextUser)
    const nextMembership = await getMembership(nextUser, true)
    setMembership(nextMembership)
    return nextMembership
  }

  async function logout() {
    clearDemoSession()
    window.sessionStorage.removeItem('activeUserId')
    setUser(null)
    setMembership(null)
    if (auth) await signOut(auth)
  }

  return (
    <AuthContext.Provider value={{ user, membership, loading, login, logout, refreshMembership, enterDemo }}>
      {children}
    </AuthContext.Provider>
  )
}
