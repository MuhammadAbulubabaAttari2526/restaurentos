/**
 * useSync.js
 *
 * React hook for sync status management.
 * Provides real-time sync state (online/offline/syncing/pending) to components.
 */

import { useEffect, useState, useCallback } from 'react'

async function checkWebReachability() {
  if (!navigator.onLine) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    await fetch('https://firestore.googleapis.com', {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export function useSync() {
  const [syncState, setSyncState] = useState({
    isOnline: true,
    status: 'idle',
    pendingCount: 0,
    needsAttentionCount: 0,
    lastSyncTime: null,
    error: null,
  })

  const isElectron = typeof window !== 'undefined' && window.posApi?.isElectron

  useEffect(() => {
    let mounted = true
    const syncApi = window.posApi?.sync
    const updateOnlineState = async () => {
      const browserOnline = navigator.onLine
      if (isElectron && syncApi) {
        try {
          const status = await syncApi.checkNetwork()
          if (mounted) setSyncState({ ...status, isOnline: browserOnline && status.isOnline })
          if (browserOnline && status.isOnline) syncApi.trigger().catch(() => {})
        } catch {}
        return
      }

      const online = await checkWebReachability()
      if (mounted) {
        setSyncState((previous) => ({
          ...previous,
          isOnline: browserOnline && online,
          status: browserOnline && online ? 'synced' : 'offline',
        }))
      }
    }

    const unsubscribe = isElectron && syncApi
      ? syncApi.onStatusChange((status) => {
          if (mounted) setSyncState({ ...status, isOnline: navigator.onLine && status.isOnline })
        })
      : undefined
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    updateOnlineState()

    return () => {
      mounted = false
      unsubscribe?.()
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [isElectron])

  const triggerSync = useCallback(() => {
    if (isElectron && window.posApi?.sync) {
      window.posApi.sync.trigger().catch(() => {})
    }
  }, [isElectron])

  return {
    ...syncState,
    triggerSync,
  }
}

export default useSync