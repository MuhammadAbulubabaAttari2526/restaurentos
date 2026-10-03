import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'

const rulesTest = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip

rulesTest('Firestore tenant and role rules', () => {
  let environment

  beforeAll(async () => {
    const [host, rawPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':')
    const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8')
    environment = await initializeTestEnvironment({
      projectId: 'demo-restaurantos',
      firestore: { host, port: Number(rawPort), rules },
    })
    await environment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore()
      await setDoc(doc(database, 'restaurants/alpha/users/owner-1'), { role: 'owner', active: true })
      await setDoc(doc(database, 'restaurants/alpha/users/waiter-1'), { role: 'waiter', active: true })
      await setDoc(doc(database, 'restaurants/alpha/users/cashier-1'), { role: 'cashier', active: true })
      await setDoc(doc(database, 'restaurants/alpha/menuItems/soup'), { name: 'Soup', priceCents: 900, available: true })
      await setDoc(doc(database, 'restaurants/alpha/orders/order-1'), { orderNumber: 'R-001', status: 'queued' })
      await setDoc(doc(database, 'restaurants/alpha/orderFinancials/order-1'), { totalCents: 900, paymentStatus: 'unpaid' })
      await setDoc(doc(database, 'restaurants/alpha/customers/customer-1'), { name: 'Guest', visitCount: 3, totalSpendingCents: 12500 })
      await setDoc(doc(database, 'restaurants/alpha/inventory/flour'), { name: 'Flour', unit: 'kg', quantityOnHand: 10, reorderLevel: 2, averageCostCents: 100 })
      await setDoc(doc(database, 'restaurants/alpha/draftOrders/waiter-draft'), { createdBy: 'waiter-1', status: 'draft', createdAt: new Date() })
      await setDoc(doc(database, 'restaurants/alpha/draftOrders/cashier-draft'), { createdBy: 'cashier-1', status: 'draft', createdAt: new Date() })
      await setDoc(doc(database, 'restaurants/beta/menuItems/soup'), { name: 'Other soup', priceCents: 100, available: true })
    })
  })

  afterAll(async () => environment?.cleanup())

  function user(uid, role, restaurantId = 'alpha') {
    return environment.authenticatedContext(uid, { restaurantId, role }).firestore()
  }

  it('isolates each restaurant from other tenants', async () => {
    await assertSucceeds(getDoc(doc(user('waiter-1', 'waiter'), 'restaurants/alpha/menuItems/soup')))
    await assertFails(getDoc(doc(user('waiter-1', 'waiter'), 'restaurants/beta/menuItems/soup')))
  })

  it('does not allow a public account to create an owner membership or restaurant', async () => {
    const browser = environment.authenticatedContext('self-owner', {
      restaurantId: 'alpha', role: 'owner', email_verified: true, email: 'owner@example.test',
    }).firestore()
    await assertFails(setDoc(doc(browser, 'accountMemberships/self-owner'), {
      restaurantId: 'alpha', role: 'owner', active: true, createdAt: serverTimestamp(),
    }))
    await assertFails(setDoc(doc(browser, 'restaurants/new-restaurant'), {
      restaurantId: 'new-restaurant', name: 'Untrusted Restaurant', createdAt: serverTimestamp(),
    }))
    await assertFails(setDoc(doc(browser, 'restaurants/alpha/users/self-owner'), {
      role: 'owner', active: true, permissions: [], createdAt: serverTimestamp(),
    }))
  })

  it('hides finance from waiters and denies removed kitchen ticket paths', async () => {
    await assertFails(getDoc(doc(user('waiter-1', 'waiter'), 'restaurants/alpha/orderFinancials/order-1')))
    await assertFails(getDoc(doc(user('waiter-1', 'waiter'), 'restaurants/alpha/kitchenTickets/order-1')))
    await assertFails(getDocs(collection(user('waiter-1', 'waiter'), 'restaurants/alpha/kitchenTickets')))
  })

  it('allows owners to soft-remove non-owner staff and prevents removing the owner', async () => {
    const owner = user('owner-1', 'owner')
    const waiterRef = doc(owner, 'restaurants/alpha/users/waiter-1')
    await assertSucceeds(updateDoc(waiterRef, {
      active: false, removedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }))
    await assertFails(updateDoc(doc(owner, 'restaurants/alpha/users/owner-1'), {
      active: false, removedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }))
  })

  it('allows cashier reads and blocks browser writes to orders and payments', async () => {
    const cashier = user('cashier-1', 'cashier')
    await assertSucceeds(getDoc(doc(cashier, 'restaurants/alpha/orderFinancials/order-1')))
    const waiter = user('waiter-1', 'waiter')
    await assertFails(setDoc(doc(waiter, 'restaurants/alpha/orders/forged'), { status: 'served' }))
    await assertFails(setDoc(doc(waiter, 'restaurants/alpha/payments/forged'), { amountCents: 1 }))
    await assertFails(setDoc(doc(cashier, 'restaurants/alpha/payments/unlinked'), {
      restaurantId: 'alpha', orderId: 'order-1', amountCents: 100, method: 'cash', reference: '',
      kind: 'payment', recordedBy: 'cashier-1', createdAt: serverTimestamp(),
    }))
    await assertFails(updateDoc(doc(cashier, 'restaurants/alpha/orderFinancials/order-1'), {
      paidCents: 900, paymentStatus: 'paid', lastPaymentId: 'unlinked', updatedAt: serverTimestamp(),
    }))
    await assertFails(setDoc(doc(user('owner-1', 'owner'), 'restaurants/alpha/orderFinancials/order-1'), { totalCents: 1 }))
  })

  it('requires an order and finance row to be created atomically', async () => {
    const cashier = user('cashier-1', 'cashier')
    const timestamp = serverTimestamp()
    const order = {
      restaurantId: 'alpha', orderNumber: 'R-002', type: 'direct-bill', tableId: null, tableName: '', note: '',
      items: [{ itemId: 'soup', name: 'Soup', quantity: 1, note: '', selectedVariant: null, selectedAddOns: [] }],
      status: 'queued', paymentStatus: 'unpaid', createdBy: 'cashier-1', createdAt: timestamp, updatedAt: timestamp,
    }
    const finance = {
      restaurantId: 'alpha', orderId: 'atomic-order', customerId: null,
      items: [{ itemId: 'soup', name: 'Soup', categoryId: 'soups', categoryName: 'Soup & starters', quantity: 1, unitPriceCents: 900 }],
      subtotalCents: 900, discountCents: 0, taxCents: 0, totalCents: 900,
      paidCents: 0, refundedCents: 0, customerVisitCounted: false,
      status: 'active', paymentStatus: 'unpaid', createdAt: timestamp, updatedAt: timestamp,
    }
    await assertFails(setDoc(doc(cashier, 'restaurants/alpha/orders/orphan-order'), { ...order, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))

    const batch = writeBatch(cashier)
    batch.set(doc(cashier, 'restaurants/alpha/orders/atomic-order'), order)
    batch.set(doc(cashier, 'restaurants/alpha/orderFinancials/atomic-order'), finance)
    await assertSucceeds(batch.commit())

    const orderRef = doc(cashier, 'restaurants/alpha/orders/atomic-order')
    const financeRef = doc(cashier, 'restaurants/alpha/orderFinancials/atomic-order')
    await assertFails(updateDoc(orderRef, { paymentStatus: 'paid', updatedAt: serverTimestamp() }))
    const paymentBatch = writeBatch(cashier)
    paymentBatch.set(doc(cashier, 'restaurants/alpha/payments/atomic-payment'), {
      restaurantId: 'alpha', orderId: 'atomic-order', amountCents: 900, method: 'cash', reference: '',
      kind: 'payment', recordedBy: 'cashier-1', createdAt: serverTimestamp(),
    })
    paymentBatch.update(financeRef, {
      paidCents: 900, paymentStatus: 'paid', customerVisitCounted: true,
      lastPaymentId: 'atomic-payment', updatedAt: serverTimestamp(),
    })
    paymentBatch.update(orderRef, { paymentStatus: 'paid', updatedAt: serverTimestamp() })
    await assertSucceeds(paymentBatch.commit())
  })

  it('requires every stock quantity change to match a manager movement record', async () => {
    const owner = user('owner-1', 'owner')
    const stockRef = doc(owner, 'restaurants/alpha/inventory/flour')
    await assertFails(updateDoc(stockRef, { quantityOnHand: 99, updatedAt: serverTimestamp() }))
    await assertFails(setDoc(doc(owner, 'restaurants/alpha/stockMovements/unlinked'), {
      restaurantId: 'alpha', ingredientId: 'flour', itemName: 'Flour', unit: 'kg',
      movementType: 'receive', quantity: 2, reason: 'Unlinked receipt', createdBy: 'owner-1', createdAt: serverTimestamp(),
    }))

    const batch = writeBatch(owner)
    batch.update(stockRef, { quantityOnHand: 12, lastMovementId: 'flour-receipt', updatedAt: serverTimestamp() })
    batch.set(doc(owner, 'restaurants/alpha/stockMovements/flour-receipt'), {
      restaurantId: 'alpha', ingredientId: 'flour', itemName: 'Flour', unit: 'kg',
      movementType: 'receive', quantity: 2, reason: 'Opening receipt', createdBy: 'owner-1', createdAt: serverTimestamp(),
    })
    await assertSucceeds(batch.commit())

    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'restaurants/alpha/orders/cancelled-order'), {
        status: 'preparing', createdBy: 'owner-1',
      })
    })
    const restockBatch = writeBatch(owner)
    restockBatch.update(doc(owner, 'restaurants/alpha/orders/cancelled-order'), {
      status: 'cancelled', cancellationReason: 'Guest changed plans', cancelledBy: 'owner-1', updatedAt: serverTimestamp(),
    })
    restockBatch.update(stockRef, { quantityOnHand: 14, lastMovementId: 'cancel-restock', updatedAt: serverTimestamp() })
    restockBatch.set(doc(owner, 'restaurants/alpha/stockMovements/cancel-restock'), {
      restaurantId: 'alpha', ingredientId: 'flour', itemName: 'Flour', unit: 'kg',
      movementType: 'order_cancel_restock', quantity: 2, reason: 'Order cancelled',
      orderId: 'cancelled-order', createdBy: 'owner-1', createdAt: serverTimestamp(),
    })
    await assertSucceeds(restockBatch.commit())
  })

  it('limits drafts to their creator and prevents forged customer rollups', async () => {
    const waiter = user('waiter-1', 'waiter')
    const draftRef = doc(waiter, 'restaurants/alpha/draftOrders/direct-bill-draft')
    await assertSucceeds(setDoc(draftRef, {
      restaurantId: 'alpha', createdBy: 'waiter-1', status: 'draft', type: 'direct-bill',
      tableId: null, customerId: null, note: '', items: [{ itemId: 'soup', quantity: 1 }],
      discountCents: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }))
    const savedDraft = await getDoc(draftRef)
    await assertSucceeds(updateDoc(draftRef, { note: 'Updated draft', createdAt: savedDraft.data().createdAt }))
    await assertFails(updateDoc(draftRef, { createdAt: serverTimestamp() }))
    const ownDrafts = query(collection(waiter, 'restaurants/alpha/draftOrders'), where('createdBy', '==', 'waiter-1'))
    await assertSucceeds(getDocs(ownDrafts))
    await assertFails(getDocs(collection(waiter, 'restaurants/alpha/draftOrders')))
    await assertFails(getDoc(doc(waiter, 'restaurants/alpha/draftOrders/cashier-draft')))
    const cashier = user('cashier-1', 'cashier')
    await assertSucceeds(getDoc(doc(cashier, 'restaurants/alpha/customers/customer-1')))
    await assertFails(updateDoc(doc(cashier, 'restaurants/alpha/customers/customer-1'), { totalSpendingCents: 1 }))
    const cashierDraftRef = doc(cashier, 'restaurants/alpha/draftOrders/cashier-owned-draft')
    await assertSucceeds(setDoc(cashierDraftRef, {
      restaurantId: 'alpha', createdBy: 'cashier-1', status: 'draft', type: 'direct-bill',
      tableId: null, customerId: null, note: '', items: [{ itemId: 'soup', quantity: 1 }],
      discountCents: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }))
    await assertSucceeds(deleteDoc(cashierDraftRef))
  })
})
