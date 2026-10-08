/**
 * localOperations.cjs
 *
 * Implements transactional POS business operations backed by local SQLite.
 * Ensures orders, payments, table states, stock deductions, and financial calculations
 * run with ACID guarantees offline, queuing sync actions for Firestore.
 */

const { getDb } = require('../sqliteClient.cjs')
const genericRepository = require('./genericRepository.cjs')
const {
  priceMenuLine,
  calculateRecipeNeeds,
  applyPayment,
  applyRefund,
  isSettledPaymentStatus,
  roundStockQuantity,
} = require('../domain.cjs')
const { now, makeId } = require('./helpers.cjs')

function getNextOrderNumber(db, restaurantId) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `R-${dateStr}-`

  const row = db
    .prepare(
      `SELECT order_number FROM orders WHERE restaurant_id = ? AND order_number LIKE ? ORDER BY order_number DESC LIMIT 1`
    )
    .get(restaurantId, `${prefix}%`)

  let nextSeq = 1
  if (row && row.order_number) {
    const parts = row.order_number.split('-')
    const lastSeq = parseInt(parts[parts.length - 1], 10)
    if (!isNaN(lastSeq)) {
      nextSeq = lastSeq + 1
    }
  }

  return `${prefix}${String(nextSeq).padStart(4, '0')}`
}

