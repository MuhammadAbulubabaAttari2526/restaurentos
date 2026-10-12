import { useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context/useAuth.js'
import { LoginPage } from './pages/LoginPage.jsx'
import { SignupPage } from './pages/SignupPage.jsx'
import { JoinPage } from './pages/JoinPage.jsx'
import { AppLayout } from './components/layout/AppLayout.jsx'
import { NotFoundPage, OperationsPage } from './pages/OperationsPage.jsx'
import { UpdateNotifier } from './components/UpdateNotifier.jsx'
import './demo-mode.css'

const pageMetadata = {
  '/login': ['Sign in', 'Sign in to manage restaurant orders, staff, inventory and daily operations.'],
  '/signup': ['Owner setup', 'RestaurantOS owner accounts are provisioned by an authorized administrator.'],
  '/dashboard': ['Overview', 'Review today’s sales, orders, expenses and stock alerts in RestaurantOS.'],
  '/pos': ['Point of sale', 'Build restaurant orders, manage tickets and record payments in RestaurantOS.'],
  '/pos-window': ['Point of sale', 'Build restaurant orders, manage tickets and record payments in RestaurantOS.'],
  '/orders': ['Orders', 'Track restaurant order progress and record payments in RestaurantOS.'],
  '/tables': ['Tables', 'Manage restaurant tables, seating capacity and reservations in RestaurantOS.'],
  '/waiters': ['Waiters', 'Manage waiter details and assignments for restaurant orders.'],
  '/menu': ['Menu', 'Manage restaurant menu items, categories, prices and availability.'],
  '/inventory': ['Inventory', 'Track restaurant stock, recipes, suppliers and inventory movements.'],
  '/suppliers': ['Suppliers', 'Manage restaurant supplier contacts and purchasing details.'],
  '/purchases': ['Purchases', 'Create purchase orders and record received stock in RestaurantOS.'],
  '/expenses': ['Expenses', 'Record and review restaurant operating expenses.'],
  '/customers': ['Customers', 'Manage restaurant guest contacts and visit history.'],
  '/reports': ['Reports', 'Review restaurant sales, payments, refunds and expenses.'],
  '/staff': ['Staff', 'Manage restaurant team invitations, permissions and access.'],
  '/audit': ['Audit log', 'Review recorded restaurant operations and access changes.'],
  '/settings': ['Settings', 'Manage restaurant profile, tax and payment settings.'],
}

function PageMetadata() {
  const { pathname } = useLocation()

  useEffect(() => {
    const path = (pathname.replace(/\/+$/, '') || '/').toLowerCase()
    const metadata = path.startsWith('/join/')
      ? ['Join your restaurant', 'Accept your RestaurantOS team invitation and set up your account.']
      : pageMetadata[path] || ['Page not found', 'The requested RestaurantOS page could not be found.']
    document.title = `${metadata[0]} | RestaurantOS`
    const description = document.querySelector('meta[name="description"]')
    if (description) description.setAttribute('content', metadata[1])
  }, [pathname])

  return null
}

function ProtectedRoute({ children }) {
  const { user, membership, loading } = useAuth()
  if (loading) return <div className="screen-loading"><span className="spinner" />Checking your access</div>
  if (!user) return <Navigate to="/login" replace />
  if (!membership) return <div className="access-error">This account is not attached to a restaurant. Contact your owner.</div>
  return children
}

export default function App() {
  const { user, membership } = useAuth()
  const home = {
    owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos',
  }[membership?.role] || '/login'
  const standalonePosWindow = typeof window !== 'undefined'
    && (
      window.location.hash === '#/pos-window'
      || window.location.pathname === '/pos-window'
      || window.location.pathname.endsWith('/pos-window')
      || new URLSearchParams(window.location.search).get('window') === 'pos'
    )

  return (
    <>
      <UpdateNotifier />
      <PageMetadata />
      <Routes>
        <Route path="/login" element={user && membership ? <Navigate to={home} replace /> : user ? <Navigate to="/signup" replace /> : <LoginPage />} />
        <Route path="/signup" element={user && membership ? <Navigate to={home} replace /> : <SignupPage />} />
        <Route path="/join/:restaurantId/:invitationId" element={<JoinPage />} />
        <Route path="/kitchen" element={<ProtectedRoute><Navigate to="/orders" replace /></ProtectedRoute>} />
        <Route path="/pos-window" element={<ProtectedRoute>{standalonePosWindow ? <OperationsPage /> : <AppLayout><OperationsPage /></AppLayout>}</ProtectedRoute>} />
        <Route element={<ProtectedRoute><AppLayout><Outlet /></AppLayout></ProtectedRoute>}>
          <Route path="/dashboard" element={<OperationsPage />} />
          <Route path="/dashboard/pos-window" element={<OperationsPage />} />
          <Route path="/pos" element={<OperationsPage />} />
          <Route path="/orders" element={<OperationsPage />} />
          <Route path="/tables" element={<OperationsPage />} />
          <Route path="/waiters" element={<OperationsPage />} />
          <Route path="/menu" element={<OperationsPage />} />
          <Route path="/inventory" element={<OperationsPage />} />
          <Route path="/suppliers" element={<OperationsPage />} />
          <Route path="/purchases" element={<OperationsPage />} />
          <Route path="/expenses" element={<OperationsPage />} />
          <Route path="/customers" element={<OperationsPage />} />
          <Route path="/reports" element={<OperationsPage />} />
          <Route path="/staff" element={<OperationsPage />} />
          <Route path="/audit" element={<OperationsPage />} />
          <Route path="/settings" element={<OperationsPage />} />
        </Route>
        <Route path="/" element={<Navigate to={user ? home : '/login'} replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  )
}
