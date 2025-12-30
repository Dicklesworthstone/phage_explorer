import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { OverlayProvider } from './components/overlays/OverlayProvider';
import { ScrollProvider } from './providers';
import App from './App';
import './styles.css';
import './styles/scroll.css';
import { queryClient } from './queryClient';

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
