import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { OverlayProvider } from './components/overlays/OverlayProvider';
import { ToastProvider, useToast } from './components/ui/Toast';
import ErrorBoundary from './components/layout/ErrorBoundary';
import { ScrollProvider } from './providers';
import App from './App';
import { GeneSelectionBridge } from './components/GeneSelectionBridge';
import { SelectedGeneLifecycleController } from './components/SelectedGeneLifecycleController';
import { ShareStateController, applyInitialShareState } from './components/ShareStateController';
import { SelectedGeneDock } from './components/mobile/SelectedGeneDock';
import './styles.css';
import './styles/scroll.css';
import './styles/phage-picker-accessibility.css';
import './styles/selected-gene-dock.css';
import './styles/selected-gene-desktop.css';
import { queryClient } from './queryClient';
import { initializeStorePersistence } from './store';

function ServiceWorkerUpdates(): null {
  const { toast } = useToast();
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || navigator.webdriver) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const register = () => {
      void import('./registerSW').then(({ registerServiceWorker, updateServiceWorker, removeServiceWorkerCallbacks }) => {
        if (disposed) return;
        const reload = () => {
          void updateServiceWorker().catch(() => {
            toast({
              id: 'app-update-error', title: 'Update could not activate',
              message: 'Your current page is still available. Try reloading the update again.',
              variant: 'error', duration: 0, actions: [{ label: 'Retry update', onClick: reload }],
            });
          });
        };
        const callbacks = {
          onUpdate: () => {
            if (disposed) return;
            toast({
              id: 'app-update', title: 'Update available',
              message: 'Reload when you are ready to use the new version.',
              duration: 0, actions: [{ label: 'Reload', onClick: reload }],
            });
          },
        };
        unsubscribe = () => removeServiceWorkerCallbacks(callbacks);
        void registerServiceWorker(callbacks);
      }).catch(() => {
        if (!disposed) toast({ title: 'Offline setup unavailable', message: 'Reconnect and reload to enable offline access.', variant: 'warning' });
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => {
      disposed = true;
      window.removeEventListener('load', register);
      unsubscribe?.();
    };
  }, [toast]);
  return null;
}

function installViewportVariables(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const root = document.documentElement;
  let rafId: number | null = null;
  let lastHeight: number | null = null;
  let lastWidth: number | null = null;

  const update = () => {
    const vv = window.visualViewport;
    const heightCandidate = vv?.height;
    const widthCandidate = vv?.width;
    const height =
      typeof heightCandidate === 'number' && Number.isFinite(heightCandidate) && heightCandidate > 0
        ? heightCandidate
        : window.innerHeight;
    const width =
      typeof widthCandidate === 'number' && Number.isFinite(widthCandidate) && widthCandidate > 0
        ? widthCandidate
        : window.innerWidth;

    if (
      lastHeight !== null &&
      lastWidth !== null &&
      Math.abs(height - lastHeight) < 0.5 &&
      Math.abs(width - lastWidth) < 0.5
    ) {
      return;
    }
    lastHeight = height;
    lastWidth = width;
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

  return () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (vv) {
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
    }
  };
}

const cleanupViewportVariables = installViewportVariables();
const cleanupStorePersistence = initializeStorePersistence();
applyInitialShareState();

let didCleanup = false;
const cleanupAll = () => {
  if (didCleanup) return;
  didCleanup = true;
  cleanupStorePersistence();
  cleanupViewportVariables();
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('unload', cleanupAll);
    }
    cleanupAll();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('unload', cleanupAll, { once: true });
}

const container = document.getElementById('root');

if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ScrollProvider>
            <ToastProvider>
              <ServiceWorkerUpdates />
              <OverlayProvider>
                <App />
                <GeneSelectionBridge />
                <SelectedGeneLifecycleController />
                <SelectedGeneDock />
                <ShareStateController />
              </OverlayProvider>
            </ToastProvider>
          </ScrollProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
