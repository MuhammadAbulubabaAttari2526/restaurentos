import {
  addDoc,
  collection,
  doc,
  deleteDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'
import { db } from '../lib/firebase.js'
import { isDemoSession, removeDemoRecord, runDemoOperation, saveDemoRecord, watchDemoRecords } from './demoData.js'
import { runSparkOperation } from './sparkOperations.js'

export function isElectron() {
  return typeof window !== 'undefined' && Boolean(window.posApi?.isElectron)
}

// ─── Local Reactivity Bus for Electron Mode ─────────────────────────────────
const electronWatchers = new Map()
let syncStatusListenerAttached = false

function notifyWatchers(collectionName) {
  if (electronWatchers.has(collectionName)) {
    for (const watcher of electronWatchers.get(collectionName)) {
      watcher.fetch()
    }
  }
}

function notifyAllWatchers() {
  for (const set of electronWatchers.values()) {
    for (const watcher of set) {
      watcher.fetch()
    }
  }
}

function attachSyncStatusListener() {
  if (syncStatusListenerAttached || !isElectron()) return
  syncStatusListenerAttached = true
  window.posApi.sync.onStatusChange((status) => {
    // Whenever sync pull completes or queue updates, refresh active views
    if (status.status === 'idle' || status.status === 'syncing') {
      notifyAllWatchers()
    }
  })
}

export function restaurantCollection(restaurantId, name) {
  if (!db || !restaurantId) throw new Error('A configured Firebase restaurant session is required.')
  return collection(db, 'restaurants', restaurantId, name)
}

export function watchRecords(restaurantId, name, onData, onError, max = 100, filters = []) {
  if (isDemoSession()) return watchDemoRecords(name, onData, onError, max, filters)

  if (isElectron()) {
    attachSyncStatusListener()

    if (!electronWatchers.has(name)) {
      electronWatchers.set(name, new Set())
    }

    let isSubscribed = true
    const fetch = async () => {
      try {
        const records = await window.posApi.db.query(restaurantId, name, filters, max)
        if (isSubscribed) {
          onData(records || [])
        }
      } catch (err) {
        if (isSubscribed && onError) {
          onError(err)
        }
      }
    }

    const watcher = { fetch }
    electronWatchers.get(name).add(watcher)
    fetch()

    return () => {
      isSubscribed = false
      electronWatchers.get(name)?.delete(watcher)
    }
  }

  // Web Firebase Firestore mode
  const source = query(
    restaurantCollection(restaurantId, name),
    ...filters.map(([field, operator, value]) => where(field, operator, value)),
    orderBy('createdAt', 'desc'),
    limit(max),
  )
  return onSnapshot(source, (snapshot) => {
    onData(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })))
  }, onError)
}

export async function saveRecord(restaurantId, name, values, id) {
  if (isDemoSession()) return saveDemoRecord(name, values, id)

  if (isElectron()) {
    const savedId = await window.posApi.db.upsert(restaurantId, name, values, id)
    notifyWatchers(name)
    return savedId
  }

  const target = restaurantCollection(restaurantId, name)
  if (id) {
    await updateDoc(doc(target, id), { ...values, updatedAt: serverTimestamp() })
    return id
  }
  const record = await addDoc(target, { ...values, createdAt: serverTimestamp() })
  return record.id
}

export async function removeRecord(restaurantId, name, id) {
  if (isDemoSession()) return removeDemoRecord(name, id)

  if (isElectron()) {
    await window.posApi.db.delete(restaurantId, name, id)
    notifyWatchers(name)
    return
  }

  await deleteDoc(doc(restaurantCollection(restaurantId, name), id))
}

export async function runOperation(name, payload = {}) {
  if (isDemoSession()) return runDemoOperation(name, payload)

  if (isElectron()) {
    const restaurantId =
      payload.restaurantId ||
      window.sessionStorage.getItem('activeRestaurantId') ||
      'default'

    const result = await window.posApi.pos.runOperation(restaurantId, name, payload)
    notifyAllWatchers()
    return result
  }

  return runSparkOperation(name, payload)
}

export async function createOrder(payload) {
  return runOperation('createOrder', payload)
}

export async function recordPayment(payload) {
  return runOperation('recordPayment', payload)
}

export async function recordRefund(payload) {
  return runOperation('recordRefund', payload)
}

export async function transitionOrder(payload) {
  return runOperation('transitionOrder', payload)
}

export async function getDashboardSummary() {
  return runOperation('getDashboardSummary', {})
}

export async function exportReport(payload) {
  return runOperation('exportReport', payload)
}
