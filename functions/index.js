import { randomBytes } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { applyPayment, applyRefund, calculateRecipeNeeds, priceMenuLine } from './domain.js'

initializeApp()
const db = getFirestore()
const auth = getAuth()
const timestamp = () => FieldValue.serverTimestamp()
const roles = new Set(['owner', 'manager', 'cashier', 'waiter'])
const canCreateOrders = ['owner', 'manager', 'cashier', 'waiter']
const canReadFinance = ['owner', 'manager', 'cashier']
const options = { region: 'us-central1', enforceAppCheck: process.env.ENFORCE_APP_CHECK === 'true' }

function fail(code, message) {
  throw new HttpsError(code, message)
}

function requiredString(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid-argument', `${name} is required.`)
  return value.trim()
}

function safeId(value, name) {
  const id = requiredString(value, name, 80)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('invalid-argument', `${name} is invalid.`)
  return id
}

function validCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) fail('invalid-argument', `${name} must be a positive amount.`)
  return value
}

function auditRef(restaurantId) {
  return db.collection('restaurants').doc(restaurantId).collection('auditLogs').doc()
}

async function actorFor(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to continue.')
  const restaurantId = request.auth.token.restaurantId
  const tokenRole = request.auth.token.role
  if (typeof restaurantId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(restaurantId) || !roles.has(tokenRole)) {
    fail('permission-denied', 'This account has not been assigned to a restaurant.')
  }
  const memberRef = db.doc(`restaurants/${restaurantId}/users/${request.auth.uid}`)
  const member = await memberRef.get()
  if (!member.exists || member.get('active') !== true || member.get('role') !== tokenRole) {
    fail('permission-denied', 'Your restaurant access is inactive. Contact an owner.')
  }
  return { uid: request.auth.uid, restaurantId, role: tokenRole, member: member.data(), memberRef }
}

function requireRole(actor, allowed) {
  if (!allowed.includes(actor.role)) fail('permission-denied', 'You do not have permission to do that.')
}

function mayUsePermission(actor, permission) {
  return actor.role === 'owner' || actor.role === 'manager' || actor.member.permissions?.includes(permission)
}

async function withActor(request, handler) {
  try {
    const actor = await actorFor(request)
    return await handler(actor, request.data || {})
  } catch (error) {
    if (error instanceof HttpsError) throw error
    console.error('RestaurantOS operation failed', error)
    fail('internal', 'The operation could not be completed. Please try again.')
  }
}

function restaurantDoc(restaurantId) {
  return db.doc(`restaurants/${restaurantId}`)
}

function subcollection(restaurantId, name) {
  return db.collection(`restaurants/${restaurantId}/${name}`)
}

function getDayStart(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function getRangeStart(range) {
  const now = new Date()
  if (range === 'day') return getDayStart(now)
  if (range === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
  if (range === 'week') return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
  fail('invalid-argument', 'Choose day, week, or month.')
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export const createOrder = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, canCreateOrders)
  const requestId = safeId(data.requestId, 'Request ID')
  const type = ['dine-in', 'takeaway', 'delivery', 'direct-bill'].includes(data.type) ? data.type : fail('invalid-argument', 'Choose dine-in, takeaway, delivery, or direct bill.')
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 40) fail('invalid-argument', 'An order must contain 1 to 40 menu lines.')
  const orderRef = subcollection(actor.restaurantId, 'orders').doc(requestId)
  const financeRef = subcollection(actor.restaurantId, 'orderFinancials').doc(requestId)
  const orderDay = localDayKey(new Date())
  const counterRef = subcollection(actor.restaurantId, 'counters').doc(orderDay)
  const tableId = type === 'dine-in' ? safeId(data.tableId, 'Table') : null
  const itemIds = [...new Set(data.items.map((item) => safeId(item.itemId, 'Menu item')))]
  const quantities = new Map()
  for (const line of data.items) {
    const itemId = safeId(line.itemId, 'Menu item')
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail('invalid-argument', 'Item quantity must be between 1 and 99.')
    quantities.set(itemId, (quantities.get(itemId) || 0) + line.quantity)
  }
  const settingRef = subcollection(actor.restaurantId, 'settings').doc('profile')
  const tableRef = tableId ? subcollection(actor.restaurantId, 'tables').doc(tableId) : null
  const activeTableReservations = tableRef
    ? subcollection(actor.restaurantId, 'reservations')
      .where('tableId', '==', tableId)
      .where('status', '==', 'booked')
      .where('startsAt', '<=', Timestamp.fromDate(new Date()))
      .where('endsAt', '>', Timestamp.fromDate(new Date()))
    : null
  const menuRefs = itemIds.map((id) => subcollection(actor.restaurantId, 'menuItems').doc(id))
  const customerId = data.customerId ? safeId(data.customerId, 'Customer') : null
  const customerRef = customerId ? subcollection(actor.restaurantId, 'customers').doc(customerId) : null

  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(orderRef)
    if (existing.exists) return { orderId: requestId, orderNumber: existing.get('orderNumber'), duplicate: true }
    const refs = [counterRef, settingRef]
    if (tableRef) refs.push(tableRef)
    if (customerRef) refs.push(customerRef)
    refs.push(...menuRefs)
    const snapshots = await transaction.getAll(...refs)
    const activeReservationSnapshots = activeTableReservations ? await transaction.get(activeTableReservations) : null
    let offset = 0
    const counterSnapshot = snapshots[offset++]
    const actualSettings = snapshots[offset++]
    const actualTable = tableRef ? snapshots[offset++] : null
    const actualCustomer = customerRef ? snapshots[offset++] : null
    const loadedMenus = snapshots.slice(offset)

    if (!actualSettings.exists) fail('failed-precondition', 'Restaurant settings have not been configured.')
    if (tableRef && (!actualTable?.exists || actualTable.get('status') !== 'available' || !activeReservationSnapshots.empty)) fail('failed-precondition', 'That table is occupied or reserved right now. Choose another table.')
    if (customerRef && !actualCustomer?.exists) fail('not-found', 'That customer record could not be found.')
    const settings = actualSettings.data()
    const menuById = new Map()
    for (let index = 0; index < menuRefs.length; index += 1) {
      const snapshot = loadedMenus[index]
      if (!snapshot?.exists || snapshot.get('available') === false) fail('failed-precondition', 'One or more items are no longer available.')
      const item = snapshot.data()
      menuById.set(itemIds[index], item)
    }
    const lines = data.items.map((line) => {
      const menuItem = menuById.get(line.itemId)
      try {
        return priceMenuLine(menuItem, line)
      } catch (error) {
        fail('failed-precondition', error.message)
      }
    })
    let recipeNeeds
    try {
      recipeNeeds = calculateRecipeNeeds(data.items, menuById)
    } catch (error) {
      fail('failed-precondition', error.message)
    }
    const stockRefs = [...recipeNeeds.keys()].map((id) => subcollection(actor.restaurantId, 'inventory').doc(id))
    const stockSnapshots = stockRefs.length ? await transaction.getAll(...stockRefs) : []
    const stockById = new Map([...recipeNeeds.keys()].map((id, index) => [id, stockSnapshots[index]]))
    for (const [ingredientId, quantity] of recipeNeeds) {
      const stock = stockById.get(ingredientId)
      if (!stock?.exists) fail('failed-precondition', 'An item recipe references stock that no longer exists.')
      if (Number(stock.get('quantityOnHand') || 0) < quantity) fail('failed-precondition', `Not enough ${stock.get('name')} in stock to send this order.`)
    }
        const subtotalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
        const discountCents = Number(data.discountCents || 0)
        if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > subtotalCents) fail('invalid-argument', 'Discount must be between zero and the order subtotal.')
        if (discountCents > 0 && !mayUsePermission(actor, 'discounts')) fail('permission-denied', 'Discounts require explicit permission.')
    const taxRate = Number(settings.taxRate || 0)
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) fail('failed-precondition', 'Restaurant tax settings are invalid.')
        const taxCents = Math.round((subtotalCents - discountCents) * taxRate)
    const tableName = actualTable?.get('name') || ''
    const sequence = (counterSnapshot.get('value') || 0) + 1
    const orderNumber = `R-${orderDay.replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`
    const createdAt = timestamp()
    const serviceLines = lines.map(({ itemId, name, quantity, note, selectedVariant, selectedAddOns }) => ({ itemId, name, quantity, note, selectedVariant, selectedAddOns: selectedAddOns.map(({ id, name: addOnName }) => ({ id, name: addOnName })) }))
    const order = {
      restaurantId: actor.restaurantId,
      orderNumber,
      type,
      tableId,
      tableName,
      note: typeof data.note === 'string' ? data.note.trim().slice(0, 500) : '',
      items: serviceLines,
      status: 'queued',
      createdBy: actor.uid,
      createdAt,
      updatedAt: createdAt,
    }
    transaction.create(orderRef, order)
    transaction.set(counterRef, { value: sequence, updatedAt: timestamp() }, { merge: true })
    transaction.create(financeRef, {
      restaurantId: actor.restaurantId,
      orderId: orderRef.id,
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
      const stock = stockById.get(ingredientId)
      const stockRef = subcollection(actor.restaurantId, 'inventory').doc(ingredientId)
      const movementId = `${requestId}_${ingredientId}`
      const movementRef = subcollection(actor.restaurantId, 'stockMovements').doc(movementId)
      transaction.update(stockRef, { quantityOnHand: Number(stock.get('quantityOnHand') || 0) - quantity, lastMovementId: movementId, updatedAt: timestamp() })
      transaction.create(movementRef, { restaurantId: actor.restaurantId, ingredientId, itemName: stock.get('name'), unit: stock.get('unit'), movementType: 'order_consumption', quantity: -quantity, reason: 'Order placed', orderId: orderRef.id, createdBy: actor.uid, createdAt })
    }
    if (tableRef) transaction.update(tableRef, { status: 'occupied', currentOrderId: orderRef.id, updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'order.created', entityId: orderRef.id, actorId: actor.uid, createdAt })
    return { orderId: orderRef.id, orderNumber, duplicate: false }
  })
}))

