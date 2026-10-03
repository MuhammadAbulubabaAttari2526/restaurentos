import { applyPayment, applyRefund, calculateRecipeNeeds, isSettledPaymentStatus, priceMenuLine } from '../../functions/domain.js'

export const DEMO_RESTAURANT_ID = 'restaurantos-demo'
export const demoUser = Object.freeze({ uid: 'demo-owner', email: 'owner@restaurantos.demo', displayName: 'Demo Owner', emailVerified: true })
export const demoMembership = Object.freeze({ restaurantId: DEMO_RESTAURANT_ID, role: 'owner', permissions: [], demo: true })

const DEMO_SESSION_KEY = 'restaurantos-demo-session'

export function isDemoSession() {
  try { return typeof window !== 'undefined' && window.sessionStorage.getItem(DEMO_SESSION_KEY) === 'active' } catch { return false }
}

export function activateDemoSession() {
  window.sessionStorage.setItem(DEMO_SESSION_KEY, 'active')
}

export function clearDemoSession() {
  window.sessionStorage.removeItem(DEMO_SESSION_KEY)
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000)
}

function daysAgo(days, hour = 12) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  date.setHours(hour, 30, 0, 0)
  return date
}

const sampleLine = (itemId, name, quantity, unitPriceCents, categoryName = 'Mains') => ({
  itemId, name, quantity, unitPriceCents, categoryId: categoryName.toLowerCase(), categoryName,
  note: '', selectedVariant: null, selectedAddOns: [],
})

