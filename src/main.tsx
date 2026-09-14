import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

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