export const saveOrderDraft = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, canCreateOrders)
  const draftId = safeId(data.draftId, 'Draft')
  const type = ['dine-in', 'takeaway', 'delivery', 'direct-bill'].includes(data.type) ? data.type : fail('invalid-argument', 'Choose dine-in, takeaway, delivery, or direct bill.')
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 40) fail('invalid-argument', 'A draft must contain 1 to 40 menu lines.')
  const items = data.items.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail('invalid-argument', 'Item quantity must be between 1 and 99.')
    return {
      itemId: safeId(line.itemId, 'Menu item'),
      quantity: line.quantity,
      note: typeof line.note === 'string' ? line.note.trim().slice(0, 300) : '',
      selectedVariantId: line.selectedVariantId ? safeId(line.selectedVariantId, 'Variant') : null,
      selectedAddOnIds: line.selectedAddOnIds || [],
    }
  })
  const discountCents = Number(data.discountCents || 0)
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) fail('invalid-argument', 'Discount must be a non-negative amount.')
  if (discountCents > 0 && !mayUsePermission(actor, 'discounts')) fail('permission-denied', 'Discounts require explicit permission.')
  const tableId = type === 'dine-in' && data.tableId ? safeId(data.tableId, 'Table') : null
  const customerId = data.customerId ? safeId(data.customerId, 'Customer') : null
  if (customerId && !canReadFinance.includes(actor.role)) fail('permission-denied', 'You cannot attach a customer record to this draft.')
  const draftRef = subcollection(actor.restaurantId, 'draftOrders').doc(draftId)
  const menuIds = [...new Set(items.map((line) => line.itemId))]
  const menuRefs = menuIds.map((id) => subcollection(actor.restaurantId, 'menuItems').doc(id))
  const tableRef = tableId ? subcollection(actor.restaurantId, 'tables').doc(tableId) : null
  const customerRef = customerId ? subcollection(actor.restaurantId, 'customers').doc(customerId) : null
  return db.runTransaction(async (transaction) => {
    const refs = [draftRef, ...(tableRef ? [tableRef] : []), ...(customerRef ? [customerRef] : []), ...menuRefs]
    const snapshots = await transaction.getAll(...refs)
    const draftSnapshot = snapshots[0]
    if (draftSnapshot.exists && draftSnapshot.get('createdBy') !== actor.uid && !['owner', 'manager'].includes(actor.role)) {
      fail('permission-denied', 'This draft belongs to another team member.')
    }
    let offset = 1
    const tableSnapshot = tableRef ? snapshots[offset++] : null
    const customerSnapshot = customerRef ? snapshots[offset++] : null
    const menuSnapshots = snapshots.slice(offset)
    if (tableRef && (!tableSnapshot.exists || tableSnapshot.get('status') === 'occupied')) fail('failed-precondition', 'That table is not available.')
    if (customerRef && !customerSnapshot.exists) fail('not-found', 'Customer not found.')
    const menuById = new Map(menuIds.map((id, index) => [id, menuSnapshots[index]]))
    let subtotalCents = 0
    for (const line of items) {
      const menuSnapshot = menuById.get(line.itemId)
      if (!menuSnapshot?.exists || menuSnapshot.get('available') === false) fail('failed-precondition', 'One or more items are no longer available.')
      let priced
      try {
        priced = priceMenuLine(menuSnapshot.data(), line)
      } catch (error) {
        fail('failed-precondition', error.message)
      }
      subtotalCents += priced.unitPriceCents * line.quantity
    }
    if (discountCents > subtotalCents) fail('invalid-argument', 'Discount cannot exceed the draft subtotal.')
    const now = timestamp()
    transaction.set(draftRef, {
      restaurantId: actor.restaurantId,
      createdBy: draftSnapshot.exists ? draftSnapshot.get('createdBy') : actor.uid,
      status: 'draft',
      type,
      tableId,
      customerId,
      note: typeof data.note === 'string' ? data.note.trim().slice(0, 500) : '',
      items,
      discountCents,
      updatedAt: now,
      ...(draftSnapshot.exists ? {} : { createdAt: now }),
    })
    return { draftId, duplicate: false }
  })
}))

export const deleteOrderDraft = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, canCreateOrders)
  const draftId = safeId(data.draftId, 'Draft')
  const draftRef = subcollection(actor.restaurantId, 'draftOrders').doc(draftId)
  await db.runTransaction(async (transaction) => {
    const draft = await transaction.get(draftRef)
    if (!draft.exists) return
    if (draft.get('createdBy') !== actor.uid && !['owner', 'manager'].includes(actor.role)) fail('permission-denied', 'This draft belongs to another team member.')
    transaction.delete(draftRef)
  })
  return { draftId, deleted: true }
}))

