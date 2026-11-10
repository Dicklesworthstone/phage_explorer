/**
 * Rate Limiting Utilities for External APIs
 *
 * NCBI allows 3 requests/second without an API key.
 * This module provides shared rate limiting across all NCBI-based API clients.
 */

// Shared state for NCBI rate limiting
let lastNCBIRequestTime = 0;
const NCBI_REQUEST_DELAY_MS = 350; // ~3 requests/second

/**
 * Throttled fetch for NCBI APIs (SRA, Entrez, etc.)
 * Ensures we don't exceed NCBI's rate limit of 3 requests/second.
 */
export async function throttledNCBIFetch(url: string, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const now = Date.now();
  // Reserve a slot synchronously. Concurrent batch callers must not all wake
  // from the same delay and issue a burst of requests together.
  const start = Math.max(now, lastNCBIRequestTime + NCBI_REQUEST_DELAY_MS);
  lastNCBIRequestTime = start;
  if (start > now) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, start - now);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  signal?.throwIfAborted();
  return fetch(url, { signal });
}

/**
 * Reset rate limit state (useful for testing)
 */
export function resetNCBIRateLimit(): void {
  lastNCBIRequestTime = 0;
}
