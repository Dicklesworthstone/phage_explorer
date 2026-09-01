/**
 * WorkerPreloader - Pre-initialize workers after critical app startup
 *
 * Creates singleton worker instances for frequently used overlays while deferring
 * their startup until the browser is idle so database loading and first paint win.
 */

import * as Comlink from 'comlink';
import type { SearchWorkerAPI } from './types';

// Worker instances and their Comlink-wrapped APIs
let searchWorker: Worker | null = null;
let searchWorkerAPI: Comlink.Remote<SearchWorkerAPI> | null = null;
let searchWorkerReady = false;

// Track initialization state
let preloadStarted = false;
let preloadComplete = false;
let preloadPromise: Promise<void> | null = null;
let preloadGeneration = 0;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
    options?: { timeout: number }
  ) => number;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return await new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function runWhenIdle(task: () => Promise<void>): Promise<void> {
  if (typeof window === 'undefined') {
    return task();
  }

  const requestIdleCallback = (window as IdleWindow).requestIdleCallback;
  if (typeof requestIdleCallback === 'function') {
    return new Promise<void>((resolve) => {
      requestIdleCallback(
        () => {
          void task().finally(resolve);
        },
        { timeout: 2000 }
      );
    });
  }

  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      void task().finally(resolve);
    }, 500);
  });
}

/**
 * Get the preloaded search worker API.
 * Returns null if worker startup has not completed yet.
 */
export function getSearchWorker(): {
  worker: Worker;
  api: Comlink.Remote<SearchWorkerAPI>;
  ready: boolean;
} | null {
  if (!searchWorker || !searchWorkerAPI) {
    return null;
  }
  return {
    worker: searchWorker,
    api: searchWorkerAPI,
    ready: searchWorkerReady,
  };
}

/**
 * Initialize all overlay workers after critical startup work has yielded.
 * Repeated callers share one in-flight preload.
 */
export async function preloadWorkers(): Promise<void> {
  if (preloadStarted) {
    if (preloadComplete) return;
    if (preloadPromise) return preloadPromise;
    return;
  }

  preloadStarted = true;
  const generation = ++preloadGeneration;

  preloadPromise = runWhenIdle(async () => {
    if (generation !== preloadGeneration) return;

    try {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        worker = new Worker(new URL('./search.worker.ts', import.meta.url));
      }

      if (generation !== preloadGeneration) {
        worker.terminate();
        return;
      }

      const api = Comlink.wrap<SearchWorkerAPI>(worker);
      searchWorker = worker;
      searchWorkerAPI = api;

      const ok = await withTimeout(api.ping(), 2500);
      if (generation !== preloadGeneration) {
        worker.terminate();
        if (searchWorker === worker) {
          searchWorker = null;
          searchWorkerAPI = null;
          searchWorkerReady = false;
        }
        return;
      }

      searchWorkerReady = ok === true;
      if (!searchWorkerReady && import.meta.env.DEV) {
        console.warn('Search worker ping timed out; continuing without preload readiness');
      }
      if (searchWorkerReady) {
        preloadComplete = true;
      } else if (searchWorker) {
        // Failed ping: drop the worker so callers fall back cleanly.
        searchWorker.terminate();
        searchWorker = null;
        searchWorkerAPI = null;
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Worker preload failed:', error);
      }
    }

    if (generation === preloadGeneration && !preloadComplete) {
      // Allow a future caller to retry if we never reached a ready worker.
      preloadStarted = false;
    }
  }).finally(() => {
    if (generation === preloadGeneration) {
      preloadPromise = null;
    }
  });

  return preloadPromise;
}

/**
 * Check if workers have been preloaded.
 */
export function isPreloaded(): boolean {
  return preloadComplete;
}

/**
 * Terminate all preloaded workers.
 */
export function terminateWorkers(): void {
  preloadGeneration += 1;

  if (searchWorker) {
    searchWorker.terminate();
    searchWorker = null;
    searchWorkerAPI = null;
    searchWorkerReady = false;
  }

  preloadStarted = false;
  preloadComplete = false;
  preloadPromise = null;
}