function createDemoRecords() {
  const menuItems = [
    { id: 'grilled-chicken', name: 'Grilled chicken bowl', description: 'Herb chicken, rice, greens', categoryId: 'mains', categoryName: 'Mains', priceCents: 145000, available: true, recipe: [{ ingredientId: 'chicken', quantity: 0.18 }, { ingredientId: 'rice', quantity: 0.2 }] },
    { id: 'beef-burger', name: 'House beef burger', description: 'Smash patty, cheddar, house sauce', categoryId: 'mains', categoryName: 'Mains', priceCents: 112000, available: true, variants: [{ id: 'double', name: 'Double patty', priceDeltaCents: 45000 }], addOns: [{ id: 'fries', name: 'Add fries', priceCents: 28000 }], recipe: [{ ingredientId: 'beef', quantity: 0.16 }] },
    { id: 'garden-salad', name: 'Garden salad', description: 'Seasonal vegetables and lemon dressing', categoryId: 'starters', categoryName: 'Starters', priceCents: 68000, available: true, recipe: [{ ingredientId: 'greens', quantity: 0.12 }] },
    { id: 'tomato-soup', name: 'Roasted tomato soup', description: 'Slow roasted tomato, basil oil', categoryId: 'starters', categoryName: 'Starters', priceCents: 52000, available: true },
    { id: 'brownie', name: 'Warm chocolate brownie', description: 'Vanilla cream', categoryId: 'desserts', categoryName: 'Desserts', priceCents: 48000, available: true },
    { id: 'lemonade', name: 'Mint lemonade', description: 'Fresh mint and lemon', categoryId: 'drinks', categoryName: 'Drinks', priceCents: 32000, available: true },
  ]
  const today = [
    { id: 'order-demo-1', number: 'R-20261001-0012', status: 'preparing', type: 'dine-in', tableId: 'table-1', tableName: 'Table 1', customerId: 'customer-amina', items: [sampleLine('grilled-chicken', 'Grilled chicken bowl', 2, 145000), sampleLine('lemonade', 'Mint lemonade', 2, 32000, 'Drinks')], createdAt: minutesAgo(24), note: 'No onion' },
    { id: 'order-demo-2', number: 'R-20261001-0011', status: 'queued', type: 'takeaway', tableId: null, tableName: '', customerId: null, items: [sampleLine('beef-burger', 'House beef burger', 1, 112000), sampleLine('garden-salad', 'Garden salad', 1, 68000, 'Starters')], createdAt: minutesAgo(11), note: '' },
    { id: 'order-demo-3', number: 'R-20261001-0010', status: 'served', type: 'dine-in', tableId: 'table-3', tableName: 'Table 3', customerId: 'customer-hamza', items: [sampleLine('beef-burger', 'House beef burger', 2, 112000), sampleLine('brownie', 'Warm chocolate brownie', 1, 48000, 'Desserts')], createdAt: minutesAgo(82), note: '' },
    { id: 'order-demo-4', number: 'R-20261001-0009', status: 'served', type: 'delivery', tableId: null, tableName: '', customerId: 'customer-amina', items: [sampleLine('grilled-chicken', 'Grilled chicken bowl', 1, 145000)], createdAt: minutesAgo(128), note: 'Ring bell' },
  ]
  const orders = today.map((order) => ({
    restaurantId: DEMO_RESTAURANT_ID,
    orderNumber: order.number,
    type: order.type,
    tableId: order.tableId,
    tableName: order.tableName,
    customerId: order.customerId,
    items: order.items.map(({ itemId, name, quantity, unitPriceCents, categoryId, categoryName, note, selectedVariant, selectedAddOns }) => ({ itemId, name, quantity, unitPriceCents, categoryId, categoryName, note, selectedVariant, selectedAddOns })),
    status: order.status,
    paymentStatus: order.status === 'served' ? 'paid' : 'unpaid',
    createdBy: demoUser.uid,
    createdAt: order.createdAt,
    updatedAt: order.createdAt,
    note: order.note,
    id: order.id,
  }))
  const orderFinancials = orders.map((order) => {
    const subtotalCents = order.items.reduce((sum, item) => sum + (Number(item.unitPriceCents) || 0) * (Number(item.quantity) || 0), 0)
    const taxCents = Math.round(subtotalCents * 0.05)
    const paidCents = order.status === 'served' ? subtotalCents + taxCents : 0
    return {
      id: order.id,
      restaurantId: DEMO_RESTAURANT_ID,
      orderId: order.id,
      customerId: order.customerId,
      items: order.items,
      subtotalCents,
      discountCents: 0,
      taxCents,
      totalCents: subtotalCents + taxCents,
      paidCents,
      refundedCents: 0,
      customerVisitCounted: paidCents > 0,
      status: 'active',
      paymentStatus: paidCents ? 'paid' : 'unpaid',
      createdAt: order.createdAt,
      updatedAt: order.createdAt,
    }
  })

  return {
    settings: [{ id: 'profile', name: 'Cedar & Sage', currency: 'PKR', taxRate: 0.05, paymentMethods: ['cash', 'card', 'digital'], createdAt: daysAgo(30), updatedAt: daysAgo(0) }],
    categories: [
      { id: 'starters', name: 'Starters', createdAt: daysAgo(30) },
      { id: 'mains', name: 'Mains', createdAt: daysAgo(30) },
      { id: 'desserts', name: 'Desserts', createdAt: daysAgo(30) },
      { id: 'drinks', name: 'Drinks', createdAt: daysAgo(30) },
    ],
    menuItems: menuItems.map((item) => ({ ...item, createdAt: daysAgo(30) })),
    orders,
    orderFinancials,
    tables: [
      { id: 'table-1', name: 'Table 1', capacity: 4, status: 'occupied', currentOrderId: 'order-demo-1', createdAt: daysAgo(25) },
      { id: 'table-2', name: 'Table 2', capacity: 2, status: 'available', currentOrderId: null, createdAt: daysAgo(25) },
      { id: 'table-3', name: 'Table 3', capacity: 6, status: 'available', currentOrderId: null, createdAt: daysAgo(25) },
      { id: 'patio-1', name: 'Patio 1', capacity: 4, status: 'available', currentOrderId: null, createdAt: daysAgo(25) },
    ],
    customers: [
      { id: 'customer-amina', name: 'Amina Khan', phone: '+92 300 123 4567', email: 'amina@example.test', visitCount: 8, totalSpendingCents: 865400, createdAt: daysAgo(23) },
      { id: 'customer-hamza', name: 'Hamza Ali', phone: '+92 321 555 0101', email: 'hamza@example.test', visitCount: 3, totalSpendingCents: 425000, createdAt: daysAgo(18) },
      { id: 'customer-sara', name: 'Sara Ahmed', phone: '', email: '', visitCount: 1, totalSpendingCents: 196000, createdAt: daysAgo(5) },
    ],
    inventory: [
      { id: 'chicken', name: 'Chicken breast', unit: 'kg', quantityOnHand: 8.4, reorderLevel: 3, averageCostCents: 75000, createdAt: daysAgo(30) },
      { id: 'rice', name: 'Basmati rice', unit: 'kg', quantityOnHand: 12, reorderLevel: 4, averageCostCents: 32000, createdAt: daysAgo(30) },
      { id: 'beef', name: 'Ground beef', unit: 'kg', quantityOnHand: 2.1, reorderLevel: 3, averageCostCents: 125000, createdAt: daysAgo(30) },
      { id: 'greens', name: 'Salad greens', unit: 'kg', quantityOnHand: 1.2, reorderLevel: 2, averageCostCents: 28000, createdAt: daysAgo(30) },
    ],
    stockMovements: [
      { id: 'movement-demo-1', ingredientId: 'beef', itemName: 'Ground beef', unit: 'kg', movementType: 'receive', quantity: 4, reason: 'Supplier delivery', createdBy: demoUser.uid, createdAt: minutesAgo(180) },
      { id: 'movement-demo-2', ingredientId: 'greens', itemName: 'Salad greens', unit: 'kg', movementType: 'waste', quantity: -0.2, reason: 'End-of-day spoilage', createdBy: demoUser.uid, createdAt: minutesAgo(320) },
    ],
    suppliers: [
      { id: 'supplier-fresh', name: 'Fresh Fields Produce', contact: 'Usman', phone: '+92 300 777 2020', email: 'sales@freshfields.example.test', createdAt: daysAgo(60) },
      { id: 'supplier-protein', name: 'Prime Protein Co.', contact: 'Nadia', phone: '+92 333 444 0100', email: 'orders@primeprotein.example.test', createdAt: daysAgo(45) },
    ],
    purchases: [
      { id: 'purchase-demo-1', supplierId: 'supplier-fresh', supplierName: 'Fresh Fields Produce', items: [{ ingredientId: 'greens', itemName: 'Salad greens', quantity: 3, unitCostCents: 26000 }], totalCents: 78000, reference: 'FF-2048', status: 'ordered', createdBy: demoUser.uid, createdAt: minutesAgo(160), updatedAt: minutesAgo(160) },
      { id: 'purchase-demo-2', supplierId: 'supplier-protein', supplierName: 'Prime Protein Co.', items: [{ ingredientId: 'chicken', itemName: 'Chicken breast', quantity: 5, unitCostCents: 72000 }], totalCents: 360000, reference: 'PP-1180', status: 'received', createdBy: demoUser.uid, createdAt: daysAgo(2), receivedAt: daysAgo(1), updatedAt: daysAgo(1) },
    ],
    expenses: [
      { id: 'expense-demo-1', category: 'Utilities', amountCents: 850000, description: 'Monthly electricity bill', date: new Date().toISOString().slice(0, 10), method: 'transfer', status: 'approved', createdBy: demoUser.uid, createdAt: minutesAgo(230) },
      { id: 'expense-demo-2', category: 'Cleaning', amountCents: 145000, description: 'Kitchen supplies', date: daysAgo(2).toISOString().slice(0, 10), method: 'cash', status: 'approved', createdBy: demoUser.uid, createdAt: daysAgo(2) },
    ],
    users: [
      { id: demoUser.uid, email: demoUser.email, displayName: demoUser.displayName, role: 'owner', active: true, permissions: [], createdAt: daysAgo(30) },
      { id: 'demo-manager', email: 'manager@restaurantos.demo', displayName: 'Noor Ahmed', role: 'manager', active: true, permissions: [], createdAt: daysAgo(20) },
      { id: 'demo-cashier', email: 'cashier@restaurantos.demo', displayName: 'Bilal Shah', role: 'cashier', active: true, permissions: ['discounts'], createdAt: daysAgo(15) },
      { id: 'demo-waiter', email: 'waiter@restaurantos.demo', displayName: 'Mariam Iqbal', role: 'waiter', active: true, permissions: [], createdAt: daysAgo(10) },
    ],
    payments: orderFinancials.filter((finance) => finance.paidCents > 0).map((finance, index) => ({ id: `payment-demo-${index + 1}`, restaurantId: DEMO_RESTAURANT_ID, orderId: finance.orderId, amountCents: finance.paidCents, method: index === 0 ? 'cash' : 'card', kind: 'payment', recordedBy: demoUser.uid, createdAt: finance.createdAt })),
    auditLogs: [
      { id: 'audit-demo-1', action: 'order.created', entityId: orders[0].id, actorId: demoUser.uid, createdAt: minutesAgo(24) },
      { id: 'audit-demo-2', action: 'purchase.received', entityId: 'purchase-demo-2', actorId: demoUser.uid, createdAt: daysAgo(1) },
    ],
    reservations: [
      { id: 'reservation-demo-1', tableId: 'table-2', tableName: 'Table 2', guestName: 'Farah Malik', phone: '+92 301 555 1234', covers: 2, startsAt: minutesAgo(-90), endsAt: minutesAgo(-210), status: 'booked', createdBy: demoUser.uid, createdAt: minutesAgo(60) },
    ],
    draftOrders: [],
    operationKeys: [],
    staffInvitations: [],
  }
}

