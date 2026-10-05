import { useState } from 'react'
import { AlertCircle, BadgeCheck, CheckCircle2, CookingPot, Printer, ReceiptText, Utensils, X } from 'lucide-react'
import { formatMoney, normalizeCurrency } from '../utils/domain.js'
import './receipt.css'

function formatReceiptDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null
  if (!date || Number.isNaN(date.valueOf())) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date)
}

function money(cents, currency) {
  return formatMoney(cents, currency)
}

export function ReceiptDialog({ order, restaurantName = 'Restaurant', currency = 'PKR', restaurantId, onClose }) {
  const currencyCode = normalizeCurrency(currency)
  const lines = order.items || []
  const totalCents = Number(order.totalCents || 0)
  const paidCents = Math.max(0, Number(order.paidCents || 0))
  const refundedCents = Math.max(0, Number(order.refundedCents || 0))
  const balanceCents = Math.max(0, totalCents - paidCents)
  const paymentLabel = refundedCents > 0 ? 'Refund recorded' : balanceCents === 0 ? 'Paid in full' : paidCents > 0 ? 'Partially paid' : 'Payment due'

  const [printingReceipt, setPrintingReceipt] = useState(false)
  const [printingKot, setPrintingKot] = useState(false)
  const [printStatus, setPrintStatus] = useState(null)
  const [printError, setPrintError] = useState(null)

  const isElectron = typeof window !== 'undefined' && Boolean(window.posApi?.print)
  const targetRestaurantId = restaurantId || order.restaurantId || order.restaurant_id || (typeof window !== 'undefined' ? window.sessionStorage?.getItem('activeRestaurantId') : null)

  async function handlePrintReceipt() {
    if (!isElectron) {
      window.print()
      return
    }

    setPrintingReceipt(true)
    setPrintError(null)
    setPrintStatus(null)

    try {
      await window.posApi.print.receipt({
        restaurantId: targetRestaurantId,
        orderId: order.id,
        order,
      })
      setPrintStatus('Receipt sent to printer successfully.')
    } catch (err) {
      console.error('[Receipt Print Error]', err)
      setPrintError(err.message || 'Failed to print receipt. Please check printer configuration in Settings.')
    } finally {
      setPrintingReceipt(false)
    }
  }

  async function handlePrintKot() {
    if (!isElectron) {
      window.print()
      return
    }

    setPrintingKot(true)
    setPrintError(null)
    setPrintStatus(null)

    try {
      await window.posApi.print.kot({
        restaurantId: targetRestaurantId,
        orderId: order.id,
        order,
      })
      setPrintStatus('Kitchen Order Ticket (KOT) sent to kitchen printer.')
    } catch (err) {
      console.error('[KOT Print Error]', err)
      setPrintError(err.message || 'Failed to print KOT. Please check printer configuration in Settings.')
    } finally {
      setPrintingKot(false)
    }
  }

  return (
    <div className="modal-backdrop receipt-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="receipt-preview-heading no-print">
          <div><p className="eyebrow">RECEIPT PREVIEW</p><h2 id="receipt-title">Ready to print</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close receipt"><X size={18} /></button>
        </div>

        {printError && (
          <div className="receipt-print-banner receipt-print-error no-print" role="alert" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '6px', background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: '13px', margin: '0 0 12px' }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{printError}</span>
          </div>
        )}

        {printStatus && (
          <div className="receipt-print-banner receipt-print-success no-print" role="status" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '6px', background: '#ecfdf5', border: '1px solid #a7f3d0', color: '#047857', fontSize: '13px', margin: '0 0 12px' }}>
            <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
            <span>{printStatus}</span>
          </div>
        )}

        <article className="receipt-paper">
          <header className="receipt-header">
            <div className="receipt-brand-mark"><Utensils size={19} /></div>
            <p className="receipt-kicker">THANK YOU FOR VISITING</p>
            <h1>{restaurantName}</h1>
            <p className="receipt-subtitle">We hope to see you again soon.</p>
          </header>

          <div className="receipt-order-meta">
            <div><span>Receipt</span><strong>{order.orderNumber || `#${order.id?.slice(0, 7)}`}</strong></div>
            <div><span>Date</span><strong>{formatReceiptDate(order.createdAt)}</strong></div>
            <div><span>Order type</span><strong>{(order.type || 'dine-in').replaceAll('-', ' ')}</strong></div>
            {order.tableName && <div><span>Table</span><strong>{order.tableName}</strong></div>}
          </div>

          <div className="receipt-items-heading"><span>ITEM</span><span>AMOUNT</span></div>
          <div className="receipt-items">
            {lines.map((item, index) => {
              const variantName = typeof item.selectedVariant === 'string' ? item.selectedVariant : item.selectedVariant?.name
              const optionNames = [variantName, ...(item.selectedAddOns || []).map((option) => typeof option === 'string' ? option : option.name)]
                .filter(Boolean)
              return (
                <div className="receipt-item" key={`${item.itemId || item.name}-${index}`}>
                  <div className="receipt-item-description">
                    <strong>{item.name}</strong>
                    {optionNames.length > 0 && <span>{optionNames.join(' · ')}</span>}
                    <small>{item.quantity} × {money(item.unitPriceCents, currencyCode)}</small>
                  </div>
                  <strong className="receipt-item-price">{money(item.unitPriceCents * item.quantity, currencyCode)}</strong>
                </div>
              )
            })}
          </div>

          <div className="receipt-summary">
            <div><span>Subtotal</span><span>{money(order.subtotalCents, currencyCode)}</span></div>
            {Number(order.discountCents) > 0 && <div className="receipt-discount"><span>Discount</span><span>−{money(order.discountCents, currencyCode)}</span></div>}
            <div><span>Sales tax</span><span>{money(order.taxCents, currencyCode)}</span></div>
            <div className="receipt-grand-total"><strong>Total</strong><strong>{money(totalCents, currencyCode)}</strong></div>
            <div className="receipt-paid-row"><span>Paid</span><span>{money(paidCents, currencyCode)}</span></div>
            {refundedCents > 0 && <div className="receipt-refund-row"><span>Refunded</span><span>−{money(refundedCents, currencyCode)}</span></div>}
            <div className="receipt-balance"><strong>Balance due</strong><strong>{money(balanceCents, currencyCode)}</strong></div>
          </div>

          <div className={`receipt-payment-status ${balanceCents === 0 && refundedCents === 0 ? 'is-paid' : ''}`}>
            {balanceCents === 0 && refundedCents === 0 ? <BadgeCheck size={16} /> : <ReceiptText size={15} />}
            <span>{paymentLabel}</span>
          </div>
          <footer className="receipt-footer"><span>Order {order.orderNumber || `#${order.id?.slice(0, 7)}`}</span><span>Thank you</span></footer>
        </article>

        <div className="modal-actions no-print receipt-actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="button button-subtle" onClick={onClose}>Close</button>
          {isElectron && (
            <button
              className="button button-subtle"
              type="button"
              onClick={handlePrintKot}
              disabled={printingKot || printingReceipt}
              title="Print Kitchen Order Ticket to the kitchen printer"
            >
              <CookingPot size={16} />
              {printingKot ? 'Printing KOT…' : 'Print KOT'}
            </button>
          )}
          <button
            className="button button-primary"
            type="button"
            onClick={handlePrintReceipt}
            disabled={printingReceipt || printingKot}
          >
            <Printer size={16} />
            {printingReceipt ? 'Printing…' : isElectron ? 'Print Receipt (ESC/POS)' : 'Print receipt'}
          </button>
        </div>
      </section>
    </div>
  )
}
