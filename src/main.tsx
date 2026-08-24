import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// M1 is a pure library milestone (see go-spec.md §12). This shell exists so the
// scaffold builds; the board canvas lands in M2.
function App() {
  return (
    <div className="app-shell flex h-screen items-center justify-center">
      <span className="app-placeholder">Go — M1: time core</span>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
