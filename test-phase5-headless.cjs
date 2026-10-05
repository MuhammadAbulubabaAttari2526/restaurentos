/**
 * Phase 5: Headless ESC/POS Printing test suite.
 *
 * Tests (no real printer needed — validates command generation & formatting):
 *   T1:  EscPos builder - init resets printer
 *   T2:  EscPos builder - text alignment bytes (left/center/right)
 *   T3:  EscPos builder - bold on/off bytes
 *   T4:  EscPos builder - large text bytes
 *   T5:  EscPos builder - row() two-column padding is correct for 80mm & 58mm
 *   T6:  EscPos builder - cut() emits GS V 0
 *   T7:  EscPos builder - cashDrawer() emits ESC p
 *   T8:  EscPos builder - wrap() wraps long text at correct column widths
 *   T9:  receiptFormatter - builds non-empty buffer for a valid order
 *   T10: receiptFormatter - buffer contains order number
 *   T11: receiptFormatter - buffer contains TOTAL line
 *   T12: receiptFormatter - copies option doubles buffer size
 *   T13: kotFormatter - builds non-empty buffer
 *   T14: kotFormatter - buffer contains item names
 *   T15: collectionRegistry - printers toRow/fromRow round-trip
 *   T16: genericRepository - upsert/getById printers works
 *   T17: printIpc - registers without throwing
 */

const { app } = require('electron')
const assert = require('assert')

