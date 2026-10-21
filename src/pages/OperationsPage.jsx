import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  ArrowDownLeft, ArrowUpRight, Banknote, CalendarDays, Check, CirclePlus,
  Clock3, CreditCard, Minus, Plus, Printer, Search, Settings, ShoppingBag,
  Trash2, Truck, Utensils, Users, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '../context/useAuth.js'
import { ReceiptDialog } from '../components/ReceiptDialog.jsx'
import {
  createOrder, exportReport, recordPayment, recordRefund, runOperation,
  saveRecord, removeRecord, transitionOrder, watchRecords,
} from '../services/data.js'
import { calculateTotals, formatMoney, friendlyError, normalizeCurrency } from '../utils/domain.js'
import { getPosDraftKey, readPosDraft, writePosDraft } from '../utils/posDraftStorage.js'
import { normalizeMenuImageUrl, optimizeMenuImageUrl } from '../utils/menuImage.js'
import { createStableIntentId, resetStableIntentId } from '../utils/idUtils.js'
import { mergeOrderWithFinancials } from '../utils/orderMerge.js'
import './operations.css'

const currency = normalizeCurrency(import.meta.env.VITE_CURRENCY || 'PKR')
const money = (value) => formatMoney(value, currency)
const weightLabel = (option) => `${option.weightValue} ${option.weightUnit}`

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{action}</div>
}

function useRecords(name, max = 150, enabled = true) {
  const { membership, user } = useAuth()
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return undefined
    if (!membership?.restaurantId) return undefined
    const filters = name === 'draftOrders' ? [['createdBy', '==', user.uid]] : []
    return watchRecords(membership.restaurantId, name, (next) => {
      setRecords(next)
      setError('')
      setLoading(false)
    }, (problem) => {
      setError(friendlyError(problem))
      setLoading(false)
    }, max, filters)
  }, [membership?.restaurantId, membership?.role, user?.uid, name, max, enabled])
  return { records, setRecords, loading, error, truncated: records.length === max, limit: max }
}

function LimitNotices({ sources }) {
  return <>{sources.filter((source) => source.truncated).map((source) => <div className="inline-alert limit-notice" role="status" key={source.label}>Showing latest {source.limit} {source.label}.</div>)}</>
}

function LoadingLines({ count = 4 }) {
  return <div className="loading-lines" aria-label="Loading records">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>
}

function MenuImage({ url, name }) {
  const source = optimizeMenuImageUrl(url)
  const [failedSource, setFailedSource] = useState('')
  if (!source || failedSource === source) return <span className="menu-image-fallback" aria-hidden="true">{name?.trim()?.slice(0, 1) || 'M'}</span>
  return <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailedSource(source)} />
}

function MenuImagePreview({ url }) {
  const source = optimizeMenuImageUrl(url)
  const [failedSource, setFailedSource] = useState('')
  if (!String(url || '').trim()) return <small className="menu-image-hint">Paste a public HTTPS image link to preview it.</small>
  if (!source) return <small className="menu-image-hint image-link-error">Enter a valid HTTPS image URL.</small>
  if (failedSource === source) return <small className="menu-image-hint image-link-error">Image did not load. Check that the link is public and points to an image.</small>
  return <div className="menu-image-preview"><img src={source} alt="Menu item preview" loading="lazy" decoding="async" onError={() => setFailedSource(source)} /><small>Image preview</small></div>
}

function EmptyState({ title, detail }) {
  return <div className="empty-state"><div className="empty-icon"><ShoppingBag size={20} /></div><strong>{title}</strong><span>{detail}</span></div>
}

function ContactLink({ value, kind }) {
  const text = String(value || '').trim()
  if (!text) return '—'
  const href = kind === 'email'
    ? `mailto:${encodeURIComponent(text)}`
    : `tel:${text.replace(/[^\d+]/g, '')}`
  if (kind !== 'email' && href === 'tel:') return text
  return <a className="contact-link" href={href}>{text}</a>
}

function StatTile({ label, value, note, icon: Icon, change }) {
  return <article className="stat-tile"><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={17} /></span></div><strong className="stat-value">{value}</strong><div className="stat-foot"><span className={change ? 'trend-positive' : ''}>{change ? <ArrowUpRight size={14} /> : null}{note}</span></div></article>
}

function Dashboard() {
  const { membership } = useAuth()
  const { records: orders, loading: ordersLoading, truncated: ordersTruncated, limit: ordersLimit } = useRecords('orders', 500)
  const canReadFinance = ['owner', 'manager'].includes(membership?.role)
  const { records: financials, loading: financialsLoading, truncated: financialsTruncated, limit: financialsLimit } = useRecords('orderFinancials', 1000, canReadFinance)
  const { records: inventory, truncated: inventoryTruncated, limit: inventoryLimit } = useRecords('inventory', 100)
  const { records: expenses, truncated: expensesTruncated, limit: expensesLimit } = useRecords('expenses', 300, canReadFinance)
  const { records: settings } = useRecords('settings', 1)
  const [today] = useState(() => new Date())
  const todayKey = localDateKey(today)
  const completedToday = financials.filter((record) => record.status === 'active' && ['paid', 'partially_refunded', 'refunded'].includes(record.paymentStatus) && localDateKey(record.createdAt) === todayKey)
  const todaysFinancials = financials.filter((record) => record.status === 'active' && localDateKey(record.createdAt) === todayKey)
  const todayOrders = orders.filter((order) => order.status !== 'cancelled' && localDateKey(order.createdAt) === todayKey)
  const salesTrend = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today)
    day.setDate(day.getDate() - (6 - index))
    const key = localDateKey(day)
    return {
      label: day.toLocaleDateString(undefined, { weekday: 'short' }),
      grossSalesCents: financials.filter((record) => record.status === 'active' && record.paymentStatus === 'paid' && localDateKey(record.createdAt) === key)
        .reduce((sum, record) => sum + (record.subtotalCents || 0), 0),
    }
  })
  const bestSellerCounts = new Map()
  for (const record of completedToday) for (const item of record.items || []) bestSellerCounts.set(item.name, (bestSellerCounts.get(item.name) || 0) + item.quantity)
  const summary = {
    currency: normalizeCurrency(settings[0]?.currency || currency),
    grossSalesCents: completedToday.reduce((sum, record) => sum + (record.subtotalCents || 0), 0),
    orderCount: todayOrders.length,
    unpaidOrderCount: todaysFinancials.filter((record) => record.paymentStatus === 'unpaid' || record.paymentStatus === 'partially_paid').length,
    averageOrderCents: completedToday.length ? Math.round(completedToday.reduce((sum, record) => sum + (record.totalCents || 0), 0) / completedToday.length) : 0,
    expenseCents: expenses.filter((expense) => expense.date === todayKey && expense.status === 'approved').reduce((sum, expense) => sum + (expense.amountCents || 0), 0),
    bestSeller: [...bestSellerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || null,
    salesTrend,
  }
  const loading = ordersLoading || (canReadFinance && financialsLoading)
  const lowStock = inventory.filter((item) => Number(item.quantityOnHand || 0) <= Number(item.reorderLevel || 0))
  const currencyCode = summary.currency
  const recentOrders = orders.map((order) => mergeOrderWithFinancials(order, financials.find((record) => record.id === order.id) || {}))
  return <>
    <PageHeading eyebrow="RESTAURANT OPERATIONS" title="Good service starts here." description="Your restaurant at a glance. Figures update from confirmed records." action={<button className="button button-subtle" onClick={() => window.location.reload()}><Clock3 size={16} /> Refresh</button>} />
    <LimitNotices sources={[{ truncated: ordersTruncated, limit: ordersLimit, label: 'orders' }, { truncated: financialsTruncated, limit: financialsLimit, label: 'financial records' }, { truncated: inventoryTruncated, limit: inventoryLimit, label: 'inventory records' }, { truncated: expensesTruncated, limit: expensesLimit, label: 'expenses' }]} />
    {loading ? <div className="stats-grid"><LoadingLines count={4} /></div> : <div className="stats-grid">
      <StatTile label="Today's gross sales" value={formatMoney(summary.grossSalesCents, currencyCode)} note="Before refunds" icon={Banknote} />
      <StatTile label="Orders today" value={summary.orderCount} note={`${summary.unpaidOrderCount} awaiting payment`} icon={ShoppingBag} />
      <StatTile label="Average order" value={formatMoney(summary.averageOrderCents, currencyCode)} note="Finalized orders" icon={ArrowUpRight} change />
      <StatTile label="Recorded expenses" value={formatMoney(summary.expenseCents, currencyCode)} note="Today, approved" icon={ArrowDownLeft} />
    </div>}
    <div className="dashboard-grid">
      <section className="panel sales-panel"><div className="section-title"><div><h2>Sales trend</h2><p>Daily gross sales, last 7 days</p></div><span className="legend-dot">Gross sales</span></div>{summary?.salesTrend?.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={summary.salesTrend} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}><defs><linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#28785f" stopOpacity={0.2} /><stop offset="95%" stopColor="#28785f" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#edf0eb" vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: '#848b83', fontSize: 11 }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#848b83', fontSize: 11 }} tickFormatter={(value) => formatMoney(value, currencyCode)} /><Tooltip formatter={(value) => [formatMoney(value, currencyCode), 'Gross sales']} contentStyle={{ border: '1px solid #e8ebe5', borderRadius: 4, fontSize: 12 }} /><Area type="monotone" dataKey="grossSalesCents" stroke="#28785f" strokeWidth={2.3} fill="url(#salesFill)" /></AreaChart></ResponsiveContainer></div> : <EmptyState title="Sales trend will appear here" detail="Complete an order to begin tracking sales." />}</section>
      <section className="panel"><div className="section-title"><div><h2>Low stock</h2><p>Items at or below reorder level</p></div><span className="count-badge">{lowStock.length}</span></div>{lowStock.length ? <div className="stock-list">{lowStock.slice(0, 5).map((item) => <div className="stock-row" key={item.id}><div><strong>{item.name}</strong><span>{item.quantityOnHand ?? 0} {item.unit || 'units'} remaining</span></div><span className="stock-alert">Reorder</span></div>)}</div> : <EmptyState title="Stock looks good" detail="Low-stock alerts appear when inventory is running short." />}</section>
      <section className="panel recent-panel"><div className="section-title"><div><h2>Recent orders</h2><p>Latest activity at your restaurant</p></div></div>{orders.length ? <div className="table-scroll"><table><thead><tr><th>Order</th><th>Type</th><th>Status</th>{['owner', 'manager'].includes(membership?.role) && <th>Total</th>}</tr></thead><tbody>{recentOrders.slice(0, 6).map((order) => <tr key={order.id}><td><strong>{order.orderNumber || order.id.slice(0, 7)}</strong></td><td>{order.type || 'Dine-in'}</td><td><span className={`status-pill status-${order.status}`}>{order.status}</span></td>{['owner', 'manager'].includes(membership?.role) && <td>{money(order.totalCents)}</td>}</tr>)}</tbody></table></div> : <EmptyState title="No orders yet" detail="Your team's latest orders will show here." />}</section>
      <section className="panel insight-panel"><div className="insight-mark"><Utensils size={20} /></div><p className="eyebrow">SERVICE PULSE</p><h2>{summary.orderCount ? `${summary.orderCount} orders served into the day.` : 'Ready when your first guest arrives.'}</h2><p>Keep orders, tables, payments and inventory in sync.</p><div className="insight-meta"><span><i /> Order feed connected</span><span>{summary.bestSeller || 'Live tracking'}</span></div></section>
    </div>
  </>
}