export const createReservation = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  const tableId = safeId(data.tableId, 'Table')
  const guestName = requiredString(data.guestName, 'Guest name', 120)
  const phone = typeof data.phone === 'string' ? data.phone.trim().slice(0, 40) : ''
  const covers = Number(data.covers)
  const durationMinutes = Number(data.durationMinutes)
  const startsAtMillis = Number(data.startsAtMillis)
  if (!Number.isInteger(covers) || covers < 1 || covers > 40) fail('invalid-argument', 'Guest count must be between 1 and 40.')
  if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 360) fail('invalid-argument', 'Reservation length must be between 30 minutes and 6 hours.')
  if (!Number.isSafeInteger(startsAtMillis)) fail('invalid-argument', 'Choose a valid reservation time.')
  const startsAt = new Date(startsAtMillis)
  const now = Date.now()
  if (startsAtMillis < now - 60 * 60 * 1000 || startsAtMillis > now + 365 * 24 * 60 * 60 * 1000) fail('invalid-argument', 'Reservation time must be within the next 12 months.')
  const endsAt = new Date(startsAtMillis + durationMinutes * 60 * 1000)
  const reservationRef = subcollection(actor.restaurantId, 'reservations').doc(reservationId)
  const tableRef = subcollection(actor.restaurantId, 'tables').doc(tableId)
  const overlappingReservations = subcollection(actor.restaurantId, 'reservations')
    .where('tableId', '==', tableId)
    .where('status', '==', 'booked')
    .where('startsAt', '<', Timestamp.fromDate(endsAt))
    .where('endsAt', '>', Timestamp.fromDate(startsAt))
  return db.runTransaction(async (transaction) => {
    const [reservationSnap, tableSnap] = await transaction.getAll(reservationRef, tableRef)
    const overlaps = await transaction.get(overlappingReservations)
    if (reservationSnap.exists) return { reservationId, duplicate: true }
    if (!tableSnap.exists || tableSnap.get('status') !== 'available') fail('failed-precondition', 'That table is not available for reservation.')
    if (covers > Number(tableSnap.get('capacity') || 0)) fail('failed-precondition', 'Guest count exceeds this table’s seating capacity.')
    if (!overlaps.empty) fail('already-exists', 'That table already has a reservation during this time.')
    transaction.create(reservationRef, {
      restaurantId: actor.restaurantId,
      tableId,
      tableName: tableSnap.get('name'),
      guestName,
      phone,
      covers,
      startsAt: Timestamp.fromDate(startsAt),
      endsAt: Timestamp.fromDate(endsAt),
      status: 'booked',
      createdBy: actor.uid,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    })
    transaction.create(auditRef(actor.restaurantId), { action: 'reservation.created', entityId: reservationId, actorId: actor.uid, tableId, startsAt: Timestamp.fromDate(startsAt), createdAt: timestamp() })
    return { reservationId, duplicate: false }
  })
}))

export const seatReservation = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  const reservationRef = subcollection(actor.restaurantId, 'reservations').doc(reservationId)
  return db.runTransaction(async (transaction) => {
    const reservationSnap = await transaction.get(reservationRef)
    if (!reservationSnap.exists) fail('not-found', 'Reservation not found.')
    const reservation = reservationSnap.data()
    if (reservation.status === 'seated') return { reservationId, duplicate: true }
    if (reservation.status !== 'booked') fail('failed-precondition', 'Only a booked reservation can be seated.')
    const tableRef = subcollection(actor.restaurantId, 'tables').doc(reservation.tableId)
    const tableSnap = await transaction.get(tableRef)
    if (!tableSnap.exists || tableSnap.get('status') !== 'available') fail('failed-precondition', 'This table is currently in use.')
    if (reservation.startsAt.toMillis() > Date.now() + 15 * 60 * 1000) fail('failed-precondition', 'Seat this reservation within 15 minutes of its start time.')
    transaction.update(reservationRef, { status: 'seated', seatedBy: actor.uid, seatedAt: timestamp(), updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'reservation.seated', entityId: reservationId, actorId: actor.uid, tableId: reservation.tableId, createdAt: timestamp() })
    return { reservationId, tableId: reservation.tableId, duplicate: false }
  })
}))

export const cancelReservation = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager', 'cashier', 'waiter'])
  const reservationId = safeId(data.reservationId, 'Reservation')
  const reason = requiredString(data.reason, 'Cancellation reason', 240)
  const reservationRef = subcollection(actor.restaurantId, 'reservations').doc(reservationId)
  await db.runTransaction(async (transaction) => {
    const reservationSnap = await transaction.get(reservationRef)
    if (!reservationSnap.exists) fail('not-found', 'Reservation not found.')
    if (reservationSnap.get('status') !== 'booked') fail('failed-precondition', 'Only a booked reservation can be cancelled.')
    transaction.update(reservationRef, { status: 'cancelled', cancellationReason: reason, cancelledBy: actor.uid, updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'reservation.cancelled', entityId: reservationId, actorId: actor.uid, reason, createdAt: timestamp() })
  })
  return { reservationId, status: 'cancelled' }
}))

export const mergeTables = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const targetTableId = safeId(data.targetTableId, 'Target table')
  const sourceTableId = safeId(data.sourceTableId, 'Table to combine')
  if (targetTableId === sourceTableId) fail('invalid-argument', 'Choose two different tables.')
  const targetRef = subcollection(actor.restaurantId, 'tables').doc(targetTableId)
  const sourceRef = subcollection(actor.restaurantId, 'tables').doc(sourceTableId)
  return db.runTransaction(async (transaction) => {
    const [targetSnap, sourceSnap] = await transaction.getAll(targetRef, sourceRef)
    if (!targetSnap.exists || !sourceSnap.exists) fail('not-found', 'One of the tables no longer exists.')
    if (targetSnap.get('status') !== 'available' || sourceSnap.get('status') !== 'available') fail('failed-precondition', 'Only two available tables can be combined.')
    if (targetSnap.get('mergedInto') || sourceSnap.get('mergedInto') || targetSnap.get('mergedTableIds')?.length || sourceSnap.get('mergedTableIds')?.length) fail('failed-precondition', 'Unmerge the existing table group before changing it.')
    const now = Timestamp.now()
    const targetBookings = await transaction.get(subcollection(actor.restaurantId, 'reservations')
      .where('tableId', '==', targetTableId).where('status', '==', 'booked').where('endsAt', '>', now))
    const sourceBookings = await transaction.get(subcollection(actor.restaurantId, 'reservations')
      .where('tableId', '==', sourceTableId).where('status', '==', 'booked').where('endsAt', '>', now))
    if (!targetBookings.empty || !sourceBookings.empty) fail('failed-precondition', 'Tables with upcoming reservations cannot be combined.')
    const targetCapacity = Number(targetSnap.get('capacity') || 0)
    const sourceCapacity = Number(sourceSnap.get('capacity') || 0)
    if (targetCapacity < 1 || sourceCapacity < 1 || targetCapacity + sourceCapacity > 100) fail('failed-precondition', 'Combined table capacity must be between 2 and 100.')
    const sourceName = sourceSnap.get('name')
    transaction.update(targetRef, {
      capacity: targetCapacity + sourceCapacity,
      unmergedCapacity: targetCapacity,
      mergedTableIds: [sourceTableId],
      mergedTableNames: [sourceName],
      updatedAt: timestamp(),
    })
    transaction.update(sourceRef, { status: 'merged', mergedInto: targetTableId, updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'table.merged', entityId: targetTableId, actorId: actor.uid, sourceTableId, sourceTableName: sourceName, createdAt: timestamp() })
    return { targetTableId, sourceTableId, capacity: targetCapacity + sourceCapacity }
  })
}))

