/**
 * UpdateNotifier.jsx
 *
 * Auto-update notification component.
 * Shows a non-intrusive bottom banner when:
 *   - Update is available   → "Downloading..." info
 *   - Update downloading    → progress bar
 *   - Update ready          → "Restart to Update" button
 *
 * Rules:
 *  - Never interrupts active POS sales (dismissible at any time)
 *  - Install only when user explicitly clicks "Restart & Install"
 */

import { useState, useEffect, useCallback } from 'react'

const isElectron = typeof window !== 'undefined' && window.posApi?.isElectron

export function UpdateNotifier() {
  const [updateState, setUpdateState] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!isElectron) return

    // Fetch current status on mount
    window.posApi.updater.getStatus().then((res) => {
      if (res?.data) setUpdateState(res.data)
    }).catch(() => {})

    // Listen for push events from main process via preload listener
    // We add an event listener on the window object for the IPC push
    function handleIpc(e) {
      if (e.detail?.status) {
        setUpdateState(e.detail)
        if (e.detail.status === 'downloaded') setDismissed(false)
      }
    }
    window.addEventListener('updater:status-changed', handleIpc)
    return () => window.removeEventListener('updater:status-changed', handleIpc)
  }, [])

  // Poll status every 30s as a fallback
  useEffect(() => {
    if (!isElectron) return
    const id = setInterval(async () => {
      try {
        const res = await window.posApi.updater.getStatus()
        if (res?.data) setUpdateState(res.data)
      } catch {}
    }, 30000)
    return () => clearInterval(id)
  }, [])

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    try {
      await window.posApi.updater.installNow()
    } catch {
      setInstalling(false)
    }
  }, [])

  const handleDismiss = useCallback(() => setDismissed(true), [])

  const visible =
    !dismissed &&
    updateState &&
    ['available', 'downloading', 'downloaded'].includes(updateState.status)

  if (!visible) return null

  const { status, version, progress } = updateState

  return (
    <div className="update-notifier" role="alert" aria-live="polite">
      <div className="update-notifier__icon">
        {status === 'downloading' ? '⬇️' : status === 'downloaded' ? '✅' : '🔔'}
      </div>

      <div className="update-notifier__body">
        {status === 'available' && (
          <>
            <span className="update-notifier__title">Update Available — v{version}</span>
            <span className="update-notifier__sub">
              Background mein download ho raha hai, kaam karte raho…
            </span>
          </>
        )}

        {status === 'downloading' && (
          <>
            <span className="update-notifier__title">Update Download Ho Raha Hai — v{version}</span>
            <div className="update-notifier__progress-track">
              <div
                className="update-notifier__progress-fill"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <span className="update-notifier__sub">{progress ?? 0}% complete</span>
          </>
        )}

        {status === 'downloaded' && (
          <>
            <span className="update-notifier__title">✅ Update Ready! — v{version}</span>
            <span className="update-notifier__sub">
              Nayi version tayyar hai. Restart karein to install ho jaye.
            </span>
          </>
        )}
      </div>

      <div className="update-notifier__actions">
        {status === 'downloaded' && (
          <button
            id="btn-restart-update"
            className="update-notifier__btn update-notifier__btn--primary"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? '⏳ Restarting…' : '🔄 Restart & Install'}
          </button>
        )}
        <button
          id="btn-dismiss-update"
          className="update-notifier__btn update-notifier__btn--ghost"
          onClick={handleDismiss}
          aria-label="Dismiss"
          title="Baad mein"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