function PosPage() {
  const { membership, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const draftStorageKey = getPosDraftKey(membership, user)
  const { records: items, loading: itemsLoading, truncated: itemsTruncated, limit: itemsLimit } = useRecords('menuItems')
  const { records: categories, truncated: categoriesTruncated, limit: categoriesLimit } = useRecords('categories')
  const canSeeCustomers = ['owner', 'manager', 'cashier'].includes(membership?.role)
  const canDiscount = ['owner', 'manager'].includes(membership?.role) || membership?.permissions?.includes('discounts')
  const { records: customers, truncated: customersTruncated, limit: customersLimit } = useRecords('customers', 150, canSeeCustomers)
  const { records: waiters, loading: waitersLoading, truncated: waitersTruncated, limit: waitersLimit } = useRecords('waiters', 150)
  const [draftHydrated, setDraftHydrated] = useState(false)
  const [cart, setCart] = useState([])
  const [ticketOpen, setTicketOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900)
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const searchRef = useRef(null)
  const [selectedMenuId, setSelectedMenuId] = useState('')
  const [orderType, setOrderType] = useState(() => (location.state?.tableId ? 'dine-in' : 'direct-bill'))
  const [tableId, setTableId] = useState(() => location.state?.tableId || '')
  const [covers, setCovers] = useState(1)
  const [customerId, setCustomerId] = useState('')
  const [waiterId, setWaiterId] = useState('')
  const [note, setNote] = useState('')
  const [discount, setDiscount] = useState('')
  const [collectPayment, setCollectPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [pendingPaymentOrder, setPendingPaymentOrder] = useState(null)
  const [optionItem, setOptionItem] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const { records: restaurant } = useRecords('settings', 1)
  const { records: drafts, truncated: draftsTruncated, limit: draftsLimit } = useRecords('draftOrders', 50)
  const { records: tables, truncated: tablesTruncated, limit: tablesLimit } = useRecords('tables', 150)
  const [selectedDraftId, setSelectedDraftId] = useState('')
  const [activeDraftId, setActiveDraftId] = useState(null)
  const orderIntentIdRef = useRef(null)
  const paymentIntentIdRef = useRef(null)
  const previousTotalCentsRef = useRef(0)

  useEffect(() => {
    if (!draftStorageKey || draftHydrated) return
    const savedDraft = readPosDraft(draftStorageKey)
    if (savedDraft) {
      setCart(savedDraft.cart || [])
      setPendingPaymentOrder(savedDraft.pendingPaymentOrder || null)
      orderIntentIdRef.current = savedDraft.pendingPaymentOrder?.orderId || savedDraft.orderIntentId || null
      paymentIntentIdRef.current = savedDraft.paymentIntentId || null
      setOrderType(savedDraft.orderType || (location.state?.tableId ? 'dine-in' : 'direct-bill'))
      setTableId(savedDraft.tableId || location.state?.tableId || '')
      setCovers(Number(savedDraft.covers) || 1)
      setCustomerId(canSeeCustomers ? savedDraft.customerId || '' : '')
      setWaiterId(savedDraft.waiterId || '')
      setNote(savedDraft.note || '')
      setDiscount(canDiscount ? savedDraft.discount || '' : '')
      setActiveDraftId(savedDraft.activeDraftId || null)
      setSelectedDraftId(savedDraft.activeDraftId || '')
    }
    setDraftHydrated(true)
  }, [canDiscount, canSeeCustomers, draftHydrated, draftStorageKey, location.state?.tableId])

  useEffect(() => {
    if (!waitersLoading && waiterId && !waiters.some((waiter) => waiter.id === waiterId && waiter.status !== 'inactive')) setWaiterId('')
  }, [waiters, waitersLoading, waiterId])
  const taxRate = Number(restaurant[0]?.taxRate || 0)
  const subtotalCents = cart.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
  const discountCents = Math.min(Math.round(Number(discount || 0) * 100) || 0, subtotalCents)
  const totals = calculateTotals(cart, taxRate, discountCents)
  const canCollectPayment = ['owner', 'manager', 'cashier'].includes(membership?.role)
  const paymentMethods = useMemo(() => {
    const configured = restaurant[0]?.paymentMethods
    const enabled = Array.isArray(configured) ? configured : ['cash', 'card', 'digital']
    return ['cash', 'card', 'digital'].filter((method) => enabled.includes(method))
  }, [restaurant])
  const selectedPaymentMethod = paymentMethods.includes(paymentMethod) ? paymentMethod : paymentMethods[0] || 'cash'
  const collectPaymentNow = canCollectPayment && paymentMethods.length > 0 && collectPayment
  const visibleItems = useMemo(() => items.filter((item) => item.available !== false && (category === 'all' || item.categoryId === category) && item.name?.toLowerCase().includes(search.toLowerCase())), [items, category, search])
  const highlightedItem = visibleItems.find((entry) => entry.id === selectedMenuId) || visibleItems[0]

  useEffect(() => {
    const previousTotal = previousTotalCentsRef.current
    setPaymentAmount((current) => {
      const followsOrderTotal = !current || Math.round(Number(current) * 100) === previousTotal
      return followsOrderTotal ? (totals.totalCents ? (totals.totalCents / 100).toFixed(2) : '') : current
    })
    previousTotalCentsRef.current = totals.totalCents
  }, [totals.totalCents])

  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  const enteredPaymentCents = Math.round(Number(paymentAmount) * 100)
  const changeDueCents = selectedPaymentMethod === 'cash' ? Math.max(0, enteredPaymentCents - totals.totalCents) : 0
  const visibleTables = tables.filter((table) => (table.status === 'available' || table.id === tableId) && (table.id === tableId || Number(table.capacity || 0) >= Number(covers || 1)))

  useEffect(() => {
    if (!draftStorageKey || !draftHydrated) return
    writePosDraft(draftStorageKey, { cart, orderType, tableId, covers, customerId, waiterId, note, discount, activeDraftId, pendingPaymentOrder, orderIntentId: orderIntentIdRef.current, paymentIntentId: paymentIntentIdRef.current })
  }, [draftStorageKey, draftHydrated, cart, orderType, tableId, covers, customerId, waiterId, note, discount, activeDraftId, pendingPaymentOrder])

  function addHighlightedItem() {
    const item = highlightedItem
    if (!item) return
    if (item.itemType === 'weight-wise' || item.variants?.length || item.addOns?.length) {
      setOptionItem(item)
      return
    }
    addToCart(item)
    setSearch('')
  }

  function changeQty(lineId, amount) {
    const currentLine = cart.find((line) => line.lineId === lineId)
    if (amount < 0 && cart.length === 1 && currentLine?.quantity <= Math.abs(amount)) setTicketOpen(false)
    setCart((current) => {
      return current.map((line) => line.lineId === lineId ? { ...line, quantity: line.quantity + amount } : line).filter((line) => line.quantity > 0)
    })
  }

  function updateLineNote(lineId, value) {
    setCart((current) => current.map((line) => line.lineId === lineId ? { ...line, note: value.slice(0, 300) } : line))
  }

  function handlePosKeyDown(event) {
    if (optionItem || receipt) return
    if (event.key === 'Escape' && ticketOpen) {
      setTicketOpen(false)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      submitOrder()
      return
    }
    if (event.key === 'Escape' && document.activeElement === searchRef.current) setSearch('')
  }

  function startNewOrder() {
    if (pendingPaymentOrder) return toast.error('Record payment for the saved order before starting another ticket.')
    if (cart.length && !window.confirm('Clear this ticket and start a new order?')) return
    resetStableIntentId(activeDraftId || 'pos-order')
    if (orderIntentIdRef.current) resetStableIntentId(`pos-payment-${orderIntentIdRef.current}`)
    orderIntentIdRef.current = null
    paymentIntentIdRef.current = null
    setCart([])
    setTicketOpen(typeof window !== 'undefined' && window.innerWidth >= 900)
    setOrderType('direct-bill')
    setTableId('')
    setCovers(1)
    setCustomerId('')
    setWaiterId('')
    setNote('')
    setDiscount('')
    setPaymentAmount('')
    setPaymentReference('')
    setPendingPaymentOrder(null)
    setActiveDraftId(null)
    setSelectedDraftId('')
  }

  function openOrdersForPendingPayment() {
    if (!pendingPaymentOrder) return
    if (activeDraftId) {
      void runOperation('deleteOrderDraft', { draftId: activeDraftId }).catch((error) => {
        toast.error(`Order is in Orders, but its saved draft could not be removed. ${friendlyError(error)}`)
      })
    }
    resetStableIntentId(activeDraftId || 'pos-order')
    if (pendingPaymentOrder.orderId) resetStableIntentId(`pos-payment-${pendingPaymentOrder.orderId}`)
    orderIntentIdRef.current = null
    paymentIntentIdRef.current = null
    writePosDraft(draftStorageKey, { cart: [], orderType: 'direct-bill', tableId: '', covers: 1, customerId: '', waiterId: '', note: '', discount: '', activeDraftId: null, pendingPaymentOrder: null, orderIntentId: null, paymentIntentId: null })
    setCart([])
    setPendingPaymentOrder(null)
    setActiveDraftId(null)
    setSelectedDraftId('')
    setTicketOpen(false)
    navigate('/orders')
  }

  function addToCart(item, selectedVariantId = '', selectedAddOnIds = [], selectedWeightOptionId = '', quantity = 1) {
    const variant = item.variants?.find((option) => option.id === selectedVariantId)
    const addOns = (item.addOns || []).filter((option) => selectedAddOnIds.includes(option.id))
    const weightOption = (item.weightOptions || []).find((option) => option.id === selectedWeightOptionId)
    if (item.itemType === 'weight-wise' && !weightOption) return toast.error('Choose a valid weight before adding this item.')
    const existing = cart.find((line) => line.lineId === `${item.id}:${selectedWeightOptionId || selectedVariantId || 'base'}:${[...selectedAddOnIds].sort().join(',')}`)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99 || (existing && existing.quantity + quantity > 99)) return toast.error('Each cart line can contain up to 99 portions.')
    const lineId = `${item.id}:${selectedWeightOptionId || selectedVariantId || 'base'}:${[...selectedAddOnIds].sort().join(',')}`
    const unitPriceCents = (weightOption?.priceCents ?? item.priceCents) + (variant?.priceDeltaCents || 0) + addOns.reduce((sum, option) => sum + option.priceCents, 0)
    const optionLabel = [weightOption ? weightLabel(weightOption) : variant?.name, ...addOns.map((option) => option.name)].filter(Boolean).join(', ')
    setCart((current) => {
      const found = current.find((line) => line.lineId === lineId)
      if (found) return current.map((line) => line.lineId === lineId ? { ...line, quantity: line.quantity + quantity } : line)
      return [...current, { lineId, itemId: item.id, name: item.name, unitPriceCents, quantity, note: '', selectedVariantId: selectedVariantId || null, selectedWeightOptionId: selectedWeightOptionId || null, selectedWeight: weightOption ? { id: weightOption.id, value: weightOption.weightValue, unit: weightOption.weightUnit, label: weightLabel(weightOption) } : null, selectedAddOnIds, optionLabel }]
    })
    if (typeof window !== 'undefined' && window.innerWidth >= 900) {
      setTicketOpen(true)
    }
  }

  async function saveDraft() {
    if (!cart.length) return toast.error('Add items before saving a draft.')
    const draftId = activeDraftId || crypto.randomUUID()
    try {
      await runOperation('saveOrderDraft', {
        draftId,
        type: orderType,
        tableId: orderType === 'dine-in' ? tableId || null : null,
        customerId: canSeeCustomers ? customerId || null : null,
        waiterId: waiterId || null,
        waiterName: waiters.find((waiter) => waiter.id === waiterId)?.name || '',
        discountCents,
        note,
        items: cart.map(({ itemId, quantity, note: itemNote, selectedVariantId, selectedWeightOptionId, selectedAddOnIds }) => ({ itemId, quantity, note: itemNote, selectedVariantId, selectedWeightOptionId, selectedAddOnIds })),
      })
      setActiveDraftId(draftId)
      setSelectedDraftId(draftId)
      toast.success('Draft saved. Prices will be checked again when you send it.')
    } catch (error) { toast.error(friendlyError(error)) }
  }

  function resumeDraft() {
    const draft = drafts.find((entry) => entry.id === selectedDraftId)
    if (!draft) return toast.error('Choose a saved draft first.')
    try {
      const nextCart = draft.items.map((line) => {
        const item = items.find((menuItem) => menuItem.id === line.itemId)
        if (!item || item.available === false) throw new Error('A saved item is no longer available. Review the menu and rebuild this draft.')
        const variant = item.variants?.find((option) => option.id === line.selectedVariantId)
        const weightOption = (item.weightOptions || []).find((option) => option.id === line.selectedWeightOptionId)
        const addOns = (item.addOns || []).filter((option) => line.selectedAddOnIds?.includes(option.id))
        if ((line.selectedVariantId && !variant) || (item.itemType === 'weight-wise' && !weightOption) || (item.itemType !== 'weight-wise' && line.selectedWeightOptionId) || addOns.length !== (line.selectedAddOnIds || []).length) throw new Error('Saved options changed in the menu. Review this draft and choose its options again.')
        const lineId = `${item.id}:${line.selectedWeightOptionId || line.selectedVariantId || 'base'}:${[...(line.selectedAddOnIds || [])].sort().join(',')}`
        const selectedWeight = weightOption ? { id: weightOption.id, value: weightOption.weightValue, unit: weightOption.weightUnit, label: weightLabel(weightOption) } : null
        return { lineId, itemId: item.id, name: item.name, unitPriceCents: (weightOption?.priceCents ?? item.priceCents) + (variant?.priceDeltaCents || 0) + addOns.reduce((sum, option) => sum + option.priceCents, 0), quantity: line.quantity, note: line.note || '', selectedVariantId: line.selectedVariantId || null, selectedWeightOptionId: line.selectedWeightOptionId || null, selectedWeight, selectedAddOnIds: line.selectedAddOnIds || [], optionLabel: [selectedWeight?.label || variant?.name, ...addOns.map((option) => option.name)].filter(Boolean).join(', ') }
      })
      setCart(nextCart)
      setOrderType(draft.type)
      setTableId(draft.tableId || '')
      setCustomerId(canSeeCustomers ? draft.customerId || '' : '')
      setWaiterId(draft.waiterId || '')
      setNote(draft.note || '')
      setDiscount(((draft.discountCents || 0) / 100).toFixed(2))
      setActiveDraftId(draft.id)
      toast.success('Draft restored. Check the table and current menu prices before sending.')
    } catch (error) { toast.error(friendlyError(error)) }
  }

  async function submitOrder() {
    if (submitting.current) return
    if (pendingPaymentOrder) return openOrdersForPendingPayment()
    if (!cart.length) return toast.error('Add at least one menu item.')
    if (orderType === 'dine-in' && !tableId) return toast.error('Choose a table for this dine-in order.')
    if (orderType === 'dine-in' && (!Number.isInteger(Number(covers)) || Number(covers) < 1 || Number(covers) > 40)) return toast.error('Guest count must be between 1 and 40.')
    if (orderType === 'dine-in' && Number(covers) > Number(tables.find((table) => table.id === tableId)?.capacity || 0)) return toast.error('Guest count exceeds this table’s seating capacity.')
    const enteredPaymentCents = Math.round(Number(paymentAmount) * 100)
    if (collectPaymentNow && (!Number.isSafeInteger(enteredPaymentCents) || enteredPaymentCents <= 0)) return toast.error('Choose an enabled payment method and enter a valid amount received.')
    if (collectPaymentNow && selectedPaymentMethod !== 'cash' && enteredPaymentCents > totals.totalCents) return toast.error('Payment amount cannot exceed the order total.')
    const requestId = pendingPaymentOrder?.orderId || orderIntentIdRef.current || createStableIntentId(activeDraftId || 'pos-order')
    orderIntentIdRef.current = requestId
    if (!pendingPaymentOrder) writePosDraft(draftStorageKey, { cart, orderType, tableId, covers, customerId, waiterId, note, discount, activeDraftId, pendingPaymentOrder: null, orderIntentId: requestId, paymentIntentId: paymentIntentIdRef.current })
    submitting.current = true
    setBusy(true)
    let orderCreated = Boolean(pendingPaymentOrder)
    try {
      const created = pendingPaymentOrder || await createOrder({
        requestId: requestId,
        type: orderType,
        tableId: orderType === 'dine-in' ? tableId || null : null,
        ...(orderType === 'dine-in' ? { covers: Number(covers) } : {}),
        customerId: canSeeCustomers ? customerId || null : null,
        waiterId: waiterId || null,
        discountCents,
        note: note.trim().slice(0, 500),
        items: cart.map(({ itemId, quantity, note: itemNote, selectedVariantId, selectedWeightOptionId, selectedAddOnIds }) => ({ itemId, quantity, note: itemNote, selectedVariantId, selectedWeightOptionId, selectedAddOnIds })),
        createdBy: user.uid,
      })
      orderCreated = true
      const confirmedTotals = {
        subtotalCents: created?.subtotalCents ?? totals.subtotalCents,
        discountCents: created?.discountCents ?? totals.discountCents,
        taxCents: created?.taxCents ?? totals.taxCents,
        totalCents: created?.totalCents ?? totals.totalCents,
      }
      const orderId = created?.orderId || requestId
      const tableName = pendingPaymentOrder?.tableName || tables.find((table) => table.id === tableId)?.name || ''
      const waiterName = pendingPaymentOrder?.waiterName || waiters.find((waiter) => waiter.id === waiterId)?.name || ''
      const receiptItems = pendingPaymentOrder?.items || cart.map((line) => {
        const selectedItem = items.find((item) => item.id === line.itemId)
        const addOnNames = (line.selectedAddOnIds || [])
          .map((optionId) => selectedItem?.addOns?.find((option) => option.id === optionId)?.name)
          .filter(Boolean)
        return {
          itemId: line.itemId,
          name: line.name,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.unitPriceCents * line.quantity,
          selectedWeight: line.selectedWeight || null,
          selectedVariant: line.selectedVariantId
            ? { name: selectedItem?.variants?.find((variant) => variant.id === line.selectedVariantId)?.name || '' }
            : null,
          selectedAddOns: addOnNames.map((name) => ({ name })),
        }
      })
      const savedOrder = pendingPaymentOrder || {
        orderId,
        orderNumber: created?.orderNumber || `DB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
        type: orderType,
        tableName,
        waiterId,
        waiterName,
        createdAt: new Date(),
        ...confirmedTotals,
        items: receiptItems,
      }
      let paidCents = 0
      if (collectPaymentNow && enteredPaymentCents > 0) {
        paidCents = Math.min(enteredPaymentCents, confirmedTotals.totalCents)
        const paymentId = paymentIntentIdRef.current || createStableIntentId(`pos-payment-${orderId}`)
        paymentIntentIdRef.current = paymentId
        if (!pendingPaymentOrder) {
          setPendingPaymentOrder(savedOrder)
          writePosDraft(draftStorageKey, { cart, orderType, tableId, covers, customerId, waiterId, note, discount, activeDraftId, pendingPaymentOrder: savedOrder, orderIntentId: orderId, paymentIntentId: paymentId })
        }
        await recordPayment({
          orderId,
          paymentId,
          amountCents: paidCents,
          method: selectedPaymentMethod,
          reference: paymentReference.trim().slice(0, 100),
        })
      }
      if (activeDraftId) {
        const savedDraftId = activeDraftId
        void runOperation('deleteOrderDraft', { draftId: savedDraftId }).catch((error) => {
          toast.error(`Order created, but the saved draft could not be removed. ${friendlyError(error)}`)
        })
      }
      writePosDraft(draftStorageKey, { cart: [], orderType: 'direct-bill', tableId: '', covers: 1, customerId: '', waiterId: '', note: '', discount: '', activeDraftId: null, pendingPaymentOrder: null, orderIntentId: null, paymentIntentId: null })
      toast.success(collectPaymentNow ? paidCents === confirmedTotals.totalCents ? 'Order paid in full.' : 'Order created with a partial payment.' : 'Order created successfully.')
      setReceipt({
        id: savedOrder.orderId,
        orderNumber: savedOrder.orderNumber,
        type: savedOrder.type,
        tableName: savedOrder.tableName,
        waiterId: savedOrder.waiterId,
        waiterName: savedOrder.waiterName,
        createdAt: savedOrder.createdAt,
        ...confirmedTotals,
        paidCents,
        refundedCents: 0,
        items: savedOrder.items,
      })
      orderIntentIdRef.current = null
      resetStableIntentId(activeDraftId || 'pos-order')
      paymentIntentIdRef.current = null
      resetStableIntentId(`pos-payment-${orderId}`)
      setCart([])
      setTicketOpen(typeof window !== 'undefined' && window.innerWidth >= 900)
      setNote('')
      setDiscount('')
      setTableId('')
      setCovers(1)
      setCustomerId('')
      setWaiterId('')
      setOrderType('direct-bill')
      setActiveDraftId(null)
      setSelectedDraftId('')
      setPaymentAmount('')
      setPaymentReference('')
      setPendingPaymentOrder(null)
    } catch (error) {
      toast.error(orderCreated ? `Order saved, but payment was not recorded. ${friendlyError(error)}` : friendlyError(error))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <div className="pos-page pos-experience" onKeyDown={handlePosKeyDown}>
    <header className="pos-hero">
      <div><div className="pos-kicker"><span className="pos-live-dot" /> FRONT OF HOUSE <span className="pos-kicker-divider">/</span> POINT OF SALE</div><h1 aria-label="Point of sale">Make it a good one.</h1><p>Build a ticket and create the order in one place.</p></div>
      <div className="pos-hero-meta"><span className="pos-live-pill"><span className="pos-live-dot" /> Menu synced</span><span className="pos-shortcut"><kbd>F2</kbd> Search <span>·</span> <kbd>Ctrl</kbd><kbd>↵</kbd> Place order</span></div>
    </header>
    <LimitNotices sources={[{ truncated: itemsTruncated, limit: itemsLimit, label: 'menu items' }, { truncated: categoriesTruncated, limit: categoriesLimit, label: 'categories' }, { truncated: customersTruncated, limit: customersLimit, label: 'customers' }, { truncated: draftsTruncated, limit: draftsLimit, label: 'draft orders' }, { truncated: tablesTruncated, limit: tablesLimit, label: 'tables' }, { truncated: waitersTruncated, limit: waitersLimit, label: 'waiters' }]} />

    <div className={`pos-layout pos-workbench ${ticketOpen ? 'ticket-open' : ''}`}>
      <section className="menu-browser pos-menu-browser" aria-label="Menu catalog">
        <div className="pos-catalog-head"><div><p className="eyebrow">THE MENU</p><h2>Pick your items</h2><span>{visibleItems.length} available {visibleItems.length === 1 ? 'item' : 'items'}</span></div>
          <label className="pos-search"><Search size={18} /><input ref={searchRef} aria-label="Search menu" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); addHighlightedItem() } }} placeholder="Search menu items…" />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X size={16} /></button>}<kbd>F2</kbd></label>
        </div>
        <div className="pos-category-row" role="tablist" aria-label="Menu categories"><button type="button" role="tab" aria-selected={category === 'all'} className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>Everything</button>{categories.map((entry) => <button type="button" role="tab" aria-selected={category === entry.id} key={entry.id} className={category === entry.id ? 'is-active' : ''} onClick={() => setCategory(entry.id)}>{entry.name}</button>)}</div>
        {itemsLoading ? <div className="pos-product-grid"><LoadingLines count={6} /></div> : visibleItems.length ? <div className="pos-product-grid">{visibleItems.map((item) => {
          const hasOptions = Boolean(item.itemType === 'weight-wise' || item.variants?.length || item.addOns?.length)
          const displayPrice = item.itemType === 'weight-wise' ? Math.min(...(item.weightOptions || []).map((option) => option.priceCents)) : item.priceCents
          return <button type="button" className="pos-product-card" key={item.id} onClick={() => hasOptions ? setOptionItem(item) : addToCart(item)} onMouseEnter={() => setSelectedMenuId(item.id)} aria-label={`${item.itemType === 'weight-wise' ? 'Choose weight for' : 'Add'} ${item.name}, ${money(displayPrice)}${hasOptions ? ', choose options' : ''}`} disabled={busy || Boolean(pendingPaymentOrder)}>
            <span className="pos-product-photo"><MenuImage url={item.imageUrl} name={item.name} /><span className="pos-product-add"><Plus size={19} /></span>{hasOptions && <span className="pos-option-badge">Customize</span>}</span>
            <span className="pos-product-info"><span className="pos-product-category">{item.categoryName || categories.find((entry) => entry.id === item.categoryId)?.name || 'Menu favorite'}</span><strong>{item.name}</strong><span className="pos-product-description">{item.description || (item.itemType === 'weight-wise' ? 'Choose a weight' : hasOptions ? 'Options available' : 'Made fresh to order')}</span><span className="pos-product-price">{item.itemType === 'weight-wise' ? 'From ' : ''}{money(displayPrice)}<span>{item.itemType === 'weight-wise' ? ' / weight' : ' / item'}</span></span></span>
          </button>
        })}</div> : <div className="pos-empty-catalog"><div className="pos-empty-icon"><Search size={21} /></div><strong>{search ? 'No matching dishes' : 'Nothing on this menu yet'}</strong><span>{search ? 'Try another name or choose a different category.' : 'Add available items in Menu management to start taking orders.'}</span>{search && <button type="button" className="button button-subtle" onClick={() => setSearch('')}>Clear search</button>}</div>}
        <div className="pos-catalog-foot"><span><i /> Prices update from your live menu</span><span>Tap any item to add it to the ticket</span></div>
      </section>

      <aside className={`cart-panel pos-ticket pos-ticket-drawer ${ticketOpen ? 'is-open' : ''}`} aria-label="Current order">
        <button type="button" className="pos-ticket-close" onClick={() => setTicketOpen(false)} aria-label="Close order ticket"><X size={18} /></button>
        <div className="pos-ticket-heading"><div className="pos-ticket-title"><span className="pos-ticket-icon"><ShoppingBag size={17} /></span><div><p className="eyebrow">YOUR TICKET</p><h2>{pendingPaymentOrder ? 'Payment due' : activeDraftId ? 'Saved order' : 'New order'}</h2></div></div><div className="pos-ticket-actions"><span className="pos-ticket-count">{itemCount} items</span><button type="button" className="pos-clear-button" onClick={startNewOrder} disabled={pendingPaymentOrder || (!cart.length && !activeDraftId)} aria-label="Start a new order" title="Start a new order"><Trash2 size={16} /></button></div></div>
        {pendingPaymentOrder && <div className="pos-pending-alert" role="status"><strong>Order {pendingPaymentOrder.orderNumber || ''} is already with the kitchen.</strong><span>Payment is recorded from the Orders screen.</span><button type="button" className="button button-subtle" onClick={openOrdersForPendingPayment}>Open Orders</button></div>}

        {(cart.length > 0 || orderType !== 'direct-bill') && <div className="pos-order-types" role="group" aria-label="Order type">{[
          { value: 'dine-in', label: 'Dine in', icon: Utensils },
          { value: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
          { value: 'delivery', label: 'Delivery', icon: Truck },
          { value: 'direct-bill', label: 'Quick sale', icon: Wallet },
        ].map(({ value, label, icon: Icon }) => <button type="button" key={value} className={orderType === value ? 'is-active' : ''} aria-pressed={orderType === value} disabled={Boolean(pendingPaymentOrder)} onClick={() => { setOrderType(value); if (value !== 'dine-in') { setTableId(''); setCovers(1) } }}><Icon size={16} /><span>{label}</span></button>)}</div>}

        {orderType === 'dine-in' && <div className="pos-seating-fields"><label className="pos-field"><span>Table</span><select required value={tableId} onChange={(event) => setTableId(event.target.value)} disabled={Boolean(pendingPaymentOrder)}><option value="">{tables.length ? 'Choose an available table' : 'No tables set up'}</option>{visibleTables.map((table) => <option key={table.id} value={table.id}>{table.name} · {table.capacity || '—'} seats</option>)}</select></label><label className="pos-field pos-covers-field"><span>Guests</span><input aria-label="Number of guests" type="number" min="1" max="40" step="1" required value={covers} onChange={(event) => setCovers(event.target.value)} disabled={Boolean(pendingPaymentOrder)} /></label></div>}

        <details className="cart-disclosure draft-disclosure pos-drafts" open={Boolean(activeDraftId)}><summary><span className="pos-drafts-title">Saved tickets</span><span>{drafts.length} saved</span></summary><div className="draft-toolbar"><select aria-label="Saved drafts" value={selectedDraftId} onChange={(event) => setSelectedDraftId(event.target.value)} disabled={Boolean(pendingPaymentOrder)}><option value="">Choose a saved ticket</option>{drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.type} · {formatDate(draft.updatedAt)}</option>)}</select><button type="button" className="button button-small" onClick={resumeDraft} disabled={Boolean(pendingPaymentOrder) || !selectedDraftId}>Resume</button><button type="button" className="button button-small" onClick={saveDraft} disabled={Boolean(pendingPaymentOrder) || !cart.length}>Save</button></div></details>

        <div className={`pos-guest-fields ${canSeeCustomers ? '' : 'single-field'}`}>{canSeeCustomers && <label className="pos-field"><span>Customer</span><select value={customerId} onChange={(event) => setCustomerId(event.target.value)} disabled={Boolean(pendingPaymentOrder)}><option value="">Walk-in guest</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</option>)}</select></label>}<label className="pos-field"><span>Served by</span><select value={waiterId} onChange={(event) => setWaiterId(event.target.value)} disabled={Boolean(pendingPaymentOrder)}><option value="">Assign waiter</option>{waiters.filter((waiter) => waiter.status !== 'inactive').map((waiter) => <option key={waiter.id} value={waiter.id}>{waiter.name}</option>)}</select></label></div>

        <div className="pos-cart-list" aria-live="polite">{cart.length ? cart.map((line) => <article className="pos-cart-item" key={line.lineId}><div className="pos-cart-item-main"><div className="pos-cart-item-copy"><strong>{line.name}</strong>{line.optionLabel && <span>{line.optionLabel}</span>}<small>{money(line.unitPriceCents)} each</small></div><strong className="pos-line-total">{money(line.unitPriceCents * line.quantity)}</strong></div><div className="pos-cart-item-controls"><div className="pos-quantity-control"><button type="button" aria-label={`Remove one ${line.name}`} onClick={() => changeQty(line.lineId, -1)} disabled={Boolean(pendingPaymentOrder)}><Minus size={14} /></button><span>{line.quantity}</span><button type="button" aria-label={`Add one ${line.name}`} onClick={() => changeQty(line.lineId, 1)} disabled={Boolean(pendingPaymentOrder) || line.quantity >= 99}><Plus size={14} /></button></div><details className="cart-line-note" open={Boolean(line.note)}><summary>{line.note ? 'Edit note' : 'Add kitchen note'}</summary><input className="cart-item-note" aria-label={`Kitchen note for ${line.name}`} placeholder="e.g. no onions" maxLength={300} value={line.note} onChange={(event) => updateLineNote(line.lineId, event.target.value)} disabled={Boolean(pendingPaymentOrder)} /></details></div></article>) : <div className="pos-cart-empty"><span className="pos-cart-empty-icon"><ShoppingBag size={21} /></span><strong>Your ticket is waiting</strong><span>Choose a dish from the menu to begin.</span></div>}</div>

        <details className="cart-disclosure order-extras pos-order-notes" open={Boolean(note || discount)}><summary><span>Notes &amp; adjustments</span><span>{note || discount ? 'Added' : 'Optional'}</span></summary><div className="order-extras-fields"><label className="pos-field pos-note-field"><span>Order note for kitchen</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Allergies or guest requests" maxLength={500} disabled={Boolean(pendingPaymentOrder)} /></label>{canDiscount && <label className="pos-field"><span>Discount amount</span><input aria-label="Discount amount" type="number" min="0" step="0.01" max={(subtotalCents / 100).toFixed(2)} value={discount} onChange={(event) => setDiscount(event.target.value)} placeholder="0.00" disabled={Boolean(pendingPaymentOrder)} /></label>}</div></details>

        <div className="pos-payment-block"><div className="pos-payment-heading"><div><p className="eyebrow">PAYMENT</p><strong>{canCollectPayment ? 'How will they pay?' : 'Payment can be added later'}</strong></div><span className={`pos-payment-status ${collectPaymentNow ? 'is-active' : ''}`}>{pendingPaymentOrder && !canCollectPayment ? 'Access needed' : collectPaymentNow ? 'Pay now' : 'Pay later'}</span></div>{canCollectPayment && <><div className="pos-payment-mode" role="group" aria-label="Payment timing"><button type="button" aria-pressed={collectPaymentNow} className={collectPaymentNow ? 'is-active' : ''} disabled={!paymentMethods.length || Boolean(pendingPaymentOrder)} onClick={() => setCollectPayment(true)}><CreditCard size={15} /> Collect now</button><button type="button" aria-pressed={!collectPaymentNow} className={!collectPaymentNow ? 'is-active' : ''} disabled={Boolean(pendingPaymentOrder)} onClick={() => setCollectPayment(false)}>Add to orders</button></div>{collectPaymentNow && <><div className="pos-payment-methods" role="group" aria-label="Payment method">{paymentMethods.map((method) => <button type="button" key={method} className={selectedPaymentMethod === method ? 'is-active' : ''} aria-pressed={selectedPaymentMethod === method} onClick={() => setPaymentMethod(method)}>{method === 'cash' ? <Banknote size={15} /> : method === 'card' ? <CreditCard size={15} /> : <Wallet size={15} />}{method[0].toUpperCase() + method.slice(1)}</button>)}</div><label className="pos-field pos-payment-amount"><span>{selectedPaymentMethod === 'cash' ? 'Cash received' : 'Amount received'}</span><div className="pos-amount-input"><span>{restaurant[0]?.currency || currency}</span><input aria-label={selectedPaymentMethod === 'cash' ? 'Cash received' : 'Payment amount'} type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} /></div></label>{selectedPaymentMethod !== 'cash' && <label className="pos-field pos-reference-field"><span>Payment reference <small>Optional</small></span><input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Terminal or transfer reference" maxLength={100} /></label>}{changeDueCents > 0 && <div className="pos-payment-outcome"><span>Change due</span><strong className="has-change">{money(changeDueCents)}</strong></div>}</>}</>}{pendingPaymentOrder && !canCollectPayment && <p className="pos-payment-note">This order is saved. Ask an owner, manager, or cashier to record its payment.</p>}{!pendingPaymentOrder && !canCollectPayment && <p className="pos-payment-note">A cashier or manager can record payment from the Orders screen.</p>}</div>

        <div className="pos-totals"><div><span>Subtotal</span><strong>{money(totals.subtotalCents)}</strong></div>{totals.discountCents > 0 && <div className="pos-discount-row"><span>Discount</span><strong>−{money(totals.discountCents)}</strong></div>}<div><span>Tax <small>{taxRate ? `${(taxRate * 100).toFixed(2).replace(/\.00$/, '')}%` : 'included'}</small></span><strong>{money(totals.taxCents)}</strong></div><div className="pos-total-row"><span>Total due</span><strong>{money(totals.totalCents)}</strong></div></div>
        <button type="button" className="pos-checkout-button" onClick={submitOrder} disabled={busy || !cart.length || (orderType === 'dine-in' && !tableId) || (collectPaymentNow && (!Number.isSafeInteger(enteredPaymentCents) || enteredPaymentCents <= 0)) || (pendingPaymentOrder && (!canCollectPayment || !paymentMethods.length))}><span className="pos-checkout-icon">{collectPaymentNow ? <CreditCard size={18} /> : <Check size={19} />}</span><span>{busy ? 'Processing ticket…' : pendingPaymentOrder ? 'Open Orders for payment' : 'Create order'}<small>{busy ? 'Please wait' : `${itemCount} dishes · ${money(totals.totalCents)}`}</small></span><ArrowUpRight size={19} /></button>
        <p className="pos-trust-note"><Check size={13} /> Menu prices and tax are verified before the order is saved.</p>
      </aside>
    </div>
    {ticketOpen && <div className="pos-ticket-backdrop" onClick={() => setTicketOpen(false)} aria-hidden="true" />}
    {cart.length > 0 && !ticketOpen && (
      <button type="button" className="pos-open-ticket" onClick={() => setTicketOpen(true)} aria-label="View current order">
        <span className="pos-open-ticket-main"><ShoppingBag size={18} /><span>View ticket ({itemCount})</span></span>
        <strong className="pos-open-ticket-total">{money(totals.totalCents)}</strong>
        <ArrowUpRight size={17} />
      </button>
    )}
    {optionItem?.itemType === 'weight-wise' && <WeightSelectionDialog item={optionItem} onCancel={() => setOptionItem(null)} onAdd={(weightOptionId, addOnIds, quantity) => { addToCart(optionItem, '', addOnIds, weightOptionId, quantity); setOptionItem(null) }} />}
    {optionItem && optionItem.itemType !== 'weight-wise' && <MenuOptionsDialog item={optionItem} onCancel={() => setOptionItem(null)} onAdd={(variantId, addOnIds) => { addToCart(optionItem, variantId, addOnIds); setOptionItem(null) }} />}
    {receipt && <ReceiptDialog order={receipt} restaurantName={restaurant[0]?.name || 'Restaurant'} currency={restaurant[0]?.currency || currency} onClose={() => setReceipt(null)} />}
  </div>
}

function WeightSelectionDialog({ item, onCancel, onAdd }) {
  const [weightId, setWeightId] = useState(item.weightOptions?.[0]?.id || '')
  const [addOnIds, setAddOnIds] = useState([])
  const [quantity, setQuantity] = useState(1)
  const selectedWeight = item.weightOptions?.find((option) => option.id === weightId)
  const addOns = (item.addOns || []).filter((option) => addOnIds.includes(option.id))
  const unitPriceCents = (selectedWeight?.priceCents || 0) + addOns.reduce((sum, option) => sum + option.priceCents, 0)
  function toggleAddOn(id) {
    setAddOnIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <section className="modal-panel options-modal weight-options-modal" role="dialog" aria-modal="true" aria-labelledby="weight-options-title">
      <div className="modal-heading"><div><p className="eyebrow">SELECT WEIGHT</p><h2 id="weight-options-title">{item.name} — Select Weight</h2></div><button className="icon-button" aria-label="Close" onClick={onCancel}>×</button></div>
      <fieldset className="option-fieldset"><legend>Available weights</legend>{(item.weightOptions || []).map((option) => <label className={`option-choice ${weightId === option.id ? 'is-selected' : ''}`} key={option.id}><input type="radio" name="weight-option" checked={weightId === option.id} onChange={() => setWeightId(option.id)} /><span>{weightLabel(option)}</span><strong>{money(option.priceCents)}</strong></label>)}</fieldset>
      {item.addOns?.length > 0 && <fieldset className="option-fieldset"><legend>Add-ons</legend>{item.addOns.map((option) => <label className="option-choice" key={option.id}><input type="checkbox" checked={addOnIds.includes(option.id)} onChange={() => toggleAddOn(option.id)} /><span>{option.name}</span><strong>+{money(option.priceCents)}</strong></label>)}</fieldset>}
      <div className="weight-portion-row"><span>Portions</span><div className="pos-quantity-control"><button type="button" aria-label="Remove one portion" onClick={() => setQuantity((value) => Math.max(1, value - 1))} disabled={quantity <= 1}><Minus size={14} /></button><span>{quantity}</span><button type="button" aria-label="Add one portion" onClick={() => setQuantity((value) => Math.min(99, value + 1))} disabled={quantity >= 99}><Plus size={14} /></button></div></div>
      <div className="weight-selection-summary"><div><span>Selected weight</span><strong>{selectedWeight ? weightLabel(selectedWeight) : 'Choose a weight'}</strong></div><div><span>Unit price</span><strong>{money(unitPriceCents)}</strong></div><div><span>Quantity</span><strong>× {quantity}</strong></div><div className="weight-selection-total"><span>Total</span><strong>{money(unitPriceCents * quantity)}</strong></div></div>
      <div className="modal-actions"><button className="button button-subtle" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={!selectedWeight} onClick={() => onAdd(weightId, addOnIds, quantity)}>Add to Cart</button></div>
    </section>
  </div>
}

function MenuOptionsDialog({ item, onCancel, onAdd }) {
  const [variantId, setVariantId] = useState('')
  const [addOnIds, setAddOnIds] = useState([])
  const selectedVariant = item.variants?.find((option) => option.id === variantId)
  const selectedAddOns = (item.addOns || []).filter((option) => addOnIds.includes(option.id))
  const totalCents = item.priceCents + (selectedVariant?.priceDeltaCents || 0) + selectedAddOns.reduce((sum, option) => sum + option.priceCents, 0)
  function toggleAddOn(id) {
    setAddOnIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}><section className="modal-panel options-modal" role="dialog" aria-modal="true" aria-labelledby="options-title"><div className="modal-heading"><div><p className="eyebrow">MENU OPTIONS</p><h2 id="options-title">{item.name}</h2></div><button className="icon-button" aria-label="Close" onClick={onCancel}>×</button></div>{item.variants?.length > 0 && <fieldset className="option-fieldset"><legend>Choose a size</legend><label className="option-choice"><input type="radio" name="variant" checked={!variantId} onChange={() => setVariantId('')} /><span>Regular</span><strong>{money(item.priceCents)}</strong></label>{item.variants.map((variant) => <label className="option-choice" key={variant.id}><input type="radio" name="variant" checked={variantId === variant.id} onChange={() => setVariantId(variant.id)} /><span>{variant.name}</span><strong>{variant.priceDeltaCents >= 0 ? '+' : '−'}{money(Math.abs(variant.priceDeltaCents))}</strong></label>)}</fieldset>}{item.addOns?.length > 0 && <fieldset className="option-fieldset"><legend>Add-ons</legend>{item.addOns.map((addOn) => <label className="option-choice" key={addOn.id}><input type="checkbox" checked={addOnIds.includes(addOn.id)} onChange={() => toggleAddOn(addOn.id)} /><span>{addOn.name}</span><strong>+{money(addOn.priceCents)}</strong></label>)}</fieldset>}<div className="options-total"><span>Item total</span><strong>{money(totalCents)}</strong></div><div className="modal-actions"><button className="button button-subtle" onClick={onCancel}>Cancel</button><button className="button button-primary" onClick={() => onAdd(variantId, addOnIds)}>Add item</button></div></section></div>
}

function OrdersPage() {
  const { membership } = useAuth()
  const { records, loading, error, truncated: ordersTruncated, limit: ordersLimit } = useRecords('orders')
  const canSeeFinancials = ['owner', 'manager', 'cashier'].includes(membership?.role)
  const { records: financials, truncated: financialsTruncated, limit: financialsLimit } = useRecords('orderFinancials', 150, canSeeFinancials)
  const { records: restaurant } = useRecords('settings', 1, canSeeFinancials)
  const canVoidOrders = ['owner', 'manager'].includes(membership?.role) || membership?.permissions?.includes('voidOrders')
  const [filter, setFilter] = useState('active')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState('')
  const [detailsOrder, setDetailsOrder] = useState(null)
  const [transferTarget, setTransferTarget] = useState(null)
  const [paymentOrder, setPaymentOrder] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const filterMenuRef = useRef(null)
  const canTransferTable = ['owner', 'manager', 'waiter'].includes(membership?.role)
  const ordersWithFinancials = records.map((order) => mergeOrderWithFinancials(order, financials.find((record) => record.id === order.id) || {}))
  const filterOptions = [
    { value: 'active', label: 'Active orders' },
    { value: 'all', label: 'All orders' },
    { value: 'served', label: 'Served' },
    { value: 'cancelled', label: 'Cancelled' },
  ]
  const visibleFilterLabel = filterOptions.find((option) => option.value === filter)?.label || 'Active orders'
  const visible = ordersWithFinancials.filter((order) => (filter === 'all' || (filter === 'active' ? !['served', 'cancelled'].includes(order.status) : order.status === filter)) && `${order.orderNumber || ''} ${order.type || ''} ${order.tableName || ''} ${(order.items || []).map((item) => item.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => {
    function handlePointerDown(event) {
      if (filterMenuRef.current && !filterMenuRef.current.contains(event.target)) {
        setFilterMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  const transitionIntentIds = useRef({})

  async function cancelOrder(order) {
    const reason = window.prompt(`Reason for cancelling ${order.orderNumber || 'this order'}?`)
    if (!reason?.trim()) return
    const requestId = transitionIntentIds.current[`cancel-${order.id}`] || createStableIntentId(`cancel-${order.id}`)
    transitionIntentIds.current[`cancel-${order.id}`] = requestId
    setBusyId(order.id)
    try {
      await transitionOrder({ orderId: order.id, to: 'cancelled', reason: reason.trim(), requestId })
      toast.success('Order cancelled and recorded in the audit trail.')
      transitionIntentIds.current[`cancel-${order.id}`] = null
      resetStableIntentId(`cancel-${order.id}`)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusyId('') }
  }

  return <>
    <PageHeading eyebrow="SERVICE FLOOR" title="Orders" description="Track order progress and record payments." action={<div className="order-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search orders" placeholder="Search orders" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="filter-menu-wrap" ref={filterMenuRef}><button type="button" className={`filter-trigger ${filterMenuOpen ? 'open' : ''}`} aria-label="Filter orders" aria-expanded={filterMenuOpen} onClick={() => setFilterMenuOpen((open) => !open)}><span>{visibleFilterLabel}</span></button>{filterMenuOpen && <div className="filter-popover" role="listbox" aria-label="Order filters">{filterOptions.map((option) => <button key={option.value} type="button" className={`filter-option ${filter === option.value ? 'selected' : ''}`} onClick={() => { setFilter(option.value); setFilterMenuOpen(false) }}>{option.label}</button>)}</div>}</div></div>} />
    <LimitNotices sources={[{ truncated: ordersTruncated, limit: ordersLimit, label: 'orders' }, { truncated: financialsTruncated, limit: financialsLimit, label: 'financial records' }]} />
    {error && <div className="inline-alert">{error}</div>}
    <section className="panel records-panel">{loading ? <LoadingLines /> : visible.length ? <div className="table-scroll"><table><thead><tr><th>Order</th><th>Placed</th><th>Type / table</th><th>Waiter</th><th>Items</th>{canSeeFinancials && <><th>Payment</th><th>Total</th></>}<th>Action</th></tr></thead><tbody>{visible.map((order) => <tr key={order.id}><td><strong>{order.orderNumber || `#${order.id.slice(0, 7)}`}</strong></td><td>{formatDate(order.createdAt)}</td><td>{order.type || 'dine-in'}{order.tableName ? ` · ${order.tableName}` : ''}</td><td>{order.waiterName || '—'}</td><td>{order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0} items</td>{canSeeFinancials && <><td><button className={`payment-status ${order.paymentStatus === 'paid' ? 'paid' : ''}`} onClick={() => setPaymentOrder(order)}>{order.paymentStatus || 'unpaid'}{order.paymentStatus !== 'paid' && <CirclePlus size={14} />}</button></td><td>{money(order.totalCents)}</td></>}<td><div className="row-actions">{order.status && !['served', 'cancelled'].includes(order.status) && <>{canVoidOrders && ['queued', 'preparing'].includes(order.status) && <button className="button button-small button-danger" onClick={() => cancelOrder(order)} disabled={busyId === order.id}>{busyId === order.id ? 'Cancelling' : 'Cancel'}</button>}{canTransferTable && order.type === 'dine-in' && <button className="button button-small" onClick={() => setTransferTarget(order)}>Transfer table</button>}</>}{canSeeFinancials && <button className="icon-button" title="Print receipt" aria-label="Print receipt" onClick={() => setReceipt(order)}><Printer size={16} /></button>}</div></td></tr>)}</tbody></table></div> : <EmptyState title="No orders in this view" detail="New POS orders will appear here as soon as they are sent." />}</section>
    {detailsOrder && <OrderDetailsDialog order={detailsOrder} canSeeFinancials={canSeeFinancials} onClose={() => setDetailsOrder(null)} />}
    {paymentOrder && <PaymentDialog order={paymentOrder} onClose={() => setPaymentOrder(null)} />}
    {receipt && <ReceiptDialog order={receipt} restaurantName={restaurant[0]?.name || 'Restaurant'} currency={restaurant[0]?.currency || currency} onClose={() => setReceipt(null)} />}
    {transferTarget && <TransferTableDialog order={transferTarget} onClose={() => setTransferTarget(null)} onTransferred={() => setTransferTarget(null)} />}
  </>
}

function OrderDetailsDialog({ order, canSeeFinancials, onClose }) {
  const items = order.items || []
  const status = order.status || 'unknown'
  const subtotalCents = Number(order.subtotalCents || 0)
  const discountCents = Number(order.discountCents || 0)
  const taxCents = Number(order.taxCents || 0)
  const totalCents = Number(order.totalCents || 0)
  const paidCents = Number(order.paidCents || 0)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-panel order-details-dialog" role="dialog" aria-modal="true" aria-labelledby="order-details-title">
        <div className="modal-heading">
          <div><p className="eyebrow">ORDER DETAILS</p><h2 id="order-details-title">{order.orderNumber || `#${order.id?.slice(0, 7)}`}</h2></div>
          <button className="icon-button" aria-label="Close order details" onClick={onClose}>×</button>
        </div>
        <div className="order-details-meta">
          <div><span>Status</span><strong className={`status-pill status-${status}`}>{status}</strong></div>
          <div><span>Placed</span><strong>{formatDate(order.createdAt)}</strong></div>
          <div><span>Type</span><strong>{(order.type || 'dine-in').replaceAll('-', ' ')}{order.tableName ? ` · ${order.tableName}` : ''}</strong></div>
          {order.waiterName && <div><span>Waiter</span><strong>{order.waiterName}</strong></div>}
        </div>
        {order.note && <p className="order-details-note"><strong>Order note</strong>{order.note}</p>}
        <div className="order-details-list">
          <div className="order-details-list-heading"><strong>Items</strong><span>{items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)} total</span></div>
          {items.length ? items.map((item, index) => {
            const variantName = typeof item.selectedVariant === 'string' ? item.selectedVariant : item.selectedVariant?.name
            const weightName = typeof item.selectedWeight === 'string' ? item.selectedWeight : item.selectedWeight?.label
            const addOnNames = (item.selectedAddOns || []).map((option) => typeof option === 'string' ? option : option.name).filter(Boolean)
            return <div className="order-details-item" key={`${item.itemId || item.name}-${index}`}>
              <div>
                <strong>{item.quantity} × {item.name}</strong>
                {(weightName || variantName || addOnNames.length > 0) && <span>{[weightName, variantName, ...addOnNames].filter(Boolean).join(' · ')}</span>}
                {item.note && <small>Note: {item.note}</small>}
              </div>
              {canSeeFinancials && Number.isFinite(Number(item.unitPriceCents)) && <strong>{money(Number(item.unitPriceCents) * Number(item.quantity || 0))}</strong>}
            </div>
          }) : <p className="order-details-empty">No item details were saved for this order.</p>}
        </div>
        {canSeeFinancials && <div className="order-details-totals">
          <div><span>Subtotal</span><span>{money(subtotalCents)}</span></div>
          {discountCents > 0 && <div><span>Discount</span><span>−{money(discountCents)}</span></div>}
          <div><span>Tax</span><span>{money(taxCents)}</span></div>
          <div className="order-details-total"><strong>Total</strong><strong>{money(totalCents)}</strong></div>
          <div><span>Paid</span><span>{money(paidCents)}</span></div>
          <div><span>Balance due</span><span>{money(Math.max(0, totalCents - paidCents))}</span></div>
        </div>}
        <div className="modal-actions"><button className="button button-subtle" onClick={onClose}>Close</button></div>
      </section>
    </div>
  )
}

function PaymentDialog({ order, onClose }) {
  const { membership } = useAuth()
  const [mode, setMode] = useState('payment')
  const [amount, setAmount] = useState(((order.totalCents || 0) - (order.paidCents || 0)) / 100)
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const paymentIntentIdRef = useRef(null)
  const canRefund = ['owner', 'manager'].includes(membership?.role) || membership?.permissions?.includes('refunds')
  const amountDue = Math.max(0, (order.totalCents || 0) - (order.paidCents || 0))
  const amountPaid = Math.max(0, (order.paidCents || 0) - (order.refundedCents || 0))
  const remaining = mode === 'refund' ? amountPaid : amountDue
  async function submit(event) {
    event.preventDefault()
    if (submitting.current) return
    const amountCents = Math.round(Number(amount) * 100)
    if (!amountCents || amountCents > remaining) return toast.error(`Enter an amount no greater than ${mode === 'refund' ? 'the refundable amount' : 'the remaining balance'}.`)
    if (mode === 'refund' && !reference.trim()) return toast.error('Enter a reason for the refund.')
    const requestId = paymentIntentIdRef.current || createStableIntentId(`${mode}-${order.id}`)
    paymentIntentIdRef.current = requestId
    submitting.current = true
    setBusy(true)
    try {
      if (mode === 'refund') {
        await recordRefund({ orderId: order.id, refundId: requestId, amountCents, reason: reference.trim().slice(0, 300) })
        toast.success('Refund adjustment recorded.')
      } else {
        await recordPayment({ orderId: order.id, paymentId: requestId, amountCents, method, reference: reference.trim().slice(0, 100) })
        toast.success('Payment recorded.')
      }
      paymentIntentIdRef.current = null
      resetStableIntentId(`${mode}-${order.id}`)
      onClose()
    } catch (error) { toast.error(friendlyError(error)) } finally { submitting.current = false; setBusy(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="payment-title"><div className="modal-heading"><div><p className="eyebrow">ORDER {order.orderNumber || order.id.slice(0, 7)}</p><h2 id="payment-title">{mode === 'refund' ? 'Record refund' : 'Record payment'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>{canRefund && <div className="order-type-toggle"><button className={mode === 'payment' ? 'selected' : ''} onClick={() => { setMode('payment'); setAmount((amountDue / 100).toFixed(2)) }}>Payment</button><button className={mode === 'refund' ? 'selected' : ''} onClick={() => { setMode('refund'); setAmount((amountPaid / 100).toFixed(2)) }} disabled={!amountPaid}>Refund</button></div>}<div className="balance-box"><span>{mode === 'refund' ? 'Paid and not refunded' : 'Remaining balance'}</span><strong>{money(remaining)}</strong></div><form onSubmit={submit} className="modal-form"><label>Amount<input type="number" min="0.01" max={(remaining / 100).toFixed(2)} step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} /></label>{mode === 'payment' ? <><label>Payment method<select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Cash</option><option value="card">Card (record only)</option><option value="digital">Digital payment</option></select></label><label>Reference (optional)<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Receipt or terminal reference" /></label></> : <label>Refund reason<input required value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Required for the audit record" maxLength={300} /></label>}<div className="modal-actions"><button type="button" className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || !remaining}>{busy ? 'Recording…' : mode === 'refund' ? 'Record refund' : 'Record payment'}</button></div><p className="form-helper">{mode === 'refund' ? 'This records an authorized refund adjustment. The original payment record is retained.' : 'This records a payment already received. It does not process cards or verify bank transfers.'}</p></form></section></div>
}

function TransferTableDialog({ order, onClose, onTransferred }) {
  const { records: tables, loading, error, truncated, limit } = useRecords('tables')
  const [targetTableId, setTargetTableId] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event) {
    event.preventDefault()
    if (!targetTableId) return toast.error('Choose an available table.')
    setBusy(true)
    try {
      await runOperation('transferOrderTable', { orderId: order.id, targetTableId })
      toast.success('Order transferred to the new table.')
      onTransferred()
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="transfer-title"><div className="modal-heading"><div><p className="eyebrow">{order.orderNumber}</p><h2 id="transfer-title">Transfer table</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div>{error && <div className="inline-alert">{error}</div>}<LimitNotices sources={[{ truncated, limit, label: 'tables' }]} /><form className="modal-form" onSubmit={submit}><label>Available table<select required value={targetTableId} onChange={(event) => setTargetTableId(event.target.value)}><option value="">{loading ? 'Loading tables…' : 'Choose a table'}</option>{tables.filter((table) => table.id !== order.tableId && table.status === 'available' && transferTableFitsCovers(table, order)).map((table) => <option key={table.id} value={table.id}>{table.name} · {table.capacity} seats</option>)}</select></label><p className="form-helper">The transfer is rechecked against the live floor and reservation schedule before saving.</p><div className="modal-actions"><button type="button" className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || loading}>{busy ? 'Transferring…' : 'Transfer order'}</button></div></form></section></div>
}

function formatDate(timestamp) {
  const date = timestamp?.toDate ? timestamp.toDate() : timestamp ? new Date(timestamp) : null
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
}

function reservationHasEnded(reservation) {
  const end = reservation.endsAt?.toDate ? reservation.endsAt.toDate() : new Date(reservation.endsAt)
  return !Number.isNaN(end.valueOf()) && end.getTime() < Date.now()
}

function displayedReservationStatus(reservation) {
  return reservation.status === 'booked' && reservationHasEnded(reservation) ? 'no-show' : reservation.status
}

function transferTableFitsCovers(table, order) {
  return !Number.isInteger(order.covers) || order.covers <= Number(table.capacity || 0)
}

function localDateKey(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null
  if (!date || Number.isNaN(date.valueOf())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function OperationsPage() {
  const { pathname } = useLocation()
  const normalizedPath = (pathname.replace(/\/+$/, '') || '/').toLowerCase()

  if (normalizedPath === '/' || normalizedPath === '/dashboard') return <Dashboard />
  if (normalizedPath === '/pos' || normalizedPath === '/pos-window' || normalizedPath.endsWith('/pos-window')) return <PosPage />
  if (normalizedPath === '/orders') return <OrdersPage />
  return <ResourcePage path={normalizedPath} />
}

export function NotFoundPage() {
  return <section className="not-found-page" aria-labelledby="not-found-title">
    <strong aria-hidden="true">404</strong>
    <h1 id="not-found-title">This page isn’t here.</h1>
    <p>That address does not match a RestaurantOS page. Return to your workspace to continue.</p>
    <Link className="button button-primary" to="/">Return to your workspace</Link>
  </section>
}

const pageConfig = {
  '/waiters': { title: 'Waiters', eyebrow: 'SERVICE TEAM', description: 'Add waiter names and contact details for POS orders.', collection: 'waiters', fields: [{ name: 'name', label: 'Waiter name', required: true }, { name: 'phone', label: 'Phone (optional)', type: 'tel' }, { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }] },
  '/tables': { title: 'Tables', eyebrow: 'DINING ROOM', description: 'Keep seating and service capacity up to date.', collection: 'tables', fields: [{ name: 'name', label: 'Table name or number', required: true }, { name: 'capacity', label: 'Seating capacity', type: 'number', required: true, min: 1 }] },
  '/expenses': { title: 'Expenses', eyebrow: 'COST CONTROL', description: 'Record day-to-day costs with a clear paper trail.', collection: 'expenses', fields: [{ name: 'category', label: 'Category', required: true }, { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0.01, step: '0.01' }, { name: 'date', label: 'Date', type: 'date', required: true }, { name: 'method', label: 'Payment method', type: 'select', options: ['cash', 'card', 'transfer'] }, { name: 'description', label: 'Description' }], readonly: true },
  '/customers': { title: 'Customers', eyebrow: 'GUEST RELATIONSHIPS', description: 'Keep only the guest details your team needs.', collection: 'customers', fields: [{ name: 'name', label: 'Customer name', required: true }, { name: 'phone', label: 'Phone (optional)', type: 'tel' }, { name: 'email', label: 'Email (optional)', type: 'email' }] },
  '/suppliers': { title: 'Suppliers', eyebrow: 'PURCHASING', description: 'Maintain trusted supplier contacts.', collection: 'suppliers', fields: [{ name: 'name', label: 'Supplier name', required: true }, { name: 'contact', label: 'Contact name' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' }] },
}

function ResourcePage({ path }) {
  if (path === '/waiters') return <WaitersPage />
  if (path === '/tables') return <TablesPage />
  if (path === '/customers') return <CustomerPage />
  if (path === '/menu') return <MenuManagement />
  if (path === '/inventory') return <InventoryPage />
  if (path === '/purchases') return <PurchasesPage />
  if (path === '/reports') return <ReportsPage />
  if (path === '/staff') return <StaffPage />
  if (path === '/settings') return <SettingsPage />
  if (path === '/audit') return <AuditPage />
  const config = pageConfig[path]
  if (config) return <RecordWorkspace config={config} />
  return <NotFoundPage />
}

function WaitersPage() {
  const { membership, user } = useAuth()
  const { records, loading, error, truncated, limit } = useRecords('waiters')
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const fields = pageConfig['/waiters'].fields

  if (!['owner', 'manager'].includes(membership?.role)) return <div className="inline-alert">Waiter management is available to owners and managers.</div>

  async function save(values) {
    setBusy(true)
    try {
      const name = String(values.name || '').trim()
      const phone = String(values.phone || '').trim()
      if (!name || name.length > 120) throw new Error('Enter a waiter name up to 120 characters long.')
      if (phone.length > 40) throw new Error('Phone numbers can be up to 40 characters long.')
      const waiter = { ...values, name, phone, status: values.status || 'active' }
      if (!editing?.id) waiter.createdBy = user.uid
      await saveRecord(membership.restaurantId, 'waiters', waiter, editing?.id)
      toast.success(editing?.id ? 'Waiter details saved.' : 'Waiter added.')
      setEditing(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }

  async function remove(waiter) {
    if (!window.confirm(`Delete waiter ${waiter.name}?`)) return
    try {
      await removeRecord(membership.restaurantId, 'waiters', waiter.id)
      toast.success('Waiter deleted.')
    } catch (problem) { toast.error(friendlyError(problem)) }
  }

  return <><PageHeading eyebrow="SERVICE TEAM" title="Waiters" description="Keep waiter names and phone numbers ready to assign to POS orders." action={<button className="button button-primary" onClick={() => setEditing({ status: 'active' })}><Plus size={16} /> Add waiter</button>} /><LimitNotices sources={[{ truncated, limit, label: 'waiters' }]} />{error && <div className="inline-alert">{error}</div>}<section className="panel records-panel">{loading ? <LoadingLines /> : records.length ? <div className="table-scroll"><table><thead><tr><th>Name</th><th>Phone</th><th>Status</th><th /></tr></thead><tbody>{records.map((waiter) => <tr key={waiter.id}><td><strong>{waiter.name}</strong></td><td><ContactLink value={waiter.phone} kind="phone" /></td><td><span className={`status-pill ${waiter.status === 'inactive' ? 'status-cancelled' : 'status-served'}`}>{waiter.status || 'active'}</span></td><td><div className="row-actions"><button className="button button-small" onClick={() => setEditing(waiter)}>Edit</button><button className="button button-small button-danger" onClick={() => remove(waiter)}>Delete</button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No waiters yet" detail="Add a waiter here to make their name available on POS orders." />}</section>{editing && <FormDialog title={editing.id ? 'Edit waiter' : 'Add waiter'} fields={fields} initial={editing} onClose={() => setEditing(null)} onSubmit={save} busy={busy} />}</>
}

function TablesPage() {
  const { membership } = useAuth()
  const navigate = useNavigate()
  const { records: tables, loading, error, truncated: tablesTruncated, limit: tablesLimit } = useRecords('tables')
  const { records: reservations, loading: reservationsLoading, truncated: reservationsTruncated, limit: reservationsLimit } = useRecords('reservations')
  const [editingTable, setEditingTable] = useState(null)
  const [creatingReservation, setCreatingReservation] = useState(false)
  const [mergeTarget, setMergeTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const canManageTables = ['owner', 'manager'].includes(membership?.role)
  const canReserve = ['owner', 'manager', 'cashier', 'waiter'].includes(membership?.role)
  const tableFields = [
    { name: 'name', label: 'Table name or number', required: true },
    { name: 'capacity', label: 'Seating capacity', type: 'number', required: true, min: 1 },
  ]
  const reservationFields = [
    { name: 'tableId', label: 'Table', type: 'select', required: true, options: tables.filter((table) => ['available', 'occupied'].includes(table.status)).map((table) => ({ value: table.id, label: `${table.name} · ${table.capacity} seats${table.status === 'occupied' ? ' · occupied, future only' : ''}` })) },
    { name: 'guestName', label: 'Guest name', required: true },
    { name: 'phone', label: 'Phone (optional)', type: 'tel' },
    { name: 'covers', label: 'Guest count', type: 'number', required: true, min: 1, max: 40 },
    { name: 'startsAt', label: 'Reservation starts', type: 'datetime-local', required: true },
    { name: 'durationMinutes', label: 'Duration in minutes', type: 'number', required: true, min: 30, max: 360, step: 15 },
  ]
  async function saveTable(values) {
    setBusy(true)
    try {
      const payload = { name: values.name.trim(), capacity: Number(values.capacity) }
      if (!editingTable.id) Object.assign(payload, { status: 'available', currentOrderId: null })
      await saveRecord(membership.restaurantId, 'tables', payload, editingTable.id)
      toast.success(editingTable.id ? 'Table updated.' : 'Table added.')
      setEditingTable(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function createBooking(values) {
    setBusy(true)
    try {
      const table = tables.find((entry) => entry.id === values.tableId)
      if (Number(values.covers) > Number(table?.capacity || 0)) throw new Error('Guest count exceeds this table’s seating capacity.')
      const startsAtMillis = new Date(values.startsAt).getTime()
      if (table?.status === 'occupied' && startsAtMillis <= Date.now()) throw new Error('Occupied tables can only be reserved for a future time.')
      await runOperation('createReservation', { reservationId: crypto.randomUUID(), tableId: values.tableId, guestName: values.guestName.trim(), phone: values.phone, covers: Number(values.covers), startsAtMillis, durationMinutes: Number(values.durationMinutes) })
      toast.success('Reservation saved.')
      setCreatingReservation(false)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function seat(reservation) {
    try {
      await runOperation('seatReservation', { reservationId: reservation.id })
      navigate('/pos', { state: { tableId: reservation.tableId } })
      toast.success('Reservation seated. The table is ready for a new POS order.')
    } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function cancel(reservation) {
    const reason = window.prompt('Why is this reservation being cancelled?')
    if (!reason?.trim()) return
    try {
      await runOperation('cancelReservation', { reservationId: reservation.id, reason: reason.trim() })
      toast.success('Reservation cancelled.')
    } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function merge(sourceTableId) {
    try {
      await runOperation('mergeTables', { targetTableId: mergeTarget.id, sourceTableId })
      toast.success('Tables combined. The target now seats the combined capacity.')
      setMergeTarget(null)
    } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function unmerge(table) {
    if (!window.confirm(`Unmerge ${table.name} and restore the original table capacities?`)) return
    try { await runOperation('unmergeTables', { targetTableId: table.id }); toast.success('Table group separated.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  return <><PageHeading eyebrow="DINING ROOM" title="Tables & reservations" description="See floor availability and manage upcoming guest bookings." action={<div className="table-page-actions">{canReserve && <button className="button button-subtle" onClick={() => setCreatingReservation(true)} disabled={!tables.some((table) => ['available', 'occupied'].includes(table.status))}><CalendarDays size={16} /> New reservation</button>}{canManageTables && <button className="button button-primary" onClick={() => setEditingTable({})}><Plus size={16} /> Add table</button>}</div>} /><LimitNotices sources={[{ truncated: tablesTruncated, limit: tablesLimit, label: 'tables' }, { truncated: reservationsTruncated, limit: reservationsLimit, label: 'reservations' }]} />
    {error && <div className="inline-alert">{error}</div>}<section className="floor-grid">{loading ? <div className="panel"><LoadingLines count={5} /></div> : tables.length ? tables.map((table) => <article className={`floor-table floor-${table.status || 'available'}`} key={table.id}><div className="floor-table-top"><span className="floor-table-icon"><Utensils size={18} /></span><span className={`status-pill status-${table.status === 'occupied' ? 'preparing' : table.status === 'merged' ? 'preparing' : 'served'}`}>{table.status || 'available'}</span></div><strong>{table.name}</strong><span>{table.capacity} seats</span>{table.mergedTableNames?.length > 0 && <small>Combined with {table.mergedTableNames.join(', ')}</small>}{table.mergedInto && <small>Part of {tables.find((candidate) => candidate.id === table.mergedInto)?.name || 'another table group'}</small>}{table.currentOrderId && <small>Order {table.currentOrderId.slice(0, 7)}</small>}{canManageTables && table.status === 'available' && table.mergedTableIds?.length > 0 && <button className="button button-small" onClick={() => unmerge(table)}>Unmerge tables</button>}{canManageTables && table.status === 'available' && !table.mergedInto && !table.mergedTableIds?.length && <button className="button button-small" onClick={() => setMergeTarget(table)}>Merge another table</button>}{canManageTables && !table.mergedInto && !table.mergedTableIds?.length && <button className="button button-small" onClick={() => setEditingTable(table)}>Edit table</button>}</article>) : <div className="panel floor-empty"><EmptyState title="No tables added" detail="Create your floor plan before opening dine-in orders." /></div>}</section>
    <section className="panel records-panel reservation-panel"><div className="section-title reservation-title"><div><h2>Upcoming reservations</h2><p>Reserved tables are assigned again only when the guest is seated.</p></div><span className="count-badge">{reservations.filter((reservation) => reservation.status === 'booked' && !reservationHasEnded(reservation)).length}</span></div>{reservationsLoading ? <LoadingLines /> : reservations.length ? <div className="table-scroll"><table><thead><tr><th>Guest</th><th>Table</th><th>Guests</th><th>Starts</th><th>Duration</th><th>Status</th>{canReserve && <th />}</tr></thead><tbody>{reservations.map((reservation) => { const shownStatus = displayedReservationStatus(reservation); const pastBooking = shownStatus === 'no-show'; return <tr key={reservation.id}><td><strong>{reservation.guestName}</strong>{reservation.phone && <small className="table-secondary"><ContactLink value={reservation.phone} kind="phone" /></small>}</td><td>{reservation.tableName}</td><td>{reservation.covers}</td><td>{formatDate(reservation.startsAt)}</td><td>{Math.round(((reservation.endsAt?.toDate ? reservation.endsAt.toDate() : new Date(reservation.endsAt)) - (reservation.startsAt?.toDate ? reservation.startsAt.toDate() : new Date(reservation.startsAt))) / 60000) || '—'} min</td><td><span className={`status-pill ${pastBooking ? 'status-cancelled' : reservation.status === 'booked' ? 'status-queued' : reservation.status === 'seated' ? 'status-served' : 'status-cancelled'}`}>{shownStatus}</span></td>{canReserve && <td><div className="row-actions">{reservation.status === 'booked' && !pastBooking && <><button className="button button-small" onClick={() => seat(reservation)}>Seat</button><button className="button button-small button-danger" onClick={() => cancel(reservation)}>Cancel</button></>}</div></td>}</tr> })}</tbody></table></div> : <EmptyState title="No reservations yet" detail="New bookings will appear here." />}</section>
    {editingTable && <FormDialog title={editingTable.id ? 'Edit table' : 'Add table'} fields={tableFields} initial={editingTable} onClose={() => setEditingTable(null)} onSubmit={saveTable} busy={busy} />}
    {creatingReservation && <FormDialog title="New reservation" fields={reservationFields} initial={{ covers: 2, durationMinutes: 90 }} onClose={() => setCreatingReservation(false)} onSubmit={createBooking} busy={busy} />}
    {mergeTarget && <TableMergeDialog target={mergeTarget} tables={tables} onClose={() => setMergeTarget(null)} onMerge={merge} />}
  </>
}

function TableMergeDialog({ target, tables, onClose, onMerge }) {
  const [sourceId, setSourceId] = useState('')
  const source = tables.find((table) => table.id === sourceId)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="merge-table-title"><div className="modal-heading"><div><p className="eyebrow">TABLE GROUP</p><h2 id="merge-table-title">Merge with {target.name}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div><label className="compact-label">Available table<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Choose another table</option>{tables.filter((table) => table.id !== target.id && table.status === 'available' && !table.mergedInto && !table.mergedTableIds?.length).map((table) => <option key={table.id} value={table.id}>{table.name} · {table.capacity} seats</option>)}</select></label>{source && <div className="balance-box"><span>Combined seating</span><strong>{Number(target.capacity) + Number(source.capacity)} seats</strong></div>}<p className="form-helper">Both tables must be free of current orders and upcoming reservations. The merge can be undone when the group is available.</p><div className="modal-actions"><button className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!sourceId} onClick={() => onMerge(sourceId)}>Merge tables</button></div></section></div>
}

function CustomerPage() {
  const { membership } = useAuth()
  const { records, loading, error, truncated, limit } = useRecords('customers')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [history, setHistory] = useState(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const visible = records.filter((customer) => `${customer.name || ''} ${customer.phone || ''} ${customer.email || ''}`.toLowerCase().includes(search.toLowerCase()))
  const fields = [{ name: 'name', label: 'Customer name', required: true }, { name: 'phone', label: 'Phone (optional)', type: 'tel' }, { name: 'email', label: 'Email (optional)', type: 'email' }]

  async function save(values) {
    setSaving(true)
    try {
      const payload = { name: values.name.trim(), phone: values.phone?.trim() || '', email: values.email?.trim().toLowerCase() || '' }
      await saveRecord(membership.restaurantId, 'customers', payload, editing.id)
      toast.success(editing.id ? 'Customer updated.' : 'Customer added.')
      setEditing(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setSaving(false) }
  }

  async function showHistory(customer) {
    setHistoryBusy(true)
    try {
      const result = await runOperation('getCustomerHistory', { customerId: customer.id })
      setHistory({ ...result, id: customer.id })
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setHistoryBusy(false) }
  }

  return <><PageHeading eyebrow="GUEST RELATIONSHIPS" title="Customers" description="See recorded visits and lifetime spend from completed payments." action={<button className="button button-primary" onClick={() => setEditing({})}><Plus size={16} /> Add customer</button>} /><LimitNotices sources={[{ truncated, limit, label: 'customers' }]} />{error && <div className="inline-alert">{error}</div>}
    <section className="panel records-panel"><div className="records-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search customers" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, phone or email" /></label><span>{visible.length} customers</span></div>{loading ? <LoadingLines /> : visible.length ? <div className="table-scroll"><table><thead><tr><th>Customer</th><th>Phone</th><th>Visits</th><th>Total spend</th><th /></tr></thead><tbody>{visible.map((customer) => <tr key={customer.id}><td><strong>{customer.name}</strong>{customer.email && <small className="table-secondary"><ContactLink value={customer.email} kind="email" /></small>}</td><td><ContactLink value={customer.phone} kind="phone" /></td><td>{customer.visitCount || 0}</td><td>{money(customer.totalSpendingCents || 0)}</td><td><div className="row-actions"><button className="button button-small" onClick={() => setEditing({ ...customer })}>Edit</button><button className="button button-small" onClick={() => showHistory(customer)} disabled={historyBusy}>{historyBusy ? 'Loading…' : 'Order history'}</button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No customers yet" detail="Customers attached to a paid order will appear here." />}</section>
    {editing && <FormDialog title={editing.id ? 'Edit customer' : 'Add customer'} fields={fields} initial={editing} onClose={() => setEditing(null)} onSubmit={save} busy={saving} />}
    {history && <CustomerHistoryDialog history={history} onClose={() => setHistory(null)} />}
  </>
}

function CustomerHistoryDialog({ history, onClose }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-panel customer-history-modal" role="dialog" aria-modal="true" aria-labelledby="customer-history-title"><div className="modal-heading"><div><p className="eyebrow">CUSTOMER ACTIVITY</p><h2 id="customer-history-title">{history.customer.name}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div><div className="customer-summary"><div><span>Visits</span><strong>{history.customer.visitCount}</strong></div><div><span>Lifetime spend</span><strong>{money(history.customer.totalSpendingCents)}</strong></div></div>{history.rows.length ? <div className="customer-order-list">{history.rows.map((order) => <article className="customer-order" key={order.orderId}><div className="customer-order-top"><strong>{order.orderNumber}</strong><span>{formatDate(order.createdAt)}</span></div><div className="customer-order-subhead"><span>{order.type} · {order.items.reduce((sum, item) => sum + item.quantity, 0)} items</span><span className="status-pill status-served">{order.paymentStatus}</span></div><div className="customer-order-items">{order.items.map((item, index) => <div key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}</span><strong>{money(item.unitPriceCents * item.quantity)}</strong></div>)}</div><div className="customer-order-total"><span>Total</span><strong>{money(order.totalCents - (order.refundedCents || 0))}</strong></div></article>)}</div> : <EmptyState title="No completed orders" detail="Order history appears after a customer order is paid." />}<div className="modal-actions"><button className="button button-subtle" onClick={onClose}>Close</button></div></section></div>
}

function RecordWorkspace({ config }) {
  const { membership, user } = useAuth()
  const canManage = ['owner', 'manager'].includes(membership?.role)
  const { records, loading, error, truncated, limit } = useRecords(config.collection)
  const [editing, setEditing] = useState(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const matching = records.filter((record) => JSON.stringify(record).toLowerCase().includes(search.toLowerCase()))
  async function save(values) {
    setBusy(true)
    try {
      const normalized = { ...values, createdBy: user.uid }
      if (config.collection === 'expenses') {
        normalized.amountCents = Math.round(Number(normalized.amount) * 100)
        delete normalized.amount
        await runOperation('recordExpense', { expenseId: crypto.randomUUID(), ...normalized })
      } else {
        if (normalized.capacity) normalized.capacity = Number(normalized.capacity)
        if (config.collection === 'tables' && !editing.id) Object.assign(normalized, { status: 'available', currentOrderId: null })
        await saveRecord(membership.restaurantId, config.collection, normalized, editing?.id)
      }
      toast.success(editing?.id ? 'Changes saved.' : 'Record added.')
      setEditing(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function remove(record) {
    if (!window.confirm(`Delete ${record.name || record.description || 'this record'}? This cannot be undone.`)) return
    try { await removeRecord(membership.restaurantId, config.collection, record.id); toast.success('Record deleted.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  const canCreate = canManage && (!config.readonly || config.collection === 'expenses')
  return <><PageHeading eyebrow={config.eyebrow} title={config.title} description={config.description} action={canCreate && <button className="button button-primary" onClick={() => setEditing({})}><Plus size={16} /> Add {config.title.slice(0, -1).toLowerCase()}</button>} /><LimitNotices sources={[{ truncated, limit, label: config.title.toLowerCase() }]} />
    {error && <div className="inline-alert">{error}</div>}<section className="panel records-panel"><div className="records-toolbar"><label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${config.title.toLowerCase()}`} /></label><span>{matching.length} records</span></div>{loading ? <LoadingLines /> : matching.length ? <div className="table-scroll"><table><thead><tr><th>Name</th><th>{config.collection === 'tables' ? 'Seats' : config.collection === 'expenses' ? 'Category' : 'Contact'}</th><th>{config.collection === 'expenses' ? 'Date' : 'Details'}</th><th>{config.collection === 'expenses' ? 'Amount' : 'Status'}</th>{canManage && <th />}</tr></thead><tbody>{matching.map((record) => <tr key={record.id}><td><strong>{record.name || record.description || 'Expense'}</strong></td><td>{record.capacity ? `${record.capacity} seats` : record.category || (record.contact ? <>{record.contact}{record.phone && <small className="table-secondary"><ContactLink value={record.phone} kind="phone" /></small>}</> : <ContactLink value={record.phone} kind="phone" />)}</td><td>{config.collection === 'expenses' ? record.date : record.email ? <ContactLink value={record.email} kind="email" /> : record.unit || '—'}</td><td>{config.collection === 'expenses' ? money(record.amountCents) : record.status || (record.active === false ? 'Disabled' : 'Active')}</td>{canManage && <td><div className="row-actions">{!config.readonly && <button className="button button-small" onClick={() => setEditing(record)}>Edit</button>}{!config.readonly && <button className="icon-button" title="Delete" aria-label="Delete" onClick={() => remove(record)}><Trash2 size={15} /></button>}</div></td>}</tr>)}</tbody></table></div> : <EmptyState title={`No ${config.title.toLowerCase()} yet`} detail="Add your first record to get started." />}</section>
    {editing && <FormDialog title={editing.id ? `Edit ${config.title.slice(0, -1).toLowerCase()}` : `Add ${config.title.slice(0, -1).toLowerCase()}`} fields={config.fields} initial={editing} onClose={() => setEditing(null)} onSubmit={save} busy={busy} />}
  </>
}

function parseMenuOptions(value, priceField, previous) {
  const lines = String(value || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > 20) throw new Error('A menu item can have up to 20 choices in each option group.')
  const seenNames = new Set()
  return lines.map((line) => {
    const separator = line.lastIndexOf('|')
    if (separator < 1) throw new Error('Enter each option as Name | price.')
    const name = line.slice(0, separator).trim()
    const price = Number(line.slice(separator + 1).trim())
    const normalized = name.toLowerCase()
    if (!name || name.length > 100 || seenNames.has(normalized) || !Number.isFinite(price)) {
      throw new Error('Option names must be unique and each option needs a valid price.')
    }
    if (priceField === 'priceCents' && price < 0) throw new Error('Add-on prices cannot be negative.')
    const cents = Math.round(price * 100)
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > 100000000) throw new Error('Option price is outside the allowed range.')
    seenNames.add(normalized)
    const previousOption = previous.find((option) => option.name.toLowerCase() === normalized)
    return { id: previousOption?.id || crypto.randomUUID(), name, [priceField]: cents }
  })
}

function formatMenuOptions(options = [], priceField) {
  return options.map((option) => `${option.name} | ${(option[priceField] / 100).toFixed(2)}`).join('\n')
}

function parseRecipeText(value, inventory) {
  const lines = String(value || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > 30) throw new Error('A recipe can contain up to 30 stock items.')
  const seen = new Set()
  return lines.map((line) => {
    const separator = line.lastIndexOf('|')
    if (separator < 1) throw new Error('Enter each recipe item as Stock item name | quantity.')
    const name = line.slice(0, separator).trim().toLowerCase()
    const quantity = Number(line.slice(separator + 1).trim())
    const matching = inventory.filter((item) => item.name.trim().toLowerCase() === name)
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000 || matching.length !== 1 || seen.has(matching[0]?.id)) {
      throw new Error('Each recipe line must match one unique stock item and a positive quantity.')
    }
    seen.add(matching[0].id)
    return { ingredientId: matching[0].id, quantity }
  })
}

function formatRecipeText(recipe = [], inventory) {
  return recipe.map((line) => {
    const item = inventory.find((entry) => entry.id === line.ingredientId)
    return item ? `${item.name} | ${line.quantity}` : ''
  }).filter(Boolean).join('\n')
}

function MenuManagement() {
  const { membership } = useAuth()
  const { records: items, loading, error, truncated: itemsTruncated, limit: itemsLimit } = useRecords('menuItems')
  const { records: categories, truncated: categoriesTruncated, limit: categoriesLimit } = useRecords('categories')
  const { records: inventory, truncated: inventoryTruncated, limit: inventoryLimit } = useRecords('inventory')
  const [editItem, setEditItem] = useState(null)
  const [categoryName, setCategoryName] = useState('')
  const [busy, setBusy] = useState(false)
  async function saveItem(values) {
    setBusy(true)
    try {
      const itemType = values.itemType || 'non-weight-wise'
      const weightOptions = itemType === 'weight-wise' ? values.weightOptions.map((option) => {
        const weightValue = Number(option.weightValue)
        const priceCents = Math.round(Number(option.price) * 100)
        if (!Number.isFinite(weightValue) || weightValue <= 0 || !['g', 'kg'].includes(option.weightUnit) || !Number.isSafeInteger(priceCents) || priceCents < 1) {
          throw new Error('Each weight needs a positive weight and a valid positive price.')
        }
        return { id: option.id || crypto.randomUUID(), weightValue, weightUnit: option.weightUnit, priceCents }
      }) : []
      if (itemType === 'weight-wise' && weightOptions.length === 0) throw new Error('Add at least one weight option before saving this item.')
      if (!['weight-wise', 'non-weight-wise'].includes(itemType)) throw new Error('Choose a valid item type.')
      const normalizedWeights = new Set()
      for (const option of weightOptions) {
        const milliGrams = Math.round(option.weightValue * (option.weightUnit === 'kg' ? 1000000 : 1000))
        if (!Number.isSafeInteger(milliGrams) || Math.abs(option.weightValue * (option.weightUnit === 'kg' ? 1000000 : 1000) - milliGrams) > 0.000001 || normalizedWeights.has(milliGrams)) {
          throw new Error('Weight options must be unique, including equivalent g and kg values.')
        }
        normalizedWeights.add(milliGrams)
      }
      const priceCents = itemType === 'weight-wise' ? Math.min(...weightOptions.map((option) => option.priceCents)) : Math.round(Number(values.price) * 100)
      if (!Number.isSafeInteger(priceCents) || priceCents < 1) throw new Error('Enter a valid positive price.')
      const rawImageUrl = values.imageUrl?.trim() || ''
      const imageUrl = normalizeMenuImageUrl(rawImageUrl)
      if (rawImageUrl && !imageUrl) throw new Error('Enter a valid HTTPS image URL.')
      const payload = {
        name: values.name,
        description: values.description,
        categoryId: values.categoryId,
        categoryName: categories.find((category) => category.id === values.categoryId)?.name || '',
        priceCents,
        itemType,
        weightOptions,
        available: String(values.available) !== 'false',
        imageUrl,
        variants: itemType === 'weight-wise' ? [] : parseMenuOptions(values.variantsText, 'priceDeltaCents', editItem.variants || []),
        addOns: parseMenuOptions(values.addOnsText, 'priceCents', editItem.addOns || []),
        recipe: parseRecipeText(values.recipeText, inventory),
      }
      await saveRecord(membership.restaurantId, 'menuItems', payload, editItem?.id)
      toast.success('Menu item saved.')
      setEditItem(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function addCategory(event) {
    event.preventDefault()
    const name = categoryName.trim()
    if (!name) return
    try { await saveRecord(membership.restaurantId, 'categories', { name }, null); setCategoryName(''); toast.success('Category added.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function toggle(item) {
    try { await saveRecord(membership.restaurantId, 'menuItems', { available: item.available === false }, item.id); toast.success('Availability updated.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  const fields = [{ name: 'name', label: 'Item name', required: true }, { name: 'itemType', label: 'Item type', type: 'select', options: [{ value: 'non-weight-wise', label: 'Non-Weight-Wise — per piece or serving' }, { value: 'weight-wise', label: 'Weight-Wise — choose a weight in POS' }] }, { name: 'price', label: 'Base price', type: 'number', required: true, min: 0.01, step: '0.01', showWhen: (values) => values.itemType !== 'weight-wise' }, { name: 'weightOptions', label: 'Weight options and prices', type: 'weightOptions', showWhen: (values) => values.itemType === 'weight-wise' }, { name: 'categoryId', label: 'Category', type: 'select', options: categories.map(({ id, name }) => ({ value: id, label: name })), required: true }, { name: 'description', label: 'Description' }, { name: 'variantsText', label: 'Variants (one per line: Name | price change)', type: 'textarea', placeholder: 'Large | 2.00\nSmall | -1.00', showWhen: (values) => values.itemType !== 'weight-wise' }, { name: 'addOnsText', label: 'Add-ons (one per line: Name | price)', type: 'textarea', placeholder: 'Extra cheese | 1.25\nAvocado | 2.00' }, { name: 'recipeText', label: 'Recipe (one per line: stock item name | quantity per serving)', type: 'textarea', placeholder: 'Tomatoes | 0.2\nOlive oil | 0.01' }, { name: 'available', label: 'Available to order', type: 'select', options: [{ value: 'true', label: 'Available' }, { value: 'false', label: 'Unavailable' }] }, { name: 'imageUrl', label: 'Public image URL (optional)', type: 'url', placeholder: 'https://example.com/menu-image.jpg' }]
  return <><PageHeading eyebrow="MENU & CATALOG" title="Menu" description="Keep prices, availability and guest-facing details current." action={<button className="button button-primary" onClick={() => setEditItem({ available: true, itemType: 'non-weight-wise', weightOptions: [] })}><Plus size={16} /> Add menu item</button>} /><LimitNotices sources={[{ truncated: itemsTruncated, limit: itemsLimit, label: 'menu items' }, { truncated: categoriesTruncated, limit: categoriesLimit, label: 'categories' }, { truncated: inventoryTruncated, limit: inventoryLimit, label: 'inventory records' }]} />{error && <div className="inline-alert">{error}</div>}
    <section className="panel category-strip"><div><p className="eyebrow">CATEGORIES</p><div className="category-chip-list">{categories.map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}{categories.length === 0 && <span className="muted-copy">Add categories before creating menu items.</span>}</div></div><form onSubmit={addCategory} className="add-category-form"><input aria-label="New category name" placeholder="Category name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} /><button className="button button-subtle" type="submit" disabled={!categoryName.trim()}><Plus size={15} /> Add</button></form></section>
    <section className="panel records-panel">{loading ? <LoadingLines /> : items.length ? <div className="table-scroll"><table><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Options</th><th>Recipe</th><th>Availability</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><div className="menu-table-name"><MenuImage url={item.imageUrl} name={item.name} /><div><strong>{item.name}</strong><small>{item.description || '—'}</small></div></div></td><td>{categories.find((category) => category.id === item.categoryId)?.name || 'Uncategorized'}</td><td>{money(item.priceCents)}</td><td>{(item.variants?.length || 0) + (item.addOns?.length || 0) || '—'}</td><td>{item.recipe?.length || '—'}</td><td><button className={`availability-button ${item.available === false ? 'unavailable' : ''}`} onClick={() => toggle(item)}>{item.available === false ? 'Unavailable' : 'Available'}</button></td><td><button className="button button-small" onClick={() => setEditItem({ ...item, price: (item.priceCents / 100).toFixed(2), available: String(item.available !== false), variantsText: formatMenuOptions(item.variants, 'priceDeltaCents'), addOnsText: formatMenuOptions(item.addOns, 'priceCents'), recipeText: formatRecipeText(item.recipe, inventory) })}>Edit</button></td></tr>)}</tbody></table></div> : <EmptyState title="Your menu starts here" detail="Create categories, then add items with verified prices." />}</section>
    {editItem && <FormDialog title={editItem.id ? 'Edit menu item' : 'Add menu item'} fields={fields} initial={editItem} onClose={() => setEditItem(null)} onSubmit={saveItem} busy={busy} />}
  </>
}

function InventoryPage() {
  return <><InventoryItemsPage /><InventoryMovementHistory /></>
}

function InventoryMovementHistory() {
  const { records, loading, error, truncated, limit } = useRecords('stockMovements', 100)
  return <section className="panel records-panel movement-history"><div className="section-title movement-title"><div><h2>Stock movement history</h2><p>Latest 100 receipts, adjustments, waste, purchase receipts and recipe deductions</p></div></div><LimitNotices sources={[{ truncated, limit, label: 'stock movements' }]} />{error && <div className="inline-alert">{error}</div>}{loading ? <LoadingLines count={3} /> : records.length ? <div className="table-scroll"><table><thead><tr><th>Item</th><th>Movement</th><th>Quantity</th><th>Reason</th><th>Recorded</th></tr></thead><tbody>{records.map((movement) => <tr key={movement.id}><td><strong>{movement.itemName || 'Stock item'}</strong></td><td>{movement.movementType?.replaceAll('_', ' ')}</td><td>{movement.quantity} {movement.unit || ''}</td><td>{movement.reason || movement.purchaseId || movement.orderId || '—'}</td><td>{formatDate(movement.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No stock movements yet" detail="Stock receipts, recipe consumption and adjustments will be recorded here." />}</section>
}

function InventoryItemsPage() {
  const { membership } = useAuth()
  const { records, loading, error, truncated, limit } = useRecords('inventory')
  const [editing, setEditing] = useState(null)
  const [adjusting, setAdjusting] = useState(null)
  const [busy, setBusy] = useState(false)
  const fields = [{ name: 'name', label: 'Ingredient or stock item', required: true }, { name: 'unit', label: 'Unit (kg, L, each)', required: true }, { name: 'reorderLevel', label: 'Low-stock threshold', type: 'number', min: 0, required: true }]
  async function save(values) {
    setBusy(true)
    try {
      const payload = { ...values, reorderLevel: Number(values.reorderLevel) }
      if (!editing.id) payload.quantityOnHand = 0
      await saveRecord(membership.restaurantId, 'inventory', payload, editing.id)
      toast.success('Inventory item saved.')
      setEditing(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function adjust(values) {
    setBusy(true)
    try {
      await runOperation('adjustInventory', { ingredientId: adjusting.id, movementId: crypto.randomUUID(), movementType: values.movementType, quantity: Number(values.quantity), reason: values.reason })
      toast.success('Stock movement recorded.')
      setAdjusting(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  return <><PageHeading eyebrow="STOCK CONTROL" title="Inventory" description="Record every receipt, adjustment and waste movement." action={<button className="button button-primary" onClick={() => setEditing({})}><Plus size={16} /> Add stock item</button>} /><LimitNotices sources={[{ truncated, limit, label: 'inventory records' }]} />{error && <div className="inline-alert">{error}</div>}<section className="panel records-panel">{loading ? <LoadingLines /> : records.length ? <div className="table-scroll"><table><thead><tr><th>Ingredient</th><th>On hand</th><th>Reorder at</th><th>Stock status</th><th /></tr></thead><tbody>{records.map((item) => { const low = Number(item.quantityOnHand || 0) <= Number(item.reorderLevel || 0); return <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.quantityOnHand || 0} {item.unit}</td><td>{item.reorderLevel} {item.unit}</td><td><span className={`status-pill ${low ? 'status-cancelled' : 'status-served'}`}>{low ? 'Reorder' : 'In stock'}</span></td><td><div className="row-actions"><button className="button button-small" onClick={() => setAdjusting(item)}>Record movement</button><button className="icon-button" title="Edit item" aria-label="Edit item" onClick={() => setEditing(item)}><Settings size={15} /></button></div></td></tr> })}</tbody></table></div> : <EmptyState title="No stock items yet" detail="Add an ingredient, then record opening stock as a movement." />}</section>{editing && <FormDialog title={editing.id ? 'Edit stock item' : 'Add stock item'} fields={fields} initial={editing} onClose={() => setEditing(null)} onSubmit={save} busy={busy} />}{adjusting && <FormDialog title={`Stock movement · ${adjusting.name}`} fields={[{ name: 'movementType', label: 'Movement', type: 'select', options: [{ value: 'receive', label: 'Receive stock' }, { value: 'waste', label: 'Record wastage' }, { value: 'adjust', label: 'Adjustment (permission required)' }] }, { name: 'quantity', label: `Quantity (${adjusting.unit})`, type: 'number', min: 0.001, step: 'any', required: true }, { name: 'reason', label: 'Reason', required: true }]} initial={{ movementType: 'receive' }} onClose={() => setAdjusting(null)} onSubmit={adjust} busy={busy} />}</>
}

function PurchasesPage() {
  const { records, loading, error, truncated, limit } = useRecords('purchases')
  const { records: suppliers } = useRecords('suppliers')
  const { records: inventory } = useRecords('inventory')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const fields = [{ name: 'supplierId', label: 'Supplier', type: 'select', options: suppliers.map(({ id, name }) => ({ value: id, label: name })), required: true }, { name: 'ingredientId', label: 'Stock item', type: 'select', options: inventory.map(({ id, name }) => ({ value: id, label: name })), required: true }, { name: 'quantity', label: 'Quantity', type: 'number', min: 0.001, step: 'any', required: true }, { name: 'unitCost', label: 'Unit cost', type: 'number', min: 0, step: '0.01', required: true }, { name: 'reference', label: 'Supplier reference (optional)' }]
  async function create(values) {
    setBusy(true)
    try {
      await runOperation('createPurchase', { purchaseId: crypto.randomUUID(), supplierId: values.supplierId, items: [{ ingredientId: values.ingredientId, quantity: Number(values.quantity), unitCostCents: Math.round(Number(values.unitCost) * 100) }], reference: values.reference })
      toast.success('Purchase order saved. Stock is not changed until it is received.')
      setCreating(false)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function receive(purchase) {
    if (!window.confirm(`Receive purchase ${purchase.reference || purchase.id.slice(0, 7)} and add its items to stock?`)) return
    try { await runOperation('receivePurchase', { purchaseId: purchase.id, movementId: crypto.randomUUID() }); toast.success('Purchase received and stock updated.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  return <><PageHeading eyebrow="SUPPLY CHAIN" title="Suppliers & purchases" description="Track what was ordered separately from stock physically received." action={<button className="button button-primary" onClick={() => setCreating(true)}><Plus size={16} /> New purchase</button>} /><LimitNotices sources={[{ truncated, limit, label: 'purchases' }]} />{error && <div className="inline-alert">{error}</div>}<section className="panel records-panel">{loading ? <LoadingLines /> : records.length ? <div className="table-scroll"><table><thead><tr><th>Supplier</th><th>Reference</th><th>Ordered</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>{records.map((purchase) => <tr key={purchase.id}><td><strong>{purchase.supplierName}</strong><small className="table-secondary">{purchase.items?.map((item) => `${item.quantity} ${inventory.find((stock) => stock.id === item.ingredientId)?.unit || ''} ${item.itemName}`).join(', ')}</small></td><td>{purchase.reference || '—'}</td><td>{formatDate(purchase.createdAt)}</td><td>{money(purchase.totalCents)}</td><td><span className={`status-pill ${purchase.status === 'received' ? 'status-served' : 'status-queued'}`}>{purchase.status}</span></td><td>{purchase.status !== 'received' && <button className="button button-small" onClick={() => receive(purchase)}>Receive stock</button>}</td></tr>)}</tbody></table></div> : <EmptyState title="No purchases yet" detail="Create a purchase order, then receive it when stock arrives." />}</section>{creating && <FormDialog title="New purchase" fields={fields} initial={{}} onClose={() => setCreating(false)} onSubmit={create} busy={busy} />}</>
}

function StaffPage() {
  const { membership } = useAuth()
  const { records: allStaff, loading, error, truncated: staffTruncated, limit: staffLimit } = useRecords('users')
  const records = allStaff.filter((staff) => !staff.removedAt)
  const [pendingInvitations, setPendingInvitations] = useState([])
  const [invitationsTruncated, setInvitationsTruncated] = useState(false)
  useEffect(() => {
    if (membership?.demo || !membership?.restaurantId) return undefined
    return watchRecords(membership.restaurantId, 'staffInvitations', (invitations) => {
      setInvitationsTruncated(invitations.length === 100)
      const currentTime = Date.now()
      setPendingInvitations(invitations.filter((invitation) => invitation.active && invitation.status === 'open' && invitation.expiresAt?.toMillis?.() > currentTime))
    }, () => setPendingInvitations([]), 100)
  }, [membership?.demo, membership?.restaurantId])
  const [inviting, setInviting] = useState(false)
  const [viewingInvitations, setViewingInvitations] = useState(false)
  const [inviteLink, setInviteLink] = useState(null)
  const [copyState, setCopyState] = useState('')
  const inviteLinkInput = useRef(null)
  const [permissionTarget, setPermissionTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const fields = [{ name: 'email', label: 'Team member email', type: 'email', required: true }, { name: 'displayName', label: 'Name', required: true }, { name: 'role', label: 'Role', type: 'select', options: ['manager', 'cashier', 'waiter'], required: true }]
  async function invite(values) {
    setBusy(true)
    try {
      const result = await runOperation('inviteStaff', values)
      if (membership?.demo) toast.success('Sample invitation saved. No real account or email was created.')
      else {
        setInviteLink({ ...result, ...values, inviteUrl: `${window.location.origin}/join/${membership.restaurantId}/${result.id}` })
        setCopyState('')
        toast.success('Invitation created. The share link is shown here.')
      }
      setInviting(false)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  async function copyInviteLink() {
    if (!inviteLink?.inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteLink.inviteUrl)
      setCopyState('Link copied. You can paste it into a message to the team member.')
    } catch {
      const input = inviteLinkInput.current
      input?.focus()
      input?.select()
      const copied = document.execCommand?.('copy')
      setCopyState(copied ? 'Link copied. You can paste it into a message to the team member.' : 'Link is selected. Copy it with Ctrl+C (or long-press on mobile).')
    }
  }
  async function sendSetupEmail() {
    toast.info('Password resets are handled by the RestaurantOS administrator.')
  }
  async function deleteMember(staff) {
    if (!window.confirm(`Delete ${staff.displayName || staff.email} from this restaurant? This cannot be undone.`)) return
    try { await runOperation('deleteStaffMember', { userId: staff.id }); toast.success('Staff member removed.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function disable(staff) {
    if (!window.confirm(`Disable ${staff.displayName || staff.email}'s access?`)) return
    try { await runOperation('setStaffActive', { userId: staff.id, active: false }); toast.success('Staff access disabled.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function enable(staff) {
    try { await runOperation('setStaffActive', { userId: staff.id, active: true }); toast.success('Staff access enabled.') } catch (problem) { toast.error(friendlyError(problem)) }
  }
  async function savePermissions(permissions) {
    setBusy(true)
    try {
      await runOperation('setStaffPermissions', { userId: permissionTarget.id, permissions })
      toast.success('Staff permissions updated and audited.')
      setPermissionTarget(null)
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  return <><PageHeading eyebrow="TEAM ACCESS" title="Staff" description="Invite team members to join with an account password." action={<div className="staff-heading-actions">{!membership?.demo && pendingInvitations.length > 0 && <button className="button button-subtle" onClick={() => setViewingInvitations(true)}>Pending links ({pendingInvitations.length})</button>}<button className="button button-primary" onClick={() => setInviting(true)}><Plus size={16} /> Add team member</button></div>} /><LimitNotices sources={[{ truncated: staffTruncated, limit: staffLimit, label: 'staff members' }, { truncated: invitationsTruncated, limit: 100, label: 'staff invitations' }]} />{error && <div className="inline-alert">{error}</div>}<div className="security-note"><Users size={18} /><span>Only the owner can invite staff. Sample invitations do not create live accounts.</span></div><section className="panel records-panel">{loading ? <LoadingLines /> : records.length ? <div className="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Extra permissions</th><th>Status</th><th /></tr></thead><tbody>{records.map((staff, index) => <tr key={staff.id}><td><strong>{staff.displayName || 'Team member'}</strong></td><td><ContactLink value={staff.email} kind="email" /></td><td><span className="role-tag">{staff.role}</span></td><td>{staff.permissions?.length ? staff.permissions.join(', ') : 'None'}</td><td>{staff.active === false ? 'Disabled' : 'Active'}</td><td><div className="row-actions">{staff.active === false && staff.role !== 'owner' && <button className="button button-small" onClick={() => enable(staff)}>Enable access</button>}{staff.active !== false && staff.role !== 'owner' && <button className="button button-small" onClick={() => sendSetupEmail(staff.email)}>Password help</button>}{['cashier', 'waiter'].includes(staff.role) && staff.active !== false && <button className="button button-small" onClick={() => setPermissionTarget(staff)}>Permissions</button>}{staff.role !== 'owner' && <button className="button button-small button-danger" onClick={() => deleteMember(staff)}>{index === 0 ? 'Delete' : 'Remove'}</button>}{staff.active !== false && staff.role !== 'owner' && <button className="button button-small button-danger" onClick={() => disable(staff)}>Disable</button>}</div></td></tr>)}</tbody></table></div> : <EmptyState title="No team members yet" detail="Create an invitation and share its link with your team member." />}</section>{viewingInvitations && <PendingInvitationsDialog invitations={pendingInvitations} onShow={(invitation) => { setInviteLink({ ...invitation, inviteUrl: `${window.location.origin}/join/${membership.restaurantId}/${invitation.id}` }); setViewingInvitations(false) }} onClose={() => setViewingInvitations(false)} />}{inviting && <FormDialog title="Add a team member" fields={fields} initial={{ role: 'cashier' }} onClose={() => setInviting(false)} onSubmit={invite} busy={busy} />}{inviteLink && <InviteLinkDialog invite={inviteLink} inputRef={inviteLinkInput} copyState={copyState} onCopy={copyInviteLink} onClose={() => setInviteLink(null)} />}{permissionTarget && <StaffPermissionsDialog staff={permissionTarget} busy={busy} onClose={() => setPermissionTarget(null)} onSave={savePermissions} />}</>
}

function PendingInvitationsDialog({ invitations, onShow, onClose }) {
  return <div className="modal-backdrop" role="presentation"><section className="modal-panel pending-invitations-dialog" role="dialog" aria-modal="true" aria-labelledby="pending-invitations-title"><div className="modal-heading"><div><p className="eyebrow">TEAM ACCESS</p><h2 id="pending-invitations-title">Pending invitations</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div><div className="invitation-list">{invitations.map((invitation) => <article className="invitation-list-item" key={invitation.id}><div><strong>{invitation.displayName}</strong><span><ContactLink value={invitation.email} kind="email" /> · {invitation.role}</span><small>Expires {formatDate(invitation.expiresAt)}</small></div><button className="button button-small" onClick={() => onShow(invitation)}>Show link</button></article>)}</div><div className="modal-actions"><button className="button button-subtle" onClick={onClose}>Done</button></div></section></div>
}

function InviteLinkDialog({ invite, inputRef, copyState, onCopy, onClose }) {
  const emailSubject = encodeURIComponent('Join our restaurant team on RestaurantOS')
  const emailBody = encodeURIComponent(`Hi ${invite.displayName},\n\nPlease open this invitation link to join our restaurant team on RestaurantOS:\n${invite.inviteUrl}\n\nThis link expires in 7 days.`)
  return <div className="modal-backdrop" role="presentation"><section className="modal-panel invite-link-dialog" role="dialog" aria-modal="true" aria-labelledby="invite-link-title"><div className="modal-heading"><div><p className="eyebrow">TEAM INVITATION</p><h2 id="invite-link-title">Share with {invite.displayName}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div><p className="invite-link-copy">Send this link to <strong><ContactLink value={invite.email} kind="email" /></strong>. They can open it, create their password and join as a {invite.role}. This link expires in 7 days.</p><label className="invite-link-label" htmlFor="staff-invite-url">Invitation link</label><div className="invite-link-row"><input ref={inputRef} id="staff-invite-url" type="text" value={invite.inviteUrl} readOnly onFocus={(event) => event.currentTarget.select()} /><button className="button button-primary" onClick={onCopy}>Copy link</button></div>{copyState && <p className="invite-copy-status" role="status">{copyState}</p>}<div className="modal-actions invite-link-actions"><a className="button button-subtle" href={`mailto:${encodeURIComponent(invite.email)}?subject=${emailSubject}&body=${emailBody}`}>Open email draft</a><button className="button button-subtle" onClick={onClose}>Done</button></div><p className="invite-link-note">RestaurantOS does not send invitation emails automatically. Share this link yourself.</p></section></div>
}

function StaffPermissionsDialog({ staff, busy, onClose, onSave }) {
  const options = staff.role === 'cashier'
    ? [{ id: 'discounts', label: 'Apply discounts' }, { id: 'refunds', label: 'Record refunds' }, { id: 'voidOrders', label: 'Cancel or void orders' }]
    : [{ id: 'discounts', label: 'Apply discounts' }, { id: 'voidOrders', label: 'Cancel or void orders' }]
  const [selected, setSelected] = useState((staff.permissions || []).filter((permission) => options.some((option) => option.id === permission)))
  function toggle(permission) {
    setSelected((current) => current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission])
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal-panel permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title"><div className="modal-heading permission-header"><div><p className="eyebrow">{staff.role.toUpperCase()} ACCESS</p><h2 id="permission-title">{staff.displayName || staff.email}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></div><fieldset className="permission-list"><legend>Additional permissions</legend>{options.map((option) => <label className="permission-option" key={option.id}><input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} /><span>{option.label}</span></label>)}</fieldset><div className="modal-actions permission-actions"><button className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" onClick={() => onSave(selected)} disabled={busy}>{busy ? 'Saving…' : 'Save permissions'}</button></div></section></div>
}

function SettingsPage() {
  const { membership } = useAuth()
  const [settings, setSettings] = useState({ name: '', currency, taxRate: '0', paymentMethods: 'cash, card, digital' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!membership?.restaurantId) return undefined
    return watchRecords(membership.restaurantId, 'settings', (records) => {
      const config = records.find((record) => record.id === 'profile') || records[0]
      if (config) setSettings({ name: config.name || '', currency: config.currency || currency, taxRate: String((config.taxRate || 0) * 100), paymentMethods: (config.paymentMethods || ['cash', 'card', 'digital']).join(', ') })
    }, () => {})
  }, [membership?.restaurantId])
  async function save(event) {
    event.preventDefault()
    const taxRate = Number(settings.taxRate) / 100
    if (taxRate < 0 || taxRate > 1) return toast.error('Tax rate must be between 0 and 100%.')
    setBusy(true)
    try {
      await saveRecord(membership.restaurantId, 'settings', {
        name: settings.name.trim(),
        currency: 'PKR',
        taxRate,
        paymentMethods: settings.paymentMethods.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
      }, 'profile')
      toast.success('Restaurant settings saved.')
    } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  return <><PageHeading eyebrow="RESTAURANT PROFILE" title="Settings" description="Basic operating and receipt settings for this restaurant." /><section className="panel settings-panel"><form className="settings-form" onSubmit={save}><label>Restaurant name<input required value={settings.name} onChange={(event) => setSettings({ ...settings, name: event.target.value })} placeholder="Your restaurant" /></label><label>Currency<input value="PKR · Pakistani rupee" readOnly /></label><label>Sales tax rate (%)<input type="number" min="0" max="100" step="0.01" value={settings.taxRate} onChange={(event) => setSettings({ ...settings, taxRate: event.target.value })} /></label><label>Enabled payment methods<input value={settings.paymentMethods} onChange={(event) => setSettings({ ...settings, paymentMethods: event.target.value })} /><small>Comma-separated labels. Card entry here records payment only.</small></label><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></form></section></>
}

function AuditPage() {
  const { records, loading, error, truncated, limit } = useRecords('auditLogs', 100)
  const [search, setSearch] = useState('')
  const visible = records.filter((record) => JSON.stringify(record).toLowerCase().includes(search.toLowerCase()))
  return <><PageHeading eyebrow="SECURITY & GOVERNANCE" title="Audit log" description="Latest 100 recorded changes to orders, inventory, payments and staff access." /><LimitNotices sources={[{ truncated, limit, label: 'audit events' }]} />{error && <div className="inline-alert">{error}</div>}<section className="panel records-panel"><div className="records-toolbar"><label className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search actions or record IDs" /></label><span>{visible.length} events</span></div>{loading ? <LoadingLines /> : visible.length ? <div className="table-scroll"><table><thead><tr><th>Action</th><th>Record</th><th>Actor</th><th>Details</th><th>Time</th></tr></thead><tbody>{visible.map((entry) => <tr key={entry.id}><td><strong>{entry.action}</strong></td><td>{entry.entityId || '—'}</td><td>{entry.actorId || '—'}</td><td>{entry.reason || entry.permissions?.join(', ') || (entry.amountCents ? money(entry.amountCents) : entry.quantity !== undefined ? entry.quantity : '—')}</td><td>{formatDate(entry.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState title="No audit events yet" detail="Recorded operational changes will appear here." />}</section></>
}

function ReportsPage() {
  const [range, setRange] = useState('week')
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true)
    try { setData(await exportReport({ range })) } catch (problem) { toast.error(friendlyError(problem)) } finally { setBusy(false) }
  }
  function downloadCsv() {
    if (!data) return toast.error('Run a report before exporting.')
    const rows = [
      ...data.rows.map((row) => ({ section: 'daily', ...row })),
      ...data.itemRows.map((row) => ({ section: 'item', ...row })),
      ...data.categoryRows.map((row) => ({ section: 'category', ...row })),
      ...data.paymentRows.map((row) => ({ section: 'payment method', ...row })),
      ...data.expenseRows.map((row) => ({ section: 'expense category', ...row })),
    ]
    if (!rows.length) return toast.error('No report rows to export.')
    const headings = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    const csv = [headings.join(','), ...rows.map((row) => headings.map((heading) => `"${String(row[heading] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `restaurantos-${range}-report.csv`
    link.click()
    URL.revokeObjectURL(url)
  }
  return <><PageHeading eyebrow="BUSINESS REVIEW" title="Reports" description="Financial totals come from recorded orders and expenses." action={<div className="report-actions"><select aria-label="Report date range" value={range} onChange={(event) => setRange(event.target.value)}><option value="day">Today</option><option value="week">Last 7 days</option><option value="month">This month</option></select><button className="button button-subtle" onClick={downloadCsv} disabled={!data}>Export CSV</button><button className="button button-primary" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Run report'}</button></div>} />
    <div className="report-note">Gross sales are before discounts, tax and refunds. Refunds, discounts, tax and expenses are shown separately. Item totals are before order-level discounts. Profit is not calculated because ingredient and labor costs may be incomplete.</div>{data?.truncated && <div className="inline-alert" role="alert">This report reached a result limit. Some records are omitted; narrow the date range to include fewer records.</div>}{data ? <><div className="stats-grid report-stat-grid"><StatTile label="Gross sales" value={money(data.summary.grossSalesCents)} note="Before refunds" icon={Banknote} /><StatTile label="Refunds" value={money(data.summary.refundsCents)} note="Recorded reversals" icon={ArrowDownLeft} /><StatTile label="Discounts" value={money(data.summary.discountsCents)} note="Authorized adjustments" icon={ArrowDownLeft} /><StatTile label="Expenses" value={money(data.summary.expenseCents)} note="Approved, recorded" icon={Banknote} /></div><div className="report-breakdowns"><BreakdownTable title="Daily totals" rows={data.rows} /><BreakdownTable title="Sales by item" rows={data.itemRows} /><BreakdownTable title="Sales by category" rows={data.categoryRows} /><BreakdownTable title="Payments by method" rows={data.paymentRows} /><BreakdownTable title="Expenses by category" rows={data.expenseRows} /></div></> : <section className="panel report-empty"><div className="empty-icon"><Banknote size={20} /></div><h2>Your numbers, clearly accounted for.</h2><p>Run a report to summarize recorded sales, discounts, refunds and expenses.</p><button className="button button-primary" onClick={load} disabled={busy}>{busy ? 'Loading…' : 'Run report'}</button></section>}</>
}

function BreakdownTable({ title, rows }) {
  if (!rows.length) return null
  const columns = Object.keys(rows[0])
  return <section className="panel records-panel"><div className="section-title breakdown-heading"><div><h2>{title}</h2></div></div><div className="table-scroll"><table><thead><tr>{columns.map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={`${title}-${index}`}>{columns.map((key) => <td key={key}>{key.toLowerCase().includes('cents') ? money(row[key]) : row[key]}</td>)}</tr>)}</tbody></table></div></section>
}

function WeightOptionsEditor({ value = [], onChange }) {
  function update(index, key, nextValue) {
    onChange(value.map((option, optionIndex) => optionIndex === index ? { ...option, [key]: nextValue } : option))
  }
  function addWeight() {
    onChange([...value, { id: crypto.randomUUID(), weightValue: '', weightUnit: 'g', price: '' }])
  }
  return <div className="weight-options-editor">
    <p>Set a separate price for every weight. Grams and kilograms are checked for equivalent duplicates.</p>
    {value.map((option, index) => <div className="weight-option-row" key={option.id || index}>
      <label><span>Weight</span><input aria-label={`Weight ${index + 1}`} type="number" min="0.001" step="any" value={option.weightValue} onChange={(event) => update(index, 'weightValue', event.target.value)} placeholder="500" /></label>
      <label><span>Unit</span><select aria-label={`Weight unit ${index + 1}`} value={option.weightUnit || 'g'} onChange={(event) => update(index, 'weightUnit', event.target.value)}><option value="g">g</option><option value="kg">kg</option></select></label>
      <label><span>Price</span><input aria-label={`Price for weight ${index + 1}`} type="number" min="0.01" step="0.01" value={option.price} onChange={(event) => update(index, 'price', event.target.value)} placeholder="1100.00" /></label>
      <button type="button" className="icon-button weight-remove-button" aria-label={`Remove weight ${index + 1}`} onClick={() => onChange(value.filter((_, optionIndex) => optionIndex !== index))}><Trash2 size={15} /></button>
    </div>)}
    <button type="button" className="button button-subtle weight-add-button" onClick={addWeight}><Plus size={15} /> Add Weight (+)</button>
  </div>
}

function FormDialog({ title, fields, initial, onClose, onSubmit, busy }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((field) => {
    if (field.type === 'weightOptions') return [field.name, (initial[field.name] || []).map((option) => ({ ...option, weightValue: String(option.weightValue), price: ((option.priceCents || 0) / 100).toFixed(2) }))]
    return [field.name, initial[field.name] ?? field.options?.[0]?.value ?? '']
  })))
  function submit(event) {
    event.preventDefault()
    const form = event.currentTarget
    const payload = { ...values }
    for (const field of fields.filter((entry) => entry.type === 'file')) payload[field.name] = form.elements[field.name].files
    onSubmit(payload)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="form-dialog-title">
      <div className="modal-heading"><div><p className="eyebrow">RESTAURANTOS</p><h2 id="form-dialog-title">{title}</h2></div><button className="icon-button close-modal" onClick={onClose} aria-label="Close">×</button></div>
      <form className="modal-form" onSubmit={submit}>
        {fields.filter((field) => !field.showWhen || field.showWhen(values)).map((field) => field.type === 'weightOptions' ? <div className="modal-field weight-options-field" key={field.name}><span>{field.label}</span><WeightOptionsEditor value={values[field.name] || []} onChange={(nextValue) => setValues({ ...values, [field.name]: nextValue })} /></div> : <label key={field.name}>
          {field.label}
          {field.type === 'select'
            ? <select name={field.name} required={field.required} value={values[field.name]} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}><option value="" disabled>Select an option</option>{field.options?.map((option) => typeof option === 'string' ? <option key={option} value={option}>{option}</option> : <option key={option.value} value={option.value}>{option.label?.replace(' (permission required)', '')}</option>)}</select>
            : field.type === 'file'
              ? <input name={field.name} type="file" accept={field.accept} />
              : field.type === 'textarea'
                ? <textarea required={field.required} maxLength={field.maxLength} placeholder={field.placeholder} value={values[field.name]} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
                : <input type={field.type || 'text'} required={field.required} min={field.name === 'quantity' && values.movementType === 'adjust' ? undefined : field.min} step={field.step} placeholder={field.placeholder} value={values[field.name]} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />}
          {field.name === 'imageUrl' && <MenuImagePreview url={values[field.name]} />}
        </label>)}
        <div className="modal-actions"><button type="button" className="button button-subtle" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </section>
  </div>
}