export const unmergeTables = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const targetTableId = safeId(data.targetTableId, 'Combined table')
  const targetRef = subcollection(actor.restaurantId, 'tables').doc(targetTableId)
  return db.runTransaction(async (transaction) => {
    const targetSnap = await transaction.get(targetRef)
    if (!targetSnap.exists) fail('not-found', 'Combined table not found.')
    const sourceIds = targetSnap.get('mergedTableIds') || []
    if (!sourceIds.length || sourceIds.length > 1) fail('failed-precondition', 'This table does not have a supported merge group.')
    if (targetSnap.get('status') !== 'available') fail('failed-precondition', 'Finish the active order before unmerging tables.')
    const sourceRefs = sourceIds.map((id) => subcollection(actor.restaurantId, 'tables').doc(safeId(id, 'Merged table')))
    const sourceSnaps = await transaction.getAll(...sourceRefs)
    for (let index = 0; index < sourceSnaps.length; index += 1) {
      if (!sourceSnaps[index].exists || sourceSnaps[index].get('status') !== 'merged' || sourceSnaps[index].get('mergedInto') !== targetTableId) fail('failed-precondition', 'A merged table has changed; refresh the floor and try again.')
    }
    const activeBookings = await transaction.get(subcollection(actor.restaurantId, 'reservations')
      .where('tableId', '==', targetTableId).where('status', '==', 'booked').where('endsAt', '>', Timestamp.now()))
    if (!activeBookings.empty) fail('failed-precondition', 'Cancel or complete the table reservation before unmerging.')
    const originalCapacity = Number(targetSnap.get('unmergedCapacity'))
    if (!Number.isInteger(originalCapacity) || originalCapacity < 1) fail('failed-precondition', 'Original table capacity is invalid.')
    transaction.update(targetRef, {
      capacity: originalCapacity,
      unmergedCapacity: FieldValue.delete(),
      mergedTableIds: FieldValue.delete(),
      mergedTableNames: FieldValue.delete(),
      updatedAt: timestamp(),
    })
    for (let index = 0; index < sourceRefs.length; index += 1) transaction.update(sourceRefs[index], {
      status: 'available', mergedInto: FieldValue.delete(), updatedAt: timestamp(),
    })
    transaction.create(auditRef(actor.restaurantId), { action: 'table.unmerged', entityId: targetTableId, actorId: actor.uid, sourceTableIds: sourceIds, createdAt: timestamp() })
    return { targetTableId, unmergedTableIds: sourceIds }
  })
}))

export const recordPayment = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, canReadFinance)
  const orderId = safeId(data.orderId, 'Order')
  const paymentId = safeId(data.paymentId, 'Payment')
  const amountCents = validCents(data.amountCents, 'Payment amount')
  const method = ['cash', 'card', 'digital'].includes(data.method) ? data.method : fail('invalid-argument', 'Choose cash, card, or digital payment.')
  const orderRef = subcollection(actor.restaurantId, 'orders').doc(orderId)
  const financeRef = subcollection(actor.restaurantId, 'orderFinancials').doc(orderId)
  const paymentRef = subcollection(actor.restaurantId, 'payments').doc(paymentId)
  const settingRef = subcollection(actor.restaurantId, 'settings').doc('profile')
  return db.runTransaction(async (transaction) => {
    const [orderSnap, financeSnap, paymentSnap, settingsSnap] = await transaction.getAll(orderRef, financeRef, paymentRef, settingRef)
    if (paymentSnap.exists) return { paymentId, duplicate: true }
    if (!orderSnap.exists || !financeSnap.exists) fail('not-found', 'Order not found.')
    const order = orderSnap.data()
    const financial = financeSnap.data()
    if (order.status === 'cancelled') fail('failed-precondition', 'Cancelled orders cannot accept payment.')
    const allowedMethods = settingsSnap.exists ? settingsSnap.get('paymentMethods') || ['cash', 'card', 'digital'] : ['cash']
    if (!allowedMethods.includes(method)) fail('failed-precondition', 'That payment method is not enabled for this restaurant.')
    let payment
    try {
      payment = applyPayment(financial, amountCents)
    } catch (error) {
      fail('failed-precondition', error.message)
    }
    const { paidCents, paymentStatus, customerVisitCounted } = payment
    const customerRef = financial.customerId ? subcollection(actor.restaurantId, 'customers').doc(financial.customerId) : null
    const customerSnap = customerRef ? await transaction.get(customerRef) : null
    const countVisit = Boolean(customerRef && customerVisitCounted)
    if (countVisit && !customerSnap?.exists) fail('failed-precondition', 'Customer record is no longer available.')
    transaction.create(paymentRef, {
      restaurantId: actor.restaurantId,
      orderId,
      amountCents,
      method,
      reference: typeof data.reference === 'string' ? data.reference.trim().slice(0, 100) : '',
      kind: 'payment',
      recordedBy: actor.uid,
      createdAt: timestamp(),
    })
    transaction.update(financeRef, { paidCents, paymentStatus, lastPaymentId: paymentId, updatedAt: timestamp(), ...(countVisit ? { customerVisitCounted: true } : {}) })
    if (countVisit) transaction.update(customerRef, {
      visitCount: FieldValue.increment(1),
      totalSpendingCents: FieldValue.increment(financial.totalCents),
      lastVisitAt: timestamp(),
      lastFinancialId: orderId,
      updatedAt: timestamp(),
    })
    if (order.status === 'served' && paymentStatus === 'paid' && order.tableId) {
      transaction.update(subcollection(actor.restaurantId, 'tables').doc(order.tableId), { status: 'available', currentOrderId: null, updatedAt: timestamp() })
    }
    transaction.create(auditRef(actor.restaurantId), { action: 'payment.recorded', entityId: orderId, actorId: actor.uid, amountCents, createdAt: timestamp() })
    return { paymentId, paymentStatus, paidCents, duplicate: false }
  })
}))

export const recordRefund = onCall(options, (request) => withActor(request, async (actor, data) => {
  if (!['owner', 'manager', 'cashier'].includes(actor.role) && !mayUsePermission(actor, 'refunds')) fail('permission-denied', 'Refunds require explicit permission.')
  const orderId = safeId(data.orderId, 'Order')
  const refundId = safeId(data.refundId, 'Refund')
  const amountCents = validCents(data.amountCents, 'Refund amount')
  const reason = requiredString(data.reason, 'Reason', 300)
  const orderRef = subcollection(actor.restaurantId, 'orders').doc(orderId)
  const financeRef = subcollection(actor.restaurantId, 'orderFinancials').doc(orderId)
  const paymentRef = subcollection(actor.restaurantId, 'payments').doc(refundId)
  return db.runTransaction(async (transaction) => {
    const [orderSnap, financeSnap, refundSnap] = await transaction.getAll(orderRef, financeRef, paymentRef)
    if (refundSnap.exists) return { refundId, duplicate: true }
    if (!orderSnap.exists || !financeSnap.exists) fail('not-found', 'Order not found.')
    const financial = financeSnap.data()
    let refund
    try {
      refund = applyRefund(financial, amountCents)
    } catch (error) {
      fail('failed-precondition', error.message)
    }
    const { refundedCents, fullyRefunded, paymentStatus } = refund
    const customerRef = financial.customerId ? subcollection(actor.restaurantId, 'customers').doc(financial.customerId) : null
    const customerSnap = customerRef ? await transaction.get(customerRef) : null
    transaction.create(paymentRef, { restaurantId: actor.restaurantId, orderId, amountCents, method: 'adjustment', kind: 'refund', reason, recordedBy: actor.uid, createdAt: timestamp() })
    transaction.update(financeRef, { refundedCents, paymentStatus, lastPaymentId: refundId, updatedAt: timestamp(), ...(fullyRefunded && financial.customerVisitCounted ? { customerVisitCounted: false } : {}) })
    if (customerRef && customerSnap?.exists && financial.customerVisitCounted) transaction.update(customerRef, {
      totalSpendingCents: FieldValue.increment(-amountCents),
      ...(fullyRefunded ? { visitCount: FieldValue.increment(-1) } : {}),
      lastFinancialId: orderId,
      updatedAt: timestamp(),
    })
    transaction.create(auditRef(actor.restaurantId), { action: 'payment.refunded', entityId: orderId, actorId: actor.uid, amountCents, reason, createdAt: timestamp() })
    return { refundId, refundedCents, duplicate: false }
  })
}))

