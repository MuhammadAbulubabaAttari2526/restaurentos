/**
 * syncService.js
 *
 * Offline-first synchronization service for RestaurantOS.
 * Handles bidirectional sync between SQLite (local) and Firestore (cloud).
 * 
 * Features:
 * - All reads/writes go to local SQLite first
 * - Automatic sync when online (debounced writes, network events, periodic)
 * - Conflict resolution using last-write-wins with updated_at timestamps
 * - Soft deletes with tombstone markers
 * - Batched writes to stay within Spark plan limits
 * - Pull direction for multi-device sync
 * - UUID-based document IDs to prevent duplicates
 */

import { db } from '../lib/firebase.js'
import { 
  collection, 
  doc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit,
  writeBatch
} from 'firebase/firestore'
import { useEffect, useState } from 'react'

const isElectron = () => typeof window !== 'undefined' && Boolean(window.posApi?.isElectron)
const sqliteQuery = (...args) => window.posApi.db.query(...args)
const sqliteUpsert = (...args) => window.posApi.db.upsert(...args)
const sqliteSoftDelete = (...args) => window.posApi.db.delete(...args)
const sqliteGetById = (...args) => window.posApi.db.getById(...args)

// Collections that should be synced between SQLite and Firestore
const SYNCABLE_COLLECTIONS = [
  'settings',
  'categories', 
  'menuItems',
  'tables',
  'reservations',
  'orders',
  'orderFinancials',
  'payments',
  'customers',
  'inventory',
  'inventoryItems',
  'suppliers',
  'taxes',
  'discounts',
  'waiters'
]

// Batch size for Firestore writes (Spark plan friendly)
const BATCH_SIZE = 400

// Sync intervals
const SYNC_INTERVAL_MS = 30000 // 30 seconds
const WRITE_DEBOUNCE_MS = 1000 // 1 second debounce for local writes

class SyncService {
  constructor() {
    this.isInitialized = false
    this.lastPullTimestamps = new Map() // collection -> last pull timestamp
    this.writeDebounceTimers = new Map() // collection -> debounce timer
    this.pendingWrites = new Map() // collection -> Set of record IDs
    this.syncInterval = null
    this.isSyncing = false
    this.lastError = null
    
    // Initialize last pull timestamps from localStorage (web) or SQLite (Electron)
    this.initializeLastPullTimestamps()
  }

  /**
   * Initialize the sync service
   * Should be called once at app startup
   */
  async initialize() {
    if (this.isInitialized) return

    if (isElectron()) {
      await window.posApi.sync.getStatus()
      this.isInitialized = true
      return
    }
    
    // Set up network listeners
    this.setupNetworkListeners()
    
    // Start periodic sync interval
    this.startSyncInterval()
    
    // Perform initial sync
    await this.performInitialSync()
    
    this.isInitialized = true
    console.log('Sync service initialized')
  }

  /**
   * Set up network event listeners for automatic sync triggering
   */
  setupNetworkListeners() {
    if (typeof window === 'undefined') return
    
    // Sync when coming online
    window.addEventListener('online', () => {
      console.log('Network: Online - triggering sync')
      this.triggerSync().catch(console.error)
    })
    
    // Optional: Sync periodically while online to catch changes
    window.addEventListener('offline', () => {
      console.log('Network: Offline')
    })
  }

  /**
   * Start the periodic sync interval
   */
  startSyncInterval() {
    if (this.syncInterval) return
    
    this.syncInterval = setInterval(async () => {
      if (await this.isOnline()) {
        await this.triggerSync().catch(console.error)
      }
    }, SYNC_INTERVAL_MS)
  }