let demoRecords = createDemoRecords()
const listeners = new Map()

function clone(value) {
  return structuredClone(value)
}

function recordTime(value) {
  return value instanceof Date ? value.getTime() : value?.toMillis?.() || 0
}

function rowsFor(name, filters = [], max = 150) {
  return (demoRecords[name] || [])
    .filter((record) => filters.every(([field, operator, value]) => {
      const current = record[field]
      if (operator === '==') return current === value
      if (operator === '!=') return current !== value
      if (operator === '<') return recordTime(current) < recordTime(value) || current < value
      if (operator === '<=') return recordTime(current) <= recordTime(value) || current <= value
      if (operator === '>') return recordTime(current) > recordTime(value) || current > value
      if (operator === '>=') return recordTime(current) >= recordTime(value) || current >= value
      if (operator === 'in') return Array.isArray(value) && value.includes(current)
      if (operator === 'array-contains') return Array.isArray(current) && current.includes(value)
      return true
    }))
    .sort((left, right) => recordTime(right.createdAt) - recordTime(left.createdAt))
    .slice(0, max)
    .map((record) => clone(record))
}

function notify(name) {
  for (const listener of listeners.get(name) || []) listener.onData(rowsFor(name, listener.filters, listener.max))
}

function commit(name, records) {
  demoRecords[name] = records
  notify(name)
}

