import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import DocsPage from './components/DocsPage.jsx'

const isDocs = window.location.pathname.replace(/\/+$/, '') === '/docs'

createRoot(document.getElementById('root')).render(<StrictMode>{isDocs ? <DocsPage /> : <App />}</StrictMode>)