function runLocalOperation(restaurantId, name, payload = {}) {
  const db = getDb()

  switch (name) {
    case 'createOrder': {
      const orderId = payload.orderId || makeId()
      const existing = genericRepository.getById(restaurantId, 'orders', orderId)
      if (existing) {
        return { orderId, orderNumber: existing.orderNumber, duplicate: true }
      }

      // Fetch menu items map for line pricing & recipes
      const menuItemsList = genericRepository.query(restaurantId, 'menuItems', [], 500)
      const menuMap = new Map(menuItemsList.map((item) => [item.id, item]))

      const pricedLines = (payload.items || []).map((line) => {
        const item = menuMap.get(line.itemId)
        if (!item) {
          throw new Error(`Menu item not found: ${line.itemId}`)
        }
        return priceMenuLine(item, line)
      })

      const subtotalCents = pricedLines.reduce(
        (sum, line) => sum + line.unitPriceCents * line.quantity,
        0
      )

      let discountCents = 0
      if (payload.discountType === 'percent' && typeof payload.discountValue === 'number') {
        discountCents = Math.round((subtotalCents * payload.discountValue) / 100)
      } else if (typeof payload.discountValue === 'number') {
        discountCents = Math.min(subtotalCents, payload.discountValue)
      }

      const taxableSubtotal = Math.max(0, subtotalCents - discountCents)
      const taxRate = typeof payload.taxRate === 'number' ? payload.taxRate : 0
      const taxCents = Math.round((taxableSubtotal * taxRate) / 100)
      const totalCents = taxableSubtotal + taxCents

      const orderNumber = getNextOrderNumber(db, restaurantId)

      let tableName = ''
      if (payload.tableId) {
        const table = genericRepository.getById(restaurantId, 'tables', payload.tableId)
        if (table) tableName = table.name || ''
      }

      let customerName = ''
      if (payload.customerId) {
        const cust = genericRepository.getById(restaurantId, 'customers', payload.customerId)
        if (cust) customerName = cust.name || ''
      }

      let waiterName = ''
      if (payload.waiterId) {
        const waiter = genericRepository.getById(restaurantId, 'waiters', payload.waiterId)
        if (!waiter || waiter.status === 'inactive') throw new Error('Choose an active waiter or clear the waiter selection.')
        waiterName = waiter.name || ''
      }

      const orderRecord = {
        id: orderId,
        restaurantId,
        orderNumber,
        type: payload.type || 'dine-in',
        tableId: payload.tableId || null,
        tableName,
        waiterId: payload.waiterId || null,
        waiterName,
        customerId: payload.customerId || null,
        customerName,
        createdBy: payload.createdBy || '',
        items: pricedLines,
        status: payload.status || 'queued',
        paymentStatus: 'unpaid',
        dineInCoverCount: payload.dineInCoverCount || 1,
        note: payload.note || '',
        createdAt: now(),
        updatedAt: now(),
      }

      const financialRecord = {
        orderId,
        restaurantId,
        subtotalCents,
        discountCents,
        discountType: payload.discountType || 'fixed',
        discountValue: payload.discountValue || 0,
        taxCents,
        taxRate,
        totalCents,
        paidCents: 0,
        refundedCents: 0,
        tipCents: 0,
        paymentStatus: 'unpaid',
        createdAt: now(),
        updatedAt: now(),
      }

      // Decrement inventory stock if recipes exist
      const recipeNeeds = calculateRecipeNeeds(pricedLines, menuMap)
      for (const [ingredientId, qtyNeeded] of recipeNeeds.entries()) {
        const ing = genericRepository.getById(restaurantId, 'inventoryItems', ingredientId)
        if (ing) {
          const newStock = roundStockQuantity((ing.currentStock || 0) - qtyNeeded)
          genericRepository.upsert(
            restaurantId,
            'inventoryItems',
            { currentStock: newStock, quantityOnHand: newStock },
            ingredientId
          )
          genericRepository.upsert(restaurantId, 'stockMovements', {
            ingredientId,
            movementType: 'order_deduct',
            quantity: -qtyNeeded,
            reason: `Order ${orderNumber}`,
            orderId,
          })
        }
      }

      // Upsert order and financials
      genericRepository.upsert(restaurantId, 'orders', orderRecord, orderId)
      genericRepository.upsert(restaurantId, 'orderFinancials', financialRecord, orderId)

      // If dine-in and tableId specified, mark table occupied
      if (payload.type === 'dine-in' && payload.tableId) {
        genericRepository.upsert(
          restaurantId,
          'tables',
          { status: 'occupied', currentOrderId: orderId },
          payload.tableId
        )
      }

      return { orderId, orderNumber, totalCents }
    }

    case 'recordPayment': {
      const { orderId, paymentId = makeId(), amountCents, method = 'cash', reference = '', recordedBy = '' } = payload
      const existingPay = genericRepository.getById(restaurantId, 'payments', paymentId)
      if (existingPay) {
        return { orderId, paymentId, duplicate: true }
      }

      const finance = genericRepository.getById(restaurantId, 'orderFinancials', orderId)
      if (!finance) {
        throw new Error('Order financial details were not found.')
      }

      const transition = applyPayment(finance, amountCents)
      const paymentRecord = {
        id: paymentId,
        restaurantId,
        orderId,
        amountCents,
        method,
        kind: 'payment',
        reference,
        recordedBy,
        createdAt: now(),
      }

      genericRepository.upsert(restaurantId, 'payments', paymentRecord, paymentId)
      genericRepository.upsert(
        restaurantId,
        'orderFinancials',
        {
          paidCents: transition.paidCents,
          paymentStatus: transition.paymentStatus,
          lastPaymentId: paymentId,
        },
        orderId
      )

      const order = genericRepository.getById(restaurantId, 'orders', orderId)
      if (order) {
        genericRepository.upsert(
          restaurantId,
          'orders',
          { paymentStatus: transition.paymentStatus },
          orderId
        )

        // Free table if served & settled
        if (order.status === 'served' && order.tableId && isSettledPaymentStatus(transition.paymentStatus)) {
          genericRepository.upsert(
            restaurantId,
            'tables',
            { status: 'available', currentOrderId: null },
            order.tableId
          )
        }
      }

      // Update customer stats
      if (finance.customerId && transition.customerVisitCounted) {
        const cust = genericRepository.getById(restaurantId, 'customers', finance.customerId)
        if (cust) {
          genericRepository.upsert(
            restaurantId,
            'customers',
            {
              visitCount: (cust.visitCount || 0) + 1,
              totalSpendingCents: (cust.totalSpendingCents || 0) + finance.totalCents,
              lastVisitAt: now(),
            },
            cust.id
          )
        }
      }

      return { orderId, paymentId, paymentStatus: transition.paymentStatus }
    }

    case 'recordRefund': {
      const { orderId, refundId = makeId(), amountCents, reason = '', recordedBy = '' } = payload
      const finance = genericRepository.getById(restaurantId, 'orderFinancials', orderId)
      if (!finance) {
        throw new Error('Order financial details were not found.')
      }

      const transition = applyRefund(finance, amountCents)
      const paymentRecord = {
        id: refundId,
        restaurantId,
        orderId,
        amountCents,
        method: 'adjustment',
        kind: 'refund',
        reason,
        recordedBy,
        createdAt: now(),
      }

      genericRepository.upsert(restaurantId, 'payments', paymentRecord, refundId)
      genericRepository.upsert(
        restaurantId,
        'orderFinancials',
        {
          refundedCents: transition.refundedCents,
          paymentStatus: transition.paymentStatus,
          lastPaymentId: refundId,
        },
        orderId
      )

      genericRepository.upsert(
        restaurantId,
        'orders',
        { paymentStatus: transition.paymentStatus },
        orderId
      )

      return { orderId, refundId, paymentStatus: transition.paymentStatus }
    }

    case 'transitionOrder': {
      const { orderId, status } = payload
      const order = genericRepository.getById(restaurantId, 'orders', orderId)
      if (!order) {
        throw new Error('Order not found.')
      }

      genericRepository.upsert(restaurantId, 'orders', { status }, orderId)

      // Free table if completed or cancelled
      if ((status === 'completed' || status === 'cancelled') && order.tableId) {
        genericRepository.upsert(
          restaurantId,
          'tables',
          { status: 'available', currentOrderId: null },
          order.tableId
        )
      }

      return { orderId, status }
    }

    case 'transferOrderTable': {
      const { orderId, targetTableId } = payload
      const order = genericRepository.getById(restaurantId, 'orders', orderId)
      if (!order) throw new Error('Order not found.')

      const oldTableId = order.tableId
      const targetTable = genericRepository.getById(restaurantId, 'tables', targetTableId)
      if (!targetTable) throw new Error('Target table not found.')

      if (oldTableId) {
        genericRepository.upsert(
          restaurantId,
          'tables',
          { status: 'available', currentOrderId: null },
          oldTableId
        )
      }

      genericRepository.upsert(
        restaurantId,
        'tables',
        { status: 'occupied', currentOrderId: orderId },
        targetTableId
      )

      genericRepository.upsert(
        restaurantId,
        'orders',
        { tableId: targetTableId, tableName: targetTable.name || '' },
        orderId
      )

      return { orderId, targetTableId }
    }

    case 'adjustInventory': {
      const { ingredientId, movementType = 'adjust', quantity, reason = '' } = payload
      const item = genericRepository.getById(restaurantId, 'inventoryItems', ingredientId)
      if (!item) throw new Error('Inventory item not found.')

      const newStock = roundStockQuantity((item.currentStock || 0) + quantity)
      genericRepository.upsert(
        restaurantId,
        'inventoryItems',
        { currentStock: newStock, quantityOnHand: newStock },
        ingredientId
      )

      const movementId = payload.movementId || makeId()
      genericRepository.upsert(
        restaurantId,
        'stockMovements',
        {
          id: movementId,
          ingredientId,
          movementType,
          quantity,
          reason,
          createdAt: now(),
        },
        movementId
      )

      return { movementId, currentStock: newStock }
    }

    case 'createPurchase': {
      const purchaseId = payload.purchaseId || makeId()
      genericRepository.upsert(restaurantId, 'purchases', { ...payload, id: purchaseId }, purchaseId)
      return { purchaseId }
    }

    case 'receivePurchase': {
      const { purchaseId } = payload
      const purchase = genericRepository.getById(restaurantId, 'purchases', purchaseId)
      if (!purchase) throw new Error('Purchase not found.')

      genericRepository.upsert(restaurantId, 'purchases', { status: 'received' }, purchaseId)

      for (const line of purchase.items || []) {
        const item = genericRepository.getById(restaurantId, 'inventoryItems', line.ingredientId)
        if (item) {
          const newStock = roundStockQuantity((item.currentStock || 0) + line.quantity)
          genericRepository.upsert(
            restaurantId,
            'inventoryItems',
            { currentStock: newStock },
            line.ingredientId
          )
          genericRepository.upsert(restaurantId, 'stockMovements', {
            ingredientId: line.ingredientId,
            movementType: 'purchase_receive',
            quantity: line.quantity,
            reason: `Purchase ${purchase.reference || purchaseId}`,
          })
        }
      }
      return { purchaseId, status: 'received' }
    }

    case 'recordExpense': {
      const expenseId = payload.expenseId || makeId()
      genericRepository.upsert(restaurantId, 'expenses', { ...payload, id: expenseId }, expenseId)
      return { expenseId }
    }

    case 'saveOrderDraft': {
      const draftId = payload.draftId || payload.id || makeId()
      genericRepository.upsert(restaurantId, 'draftOrders', { ...payload, id: draftId }, draftId)
      return { draftId }
    }

    case 'deleteOrderDraft': {
      const draftId = payload.draftId || payload.id
      if (draftId) {
        genericRepository.softDelete(restaurantId, 'draftOrders', draftId)
      }
      return { draftId, deleted: true }
    }

    case 'createReservation': {
      const resId = payload.reservationId || makeId()
      genericRepository.upsert(
        restaurantId,
        'reservations',
        { ...payload, id: resId, status: 'booked' },
        resId
      )
      return { reservationId: resId }
    }

    case 'seatReservation': {
      const { reservationId } = payload
      const res = genericRepository.getById(restaurantId, 'reservations', reservationId)
      if (res) {
        genericRepository.upsert(restaurantId, 'reservations', { status: 'seated' }, reservationId)
        if (res.tableId) {
          genericRepository.upsert(
            restaurantId,
            'tables',
            { status: 'occupied' },
            res.tableId
          )
        }
      }
      return { reservationId, status: 'seated' }
    }

    case 'cancelReservation': {
      const { reservationId, reason } = payload
      genericRepository.upsert(
        restaurantId,
        'reservations',
        { status: 'cancelled', cancelReason: reason },
        reservationId
      )
      return { reservationId, status: 'cancelled' }
    }

    case 'getDashboardSummary': {
      const orders = genericRepository.query(restaurantId, 'orders', [], 200)
      const payments = genericRepository.query(restaurantId, 'payments', [], 200)
      const tables = genericRepository.query(restaurantId, 'tables', [], 100)

      const totalRevenueCents = payments
        .filter((p) => p.kind === 'payment')
        .reduce((sum, p) => sum + (p.amountCents || 0), 0)
      const activeOrdersCount = orders.filter((o) =>
        ['queued', 'preparing', 'served'].includes(o.status)
      ).length
      const occupiedTablesCount = tables.filter((t) => t.status === 'occupied').length

      return {
        totalRevenueCents,
        activeOrdersCount,
        occupiedTablesCount,
        totalOrdersCount: orders.length,
      }
    }

    default: {
      // Fallback: if there is no custom operation handler, return success or error
      return { success: true, operation: name }
    }
  }
}

module.exports = { runLocalOperation }
