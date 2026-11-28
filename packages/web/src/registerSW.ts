/**
 * Service Worker Registration
 *
 * Registers the service worker and handles updates.
 */
import { applicationScope, workerGeneration } from './service-worker-runtime';

export interface ServiceWorkerCallbacks {
  onUpdate?: () => void;
  onSuccess?: () => void;
  onOffline?: () => void;
}

let updateIntervalId: ReturnType<typeof setInterval> | null = null;
let registrationForUpdates: ServiceWorkerRegistration | null = null;
const registrationsWithListeners = new WeakSet<ServiceWorkerRegistration>();

const updateCallbacks = new Set<() => void>();
const successCallbacks = new Set<() => void>();
const offlineCallbacks = new Set<() => void>();

let offlineListenerInstalled = false;
function ensureOfflineListener(): void {
  if (offlineListenerInstalled) return;
  offlineListenerInstalled = true;

  window.addEventListener('offline', () => {
    for (const cb of offlineCallbacks) cb();
  });
}

function pageScope(): string {
  return applicationScope(import.meta.env.BASE_URL, window.location.href);
}

/** getRegistration may return the enclosing site's registration for a nested app. */
async function ownRegistration(container: ServiceWorkerContainer, scope: string): Promise<ServiceWorkerRegistration | undefined> {
  const registration = await container.getRegistration(scope);
  if (!registration || registration.scope !== scope) return undefined;
  const workers = [registration.installing, registration.waiting, registration.active].filter(worker => worker !== null);
  if (!workers.length || workers.some(worker => !workerGeneration(worker.scriptURL, scope))) {
    throw new Error('Another application owns the service worker at this address.');
  }
  return registration;
}

/**
 * Register the service worker
 */
export async function registerServiceWorker(
  callbacks: ServiceWorkerCallbacks = {}
): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    if (import.meta.env.DEV) {
      console.log('[SW] Service workers not supported');
    }
    return null;
  }

  try {
    if (callbacks.onUpdate) updateCallbacks.add(callbacks.onUpdate);
    if (callbacks.onSuccess) successCallbacks.add(callbacks.onSuccess);
    if (callbacks.onOffline) offlineCallbacks.add(callbacks.onOffline);

    const scope = pageScope();
    const existing = await ownRegistration(navigator.serviceWorker, scope);
    const worker = existing?.installing ?? existing?.waiting ?? existing?.active;
    const registration = await navigator.serviceWorker.register(worker?.scriptURL ?? new URL('sw.js', scope).href, {
      scope, updateViaCache: 'none',
    });

    registrationForUpdates = registration;

    // Check for updates periodically (every hour)
    if (!updateIntervalId) {
      updateIntervalId = setInterval(() => {
        // Offline update checks are expected to fail; retry at the next interval.
        void registrationForUpdates?.update().catch(() => undefined);
      }, 60 * 60 * 1000);
    }

    // An update can already be waiting when a tab is reopened.
    if (registration.waiting && navigator.serviceWorker.controller) {
      callbacks.onUpdate?.();
    }

    // Handle updates
    if (!registrationsWithListeners.has(registration)) {
      registrationsWithListeners.add(registration);
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New content available
            if (import.meta.env.DEV) {
              console.log('[SW] New content available');
            }
            for (const cb of updateCallbacks) cb();
          }
        });
      });
    }

    // Initial registration success
    if (registration.active) {
      if (import.meta.env.DEV) {
        console.log('[SW] Service worker active');
      }
      for (const cb of successCallbacks) cb();
    }

    // Handle offline/online events
    ensureOfflineListener();

    return registration;
  } catch (error) {
    console.error('[SW] Registration failed:', error);
    return null;
  }
}

/**
 * Trigger service worker update
 */
export async function updateServiceWorker(): Promise<void> {
  const registration = await ownRegistration(navigator.serviceWorker, pageScope());
  if (!registration) throw new Error('The update registration is unavailable.');
  if (registration?.waiting) {
    const waiting = registration.waiting;
    const previousController = navigator.serviceWorker.controller;

    // Wait until the new service worker takes control to avoid reloading back into old caches.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      };
      const onControllerChange = () => {
        if (!navigator.serviceWorker.controller || navigator.serviceWorker.controller === previousController) return;
        cleanup();
        resolve();
      };
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('The update has not activated. Please try reloading again.'));
      }, 10_000);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      try {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  // Another tab may have activated the waiting worker before this click.
  window.location.reload();
}

/** Release callbacks when their UI owner unmounts; registration remains shared. */
export function removeServiceWorkerCallbacks(callbacks: ServiceWorkerCallbacks): void {
  if (callbacks.onUpdate) updateCallbacks.delete(callbacks.onUpdate);
  if (callbacks.onSuccess) successCallbacks.delete(callbacks.onSuccess);
  if (callbacks.onOffline) offlineCallbacks.delete(callbacks.onOffline);
}

/**
 * Unregister the worker for this application only.
 */
export async function unregisterServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    return false;
  }

  const registration = await ownRegistration(navigator.serviceWorker, pageScope());
  if (registration) {
    return registration.unregister();
  }

  return false;
}

/**
 * Install a replacement shell alongside the active one. The browser installs all
 * precached assets before accepting SKIP_WAITING. A failed download keeps the old
 * worker available, including for other open tabs and offline navigation.
 */
export async function repairApplicationShell(
  container: ServiceWorkerContainer | undefined = navigator.serviceWorker,
  scope = pageScope(),
  online = () => navigator.onLine,
): Promise<void> {
  if (!online()) throw new Error('Reconnect before downloading the application shell.');
  if (!container) throw new Error('This browser does not support an offline application shell.');
  await ownRegistration(container, scope);
  if (!online()) throw new Error('Reconnect before downloading the application shell.');
  const url = new URL('sw.js', scope);
  url.searchParams.set('repair', crypto.randomUUID());
  const registration = await container.register(url.href, { scope, updateViaCache: 'none' });
  await new Promise<void>((resolve, reject) => {
    let worker: ServiceWorker | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      registration.removeEventListener('updatefound', check);
      container.removeEventListener('controllerchange', check);
      worker?.removeEventListener('statechange', check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (container.controller?.scriptURL === url.href) { finish(); return; }
      const candidate = [registration.installing, registration.waiting, registration.active].find(item => item?.scriptURL === url.href);
      if (candidate && candidate !== worker) {
        worker?.removeEventListener('statechange', check);
        worker = candidate; worker.addEventListener('statechange', check);
      }
      if (worker?.state === 'redundant') finish(new Error('The replacement shell could not be installed. Reconnect and retry.'));
      if (worker?.state === 'installed') {
        try { worker.postMessage({ type: 'SKIP_WAITING' }); }
        catch { finish(new Error('The replacement shell could not be activated.')); }
      }
    };
    const timer = setTimeout(() => finish(new Error('The replacement shell did not take control in time. Retry when connected.')), 60_000);
    registration.addEventListener('updatefound', check);
    container.addEventListener('controllerchange', check);
    check();
  });
}

export default registerServiceWorker;
