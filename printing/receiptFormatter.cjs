/**
 * receiptFormatter.cjs
 *
 * Formats a Customer Bill Receipt as an ESC/POS buffer.
 *
 * Data required:
 *   order          – order record (type, tableId, tableName, items, orderNumber, etc.)
 *   financial      – order financial record (subtotalCents, discountCents, taxCents, totalCents, paidCents, etc.)
 *   payments       – array of payment records
 *   settings       – restaurant settings (name, currency, taxRate)
 *   printer        – printer config (paperWidth, copies)
 *   options        – { openCashDrawer: bool, showTaxBreakdown: bool }
 */

const { builder } = require('./escpos.cjs')

/**
 * Format cents as currency string.
 * Example: 150050 → "PKR 1,500.50"
 */
function money(cents, currency = 'PKR') {
  const amount = (Number(cents) / 100).toFixed(2)
  const [intPart, decPart] = amount.split('.')
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${currency} ${formatted}.${decPart}`
}

/**
 * Short money without currency prefix.
 * Example: 150050 → "1,500.50"
 */
function moneyShort(cents) {
  const amount = (Number(cents) / 100).toFixed(2)
  const [intPart, decPart] = amount.split('.')
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + decPart
}

/**
 * Format ISO date string to local-ish readable date
 */
function formatDate(isoString) {
  try {
    const d = new Date(isoString)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return isoString || ''
  }
}

/**
 * Build receipt ESC/POS Buffer for a single copy.
 * @returns {Buffer}
 */
function buildReceipt({ order, financial, payments = [], settings = {}, printer = {}, options = {} }) {
  const currency = settings.currency || 'PKR'
  const restaurantName = settings.name || 'Restaurant'
  const b = builder(printer)

  // ─── HEADER ───────────────────────────────────────────────────────────────
  if (options.openCashDrawer) {
    b.cashDrawer()
  }

  b.center()
  b.bold(true).large(true).line(restaurantName.slice(0, 20)).large(false).bold(false)

  if (settings.address) {
    b.line(settings.address.slice(0, b.cols))
  }
  if (settings.phone) {
    b.line(`Tel: ${settings.phone}`)
  }
  if (settings.taxNumber) {
    b.line(`NTN: ${settings.taxNumber}`)
  }

  b.rule()
  b.left()

  b.bold(true).line('CUSTOMER RECEIPT').bold(false)
  b.row('Order #:', order.orderNumber || '')
  b.row('Date:', formatDate(order.createdAt))

  const typeLabel = { 'dine-in': 'Dine-In', takeaway: 'Takeaway', delivery: 'Delivery' }[order.type] || order.type || 'Dine-In'
  b.row('Type:', typeLabel)
  if (order.tableName) {
    b.row('Table:', order.tableName)
  }
  if (order.waiterName) {
    b.row('Waiter:', order.waiterName)
  }
  if (order.customerName) {
    b.row('Customer:', order.customerName.slice(0, 20))
  }
  if (order.dineInCoverCount > 1) {
    b.row('Covers:', String(order.dineInCoverCount))
  }

  // ─── ITEMS ────────────────────────────────────────────────────────────────
  b.rule()
  b.bold(true).line('Items').bold(false)
  b.rule()

  const items = Array.isArray(order.items) ? order.items : []
  for (const item of items) {
    const qty = item.quantity || 1
    const unitCents = item.unitPriceCents || 0
    const lineCents = qty * unitCents

    // Item name + total price
    const nameCol = b.cols - 10
    const name = String(item.name || '').slice(0, nameCol)
    const lineTotal = moneyShort(lineCents)
    b.row(name, lineTotal)

    // Qty × unit price if qty > 1
    if (qty > 1) {
      b.line(`  ${qty} x ${moneyShort(unitCents)}`)
    }

    // Options label
    if (item.selectedVariant?.name) {
      b.line(`  + ${item.selectedVariant.name}`)
    }
    const addOns = Array.isArray(item.selectedAddOns) ? item.selectedAddOns : []
    for (const addOn of addOns) {
      b.line(`  + ${addOn.name}`)
    }

    // Per-item note
    if (item.note) {
      b.line(`  * ${item.note.slice(0, 30)}`)
    }
  }

  // ─── TOTALS ───────────────────────────────────────────────────────────────
  b.rule()

  const subtotal   = financial.subtotalCents   || 0
  const discount   = financial.discountCents   || 0
  const taxCents   = financial.taxCents        || 0
  const tipCents   = financial.tipCents        || 0
  const total      = financial.totalCents      || 0
  const paid       = financial.paidCents       || 0
  const refunded   = financial.refundedCents   || 0

  b.row('Subtotal:', money(subtotal, currency))
  if (discount > 0) {
    b.row('Discount:', `-${money(discount, currency)}`)
  }
  if (taxCents > 0) {
    const taxLabel = `Tax (${financial.taxRate || 0}%):`
    b.row(taxLabel, money(taxCents, currency))
  }
  if (tipCents > 0) {
    b.row('Tip:', money(tipCents, currency))
  }

  b.rule()
  b.bold(true)
  b.row('TOTAL:', money(total, currency))
  b.bold(false)
  b.rule()

  // ─── PAYMENTS ─────────────────────────────────────────────────────────────
  const paidPayments = payments.filter((p) => p.kind === 'payment' || !p.kind)
  if (paidPayments.length > 0) {
    for (const pay of paidPayments) {
      const methodLabel = (pay.method || 'Cash').toUpperCase()
      b.row(`Paid (${methodLabel}):`, money(pay.amountCents || 0, currency))
    }
  } else if (paid > 0) {
    b.row('Amount Paid:', money(paid, currency))
  }

  if (refunded > 0) {
    b.row('Refunded:', `-${money(refunded, currency)}`)
  }

  const balance = Math.max(0, total - paid + refunded)
  if (balance > 0) {
    b.bold(true)
    b.row('Balance Due:', money(balance, currency))
    b.bold(false)
  }

  // Change due
  const change = Math.max(0, paid - total)
  if (change > 0) {
    b.row('Change:', money(change, currency))
  }

  // ─── FOOTER ───────────────────────────────────────────────────────────────
  b.rule()
  b.center()

  const payStatus = financial.paymentStatus || 'unpaid'
  if (payStatus === 'paid') {
    b.bold(true).line('** PAID **').bold(false)
  } else if (payStatus === 'partially_paid') {
    b.line('** PARTIAL PAYMENT **')
  }

  if (settings.receiptFooter) {
    b.feed(1).wrap(settings.receiptFooter)
  } else {
    b.feed(1).line('Thank you for dining with us!')
  }

  if (settings.wifiPassword) {
    b.line(`WiFi: ${settings.wifiName || 'Guest'} | ${settings.wifiPassword}`)
  }

  b.feed(1).line(`Served by: ${order.createdByName || 'Staff'}`)
  b.left()

  b.cut()

  return b.build()
}

/**
 * Build ESC/POS Buffer for multiple copies.
 * @returns {Buffer}
 */
function formatReceipt(data) {
  const copies = (data.printer && data.printer.copies) || 1
  const buffers = []
  for (let i = 0; i < Math.max(1, copies); i++) {
    buffers.push(buildReceipt(data))
  }
  return Buffer.concat(buffers)
}

module.exports = { formatReceipt, buildReceipt, money, formatDate }
