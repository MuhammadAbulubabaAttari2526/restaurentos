import { Link, Navigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { publicAssetUrl } from '../utils/publicAssetUrl.js'

export function SignupPage() {
  const { user, membership, logout } = useAuth()
  const logoUrl = publicAssetUrl('logo.jpg')
  const home = {
    owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos',
  }[membership?.role]

  if (user && membership) return <Navigate to={home || '/login'} replace />

  return (
    <main className="login-screen signup-screen">
      <div className="login-art" aria-hidden="true">
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-stamp"><img src={logoUrl} alt="" className="art-stamp-logo" /><span>SMART · FAST<br />COMPLETE</span></div>
        <div className="art-caption"><span>HOSPITALITY, IN RHYTHM</span><strong>Your whole restaurant,<br />working as one.</strong></div>
      </div>
      <section className="login-panel">
        <Link to="/" className="login-brand" aria-label="RestaurantOS home"><img className="brand-mark" src={logoUrl} alt="RestaurantOS" /><strong>RestaurantOS</strong></Link>
        <div className="login-copy">
          <p className="eyebrow">SECURE OWNER SETUP</p>
          <h1>Owner access<br />is provisioned.</h1>
          <p>An authorized administrator provisions the first owner account. Public signup cannot grant restaurant ownership.</p>
        </div>
        {user && <div className="form-helper" role="status">Signed in as {user.email}, but this account has no restaurant access yet. Contact the administrator who invited you.</div>}
        <div className="login-footnote">Staff accounts can be created only from an owner invitation. First-owner setup instructions are in the project README.</div>
        <div className="login-form">
          {user && <button className="text-button reset-link" type="button" onClick={logout}>Sign out</button>}
          <Link className="button button-primary login-submit" to="/login">Return to sign in<ArrowRight size={17} /></Link>
        </div>
      </section>
    </main>
  )
}
