import { useEffect, useMemo, useRef, useState } from 'react'
import { watchRecords } from '../services/data.js'
import { formatMoney, friendlyError, normalizeCurrency } from '../utils/domain.js'

const HISTORY_LIMIT = 100
const currency = normalizeCurrency(import.meta.env.VITE_CURRENCY || 'PKR')

function timestampValue(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null
  return date && !Number.isNaN(date.valueOf()) ? date : null
}

function formatHistoryDate(value) {
  return timestampValue(value)?.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) || '—'
}

export function OrderHistoryDialog({ restaurantId, canSeePayments, onClose, triggerRef }) {
  const [orders, setOrders] = useState([])
  const [payments, setPayments] = useState([])
  const [loadingOrders, setLoadingOrders] = useState(true)
  const [loadingPayments, setLoadingPayments] = useState(canSeePayments)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('orders')
  const [search, setSearch] = useState('')
  const closeButtonRef = useRef(null)

  useEffect(() => {
    let active = true
    const trigger = triggerRef?.current
    const stopOrders = watchRecords(restaurantId, 'orders', (records) => {
      if (!active) return
      setOrders(records)
      setLoadingOrders(false)
    }, (problem) => {
      if (!active) return
      setError(friendlyError(problem))
      setLoadingOrders(false)
    }, HISTORY_LIMIT)
    const stopPayments = canSeePayments
      ? watchRecords(restaurantId, 'payments', (records) => {
        if (!active) return
        setPayments(records)
        setLoadingPayments(false)
      }, (problem) => {
        if (!active) return
        setError(friendlyError(problem))
        setLoadingPayments(false)
      }, HISTORY_LIMIT)
      : undefined

    const previousOverflow = document.body.style.overflow
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()

    return () => {
      active = false
      stopOrders?.()
      stopPayments?.()
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      trigger?.focus()
    }
  }, [restaurantId, canSeePayments, onClose, triggerRef])

  const orderById = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders])
  const normalizedSearch = search.trim().toLowerCase()
  const visibleOrders = useMemo(() => [...orders]
    .sort((left, right) => (timestampValue(right.createdAt)?.getTime() || 0) - (timestampValue(left.createdAt)?.getTime() || 0))
    .filter((order) => `${order.orderNumber || order.id} ${order.type || ''} ${order.tableName || ''} ${order.status || ''}`.toLowerCase().includes(normalizedSearch)),
  [orders, normalizedSearch])
  const visiblePayments = useMemo(() => [...payments]
    .sort((left, right) => (timestampValue(right.createdAt)?.getTime() || 0) - (timestampValue(left.createdAt)?.getTime() || 0))
    .filter((payment) => {
      const order = orderById.get(payment.orderId)
      return `${order?.orderNumber || payment.orderId} ${payment.method || ''} ${payment.kind || ''} ${payment.recordedBy || ''}`.toLowerCase().includes(normalizedSearch)
    }),
  [payments, orderById, normalizedSearch])

  return (
    <div className="modal-backdrop order-history-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel order-history-dialog" role="dialog" aria-modal="true" aria-labelledby="order-history-title">
        <div className="modal-heading">
          <div><p className="eyebrow">RESTAURANT ACTIVITY</p><h2 id="order-history-title">Order history</h2></div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close history" onClick={onClose}>×</button>
        </div>
        <p className="order-history-intro">Review recent orders and recorded payments for this restaurant.</p>
        <label className="search-field order-history-search">
          <span className="sr-only">Search history</span>
          <input aria-label="Search history" placeholder="Search order, table or payment method" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="order-history-tabs" role="tablist" aria-label="History type">
          <button type="button" role="tab" id="history-orders-tab" aria-selected={activeTab === 'orders'} aria-controls="history-orders-panel" onClick={() => setActiveTab('orders')}>Orders</button>
          {canSeePayments && <button type="button" role="tab" id="history-payments-tab" aria-selected={activeTab === 'payments'} aria-controls="history-payments-panel" onClick={() => setActiveTab('payments')}>Payments</button>}
        </div>
        {error && <div className="inline-alert" role="alert">{error}</div>}
        {activeTab === 'orders'
          ? <div id="history-orders-panel" role="tabpanel" aria-labelledby="history-orders-tab" className="order-history-table-wrap">
            {loadingOrders
              ? <p className="order-history-state">Loading order history…</p>
              : visibleOrders.length
                ? <div className="table-scroll"><table><thead><tr><th>Order</th><th>Date</th><th>Type / table</th><th>Status</th>{canSeePayments && <><th>Payment</th><th>Total</th></>}</tr></thead><tbody>
                  {visibleOrders.map((order) => <tr key={order.id}>
                    <td><strong>{order.orderNumber || `#${order.id?.slice(0, 7)}`}</strong></td>
                    <td>{formatHistoryDate(order.createdAt)}</td>
                    <td>{order.type || 'dine-in'}{order.tableName ? ` · ${order.tableName}` : ''}</td>
                    <td><span className={`status-pill status-${order.status || 'queued'}`}>{order.status || '—'}</span></td>
                    {canSeePayments && <><td>{order.paymentStatus || 'unpaid'}</td><td>{formatMoney(order.totalCents || 0, currency)}</td></>}
                  </tr>)}
                </tbody></table></div>
                : <p className="order-history-state">{normalizedSearch ? 'No orders match your search.' : 'No orders recorded yet.'}</p>}
          </div>
          : <div id="history-payments-panel" role="tabpanel" aria-labelledby="history-payments-tab" className="order-history-table-wrap">
            {loadingPayments
              ? <p className="order-history-state">Loading payment history…</p>
              : visiblePayments.length
                ? <div className="table-scroll"><table><thead><tr><th>Order</th><th>Date</th><th>Method</th><th>Type</th><th>Amount</th></tr></thead><tbody>
                  {visiblePayments.map((payment) => {
                    const order = orderById.get(payment.orderId)
                    return <tr key={payment.id}>
                      <td><strong>{order?.orderNumber || `#${String(payment.orderId || '').slice(0, 7)}`}</strong></td>
                      <td>{formatHistoryDate(payment.createdAt)}</td>
                      <td>{payment.method || '—'}</td>
                      <td>{payment.kind || 'payment'}</td>
                      <td>{formatMoney(payment.amountCents || 0, currency)}</td>
                    </tr>
                  })}
                </tbody></table></div>
                : <p className="order-history-state">{normalizedSearch ? 'No payments match your search.' : 'No payments recorded yet.'}</p>}
          </div>}
        {(orders.length >= HISTORY_LIMIT || payments.length >= HISTORY_LIMIT) && <p className="order-history-limit">Showing the latest {HISTORY_LIMIT} records in each history.</p>}
        <div className="modal-actions"><button className="button button-subtle" type="button" onClick={onClose}>Close</button></div>
      </section>
    </div>
  )
}