export const transitionOrder = onCall(options, (request) => withActor(request, async (actor, data) => {
  const orderId = safeId(data.orderId, 'Order')
  const to = requiredString(data.to, 'Order status', 30)
  const requestId = safeId(data.requestId, 'Request ID')
  const orderRef = subcollection(actor.restaurantId, 'orders').doc(orderId)
  const financeRef = subcollection(actor.restaurantId, 'orderFinancials').doc(orderId)
  const requestRef = subcollection(actor.restaurantId, 'operationKeys').doc(`transition_${requestId}`)
  return db.runTransaction(async (transaction) => {
    const [orderSnap, financeSnap, requestSnap] = await transaction.getAll(orderRef, financeRef, requestRef)
    if (requestSnap.exists) return { orderId, duplicate: true }
    if (!orderSnap.exists || !financeSnap.exists) fail('not-found', 'Order not found.')
    const order = orderSnap.data()
    const financial = financeSnap.data()
    const transitions = { queued: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served'] }
    if (!transitions[order.status]?.includes(to)) fail('failed-precondition', `An order cannot move from ${order.status} to ${to}.`)
    if (to === 'cancelled') {
      if (!mayUsePermission(actor, 'voidOrders')) fail('permission-denied', 'Cancelling an order requires explicit permission.')
      requiredString(data.reason, 'Cancellation reason', 300)
      if ((financial.paidCents || 0) > 0) fail('failed-precondition', 'Record a refund before cancelling a paid order.')
      transaction.update(financeRef, { status: 'cancelled', updatedAt: timestamp() })
    }
    const nextStatus = to
    transaction.update(orderRef, { status: nextStatus, updatedAt: timestamp(), ...(to === 'cancelled' ? { cancellationReason: data.reason.trim().slice(0, 300), cancelledBy: actor.uid } : {}) })
    if (to === 'cancelled' && order.tableId) transaction.update(subcollection(actor.restaurantId, 'tables').doc(order.tableId), { status: 'available', currentOrderId: null, updatedAt: timestamp() })
    if (to === 'served' && financial.paymentStatus === 'paid' && order.tableId) transaction.update(subcollection(actor.restaurantId, 'tables').doc(order.tableId), { status: 'available', currentOrderId: null, updatedAt: timestamp() })
    transaction.create(requestRef, { actorId: actor.uid, createdAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: `order.${to}`, entityId: orderId, actorId: actor.uid, createdAt: timestamp(), ...(to === 'cancelled' ? { reason: data.reason.trim().slice(0, 300) } : {}) })
    return { orderId, status: nextStatus, duplicate: false }
  })
}))

export const transferOrderTable = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager', 'waiter'])
  const orderId = safeId(data.orderId, 'Order')
  const targetTableId = safeId(data.targetTableId, 'Target table')
  const orderRef = subcollection(actor.restaurantId, 'orders').doc(orderId)
  return db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef)
    if (!orderSnap.exists) fail('not-found', 'Order not found.')
    const order = orderSnap.data()
    if (order.type !== 'dine-in' || !order.tableId) fail('failed-precondition', 'Only a dine-in order can be moved to another table.')
    if (order.status === 'served' || order.status === 'cancelled') fail('failed-precondition', 'Completed or cancelled orders cannot be moved.')
    if (order.tableId === targetTableId) return { orderId, targetTableId, duplicate: true }
    const oldTableRef = subcollection(actor.restaurantId, 'tables').doc(order.tableId)
    const targetTableRef = subcollection(actor.restaurantId, 'tables').doc(targetTableId)
    const [oldTableSnap, targetTableSnap] = await transaction.getAll(oldTableRef, targetTableRef)
    const activeReservations = subcollection(actor.restaurantId, 'reservations')
      .where('tableId', '==', targetTableId)
      .where('status', '==', 'booked')
      .where('startsAt', '<=', Timestamp.fromDate(new Date()))
      .where('endsAt', '>', Timestamp.fromDate(new Date()))
    const reservationSnapshot = await transaction.get(activeReservations)
    if (!oldTableSnap.exists || oldTableSnap.get('currentOrderId') !== orderId) fail('failed-precondition', 'The original table is no longer assigned to this order.')
    if (!targetTableSnap.exists || targetTableSnap.get('status') !== 'available' || !reservationSnapshot.empty) fail('failed-precondition', 'The target table is occupied or reserved right now.')
    const covers = (order.items || []).reduce((sum, item) => sum + item.quantity, 0)
    if (covers > Number(targetTableSnap.get('capacity') || 0)) fail('failed-precondition', 'The target table does not have enough seats for this order.')
    transaction.update(oldTableRef, { status: 'available', currentOrderId: null, updatedAt: timestamp() })
    transaction.update(targetTableRef, { status: 'occupied', currentOrderId: orderId, updatedAt: timestamp() })
    transaction.update(orderRef, { tableId: targetTableId, tableName: targetTableSnap.get('name'), updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'order.table_transferred', entityId: orderId, actorId: actor.uid, fromTableId: order.tableId, toTableId: targetTableId, createdAt: timestamp() })
    return { orderId, targetTableId, duplicate: false }
  })
}))

export const adjustInventory = onCall(options, (request) => withActor(request, async (actor, data) => {
  if (!['owner', 'manager'].includes(actor.role) && !mayUsePermission(actor, 'adjustInventory')) fail('permission-denied', 'Inventory adjustments require explicit permission.')
  const ingredientId = safeId(data.ingredientId, 'Stock item')
  const movementId = safeId(data.movementId, 'Movement')
  const movementType = ['receive', 'waste', 'adjust'].includes(data.movementType) ? data.movementType : fail('invalid-argument', 'Choose a valid stock movement.')
  const reason = requiredString(data.reason, 'Reason', 300)
  if (movementType === 'adjust' && !mayUsePermission(actor, 'adjustInventory')) fail('permission-denied', 'Stock adjustments require explicit permission.')
  const rawQuantity = Number(data.quantity)
  if (!Number.isFinite(rawQuantity) || rawQuantity === 0 || Math.abs(rawQuantity) > 1000000) fail('invalid-argument', 'Enter a valid non-zero quantity.')
  if (movementType !== 'adjust' && rawQuantity < 0) fail('invalid-argument', 'Quantity must be positive.')
  const delta = movementType === 'waste' ? -rawQuantity : rawQuantity
  const stockRef = subcollection(actor.restaurantId, 'inventory').doc(ingredientId)
  const movementRef = subcollection(actor.restaurantId, 'stockMovements').doc(movementId)
  return db.runTransaction(async (transaction) => {
    const [stockSnap, movementSnap] = await transaction.getAll(stockRef, movementRef)
    if (movementSnap.exists) return { movementId, duplicate: true }
    if (!stockSnap.exists) fail('not-found', 'Stock item not found.')
    const currentQuantity = Number(stockSnap.get('quantityOnHand') || 0)
    const nextQuantity = currentQuantity + delta
    if (nextQuantity < 0) fail('failed-precondition', 'This movement would make stock negative.')
    transaction.update(stockRef, { quantityOnHand: nextQuantity, lastMovementId: movementId, updatedAt: timestamp() })
    transaction.create(movementRef, { restaurantId: actor.restaurantId, ingredientId, itemName: stockSnap.get('name'), unit: stockSnap.get('unit'), movementType, quantity: delta, reason, createdBy: actor.uid, createdAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: `inventory.${movementType}`, entityId: ingredientId, actorId: actor.uid, quantity: delta, reason, createdAt: timestamp() })
    return { movementId, quantityOnHand: nextQuantity, duplicate: false }
  })
}))

