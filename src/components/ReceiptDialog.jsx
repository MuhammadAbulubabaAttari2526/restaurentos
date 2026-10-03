import { BadgeCheck, Printer, ReceiptText, Utensils, X } from 'lucide-react'
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

export function ReceiptDialog({ order, restaurantName = 'Restaurant', currency = 'PKR', onClose }) {
  const currencyCode = normalizeCurrency(currency)
  const lines = order.items || []
  const totalCents = Number(order.totalCents || 0)
  const paidCents = Math.max(0, Number(order.paidCents || 0))
  const refundedCents = Math.max(0, Number(order.refundedCents || 0))
  const balanceCents = Math.max(0, totalCents - paidCents)
  const paymentLabel = refundedCents > 0 ? 'Refund recorded' : balanceCents === 0 ? 'Paid in full' : paidCents > 0 ? 'Partially paid' : 'Payment due'

  return (
    <div className="modal-backdrop receipt-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="receipt-preview-heading no-print">
          <div><p className="eyebrow">RECEIPT PREVIEW</p><h2 id="receipt-title">Ready to print</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close receipt"><X size={18} /></button>
        </div>

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

        <div className="modal-actions no-print receipt-actions">
          <button className="button button-subtle" onClick={onClose}>Close</button>
          <button className="button button-primary" onClick={() => window.print()}><Printer size={16} /> Print receipt</button>
        </div>
      </section>
    </div>
  )
}