const { EscPos, builder } = require('./printing/escpos.cjs')
const { buildReceipt, formatReceipt } = require('./printing/receiptFormatter.cjs')
const { buildKot, formatKot } = require('./printing/kotFormatter.cjs')
const { getDb, closeDb } = require('./database/sqliteClient.cjs')
const genericRepository = require('./database/repositories/genericRepository.cjs')
const { registerPrintIpc } = require('./electron/ipc/printIpc.cjs')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL: ${name}`)
    console.error(`        ${err.message}`)
    failed++
  }
}

// ─── Sample test data ─────────────────────────────────────────────────────────
const sampleOrder = {
  id: 'order_print_test_1',
  orderNumber: 'R-20261005-0001',
  type: 'dine-in',
  tableId: 'table_1',
  tableName: 'Table 1',
  items: [
    {
      itemId: 'item_1',
      name: 'Chicken Karahi',
      quantity: 2,
      unitPriceCents: 150000,
      selectedVariant: { id: 'full', name: 'Full Size' },
      selectedAddOns: [{ id: 'raita', name: 'Extra Raita', priceCents: 1000 }],
      note: 'Extra spicy',
    },
    {
      itemId: 'item_2',
      name: 'Mint Lemonade',
      quantity: 3,
      unitPriceCents: 25000,
      selectedVariant: null,
      selectedAddOns: [],
    },
  ],
  dineInCoverCount: 2,
  note: 'Window seat preferred',
  createdAt: '2026-10-05T11:00:00.000Z',
  createdByName: 'Ali Raza',
}

const sampleFinancial = {
  subtotalCents:  375000,
  discountCents:  10000,
  discountType:   'fixed',
  taxRate:        15,
  taxCents:       54750,
  totalCents:     419750,
  paidCents:      419750,
  refundedCents:  0,
  tipCents:       0,
  paymentStatus:  'paid',
}

const samplePayments = [
  { id: 'pay1', kind: 'payment', amountCents: 419750, method: 'cash' },
]

const sampleSettings = {
  name: 'Spice Garden',
  currency: 'PKR',
  taxRate: 15,
  receiptFooter: 'Thank you for dining with us! Visit again.',
}

const samplePrinter80 = { paperWidth: 80, copies: 1 }
const samplePrinter58 = { paperWidth: 58, copies: 1 }

// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  console.log('\n========================================')
  console.log('--- Phase 5 Headless Printing Tests ---')
  console.log('========================================\n')

  try {
    getDb() // ensure migrations run

    // ─── T1: EscPos init ──────────────────────────────────────────────────
    console.log('[Suite 1: EscPos Builder]')
    it('builder init emits ESC @ (reset command)', () => {
      const b = builder(samplePrinter80)
      const hex = b.toHex()
      assert(hex.includes('1b40'), 'ESC @ (0x1b 0x40) found')
    })

    // ─── T2: Alignment bytes ──────────────────────────────────────────────
    it('align left emits ESC a 0', () => {
      const b = new EscPos(80).left()
      assert(b.toHex().includes('1b6100'), 'left align bytes')
    })

    it('align center emits ESC a 1', () => {
      const b = new EscPos(80).center()
      assert(b.toHex().includes('1b6101'), 'center align bytes')
    })

    it('align right emits ESC a 2', () => {
      const b = new EscPos(80).right()
      assert(b.toHex().includes('1b6102'), 'right align bytes')
    })

    // ─── T3: Bold ─────────────────────────────────────────────────────────
    it('bold(true) emits ESC E 1, bold(false) emits ESC E 0', () => {
      const b = new EscPos(80).bold(true).bold(false)
      const hex = b.toHex()
      assert(hex.includes('1b4501'), 'bold on')
      assert(hex.includes('1b4500'), 'bold off')
    })

    // ─── T4: Large text ───────────────────────────────────────────────────
    it('large(true) emits GS ! 0x11', () => {
      const b = new EscPos(80).large(true)
      assert(b.toHex().includes('1d2111'), 'large on: GS ! 0x11')
    })

    // ─── T5: Row padding ──────────────────────────────────────────────────
    it('row() produces 48-char lines on 80mm paper', () => {
      const b = new EscPos(80)
      b.row('Total:', 'PKR 1,000.00')
      const text = b.toText()
      const lines = text.split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1]
      assert.strictEqual(lastLine.length, 48, `Expected 48 chars, got ${lastLine.length}`)
    })

    it('row() produces 32-char lines on 58mm paper', () => {
      const b = new EscPos(58)
      b.row('Total:', 'PKR 500.00')
      const text = b.toText()
      const lines = text.split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1]
      assert.strictEqual(lastLine.length, 32, `Expected 32 chars, got ${lastLine.length}`)
    })

    // ─── T6: Cut ──────────────────────────────────────────────────────────
    it('cut() emits GS V 0', () => {
      const b = new EscPos(80).cut()
      assert(b.toHex().includes('1d5600'), 'GS V 0 found')
    })

    // ─── T7: Cash drawer ──────────────────────────────────────────────────
    it('cashDrawer() emits ESC p', () => {
      const b = new EscPos(80).cashDrawer()
      assert(b.toHex().includes('1b70'), 'ESC p found')
    })

    // ─── T8: Wrap ─────────────────────────────────────────────────────────
    it('wrap() splits long text correctly at 80mm cols (48)', () => {
      const b = new EscPos(80)
      const longText = 'The quick brown fox jumps over the lazy dog and then runs away into the forest'
      b.wrap(longText)
      const lines = b.toText().split('\n').filter(Boolean)
      assert(lines.length >= 2, 'Wraps into at least 2 lines')
      for (const line of lines) {
        assert(line.length <= 48, `Line length ${line.length} ≤ 48`)
      }
    })

    // ─── T9-T12: Receipt Formatter ───────────────────────────────────────
    console.log('\n[Suite 2: Receipt Formatter]')
    it('buildReceipt returns a non-empty Buffer', () => {
      const buf = buildReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: samplePrinter80,
      })
      assert(Buffer.isBuffer(buf), 'is a Buffer')
      assert(buf.length > 100, `Buffer length ${buf.length} > 100`)
    })

    it('receipt buffer contains order number text', () => {
      const buf = buildReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: samplePrinter80,
      })
      const text = buf.filter((b) => b >= 0x20 && b < 0x7F).toString('latin1')
      assert(text.includes('R-20261005-0001'), `Order number found in receipt text`)
    })

    it('receipt buffer contains TOTAL line', () => {
      const buf = buildReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: samplePrinter80,
      })
      const text = buf.filter((b) => b >= 0x20 && b < 0x7F).toString('latin1')
      assert(text.includes('TOTAL:'), 'TOTAL: found in receipt')
    })

    it('formatReceipt with copies=2 produces roughly double the buffer size', () => {
      const single = buildReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: { paperWidth: 80, copies: 1 },
      })
      const double = formatReceipt({
        order: sampleOrder,
        financial: sampleFinancial,
        payments: samplePayments,
        settings: sampleSettings,
        printer: { paperWidth: 80, copies: 2 },
      })
      assert.strictEqual(double.length, single.length * 2, 'copies=2 doubles buffer length')
    })

    // ─── T13-T14: KOT Formatter ──────────────────────────────────────────
    console.log('\n[Suite 3: KOT Formatter]')
    it('buildKot returns a non-empty Buffer', () => {
      const buf = buildKot({ order: sampleOrder, printer: samplePrinter80 })
      assert(Buffer.isBuffer(buf), 'is a Buffer')
      assert(buf.length > 50, 'KOT buffer has content')
    })

    it('KOT buffer contains item names and table info', () => {
      const buf = buildKot({ order: sampleOrder, printer: samplePrinter80 })
      const text = buf.filter((b) => b >= 0x20 && b < 0x7F).toString('latin1')
      assert(text.includes('Chicken Karahi'), 'Item name in KOT')
      assert(text.includes('TABLE 1') || text.includes('Table 1'), 'Table name in KOT')
      assert(text.includes('DINE-IN'), 'Order type in KOT')
    })

    it('KOT 58mm paper produces narrower output than 80mm', () => {
      const buf80 = buildKot({ order: sampleOrder, printer: samplePrinter80 })
      const buf58 = buildKot({ order: sampleOrder, printer: samplePrinter58 })
      assert(buf58.length < buf80.length, '58mm KOT is shorter than 80mm')
    })

    // ─── T15-T16: Printers in collectionRegistry + repository ────────────
    console.log('\n[Suite 4: Printers Collection Registry]')
    const testRestaurantId = 'rest_print_test'

    it('printers toRow/fromRow round-trip correctly', () => {
      const printerId = genericRepository.upsert(testRestaurantId, 'printers', {
        name: 'Main Counter Printer',
        connectionType: 'network',
        ipAddress: '192.168.1.100',
        port: 9100,
        paperWidth: 80,
        copies: 1,
        autoPrint: true,
        isDefault: true,
      })

      const printer = genericRepository.getById(testRestaurantId, 'printers', printerId)
      assert(printer !== null, 'printer retrieved from DB')
      assert.strictEqual(printer.name, 'Main Counter Printer')
      assert.strictEqual(printer.connectionType, 'network')
      assert.strictEqual(printer.ipAddress, '192.168.1.100')
      assert.strictEqual(printer.port, 9100)
      assert.strictEqual(printer.paperWidth, 80)
      assert.strictEqual(printer.copies, 1)
      assert.strictEqual(printer.autoPrint, true)
      assert.strictEqual(printer.isDefault, true)
    })

    it('multiple printers queryable for a restaurant', () => {
      genericRepository.upsert(testRestaurantId, 'printers', {
        name: 'Kitchen Printer',
        connectionType: 'network',
        ipAddress: '192.168.1.101',
        paperWidth: 58,
        isDefault: false,
      })

      const printers = genericRepository.query(testRestaurantId, 'printers', [], 20)
      assert(printers.length >= 2, 'At least 2 printers found')
    })

    // ─── T17: Print IPC registration ─────────────────────────────────────
    console.log('\n[Suite 5: Print IPC Registration]')
    it('registerPrintIpc runs without throwing', () => {
      registerPrintIpc()
      assert(true)
    })

    console.log('\n========================================')
    console.log(`Results: ${passed} passed, ${failed} failed`)
    console.log('========================================\n')

    closeDb()
    process.exit(failed > 0 ? 1 : 0)
  } catch (fatal) {
    console.error('Fatal test error:', fatal)
    closeDb()
    process.exit(1)
  }
})
