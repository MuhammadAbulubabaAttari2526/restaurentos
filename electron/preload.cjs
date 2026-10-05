const { contextBridge, ipcRenderer } = require('electron')

// Strictly whitelisted API exposed to renderer window.
// Renderer process has NO access to Node.js, filesystem, or DB directly.
contextBridge.exposeInMainWorld('posApi', {
  isElectron: true,

  // System info
  system: {
    ping: () => ipcRenderer.invoke('system:ping'),
    getInfo: () => ipcRenderer.invoke('system:getInfo'),
  },

  // Database CRUD (all reads/writes go through main process → SQLite)
  db: {
    query:   (restaurantId, collection, filters, max) =>
               ipcRenderer.invoke('db:query',   restaurantId, collection, filters, max),
    upsert:  (restaurantId, collection, values, id) =>
               ipcRenderer.invoke('db:upsert',  restaurantId, collection, values, id),
    delete:  (restaurantId, collection, id) =>
               ipcRenderer.invoke('db:delete',  restaurantId, collection, id),
    getById: (restaurantId, collection, id) =>
               ipcRenderer.invoke('db:getById', restaurantId, collection, id),
  },

  // Sync engine (SQLite ↔ Firestore background sync)
  sync: {
    getStatus:       () => ipcRenderer.invoke('sync:getStatus'),
    trigger:         () => ipcRenderer.invoke('sync:trigger'),
    setCredentials:  (creds) => ipcRenderer.invoke('sync:setCredentials', creds),
    getPendingCount: () => ipcRenderer.invoke('sync:getPendingCount'),
    onStatusChange:  (callback) => {
      const listener = (_, status) => callback(status)
      ipcRenderer.on('sync:status-changed', listener)
      return () => ipcRenderer.removeListener('sync:status-changed', listener)
    },
  },

  // POS Domain Operations (runs ACID operations locally offline)
  pos: {
    runOperation: (restaurantId, name, payload) =>
      ipcRenderer.invoke('pos:runOperation', restaurantId, name, payload),
  },

  // Thermal Printing (ESC/POS – receipt & KOT)
  print: {
    receipt:           (payload) => ipcRenderer.invoke('print:receipt', payload),
    kot:               (payload) => ipcRenderer.invoke('print:kot', payload),
    test:              (payload) => ipcRenderer.invoke('print:test', payload),
    listPrinters:      (restaurantId) => ipcRenderer.invoke('print:listPrinters', restaurantId),
    listWindowsPrinters: () => ipcRenderer.invoke('print:listWindowsPrinters'),
  },

  // Offline Analytics & Reports
  reports: {
    getDailySummary:   (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:dailySummary', restaurantId, startDate, endDate),
    getItemsBreakdown: (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:itemsBreakdown', restaurantId, startDate, endDate),
    getHourly:         (restaurantId, dateString) =>
      ipcRenderer.invoke('reports:hourly', restaurantId, dateString),
    getPayments:       (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:payments', restaurantId, startDate, endDate),
    getTaxes:          (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:taxes', restaurantId, startDate, endDate),
    getDiscounts:      (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:discounts', restaurantId, startDate, endDate),
    getStaff:          (restaurantId, startDate, endDate) =>
      ipcRenderer.invoke('reports:staff', restaurantId, startDate, endDate),
  },

  // Database Backup & Restore
  backup: {
    create:       (reason) => ipcRenderer.invoke('backup:create', reason),
    list:         () => ipcRenderer.invoke('backup:list'),
    restore:      (filenameOrPath) => ipcRenderer.invoke('backup:restore', filenameOrPath),
    checkMissing: () => ipcRenderer.invoke('backup:checkMissing'),
  },

  // Safe Auto-Updater
  updater: {
    getStatus:  () => ipcRenderer.invoke('updater:getStatus'),
    checkNow:   () => ipcRenderer.invoke('updater:check'),
    installNow: () => ipcRenderer.invoke('updater:installNow'),
    // onStatusChange not needed here — wired below via ipcRenderer.on
  },
})

// Bridge IPC push events from main process → window CustomEvent
// This allows UpdateNotifier.jsx to listen via window.addEventListener('updater:status-changed')
ipcRenderer.on('updater:status-changed', (_event, state) => {
  window.dispatchEvent(new CustomEvent('updater:status-changed', { detail: state }))
})
