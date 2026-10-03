import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App.jsx'
import { AuthProvider } from '../context/AuthContext.jsx'
import { mergeOrderWithFinancials } from '../utils/orderMerge.js'
import { activateDemoSession, clearDemoSession, runDemoOperation, saveDemoRecord } from '../services/demoData.js'
import * as dataOperations from '../services/data.js'
import { readPosDraft, writePosDraft } from '../utils/posDraftStorage.js'

afterEach(() => {
  cleanup()
  clearDemoSession()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

function renderApp(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('authentication routes', () => {
  it('redirects a protected page to sign in when no session exists', async () => {
    renderApp('/orders')
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument()
  })

  it('offers sign in and a separate sample workspace without public owner signup', async () => {
    renderApp('/login')
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open sample workspace/i })).toBeInTheDocument()
    expect(screen.getByText(/sample data only/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /create an account/i })).not.toBeInTheDocument()
  })

  it('explains that first-owner access is provisioned by an administrator', async () => {
    renderApp('/signup')
    expect(await screen.findByText(/secure owner setup/i)).toBeInTheDocument()
    expect(screen.getByText(/public signup cannot grant restaurant ownership/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create owner account/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resend verification/i })).not.toBeInTheDocument()
  })

  it('opens the sample dashboard without Firebase credentials', async () => {
    renderApp('/login')
    fireEvent.click(await screen.findByRole('button', { name: /open sample workspace/i }))
    expect(await screen.findByText(/demo.*sample data/i)).toBeInTheDocument()
    expect(await screen.findByRole('navigation', { name: /main navigation/i })).toBeInTheDocument()
    expect(await screen.findByText('Cedar & Sage')).toBeInTheDocument()
  })

  it('closes the mobile navigation with Escape and restores focus', async () => {
    renderApp('/login')
    fireEvent.click(await screen.findByRole('button', { name: /open sample workspace/i }))
    const menuButton = await screen.findByRole('button', { name: /open navigation/i })

    expect(menuButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(menuButton)
    expect(menuButton).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelector('.sidebar-close')).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(menuButton).toHaveAttribute('aria-expanded', 'false')
    expect(menuButton).toHaveFocus()
  })

  it('shows a delete action for non-owner staff members in the staff table', async () => {
    activateDemoSession()
    renderApp('/staff')

    expect(await screen.findByRole('button', { name: /delete/i })).toBeInTheDocument()
  })

  it('hides removed staff and lets the owner re-enable disabled staff', async () => {
    activateDemoSession()
    await runDemoOperation('setStaffActive', { userId: 'demo-cashier', active: false })
    await runDemoOperation('deleteStaffMember', { userId: 'demo-waiter' })
    renderApp('/staff')

    expect(await screen.findByText('Bilal Shah')).toBeInTheDocument()
    expect(screen.queryByText('Mariam Iqbal')).not.toBeInTheDocument()
    const disabledRow = screen.getByText('Bilal Shah').closest('tr')
    fireEvent.click(within(disabledRow).getByRole('button', { name: /enable access/i }))
    expect(await within(disabledRow).findByText('Active')).toBeInTheDocument()
  })

  it('saves a new menu item as available when the availability field is untouched', async () => {
    activateDemoSession()
    renderApp('/menu')

    fireEvent.click(await screen.findByRole('button', { name: /add menu item/i }))
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Availability regression item' } })
    fireEvent.change(screen.getByLabelText('Base price'), { target: { value: '1.00' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'mains' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const item = await screen.findByText('Availability regression item')
    expect(item.closest('tr')).toHaveTextContent('Available')
    expect(item.closest('tr')).not.toHaveTextContent('Unavailable')
  })

  it('shows owners only drafts they created in the POS draft list', async () => {
    activateDemoSession()
    saveDemoRecord('draftOrders', { createdBy: 'other-user', type: 'delivery' }, null)
    renderApp('/pos')

    const drafts = await screen.findByLabelText('Saved drafts')
    expect(within(drafts).queryByRole('option', { name: /delivery/i })).not.toBeInTheDocument()
  })

  it('shows a latest-N notice when the POS draft list reaches its limit', async () => {
    activateDemoSession()
    for (let index = 0; index < 50; index += 1) {
      saveDemoRecord('draftOrders', { createdBy: 'demo-owner', type: 'takeaway' }, null)
    }
    renderApp('/pos')

    expect(await screen.findByText('Showing latest 50 draft orders.')).toBeInTheDocument()
  })

  it('shows a warning when an exported report is truncated', async () => {
    activateDemoSession()
    vi.spyOn(dataOperations, 'exportReport').mockResolvedValue({
      range: 'week', truncated: true,
      summary: { grossSalesCents: 0, refundsCents: 0, discountsCents: 0, expenseCents: 0 },
      rows: [], itemRows: [], categoryRows: [], paymentRows: [], expenseRows: [],
    })
    renderApp('/reports')

    fireEvent.click((await screen.findAllByRole('button', { name: /run report/i }))[0])

    expect(await screen.findByRole('alert')).toHaveTextContent(/report reached a result limit/i)
  })

  it('prints the saved dine-in receipt with one variant, both add-ons and saved totals', async () => {
    activateDemoSession()
    saveDemoRecord('menuItems', {
      addOns: [
        { id: 'fries', name: 'Add fries', priceCents: 28000 },
        { id: 'cheese', name: 'Extra cheese', priceCents: 15000 },
      ],
    }, 'beef-burger')
    const createOrder = vi.spyOn(dataOperations, 'createOrder').mockResolvedValue({
      orderId: 'saved-receipt-order', orderNumber: 'R-SAVED', subtotalCents: 198765,
      discountCents: 0, taxCents: 4321, totalCents: 203086,
    })
    renderApp({ pathname: '/pos', state: { tableId: 'table-1' } })

    fireEvent.click(await screen.findByRole('button', { name: /house beef burger/i }))
    fireEvent.click(screen.getByRole('radio', { name: /double patty/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /add fries/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /extra cheese/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    fireEvent.click(screen.getByRole('button', { name: /create order/i }))

    const receipt = await screen.findByRole('dialog', { name: /ready to print/i })
    expect(receipt).toHaveTextContent('Table 1')
    expect(receipt).toHaveTextContent('Double patty · Add fries · Extra cheese')
    expect([...receipt.textContent.matchAll(/Add fries/g)]).toHaveLength(1)
    expect([...receipt.textContent.matchAll(/Extra cheese/g)]).toHaveLength(1)
    expect(receipt).toHaveTextContent('Rs. 1,987.65')
    expect(receipt).toHaveTextContent('Rs. 2,030.86')
    expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'dine-in', tableId: 'table-1' }))
  })

  it('supports direct bill mode and adding by Enter in the point of sale flow', async () => {
    activateDemoSession()
    renderApp('/pos')

    expect(await screen.findByPlaceholderText(/search menu items/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^direct bill$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dine-in/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /takeaway/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delivery/i })).not.toBeInTheDocument()

    const search = screen.getByPlaceholderText(/search menu items/i)
    fireEvent.change(search, { target: { value: 'lemonade' } })
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', charCode: 13 })

    expect(await screen.findByText(/1 items/i)).toBeInTheDocument()
  })

  it('keeps the order status from the order record instead of the finance record', () => {
    const order = { id: 'order-1', status: 'queued', orderNumber: 'R-001' }
    const finance = { id: 'order-1', status: 'active', paymentStatus: 'unpaid', totalCents: 500 }

    expect(mergeOrderWithFinancials(order, finance)).toMatchObject({
      id: 'order-1',
      status: 'queued',
      orderNumber: 'R-001',
      paymentStatus: 'unpaid',
      totalCents: 500,
    })
  })

  it('reuses an order requestId on retry and creates a fresh one after success', async () => {
    activateDemoSession()
    const createOrder = vi.spyOn(dataOperations, 'createOrder')
      .mockRejectedValueOnce(new Error('Temporary network failure'))
      .mockImplementation(async ({ requestId }) => ({
        orderId: requestId, orderNumber: 'R-RETRY', subtotalCents: 32000,
        discountCents: 0, taxCents: 0, totalCents: 32000,
      }))
    renderApp('/pos')

    fireEvent.click(await screen.findByRole('button', { name: /mint lemonade/i }))
    fireEvent.click(screen.getByRole('button', { name: /create order/i }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /create order/i }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))
    const firstRequestId = createOrder.mock.calls[0][0].requestId
    expect(createOrder.mock.calls[1][0].requestId).toBe(firstRequestId)

    fireEvent.click(await screen.findByRole('button', { name: /close receipt/i }))
    fireEvent.click(screen.getByRole('button', { name: /mint lemonade/i }))
    fireEvent.click(screen.getByRole('button', { name: /create order/i }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(3))
    expect(createOrder.mock.calls[2][0].requestId).not.toBe(firstRequestId)
  }, 20000)

  it('reuses a paymentId on retry and creates a fresh one after success', async () => {
    activateDemoSession()
    const recordPayment = vi.spyOn(dataOperations, 'recordPayment')
      .mockRejectedValueOnce(new Error('Temporary network failure'))
      .mockResolvedValue({ paymentId: 'payment-saved' })
    renderApp('/orders')

    const orderRow = (await screen.findByText('R-20261001-0011')).closest('tr')
    fireEvent.click(within(orderRow).getByRole('button', { name: /unpaid/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(2))
    const firstPaymentId = recordPayment.mock.calls[0][0].paymentId
    expect(recordPayment.mock.calls[1][0].paymentId).toBe(firstPaymentId)

    fireEvent.click(within(orderRow).getByRole('button', { name: /unpaid/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(3))
    expect(recordPayment.mock.calls[2][0].paymentId).not.toBe(firstPaymentId)
  }, 20000)

  it('reuses a refundId on retry and creates a fresh one after success', async () => {
    activateDemoSession()
    const recordRefund = vi.spyOn(dataOperations, 'recordRefund')
      .mockRejectedValueOnce(new Error('Temporary network failure'))
      .mockResolvedValue({ refundId: 'refund-saved' })
    renderApp('/orders')
    fireEvent.click(await screen.findByRole('button', { name: /filter orders/i }))
    fireEvent.click(screen.getByRole('button', { name: 'All orders' }))

    const orderRow = (await screen.findByText('R-20261001-0010')).closest('tr')
    fireEvent.click(within(orderRow).getByRole('button', { name: /^paid$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }))
    fireEvent.change(screen.getByLabelText('Refund reason'), { target: { value: 'Retry test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }))
    await waitFor(() => expect(recordRefund).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }))
    await waitFor(() => expect(recordRefund).toHaveBeenCalledTimes(2))
    const firstRefundId = recordRefund.mock.calls[0][0].refundId
    expect(recordRefund.mock.calls[1][0].refundId).toBe(firstRefundId)

    fireEvent.click(within(orderRow).getByRole('button', { name: /^paid$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }))
    fireEvent.change(screen.getByLabelText('Refund reason'), { target: { value: 'Retry test again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record refund' }))
    await waitFor(() => expect(recordRefund).toHaveBeenCalledTimes(3))
    expect(recordRefund.mock.calls[2][0].refundId).not.toBe(firstRefundId)
  }, 20000)

  it('persists POS drafts in local storage for reload recovery', () => {
    const key = 'restaurantos:pos-draft:local:restaurant-1:user-1'
    const draft = {
      version: 1,
      cart: [{ lineId: 'item-1:base:', itemId: 'item-1', name: 'Lemonade', unitPriceCents: 180, quantity: 2, note: '', selectedVariantId: null, selectedAddOnIds: [], optionLabel: '' }],
      orderType: 'takeaway',
      tableId: '',
      customerId: 'customer-1',
      note: 'No ice',
      discount: '5.00',
      activeDraftId: 'draft-1',
    }

    writePosDraft(key, draft)

    expect(readPosDraft(key)).toMatchObject({
      cart: draft.cart,
      orderType: 'takeaway',
      customerId: 'customer-1',
      note: 'No ice',
      activeDraftId: 'draft-1',
    })
  })
})
