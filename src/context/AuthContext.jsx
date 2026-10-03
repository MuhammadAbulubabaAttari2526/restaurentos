import { useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
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
    return onAuthStateChanged(auth, async (nextUser) => {
      if (isDemoSession()) {
        setUser(demoUser)
        setMembership(demoMembership)
        setLoading(false)
        return
      }
      setLoading(true)
      setUser(nextUser)
      try {
        setMembership(nextUser ? await getMembership(nextUser) : null)
      } catch {
        setMembership(null)
      } finally {
        setLoading(false)
      }
    })
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
