/**
 * COLLECTION REGISTRY
 *
 * Maps Firestore collection names (used throughout the React app via watchRecords /
 * saveRecord) to their SQLite table names and field serializers/deserializers.
 *
 * Shape of each entry:
 *   table         – SQLite table name
 *   toRow(values) – convert incoming JS object → SQLite row object
 *   fromRow(row)  – convert SQLite row → JS object matching Firestore document shape
 */

const { toIso, parseJson, toJson, now } = require('./helpers.cjs')

// ─── Shared column deserializers ─────────────────────────────────────────────
function baseFrom(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    syncStatus: row.sync_status,
    version: row.version,
  }
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function settingsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    currency: v.currency || 'PKR',
    tax_rate: typeof v.taxRate === 'number' ? v.taxRate : 0,
    payment_methods_json: toJson(v.paymentMethods || ['cash', 'card', 'digital']),
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function settingsFromRow(row) {
  return {
    ...baseFrom(row),
    name: row.name,
    currency: row.currency,
    taxRate: row.tax_rate,
    paymentMethods: parseJson(row.payment_methods_json, ['cash', 'card', 'digital']),
  }
}

// ─── CATEGORIES ──────────────────────────────────────────────────────────────
function categoriesToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function categoriesFromRow(row) {
  return { ...baseFrom(row), name: row.name }
}

// ─── MENU ITEMS ──────────────────────────────────────────────────────────────
function menuItemsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    category_id: v.categoryId || null,
    category_name: v.categoryName || '',
    name: v.name || '',
    description: v.description || '',
    price_cents: typeof v.priceCents === 'number' ? v.priceCents : (typeof v.price === 'number' ? v.price : 0),
    available: v.available === false ? 0 : 1,
    image_url: v.imageUrl || '',
    variants_json: toJson(v.variants || []),
    add_ons_json: toJson(v.addOns || []),
    recipe_json: toJson(v.recipe || []),
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function menuItemsFromRow(row) {
  return {
    ...baseFrom(row),
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    price: row.price_cents,
    available: row.available === 1,
    imageUrl: row.image_url,
    variants: parseJson(row.variants_json, []),
    addOns: parseJson(row.add_ons_json, []),
    recipe: parseJson(row.recipe_json, []),
  }
}

// ─── TABLES ──────────────────────────────────────────────────────────────────
function tablesToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    capacity: typeof v.capacity === 'number' ? v.capacity : 1,
    status: v.status || 'available',
    current_order_id: v.currentOrderId || null,
    current_reservation_id: v.currentReservationId || null,
    merged_table_ids_json: toJson(v.mergedTableIds || []),
    merged_table_names_json: toJson(v.mergedTableNames || []),
    merged_into: v.mergedInto || null,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function tablesFromRow(row) {
  return {
    ...baseFrom(row),
    name: row.name,
    capacity: row.capacity,
    status: row.status,
    currentOrderId: row.current_order_id,
    currentReservationId: row.current_reservation_id,
    mergedTableIds: parseJson(row.merged_table_ids_json, []),
    mergedTableNames: parseJson(row.merged_table_names_json, []),
    mergedInto: row.merged_into,
  }
}

// ─── RESERVATIONS ────────────────────────────────────────────────────────────
function reservationsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    table_id: v.tableId || '',
    table_name: v.tableName || '',
    guest_name: v.guestName || '',
    phone: v.phone || '',
    covers: typeof v.covers === 'number' ? v.covers : 1,
    starts_at: toIso(v.startsAt),
    ends_at: toIso(v.endsAt),
    status: v.status || 'booked',
    created_by: v.createdBy || null,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function reservationsFromRow(row) {
  return {
    ...baseFrom(row),
    tableId: row.table_id,
    tableName: row.table_name,
    guestName: row.guest_name,
    phone: row.phone,
    covers: row.covers,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    createdBy: row.created_by,
  }
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
function ordersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    order_number: v.orderNumber || '',
    type: v.type || 'direct-bill',
    table_id: v.tableId || null,
    table_name: v.tableName || '',
    covers: v.covers != null ? Number(v.covers) : null,
    waiter_id: v.waiterId || null,
    waiter_name: v.waiterName || '',
    note: v.note || '',
    items_json: toJson(v.items || []),
    status: v.status || 'queued',
    payment_status: v.paymentStatus || 'unpaid',
    created_by: v.createdBy || null,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'pending',
    version: (v.version || 0) + 1,
  }
}
function ordersFromRow(row) {
  return {
    ...baseFrom(row),
    orderNumber: row.order_number,
    type: row.type,
    tableId: row.table_id,
    tableName: row.table_name,
    covers: row.covers,
    waiterId: row.waiter_id || null,
    waiterName: row.waiter_name || '',
    note: row.note,
    items: parseJson(row.items_json, []),
    status: row.status,
    paymentStatus: row.payment_status,
    createdBy: row.created_by,
  }
}

