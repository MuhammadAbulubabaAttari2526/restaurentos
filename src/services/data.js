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

export function restaurantCollection(restaurantId, name) {
  if (!db || !restaurantId) throw new Error('A configured Firebase restaurant session is required.')
  return collection(db, 'restaurants', restaurantId, name)
}

export function watchRecords(restaurantId, name, onData, onError, max = 100, filters = []) {
  if (isDemoSession()) return watchDemoRecords(name, onData, onError, max, filters)
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
  await deleteDoc(doc(restaurantCollection(restaurantId, name), id))
}

export async function runOperation(name, payload) {
  if (isDemoSession()) return runDemoOperation(name, payload)
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
