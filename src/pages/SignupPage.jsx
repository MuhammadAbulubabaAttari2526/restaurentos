import { Link, Navigate } from 'react-router-dom'
import { ArrowRight, Utensils } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { firebaseConfigured, firebaseConfigError } from '../lib/firebase.js'

export function SignupPage() {
  const { user, membership, logout } = useAuth()
  const home = {
    owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos',
  }[membership?.role]

  if (user && membership) return <Navigate to={home || '/login'} replace />

  return (
    <main className="login-screen signup-screen">
      <div className="login-art" aria-hidden="true">
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-stamp"><Utensils size={32} /><span>GOOD FOOD<br />GOOD SERVICE</span></div>
        <div className="art-caption"><span>HOSPITALITY, IN RHYTHM</span><strong>Your whole restaurant,<br />working as one.</strong></div>
      </div>
      <section className="login-panel">
        <div className="login-brand"><div className="brand-mark"><Utensils size={19} /></div><strong>RestaurantOS</strong></div>
        <div className="login-copy">
          <p className="eyebrow">SECURE OWNER SETUP</p>
          <h1>Owner access<br />is provisioned.</h1>
          <p>A verified Firebase administrator must create the first owner account. Public signup cannot grant restaurant ownership.</p>
        </div>
        {!firebaseConfigured && <div className="config-notice" role="status"><strong>Firebase setup needed</strong><span>{firebaseConfigError}. Copy the template values into .env.local and restart the app.</span></div>}
        {user && <div className="form-helper" role="status">Signed in as {user.email}, but this account has no restaurant access yet. Contact the administrator who invited you.</div>}
        <div className="login-footnote">Staff accounts can be created only from an owner invitation sent to their email. First-owner setup instructions are in the project README.</div>
        <div className="login-form">
          {user && <button className="text-button reset-link" type="button" onClick={logout}>Sign out</button>}
          <Link className="button button-primary login-submit" to="/login">Return to sign in<ArrowRight size={17} /></Link>
        </div>
      </section>
    </main>
  )
}