// ─── ORDER FINANCIALS ────────────────────────────────────────────────────────
function orderFinancialsToRow(restaurantId, id, v) {
  return {
    order_id: id,
    restaurant_id: restaurantId,
    customer_id: v.customerId || null,
    items_json: toJson(v.items || []),
    subtotal_cents: v.subtotalCents || 0,
    discount_cents: v.discountCents || 0,
    tax_cents: v.taxCents || 0,
    total_cents: v.totalCents || 0,
    paid_cents: v.paidCents || 0,
    refunded_cents: v.refundedCents || 0,
    customer_visit_counted: v.customerVisitCounted ? 1 : 0,
    status: v.status || 'active',
    payment_status: v.paymentStatus || 'unpaid',
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'pending',
    version: (v.version || 0) + 1,
  }
}
function orderFinancialsFromRow(row) {
  return {
    id: row.order_id,
    restaurantId: row.restaurant_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    items: parseJson(row.items_json, []),
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    refundedCents: row.refunded_cents,
    customerVisitCounted: row.customer_visit_counted === 1,
    status: row.status,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    syncStatus: row.sync_status,
    version: row.version,
  }
}

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
function paymentsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    order_id: v.orderId || '',
    amount_cents: v.amountCents || 0,
    method: v.method || 'cash',
    kind: v.kind || 'payment',
    reference: v.reference || '',
    recorded_by: v.recordedBy || null,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'pending',
    version: (v.version || 0) + 1,
  }
}
function paymentsFromRow(row) {
  return {
    ...baseFrom(row),
    orderId: row.order_id,
    amountCents: row.amount_cents,
    method: row.method,
    kind: row.kind,
    reference: row.reference,
    recordedBy: row.recorded_by,
  }
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────
function customersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    phone: v.phone || '',
    email: v.email || '',
    visit_count: v.visitCount || 0,
    total_spending_cents: v.totalSpendingCents || 0,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function customersFromRow(row) {
  return {
    ...baseFrom(row),
    name: row.name,
    phone: row.phone,
    email: row.email,
    visitCount: row.visit_count,
    totalSpendingCents: row.total_spending_cents,
  }
}

// ─── INVENTORY ───────────────────────────────────────────────────────────────
function inventoryToRow(restaurantId, id, v) {
  const qty = typeof v.currentStock === 'number'
    ? v.currentStock
    : (typeof v.quantityOnHand === 'number' ? v.quantityOnHand : (typeof v.quantity === 'number' ? v.quantity : 0))
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    unit: v.unit || 'kg',
    quantity_on_hand: qty,
    reorder_level: typeof v.reorderLevel === 'number' ? v.reorderLevel : 0,
    average_cost_cents: typeof v.averageCostCents === 'number' ? v.averageCostCents : 0,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function inventoryFromRow(row) {
  return {
    ...baseFrom(row),
    name: row.name,
    unit: row.unit,
    quantityOnHand: row.quantity_on_hand,
    currentStock: row.quantity_on_hand,
    quantity: row.quantity_on_hand,
    reorderLevel: row.reorder_level,
    averageCostCents: row.average_cost_cents,
  }
}

// ─── STOCK MOVEMENTS ─────────────────────────────────────────────────────────
function stockMovementsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    ingredient_id: v.ingredientId || '',
    item_name: v.itemName || '',
    unit: v.unit || '',
    movement_type: v.movementType || '',
    quantity: v.quantity || 0,
    reason: v.reason || '',
    created_by: v.createdBy || null,
    created_at: toIso(v.createdAt) || now(),
    sync_status: v.syncStatus || 'pending',
  }
}
function stockMovementsFromRow(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    ingredientId: row.ingredient_id,
    itemName: row.item_name,
    unit: row.unit,
    movementType: row.movement_type,
    quantity: row.quantity,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    syncStatus: row.sync_status,
  }
}

