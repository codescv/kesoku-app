import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@kesoku/ui/tokens.css';
import '@kesoku/ui/components.css';
import './app/global.css';
import { App } from './app/App';
import { isNative } from './native/platform';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker only on the Web PWA (Capacitor custom schemes do not run SWs).
if (!isNative() && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
