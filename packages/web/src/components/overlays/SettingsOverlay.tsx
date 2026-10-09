import React, { lazy, Suspense, useMemo, useState } from 'react';
import type { PhageRepository } from '../../db';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useTheme } from '../../hooks/useTheme';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useBeginnerMode } from '../../education';
import {
  detectCoarsePointerDevice,
  getEffectiveBackgroundEffects,
  getEffectiveGlow,
  getEffectiveScanlines,
  useWebPreferences,
} from '../../store/createWebStore';
import { IconContrast, IconLearn, IconSettings, IconDatabase } from '../ui';

const OfflineDatasetPanel = lazy(() => import('./OfflineDatasetPanel').then(module => ({ default: module.OfflineDatasetPanel })));

export interface SettingsOverlayProps {
  repository?: PhageRepository | null;
  reloadDatabase: () => Promise<void>;
  databaseFetching: boolean;
}

export function SettingsOverlay({ reloadDatabase, databaseFetching, repository }: SettingsOverlayProps): React.ReactElement | null {
  const { close, isOpen } = useOverlay();
  const offline = useMemo(() => repository?.getOfflineDataset?.() ?? null, [repository]);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const { theme, setTheme, availableThemes } = useTheme();
  const reducedMotion = useReducedMotion();
  const highContrast = useWebPreferences((s) => s.highContrast);
  const setHighContrast = useWebPreferences((s) => s.setHighContrast);
  const backgroundEffects = useWebPreferences((s) => s.backgroundEffects);
  const setBackgroundEffects = useWebPreferences((s) => s.setBackgroundEffects);
  const scanlines = useWebPreferences((s) => s.scanlines);
  const setScanlines = useWebPreferences((s) => s.setScanlines);
  const scanlineIntensity = useWebPreferences((s) => s.scanlineIntensity);
  const setScanlineIntensity = useWebPreferences((s) => s.setScanlineIntensity);
  const glow = useWebPreferences((s) => s.glow);
  const setGlow = useWebPreferences((s) => s.setGlow);
  const fxSafeMode = useWebPreferences((s) => s.fxSafeMode);
  const setFxSafeMode = useWebPreferences((s) => s.setFxSafeMode);
  const coarsePointer = useMemo(() => detectCoarsePointerDevice(), []);
  const narrowViewport = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.matchMedia?.('(max-width: 1100px)')?.matches ?? false;
    } catch {
      return false;
    }
  }, []);

  const effectiveBackgroundEffects = getEffectiveBackgroundEffects(backgroundEffects, {
    reducedMotion,
    coarsePointer,
    safeMode: fxSafeMode,
    narrowViewport,
  });
  const effectiveScanlines = getEffectiveScanlines(scanlines, { reducedMotion, coarsePointer, safeMode: fxSafeMode });
  const effectiveGlow = getEffectiveGlow(glow, { reducedMotion, coarsePointer, safeMode: fxSafeMode });

  const [reloadStatus, setReloadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const {
    isEnabled: beginnerModeEnabled,
    enable: enableBeginnerMode,
    disable: disableBeginnerMode,
  } = useBeginnerMode();

  const handleToggleBeginner = () => {
    if (beginnerModeEnabled) {
      disableBeginnerMode();
    } else {
      enableBeginnerMode();
    }
  };

  const handleReloadDatabase = async () => {
    setReloadStatus('loading');
    try {
      await reloadDatabase();
      setReloadStatus('success');
      // Reload the page to reinitialize with fresh data
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch {
      setReloadStatus('error');
    }
  };

  return (
    <Overlay
      id="settings"
      title="Settings"
      icon={<IconSettings size={18} />}
      size="lg"
      onClose={() => close('settings')}
    >
      <div className="settings-overlay">
        <section
          aria-label="Appearance settings"
          className="panel panel-compact settings-section"
        >
          <div className="settings-section-header">
            <IconContrast size={16} />
            <h3 className="settings-section-title">Appearance</h3>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Theme</div>
              <div className="settings-row-desc">Choose the overall color palette.</div>
            </div>
            <select
              value={theme.id}
              onChange={(e) => setTheme(e.target.value)}
              aria-label="Select theme"
              className="input settings-select"
            >
              {availableThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">High contrast</div>
              <div className="settings-row-desc">Increases text and border contrast for readability.</div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setHighContrast(!highContrast)}
              aria-pressed={highContrast}
              aria-label={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
            >
              {highContrast ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Performance safe mode</div>
              <div className="settings-row-desc">
                Temporarily disables heavy visual effects if scrolling becomes janky. Session-only (does not change your settings).
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setFxSafeMode(!fxSafeMode)}
              aria-pressed={fxSafeMode}
              aria-label={fxSafeMode ? 'Disable performance safe mode' : 'Enable performance safe mode'}
            >
              {fxSafeMode ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Background effects</div>
              <div className="settings-row-desc">
                Matrix rain background. CRT overlay requires Scanlines.
                {reducedMotion ? ' Suppressed by your Reduced Motion preference.' : ''}
                {coarsePointer ? ' Suppressed on touch devices.' : ''}
                {fxSafeMode ? ' Suppressed by Safe Mode.' : ''}
                {narrowViewport ? ' Suppressed on smaller screens.' : ''}
                {backgroundEffects && !effectiveBackgroundEffects ? ' (Currently suppressed)' : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setBackgroundEffects(!backgroundEffects)}
              aria-pressed={backgroundEffects}
              aria-label={backgroundEffects ? 'Disable background effects' : 'Enable background effects'}
            >
              {backgroundEffects ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Scanlines</div>
              <div className="settings-row-desc">
                Subtle CRT scanlines on overlays and the sequence view.
                {reducedMotion ? ' Suppressed by your Reduced Motion preference.' : ''}
                {coarsePointer ? ' Suppressed on touch devices.' : ''}
                {fxSafeMode ? ' Suppressed by Safe Mode.' : ''}
                {scanlines && !effectiveScanlines ? ' (Currently suppressed)' : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setScanlines(!scanlines)}
              aria-pressed={scanlines}
              aria-label={scanlines ? 'Disable scanlines' : 'Enable scanlines'}
            >
              {scanlines ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Glow</div>
              <div className="settings-row-desc">
                Adds subtle bloom to diff highlights.
                {reducedMotion ? ' Suppressed by your Reduced Motion preference.' : ''}
                {coarsePointer ? ' Suppressed on touch devices.' : ''}
                {fxSafeMode ? ' Suppressed by Safe Mode.' : ''}
                {glow && !effectiveGlow ? ' (Currently suppressed)' : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setGlow(!glow)}
              aria-pressed={glow}
              aria-label={glow ? 'Disable glow effects' : 'Enable glow effects'}
            >
              {glow ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Scanline intensity</div>
              <div className="settings-row-desc">
                How strong scanlines appear (0–8%).
                {scanlines && !effectiveScanlines ? ' Currently suppressed.' : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: '200px' }}>
              <input
                type="range"
                min={0}
                max={0.08}
                step={0.01}
                value={scanlineIntensity}
                onChange={(e) => setScanlineIntensity(parseFloat(e.target.value))}
                aria-label="Adjust scanline intensity"
                style={{
                  width: '140px',
                  height: '4px',
                  accentColor: 'var(--color-accent)',
                }}
              />
              <span
                style={{
                  width: '4ch',
                  textAlign: 'right',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-dim)',
                }}
              >
                {Math.round(scanlineIntensity * 100)}%
              </span>
            </div>
          </div>
        </section>

        <section
          aria-label="Beginner mode setting"
          className="panel panel-compact settings-section"
        >
          <div className="settings-row settings-row--top">
            <div className="settings-row-text">
              <div className="settings-section-header">
                <IconLearn size={16} />
                <h3 className="settings-section-title">Beginner Mode</h3>
              </div>
              <p className="settings-paragraph">
                Shows glossary, context-aware help, guided tours, and learning overlays. Persists to localStorage so
                newcomers keep their learning setup between visits.
              </p>
              <p className="settings-meta">
                Current state: <strong>{beginnerModeEnabled ? 'Enabled' : 'Disabled'}</strong>
              </p>
            </div>
            <div className="settings-row-actions">
              <button
                type="button"
                className="btn"
                onClick={handleToggleBeginner}
                aria-pressed={beginnerModeEnabled}
                aria-label={beginnerModeEnabled ? 'Disable Beginner Mode' : 'Enable Beginner Mode'}
              >
                {beginnerModeEnabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        </section>

        <section
          aria-label="Database settings"
          className="panel panel-compact settings-section"
        >
          <div className="settings-row settings-row--top">
            <div className="settings-row-text">
              <div className="settings-section-header">
                <IconDatabase size={16} />
                <h3 className="settings-section-title">Database</h3>
              </div>
              <p className="settings-paragraph">
                Reload the published database to fetch a new version. In catalog-first datasets, only fetched
                or explicitly prepared genomes are cached; loading the catalog does not download every genome.
              </p>
              <p className="settings-meta">
                {reloadStatus === 'loading' && 'Downloading latest database...'}
                {reloadStatus === 'success' && 'Database updated! Reloading...'}
                {reloadStatus === 'error' && 'Failed to reload database. Check your connection.'}
                {reloadStatus === 'idle' && 'Offline availability depends on the saved dataset files and startup manifest.'}
              </p>
            </div>
            <div className="settings-row-actions">
              <button
                type="button"
                className="btn"
                onClick={handleReloadDatabase}
                disabled={reloadStatus === 'loading' || databaseFetching || offlineBusy}
                aria-label="Reload database from server"
              >
                {reloadStatus === 'loading' || databaseFetching ? 'Reloading...' : 'Reload Database'}
              </button>
            </div>
          </div>
        </section>

        <section aria-label="Offline dataset management" className="panel panel-compact settings-section">
          {offline ? <>
            <button type="button" className="btn" aria-expanded={offlineExpanded} disabled={databaseFetching || reloadStatus === 'loading'}
              onClick={() => setOfflineExpanded(!offlineExpanded)}>
              {offlineExpanded ? 'Close offline manager' : 'Manage offline genomes'}
            </button>
            {offlineExpanded && isOpen('settings') && !databaseFetching && reloadStatus !== 'loading' &&
              <Suspense fallback={<p role="status">Loading offline manager…</p>}>
                <OfflineDatasetPanel access={offline} onBusyChange={setOfflineBusy} />
              </Suspense>}
          </> : <p>Individual offline selections require a catalog-first dataset. Legacy databases retain their existing
            whole-database cache. Export private genome bundles separately; private imports are not downloaded or saved by this manager.</p>}
        </section>

        <div className="settings-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => close('settings')}
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