// ─── SUPPLIERS ───────────────────────────────────────────────────────────────
function suppliersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    contact: v.contact || '',
    phone: v.phone || '',
    email: v.email || '',
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function suppliersFromRow(row) {
  return { ...baseFrom(row), name: row.name, contact: row.contact, phone: row.phone, email: row.email }
}

// ─── PURCHASES ───────────────────────────────────────────────────────────────
function purchasesToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    supplier_id: v.supplierId || null,
    supplier_name: v.supplierName || '',
    items_json: toJson(v.items || []),
    total_cents: v.totalCents || 0,
    reference: v.reference || '',
    status: v.status || 'ordered',
    created_by: v.createdBy || null,
    created_at: toIso(v.createdAt) || now(),
    received_at: v.receivedAt ? toIso(v.receivedAt) : null,
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function purchasesFromRow(row) {
  return {
    ...baseFrom(row),
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    items: parseJson(row.items_json, []),
    totalCents: row.total_cents,
    reference: row.reference,
    status: row.status,
    createdBy: row.created_by,
    receivedAt: row.received_at,
  }
}

// ─── EXPENSES ────────────────────────────────────────────────────────────────
function expensesToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    category: v.category || '',
    amount_cents: typeof v.amountCents === 'number' ? v.amountCents : Math.round((v.amount || 0) * 100),
    description: v.description || '',
    date: v.date || new Date().toISOString().slice(0, 10),
    method: v.method || 'cash',
    status: v.status || 'approved',
    created_by: v.createdBy || null,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function expensesFromRow(row) {
  return {
    ...baseFrom(row),
    category: row.category,
    amountCents: row.amount_cents,
    description: row.description,
    date: row.date,
    method: row.method,
    status: row.status,
    createdBy: row.created_by,
  }
}

// ─── DRAFT ORDERS ────────────────────────────────────────────────────────────
function draftOrdersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    type: v.type || 'direct-bill',
    table_id: v.tableId || null,
    customer_id: v.customerId || null,
    discount_cents: v.discountCents || 0,
    note: v.note || '',
    items_json: toJson(v.items || []),
    created_by: v.createdBy || '',
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function draftOrdersFromRow(row) {
  return {
    ...baseFrom(row),
    type: row.type,
    tableId: row.table_id,
    customerId: row.customer_id,
    discountCents: row.discount_cents,
    note: row.note,
    items: parseJson(row.items_json, []),
    createdBy: row.created_by,
  }
}

// ─── AUDIT LOGS ──────────────────────────────────────────────────────────────
function auditLogsToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    action: v.action || '',
    entity_id: v.entityId || null,
    actor_id: v.actorId || null,
    details_json: toJson(v.details || {}),
    created_at: toIso(v.createdAt) || now(),
    sync_status: v.syncStatus || 'pending',
  }
}
function auditLogsFromRow(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    action: row.action,
    entityId: row.entity_id,
    actorId: row.actor_id,
    details: parseJson(row.details_json, {}),
    // Expose common fields for existing UI (reason, amountCents, permissions, quantity)
    reason: parseJson(row.details_json, {}).reason,
    amountCents: parseJson(row.details_json, {}).amountCents,
    permissions: parseJson(row.details_json, {}).permissions,
    quantity: parseJson(row.details_json, {}).quantity,
    createdAt: row.created_at,
    syncStatus: row.sync_status,
  }
}

