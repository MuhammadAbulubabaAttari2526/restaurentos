import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  ChartNoAxesColumnIncreasing,
  ClipboardList,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Table2,
  UsersRound,
} from 'lucide-react'
import { toast } from 'sonner'
import './auth.css'
import { useAuth } from '../context/useAuth.js'
import { friendlyError } from '../utils/domain.js'
import { publicAssetUrl } from '../utils/publicAssetUrl.js'

const loginFeatures = [
  { icon: ClipboardList, title: 'POS & Billing', detail: 'Fast, accurate transactions' },
  { icon: Table2, title: 'Table Management', detail: 'A better guest flow' },
  { icon: ChartNoAxesColumnIncreasing, title: 'Inventory Control', detail: 'Track stock in real time' },
  { icon: UsersRound, title: 'Staff Management', detail: 'Keep your team in sync' },
]

export function LoginPage() {
  const { login, enterDemo } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const logoUrl = publicAssetUrl('restaurantos-mark.png')

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
      <header className="login-topbar">
        <Link to="/" className="login-hero-brand" aria-label="RestaurantOS home">
          <img src={logoUrl} alt="" />
          <span><strong>RestaurantOS</strong></span>
        </Link>
        <nav aria-label="Page navigation">
          <a href="#overview" aria-current="page">Home</a>
          <a href="#features">Features</a>
          <a href="#about">About</a>
          <a href="#contact">Contact</a>
        </nav>
        <button className="login-topbar-cta" type="button" onClick={enterDemo}>
          Explore sample <ArrowRight size={16} />
        </button>
      </header>

      <section className="login-art" aria-label="RestaurantOS restaurant management overview">
        <div className="login-hero-content">
          <div className="login-hero-copy" id="overview">
            <p className="login-hero-eyebrow">SMART POS FOR MODERN RESTAURANTS</p>
            <h2>Your whole<br /><em>restaurant,</em><br />working as one.</h2>
            <p className="login-hero-description" id="about">From the first order to end-of-day reports, keep your team, tables and stock moving together in one simple system.</p>

            <div className="login-feature-grid" id="features">
              {loginFeatures.map(({ icon: Icon, title, detail }) => (
                <div className="login-feature" key={title}>
                  <span className="login-feature-icon"><Icon size={19} strokeWidth={1.8} /></span>
                  <span><strong>{title}</strong><small>{detail}</small></span>
                </div>
              ))}
            </div>
            <button className="login-hero-demo" type="button" onClick={enterDemo}>
              Explore sample workspace <ArrowRight size={17} />
            </button>
          </div>
        </div>
        <p className="login-hero-footer">Good food. <em>Better business.</em></p>
      </section>

      <section className="login-panel" id="sign-in">
        <Link to="/" className="login-brand" aria-label="RestaurantOS home">
          <img className="brand-mark" src={logoUrl} alt="" />
          <strong>RestaurantOS</strong>
        </Link>
        <div className="login-copy">
          <p className="eyebrow">SIGN IN</p>
          <h1>Welcome <em>back.</em></h1>
          <p>Sign in to your account to continue to your restaurant dashboard.</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>Email address
            <span className="login-input-wrap"><Mail size={19} aria-hidden="true" /><input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@restaurant.com" /></span>
          </label>
          <label>Password
            <span className="login-input-wrap password-wrap"><LockKeyhole size={19} aria-hidden="true" /><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></span>
          </label>
          <button className="button button-primary login-submit" type="submit" disabled={busy}>
            <span>{busy ? 'Signing in…' : 'Sign in'}</span><ArrowRight size={21} />
          </button>
        </form>

        <p className="login-reset-copy">Forgot your password? <span>Contact your restaurant owner.</span></p>
        <div className="login-demo-divider"><span />OR<span /></div>
        <button className="login-sample-link" type="button" onClick={enterDemo}>
          Open sample workspace
        </button>
        <p className="login-sample-note">Sample data only. Changes reset when you leave.</p>
        <div className="login-footnote" id="contact"><strong>Need access?</strong> Restaurant owners are set up by an authorized administrator. Team members can join with an invitation link from their owner.</div>
      </section>
    </main>
  )
}