export const createPurchase = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const purchaseId = safeId(data.purchaseId, 'Purchase')
  const supplierId = safeId(data.supplierId, 'Supplier')
  const reference = typeof data.reference === 'string' ? data.reference.trim().slice(0, 100) : ''
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 30) fail('invalid-argument', 'A purchase must contain 1 to 30 items.')
  const purchaseRef = subcollection(actor.restaurantId, 'purchases').doc(purchaseId)
  const supplierRef = subcollection(actor.restaurantId, 'suppliers').doc(supplierId)
  const itemIds = [...new Set(data.items.map((line) => safeId(line.ingredientId, 'Stock item')))]
  if (itemIds.length !== data.items.length) fail('invalid-argument', 'Combine duplicate stock items into one purchase line.')
  const stockRefs = itemIds.map((id) => subcollection(actor.restaurantId, 'inventory').doc(id))
  return db.runTransaction(async (transaction) => {
    const [purchaseSnap, supplierSnap, ...stockSnaps] = await transaction.getAll(purchaseRef, supplierRef, ...stockRefs)
    if (purchaseSnap.exists) return { purchaseId, duplicate: true }
    if (!supplierSnap.exists) fail('not-found', 'Supplier not found.')
    const stockById = new Map()
    stockSnaps.forEach((snapshot, index) => {
      if (!snapshot.exists) fail('not-found', 'One of the stock items could not be found.')
      stockById.set(itemIds[index], snapshot.data())
    })
    const items = data.items.map((line) => {
      const ingredientId = safeId(line.ingredientId, 'Stock item')
      const quantity = Number(line.quantity)
      const unitCostCents = Number(line.unitCostCents)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000 || !Number.isSafeInteger(unitCostCents) || unitCostCents < 0 || unitCostCents > 100000000) {
        fail('invalid-argument', 'Purchase quantities and unit costs must be valid.')
      }
      const stock = stockById.get(ingredientId)
      return { ingredientId, itemName: stock.name, quantity, unitCostCents }
    })
    const totalCents = Math.round(items.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0))
    if (!Number.isSafeInteger(totalCents) || totalCents > 1000000000) fail('invalid-argument', 'Purchase total is outside the allowed range.')
    transaction.create(purchaseRef, {
      restaurantId: actor.restaurantId,
      supplierId,
      supplierName: supplierSnap.get('name'),
      items,
      totalCents,
      reference,
      status: 'ordered',
      createdBy: actor.uid,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    })
    transaction.create(auditRef(actor.restaurantId), { action: 'purchase.created', entityId: purchaseId, actorId: actor.uid, totalCents, createdAt: timestamp() })
    return { purchaseId, totalCents, duplicate: false }
  })
}))

export const receivePurchase = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const purchaseId = safeId(data.purchaseId, 'Purchase')
  const movementId = safeId(data.movementId, 'Movement')
  const purchaseRef = subcollection(actor.restaurantId, 'purchases').doc(purchaseId)
  const movementRef = subcollection(actor.restaurantId, 'stockMovements').doc(movementId)
  return db.runTransaction(async (transaction) => {
    const [purchaseSnap, movementSnap] = await transaction.getAll(purchaseRef, movementRef)
    if (purchaseSnap.exists && purchaseSnap.get('status') === 'received') return { purchaseId, duplicate: true }
    if (!purchaseSnap.exists) fail('not-found', 'Purchase not found.')
    const purchase = purchaseSnap.data()
    if (!Array.isArray(purchase.items) || !purchase.items.length || purchase.items.length > 30) fail('failed-precondition', 'Purchase items are invalid.')
    if (movementSnap.exists) fail('failed-precondition', 'This receipt key was already used. Reload purchases and try again.')
    const refs = purchase.items.map((item) => subcollection(actor.restaurantId, 'inventory').doc(safeId(item.ingredientId, 'Stock item')))
    const stocks = await transaction.getAll(...refs)
    const receiptTime = timestamp()
    for (let index = 0; index < purchase.items.length; index += 1) {
      const line = purchase.items[index]
      const stock = stocks[index]
      const quantity = Number(line.quantity)
      if (!stock.exists || !Number.isFinite(quantity) || quantity <= 0) fail('failed-precondition', 'A stock item or purchase quantity is invalid.')
      const quantityOnHand = Number(stock.get('quantityOnHand') || 0)
      const nextQuantity = quantityOnHand + quantity
      const unitCostCents = Number(line.unitCostCents || 0)
      const currentCost = Number(stock.get('averageCostCents') || 0)
      const averageCostCents = Math.round((quantityOnHand * currentCost + quantity * unitCostCents) / nextQuantity)
      const stockMovementId = `${purchaseId}_${line.ingredientId}`
      transaction.update(refs[index], { quantityOnHand: nextQuantity, averageCostCents, lastMovementId: stockMovementId, updatedAt: receiptTime })
      transaction.create(subcollection(actor.restaurantId, 'stockMovements').doc(stockMovementId), { restaurantId: actor.restaurantId, ingredientId: line.ingredientId, itemName: line.itemName || stock.get('name'), unit: stock.get('unit'), movementType: 'purchase_received', quantity, unitCostCents, purchaseId, createdBy: actor.uid, createdAt: receiptTime })
    }
    transaction.update(purchaseRef, { status: 'received', receivedBy: actor.uid, receivedAt: receiptTime, lastReceiptId: movementId, updatedAt: receiptTime })
    transaction.create(movementRef, { restaurantId: actor.restaurantId, movementType: 'purchase_receipt', purchaseId, createdBy: actor.uid, createdAt: receiptTime })
    transaction.create(auditRef(actor.restaurantId), { action: 'purchase.received', entityId: purchaseId, actorId: actor.uid, createdAt: receiptTime })
    return { purchaseId, duplicate: false }
  })
}))

export const recordExpense = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const expenseId = safeId(data.expenseId, 'Expense')
  const amountCents = validCents(data.amountCents, 'Expense amount')
  const category = requiredString(data.category, 'Category', 80)
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 500) : ''
  const date = requiredString(data.date, 'Expense date', 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid-argument', 'Enter a valid expense date.')
  const expenseRef = subcollection(actor.restaurantId, 'expenses').doc(expenseId)
  return db.runTransaction(async (transaction) => {
    const exists = await transaction.get(expenseRef)
    if (exists.exists) return { expenseId, duplicate: true }
    const record = { restaurantId: actor.restaurantId, amountCents, category, description, date, method: ['cash', 'card', 'transfer'].includes(data.method) ? data.method : 'cash', status: 'approved', createdBy: actor.uid, createdAt: timestamp(), updatedAt: timestamp() }
    transaction.create(expenseRef, record)
    transaction.create(auditRef(actor.restaurantId), { action: 'expense.recorded', entityId: expenseId, actorId: actor.uid, amountCents, createdAt: timestamp() })
    return { expenseId, duplicate: false }
  })
}))

export const updateRestaurantSettings = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner'])
  const name = requiredString(data.name, 'Restaurant name', 120)
  const currency = requiredString(data.currency, 'Currency', 3).toUpperCase()
  const taxRate = Number(data.taxRate)
  const paymentMethods = [...new Set(data.paymentMethods || [])]
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) fail('invalid-argument', 'Currency or tax rate is invalid.')
  if (!paymentMethods.length || paymentMethods.some((method) => !['cash', 'card', 'digital'].includes(method))) fail('invalid-argument', 'Payment method configuration is invalid.')
  const restaurantRef = restaurantDoc(actor.restaurantId)
  const settingsRef = subcollection(actor.restaurantId, 'settings').doc('profile')
  await db.runTransaction(async (transaction) => {
    transaction.set(restaurantRef, { restaurantId: actor.restaurantId, name, updatedAt: timestamp() }, { merge: true })
    transaction.set(settingsRef, { name, currency, taxRate, paymentMethods, updatedAt: timestamp(), createdAt: timestamp() }, { merge: true })
    transaction.create(auditRef(actor.restaurantId), { action: 'settings.updated', actorId: actor.uid, createdAt: timestamp() })
  })
  return { ok: true }
}))

