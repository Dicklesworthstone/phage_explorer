import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { OverlayProvider } from './components/overlays/OverlayProvider';
import { ScrollProvider } from './providers';
import App from './App';
import './styles.css';
import './styles/scroll.css';
import { queryClient } from './queryClient';

function installViewportVariables(): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  let rafId: number | null = null;

  const update = () => {
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const width = vv?.width ?? window.innerWidth;
    root.style.setProperty('--visual-viewport-height', `${height}px`);
    root.style.setProperty('--visual-viewport-width', `${width}px`);
    root.style.setProperty('--vvh', `${height * 0.01}px`);
    root.style.setProperty('--vvw', `${width * 0.01}px`);
  };

  const schedule = () => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      update();
    });
  };

  update();
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
  }
}

installViewportVariables();

const container = document.getElementById('root');

if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ScrollProvider>
          <OverlayProvider>
            <App />
          </OverlayProvider>
        </ScrollProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

// Register service worker in production builds (disabled for automation via navigator.webdriver).
if (import.meta.env.PROD && typeof window !== 'undefined' && 'serviceWorker' in navigator && !navigator.webdriver) {
  window.addEventListener('load', () => {
    void import('./registerSW').then(({ registerServiceWorker }) => registerServiceWorker());
  });
}