function makeId(prefix = 'demo') {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function updateRecord(name, id, updates) {
  const records = demoRecords[name] || []
  const index = records.findIndex((record) => record.id === id)
  if (index < 0) throw new Error('That sample record could not be found.')
  const next = [...records]
  next[index] = { ...next[index], ...updates }
  commit(name, next)
  return next[index]
}

export function watchDemoRecords(name, onData, onError, max = 150, filters = []) {
  if (!listeners.has(name)) listeners.set(name, new Set())
  const listener = { onData, onError, max, filters }
  listeners.get(name).add(listener)
  onData(rowsFor(name, filters, max))
  return () => listeners.get(name)?.delete(listener)
}

export function saveDemoRecord(name, values, id) {
  const now = new Date()
  if (id) {
    updateRecord(name, id, { ...clone(values), updatedAt: now })
    return id
  }
  const record = { ...clone(values), id: makeId(name), createdAt: now }
  commit(name, [...(demoRecords[name] || []), record])
  return record.id
}

export function removeDemoRecord(name, id) {
  commit(name, (demoRecords[name] || []).filter((record) => record.id !== id))
}

function recordAudit(action, entityId, extra = {}) {
  const now = new Date()
  commit('auditLogs', [{ id: makeId('audit'), action, entityId, actorId: demoUser.uid, ...extra, createdAt: now }, ...demoRecords.auditLogs])
}

function financialFor(orderId) {
  const record = demoRecords.orderFinancials.find((entry) => entry.id === orderId)
  if (!record) throw new Error('Order financial details were not found.')
  return record
}

function applyDemoPayment(orderId, paymentId, amountCents, kind, values = {}) {
  const duplicate = demoRecords.payments.find((entry) => entry.id === paymentId)
  if (duplicate) return { orderId, duplicate: true, paymentId }
  const finance = financialFor(orderId)
  const transition = kind === 'payment' ? applyPayment(finance, amountCents) : applyRefund(finance, amountCents)
  const payment = {
    id: paymentId,
    restaurantId: DEMO_RESTAURANT_ID,
    orderId,
    amountCents,
    method: kind === 'refund' ? 'adjustment' : values.method || 'cash',
    kind,
    reason: values.reason || '',
    reference: values.reference || '',
    recordedBy: demoUser.uid,
    createdAt: new Date(),
  }
  const updates = kind === 'payment'
    ? { ...transition, customerVisitCounted: transition.customerVisitCounted || finance.customerVisitCounted, lastPaymentId: paymentId, updatedAt: new Date() }
    : { refundedCents: transition.refundedCents, paymentStatus: transition.paymentStatus, lastPaymentId: paymentId, customerVisitCounted: transition.fullyRefunded ? false : finance.customerVisitCounted, updatedAt: new Date() }
  updateRecord('orderFinancials', orderId, updates)
  const order = demoRecords.orders.find((entry) => entry.id === orderId)
  if (order) {
    updateRecord('orders', orderId, { paymentStatus: transition.paymentStatus, updatedAt: new Date() })
    if (order.status === 'served' && order.tableId && isSettledPaymentStatus(transition.paymentStatus)) {
      updateRecord('tables', order.tableId, { status: 'available', currentOrderId: null, updatedAt: new Date() })
    }
  }
  commit('payments', [...demoRecords.payments, payment])
  if (finance.customerId && kind === 'payment' && transition.customerVisitCounted) {
    const customer = demoRecords.customers.find((entry) => entry.id === finance.customerId)
    if (customer) updateRecord('customers', customer.id, { visitCount: (customer.visitCount || 0) + 1, totalSpendingCents: (customer.totalSpendingCents || 0) + finance.totalCents, lastVisitAt: new Date() })
  }
  if (finance.customerId && kind === 'refund' && finance.customerVisitCounted) {
    const customer = demoRecords.customers.find((entry) => entry.id === finance.customerId)
    if (customer) updateRecord('customers', customer.id, { totalSpendingCents: Math.max(0, (customer.totalSpendingCents || 0) - amountCents), ...(transition.fullyRefunded ? { visitCount: Math.max(0, (customer.visitCount || 0) - 1) } : {}) })
  }
  recordAudit(kind === 'payment' ? 'payment.recorded' : 'payment.refunded', orderId, { amountCents })
  return { ...updates, duplicate: false, paymentId }
}

function reportFor(range = 'week') {
  const days = range === 'day' ? 1 : range === 'month' ? 30 : 7
  const since = Date.now() - days * 86400000
  const financials = demoRecords.orderFinancials.filter((entry) => recordTime(entry.createdAt) >= since && entry.status === 'active')
  const expenses = demoRecords.expenses.filter((entry) => new Date(`${entry.date}T00:00:00`).getTime() >= since && entry.status === 'approved')
  const salesByItem = new Map()
  const salesByCategory = new Map()
  for (const finance of financials) for (const line of finance.items || []) {
    const current = salesByItem.get(line.itemId) || { item: line.name, quantity: 0, grossSalesCents: 0 }
    current.quantity += line.quantity
    current.grossSalesCents += line.unitPriceCents * line.quantity
    salesByItem.set(line.itemId, current)
    const category = demoRecords.menuItems.find((item) => item.id === line.itemId)?.categoryName || line.categoryName || 'Uncategorised'
    const categoryRow = salesByCategory.get(category) || { category, quantity: 0, grossSalesCents: 0 }
    categoryRow.quantity += line.quantity
    categoryRow.grossSalesCents += line.unitPriceCents * line.quantity
    salesByCategory.set(category, categoryRow)
  }
  const grossSalesCents = financials.reduce((total, entry) => total + entry.subtotalCents, 0)
  const refundsCents = financials.reduce((total, entry) => total + entry.refundedCents, 0)
  const discountsCents = financials.reduce((total, entry) => total + entry.discountCents, 0)
  const expenseCents = expenses.reduce((total, entry) => total + entry.amountCents, 0)
  const paymentGroups = new Map()
  for (const payment of demoRecords.payments.filter((entry) => recordTime(entry.createdAt) >= since)) {
    const method = payment.method || 'cash'
    const row = paymentGroups.get(method) || { method, paymentCount: 0, amountCents: 0 }
    row.paymentCount += 1
    row.amountCents += payment.kind === 'refund' ? -payment.amountCents : payment.amountCents
    paymentGroups.set(method, row)
  }
  const expensesByCategory = new Map()
  for (const expense of expenses) {
    const row = expensesByCategory.get(expense.category) || { category: expense.category, amountCents: 0, count: 0 }
    row.amountCents += expense.amountCents
    row.count += 1
    expensesByCategory.set(expense.category, row)
  }
  return {
    range,
    truncated: false,
    summary: { grossSalesCents, refundsCents, discountsCents, expenseCents },
    rows: financials.map((entry) => ({ date: new Date(entry.createdAt).toISOString().slice(0, 10), orderCount: 1, grossSalesCents: entry.subtotalCents, taxCents: entry.taxCents, refundsCents: entry.refundedCents })),
    itemRows: [...salesByItem.values()].sort((left, right) => right.grossSalesCents - left.grossSalesCents),
    categoryRows: [...salesByCategory.values()].sort((left, right) => right.grossSalesCents - left.grossSalesCents),
    paymentRows: [...paymentGroups.values()],
    expenseRows: [...expensesByCategory.values()].sort((left, right) => right.amountCents - left.amountCents),
  }
}

export async function runDemoOperation(name, payload = {}) {
  const now = new Date()
  switch (name) {
    case 'createOrder': {
      const id = payload.requestId || makeId('order')
      if (demoRecords.orders.some((order) => order.id === id)) return { orderId: id, orderNumber: demoRecords.orders.find((order) => order.id === id).orderNumber, duplicate: true }
      const menu = new Map(demoRecords.menuItems.map((item) => [item.id, item]))
      const items = payload.items.map((line) => {
        const priced = priceMenuLine(menu.get(line.itemId), line)
        const categoryName = priced.categoryName || demoRecords.categories.find((category) => category.id === priced.categoryId)?.name || ''
        return { ...priced, categoryName }
      })
      const subtotalCents = items.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
      const discountCents = Math.min(Math.max(0, Number(payload.discountCents) || 0), subtotalCents)
      const settings = demoRecords.settings[0]
      const taxCents = Math.round((subtotalCents - discountCents) * settings.taxRate)
      const table = payload.tableId ? demoRecords.tables.find((entry) => entry.id === payload.tableId) : null
      if (payload.type === 'dine-in' && (!table || table.status !== 'available')) throw new Error('Select an available demo table.')
      if (!['dine-in', 'takeaway', 'delivery', 'direct-bill'].includes(payload.type)) throw new Error('Choose dine-in, takeaway, delivery, or direct bill.')
      const needs = calculateRecipeNeeds(payload.items, menu)
      for (const [ingredientId, quantity] of needs) {
        const stock = demoRecords.inventory.find((entry) => entry.id === ingredientId)
        if (!stock || stock.quantityOnHand < quantity) throw new Error(`Not enough ${stock?.name || 'recipe stock'} in the sample inventory.`)
      }
      const sequence = demoRecords.orders.length + 1
      const orderNumber = `D-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(sequence).padStart(3, '0')}`
      const order = { id, restaurantId: DEMO_RESTAURANT_ID, orderNumber, type: payload.type, tableId: table?.id || null, tableName: table?.name || '', note: payload.note || '', items: items.map(({ itemId, name, quantity, note, selectedVariant, selectedAddOns }) => ({ itemId, name, quantity, note, selectedVariant: selectedVariant?.name || '', selectedAddOns: selectedAddOns.map((option) => option.name) })), status: 'queued', paymentStatus: 'unpaid', createdBy: demoUser.uid, createdAt: now, updatedAt: now }
      const financial = { id, restaurantId: DEMO_RESTAURANT_ID, orderId: id, customerId: payload.customerId || null, items, subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents, paidCents: 0, refundedCents: 0, customerVisitCounted: false, status: 'active', paymentStatus: 'unpaid', createdAt: now, updatedAt: now }
      commit('orders', [order, ...demoRecords.orders])
      commit('orderFinancials', [financial, ...demoRecords.orderFinancials])
      if (table) updateRecord('tables', table.id, { status: 'occupied', currentOrderId: id })
      for (const [ingredientId, quantity] of needs) {
        const stock = demoRecords.inventory.find((entry) => entry.id === ingredientId)
        const movementId = `${id}_${ingredientId}`
        updateRecord('inventory', ingredientId, { quantityOnHand: stock.quantityOnHand - quantity, lastMovementId: movementId })
        commit('stockMovements', [{ id: movementId, restaurantId: DEMO_RESTAURANT_ID, ingredientId, itemName: stock.name, unit: stock.unit, movementType: 'order_consumption', quantity: -quantity, orderId: id, reason: 'Order placed', createdBy: demoUser.uid, createdAt: now }, ...demoRecords.stockMovements])
      }
      recordAudit('order.created', id)
      return { orderId: id, orderNumber, subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents, duplicate: false }
    }
    case 'transitionOrder': {
      const order = demoRecords.orders.find((entry) => entry.id === payload.orderId)
      if (!order) throw new Error('Order not found in demo data.')
      const requestId = payload.requestId || makeId('transition')
      const operationId = `transition_${requestId}`
      if (demoRecords.operationKeys.some((entry) => entry.id === operationId)) return { orderId: order.id, duplicate: true }
      const legal = { queued: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served'] }
      if (!legal[order.status]?.includes(payload.to)) throw new Error(`An order cannot move from ${order.status} to ${payload.to}.`)
      if (payload.to === 'cancelled' && financialFor(order.id).paidCents > 0) throw new Error('Refund the demo payment before cancelling this order.')
      if (payload.to === 'cancelled') {
        const menu = new Map(demoRecords.menuItems.map((item) => [item.id, item]))
        const needs = calculateRecipeNeeds(order.items, menu)
        for (const [ingredientId, quantity] of needs) {
          const stock = demoRecords.inventory.find((entry) => entry.id === ingredientId)
          if (!stock) throw new Error('A cancelled order references stock that no longer exists.')
          const movementId = `${order.id}_cancel_${ingredientId}`
          updateRecord('inventory', ingredientId, {
            quantityOnHand: Number(stock.quantityOnHand || 0) + quantity,
            lastMovementId: movementId,
            updatedAt: now,
          })
          commit('stockMovements', [{
            id: movementId, restaurantId: DEMO_RESTAURANT_ID, ingredientId, itemName: stock.name,
            unit: stock.unit, movementType: 'order_cancel_restock', quantity, reason: 'Order cancelled',
            orderId: order.id, createdBy: demoUser.uid, createdAt: now,
          }, ...demoRecords.stockMovements])
        }
      }
      updateRecord('orders', order.id, { status: payload.to, updatedAt: now, ...(payload.to === 'cancelled' ? { cancellationReason: payload.reason } : {}) })
      if (payload.to === 'cancelled') updateRecord('orderFinancials', order.id, { status: 'cancelled', updatedAt: now })
      if (order.tableId && (payload.to === 'cancelled' || (payload.to === 'served' && isSettledPaymentStatus(order.paymentStatus)))) updateRecord('tables', order.tableId, { status: 'available', currentOrderId: null })
      commit('operationKeys', [{ id: operationId, actorId: demoUser.uid, createdAt: now }, ...demoRecords.operationKeys])
      recordAudit(`order.${payload.to}`, order.id)
      return { orderId: order.id, status: payload.to, duplicate: false }
    }
    case 'recordPayment':
      return applyDemoPayment(payload.orderId, payload.paymentId || makeId('payment'), Number(payload.amountCents), 'payment', payload)
    case 'recordRefund':
      return applyDemoPayment(payload.orderId, payload.refundId || makeId('refund'), Number(payload.amountCents), 'refund', payload)
    case 'adjustInventory': {
      if (demoRecords.stockMovements.some((entry) => entry.id === payload.movementId)) return { movementId: payload.movementId, duplicate: true }
      const stock = demoRecords.inventory.find((entry) => entry.id === payload.ingredientId)
      if (!stock) throw new Error('Stock item not found.')
      const quantity = Number(payload.quantity)
      const delta = payload.movementType === 'waste' ? -quantity : quantity
      const next = stock.quantityOnHand + delta
      if (next < 0) throw new Error('This movement would make stock negative.')
      updateRecord('inventory', stock.id, { quantityOnHand: next, lastMovementId: payload.movementId })
      commit('stockMovements', [{ id: payload.movementId || makeId('movement'), restaurantId: DEMO_RESTAURANT_ID, ingredientId: stock.id, itemName: stock.name, unit: stock.unit, movementType: payload.movementType, quantity: delta, reason: payload.reason, createdBy: demoUser.uid, createdAt: now }, ...demoRecords.stockMovements])
      recordAudit(`inventory.${payload.movementType}`, stock.id, { quantity: delta })
      return { movementId: payload.movementId, quantityOnHand: next, duplicate: false }
    }
    case 'recordExpense': {
      const expense = { id: payload.expenseId || makeId('expense'), restaurantId: DEMO_RESTAURANT_ID, ...payload, status: 'approved', createdBy: demoUser.uid, createdAt: now }
      if (demoRecords.expenses.some((entry) => entry.id === expense.id)) return { expenseId: expense.id, duplicate: true }
      commit('expenses', [expense, ...demoRecords.expenses])
      recordAudit('expense.recorded', expense.id, { amountCents: expense.amountCents })
      return { expenseId: expense.id, duplicate: false }
    }
    case 'createReservation': {
      if (demoRecords.reservations.some((entry) => entry.id === payload.reservationId)) return { reservationId: payload.reservationId, duplicate: true }
      const table = demoRecords.tables.find((entry) => entry.id === payload.tableId)
      if (!table || table.status !== 'available') throw new Error('That demo table is not available.')
      const startsAt = new Date(payload.startsAtMillis)
      const endsAt = new Date(startsAt.getTime() + Number(payload.durationMinutes) * 60000)
      if (demoRecords.reservations.some((entry) => entry.tableId === table.id && entry.status === 'booked' && entry.startsAt < endsAt && entry.endsAt > startsAt)) throw new Error('That demo table already has a reservation at this time.')
      const reservation = { id: payload.reservationId || makeId('reservation'), restaurantId: DEMO_RESTAURANT_ID, tableId: table.id, tableName: table.name, guestName: payload.guestName, phone: payload.phone || '', covers: Number(payload.covers), startsAt, endsAt, status: 'booked', createdBy: demoUser.uid, createdAt: now }
      commit('reservations', [reservation, ...demoRecords.reservations])
      recordAudit('reservation.created', reservation.id)
      return { reservationId: reservation.id, duplicate: false }
    }
    case 'seatReservation':
    case 'cancelReservation': {
      const reservation = demoRecords.reservations.find((entry) => entry.id === payload.reservationId)
      if (!reservation || reservation.status !== 'booked') throw new Error('This demo reservation is no longer active.')
      updateRecord('reservations', reservation.id, { status: name === 'seatReservation' ? 'seated' : 'cancelled', updatedAt: now })
      recordAudit(`reservation.${name === 'seatReservation' ? 'seated' : 'cancelled'}`, reservation.id)
      return { reservationId: reservation.id, status: name === 'seatReservation' ? 'seated' : 'cancelled' }
    }
    case 'createPurchase': {
      if (demoRecords.purchases.some((entry) => entry.id === payload.purchaseId)) return { purchaseId: payload.purchaseId, duplicate: true }
      const supplier = demoRecords.suppliers.find((entry) => entry.id === payload.supplierId)
      const items = payload.items.map((line) => ({ ...line, itemName: demoRecords.inventory.find((stock) => stock.id === line.ingredientId)?.name || 'Stock item' }))
      const purchase = { id: payload.purchaseId || makeId('purchase'), restaurantId: DEMO_RESTAURANT_ID, supplierId: payload.supplierId, supplierName: supplier?.name || 'Supplier', items, totalCents: Math.round(items.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0)), reference: payload.reference || '', status: 'ordered', createdBy: demoUser.uid, createdAt: now }
      commit('purchases', [purchase, ...demoRecords.purchases])
      recordAudit('purchase.created', purchase.id)
      return { purchaseId: purchase.id, duplicate: false }
    }
    case 'receivePurchase': {
      const purchase = demoRecords.purchases.find((entry) => entry.id === payload.purchaseId)
      if (!purchase || purchase.status === 'received') return { purchaseId: payload.purchaseId, duplicate: true }
      for (const line of purchase.items) {
        const stock = demoRecords.inventory.find((entry) => entry.id === line.ingredientId)
        if (!stock) continue
        const next = stock.quantityOnHand + line.quantity
        const averageCostCents = Math.round(((stock.quantityOnHand * (stock.averageCostCents || 0)) + (line.quantity * line.unitCostCents)) / next)
        const movementId = `${purchase.id}_${line.ingredientId}`
        updateRecord('inventory', stock.id, { quantityOnHand: next, averageCostCents, lastMovementId: movementId })
        commit('stockMovements', [{ id: movementId, restaurantId: DEMO_RESTAURANT_ID, ingredientId: stock.id, itemName: stock.name, unit: stock.unit, movementType: 'purchase_received', quantity: line.quantity, purchaseId: purchase.id, createdBy: demoUser.uid, createdAt: now }, ...demoRecords.stockMovements])
      }
      updateRecord('purchases', purchase.id, { status: 'received', receivedAt: now, receivedBy: demoUser.uid })
      recordAudit('purchase.received', purchase.id)
      return { purchaseId: purchase.id, duplicate: false }
    }
    case 'inviteStaff': {
      const invitationId = makeId('invite')
      const invitation = { id: invitationId, restaurantId: DEMO_RESTAURANT_ID, email: payload.email, displayName: payload.displayName, role: payload.role, active: true, status: 'open', createdBy: demoUser.uid, createdAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000) }
      commit('staffInvitations', [invitation, ...demoRecords.staffInvitations])
      return { invitationId, inviteUrl: `${window.location.origin}/join/${DEMO_RESTAURANT_ID}/${invitationId}` }
    }
    case 'setStaffActive':
      updateRecord('users', payload.userId, { active: Boolean(payload.active), updatedAt: now })
      recordAudit(payload.active ? 'staff.access_enabled' : 'staff.access_disabled', payload.userId)
      return { userId: payload.userId, active: payload.active }
    case 'deleteStaffMember': {
      const member = demoRecords.users.find((entry) => entry.id === payload.userId)
      if (!member) throw new Error('Team member not found.')
      if (member.role === 'owner') throw new Error('The owner account cannot be removed here.')
      updateRecord('users', payload.userId, { active: false, removedAt: now, updatedAt: now })
      recordAudit('staff.member_deleted', payload.userId)
      return { userId: payload.userId, deleted: true }
    }
    case 'setStaffPermissions':
      updateRecord('users', payload.userId, { permissions: payload.permissions || [] })
      recordAudit('staff.permissions_updated', payload.userId)
      return { userId: payload.userId, permissions: payload.permissions || [] }
    case 'saveOrderDraft': {
      const draftId = payload.draftId || makeId('draft')
      const { draftId: _requestedDraftId, ...draftValues } = payload
      const values = { ...draftValues, restaurantId: DEMO_RESTAURANT_ID, createdBy: demoUser.uid, status: 'draft', updatedAt: now }
      if (demoRecords.draftOrders.some((entry) => entry.id === draftId)) {
        saveDemoRecord('draftOrders', values, draftId)
      } else {
        commit('draftOrders', [...demoRecords.draftOrders, { ...clone(values), id: draftId, createdAt: now }])
      }
      return { draftId, duplicate: false }
    }
    case 'deleteOrderDraft': {
      const draft = demoRecords.draftOrders.find((entry) => entry.id === payload.draftId)
      if (!draft) return { draftId: payload.draftId, deleted: false }
      if (draft.createdBy !== demoUser.uid) throw new Error('This draft belongs to another team member.')
      removeDemoRecord('draftOrders', payload.draftId)
      return { draftId: payload.draftId, deleted: true }
    }
    case 'exportReport':
      return reportFor(payload.range)
    case 'getCustomerHistory': {
      const customer = demoRecords.customers.find((entry) => entry.id === payload.customerId)
      const rows = demoRecords.orderFinancials.filter((entry) => entry.customerId === payload.customerId && ['paid', 'partially_refunded', 'refunded'].includes(entry.paymentStatus)).map((finance) => {
        const order = demoRecords.orders.find((entry) => entry.id === finance.orderId)
        return order ? { orderId: order.id, orderNumber: order.orderNumber, createdAt: order.createdAt, type: order.type, items: finance.items, totalCents: finance.totalCents, refundedCents: finance.refundedCents, paymentStatus: finance.paymentStatus } : null
      }).filter(Boolean)
      if (!customer) throw new Error('Customer not found in demo data.')
      return { customer, rows }
    }
    case 'mergeTables': {
      const target = demoRecords.tables.find((entry) => entry.id === payload.targetTableId)
      const source = demoRecords.tables.find((entry) => entry.id === payload.sourceTableId)
      if (!target || !source || target.id === source.id || target.status !== 'available' || source.status !== 'available' || target.mergedInto || target.mergedTableIds?.length || source.mergedInto || source.mergedTableIds?.length) throw new Error('Choose two separate, available demo tables to combine.')
      if (demoRecords.reservations.some((entry) => [target.id, source.id].includes(entry.tableId) && entry.status === 'booked' && entry.endsAt > now)) throw new Error('Cancel or complete the reservation before combining these tables.')
      updateRecord('tables', target.id, { capacity: Number(target.capacity) + Number(source.capacity), unmergedCapacity: target.capacity, mergedTableIds: [source.id], mergedTableNames: [source.name] })
      updateRecord('tables', source.id, { status: 'merged', mergedInto: target.id })
      recordAudit('table.merged', target.id, { reason: source.name })
      return { targetTableId: target.id, sourceTableId: source.id, duplicate: false }
    }
    case 'unmergeTables': {
      const target = demoRecords.tables.find((entry) => entry.id === payload.targetTableId)
      if (!target?.mergedTableIds?.length || target.status !== 'available') throw new Error('This demo table group cannot be unmerged right now.')
      const sourceIds = target.mergedTableIds
      if (demoRecords.reservations.some((entry) => [target.id, ...sourceIds].includes(entry.tableId) && entry.status === 'booked' && entry.endsAt > now)) throw new Error('Cancel or complete reservations before separating this group.')
      updateRecord('tables', target.id, { capacity: target.unmergedCapacity, unmergedCapacity: null, mergedTableIds: [], mergedTableNames: [] })
      for (const sourceId of sourceIds) updateRecord('tables', sourceId, { status: 'available', mergedInto: null })
      recordAudit('table.unmerged', target.id)
      return { targetTableId: target.id, unmergedTableIds: sourceIds }
    }
    case 'transferOrderTable': {
      const order = demoRecords.orders.find((entry) => entry.id === payload.orderId)
      const target = demoRecords.tables.find((entry) => entry.id === payload.targetTableId)
      if (!order || !target) throw new Error('Choose an order and target table from the sample workspace.')
      if (order.type !== 'dine-in' || !order.tableId || ['served', 'cancelled'].includes(order.status)) throw new Error('Only active dine-in orders can move to another table.')
      if (order.tableId === target.id) return { orderId: order.id, targetTableId: target.id, duplicate: true }
      if (target.status !== 'available' || (order.items || []).reduce((sum, item) => sum + item.quantity, 0) > Number(target.capacity || 0)) throw new Error('The target demo table is occupied or too small.')
      if (demoRecords.reservations.some((entry) => entry.tableId === target.id && entry.status === 'booked' && entry.startsAt <= now && entry.endsAt > now)) throw new Error('The target demo table is reserved right now.')
      const old = demoRecords.tables.find((entry) => entry.id === order.tableId)
      if (!old || old.currentOrderId !== order.id) throw new Error('The original demo table no longer has this order.')
      updateRecord('tables', old.id, { status: 'available', currentOrderId: null })
      updateRecord('tables', target.id, { status: 'occupied', currentOrderId: order.id })
      updateRecord('orders', order.id, { tableId: target.id, tableName: target.name, updatedAt: now })
      recordAudit('order.table_transferred', order.id, { reason: `${old.name} -> ${target.name}` })
      return { orderId: order.id, targetTableId: target.id, duplicate: false }
    }
    default:
      throw new Error(`${name} is not available in the sample workspace.`)
  }
}
