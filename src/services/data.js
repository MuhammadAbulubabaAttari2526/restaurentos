import { apiRequest } from './apiClient.js'
import { isDemoSession, removeDemoRecord, runDemoOperation, saveDemoRecord, watchDemoRecords } from './demoData.js'

const WEB_REFRESH_MS = 5000

export function isElectron() {
  return typeof window !== 'undefined' && Boolean(window.posApi?.isElectron)
}

function callDataFunction(name, payload = {}) {
  return apiRequest(name, { method: 'POST', body: payload }).then((result) => result.data)
}

// Local Reactivity Bus for Electron Mode
const electronWatchers = new Map()
let syncStatusListenerAttached = false

function notifyWatchers(collectionName) {
  for (const watcher of electronWatchers.get(collectionName) || []) watcher.fetch()
}

function notifyAllWatchers() {
  for (const watchers of electronWatchers.values()) {
    for (const watcher of watchers) watcher.fetch()
  }
}

function attachSyncStatusListener() {
  if (syncStatusListenerAttached || !isElectron()) return
  syncStatusListenerAttached = true
  window.posApi.sync.onStatusChange((status) => {
    if (status.status === 'idle' || status.status === 'syncing') notifyAllWatchers()
  })
}

export function watchRecords(restaurantId, name, onData, onError, max = 100, filters = []) {
  if (isDemoSession()) return watchDemoRecords(name, onData, onError, max, filters)

  if (isElectron()) {
    attachSyncStatusListener()
    if (!electronWatchers.has(name)) electronWatchers.set(name, new Set())
    let subscribed = true
    let fetching = false
    let lastError = ''
    const fetch = async () => {
      if (!subscribed || fetching) return
      fetching = true
      try {
        const records = await window.posApi.db.query(restaurantId, name, filters, max)
        if (subscribed) onData(records || [])
        lastError = ''
      } catch (error) {
        if (subscribed && onError && error.message !== lastError) onError(error)
        lastError = error.message
      } finally {
        fetching = false
      }
    }
    const watcher = { fetch }
    electronWatchers.get(name).add(watcher)
    fetch()
    return () => {
      subscribed = false
      electronWatchers.get(name)?.delete(watcher)
    }
  }

  let subscribed = true
  let fetching = false
  let lastError = ''
  const fetch = async () => {
    if (!subscribed || fetching) return
    fetching = true
    try {
      const records = await callDataFunction('getRecords', { restaurantId, collection: name, max, filters })
      if (subscribed) onData(records || [])
      lastError = ''
    } catch (error) {
      if (subscribed && onError && error.message !== lastError) onError(error)
      lastError = error.message
    } finally {
      fetching = false
    }
  }
  fetch()
  const interval = setInterval(fetch, WEB_REFRESH_MS)
  return () => {
    subscribed = false
    clearInterval(interval)
  }
}

export async function saveRecord(restaurantId, name, values, id) {
  if (isDemoSession()) return saveDemoRecord(name, values, id)
  if (isElectron()) {
    const savedId = await window.posApi.db.upsert(restaurantId, name, values, id)
    notifyWatchers(name)
    return savedId
  }
  const result = await callDataFunction('saveRecord', { restaurantId, collection: name, values, id: id || null })
  return result.id
}

export async function removeRecord(restaurantId, name, id) {
  if (isDemoSession()) return removeDemoRecord(name, id)
  if (isElectron()) {
    await window.posApi.db.delete(restaurantId, name, id)
    notifyWatchers(name)
    return
  }
  await callDataFunction('removeRecord', { restaurantId, collection: name, id })
}

export async function runOperation(name, payload = {}) {
  if (isDemoSession()) return runDemoOperation(name, payload)
  if (isElectron()) {
    const restaurantId = payload.restaurantId || window.sessionStorage.getItem('activeRestaurantId') || 'default'
    const actorId = window.sessionStorage.getItem('activeUserId')
    const localPayload = { ...payload, createdBy: payload.createdBy || actorId, recordedBy: payload.recordedBy || actorId }
    const result = await window.posApi.pos.runOperation(restaurantId, name, localPayload)
    notifyAllWatchers()
    return result
  }
  const result = await callDataFunction(name, payload)
  notifyAllWatchers()
  return result
}

export async function getMembership() {
  return callDataFunction('getMembership')
}

export async function getStaffInvitation(restaurantId, invitationId) {
  return callDataFunction('getStaffInvitation', { restaurantId, invitationId })
}

export async function completeStaffInvite(restaurantId, invitationId) {
  return callDataFunction('completeStaffInvite', { restaurantId, invitationId })
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
