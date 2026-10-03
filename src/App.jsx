import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './context/useAuth.js'
import { LoginPage } from './pages/LoginPage.jsx'
import { SignupPage } from './pages/SignupPage.jsx'
import { JoinPage } from './pages/JoinPage.jsx'
import { AppLayout } from './components/layout/AppLayout.jsx'
import { OperationsPage } from './pages/OperationsPage.jsx'
import './demo-mode.css'

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
  return (
    <Routes>
      <Route path="/login" element={user && membership ? <Navigate to={home} replace /> : user ? <Navigate to="/signup" replace /> : <LoginPage />} />
      <Route path="/signup" element={user && membership ? <Navigate to={home} replace /> : <SignupPage />} />
      <Route path="/join/:restaurantId/:invitationId" element={<JoinPage />} />
      <Route path="/kitchen" element={<ProtectedRoute><Navigate to="/orders" replace /></ProtectedRoute>} />
      <Route path="/" element={<Navigate to={user ? home : '/login'} replace />} />
      <Route path="/*" element={<ProtectedRoute><AppLayout><OperationsPage /></AppLayout></ProtectedRoute>} />
    </Routes>
  )
}
