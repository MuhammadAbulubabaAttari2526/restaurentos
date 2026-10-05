import { useEffect, useState, useRef } from 'react'
import { onIdTokenChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, firebaseConfigured } from '../lib/firebase.js'
import { activateDemoSession, clearDemoSession, demoMembership, demoUser, isDemoSession } from '../services/demoData.js'
import AuthContext from './authContext.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Checks whether we're running inside the Electron shell with posApi available */
function isElectron() {
  return typeof window !== 'undefined' && window.posApi?.isElectron === true
}

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

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => isDemoSession() ? demoUser : null)
  const [membership, setMembership] = useState(() => isDemoSession() ? demoMembership : null)
  const [loading, setLoading] = useState(() => firebaseConfigured && !isDemoSession())

  // Track if we've attempted session restore (avoid double-restore)
  const sessionRestoreAttempted = useRef(false)

  useEffect(() => {
    if (isDemoSession()) return undefined
    if (!auth || !db) {
      // No Firebase – try Electron offline session restore
      if (isElectron() && !sessionRestoreAttempted.current) {
        sessionRestoreAttempted.current = true
        _trySessionRestore().catch(() => setLoading(false))
      } else {
        setLoading(false)
      }
      return undefined
    }

    // 1. Listen to auth state and token renewals via onIdTokenChanged
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      if (isDemoSession()) {
        setUser(demoUser)
        setMembership(demoMembership)
        setLoading(false)
        return
      }
      setLoading(true)
      setUser(nextUser)
      try {
        const mem = nextUser ? await getMembership(nextUser) : null
        setMembership(mem)
        if (mem?.restaurantId && nextUser) {
          window.sessionStorage.setItem('activeRestaurantId', mem.restaurantId)
          window.sessionStorage.setItem('activeUid', nextUser.uid)

          if (isElectron() && window.posApi?.sync) {
            const token = await nextUser.getIdToken()
            window.posApi.sync.setCredentials({
              projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
              authToken: token,
              restaurantId: mem.restaurantId,
            })
            // Also keep cached token fresh for offline session restore
            window.posApi.auth?.updateToken({ uid: nextUser.uid, token })
          }
        }
      } catch {
        setMembership(null)
      } finally {
        setLoading(false)
      }
    })

    // 2. Force refresh token every 45 minutes while app is active
    const tokenRefreshInterval = setInterval(async () => {
      if (auth?.currentUser && isElectron()) {
        try {
          const refreshedToken = await auth.currentUser.getIdToken(true)
          const resId = window.sessionStorage.getItem('activeRestaurantId')
          const uid = window.sessionStorage.getItem('activeUid')
          if (resId && refreshedToken) {
            window.posApi?.sync?.setCredentials({
              projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
              authToken: refreshedToken,
              restaurantId: resId,
            })
          }
          if (uid && refreshedToken) {
            window.posApi?.auth?.updateToken({ uid, token: refreshedToken })
          }
        } catch (err) {
          console.warn('[AuthContext] Token auto-refresh error:', err?.message)
        }
      }
    }, 45 * 60 * 1000)

    return () => {
      unsubscribe()
      clearInterval(tokenRefreshInterval)
    }
  }, [])

  // ── Offline session restore (Electron only) ──────────────────────────────
  async function _trySessionRestore() {
    if (!isElectron() || !window.posApi?.auth) return
    const uid = window.sessionStorage.getItem('activeUid')
    if (!uid) { setLoading(false); return }

    try {
      const result = await window.posApi.auth.sessionRestore({ uid })
      if (result?.ok && result.session) {
        const s = result.session
        // Hydrate as an offline user object (no Firebase user instance)
        const offlineUser = {
          uid: s.uid,
          email: s.email,
          displayName: s.displayName,
          isOfflineSession: true,
        }
        const offlineMembership = {
          restaurantId: s.restaurantId,
          role: s.role,
          permissions: s.permissions,
        }
        setUser(offlineUser)
        setMembership(offlineMembership)
        window.sessionStorage.setItem('activeRestaurantId', s.restaurantId)

        // Supply cached credentials to sync worker so it can try online
        if (s.lastToken && window.posApi?.sync) {
          window.posApi.sync.setCredentials({
            projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
            authToken: s.lastToken,
            restaurantId: s.restaurantId,
          })
        }
      }
    } catch (err) {
      console.warn('[AuthContext] Session restore failed:', err?.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Online login (Firebase + cache credentials for offline) ───────────────
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

    // Cache credentials in SQLite auth_cache for future offline login
    if (isElectron() && window.posApi?.auth && verifiedMembership) {
      try {
        const token = await result.user.getIdToken()
        window.sessionStorage.setItem('activeUid', result.user.uid)
        await window.posApi.auth.cacheCredentials({
          uid: result.user.uid,
          email: result.user.email,
          displayName: result.user.displayName || '',
          role: verifiedMembership.role,
          restaurantId: verifiedMembership.restaurantId,
          permissions: verifiedMembership.permissions || [],
          password, // plaintext – main process hashes it; never stored raw
          lastToken: token,
        })
      } catch (err) {
        // Non-fatal: online login succeeded, offline cache is best-effort
        console.warn('[AuthContext] Credential caching failed:', err?.message)
      }
    }

    return result
  }

  // ── Offline login fallback (Electron only) ────────────────────────────────
  async function offlineLogin(email, password) {
    if (!isElectron() || !window.posApi?.auth) {
      throw new Error('Offline login is only available in the desktop app.')
    }
    const result = await window.posApi.auth.offlineLogin({ email, password })
    if (!result?.ok) {
      if (result?.reason === 'not_cached') {
        throw new Error('No offline credentials found. Please connect to the internet and login at least once.')
      }
      if (result?.reason === 'locked') {
        const until = result.lockedUntil
          ? new Date(result.lockedUntil).toLocaleTimeString()
          : 'some time'
        throw new Error(`Account locked due to too many failed attempts. Try again after ${until}.`)
      }
      const remaining = result?.attemptsRemaining
      const suffix = remaining !== undefined ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)` : ''
      throw new Error(`Incorrect password.${suffix}`)
    }

    const s = result.user
    const offlineUser = {
      uid: s.uid,
      email: s.email,
      displayName: s.displayName,
      isOfflineSession: true,
    }
    const offlineMembership = {
      restaurantId: s.restaurantId,
      role: s.role,
      permissions: s.permissions,
    }
    setUser(offlineUser)
    setMembership(offlineMembership)
    window.sessionStorage.setItem('activeRestaurantId', s.restaurantId)
    window.sessionStorage.setItem('activeUid', s.uid)

    // Attempt background re-verification when connectivity is restored
    _scheduleBackgroundReVerification(s.uid, email, password)

    return { user: offlineUser, membership: offlineMembership }
  }

  // ── Background re-verification (after offline login, reconnect = verify online) ──
  function _scheduleBackgroundReVerification(uid, email, password) {
    if (!isElectron() || !auth) return
    // Try online verification every 30s for up to 5 minutes
    let attempts = 0
    const MAX_ATTEMPTS = 10
    const interval = setInterval(async () => {
      attempts++
      if (attempts > MAX_ATTEMPTS) {
        clearInterval(interval)
        return
      }
      try {
        const result = await signInWithEmailAndPassword(auth, email, password)
        if (result?.user) {
          const mem = await getMembership(result.user, true)
          clearInterval(interval)
          setUser(result.user)
          if (mem) {
            setMembership(mem)
            // Refresh the cache with the confirmed online token
            const token = await result.user.getIdToken()
            await window.posApi?.auth?.cacheCredentials({
              uid: result.user.uid,
              email: result.user.email,
              displayName: result.user.displayName || '',
              role: mem.role,
              restaurantId: mem.restaurantId,
              permissions: mem.permissions || [],
              password,
              lastToken: token,
            })
            window.posApi?.sync?.setCredentials({
              projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
              authToken: token,
              restaurantId: mem.restaurantId,
            })
          }
        }
      } catch {
        // Still offline or wrong credentials — will retry
      }
    }, 30_000)
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
    const uid = window.sessionStorage.getItem('activeUid')
    setUser(null)
    setMembership(null)
    window.sessionStorage.removeItem('activeRestaurantId')
    window.sessionStorage.removeItem('activeUid')
    if (auth) await signOut(auth)
    // Clear sync credentials so auth-required state resets on next login
    window.posApi?.sync?.setCredentials({ authToken: null })
  }

  return (
    <AuthContext.Provider value={{ user, membership, loading, login, offlineLogin, logout, refreshMembership, enterDemo }}>
      {children}
    </AuthContext.Provider>
  )
}
