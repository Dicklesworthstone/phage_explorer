/**
 * DataLoadingOverlay - Database Loading and Recovery Screen
 *
 * Displays database progress, classifies startup failures, and offers a scoped
 * local-runtime repair path for stale IndexedDB, Workbox, and WASM caches.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../hooks/useTheme';
import type { DatabaseLoadProgress } from '../db';
import { Skeleton } from './ui/Skeleton';
import { IconAlertTriangle } from './ui';

interface DataLoadingOverlayProps {
  progress: DatabaseLoadProgress | null;
  error?: string | null;
  onRetry?: () => void;
}

function deleteIndexedDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = finish;
      request.onerror = finish;
      request.onblocked = finish;
    } catch {
      finish();
    }
  });
}

export function DataLoadingOverlay({
  progress,
  error,
  onRetry,
}: DataLoadingOverlayProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const progressRef = useRef<DatabaseLoadProgress | null>(progress);
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  });
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [estimatedRemainingSeconds, setEstimatedRemainingSeconds] = useState<number | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const progressSamplesRef = useRef<Array<{ timeMs: number; percent: number }>>([]);
  const lastStageRef = useRef<DatabaseLoadProgress['stage'] | null>(null);
  const lastPercentRef = useRef<number | null>(null);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const resetProgressEstimation = (): void => {
    setIsSlowLoad(false);
    setEstimatedRemainingSeconds(null);
    progressSamplesRef.current = [];
    lastStageRef.current = null;
    lastPercentRef.current = null;
  };

  const handleRetry = (): void => {
    if (!onRetry) return;
    resetProgressEstimation();
    setRepairError(null);
    setDiagnosticsCopied(false);
    setRetryAttempt((previous) => previous + 1);
    onRetry();
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (error) {
      setIsSlowLoad(false);
      return;
    }

    setIsSlowLoad(false);
    const timer = window.setTimeout(() => {
      const current = progressRef.current;
      if (!current || current.percent < 100) {
        setIsSlowLoad(true);
      }
    }, 15000);

    return () => window.clearTimeout(timer);
  }, [retryAttempt, error]);

  useEffect(() => {
    if (
      !progress ||
      progress.percent <= 0 ||
      progress.percent >= 100 ||
      progress.stage === 'ready' ||
      progress.stage === 'error'
    ) {
      progressSamplesRef.current = [];
      lastStageRef.current = progress?.stage ?? null;
      lastPercentRef.current = progress?.percent ?? null;
      setEstimatedRemainingSeconds(null);
      return;
    }

    const nowMs = Date.now();

    if (lastStageRef.current !== progress.stage) {
      progressSamplesRef.current = [];
      lastStageRef.current = progress.stage;
      lastPercentRef.current = null;
    }

    const previousPercent = lastPercentRef.current;
    if (previousPercent === null || progress.percent !== previousPercent) {
      if (previousPercent !== null && progress.percent < previousPercent) {
        progressSamplesRef.current = [];
      }
      progressSamplesRef.current.push({ timeMs: nowMs, percent: progress.percent });
      lastPercentRef.current = progress.percent;
    }

    const samples = progressSamplesRef.current;
    const maxSamples = 8;
    if (samples.length > maxSamples) {
      samples.splice(0, samples.length - maxSamples);
    }

    if (samples.length < 2) {
      setEstimatedRemainingSeconds(null);
      return;
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const deltaPercent = last.percent - first.percent;
    const deltaSeconds = (last.timeMs - first.timeMs) / 1000;
    const secondsSinceLastUpdate = (nowMs - last.timeMs) / 1000;

    if (secondsSinceLastUpdate > 5 || deltaSeconds <= 0.5 || deltaPercent <= 0.5) {
      setEstimatedRemainingSeconds(null);
      return;
    }

    const ratePercentPerSecond = deltaPercent / deltaSeconds;
    const remainingSeconds = Math.ceil((100 - last.percent) / ratePercentPerSecond);
    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      setEstimatedRemainingSeconds(null);
      return;
    }

    setEstimatedRemainingSeconds(Math.min(30 * 60, remainingSeconds));
  }, [progress]);

  if (error) {
    const offline = !isOnline;
    const normalizedError = error.toLowerCase();
    const isWasmUnsupported =
      normalizedError.includes('webassembly not supported') ||
      (normalizedError.includes('wasm') && normalizedError.includes('not supported'));
    const isWasmLoadFailure =
      normalizedError.includes('both async and sync fetching of the wasm failed') ||
      normalizedError.includes('failed to asynchronously prepare wasm') ||
      normalizedError.includes('wasm streaming compile failed') ||
      normalizedError.includes('failed to load wasm');
    const isDownloadFailure =
      normalizedError.includes('failed to download') ||
      normalizedError.includes('network error') ||
      normalizedError.includes('failed to fetch');

    const headline = offline
      ? 'You appear to be offline'
      : isWasmUnsupported
        ? 'This browser cannot run the database engine'
        : isWasmLoadFailure
          ? 'Could not start the local database engine'
          : isDownloadFailure
            ? 'Could not download the database'
            : 'Database load failed';

    const helperText = offline
      ? 'Phage Explorer needs to download the database on first load. Reconnect to the internet and retry.'
      : isWasmUnsupported
        ? 'Phage Explorer requires WebAssembly to run SQLite in your browser. Use a current Chromium, Firefox, or Safari release.'
        : isWasmLoadFailure
          ? 'A stale service worker or cached WASM response can block SQLite startup. Retry first; if it repeats, repair the local cache and reload cleanly.'
          : isDownloadFailure
            ? 'This can happen because of a flaky network, a blocked asset request, or a transient edge-cache issue.'
            : 'Retry the load. The repair option below can recover from stale local application data without changing your preferences.';

    const diagnostics = [
      progress
        ? `${progress.stage} (${progress.percent}%): ${progress.message}`
        : error,
      typeof window !== 'undefined' ? `URL: ${window.location.href}` : null,
      `Online: ${isOnline ? 'yes' : 'no'}`,
      typeof navigator !== 'undefined' ? `Browser: ${navigator.userAgent}` : null,
    ].filter(Boolean).join('\n');

    const handleCopyDiagnostics = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(diagnostics);
        setDiagnosticsCopied(true);
        window.setTimeout(() => setDiagnosticsCopied(false), 2000);
      } catch {
        setDiagnosticsCopied(false);
      }
    };

    const handleRepairLocalData = async (): Promise<void> => {
      if (typeof window === 'undefined') return;
      setIsRepairing(true);
      setRepairError(null);

      try {
        await Promise.all([
          deleteIndexedDatabase('phage-explorer-db'),
          deleteIndexedDatabase('workbox-expiration'),
        ]);

        if ('caches' in window) {
          const cacheNames = await window.caches.keys();
          const appCacheNames = cacheNames.filter((name) => {
            const normalized = name.toLowerCase();
            return (
              normalized.includes('phage') ||
              normalized.includes('wasm') ||
              normalized.includes('sql-js') ||
              normalized.includes('workbox-precache')
            );
          });
          await Promise.all(appCacheNames.map((name) => window.caches.delete(name)));
        }

        if ('serviceWorker' in navigator) {
          const registrations = typeof navigator.serviceWorker.getRegistrations === 'function'
            ? await navigator.serviceWorker.getRegistrations()
            : [await navigator.serviceWorker.getRegistration()].filter(
                (registration): registration is ServiceWorkerRegistration => Boolean(registration)
              );
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }

        window.setTimeout(() => window.location.reload(), 50);
      } catch (repairFailure) {
        const message = repairFailure instanceof Error
          ? repairFailure.message
          : 'Could not clear local application data';
        setRepairError(message);
        setIsRepairing(false);
      }
    };

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
          backgroundColor: colors.background,
          zIndex: 9999,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: 'min(520px, 100%)',
            maxHeight: 'calc(100dvh - 2rem)',
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            border: `1px solid ${colors.error}`,
            padding: 'clamp(1.25rem, 5vw, 2rem)',
            borderRadius: '12px',
            textAlign: 'center',
            backgroundColor: 'rgba(255, 0, 0, 0.1)',
            boxSizing: 'border-box',
          }}
        >
          <div style={{ marginBottom: '1rem', color: colors.error }} aria-hidden="true">
            <IconAlertTriangle size={34} />
          </div>
          <h2 style={{ color: colors.error, margin: '0 0 1rem' }}>{headline}</h2>
          <p style={{ color: colors.text, margin: '0 0 0.9rem', lineHeight: 1.55 }}>{helperText}</p>
          <details
            style={{
              margin: '0 auto 1.25rem',
              textAlign: 'left',
              color: colors.textMuted,
              fontSize: '0.85rem',
            }}
          >
            <summary style={{ cursor: 'pointer', color: colors.textDim, minHeight: '44px', display: 'flex', alignItems: 'center' }}>
              Details
            </summary>
            <pre
              style={{
                maxHeight: '180px',
                marginTop: '0.5rem',
                padding: '0.75rem',
                backgroundColor: colors.backgroundAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '0.75rem',
                lineHeight: 1.45,
              }}
            >
              {diagnostics}
            </pre>
            <button
              type="button"
              onClick={() => void handleCopyDiagnostics()}
              className="btn btn-ghost btn-sm"
              style={{ marginTop: '0.5rem' }}
            >
              {diagnosticsCopied ? 'Copied' : 'Copy diagnostics'}
            </button>
          </details>

          {repairError && (
            <div style={{ color: colors.error, fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              Repair failed: {repairError}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
            }}
          >
            {onRetry && (
              <button
                type="button"
                onClick={handleRetry}
                className="btn btn-primary"
                disabled={isRepairing}
              >
                Retry
              </button>
            )}
            {!offline && !isWasmUnsupported && (
              <button
                type="button"
                onClick={() => void handleRepairLocalData()}
                className="btn btn-ghost"
                disabled={isRepairing}
              >
                {isRepairing ? 'Repairing…' : 'Repair local cache'}
              </button>
            )}
          </div>

          {!offline && !isWasmUnsupported && (
            <p style={{ color: colors.textMuted, fontSize: '0.75rem', lineHeight: 1.45, margin: '1rem 0 0' }}>
              Repair removes only this site’s downloaded database, service worker, and runtime caches. Saved display preferences remain intact.
            </p>
          )}
        </div>
      </div>
    );
  }

  const displayProgress: DatabaseLoadProgress = progress ?? {
    stage: 'initializing',
    percent: 0,
    message: 'Initializing...',
  };

  const formatDuration = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) {
      return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom))',
        boxSizing: 'border-box',
        backgroundColor: colors.background,
        zIndex: 9999,
      }}
    >
      <div style={{ width: 'min(320px, 100%)', textAlign: 'center' }}>
        <div style={{ marginBottom: '1.5rem', fontSize: '1.5rem', color: colors.accent }}>
          PHAGE EXPLORER
        </div>

        {displayProgress.percent === 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <Skeleton
              variant="rect"
              width="100%"
              height={4}
              animation="shimmer"
              aria-label="Loading"
            />
          </div>
        )}

        {displayProgress.percent > 0 && (
          <div
            className="progress-bar"
            style={{ marginBottom: '1rem' }}
            role="progressbar"
            aria-valuenow={displayProgress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="progress"
              style={{ width: `${displayProgress.percent}%` }}
            />
          </div>
        )}

        <div
          style={{
            color: colors.textDim,
            fontSize: '0.9rem',
            marginBottom: estimatedRemainingSeconds ? '0.25rem' : '0.5rem',
          }}
        >
          {displayProgress.message}
          {displayProgress.percent > 0 && ` (${displayProgress.percent}%)`}
        </div>

        {estimatedRemainingSeconds !== null && (
          <div
            aria-hidden="true"
            style={{
              color: colors.textMuted,
              fontSize: '0.8rem',
              marginBottom: '0.5rem',
            }}
          >
            About {formatDuration(estimatedRemainingSeconds)} remaining
          </div>
        )}

        {isSlowLoad && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '8px',
              border: `1px solid ${colors.border}`,
            }}
          >
            <div style={{ color: colors.warning, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              Taking longer than expected…
            </div>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem', lineHeight: 1.45 }}>
              The first visit downloads and opens the local genome database. A slow connection or constrained device can add a few seconds.
            </div>
            {onRetry && (
              <button
                onClick={handleRetry}
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: '0.75rem' }}
              >
                Retry
              </button>
            )}
          </div>
        )}

        <div className="sr-only">
          Loading database: {displayProgress.message},{' '}
          {displayProgress.percent > 0
            ? `${displayProgress.percent}% complete`
            : 'starting up'}
          .
          {isSlowLoad && ' Loading is taking longer than expected.'}
        </div>
      </div>
    </div>
  );
}
