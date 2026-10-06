import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import './app-polish.css'
import { AuthProvider } from './context/AuthContext.jsx'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'

const isFileOrElectron = typeof window !== 'undefined' && (
  window.location.protocol === 'file:' ||
  Boolean(window.posApi?.isElectron)
)
const Router = isFileOrElectron ? HashRouter : BrowserRouter

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router>
      <AuthProvider>
        <App />
        <Toaster position="top-right" richColors />
      </AuthProvider>
    </Router>
  </StrictMode>,
)
