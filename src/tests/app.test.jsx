import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../App.jsx'
import { AuthProvider } from '../context/AuthContext.jsx'
import { createStableIntentId } from '../utils/idUtils.js'
import { mergeOrderWithFinancials } from '../utils/orderMerge.js'
import { activateDemoSession, clearDemoSession } from '../services/demoData.js'
import { readPosDraft, writePosDraft } from '../utils/posDraftStorage.js'

afterEach(() => {
  cleanup()
  clearDemoSession()
  window.localStorage.clear()
  window.sessionStorage.clear()
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

  it('reuses the same stable ID for a single user intent until the action succeeds', () => {
    const first = createStableIntentId('order')
    const second = createStableIntentId('order')

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

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
