import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  ChartNoAxesColumnIncreasing,
  ChefHat,
  ClipboardList,
  Eye,
  EyeOff,
  FlaskConical,
  LockKeyhole,
  Mail,
  Table2,
} from 'lucide-react'
import { toast } from 'sonner'
import './auth.css'
import { useAuth } from '../context/useAuth.js'
import { friendlyError } from '../utils/domain.js'
import { publicAssetUrl } from '../utils/publicAssetUrl.js'

const loginFeatures = [
  { icon: ClipboardList, title: 'POS & Billing', detail: 'Fast & reliable' },
  { icon: Table2, title: 'Table Management', detail: 'Dine in / takeout' },
  { icon: ChefHat, title: 'Inventory', detail: 'Track in real time' },
  { icon: ChartNoAxesColumnIncreasing, title: 'Reports & Analytics', detail: 'Grow smarter' },
]

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
      <section className="login-art" aria-label="RestaurantOS restaurant management overview">
        <Link to="/" className="login-hero-brand" aria-label="RestaurantOS home">
          <img src={logoUrl} alt="" />
          <span><strong>RestaurantOS</strong><small>SMART <i>·</i> FAST <i>·</i> COMPLETE</small></span>
        </Link>

        <div className="login-hero-content">
          <div className="login-hero-copy">
            <p className="login-hero-eyebrow">HOSPITALITY, IN RHYTHM</p>
            <h2>Your whole<br /><em>restaurant,</em><br />working as one.</h2>
            <p className="login-hero-description">Manage orders, tables, inventory, staff and more — all in one simple, powerful system.</p>

            <div className="login-feature-grid">
              {loginFeatures.map(({ icon: Icon, title, detail }) => (
                <div className="login-feature" key={title}>
                  <span className="login-feature-icon"><Icon size={19} strokeWidth={1.8} /></span>
                  <span><strong>{title}</strong><small>{detail}</small></span>
                </div>
              ))}
            </div>
          </div>

          <div className="login-hero-visual" aria-hidden="true">
            <p className="login-hero-script">Simple. Smart. Complete.</p>
            <div className="login-float-card login-float-chef"><ChefHat size={27} /></div>
            <div className="login-float-card login-float-chart"><ChartNoAxesColumnIncreasing size={28} /></div>
            <div className="login-device">
              <div className="login-device-top"><span className="login-device-brand"><i /> Restaurant</span><span>◦ &nbsp; ◦ &nbsp; ◦</span></div>
              <div className="login-device-body">
                <div className="login-device-nav"><i /><i /><i /><i /><i /></div>
                <div className="login-device-menu">
                  <div className="login-device-tabs"><b>All</b><span>Food</span><span>Drinks</span></div>
                  <div className="login-device-dishes">
                    <i /><i /><i /><i /><i /><i />
                  </div>
                  <div className="login-device-lines"><i /><i /><i /></div>
                </div>
                <div className="login-device-ticket"><b>New order</b><i /><i /><i /><span>Total <strong>Rs. 2,850</strong></span><small>Checkout&nbsp; →</small></div>
              </div>
            </div>
            <div className="login-device-glow" />
          </div>
        </div>

        <p className="login-hero-footer">Good food.<br /><em>Better business.</em></p>
      </section>

      <section className="login-panel">
        <Link to="/" className="login-brand" aria-label="RestaurantOS home">
          <img className="brand-mark" src={logoUrl} alt="" />
          <strong>RestaurantOS</strong>
        </Link>
        <div className="login-copy">
          <p className="eyebrow">SIGN IN</p>
          <h1>Welcome<br />back.</h1>
          <p>Sign in to your owner or team account.</p>
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
        <div className="demo-entry">
          <button className="button button-subtle" type="button" onClick={enterDemo}><FlaskConical size={17} />Open sample workspace</button>
          <small>Uses sample data only. Changes reset when you leave this session.</small>
        </div>
        <div className="login-footnote">Restaurant owners are provisioned by an authorized administrator. Team members join with their invitation link.</div>
      </section>
    </main>
  )
}
