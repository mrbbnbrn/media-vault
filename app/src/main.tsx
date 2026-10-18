// First: keys only go to what is on top (keylayers.ts).
import './keyguard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './screens.css';
import { App } from './App';
import { api } from './api';
import { ErrorBoundary, errorText, WindowFailed } from './components/ErrorBoundary';

// No right-click menu (it offers "Save image as…", "Inspect", etc.).
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea')) e.preventDefault();
});

// Errors React couldn't hand to a boundary: into diagnostics.log with where they happened.
const where = (info: { componentStack?: string }) => (info.componentStack ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join(' < ');
createRoot(document.getElementById('root')!, {
  onUncaughtError: (e, info) => void api.diagNote(`uncaught: ${errorText(e)} | in ${where(info)}`),
}).render(
  <StrictMode>
    <ErrorBoundary name="the window" fallback={<WindowFailed />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
