import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'regen-ui/styles.css'
import './styles.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
