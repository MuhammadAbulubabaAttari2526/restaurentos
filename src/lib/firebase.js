import { initializeApp, getApps } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore'

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}

const requiredKeys = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
]

const missingConfig = requiredKeys.filter((key) => !env[key])
export const firebaseConfigured = missingConfig.length === 0
export const firebaseConfigError = missingConfig.length
  ? `Missing Firebase settings: ${missingConfig.join(', ')}`
  : ''

const app = firebaseConfigured
  ? getApps()[0] ?? initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    })
  : null

if (app && env.VITE_FIREBASE_APPCHECK_SITE_KEY && env.VITE_USE_FIREBASE_EMULATORS !== 'true') {
  import('firebase/app-check')
    .then(({ initializeAppCheck, ReCaptchaV3Provider }) => {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(env.VITE_FIREBASE_APPCHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true,
      })
    })
    .catch(() => {
      // Ignore optional App Check bootstrap failures in local/test environments.
    })
}

export const auth = app ? getAuth(app) : null
export const db = app ? getFirestore(app) : null

if (app && env.VITE_USE_FIREBASE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
}