// ─── PRINTERS ─────────────────────────────────────────────────────────────────
function printersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    connection_type: v.connectionType || v.connection_type || 'network',
    ip_address: v.ipAddress || v.ip_address || '',
    port: typeof v.port === 'number' ? v.port : 9100,
    paper_width: typeof v.paperWidth === 'number' ? v.paperWidth : (typeof v.paper_width === 'number' ? v.paper_width : 80),
    copies: typeof v.copies === 'number' ? v.copies : 1,
    auto_print: v.autoPrint || v.auto_print ? 1 : 0,
    is_default: v.isDefault || v.is_default ? 1 : 0,
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
  }
}
function printersFromRow(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    name: row.name,
    connectionType: row.connection_type,
    ipAddress: row.ip_address,
    port: row.port,
    paperWidth: row.paper_width,
    copies: row.copies,
    autoPrint: row.auto_print === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── WAITERS ─────────────────────────────────────────────────────────────────
function waitersToRow(restaurantId, id, v) {
  return {
    id,
    restaurant_id: restaurantId,
    name: v.name || '',
    phone: v.phone || '',
    status: v.status || 'active',
    created_at: toIso(v.createdAt) || now(),
    updated_at: now(),
    deleted_at: v.deletedAt ? toIso(v.deletedAt) : null,
    sync_status: v.syncStatus || 'synced',
    version: (v.version || 0) + 1,
  }
}
function waitersFromRow(row) {
  return {
    ...baseFrom(row),
    name: row.name,
    phone: row.phone,
    status: row.status,
  }
}

// ─── COLLECTION REGISTRY ─────────────────────────────────────────────────────
const REGISTRY = {
  settings:        { table: 'settings',        toRow: settingsToRow,        fromRow: settingsFromRow        },
  categories:      { table: 'categories',      toRow: categoriesToRow,      fromRow: categoriesFromRow      },
  menuItems:       { table: 'menu_items',      toRow: menuItemsToRow,       fromRow: menuItemsFromRow       },
  tables:          { table: 'tables',          toRow: tablesToRow,          fromRow: tablesFromRow          },
  reservations:    { table: 'reservations',    toRow: reservationsToRow,    fromRow: reservationsFromRow    },
  orders:          { table: 'orders',          toRow: ordersToRow,          fromRow: ordersFromRow          },
  orderFinancials: { table: 'order_financials',toRow: orderFinancialsToRow, fromRow: orderFinancialsFromRow },
  payments:        { table: 'payments',        toRow: paymentsToRow,        fromRow: paymentsFromRow        },
  customers:       { table: 'customers',       toRow: customersToRow,       fromRow: customersFromRow       },
  waiters:         { table: 'waiters',         toRow: waitersToRow,         fromRow: waitersFromRow         },
  inventory:       { table: 'inventory',       toRow: inventoryToRow,       fromRow: inventoryFromRow       },
  inventoryItems:  { table: 'inventory',       toRow: inventoryToRow,       fromRow: inventoryFromRow       },
  stockMovements:  { table: 'stock_movements', toRow: stockMovementsToRow,  fromRow: stockMovementsFromRow  },
  suppliers:       { table: 'suppliers',       toRow: suppliersToRow,       fromRow: suppliersFromRow       },
  purchases:       { table: 'purchases',       toRow: purchasesToRow,       fromRow: purchasesFromRow       },
  expenses:        { table: 'expenses',        toRow: expensesToRow,        fromRow: expensesFromRow        },
  draftOrders:     { table: 'draft_orders',    toRow: draftOrdersToRow,     fromRow: draftOrdersFromRow     },
  auditLogs:       { table: 'audit_logs',      toRow: auditLogsToRow,       fromRow: auditLogsFromRow       },
  printers:        { table: 'printers',        toRow: printersToRow,        fromRow: printersFromRow        },
}

function getEntry(collection) {
  const entry = REGISTRY[collection]
  if (!entry) throw new Error(`Unknown collection: ${collection}`)
  return entry
}

module.exports = { REGISTRY, getEntry }
