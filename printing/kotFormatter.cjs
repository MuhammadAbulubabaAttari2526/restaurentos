/**
 * kotFormatter.cjs
 *
 * Formats a Kitchen Order Ticket (KOT) as an ESC/POS buffer.
 * Designed for speed – large fonts, minimal noise.
 *
 * Data required:
 *   order     – order record (type, tableName, orderNumber, items, note, createdAt)
 *   printer   – printer config (paperWidth, copies)
 *   options   – { showItemIndex: bool, kotLabel: string }
 */

const { builder } = require('./escpos.cjs')

function formatDate(isoString) {
  try {
    const d = new Date(isoString)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return ''
  }
}

/**
 * Build KOT ESC/POS Buffer for a single copy.
 * @returns {Buffer}
 */
function buildKot({ order, printer = {}, options = {} }) {
  const b = builder(printer)
  const kotLabel = options.kotLabel || 'KITCHEN ORDER'

  // ─── HEADER ───────────────────────────────────────────────────────────────
  b.center()
  b.bold(true).large(true)
  b.line('** KOT **')
  b.large(false).bold(false)
  b.rule('=')

  b.bold(true).line(kotLabel).bold(false)
  b.rule()

  b.left()
  b.row('Order #:', order.orderNumber || '-')
  b.row('Time:', formatDate(order.createdAt))

  const typeLabel = { 'dine-in': 'DINE-IN', takeaway: 'TAKEAWAY', delivery: 'DELIVERY' }[order.type] || (order.type || 'DINE-IN').toUpperCase()
  b.row('Type:', typeLabel)

  if (order.tableName) {
    b.bold(true)
    b.row('TABLE:', order.tableName.toUpperCase())
    b.bold(false)
  }

  if (order.dineInCoverCount > 1) {
    b.row('Covers:', String(order.dineInCoverCount))
  }

  // ─── ITEMS ────────────────────────────────────────────────────────────────
  b.rule('=')

  const items = Array.isArray(order.items) ? order.items : []
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    const qty = item.quantity || 1

    // Item line – big so kitchen can read from a distance
    b.bold(true)
    const prefix = options.showItemIndex ? `${idx + 1}. ` : ''
    b.line(`${prefix}${qty}x  ${String(item.name || '').slice(0, b.cols - prefix.length - 5)}`)
    b.bold(false)

    // Variant
    if (item.selectedVariant?.name) {
      b.line(`    >> ${item.selectedVariant.name}`)
    }

    // Add-ons
    const addOns = Array.isArray(item.selectedAddOns) ? item.selectedAddOns : []
    for (const addOn of addOns) {
      b.line(`    >> ${addOn.name}`)
    }

    // Item-level note
    if (item.note && item.note.trim()) {
      b.underline(1).line(`    ! ${item.note.trim().slice(0, 28)}`).underline(0)
    }

    // Spacer between items
    if (idx < items.length - 1) {
      b.line('')
    }
  }

  // ─── ORDER NOTE ───────────────────────────────────────────────────────────
  if (order.note && order.note.trim()) {
    b.rule()
    b.bold(true).line('ORDER NOTE:').bold(false)
    b.wrap(order.note.trim())
  }

  // ─── FOOTER ───────────────────────────────────────────────────────────────
  b.rule('=')
  b.center().line('-- end of ticket --').left()

  b.cut()

  return b.build()
}

/**
 * Build KOT Buffer for multiple copies.
 */
function formatKot(data) {
  const copies = (data.printer && data.printer.copies) || 1
  const buffers = []
  for (let i = 0; i < Math.max(1, copies); i++) {
    buffers.push(buildKot(data))
  }
  return Buffer.concat(buffers)
}

module.exports = { formatKot, buildKot }
