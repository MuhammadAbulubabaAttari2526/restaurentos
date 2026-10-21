import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import './auth.css'
import { useAuth } from '../context/useAuth.js'
import { friendlyError } from '../utils/domain.js'
import { publicAssetUrl } from '../utils/publicAssetUrl.js'

export function LoginPage() {
  const { login, enterDemo } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const logoUrl = publicAssetUrl('logo.jpg')

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

  return (
    <main className="login-screen auth-login-screen">
      <div className="login-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-stamp"><img src={logoUrl} alt="" className="art-stamp-logo" /><span>SMART · FAST<br />COMPLETE</span></div><div className="art-caption"><span>HOSPITALITY, IN RHYTHM</span><strong>Your whole restaurant,<br />working as one.</strong></div></div>
      <section className="login-panel"><Link to="/" className="login-brand" aria-label="RestaurantOS home"><img className="brand-mark" src={logoUrl} alt="RestaurantOS" /><strong>RestaurantOS</strong></Link><div className="login-copy"><p className="eyebrow">SIGN IN</p><h1>Welcome<br />back.</h1><p>Sign in to your owner or team account.</p></div>
        <form className="login-form" onSubmit={submit}>
          <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@restaurant.com" /></label>
          <label>Password<div className="password-wrap"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} /></button>
        </form><p className="text-button reset-link">Forgot your password? Contact your restaurant owner.</p>
        <div className="demo-entry"><span>Just looking around?</span><button className="button button-subtle" type="button" onClick={enterDemo}>Open sample workspace</button><small>Uses sample data only. Changes reset when you leave this session.</small></div>
        <div className="login-footnote">Restaurant owners are provisioned by an authorized administrator. Team members join with their invitation link.</div>
      </section>
    </main>
  )
}
