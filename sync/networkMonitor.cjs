/**
 * networkMonitor.cjs
 *
 * Monitors network reachability to Firestore/Internet.
 * Uses HTTPS HEAD request with short timeout.
 * Emits 'status' event on state change and allows manual mock overrides for tests/demo.
 */

const https = require('https')
const http = require('http')
const EventEmitter = require('events')

class NetworkMonitor extends EventEmitter {
  constructor(options = {}) {
    super()
    this.checkIntervalMs = options.checkIntervalMs || 15000
    this.pingUrl = options.pingUrl || 'https://firestore.googleapis.com'
    this.timeoutMs = options.timeoutMs || 4000
    this._isOnline = true
    this._mockStatus = null // null means use real check, boolean forces state
    this._interval = null
  }

  isOnline() {
    if (this._mockStatus !== null) {
      return this._mockStatus
    }
    return this._isOnline
  }

  setMockStatus(status) {
    const prev = this.isOnline()
    this._mockStatus = status === null ? null : Boolean(status)
    const next = this.isOnline()
    if (prev !== next) {
      this.emit('status', { isOnline: next })
    }
  }

  async checkNow() {
    if (this._mockStatus !== null) {
      return this._mockStatus
    }

    return new Promise((resolve) => {
      try {
        const urlObj = new URL(this.pingUrl)
        const client = urlObj.protocol === 'http:' ? http : https

        const req = client.request(
          this.pingUrl,
          {
            method: 'HEAD',
            timeout: this.timeoutMs,
          },
          (res) => {
            const online = res.statusCode >= 200 && res.statusCode < 500
            this._updateState(online)
            resolve(online)
          }
        )

        req.on('timeout', () => {
          req.destroy()
          this._updateState(false)
          resolve(false)
        })

        req.on('error', () => {
          this._updateState(false)
          resolve(false)
        })

        req.end()
      } catch (err) {
        this._updateState(false)
        resolve(false)
      }
    })
  }

  _updateState(online) {
    if (this._mockStatus !== null) return
    const prev = this._isOnline
    this._isOnline = online
    if (prev !== online) {
      this.emit('status', { isOnline: online })
    }
  }

  start() {
    if (this._interval) return
    this.checkNow()
    this._interval = setInterval(() => {
      this.checkNow()
    }, this.checkIntervalMs)
    if (this._interval.unref) {
      this._interval.unref()
    }
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
  }
}

const networkMonitor = new NetworkMonitor()

module.exports = {
  NetworkMonitor,
  networkMonitor,
}
