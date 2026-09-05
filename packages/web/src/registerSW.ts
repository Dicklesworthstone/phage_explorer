/**
 * Service Worker Registration
 *
 * Registers the service worker and handles updates.
 */

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

    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
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
  const registration = await navigator.serviceWorker.getRegistration();
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
 * Unregister all service workers
 */
export async function unregisterServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    return false;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  if (registration) {
    return registration.unregister();
  }

  return false;
}

export default registerServiceWorker;
