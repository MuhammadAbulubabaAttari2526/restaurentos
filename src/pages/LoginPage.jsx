import { useState } from 'react'
import { sendPasswordResetEmail } from 'firebase/auth'
import { ArrowRight, Eye, EyeOff, Utensils } from 'lucide-react'
import { toast } from 'sonner'
import './auth.css'
import { auth, firebaseConfigured, firebaseConfigError } from '../lib/firebase.js'
import { useAuth } from '../context/useAuth.js'
import { friendlyError } from '../utils/domain.js'

export function LoginPage() {
  const { login, enterDemo } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    try {
      await login(email.trim(), password)
    } catch (error) {
      toast.error(friendlyError(error))
    } finally {
      setBusy(false)
    }
  }

  async function resetPassword() {
    if (!email.trim()) return toast.error('Enter your email address first.')
    try {
      await sendPasswordResetEmail(auth, email.trim())
      toast.success('If that account exists, a reset link is on its way.')
    } catch (error) {
      toast.error(friendlyError(error))
    }
  }

  return (
    <main className="login-screen auth-login-screen">
      <div className="login-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-stamp"><Utensils size={32} /><span>GOOD FOOD<br />GOOD SERVICE</span></div><div className="art-caption"><span>HOSPITALITY, IN RHYTHM</span><strong>Your whole restaurant,<br />working as one.</strong></div></div>
      <section className="login-panel"><div className="login-brand"><div className="brand-mark"><Utensils size={19} /></div><strong>RestaurantOS</strong></div><div className="login-copy"><p className="eyebrow">SIGN IN</p><h1>Welcome<br />back.</h1><p>Sign in to your owner or team account.</p></div>
        {!firebaseConfigured && <div className="config-notice" role="status"><strong>Firebase setup needed</strong><span>{firebaseConfigError}. Copy the template values into .env.local and restart the app.</span></div>}
        <form className="login-form" onSubmit={submit}>
          <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@restaurant.com" /></label>
          <label>Password<div className="password-wrap"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          <button className="button button-primary login-submit" type="submit" disabled={busy || !firebaseConfigured}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} /></button>
        </form><button className="text-button reset-link" onClick={resetPassword} disabled={!firebaseConfigured}>Forgot password?</button>
        <div className="demo-entry"><span>Just looking around?</span><button className="button button-subtle" type="button" onClick={enterDemo}>Open sample workspace</button><small>Uses sample data only. Changes reset when you leave this session.</small></div>
        <div className="login-footnote">Restaurant owners are provisioned by an authorized administrator. Team members join with their email invitation.</div>
      </section>
    </main>
  )
}
