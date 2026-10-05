/**
 * escpos.cjs
 *
 * ESC/POS command builder for thermal receipt printers.
 * Supports 58mm (32 char) and 80mm (48 char) paper widths.
 * Returns a Buffer ready to be written to a TCP socket or Windows printer.
 *
 * Reference: EPSON ESC/POS Command Reference
 */

// ─── ESC/POS Control bytes ────────────────────────────────────────────────────
const ESC  = 0x1B
const GS   = 0x1D
const LF   = 0x0A
const CR   = 0x0D
const NUL  = 0x00

// ─── Paper widths ─────────────────────────────────────────────────────────────
const COLS = {
  58: 32,
  80: 48,
}

class EscPos {
  constructor(paperWidth = 80) {
    this.cols = COLS[paperWidth] || 48
    this._bytes = []
    this._init()
  }

  _push(...bytes) {
    for (const b of bytes) this._bytes.push(b)
    return this
  }

  _init() {
    // Initialize / Reset printer
    this._push(ESC, 0x40)
    return this
  }

  // ─── Character / Font ─────────────────────────────────────────────────────

  /** Set text alignment: 0=left, 1=center, 2=right */
  align(n) {
    this._push(ESC, 0x61, n)
    return this
  }

  left()   { return this.align(0) }
  center() { return this.align(1) }
  right()  { return this.align(2) }

  /** Bold on/off */
  bold(on = true) {
    this._push(ESC, 0x45, on ? 1 : 0)
    return this
  }

  /** Double-height + double-width (large text) */
  large(on = true) {
    this._push(GS, 0x21, on ? 0x11 : 0x00)
    return this
  }

  /** Underline (0=off, 1=thin, 2=thick) */
  underline(n = 1) {
    this._push(ESC, 0x2D, n)
    return this
  }

  // ─── Content ──────────────────────────────────────────────────────────────

  /** Write a raw text string (Latin-1) */
  text(str) {
    const s = String(str || '')
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      this._push(c < 256 ? c : 0x3F) // unknown chars → '?'
    }
    return this
  }

  /** Write a line of text then LF */
  line(str = '') {
    this.text(str)
    this._push(LF)
    return this
  }

  /** Write blank line(s) */
  feed(n = 1) {
    for (let i = 0; i < n; i++) this._push(LF)
    return this
  }

  /** Full-width horizontal rule using dashes */
  rule(char = '-') {
    return this.line(char.repeat(this.cols))
  }

  /** Two-column row: left text, right text, padded to fill paper width */
  row(left, right, totalCols) {
    const total = totalCols || this.cols
    const l = String(left  || '')
    const r = String(right || '')
    const spaces = Math.max(0, total - l.length - r.length)
    return this.line(l + ' '.repeat(spaces) + r)
  }

  /** Three-column row: left | center | right */
  row3(left, middle, right) {
    const l = String(left   || '')
    const m = String(middle || '')
    const r = String(right  || '')
    const remaining = this.cols - l.length - r.length
    const mPadded = m.padStart(Math.floor((remaining + m.length) / 2)).padEnd(remaining)
    return this.line(l + mPadded + r)
  }

  /** Word-wrap a long string into multiple left-aligned lines */
  wrap(str, indent = 0) {
    const prefix = ' '.repeat(indent)
    const maxLen = this.cols - indent
    const words = String(str || '').split(' ')
    let current = ''
    for (const word of words) {
      if (current.length + word.length + (current ? 1 : 0) > maxLen) {
        if (current) this.line(prefix + current)
        current = word
      } else {
        current = current ? current + ' ' + word : word
      }
    }
    if (current) this.line(prefix + current)
    return this
  }

  // ─── Special commands ─────────────────────────────────────────────────────

  /** Open cash drawer (pulse pin 2 or pin 5) */
  cashDrawer(pin = 2) {
    const p = pin === 5 ? 0x01 : 0x00
    this._push(ESC, 0x70, p, 0x32, 0xFF)  // ESC p pin time1 time2
    return this
  }

  /** Full cut (feed 3 lines then cut) */
  cut() {
    this.feed(3)
    this._push(GS, 0x56, 0x00)  // GS V 0  – full cut
    return this
  }

  /** Partial cut */
  partialCut() {
    this.feed(3)
    this._push(GS, 0x56, 0x01)  // GS V 1 – partial cut
    return this
  }

  /** Return the complete command as a Node.js Buffer */
  build() {
    return Buffer.from(this._bytes)
  }

  /** Return hex string (for debugging / testing) */
  toHex() {
    return Buffer.from(this._bytes).toString('hex')
  }

  /** Convenience: return printable chars only (for text-mode test assertions) */
  toText() {
    const bytes = this._bytes
    const out = []
    let i = 0
    while (i < bytes.length) {
      const b = bytes[i]
      if (b === ESC) {
        const next = bytes[i + 1]
        if (next === 0x40) { i += 2; continue } // ESC @
        if (next === 0x61 || next === 0x45) { i += 3; continue } // ESC a n, ESC E n
        if (next === 0x70) { i += 5; continue } // ESC p pin t1 t2
        i += 2
        continue
      }
      if (b === GS) {
        const next = bytes[i + 1]
        if (next === 0x21 || next === 0x56) { i += 3; continue } // GS ! n, GS V n
        i += 2
        continue
      }
      if ((b >= 0x20 && b < 0x7F) || b === LF || b === CR) {
        out.push(b)
      }
      i++
    }
    return Buffer.from(out).toString('latin1')
  }
}

/**
 * Factory: create a new EscPos builder for the given printer profile.
 * @param {object} printer  - { paperWidth: 80|58, … }
 */
function builder(printer = {}) {
  return new EscPos(printer.paperWidth || printer.paper_width || 80)
}

module.exports = { EscPos, builder }
