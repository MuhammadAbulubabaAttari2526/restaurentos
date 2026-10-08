import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

export default defineConfig(({ command, mode }) => {
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    const requiredFirebaseKeys = [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_APP_ID',
    ]
    const missingKeys = requiredFirebaseKeys.filter((key) => !env[key]?.trim())
    if (missingKeys.length) {
      throw new Error(`Cannot build the production app without Firebase configuration. Set ${missingKeys.join(', ')} in the build environment or .env.local. These VITE_ values are embedded in the renderer bundle; they are not loaded from a .env file after installation.`)
    }
    if (env.VITE_USE_FIREBASE_EMULATORS === 'true') {
      throw new Error('Cannot package the production app while VITE_USE_FIREBASE_EMULATORS=true. Set it to false for an installer build.')
    }
  }

  return {
    base: './',
    plugins: [react(), tailwindcss()],
    test: {
      environment: 'jsdom',
      setupFiles: './src/tests/setup.js',
    },
  }
})
