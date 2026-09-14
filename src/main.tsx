import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// PIN was intentionally retired. Remove only Home Meds' former local lock
// records, so a previous installation has no stale security state left behind.
try {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith('home-meds:local-pin:')) localStorage.removeItem(key);
  }
} catch {
  // Private-mode storage can be unavailable; there is no PIN code left to read.
}

// This is an app-like PWA: pinch and double-tap gestures should scroll or
// interact with controls, never resize the whole layout. The viewport meta
// covers modern browsers; these handlers cover iOS Safari and older Android
// WebViews that do not fully honor it.
const preventPageZoom = (event: Event) => event.preventDefault();
const preventMultiTouchZoom = (event: TouchEvent) => {
  if (event.touches.length > 1) event.preventDefault();
};

document.addEventListener('gesturestart', preventPageZoom, { passive: false });
document.addEventListener('gesturechange', preventPageZoom, { passive: false });
document.addEventListener('gestureend', preventPageZoom, { passive: false });
document.addEventListener('touchmove', preventMultiTouchZoom, { passive: false });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