export const inviteStaff = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner'])
  const email = requiredString(data.email, 'Email', 254).toLowerCase()
  const displayName = requiredString(data.displayName, 'Name', 100)
  const role = roles.has(data.role) && data.role !== 'owner' ? data.role : fail('invalid-argument', 'Choose a valid staff role.')
  let user
  let setupRequired = false
  try {
    user = await auth.createUser({ email, displayName, password: randomBytes(32).toString('base64url'), emailVerified: false, disabled: false })
    setupRequired = true
  } catch (error) {
    if (error.code !== 'auth/email-already-exists') throw error
    user = await auth.getUserByEmail(email)
    if (user.disabled) fail('failed-precondition', 'This Firebase account is disabled.')
    if (user.customClaims?.restaurantId) fail('already-exists', 'This account is already assigned to a restaurant.')
  }
  const memberRef = subcollection(actor.restaurantId, 'users').doc(user.uid)
  const auditRefForInvite = auditRef(actor.restaurantId)
  const existingMember = await memberRef.get()
  if (existingMember.exists) {
    if (setupRequired) await auth.deleteUser(user.uid).catch(() => {})
    fail('already-exists', 'This team member is already set up for this restaurant.')
  }
  const previousClaims = user.customClaims || {}
  const memberBatch = db.batch()
  memberBatch.create(memberRef, { email, displayName: displayName || user.displayName || email, role, active: true, permissions: [], createdAt: timestamp(), createdBy: actor.uid })
  memberBatch.create(auditRefForInvite, { action: 'staff.invited', entityId: user.uid, actorId: actor.uid, createdAt: timestamp() })
  let membershipCreated = false
  try {
    await memberBatch.commit()
    membershipCreated = true
    await auth.setCustomUserClaims(user.uid, { ...previousClaims, restaurantId: actor.restaurantId, role })
    return { userId: user.uid, setupRequired }
  } catch (error) {
    if (membershipCreated) {
      const cleanup = db.batch()
      cleanup.delete(memberRef)
      cleanup.delete(auditRefForInvite)
      await cleanup.commit().catch(() => {})
    }
    await auth.setCustomUserClaims(user.uid, previousClaims).catch(() => {})
    if (setupRequired) await auth.deleteUser(user.uid).catch(() => {})
    throw error
  }
}))

export const createOwnerRestaurant = onCall(options, async (request) => {
  if (!request.auth?.uid) fail('unauthenticated', 'Create and verify your account before setting up a restaurant.')
  const restaurantName = requiredString(request.data?.restaurantName, 'Restaurant name', 120)
  let account
  try {
    account = await auth.getUser(request.auth.uid)
  } catch {
    fail('unauthenticated', 'Your Firebase account could not be verified.')
  }
  if (account.disabled) fail('permission-denied', 'This account is disabled.')
  if (!account.emailVerified) fail('failed-precondition', 'Verify your email before creating a restaurant.')
  if (account.customClaims?.restaurantId) fail('already-exists', 'This account already belongs to a restaurant.')

  const restaurantId = `r_${randomBytes(16).toString('hex')}`
  const restaurantRef = restaurantDoc(restaurantId)
  const memberRef = subcollection(restaurantId, 'users').doc(account.uid)
  const settingsRef = subcollection(restaurantId, 'settings').doc('profile')
  const auditReference = auditRef(restaurantId)
  const signupLockRef = db.doc(`ownerSignupLocks/${account.uid}`)
  await db.runTransaction(async (transaction) => {
    const signupLock = await transaction.get(signupLockRef)
    if (signupLock.exists) fail('already-exists', 'This account has already created its restaurant.')
    transaction.create(signupLockRef, { restaurantId, userId: account.uid, createdAt: timestamp() })
    transaction.create(restaurantRef, { restaurantId, name: restaurantName, createdAt: timestamp(), createdBy: account.uid, updatedAt: timestamp() })
    transaction.create(memberRef, { email: account.email || '', displayName: account.displayName || restaurantName, role: 'owner', active: true, permissions: [], createdAt: timestamp(), createdBy: account.uid })
    transaction.create(settingsRef, { name: restaurantName, currency: 'PKR', taxRate: 0, paymentMethods: ['cash', 'card', 'digital'], createdAt: timestamp(), updatedAt: timestamp() })
    transaction.create(auditReference, { action: 'restaurant.owner_self_provisioned', entityId: account.uid, actorId: account.uid, createdAt: timestamp() })
  })

  try {
    await auth.setCustomUserClaims(account.uid, { ...(account.customClaims || {}), restaurantId, role: 'owner' })
    return { restaurantId, role: 'owner' }
  } catch (error) {
    const cleanup = db.batch()
    cleanup.delete(signupLockRef)
    cleanup.delete(restaurantRef)
    cleanup.delete(memberRef)
    cleanup.delete(settingsRef)
    cleanup.delete(auditReference)
    await cleanup.commit().catch(() => {})
    await auth.setCustomUserClaims(account.uid, account.customClaims || {}).catch(() => {})
    throw error
  }
})

export const setStaffActive = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner'])
  const userId = safeId(data.userId, 'Staff member')
  if (userId === actor.uid) fail('failed-precondition', 'You cannot disable your own account.')
  const memberRef = subcollection(actor.restaurantId, 'users').doc(userId)
  const active = data.active === true
  await db.runTransaction(async (transaction) => {
    const member = await transaction.get(memberRef)
    if (!member.exists) fail('not-found', 'Staff member not found.')
    if (member.get('role') === 'owner') fail('failed-precondition', 'Owner accounts cannot be disabled here.')
    transaction.update(memberRef, { active, updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: active ? 'staff.enabled' : 'staff.disabled', entityId: userId, actorId: actor.uid, createdAt: timestamp() })
  })
  await auth.updateUser(userId, { disabled: !active })
  if (!active) await auth.revokeRefreshTokens(userId)
  return { userId, active }
}))

export const setStaffPermissions = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner'])
  const userId = safeId(data.userId, 'Staff member')
  if (!Array.isArray(data.permissions) || data.permissions.length > 3) fail('invalid-argument', 'Choose up to three permissions.')
  const permissions = [...new Set(data.permissions)]
  const memberRef = subcollection(actor.restaurantId, 'users').doc(userId)
  await db.runTransaction(async (transaction) => {
    const member = await transaction.get(memberRef)
    if (!member.exists) fail('not-found', 'Staff member not found.')
    const rolePermissions = {
      cashier: ['discounts', 'refunds', 'voidOrders'],
      waiter: ['discounts', 'voidOrders'],
    }
    const allowed = rolePermissions[member.get('role')] || []
    if (permissions.some((permission) => !allowed.includes(permission))) fail('invalid-argument', 'One or more permissions are not valid for this staff role.')
    transaction.update(memberRef, { permissions, updatedAt: timestamp() })
    transaction.create(auditRef(actor.restaurantId), { action: 'staff.permissions_updated', entityId: userId, actorId: actor.uid, permissions, createdAt: timestamp() })
  })
  return { userId, permissions }
}))

