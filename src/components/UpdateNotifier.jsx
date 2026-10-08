import { useCallback, useEffect, useState } from 'react'
import { BellRing, CheckCircle2, Download } from 'lucide-react'

const isElectron = typeof window !== 'undefined' && window.posApi?.isElectron

export function UpdateNotifier() {
  const [updateState, setUpdateState] = useState(null)
  const [dismissedVersion, setDismissedVersion] = useState('')
  const [installing, setInstalling] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!isElectron) return undefined
    let mounted = true

    window.posApi.updater.getStatus().then((result) => {
      if (mounted && result?.data) setUpdateState(result.data)
    }).catch(() => {})

    function handleUpdateStatus(event) {
      if (!event.detail?.status) return
      setUpdateState(event.detail)
      setActionError('')
      if (event.detail.status === 'downloaded') setDismissedVersion('')
    }
    window.addEventListener('updater:status-changed', handleUpdateStatus)
    return () => {
      mounted = false
      window.removeEventListener('updater:status-changed', handleUpdateStatus)
    }
  }, [])

  useEffect(() => {
    if (!isElectron) return undefined
    const timer = setInterval(async () => {
      try {
        const result = await window.posApi.updater.getStatus()
        if (result?.data) setUpdateState(result.data)
      } catch {}
    }, 30000)
    return () => clearInterval(timer)
  }, [])

  const handleDownload = useCallback(async () => {
    setActionError('')
    try {
      const result = await window.posApi.updater.download()
      if (!result?.success) setActionError(result?.error || 'The update could not be downloaded.')
    } catch (error) {
      setActionError(error.message || 'The update could not be downloaded.')
    }
  }, [])

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    setActionError('')
    try {
      const result = await window.posApi.updater.installNow()
      if (!result?.success) {
        setActionError(result?.error || 'The update could not be installed yet.')
        setInstalling(false)
      }
    } catch (error) {
      setActionError(error.message || 'The update could not be installed yet.')
      setInstalling(false)
    }
  }, [])

  if (!isElectron) return null

  const status = updateState?.status
  const version = updateState?.version || ''
  const visible = ['available', 'downloading', 'downloaded'].includes(status)
    && dismissedVersion !== version
  if (!visible) return null

  const progress = Math.max(0, Math.min(100, Number(updateState.progress) || 0))
  const icon = status === 'downloaded'
    ? <CheckCircle2 size={20} aria-hidden="true" />
    : status === 'downloading'
      ? <Download size={20} aria-hidden="true" />
      : <BellRing size={20} aria-hidden="true" />

  return (
    <section className="update-notifier" role="status" aria-live="polite" aria-label="RestaurantOS update">
      <div className="update-notifier__icon">{icon}</div>
      <div className="update-notifier__body">
        {status === 'available' && (
          <>
            <strong className="update-notifier__title">New update available (v{version}) / Naya update available hai</strong>
            <span className="update-notifier__sub">Current version: v{updateState.currentVersion || '—'}</span>
          </>
        )}
        {status === 'downloading' && (
          <>
            <strong className="update-notifier__title">Downloading update (v{version}) / Update download ho raha hai</strong>
            <div className="update-notifier__progress-track" role="progressbar" aria-label="Update download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}>
              <div className="update-notifier__progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="update-notifier__sub">{progress}% complete</span>
          </>
        )}
        {status === 'downloaded' && (
          <>
            <strong className="update-notifier__title">Update ready (v{version}) / Naya version tayyar hai</strong>
            <span className="update-notifier__sub">Restart when it suits your shift / Apni sahulat se restart karein.</span>
          </>
        )}
        {actionError && <span className="update-notifier__error" role="alert">{actionError}</span>}
      </div>
      <div className="update-notifier__actions">
        {status === 'available' && (
          <button className="update-notifier__btn update-notifier__btn--primary" onClick={handleDownload}>
            Update Now / Abhi Update Karein
          </button>
        )}
        {status === 'downloaded' && (
          <button className="update-notifier__btn update-notifier__btn--primary" onClick={handleInstall} disabled={installing}>
            {installing ? 'Restarting…' : 'Restart to install / Restart karein'}
          </button>
        )}
        <button className="update-notifier__btn update-notifier__btn--ghost" onClick={() => setDismissedVersion(version)}>
          Later / Baad Mein
        </button>
      </div>
    </section>
  )
}
