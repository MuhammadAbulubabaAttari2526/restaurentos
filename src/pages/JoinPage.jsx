import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useAuth } from '../context/useAuth.js'
import { completeStaffInvite, getStaffInvitation } from '../services/data.js'
import { friendlyError } from '../utils/domain.js'
import { publicAssetUrl } from '../utils/publicAssetUrl.js'
import './auth.css'

export function JoinPage() {
  const { restaurantId, invitationId } = useParams()
  const logoUrl = publicAssetUrl('restaurantos-mark.png')
  const { user, membership, login, joinInvitation, refreshMembership, logout } = useAuth()
  const navigate = useNavigate()
  const [invitation, setInvitation] = useState(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('signup')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getStaffInvitation(restaurantId, invitationId).then((result) => {
      if (!active) return
      setInvitation(result)
      setName(result.displayName || '')
    }).catch((problem) => {
      if (active) setError(friendlyError(problem))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [restaurantId, invitationId])

  async function joinWithAccount() {
    await completeStaffInvite(restaurantId, invitationId)
    const next = await refreshMembership()
    if (!next) throw new Error('Team access was saved, but could not be refreshed. Sign out and sign in again.')
    const destination = { owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos' }[next.role] || '/login'
    navigate(destination, { replace: true })
  }

  if (user && membership) {
    const destination = { owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos' }[membership.role] || '/login'
    return <Navigate to={destination} replace />
  }

  async function signup(event) {
    event.preventDefault()
    setError('')
    if (!invitation?.email) return setError('This invitation is invalid or has expired.')
    setBusy(true)
    try {
      const session = await joinInvitation({ restaurantId, invitationId, email: invitation.email, password, displayName: name.trim() })
      const destination = { owner: '/dashboard', manager: '/dashboard', cashier: '/pos', waiter: '/pos' }[session.membership?.role] || '/login'
      navigate(destination, { replace: true })
    } catch (problem) {
      setError(friendlyError(problem))
    } finally {
      setBusy(false)
    }
  }

  async function signin(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(invitation.email, password)
      await joinWithAccount()
    } catch (problem) {
      setError(friendlyError(problem))
    } finally {
      setBusy(false)
    }
  }

  async function finishJoining() {
    if (!user) return setError('Sign in to the invited email address first.')
    setError('')
    setBusy(true)
    try {
      await joinWithAccount()
    } catch (problem) {
      setError(friendlyError(problem))
    } finally {
      setBusy(false)
    }
  }

  return <main className="login-screen signup-screen"><div className="login-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-stamp"><img src={logoUrl} alt="" className="art-stamp-logo" /><span>SMART · FAST<br />COMPLETE</span></div><div className="art-caption"><span>HOSPITALITY, IN RHYTHM</span><strong>Your whole restaurant,<br />working as one.</strong></div></div><section className="login-panel"><Link to="/" className="login-brand" aria-label="RestaurantOS home"><img className="brand-mark" src={logoUrl} alt="RestaurantOS" /><strong>RestaurantOS</strong></Link><div className="login-copy"><p className="eyebrow">TEAM INVITATION</p><h1>{loading ? <>Checking<br />invitation.</> : <>Join your<br />restaurant.</>}</h1><p>{invitation ? `${invitation.displayName} invited ${invitation.email} as ${invitation.role}. Set a password to activate your account and join the team.` : 'This invitation link is invalid or has expired.'}</p></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {loading ? <div className="loading-lines"><i /><i /><i /></div> : invitation && !user && <>
      <div className="join-mode-switch"><button type="button" aria-pressed={mode === 'signup'} className={mode === 'signup' ? 'selected' : ''} onClick={() => { setMode('signup'); setError('') }}>Set password</button><button type="button" aria-pressed={mode === 'signin'} className={mode === 'signin' ? 'selected' : ''} onClick={() => { setMode('signin'); setError('') }}>I have an account</button></div>
      <form className="login-form signup-form" aria-busy={busy} onSubmit={mode === 'signup' ? signup : signin}>
        {mode === 'signup' && <label>Your name<input autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>}
        <label>Invited email<input type="email" autoComplete="email" required readOnly value={invitation.email} /></label>
        <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
        <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? 'Please wait...' : mode === 'signup' ? 'Set password & join' : 'Sign in & join'}<ArrowRight size={17} /></button>
      </form>
    </>}
    {user && invitation && <div className="login-form"><div className="form-helper">Signed in as {user.email}. The invitation can only be accepted by the invited email address.</div><button className="button button-primary login-submit" type="button" onClick={finishJoining} disabled={busy}>{busy ? 'Joining...' : 'Accept invitation'}<ArrowRight size={17} /></button><button className="text-button reset-link" type="button" onClick={logout}>Sign out</button></div>}
    <div className="login-footnote">Staff can join directly through this one-use invitation link. Email verification is not required. Owner access cannot be granted by staff invitations.</div></section></main>
}
