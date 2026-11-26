import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setUiLanguage } from '@kesoku/ui';
import '@kesoku/ui/tokens.css';
import '@kesoku/ui/components.css';
import './app/global.css';
import { App } from './app/App';
import { isNative } from './native/platform';

// Apply resolved system locale to <html lang> before first paint.
setUiLanguage('system');

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