  /**
   * Stop the periodic sync interval
   */
  stopSyncInterval() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval)
      this.syncInterval = null
    }
  }

  /**
   * Check if we're online using multiple methods
   */
  async isOnline() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false
    }
    
    // Additional check: try to reach Firestore
    try {
      await fetch('https://firestore.googleapis.com/', { 
        method: 'HEAD', 
        timeout: 5000 
      })
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Perform initial sync on app startup
   */
  async performInitialSync() {
    if (isElectron()) return window.posApi.sync.trigger()
    try {
      console.log('Performing initial sync...')
      
      // 1. Pull any changes from Firestore that happened while we were offline
      await this.pullFromFirestore()
      
      // 2. Push any pending local changes to Firestore
      await this.pushToFirestore()
      
      console.log('Initial sync completed')
    } catch (error) {
      console.error('Initial sync failed:', error)
      this.lastError = error.message
      throw error
    }
  }

  /**
   * Trigger a manual sync
   */
  async triggerSync() {
    if (isElectron()) return window.posApi.sync.trigger()
    if (this.isSyncing) {
      console.log('Sync already in progress, skipping')
      return
    }
    
    if (!(await this.isOnline())) {
      console.log('Offline, skipping sync')
      return
    }
    
    this.isSyncing = true
    this.lastError = null
    
    try {
      console.log('Starting manual sync...')
      
      // 1. Pull changes from Firestore
      await this.pullFromFirestore()
      
      // 2. Push local changes to Firestore
      await this.pushToFirestore()
      
      console.log('Manual sync completed')
    } catch (error) {
      console.error('Manual sync failed:', error)
      this.lastError = error.message
      throw error
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * Pull changes from Firestore to SQLite (last-write-wins conflict resolution)
   */
  async pullFromFirestore() {
    if (isElectron()) return window.posApi.sync.trigger()
    if (!(await this.isOnline())) return
    
    try {
      console.log('Pulling from Firestore...')
      
      for (const collectionName of SYNCABLE_COLLECTIONS) {
        await this.pullCollection(collectionName)
      }
      
      console.log('Pull from Firestore completed')
    } catch (error) {
      console.error('Pull from Firestore failed:', error)
      throw error
    }
  }

  /**
   * Pull a specific collection from Firestore
   */
  async pullCollection(collectionName) {
    const lastPullTime = this.lastPullTimestamps.get(collectionName) || 
                        this.getInitialPullTimestamp(collectionName)
    
    try {
      const colRef = collection(db, 'restaurants', await this.getRestaurantId(), collectionName)
      
      // Query for documents updated since last pull
      const q = query(
        colRef,
        where('updatedAt', '>', new Date(lastPullTime)),
        orderBy('updatedAt', 'asc'),
        limit(500) // Limit to prevent overwhelming
      )
      
      const querySnapshot = await getDocs(q)
      const changes = []
      
      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data()
        changes.push({
          id: docSnap.id,
          ...data,
          // Ensure we have the sync metadata
          syncStatus: 'synced',
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt || new Date().toISOString()
        })
      })
      
      if (changes.length > 0) {
        console.log(`Pulling ${changes.length} changes from ${collectionName}`)
        
        // Apply changes to SQLite with conflict resolution
        for (const change of changes) {
          await this.applyFirestoreChangeToSQLite(collectionName, change)
        }
        
        // Update last pull timestamp
        const latestChange = changes[changes.length - 1]
        const latestTimestamp = latestChange.updatedAt || new Date().toISOString()
        this.lastPullTimestamps.set(collectionName, latestTimestamp)
        this.saveLastPullTimestamp(collectionName, latestTimestamp)
      }
    } catch (error) {
      console.error(`Failed to pull collection ${collectionName}:`, error)
      // Don't throw - continue with other collections
    }
  }

  /**
   * Get initial pull timestamp for a collection (from local storage or default)
   */
  getInitialPullTimestamp(collectionName) {
    if (typeof window === 'undefined') return '1970-01-01T00:00:00.000Z'
    
    const key = `restaurantos_last_pull_${collectionName}`
    const saved = localStorage.getItem(key)
    return saved || '1970-01-01T00:00:00.000Z'
  }

  /**
   * Save last pull timestamp to local storage
   */
  saveLastPullTimestamp(collectionName, timestamp) {
    if (typeof window === 'undefined') return
    
    const key = `restaurantos_last_pull_${collectionName}`
    localStorage.setItem(key, timestamp)
  }

  /**
   * Apply a Firestore change to SQLite with last-write-wins conflict resolution
   */
  async applyFirestoreChangeToSQLite(collectionName, firestoreDoc) {
    try {
      // Get current local record
      const restaurantId = await this.getRestaurantId()
      const localRecord = await sqliteGetById(
        restaurantId,
        collectionName, 
        firestoreDoc.id
      )
      
      const firestoreTime = new Date(firestoreDoc.updatedAt).getTime()
      
      if (localRecord) {
        // Compare timestamps for conflict resolution
        const localTime = new Date(localRecord.updatedAt).getTime()
        
        if (firestoreTime > localTime) {
          // Firestore version is newer - update local
          await sqliteUpsert(
            restaurantId,
            collectionName,
            firestoreDoc,
            firestoreDoc.id
          )
        }
        // If local is newer or equal, keep local (last-write-wins favors newer)
      } else {
        // No local record exists - insert from Firestore
        await sqliteUpsert(
          restaurantId,
          collectionName,
          firestoreDoc,
          firestoreDoc.id
        )
      }
    } catch (error) {
      console.error(`Failed to apply Firestore change to SQLite for ${collectionName}:`, error)
      throw error
    }
  }

  /**
   * Push pending local changes to Firestore
   */
  async pushToFirestore() {
    if (isElectron()) return window.posApi.sync.trigger()
    if (!(await this.isOnline())) return
    
    try {
      console.log('Pushing to Firestore...')
      
      for (const collectionName of SYNCABLE_COLLECTIONS) {
        await this.pushCollection(collectionName)
      }
      
      console.log('Push to Firestore completed')
    } catch (error) {
      console.error('Push to Firestore failed:', error)
      throw error
    }
  }

  /**
   * Push a specific collection to Firestore
   */
  async pushCollection(collectionName) {
    if (isElectron()) return window.posApi.sync.trigger()
    try {
      // Get pending changes from SQLite sync queue or check sync_status
      const pendingRecords = await this.getPendingLocalChanges(collectionName)
      
      if (pendingRecords.length === 0) return
      
      console.log(`Pushing ${pendingRecords.length} changes from ${collectionName}`)
      
      // Process in batches to stay within limits
      for (let i = 0; i < pendingRecords.length; i += BATCH_SIZE) {
        const batch = pendingRecords.slice(i, i + BATCH_SIZE)
        await this.writeBatchToFirestore(collectionName, batch)
      }
      
      // Mark records as synced in SQLite
      await this.markAsSynced(collectionName, pendingRecords.map(r => r.id))
    } catch (error) {
      console.error(`Failed to push collection ${collectionName}:`, error)
      throw error
    }
  }

  /**
   * Get pending local changes that need to be pushed to Firestore
   */
  async getPendingLocalChanges(collectionName) {
    try {
      const restaurantId = await this.getRestaurantId()
      
      // Query for records that are not synced or have pending status
      const records = await sqliteQuery(
        restaurantId,
        collectionName,
        [
          ['syncStatus', '!=', 'synced']
        ],
        1000 // Reasonable limit
      )
      
      return records
    } catch (error) {
      console.error(`Failed to get pending local changes for ${collectionName}:`, error)
      return []
    }
  }

  /**
   * Write a batch of records to Firestore
   */
  async writeBatchToFirestore(collectionName, records) {
    if (isElectron()) return window.posApi.sync.trigger()
    if (!(await this.isOnline())) return
    
    try {
      const restaurantId = await this.getRestaurantId()
      const batch = writeBatch(db)
      
      for (const record of records) {
        // Ensure we have a UUID for Firestore document ID
        const docId = record.id || window.crypto.randomUUID()
        
        // Prepare data for Firestore (remove local-only fields)
        const firestoreData = this.prepareForFirestore(record)
        
        const docRef = doc(db, 'restaurants', restaurantId, collectionName, docId)
        batch.set(docRef, firestoreData, { merge: true })
      }
      
      await batch.commit()
      console.log(`Wrote batch of ${records.length} records to ${collectionName}`)
    } catch (error) {
      console.error(`Failed to write batch to Firestore for ${collectionName}:`, error)
      throw error
    }
  }

  /**
   * Prepare a SQLite record for Firestore (remove local-only fields)
   */
  prepareForFirestore(record) {
    const { 
      syncStatus, 
      version, 
      created_at, 
      updated_at, 
      deleted_at,
      restaurant_id,
      ...firestoreData
    } = record
    
    // Convert Date objects to Firestore timestamps where needed
    const preparedData = {}
    
    for (const [key, value] of Object.entries(firestoreData)) {
      if (value instanceof Date) {
        preparedData[key] = value
      } else if (value !== null && value !== undefined) {
        preparedData[key] = value
      }
    }
    
    // Ensure we have timestamps
    if (!preparedData.createdAt) {
      preparedData.createdAt = new Date()
    }
    if (!preparedData.updatedAt) {
      preparedData.updatedAt = new Date()
    }
    
    return preparedData
  }

  /**
   * Mark records as synced in SQLite
   */
  async markAsSynced(collectionName, recordIds) {
    if (isElectron()) return window.posApi.sync.trigger()
    try {
      const restaurantId = await this.getRestaurantId()
      
      for (const id of recordIds) {
        const record = await sqliteGetById(restaurantId, collectionName, id)
        if (record) await sqliteUpsert(restaurantId, collectionName, { ...record, syncStatus: 'synced' }, id)
      }
    } catch (error) {
      console.error(`Failed to mark records as synced for ${collectionName}:`, error)
      throw error
    }
  }

  /**
   * Get table name for a collection
   */
  getTableName(collectionName) {
    const tableMap = {
      settings: 'settings',
      categories: 'categories',
      menuItems: 'menu_items',
      tables: 'tables',
      reservations: 'reservations',
      orders: 'orders',
      orderFinancials: 'order_financials',
      payments: 'payments',
      customers: 'customers',
      inventory: 'inventory',
      inventoryItems: 'inventory',
      suppliers: 'suppliers',
      taxes: 'taxes',
      discounts: 'discounts',
      waiters: 'waiters'
    }
    
    return tableMap[collectionName] || collectionName
  }

  /**
   * Get current restaurant ID from auth context
   */
  async getRestaurantId() {
    if (typeof window !== 'undefined' && window.posApi) {
      // Electron version - get from IPC
      const status = await window.posApi.sync.getStatus()
      return status.restaurantId
    } else {
      // Web version - get from auth context
      // This would need to be implemented based on your auth context
      return 'current-restaurant-id' // Placeholder
    }
  }

  /**
   * Initialize last pull timestamps from storage
   */
  initializeLastPullTimestamps() {
    if (typeof window === 'undefined') return
    
    for (const collectionName of SYNCABLE_COLLECTIONS) {
      const timestamp = this.getInitialPullTimestamp(collectionName)
      this.lastPullTimestamps.set(collectionName, timestamp)
    }
  }

  /**
   * Debounced write to local SQLite that also marks for sync
   */
  async debouncedWrite(collectionName, record) {
    if (isElectron()) {
      const restaurantId = await this.getRestaurantId()
      const recordId = record.id || window.crypto.randomUUID()
      return sqliteUpsert(restaurantId, collectionName, record, recordId)
    }
    // Clear existing debounce timer
    if (this.writeDebounceTimers.has(collectionName)) {
      clearTimeout(this.writeDebounceTimers.get(collectionName))
    }
    
    // Set new debounce timer
    this.writeDebounceTimers.set(collectionName, setTimeout(async () => {
      try {
        // Write to local SQLite first
        const restaurantId = await this.getRestaurantId()
        const recordId = record.id || window.crypto.randomUUID()
        
        // Ensure record has sync metadata
        const recordWithSync = {
          ...record,
          id: recordId,
          syncStatus: 'pending',
          updatedAt: new Date().toISOString(),
          createdAt: record.createdAt || new Date().toISOString()
        }
        
        // Upsert to SQLite
        await sqliteUpsert(restaurantId, collectionName, recordWithSync, recordId)
        
        // Mark for sync
        if (!this.pendingWrites.has(collectionName)) {
          this.pendingWrites.set(collectionName, new Set())
        }
        this.pendingWrites.get(collectionName).add(recordId)
        
        console.log(`Debounced write completed for ${collectionName}:${recordId}`)
      } catch (error) {
        console.error(`Debounced write failed for ${collectionName}:`, error)
      } finally {
        this.writeDebounceTimers.delete(collectionName)
      }
    }, WRITE_DEBOUNCE_MS))
  }

  /**
   * Soft delete a record (marks for deletion in SQLite and Firestore)
   */
  async softDelete(collectionName, recordId) {
    if (isElectron()) {
      return sqliteSoftDelete(await this.getRestaurantId(), collectionName, recordId)
    }
    try {
      const restaurantId = await this.getRestaurantId()
      
      // Soft delete in SQLite
      await sqliteSoftDelete(restaurantId, collectionName, recordId)
      
      // Mark for sync
      if (!this.pendingWrites.has(collectionName)) {
        this.pendingWrites.set(collectionName, new Set())
      }
      this.pendingWrites.get(collectionName).add(recordId)
      
      console.log(`Soft deleted ${collectionName}:${recordId}`)
    } catch (error) {
      console.error(`Soft delete failed for ${collectionName}:${recordId}:`, error)
      throw error
    }
  }

  /**
   * Get current sync status
   */
  async getStatus() {
    if (isElectron()) return window.posApi.sync.getStatus()
    try {
      const isOnline = await this.isOnline()
      let status = 'idle'
      
      if (!isOnline) {
        status = 'offline'
      } else if (this.isSyncing) {
        status = 'syncing'
      } else if (this.lastError) {
        status = 'error'
      }
      
      // Calculate pending count
      let pendingCount = 0
      for (const [collectionName, pendingSet] of this.pendingWrites) {
        pendingCount += pendingSet.size
      }
      
      return {
        isOnline,
        status,
        pendingCount,
        lastSyncTime: this.lastSyncTime || null,
        error: this.lastError || null
      }
    } catch (error) {
      return {
        isOnline: false,
        status: 'error',
        pendingCount: 0,
        lastSyncTime: null,
        error: error.message
      }
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (isElectron()) return
    this.stopSyncInterval()
    
    // Clear all debounce timers
    for (const [collectionName, timer] of this.writeDebounceTimers) {
      clearTimeout(timer)
    }
    this.writeDebounceTimers.clear()
  }
}

// Create and export singleton instance
const syncService = new SyncService()
export default syncService

// Export helper functions for use in components
export function useSyncStatus() {
  const [status, setStatus] = useState({
    isOnline: true,
    status: 'idle',
    pendingCount: 0,
    lastSyncTime: null,
    error: null
  })
  
  useEffect(() => {
    let isMounted = true
    
    const updateStatus = async () => {
      if (!isMounted) return
      try {
        const newStatus = await syncService.getStatus()
        setStatus(newStatus)
      } catch (error) {
        console.error('Failed to get sync status:', error)
      }
    }
    
    // Initial load
    updateStatus()
    
    // Poll every 5 seconds for updates
    const interval = setInterval(updateStatus, 5000)
    
    return () => {
      isMounted = false
      clearInterval(interval)
      syncService.cleanup()
    }
  }, [])
  
  return status
}

export function useSyncActions() {
  const triggerSync = useCallback(async () => {
    await syncService.triggerSync()
  }, [])
  
  const debouncedWrite = useCallback((collectionName, record) => {
    syncService.debouncedWrite(collectionName, record)
  }, [])
  
  const softDelete = useCallback((collectionName, recordId) => {
    syncService.softDelete(collectionName, recordId)
  }, [])
  
  return { triggerSync, debouncedWrite, softDelete }
}