import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  BarChart3, ClipboardList, CreditCard, LayoutDashboard,
  History, LogOut, Menu, Package, Settings, ShoppingBasket,
  Store, Truck, Users, Utensils, Wallet, X,
} from 'lucide-react'
import { useAuth } from '../../context/useAuth.js'
import { watchRecords } from '../../services/data.js'

const links = [
  { label: 'Overview', path: '/dashboard', icon: LayoutDashboard, roles: ['owner', 'manager'] },
  { label: 'Point of sale', path: '/pos', icon: CreditCard, roles: ['owner', 'manager', 'cashier', 'waiter'] },
  { label: 'Orders', path: '/orders', icon: ClipboardList, roles: ['owner', 'manager', 'cashier', 'waiter'] },
  { label: 'Tables', path: '/tables', icon: Utensils, roles: ['owner', 'manager', 'cashier', 'waiter'] },
  { label: 'Menu', path: '/menu', icon: Store, roles: ['owner', 'manager'] },
  { label: 'Inventory', path: '/inventory', icon: Package, roles: ['owner', 'manager'] },
  { label: 'Suppliers', path: '/suppliers', icon: Truck, roles: ['owner', 'manager'] },
  { label: 'Purchases', path: '/purchases', icon: ShoppingBasket, roles: ['owner', 'manager'] },
  { label: 'Expenses', path: '/expenses', icon: Wallet, roles: ['owner', 'manager'] },
  { label: 'Customers', path: '/customers', icon: Users, roles: ['owner', 'manager', 'cashier'] },
  { label: 'Reports', path: '/reports', icon: BarChart3, roles: ['owner', 'manager'] },
  { label: 'Staff', path: '/staff', icon: Users, roles: ['owner'] },
  { label: 'Audit log', path: '/audit', icon: History, roles: ['owner'] },
  { label: 'Settings', path: '/settings', icon: Settings, roles: ['owner'] },
]

const pageNames = Object.fromEntries(links.map(({ path, label }) => [path, label]))

export function AppLayout({ children }) {
  const { user, membership, logout } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [restaurantName, setRestaurantName] = useState('')
  const location = useLocation()
  const role = membership?.role || 'staff'
  const visibleLinks = links.filter((link) => link.roles.includes(role))
  const menuButtonRef = useRef(null)
  const closeButtonRef = useRef(null)

  function closeDrawer() {
    setDrawerOpen(false)
  }

  useEffect(() => {
    const restaurantId = membership?.restaurantId
    if (!restaurantId) return undefined
    return watchRecords(restaurantId, 'settings', (records) => {
      const profile = records.find((record) => record.id === 'profile') || records[0]
      setRestaurantName(typeof profile?.name === 'string' ? profile.name : '')
    }, () => setRestaurantName(''), 10)
  }, [membership?.restaurantId])

  useEffect(() => {
    if (!drawerOpen) return undefined
    const previousOverflow = document.body.style.overflow
    const menuButton = menuButtonRef.current
    function handleKeyDown(event) {
      if (event.key === 'Escape') closeDrawer()
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      menuButton?.focus()
    }
  }, [drawerOpen])

  return (
    <div className="app-frame">
      {drawerOpen && <button className="drawer-scrim" aria-label="Close navigation" onClick={closeDrawer} />}
      <aside id="workspace-navigation" aria-label="Workspace navigation" className={`sidebar ${drawerOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><div className="brand-mark"><Utensils size={19} /></div><div><strong>RestaurantOS</strong><span>Operations</span></div><button ref={closeButtonRef} className="icon-button sidebar-close" aria-label="Close navigation" onClick={closeDrawer}><X size={19} /></button></div>
        <div className="restaurant-picker"><div className="restaurant-avatar">{(restaurantName || 'R').slice(0, 1).toUpperCase()}</div><div className="restaurant-label"><strong>{restaurantName || 'Restaurant'}</strong><span>{membership?.demo ? 'Sample workspace' : 'Restaurant workspace'}</span></div></div>
        <p className="nav-caption">WORKSPACE</p>
        <nav className="main-nav" aria-label="Main navigation">
          {visibleLinks.map(({ label, path, icon: Icon }) => (
            <NavLink key={path} to={path} onClick={closeDrawer} className={({ isActive }) => `nav-link ${isActive ? 'nav-active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom"><div className="help-panel"><div className="help-glyph">?</div><div><strong>Need a hand?</strong><span>Check setup guide</span></div></div><button className="profile-row" onClick={logout}><div className="profile-avatar">{(user?.email || 'U').slice(0, 1).toUpperCase()}</div><div className="profile-details"><strong>{user?.displayName || user?.email?.split('@')[0] || 'Team member'}</strong><span>{role}</span></div><LogOut size={17} /></button></div>
      </aside>
      <div className="main-column">
        <header className="topbar"><button ref={menuButtonRef} className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="workspace-navigation" onClick={() => setDrawerOpen(true)}><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{pageNames[location.pathname] || 'Restaurant operations'}</strong></div><div className="topbar-right"><span className={`service-status ${membership?.demo ? 'demo-status' : ''}`}><i /> {membership?.demo ? 'Demo · sample data' : 'Live workspace'}</span></div></header>
        <main className="page-content">{membership?.demo && <div className="demo-banner"><strong>Sample data only</strong><span>Changes reset when you sign out or refresh this tab.</span></div>}{children}</main>
      </div>
    </div>
  )
}