export const getDashboardSummary = onCall(options, (request) => withActor(request, async (actor) => {
  requireRole(actor, ['owner', 'manager'])
  const start = Timestamp.fromDate(getDayStart())
  const [ordersSnapshot, financialSnapshot, expensesSnapshot, settingsSnapshot] = await Promise.all([
    subcollection(actor.restaurantId, 'orders').where('createdAt', '>=', start).limit(500).get(),
    subcollection(actor.restaurantId, 'orderFinancials').where('createdAt', '>=', start).limit(500).get(),
    subcollection(actor.restaurantId, 'expenses').where('date', '==', localDayKey(new Date())).limit(300).get(),
    subcollection(actor.restaurantId, 'settings').doc('profile').get(),
  ])
  const orders = ordersSnapshot.docs.map((doc) => doc.data())
  const financials = financialSnapshot.docs.map((doc) => doc.data())
  const completed = financials.filter((record) => record.paymentStatus === 'paid' && record.status === 'active')
  const grossSalesCents = completed.reduce((sum, record) => sum + record.subtotalCents, 0)
  const counts = new Map()
  for (const record of completed) for (const item of record.items || []) counts.set(item.name, (counts.get(item.name) || 0) + item.quantity)
  const bestSeller = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  const trendStart = new Date()
  trendStart.setDate(trendStart.getDate() - 6)
  const trendSnapshot = await subcollection(actor.restaurantId, 'orderFinancials').where('createdAt', '>=', Timestamp.fromDate(getDayStart(trendStart))).limit(1000).get()
  const days = new Map()
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date()
    day.setDate(day.getDate() - offset)
    days.set(localDayKey(day), { label: day.toLocaleDateString(undefined, { weekday: 'short' }), grossSalesCents: 0 })
  }
  for (const orderDoc of trendSnapshot.docs) {
    const financial = orderDoc.data()
    if (financial.paymentStatus !== 'paid' || financial.status !== 'active') continue
    const date = financial.createdAt.toDate()
    const entry = days.get(localDayKey(date))
    if (entry) entry.grossSalesCents += financial.subtotalCents
  }
  const unpaidOrderCount = financials.filter((record) => record.paymentStatus !== 'paid' && record.status === 'active').length
  const expenseCents = expensesSnapshot.docs.filter((doc) => doc.get('status') === 'approved').reduce((sum, doc) => sum + (doc.get('amountCents') || 0), 0)
  return {
    currency: settingsSnapshot.get('currency') || 'PKR',
    grossSalesCents,
    orderCount: orders.filter((order) => order.status !== 'cancelled').length,
    unpaidOrderCount,
    averageOrderCents: completed.length ? Math.round(completed.reduce((sum, record) => sum + record.totalCents, 0) / completed.length) : 0,
    expenseCents,
    bestSeller,
    salesTrend: [...days.values()],
  }
}))

export const exportReport = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, ['owner', 'manager'])
  const range = ['day', 'week', 'month'].includes(data.range) ? data.range : 'week'
  const startDate = getRangeStart(range)
  const start = Timestamp.fromDate(startDate)
  const [financialSnapshot, expensesSnapshot, paymentSnapshot] = await Promise.all([
    subcollection(actor.restaurantId, 'orderFinancials').where('createdAt', '>=', start).orderBy('createdAt', 'desc').limit(1000).get(),
    subcollection(actor.restaurantId, 'expenses').where('date', '>=', localDayKey(startDate)).orderBy('date').limit(1000).get(),
    subcollection(actor.restaurantId, 'payments').where('createdAt', '>=', start).orderBy('createdAt', 'desc').limit(2000).get(),
  ])
  const totalsByDay = new Map()
  const salesByItem = new Map()
  const salesByCategory = new Map()
  const expensesByCategory = new Map()
  let refundsCents = 0
  let discountsCents = 0
  let grossSalesCents = 0
  for (const financialDoc of financialSnapshot.docs) {
    const financial = financialDoc.data()
    if (financial.status !== 'active') continue
    const day = localDayKey(financial.createdAt.toDate())
    if (!totalsByDay.has(day)) totalsByDay.set(day, { date: day, orderCount: 0, grossSalesCents: 0, taxCents: 0, refundsCents: 0 })
    const row = totalsByDay.get(day)
    row.orderCount += 1
    row.grossSalesCents += financial.subtotalCents
    row.taxCents += financial.taxCents || 0
    row.refundsCents += financial.refundedCents || 0
    grossSalesCents += financial.subtotalCents
    refundsCents += financial.refundedCents || 0
    discountsCents += financial.discountCents || 0
    for (const item of financial.items || []) {
      const itemId = item.itemId || item.name
      const line = salesByItem.get(itemId) || { item: item.name, quantity: 0, grossSalesCents: 0 }
      line.quantity += item.quantity
      line.grossSalesCents += item.unitPriceCents * item.quantity
      salesByItem.set(itemId, line)
      const categoryKey = item.categoryId || item.categoryName || 'uncategorized'
      const category = salesByCategory.get(categoryKey) || { category: item.categoryName || 'Uncategorized', quantity: 0, grossSalesCents: 0 }
      category.quantity += item.quantity
      category.grossSalesCents += item.unitPriceCents * item.quantity
      salesByCategory.set(categoryKey, category)
    }
  }
  let expenseCents = 0
  for (const expense of expensesSnapshot.docs) {
    if (expense.get('status') !== 'approved') continue
    const amountCents = expense.get('amountCents') || 0
    expenseCents += amountCents
    const category = expense.get('category') || 'Uncategorized'
    expensesByCategory.set(category, (expensesByCategory.get(category) || 0) + amountCents)
  }
  const paymentsByMethod = new Map()
  for (const payment of paymentSnapshot.docs) {
    if (payment.get('kind') !== 'payment') continue
    const method = payment.get('method') || 'other'
    paymentsByMethod.set(method, (paymentsByMethod.get(method) || 0) + (payment.get('amountCents') || 0))
  }
  const rows = [...totalsByDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  return {
    range,
    summary: { grossSalesCents, refundsCents, discountsCents, expenseCents },
    rows,
    itemRows: [...salesByItem.values()].sort((a, b) => b.grossSalesCents - a.grossSalesCents),
    categoryRows: [...salesByCategory.values()].sort((a, b) => b.grossSalesCents - a.grossSalesCents),
    paymentRows: [...paymentsByMethod.entries()].map(([method, amountCents]) => ({ method, amountCents })),
    expenseRows: [...expensesByCategory.entries()].map(([category, amountCents]) => ({ category, amountCents })),
  }
}))

export const getCustomerHistory = onCall(options, (request) => withActor(request, async (actor, data) => {
  requireRole(actor, canReadFinance)
  const customerId = safeId(data.customerId, 'Customer')
  const customerRef = subcollection(actor.restaurantId, 'customers').doc(customerId)
  const customer = await customerRef.get()
  if (!customer.exists) fail('not-found', 'Customer not found.')
  const history = await subcollection(actor.restaurantId, 'orderFinancials')
    .where('customerId', '==', customerId)
    .where('status', '==', 'active')
    .where('paymentStatus', 'in', ['paid', 'partially_refunded', 'refunded'])
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get()
  const rows = await Promise.all(history.docs.map(async (financialDoc) => {
    const financial = financialDoc.data()
    const orderSnap = await subcollection(actor.restaurantId, 'orders').doc(financialDoc.id).get()
    if (!orderSnap.exists) return null
    const order = orderSnap.data()
    return {
      orderId: financialDoc.id,
      orderNumber: order.orderNumber,
      createdAt: financial.createdAt,
      type: order.type,
      status: order.status,
      items: financial.items,
      subtotalCents: financial.subtotalCents,
      discountCents: financial.discountCents,
      taxCents: financial.taxCents,
      totalCents: financial.totalCents,
      paidCents: financial.paidCents,
      refundedCents: financial.refundedCents,
      paymentStatus: financial.paymentStatus,
    }
  }))
  return {
    customer: { name: customer.get('name'), visitCount: customer.get('visitCount') || 0, totalSpendingCents: customer.get('totalSpendingCents') || 0 },
    rows: rows.filter(Boolean),
  }
}))
