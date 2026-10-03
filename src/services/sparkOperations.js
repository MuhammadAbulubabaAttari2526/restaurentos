import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore'
import { auth, db } from '../lib/firebase.js'
import { applyPayment, applyRefund, calculateRecipeNeeds, isSettledPaymentStatus, priceMenuLine, shouldLoadFinancialForTransition } from '../../functions/domain.js'

const path = (restaurantId, name, id) => doc(db, 'restaurants', restaurantId, name, id)
const rows = (restaurantId, name) => collection(db, 'restaurants', restaurantId, name)
const auditRef = (restaurantId) => doc(rows(restaurantId, 'auditLogs'))

function fail(message) {
  throw new Error(message)
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail(`${label} is invalid.`)
  return value
}

function positiveCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) fail(`${label} must be a positive amount.`)
  return value
}

async function actorFor(allowedRoles = ['owner', 'manager'], { loadMember = true } = {}) {
  const user = auth?.currentUser
  if (!user || !db) fail('Sign in to continue.')
  const token = await user.getIdTokenResult()
  let restaurantId = token.claims.restaurantId
  let role = token.claims.role
  if (!restaurantId || !role) {
    const account = await getDoc(doc(db, 'accountMemberships', user.uid))
    if (account.exists() && account.data().active === true) {
      restaurantId = account.data().restaurantId
      role = account.data().role
    }
  }
  if (!restaurantId || !allowedRoles.includes(role)) fail('This action is available to restaurant owners and managers.')
  if (!loadMember) return { uid: user.uid, restaurantId, role, member: null }
  const member = await getDoc(path(restaurantId, 'users', user.uid))
  if (!member.exists() || member.data().active !== true || member.data().role !== role) fail('Your restaurant access is inactive.')
  return { uid: user.uid, restaurantId, role, member: member.data() }
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function createAudit(transaction, actor, action, entityId, details = {}) {
  transaction.set(auditRef(actor.restaurantId), {
    action,
    ...(entityId ? { entityId } : {}),
    actorId: actor.uid,
    ...details,
    createdAt: serverTimestamp(),
  })
}

async function createOrder(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'], { loadMember: Number(data.discountCents || 0) > 0 })
  const requestId = safeId(data.requestId, 'Request ID')
  const type = ['dine-in', 'takeaway', 'delivery', 'direct-bill'].includes(data.type) ? data.type : fail('Choose dine-in, takeaway, delivery, or direct bill.')
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 40) fail('An order must contain 1 to 40 menu lines.')
  const quantities = new Map()
  for (const line of data.items) {
    const itemId = safeId(line.itemId, 'Menu item')
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail('Item quantity must be between 1 and 99.')
    quantities.set(itemId, (quantities.get(itemId) || 0) + line.quantity)
  }
  const itemIds = [...quantities.keys()]
  const orderRef = path(actor.restaurantId, 'orders', requestId)
  const financeRef = path(actor.restaurantId, 'orderFinancials', requestId)
  const day = localDayKey(new Date())
  const counterRef = path(actor.restaurantId, 'counters', day)
  const settingRef = path(actor.restaurantId, 'settings', 'profile')
  const tableId = type === 'dine-in' ? safeId(data.tableId, 'Table') : null
  const tableRef = tableId ? path(actor.restaurantId, 'tables', tableId) : null
  const customerId = data.customerId ? safeId(data.customerId, 'Customer') : null
  const customerRef = customerId ? path(actor.restaurantId, 'customers', customerId) : null
  const menuRefs = itemIds.map((id) => path(actor.restaurantId, 'menuItems', id))

  return runTransaction(db, async (transaction) => {
    const refs = [orderRef, counterRef, settingRef, ...(tableRef ? [tableRef] : []), ...(customerRef ? [customerRef] : []), ...menuRefs]
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)))
    const existing = snapshots[0]
    if (existing.exists()) return { orderId: requestId, orderNumber: existing.data().orderNumber, duplicate: true }
    let offset = 1
    const counterSnapshot = snapshots[offset++]
    const settingsSnapshot = snapshots[offset++]
    const tableSnapshot = tableRef ? snapshots[offset++] : null
    const customerSnapshot = customerRef ? snapshots[offset++] : null
    const menuSnapshots = snapshots.slice(offset)
    if (!settingsSnapshot.exists()) fail('Restaurant settings have not been configured.')
    if (tableRef && (!tableSnapshot.exists() || tableSnapshot.data().status !== 'available')) fail('That table is occupied or unavailable.')
    if (customerRef && !customerSnapshot.exists()) fail('That customer record could not be found.')

    const menuById = new Map(menuRefs.map((ref, index) => [itemIds[index], menuSnapshots[index].data()]))
    if (menuSnapshots.some((snapshot) => !snapshot.exists() || snapshot.data().available === false)) fail('One or more items are no longer available.')
    const lines = data.items.map((line) => priceMenuLine(menuById.get(line.itemId), line))
    const recipeNeeds = calculateRecipeNeeds(data.items, menuById)
    const stockRefs = [...recipeNeeds.keys()].map((id) => path(actor.restaurantId, 'inventory', id))
    const stockSnapshots = await Promise.all(stockRefs.map((ref) => transaction.get(ref)))
    const stockById = new Map([...recipeNeeds.keys()].map((id, index) => [id, stockSnapshots[index]]))
    for (const [ingredientId, quantity] of recipeNeeds) {
      const stock = stockById.get(ingredientId)
      if (!stock?.exists()) fail('A menu recipe references stock that no longer exists.')
      if (Number(stock.data().quantityOnHand || 0) < quantity) fail(`Not enough ${stock.data().name} in stock to send this order.`)
    }

    let activeReservations = null
    if (tableRef) {
      const now = new Date()
      activeReservations = await getDocs(query(
        rows(actor.restaurantId, 'reservations'),
        where('tableId', '==', tableId),
        where('status', '==', 'booked'),
        where('startsAt', '<=', now),
        where('endsAt', '>', now),
      ))
      if (!activeReservations.empty) fail('That table has an active reservation. Choose another table.')
    }

    const subtotalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
    const discountCents = Number(data.discountCents || 0)
    if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > subtotalCents) fail('Discount must be between zero and the order subtotal.')
    if (discountCents > 0 && !['owner', 'manager'].includes(actor.role) && !actor.member.permissions?.includes('discounts')) fail('Discounts require explicit permission.')
    const taxRate = Number(settingsSnapshot.data().taxRate || 0)
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) fail('Restaurant tax settings are invalid.')
    const taxCents = Math.round((subtotalCents - discountCents) * taxRate)
    const sequence = Number(counterSnapshot.data()?.value || 0) + 1
    const orderNumber = `R-${day.replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`
    const tableName = tableSnapshot?.data()?.name || ''
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 500) : ''
    const createdAt = serverTimestamp()
    const order = {
      restaurantId: actor.restaurantId,
      orderNumber,
      type,
      tableId,
      tableName,
      note,
      items: lines.map(({ itemId, name, quantity, note: itemNote, selectedVariant, selectedAddOns }) => ({
        itemId, name, quantity, note: itemNote, selectedVariant,
        selectedAddOns: selectedAddOns.map(({ id, name: addOnName }) => ({ id, name: addOnName })),
      })),
      status: 'queued',
      paymentStatus: 'unpaid',
      createdBy: actor.uid,
      createdAt,
      updatedAt: createdAt,
    }
    transaction.set(orderRef, order)
    transaction.set(counterRef, { value: sequence, updatedAt: serverTimestamp() })
    transaction.set(financeRef, {
      restaurantId: actor.restaurantId,
      orderId: requestId,
      customerId,
      items: lines,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: subtotalCents - discountCents + taxCents,
      paidCents: 0,
      refundedCents: 0,
      customerVisitCounted: false,
      status: 'active',
      paymentStatus: 'unpaid',
      createdAt,
      updatedAt: createdAt,
    })
    for (const [ingredientId, quantity] of recipeNeeds) {
      const stock = stockById.get(ingredientId).data()
      const movementId = `${requestId}_${ingredientId}`
      transaction.update(path(actor.restaurantId, 'inventory', ingredientId), {
        quantityOnHand: Number(stock.quantityOnHand || 0) - quantity,
        lastMovementId: movementId,
        updatedAt: serverTimestamp(),
      })
      transaction.set(path(actor.restaurantId, 'stockMovements', movementId), {
        restaurantId: actor.restaurantId,
        ingredientId,
        itemName: stock.name,
        unit: stock.unit,
        movementType: 'order_consumption',
        quantity: -quantity,
        reason: 'Order placed',
        orderId: requestId,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
      })
    }
    if (tableRef) transaction.update(tableRef, { status: 'occupied', currentOrderId: requestId, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'order.created', requestId)
    return {
      orderId: requestId,
      orderNumber,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: subtotalCents - discountCents + taxCents,
      duplicate: false,
    }
  })
}

