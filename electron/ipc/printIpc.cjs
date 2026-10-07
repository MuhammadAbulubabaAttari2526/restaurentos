/**
 * printIpc.cjs
 *
 * IPC handlers for thermal receipt printing.
 * Exposes print channels to the renderer via posApi.print.
 *
 * Channels:
 *   print:receipt       – print customer bill receipt
 *   print:kot           – print kitchen order ticket
 *   print:test          – print a test page to verify connectivity
 *   print:listPrinters  – return list of saved printers for this restaurant
 *   print:listWindows   – return list of Windows printer names (driver)
 */

const { ipcMain } = require('electron')
const { getDb } = require('../../database/sqliteClient.cjs')
const genericRepository = require('../../database/repositories/genericRepository.cjs')
const { formatReceipt } = require('../../printing/receiptFormatter.cjs')
const { formatKot } = require('../../printing/kotFormatter.cjs')
const { printBuffer, listWindowsPrinters } = require('../../printing/printerManager.cjs')
const { builder } = require('../../printing/escpos.cjs')
const { beginActivity } = require('../activityMonitor.cjs')

let _registered = false

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDefaultPrinter(restaurantId) {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT * FROM printers WHERE restaurant_id = ? AND is_default = 1 ORDER BY created_at DESC LIMIT 1'
    )
    .get(restaurantId)
  if (!row) {
    const any = db
      .prepare('SELECT * FROM printers WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(restaurantId)
    return any || null
  }
  return row
}

function getPrinterById(restaurantId, printerId) {
  const db = getDb()
  return db
    .prepare('SELECT * FROM printers WHERE id = ? AND restaurant_id = ?')
    .get(printerId, restaurantId) || null
}

function resolveAndPrint(buf, restaurantId, printerId) {
  const printer = printerId
    ? getPrinterById(restaurantId, printerId) || getDefaultPrinter(restaurantId)
    : getDefaultPrinter(restaurantId)

  if (!printer) {
    throw new Error('No printer configured. Please add a printer in Settings.')
  }

  return printBuffer(buf, printer)
}

// ─── Registration ─────────────────────────────────────────────────────────────

function registerPrintIpc() {
  if (_registered) return
  _registered = true

  /**
   * Print customer receipt
   * payload: { restaurantId, orderId, printerId? }
   */
  ipcMain.handle('print:receipt', async (_, payload) => {
    const finishActivity = beginActivity()
    try {
    const { restaurantId, orderId, printerId, openCashDrawer = false } = payload || {}
    if (!restaurantId || !orderId) throw new Error('restaurantId and orderId are required')

    const order    = genericRepository.getById(restaurantId, 'orders', orderId)
    if (!order) throw new Error('Order not found')

    const financial = genericRepository.getById(restaurantId, 'orderFinancials', orderId)
    const payments  = genericRepository.query(restaurantId, 'payments', [['orderId', '==', orderId]], 50)
    const settingsList = genericRepository.query(restaurantId, 'settings', [], 5)
    const settings  = (settingsList.find((s) => s.id === 'profile') || settingsList[0] || {})

    const printer   = printerId
      ? getPrinterById(restaurantId, printerId) || getDefaultPrinter(restaurantId)
      : getDefaultPrinter(restaurantId)
    if (!printer) throw new Error('No printer configured. Please add a printer in Settings.')

    const buf = formatReceipt({
      order,
      financial: financial || {},
      payments,
      settings,
      printer: { paperWidth: printer.paper_width || 80, copies: printer.copies || 1 },
      options: { openCashDrawer },
    })

    await printBuffer(buf, printer)
    return { success: true, bytesWritten: buf.length }
    } finally {
      finishActivity()
    }
  })

  /**
   * Print KOT (Kitchen Order Ticket)
   * payload: { restaurantId, orderId, printerId? }
   */
  ipcMain.handle('print:kot', async (_, payload) => {
    const finishActivity = beginActivity()
    try {
    const { restaurantId, orderId, printerId, kotLabel } = payload || {}
    if (!restaurantId || !orderId) throw new Error('restaurantId and orderId are required')

    const order = genericRepository.getById(restaurantId, 'orders', orderId)
    if (!order) throw new Error('Order not found')

    const printer = printerId
      ? getPrinterById(restaurantId, printerId) || getDefaultPrinter(restaurantId)
      : getDefaultPrinter(restaurantId)
    if (!printer) throw new Error('No printer configured.')

    const buf = formatKot({
      order,
      printer: { paperWidth: printer.paper_width || 80, copies: printer.copies || 1 },
      options: { kotLabel },
    })

    await printBuffer(buf, printer)
    return { success: true, bytesWritten: buf.length }
    } finally {
      finishActivity()
    }
  })

  /**
   * Print test page
   * payload: { restaurantId, printerId? }
   */
  ipcMain.handle('print:test', async (_, payload) => {
    const finishActivity = beginActivity()
    try {
    const { restaurantId, printerId } = payload || {}
    if (!restaurantId) throw new Error('restaurantId is required')

    const printer = printerId
      ? getPrinterById(restaurantId, printerId) || getDefaultPrinter(restaurantId)
      : getDefaultPrinter(restaurantId)
    if (!printer) throw new Error('No printer configured.')

    const b = builder({ paperWidth: printer.paper_width || 80 })
    b.center()
     .bold(true).large(true).line('TEST PAGE').large(false).bold(false)
     .rule()
     .line('RestaurantOS Desktop POS')
     .line('Printer connection successful!')
     .rule()
     .left()
     .row('Printer:', printer.name || '-')
     .row('Type:', printer.connection_type || '-')
     .row('IP:', printer.ip_address || '-')
     .row('Width:', `${printer.paper_width || 80}mm`)
     .feed(2)
     .cut()

    await printBuffer(b.build(), printer)
    return { success: true }
    } finally {
      finishActivity()
    }
  })

  /**
   * List printers for restaurant
   */
  ipcMain.handle('print:listPrinters', async (_, restaurantId) => {
    if (!restaurantId) return []
    return genericRepository.query(restaurantId, 'printers', [], 50)
  })

  /**
   * List installed Windows printer names
   */
  ipcMain.handle('print:listWindowsPrinters', async () => {
    return listWindowsPrinters()
  })
}

module.exports = { registerPrintIpc }
