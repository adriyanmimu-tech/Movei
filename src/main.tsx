import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Unregister any stale service workers and wipe outdated Workbox precaches so Render deploys update immediately
if (typeof window !== 'undefined') {
  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => {
        for (const key of keys) {
          if (key.includes('workbox') || key.includes('precache') || key.includes('vite-pwa')) {
            caches.delete(key).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const registration of registrations) {
          registration.update().catch(() => {});
          if (
            registration.active?.scriptURL?.includes('dev-sw') ||
            registration.active?.scriptURL?.endsWith('/sw.js')
          ) {
            registration.unregister().catch(() => {});
          }
        }
      })
      .catch(() => {});
  }
}

createRoot(document.getElementById('root')!).render(<App />);