async function saveOrderDraft(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'])
  const draftId = safeId(data.draftId, 'Draft')
  const type = ['dine-in', 'takeaway', 'delivery', 'direct-bill'].includes(data.type) ? data.type : fail('Choose dine-in, takeaway, delivery, or direct bill.')
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 40) fail('A draft must contain 1 to 40 menu lines.')
  const draftRef = path(actor.restaurantId, 'draftOrders', draftId)
  const menuIds = [...new Set(data.items.map((line) => safeId(line.itemId, 'Menu item')))]
  const menuRefs = menuIds.map((id) => path(actor.restaurantId, 'menuItems', id))
  const tableRef = type === 'dine-in' && data.tableId ? path(actor.restaurantId, 'tables', safeId(data.tableId, 'Table')) : null
  const customerRef = data.customerId ? path(actor.restaurantId, 'customers', safeId(data.customerId, 'Customer')) : null
  return runTransaction(db, async (transaction) => {
    const refs = [draftRef, ...(tableRef ? [tableRef] : []), ...(customerRef ? [customerRef] : []), ...menuRefs]
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)))
    const draft = snapshots[0]
    let offset = 1
    const table = tableRef ? snapshots[offset++] : null
    const customer = customerRef ? snapshots[offset++] : null
    const menus = snapshots.slice(offset)
    if (draft.exists() && draft.data().createdBy !== actor.uid) fail('This draft belongs to another team member.')
    if (tableRef && (!table.exists() || table.data().status === 'occupied')) fail('That table is not available.')
    if (customerRef && !customer.exists()) fail('Customer not found.')
    const menuById = new Map(menuIds.map((id, index) => [id, menus[index].data()]))
    let subtotalCents = 0
    const items = data.items.map((line) => {
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail('Item quantity must be between 1 and 99.')
      const menu = menuById.get(line.itemId)
      if (!menu || menu.available === false) fail('One or more items are no longer available.')
      const priced = priceMenuLine(menu, line)
      subtotalCents += priced.unitPriceCents * line.quantity
      return {
        itemId: line.itemId,
        quantity: line.quantity,
        note: typeof line.note === 'string' ? line.note.trim().slice(0, 300) : '',
        selectedVariantId: line.selectedVariantId || null,
        selectedAddOnIds: line.selectedAddOnIds || [],
      }
    })
    const discountCents = Number(data.discountCents || 0)
    if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > subtotalCents) fail('Discount cannot exceed the draft subtotal.')
    if (discountCents > 0 && !['owner', 'manager'].includes(actor.role) && !actor.member.permissions?.includes('discounts')) fail('Discounts require explicit permission.')
    const now = serverTimestamp()
    transaction.set(draftRef, {
      restaurantId: actor.restaurantId,
      createdBy: draft.exists() ? draft.data().createdBy : actor.uid,
      status: 'draft',
      type,
      tableId: tableRef ? data.tableId : null,
      customerId: data.customerId || null,
      note: typeof data.note === 'string' ? data.note.trim().slice(0, 500) : '',
      items,
      discountCents,
      createdAt: draft.exists() ? draft.data().createdAt : now,
      updatedAt: now,
    })
    return { draftId, duplicate: false }
  })
}

async function deleteOrderDraft(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'], { loadMember: false })
  const draftId = safeId(data.draftId, 'Draft')
  const draftRef = path(actor.restaurantId, 'draftOrders', draftId)
  return runTransaction(db, async (transaction) => {
    const draft = await transaction.get(draftRef)
    if (!draft.exists()) return { draftId, deleted: false }
    if (draft.data().createdBy !== actor.uid) fail('This draft belongs to another team member.')
    transaction.delete(draftRef)
    return { draftId, deleted: true }
  })
}

async function transitionOrder(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'])
  const orderId = safeId(data.orderId, 'Order')
  const requestId = safeId(data.requestId, 'Request ID')
  const to = data.to
  const orderRef = path(actor.restaurantId, 'orders', orderId)
  const financeRef = path(actor.restaurantId, 'orderFinancials', orderId)
  const operationRef = path(actor.restaurantId, 'operationKeys', `transition_${requestId}`)
  return runTransaction(db, async (transaction) => {
    const needsFinance = shouldLoadFinancialForTransition(data.to, actor.role)
    const [order, finance, operation] = await Promise.all([
      transaction.get(orderRef),
      needsFinance ? transaction.get(financeRef) : Promise.resolve(null),
      transaction.get(operationRef),
    ])
    if (operation.exists()) return { orderId, duplicate: true }
    if (!order.exists() || (needsFinance && !finance?.exists())) fail('Order not found.')
    const transitions = { queued: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served'] }
    if (!transitions[order.data().status]?.includes(to)) fail(`An order cannot move from ${order.data().status} to ${to}.`)
    if (to === 'cancelled') {
      if (!['owner', 'manager'].includes(actor.role) && !actor.member.permissions?.includes('voidOrders')) fail('Cancelling an order requires explicit permission.')
      if (typeof data.reason !== 'string' || !data.reason.trim()) fail('Enter a cancellation reason.')
      if ((finance.data().paidCents || 0) > 0) fail('Record a refund before cancelling a paid order.')
    }
    const tableRef = order.data().tableId ? path(actor.restaurantId, 'tables', order.data().tableId) : null
    const paymentState = order.data().paymentStatus || finance?.data()?.paymentStatus
    const table = tableRef && (to === 'cancelled' || (to === 'served' && isSettledPaymentStatus(paymentState)))
      ? await transaction.get(tableRef)
      : null
    if (to === 'cancelled') transaction.update(financeRef, { status: 'cancelled', updatedAt: serverTimestamp() })
    transaction.update(orderRef, {
      status: to,
      updatedAt: serverTimestamp(),
      ...(to === 'cancelled' ? { cancellationReason: data.reason.trim().slice(0, 300), cancelledBy: actor.uid } : {}),
    })
    if (table?.exists()) transaction.update(tableRef, { status: 'available', currentOrderId: null, updatedAt: serverTimestamp() })
    transaction.set(operationRef, { actorId: actor.uid, createdAt: serverTimestamp() })
    createAudit(transaction, actor, `order.${to}`, orderId, to === 'cancelled' ? { reason: data.reason.trim().slice(0, 300) } : {})
    return { orderId, status: to, duplicate: false }
  })
}

async function recordPayment(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier'])
  const orderId = safeId(data.orderId, 'Order')
  const paymentId = safeId(data.paymentId, 'Payment')
  const amountCents = positiveCents(data.amountCents, 'Payment amount')
  const method = ['cash', 'card', 'digital'].includes(data.method) ? data.method : fail('Choose cash, card, or digital payment.')
  const orderRef = path(actor.restaurantId, 'orders', orderId)
  const financeRef = path(actor.restaurantId, 'orderFinancials', orderId)
  const paymentRef = path(actor.restaurantId, 'payments', paymentId)
  const settingRef = path(actor.restaurantId, 'settings', 'profile')
  return runTransaction(db, async (transaction) => {
    const [order, finance, payment, settings] = await Promise.all([
      transaction.get(orderRef), transaction.get(financeRef), transaction.get(paymentRef), transaction.get(settingRef),
    ])
    if (payment.exists()) return { paymentId, duplicate: true }
    if (!order.exists() || !finance.exists()) fail('Order not found.')
    if (order.data().status === 'cancelled') fail('Cancelled orders cannot accept payment.')
    const allowed = settings.exists() ? settings.data().paymentMethods || ['cash', 'card', 'digital'] : ['cash']
    if (!allowed.includes(method)) fail('That payment method is not enabled for this restaurant.')
    const update = applyPayment(finance.data(), amountCents)
    const countVisit = Boolean(finance.data().customerId && update.customerVisitCounted)
    const customerRef = countVisit ? path(actor.restaurantId, 'customers', finance.data().customerId) : null
    const customer = customerRef ? await transaction.get(customerRef) : null
    if (countVisit && !customer?.exists()) fail('Customer record is no longer available.')
    transaction.set(paymentRef, {
      restaurantId: actor.restaurantId,
      orderId,
      amountCents,
      method,
      reference: typeof data.reference === 'string' ? data.reference.trim().slice(0, 100) : '',
      kind: 'payment',
      recordedBy: actor.uid,
      createdAt: serverTimestamp(),
    })
    transaction.update(financeRef, {
      paidCents: update.paidCents,
      paymentStatus: update.paymentStatus,
      customerVisitCounted: update.customerVisitCounted || finance.data().customerVisitCounted || false,
      lastPaymentId: paymentId,
      updatedAt: serverTimestamp(),
    })
    transaction.update(orderRef, { paymentStatus: update.paymentStatus, updatedAt: serverTimestamp() })
    if (countVisit) transaction.update(customerRef, {
      visitCount: increment(1),
      totalSpendingCents: increment(finance.data().totalCents),
      lastVisitAt: serverTimestamp(),
      lastFinancialId: orderId,
      updatedAt: serverTimestamp(),
    })
    if (order.data().status === 'served' && isSettledPaymentStatus(update.paymentStatus) && order.data().tableId) {
      transaction.update(path(actor.restaurantId, 'tables', order.data().tableId), { status: 'available', currentOrderId: null, updatedAt: serverTimestamp() })
    }
    createAudit(transaction, actor, 'payment.recorded', orderId, { amountCents })
    return { paymentId, paymentStatus: update.paymentStatus, paidCents: update.paidCents, duplicate: false }
  })
}

async function recordRefund(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier'])
  if (actor.role === 'cashier' && !actor.member.permissions?.includes('refunds')) fail('Refunds require explicit permission.')
  const orderId = safeId(data.orderId, 'Order')
  const refundId = safeId(data.refundId, 'Refund')
  const amountCents = positiveCents(data.amountCents, 'Refund amount')
  if (typeof data.reason !== 'string' || !data.reason.trim()) fail('Enter a refund reason.')
  const orderRef = path(actor.restaurantId, 'orders', orderId)
  const financeRef = path(actor.restaurantId, 'orderFinancials', orderId)
  const paymentRef = path(actor.restaurantId, 'payments', refundId)
  return runTransaction(db, async (transaction) => {
    const [order, finance, payment] = await Promise.all([transaction.get(orderRef), transaction.get(financeRef), transaction.get(paymentRef)])
    if (payment.exists()) return { refundId, duplicate: true }
    if (!order.exists() || !finance.exists()) fail('Order not found.')
    const { refundedCents, fullyRefunded, paymentStatus } = applyRefund(finance.data(), amountCents)
    const customerRef = finance.data().customerId ? path(actor.restaurantId, 'customers', finance.data().customerId) : null
    const customer = customerRef ? await transaction.get(customerRef) : null
    transaction.set(paymentRef, {
      restaurantId: actor.restaurantId,
      orderId,
      amountCents,
      method: 'adjustment',
      kind: 'refund',
      reason: data.reason.trim().slice(0, 300),
      recordedBy: actor.uid,
      createdAt: serverTimestamp(),
    })
    transaction.update(financeRef, {
      refundedCents,
      paymentStatus,
      lastPaymentId: refundId,
      ...(fullyRefunded && finance.data().customerVisitCounted ? { customerVisitCounted: false } : {}),
      updatedAt: serverTimestamp(),
    })
    transaction.update(orderRef, { paymentStatus, updatedAt: serverTimestamp() })
    if (customerRef && customer?.exists() && finance.data().customerVisitCounted) transaction.update(customerRef, {
      totalSpendingCents: increment(-amountCents),
      ...(fullyRefunded ? { visitCount: increment(-1) } : {}),
      lastFinancialId: orderId,
      updatedAt: serverTimestamp(),
    })
    createAudit(transaction, actor, 'payment.refunded', orderId, { amountCents, reason: data.reason.trim().slice(0, 300) })
    return { refundId, refundedCents, duplicate: false }
  })
}

async function adjustInventory(data) {
  const actor = await actorFor()
  const ingredientId = safeId(data.ingredientId, 'Stock item')
  const movementId = safeId(data.movementId, 'Movement')
  if (!['receive', 'waste', 'adjust'].includes(data.movementType)) fail('Choose a valid stock movement.')
  if (typeof data.reason !== 'string' || !data.reason.trim()) fail('Enter a reason for the stock movement.')
  const quantity = Number(data.quantity)
  if (!Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 1000000 || (data.movementType !== 'adjust' && quantity < 0)) fail('Enter a valid stock quantity.')
  const delta = data.movementType === 'waste' ? -quantity : quantity
  const stockRef = path(actor.restaurantId, 'inventory', ingredientId)
  const movementRef = path(actor.restaurantId, 'stockMovements', movementId)
  return runTransaction(db, async (transaction) => {
    const [stock, movement] = await Promise.all([transaction.get(stockRef), transaction.get(movementRef)])
    if (movement.exists()) return { movementId, duplicate: true }
    if (!stock.exists()) fail('Stock item not found.')
    const nextQuantity = Number(stock.data().quantityOnHand || 0) + delta
    if (nextQuantity < 0) fail('This movement would make stock negative.')
    transaction.update(stockRef, { quantityOnHand: nextQuantity, lastMovementId: movementId, updatedAt: serverTimestamp() })
    transaction.set(movementRef, {
      restaurantId: actor.restaurantId,
      ingredientId,
      itemName: stock.data().name,
      unit: stock.data().unit,
      movementType: data.movementType,
      quantity: delta,
      reason: data.reason.trim().slice(0, 300),
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
    })
    createAudit(transaction, actor, `inventory.${data.movementType}`, ingredientId, { quantity: delta, reason: data.reason.trim().slice(0, 300) })
    return { movementId, quantityOnHand: nextQuantity, duplicate: false }
  })
}

async function recordExpense(data) {
  const actor = await actorFor()
  const expenseId = safeId(data.expenseId, 'Expense')
  const amountCents = positiveCents(data.amountCents, 'Expense amount')
  const category = typeof data.category === 'string' ? data.category.trim() : ''
  const date = typeof data.date === 'string' ? data.date : ''
  if (!category || category.length > 80 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('Enter a valid expense category and date.')
  const expenseRef = path(actor.restaurantId, 'expenses', expenseId)
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(expenseRef)
    if (existing.exists()) return { expenseId, duplicate: true }
    transaction.set(expenseRef, {
      restaurantId: actor.restaurantId,
      amountCents,
      category,
      description: typeof data.description === 'string' ? data.description.trim().slice(0, 500) : '',
      date,
      method: ['cash', 'card', 'transfer'].includes(data.method) ? data.method : 'cash',
      status: 'approved',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    createAudit(transaction, actor, 'expense.recorded', expenseId, { amountCents })
    return { expenseId, duplicate: false }
  })
}

async function createReservation(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  const tableId = safeId(data.tableId, 'Table')
  const guestName = typeof data.guestName === 'string' ? data.guestName.trim() : ''
  const covers = Number(data.covers)
  const durationMinutes = Number(data.durationMinutes)
  const startsAtMillis = Number(data.startsAtMillis)
  if (!guestName || guestName.length > 120) fail('Enter a valid guest name.')
  if (!Number.isInteger(covers) || covers < 1 || covers > 40) fail('Guest count must be between 1 and 40.')
  if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 360) fail('Reservation length must be between 30 minutes and 6 hours.')
  if (!Number.isSafeInteger(startsAtMillis) || startsAtMillis < Date.now() - 3600000 || startsAtMillis > Date.now() + 365 * 86400000) fail('Choose a valid reservation time within the next 12 months.')
  const startsAt = new Date(startsAtMillis)
  const endsAt = new Date(startsAtMillis + durationMinutes * 60000)
  const reservationRef = path(actor.restaurantId, 'reservations', reservationId)
  const tableRef = path(actor.restaurantId, 'tables', tableId)
  return runTransaction(db, async (transaction) => {
    const [existing, table] = await Promise.all([transaction.get(reservationRef), transaction.get(tableRef)])
    if (existing.exists()) return { reservationId, duplicate: true }
    if (!table.exists() || table.data().status !== 'available') fail('That table is not available for reservation.')
    if (covers > Number(table.data().capacity || 0)) fail('Guest count exceeds this table’s seating capacity.')
    const overlap = await getDocs(query(
      rows(actor.restaurantId, 'reservations'),
      where('tableId', '==', tableId),
      where('status', '==', 'booked'),
      where('startsAt', '<', endsAt),
      where('endsAt', '>', startsAt),
      limit(1),
    ))
    if (!overlap.empty) fail('That table already has a reservation during this time.')
    transaction.set(reservationRef, {
      restaurantId: actor.restaurantId,
      tableId,
      tableName: table.data().name,
      guestName,
      phone: typeof data.phone === 'string' ? data.phone.trim().slice(0, 40) : '',
      covers,
      startsAt,
      endsAt,
      status: 'booked',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    createAudit(transaction, actor, 'reservation.created', reservationId, { tableId })
    return { reservationId, duplicate: false }
  })
}

async function seatReservation(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  const reservationRef = path(actor.restaurantId, 'reservations', reservationId)
  return runTransaction(db, async (transaction) => {
    const reservation = await transaction.get(reservationRef)
    if (!reservation.exists()) fail('Reservation not found.')
    if (reservation.data().status === 'seated') return { reservationId, duplicate: true }
    if (reservation.data().status !== 'booked') fail('Only a booked reservation can be seated.')
    const tableRef = path(actor.restaurantId, 'tables', reservation.data().tableId)
    const table = await transaction.get(tableRef)
    if (!table.exists() || table.data().status !== 'available') fail('This table is currently in use.')
    if (reservation.data().startsAt.toMillis() > Date.now() + 15 * 60000) fail('Seat this reservation within 15 minutes of its start time.')
    transaction.update(reservationRef, { status: 'seated', seatedBy: actor.uid, seatedAt: serverTimestamp(), updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'reservation.seated', reservationId, { tableId: reservation.data().tableId })
    return { reservationId, tableId: reservation.data().tableId, duplicate: false }
  })
}

async function cancelReservation(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  if (typeof data.reason !== 'string' || !data.reason.trim()) fail('Enter a cancellation reason.')
  const reservationRef = path(actor.restaurantId, 'reservations', reservationId)
  return runTransaction(db, async (transaction) => {
    const reservation = await transaction.get(reservationRef)
    if (!reservation.exists()) fail('Reservation not found.')
    if (reservation.data().status !== 'booked') fail('Only a booked reservation can be cancelled.')
    const reason = data.reason.trim().slice(0, 240)
    transaction.update(reservationRef, { status: 'cancelled', cancellationReason: reason, cancelledBy: actor.uid, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'reservation.cancelled', reservationId, { reason })
    return { reservationId, status: 'cancelled' }
  })
}

async function mergeTables(data) {
  const actor = await actorFor()
  const targetTableId = safeId(data.targetTableId, 'Target table')
  const sourceTableId = safeId(data.sourceTableId, 'Table to combine')
  if (targetTableId === sourceTableId) fail('Choose two different tables.')
  const targetRef = path(actor.restaurantId, 'tables', targetTableId)
  const sourceRef = path(actor.restaurantId, 'tables', sourceTableId)
  return runTransaction(db, async (transaction) => {
    const [target, source] = await Promise.all([transaction.get(targetRef), transaction.get(sourceRef)])
    if (!target.exists() || !source.exists()) fail('One of the tables no longer exists.')
    if (target.data().status !== 'available' || source.data().status !== 'available') fail('Only two available tables can be combined.')
    if (target.data().mergedInto || source.data().mergedInto || target.data().mergedTableIds?.length || source.data().mergedTableIds?.length) fail('Unmerge the existing table group before changing it.')
    const now = new Date()
    const [targetBookings, sourceBookings] = await Promise.all([targetTableId, sourceTableId].map((tableId) => getDocs(query(
      rows(actor.restaurantId, 'reservations'),
      where('tableId', '==', tableId),
      where('status', '==', 'booked'),
      where('endsAt', '>', now),
      limit(1),
    ))))
    if (!targetBookings.empty || !sourceBookings.empty) fail('Tables with upcoming reservations cannot be combined.')
    const targetCapacity = Number(target.data().capacity || 0)
    const sourceCapacity = Number(source.data().capacity || 0)
    if (targetCapacity < 1 || sourceCapacity < 1 || targetCapacity + sourceCapacity > 100) fail('Combined table capacity must be between 2 and 100.')
    transaction.update(targetRef, {
      capacity: targetCapacity + sourceCapacity,
      unmergedCapacity: targetCapacity,
      mergedTableIds: [sourceTableId],
      mergedTableNames: [source.data().name],
      updatedAt: serverTimestamp(),
    })
    transaction.update(sourceRef, { status: 'merged', mergedInto: targetTableId, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'table.merged', targetTableId, { quantity: sourceCapacity })
    return { targetTableId, sourceTableId, capacity: targetCapacity + sourceCapacity }
  })
}

async function unmergeTables(data) {
  const actor = await actorFor()
  const targetTableId = safeId(data.targetTableId, 'Combined table')
  const targetRef = path(actor.restaurantId, 'tables', targetTableId)
  return runTransaction(db, async (transaction) => {
    const target = await transaction.get(targetRef)
    if (!target.exists()) fail('Combined table not found.')
    const sourceIds = target.data().mergedTableIds || []
    if (sourceIds.length !== 1) fail('This table does not have a supported merge group.')
    if (target.data().status !== 'available') fail('Finish the active order before unmerging tables.')
    const sourceRefs = sourceIds.map((id) => path(actor.restaurantId, 'tables', safeId(id, 'Merged table')))
    const sourceSnapshots = await Promise.all(sourceRefs.map((ref) => transaction.get(ref)))
    if (sourceSnapshots.some((source) => !source.exists() || source.data().status !== 'merged' || source.data().mergedInto !== targetTableId)) fail('A merged table has changed; refresh the floor and try again.')
    const bookings = await getDocs(query(
      rows(actor.restaurantId, 'reservations'),
      where('tableId', '==', targetTableId),
      where('status', '==', 'booked'),
      where('endsAt', '>', new Date()),
      limit(1),
    ))
    if (!bookings.empty) fail('Cancel or complete the table reservation before unmerging.')
    const capacity = Number(target.data().unmergedCapacity)
    if (!Number.isInteger(capacity) || capacity < 1) fail('Original table capacity is invalid.')
    transaction.update(targetRef, {
      capacity,
      unmergedCapacity: null,
      mergedTableIds: [],
      mergedTableNames: [],
      updatedAt: serverTimestamp(),
    })
    for (const sourceRef of sourceRefs) transaction.update(sourceRef, { status: 'available', mergedInto: null, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'table.unmerged', targetTableId)
    return { targetTableId, unmergedTableIds: sourceIds }
  })
}

async function transferOrderTable(data) {
  const actor = await actorFor(['owner', 'manager', 'waiter'])
  const orderId = safeId(data.orderId, 'Order')
  const targetTableId = safeId(data.targetTableId, 'Target table')
  const orderRef = path(actor.restaurantId, 'orders', orderId)
  return runTransaction(db, async (transaction) => {
    const order = await transaction.get(orderRef)
    if (!order.exists()) fail('Order not found.')
    const current = order.data()
    if (current.type !== 'dine-in' || !current.tableId) fail('Only a dine-in order can be moved to another table.')
    if (['served', 'cancelled'].includes(current.status)) fail('Completed or cancelled orders cannot be moved.')
    if (current.tableId === targetTableId) return { orderId, targetTableId, duplicate: true }
    const oldRef = path(actor.restaurantId, 'tables', current.tableId)
    const targetRef = path(actor.restaurantId, 'tables', targetTableId)
    const [oldTable, targetTable] = await Promise.all([transaction.get(oldRef), transaction.get(targetRef)])
    const now = new Date()
    const reservations = await getDocs(query(
      rows(actor.restaurantId, 'reservations'),
      where('tableId', '==', targetTableId),
      where('status', '==', 'booked'),
      where('startsAt', '<=', now),
      where('endsAt', '>', now),
      limit(1),
    ))
    if (!oldTable.exists() || oldTable.data().currentOrderId !== orderId) fail('The original table is no longer assigned to this order.')
    if (!targetTable.exists() || targetTable.data().status !== 'available' || !reservations.empty) fail('The target table is occupied or reserved right now.')
    const covers = (current.items || []).reduce((sum, item) => sum + item.quantity, 0)
    if (covers > Number(targetTable.data().capacity || 0)) fail('The target table does not have enough seats for this order.')
    transaction.update(oldRef, { status: 'available', currentOrderId: null, updatedAt: serverTimestamp() })
    transaction.update(targetRef, { status: 'occupied', currentOrderId: orderId, updatedAt: serverTimestamp() })
    transaction.update(orderRef, { tableId: targetTableId, tableName: targetTable.data().name, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'order.table_transferred', orderId, { reason: `${current.tableId} -> ${targetTableId}` })
    return { orderId, targetTableId, duplicate: false }
  })
}

async function createPurchase(data) {
  const actor = await actorFor()
  const purchaseId = safeId(data.purchaseId, 'Purchase')
  const supplierId = safeId(data.supplierId, 'Supplier')
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 30) fail('A purchase must contain 1 to 30 items.')
  const ingredientIds = data.items.map((line) => safeId(line.ingredientId, 'Stock item'))
  if (new Set(ingredientIds).size !== ingredientIds.length) fail('Combine duplicate stock items into one purchase line.')
  const purchaseRef = path(actor.restaurantId, 'purchases', purchaseId)
  const supplierRef = path(actor.restaurantId, 'suppliers', supplierId)
  const stockRefs = ingredientIds.map((id) => path(actor.restaurantId, 'inventory', id))
  return runTransaction(db, async (transaction) => {
    const [purchase, supplier, ...stocks] = await Promise.all([purchaseRef, supplierRef, ...stockRefs].map((ref) => transaction.get(ref)))
    if (purchase.exists()) return { purchaseId, duplicate: true }
    if (!supplier.exists()) fail('Supplier not found.')
    if (stocks.some((stock) => !stock.exists())) fail('One of the stock items could not be found.')
    const items = data.items.map((line, index) => {
      const quantity = Number(line.quantity)
      const unitCostCents = Number(line.unitCostCents)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000 || !Number.isSafeInteger(unitCostCents) || unitCostCents < 0 || unitCostCents > 100000000) fail('Purchase quantities and unit costs must be valid.')
      return { ingredientId: ingredientIds[index], itemName: stocks[index].data().name, quantity, unitCostCents }
    })
    const totalCents = Math.round(items.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0))
    if (!Number.isSafeInteger(totalCents) || totalCents > 1000000000) fail('Purchase total is outside the allowed range.')
    transaction.set(purchaseRef, {
      restaurantId: actor.restaurantId,
      supplierId,
      supplierName: supplier.data().name,
      items,
      totalCents,
      reference: typeof data.reference === 'string' ? data.reference.trim().slice(0, 100) : '',
      status: 'ordered',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    createAudit(transaction, actor, 'purchase.created', purchaseId, { amountCents: totalCents })
    return { purchaseId, totalCents, duplicate: false }
  })
}

async function receivePurchase(data) {
  const actor = await actorFor()
  const purchaseId = safeId(data.purchaseId, 'Purchase')
  const movementId = safeId(data.movementId, 'Movement')
  const purchaseRef = path(actor.restaurantId, 'purchases', purchaseId)
  const markerRef = path(actor.restaurantId, 'stockMovements', movementId)
  return runTransaction(db, async (transaction) => {
    const [purchase, marker] = await Promise.all([transaction.get(purchaseRef), transaction.get(markerRef)])
    if (purchase.exists() && purchase.data().status === 'received') return { purchaseId, duplicate: true }
    if (!purchase.exists()) fail('Purchase not found.')
    if (marker.exists()) fail('This receipt key was already used. Reload purchases and try again.')
    const items = purchase.data().items
    if (!Array.isArray(items) || !items.length || items.length > 30) fail('Purchase items are invalid.')
    const stockRefs = items.map((item) => path(actor.restaurantId, 'inventory', safeId(item.ingredientId, 'Stock item')))
    const stocks = await Promise.all(stockRefs.map((ref) => transaction.get(ref)))
    if (stocks.some((stock) => !stock.exists())) fail('A stock item could not be found.')
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const stock = stocks[index].data()
      const nextQuantity = Number(stock.quantityOnHand || 0) + Number(item.quantity)
      const averageCostCents = Math.round((Number(stock.quantityOnHand || 0) * Number(stock.averageCostCents || 0) + Number(item.quantity) * Number(item.unitCostCents || 0)) / nextQuantity)
      const stockMovementId = `${purchaseId}_${item.ingredientId}`
      transaction.update(stockRefs[index], { quantityOnHand: nextQuantity, averageCostCents, lastMovementId: stockMovementId, updatedAt: serverTimestamp() })
      transaction.set(path(actor.restaurantId, 'stockMovements', stockMovementId), {
        restaurantId: actor.restaurantId,
        ingredientId: item.ingredientId,
        itemName: item.itemName || stock.name,
        unit: stock.unit,
        movementType: 'purchase_received',
        quantity: Number(item.quantity),
        unitCostCents: Number(item.unitCostCents || 0),
        purchaseId,
        createdBy: actor.uid,
        createdAt: serverTimestamp(),
      })
    }
    transaction.update(purchaseRef, { status: 'received', receivedBy: actor.uid, receivedAt: serverTimestamp(), lastReceiptId: movementId, updatedAt: serverTimestamp() })
    transaction.set(markerRef, { restaurantId: actor.restaurantId, movementType: 'purchase_receipt', purchaseId, quantity: 0, createdBy: actor.uid, createdAt: serverTimestamp() })
    createAudit(transaction, actor, 'purchase.received', purchaseId)
    return { purchaseId, duplicate: false }
  })
}

async function createStaffInvite(data) {
  const actor = await actorFor(['owner'])
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : ''
  const role = data.role
  if (!email || email.length > 254 || !email.includes('@')) fail('Enter a valid team member email address.')
  if (!displayName || displayName.length > 100) fail('Enter a valid team member name.')
  if (!['manager', 'cashier', 'waiter'].includes(role)) fail('Choose a valid team role.')
  const invitationId = crypto.randomUUID()
  const invitationRef = path(actor.restaurantId, 'staffInvitations', invitationId)
  await runTransaction(db, async (transaction) => {
    transaction.set(invitationRef, {
      restaurantId: actor.restaurantId,
      email,
      displayName,
      role,
      active: true,
      status: 'open',
      createdBy: actor.uid,
      createdAt: serverTimestamp(),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    })
    createAudit(transaction, actor, 'staff.invitation_created', invitationId, { reason: role })
  })
  return { invitationId, inviteUrl: `${window.location.origin}/join/${actor.restaurantId}/${invitationId}` }
}

export async function getStaffInvitation(restaurantId, invitationId) {
  if (!db) fail('Firebase is not configured.')
  const invitation = await getDoc(path(restaurantId, 'staffInvitations', invitationId))
  if (!invitation.exists()) fail('This invitation link is invalid or has expired.')
  const data = invitation.data()
  if (!data.active || data.status !== 'open' || data.expiresAt?.toDate?.() <= new Date()) fail('This invitation link is no longer active.')
  return { ...data, id: invitation.id }
}

export async function completeStaffInvite(user, restaurantId, invitationId) {
  if (!db || !user?.uid) fail('Sign in to join the restaurant team.')
  const invitation = await getStaffInvitation(restaurantId, invitationId)
  const email = (user.email || '').trim().toLowerCase()
  if (!email || email !== invitation.email) fail(`Sign in with ${invitation.email} to accept this invitation.`)
  if (invitation.role === 'owner') fail('This invitation has an invalid role.')
  const memberRef = path(invitation.restaurantId, 'users', user.uid)
  const accountRef = doc(db, 'accountMemberships', user.uid)
  const invitationRef = path(invitation.restaurantId, 'staffInvitations', invitationId)
  const batch = writeBatch(db)
  const createdAt = serverTimestamp()
  batch.set(memberRef, {
    email,
    displayName: user.displayName || invitation.displayName,
    role: invitation.role,
    active: true,
    permissions: [],
    invitationId,
    createdAt,
    createdBy: invitation.createdBy,
  })
  batch.set(accountRef, {
    restaurantId: invitation.restaurantId,
    role: invitation.role,
    active: true,
    invitationId,
    createdAt,
  })
  batch.update(invitationRef, { status: 'claimed', claimedBy: user.uid, claimedAt: createdAt, updatedAt: createdAt })
  await batch.commit()
  return { restaurantId: invitation.restaurantId, role: invitation.role }
}

async function setStaffActive(data) {
  const actor = await actorFor(['owner'])
  const userId = safeId(data.userId, 'Team member')
  if (typeof data.active !== 'boolean') fail('Choose whether team access should be active.')
  const memberRef = path(actor.restaurantId, 'users', userId)
  return runTransaction(db, async (transaction) => {
    const member = await transaction.get(memberRef)
    if (!member.exists() || member.data().role === 'owner') fail('That team member cannot be changed here.')
    transaction.update(memberRef, { active: data.active, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, data.active ? 'staff.access_enabled' : 'staff.access_disabled', userId)
    return { userId, active: data.active }
  })
}

async function deleteStaffMember(data) {
  const actor = await actorFor(['owner'])
  const userId = safeId(data.userId, 'Team member')
  const memberRef = path(actor.restaurantId, 'users', userId)
  const accountRef = doc(db, 'accountMemberships', userId)
  return runTransaction(db, async (transaction) => {
    const member = await transaction.get(memberRef)
    if (!member.exists() || member.data().role === 'owner') fail('That team member cannot be removed here.')
    transaction.delete(memberRef)
    transaction.delete(accountRef)
    createAudit(transaction, actor, 'staff.member_deleted', userId)
    return { userId, deleted: true }
  })
}

async function setStaffPermissions(data) {
  const actor = await actorFor(['owner'])
  const userId = safeId(data.userId, 'Team member')
  if (!Array.isArray(data.permissions) || data.permissions.length > 3) fail('Choose valid team permissions.')
  const memberRef = path(actor.restaurantId, 'users', userId)
  return runTransaction(db, async (transaction) => {
    const member = await transaction.get(memberRef)
    if (!member.exists() || !['cashier', 'waiter'].includes(member.data().role)) fail('Permissions are only configurable for cashiers and waiters.')
    const available = member.data().role === 'cashier' ? ['discounts', 'refunds', 'voidOrders'] : ['discounts', 'voidOrders']
    if (new Set(data.permissions).size !== data.permissions.length || data.permissions.some((permission) => !available.includes(permission))) fail('One or more permissions are not valid for this team role.')
    transaction.update(memberRef, { permissions: data.permissions, updatedAt: serverTimestamp() })
    createAudit(transaction, actor, 'staff.permissions_updated', userId, { reason: data.permissions.join(',') })
    return { userId, permissions: data.permissions }
  })
}

async function exportReport(data) {
  const actor = await actorFor()
  const rangeName = ['day', 'week', 'month'].includes(data.range) ? data.range : 'week'
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (rangeName === 'week') start.setDate(start.getDate() - 6)
  if (rangeName === 'month') start.setDate(1)
  const startKey = localDayKey(start)
  const [financialSnapshot, expensesSnapshot, paymentsSnapshot] = await Promise.all([
    getDocs(query(rows(actor.restaurantId, 'orderFinancials'), where('createdAt', '>=', start), orderBy('createdAt', 'desc'), limit(1000))),
    getDocs(query(rows(actor.restaurantId, 'expenses'), where('date', '>=', startKey), orderBy('date'), limit(1000))),
    getDocs(query(rows(actor.restaurantId, 'payments'), where('createdAt', '>=', start), orderBy('createdAt', 'desc'), limit(2000))),
  ])
  const totalsByDay = new Map()
  const salesByItem = new Map()
  const salesByCategory = new Map()
  const expensesByCategory = new Map()
  const paymentsByMethod = new Map()
  let grossSalesCents = 0
  let refundsCents = 0
  let discountsCents = 0
  for (const snapshot of financialSnapshot.docs) {
    const financial = snapshot.data()
    if (financial.status !== 'active') continue
    const date = financial.createdAt?.toDate?.() || new Date(financial.createdAt)
    const key = localDayKey(date)
    const daily = totalsByDay.get(key) || { date: key, orderCount: 0, grossSalesCents: 0, taxCents: 0, refundsCents: 0 }
    daily.orderCount += 1
    daily.grossSalesCents += financial.subtotalCents || 0
    daily.taxCents += financial.taxCents || 0
    daily.refundsCents += financial.refundedCents || 0
    totalsByDay.set(key, daily)
    grossSalesCents += financial.subtotalCents || 0
    refundsCents += financial.refundedCents || 0
    discountsCents += financial.discountCents || 0
    for (const item of financial.items || []) {
      const id = item.itemId || item.name
      const row = salesByItem.get(id) || { item: item.name, quantity: 0, grossSalesCents: 0 }
      row.quantity += item.quantity
      row.grossSalesCents += item.unitPriceCents * item.quantity
      salesByItem.set(id, row)
      const categoryId = item.categoryId || item.categoryName || 'uncategorized'
      const category = salesByCategory.get(categoryId) || { category: item.categoryName || 'Uncategorized', quantity: 0, grossSalesCents: 0 }
      category.quantity += item.quantity
      category.grossSalesCents += item.unitPriceCents * item.quantity
      salesByCategory.set(categoryId, category)
    }
  }
  let expenseCents = 0
  for (const snapshot of expensesSnapshot.docs) {
    const expense = snapshot.data()
    if (expense.status !== 'approved') continue
    expenseCents += expense.amountCents || 0
    const category = expense.category || 'Uncategorized'
    expensesByCategory.set(category, (expensesByCategory.get(category) || 0) + (expense.amountCents || 0))
  }
  for (const snapshot of paymentsSnapshot.docs) {
    const payment = snapshot.data()
    if (payment.kind !== 'payment') continue
    const method = payment.method || 'other'
    paymentsByMethod.set(method, (paymentsByMethod.get(method) || 0) + (payment.amountCents || 0))
  }
  return {
    range: rangeName,
    summary: { grossSalesCents, refundsCents, discountsCents, expenseCents },
    rows: [...totalsByDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    itemRows: [...salesByItem.values()].sort((a, b) => b.grossSalesCents - a.grossSalesCents),
    categoryRows: [...salesByCategory.values()].sort((a, b) => b.grossSalesCents - a.grossSalesCents),
    paymentRows: [...paymentsByMethod.entries()].map(([method, amountCents]) => ({ method, amountCents })),
    expenseRows: [...expensesByCategory.entries()].map(([category, amountCents]) => ({ category, amountCents })),
  }
}

async function getCustomerHistory(data) {
  const actor = await actorFor(['owner', 'manager', 'cashier'])
  const customerId = safeId(data.customerId, 'Customer')
  const customerSnapshot = await getDoc(path(actor.restaurantId, 'customers', customerId))
  if (!customerSnapshot.exists()) fail('Customer not found.')
  const financials = await getDocs(query(
    rows(actor.restaurantId, 'orderFinancials'),
    where('customerId', '==', customerId),
    where('status', '==', 'active'),
    where('paymentStatus', 'in', ['paid', 'partially_refunded', 'refunded']),
    orderBy('createdAt', 'desc'),
    limit(50),
  ))
  const histories = await Promise.all(financials.docs.map(async (financialSnapshot) => {
    const order = await getDoc(path(actor.restaurantId, 'orders', financialSnapshot.id))
    if (!order.exists()) return null
    const financial = financialSnapshot.data()
    const orderData = order.data()
    return {
      orderId: order.id,
      orderNumber: orderData.orderNumber,
      createdAt: financial.createdAt,
      type: orderData.type,
      items: financial.items || [],
      subtotalCents: financial.subtotalCents,
      totalCents: financial.totalCents,
      refundedCents: financial.refundedCents || 0,
      paymentStatus: financial.paymentStatus,
    }
  }))
  return { customer: { ...customerSnapshot.data(), id: customerId }, rows: histories.filter(Boolean) }
}

export async function runSparkOperation(name, payload = {}) {
  switch (name) {
    case 'createOrder': return createOrder(payload)
    case 'saveOrderDraft': return saveOrderDraft(payload)
    case 'deleteOrderDraft': return deleteOrderDraft(payload)
    case 'transitionOrder': return transitionOrder(payload)
    case 'recordPayment': return recordPayment(payload)
    case 'recordRefund': return recordRefund(payload)
    case 'adjustInventory': return adjustInventory(payload)
    case 'recordExpense': return recordExpense(payload)
    case 'createReservation': return createReservation(payload)
    case 'seatReservation': return seatReservation(payload)
    case 'cancelReservation': return cancelReservation(payload)
    case 'mergeTables': return mergeTables(payload)
    case 'unmergeTables': return unmergeTables(payload)
    case 'transferOrderTable': return transferOrderTable(payload)
    case 'createPurchase': return createPurchase(payload)
    case 'receivePurchase': return receivePurchase(payload)
    case 'inviteStaff': return createStaffInvite(payload)
    case 'setStaffActive': return setStaffActive(payload)
    case 'deleteStaffMember': return deleteStaffMember(payload)
    case 'setStaffPermissions': return setStaffPermissions(payload)
    case 'exportReport': return exportReport(payload)
    case 'getCustomerHistory': return getCustomerHistory(payload)
    default:
      fail(`${name} needs a trusted server action. It isn't enabled on the free Spark plan yet.`)
  }
}
