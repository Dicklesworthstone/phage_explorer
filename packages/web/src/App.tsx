import React, { useCallback, useEffect, useMemo, useOptimistic, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import OverlayManager from './components/overlays/OverlayManager';
import { useOverlay } from './components/overlays/OverlayProvider';
import { DataLoadingOverlay } from './components/DataLoadingOverlay';
import { useDatabase } from './hooks/useDatabase';
import {
  useHotkeys,
  useKeyboardMode,
  usePendingSequence,
} from './hooks';
import { useTheme } from './hooks/useTheme';
import { useReducedMotion } from './hooks';
import type { PhageRepository } from './db';
import {
  initializeStorePersistence,
  usePhageStore,
  useWebPreferences,
} from './store';
import { useBeginnerMode, useBeginnerModeInit, GlossaryPanel } from './education';
import './styles.css';
import { Model3DView } from './components/Model3DView';
import { SequenceView } from './components/SequenceView';
import { BeginnerModeIndicator } from './components/BeginnerModeIndicator';
import { ReadingFrameVisualizer } from './components/ReadingFrameVisualizer';
import { GlossaryPanel } from './education/glossary/GlossaryPanel';
import { LearnMenu } from './components/LearnMenu';

/** Number of bases to show in the sequence preview */
const SEQUENCE_PREVIEW_LENGTH = 500;

export default function App(): JSX.Element {
  const { theme, nextTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const highContrast = useWebPreferences((s) => s.highContrast);
  const setHighContrast = useWebPreferences((s) => s.setHighContrast);
  // Hydrate beginner mode preferences from storage once on mount
  useBeginnerModeInit();
  const {
    repository,
    isLoading,
    progress,
    error,
    isCached,
    load,
    reload,
  } = useDatabase({ autoLoad: true });
  const {
    toggle: toggleBeginnerMode,
    isEnabled: beginnerModeEnabled,
    isGlossaryOpen,
    closeGlossary,
  } = useBeginnerMode();
  const [beginnerToast, setBeginnerToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Use individual selectors to avoid getSnapshot caching issues
  const phages = usePhageStore((s) => s.phages);
  const currentPhageIndex = usePhageStore((s) => s.currentPhageIndex);
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const isLoadingPhage = usePhageStore((s) => s.isLoadingPhage);
  const setPhages = usePhageStore((s) => s.setPhages);
  const setCurrentPhageIndex = usePhageStore((s) => s.setCurrentPhageIndex);
  const setCurrentPhage = usePhageStore((s) => s.setCurrentPhage);
  const setLoadingPhage = usePhageStore((s) => s.setLoadingPhage);
  const setError = usePhageStore((s) => s.setError);
  const storeSetTheme = usePhageStore((s) => s.setTheme);
  const storeCloseAllOverlays = usePhageStore((s) => s.closeAllOverlays);
  const { open: openOverlayCtx, closeAll: closeAllOverlaysCtx } = useOverlay();
  const { mode } = useKeyboardMode();
  const pendingSequence = usePendingSequence();
  const [sequencePreview, setSequencePreview] = useState<string>('');
  const [fullSequence, setFullSequence] = useState<string>('');
  const enableBackgroundEffects = !reducedMotion;

  // React 19: useOptimistic for instant visual feedback on phage selection
  // Shows selection immediately while data loads in background
  const [optimisticIndex, setOptimisticIndex] = useOptimistic(
    currentPhageIndex,
    (_current: number, next: number) => next
  );

  useEffect(() => {
    const root = document.documentElement;
    if (highContrast) {
      root.classList.add('high-contrast');
    } else {
      root.classList.remove('high-contrast');
    }
  }, [highContrast]);

  // Initialize persistence once on mount
  useEffect(() => {
    const cleanup = initializeStorePersistence();
    return cleanup;
  }, []);

  // Keep Zustand theme aligned with current visual theme
  useEffect(() => {
    storeSetTheme(theme.id);
  }, [storeSetTheme, theme.id]);

  const loadPhage = useCallback(
    async (repo: PhageRepository, index: number) => {
      setLoadingPhage(true);
      try {
        setSequencePreview('');
        setFullSequence('');
        const phage = await repo.getPhageByIndex(index);
        if (!phage) return;
        setCurrentPhageIndex(index);
        setCurrentPhage(phage);
        const genomeLength = phage.genomeLength ?? 0;
        if (genomeLength > 0) {
          const seq = await repo.getSequenceWindow(phage.id, 0, genomeLength);
          setFullSequence(seq);
          setSequencePreview(seq.slice(0, SEQUENCE_PREVIEW_LENGTH));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load phage';
        setError(message);
      } finally {
        setLoadingPhage(false);
      }
    },
    [setCurrentPhage, setCurrentPhageIndex, setError, setLoadingPhage]
  );

  // Hydrate store from repository once available
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!repository || hydratedRef.current) return;
    hydratedRef.current = true;

    void (async () => {
      try {
        const list = await repository.listPhages();
        setPhages(list);

        if (list.length > 0) {
          await loadPhage(repository, 0);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load phages';
        setError(message);
      }
    })();
  }, [loadPhage, repository, setError, setPhages]);

  const handleSelectPhage = useCallback(
    async (index: number) => {
      if (!repository) return;
      // React 19: Optimistically update selection for instant UI feedback
      setOptimisticIndex(index);
      await loadPhage(repository, index);
    },
    [loadPhage, repository, setOptimisticIndex]
  );

  const handleNextPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const nextIndex = (currentPhageIndex + 1) % phages.length;
    // React 19: Optimistic update for keyboard navigation too
    setOptimisticIndex(nextIndex);
    void loadPhage(repository, nextIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository, setOptimisticIndex]);

  const handlePrevPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const prevIndex = (currentPhageIndex - 1 + phages.length) % phages.length;
    // React 19: Optimistic update for keyboard navigation too
    setOptimisticIndex(prevIndex);
    void loadPhage(repository, prevIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository, setOptimisticIndex]);

  const headerSubtitle = useMemo(() => {
    if (error) return 'db: error';
    if (isLoading) return 'db: loading';
    if (repository) return isCached ? 'db: cached' : 'db: ready';
    return 'db: idle';
  }, [error, isCached, isLoading, repository]);

  const showBeginnerToast = useCallback(
    (nextEnabled: boolean) => {
      setBeginnerToast(nextEnabled ? 'Beginner Mode enabled' : 'Beginner Mode disabled');
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => setBeginnerToast(null), 2000);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const handleToggleBeginnerMode = useCallback(() => {
    const nextState = !beginnerModeEnabled;
    showBeginnerToast(nextState);
    toggleBeginnerMode();
  }, [beginnerModeEnabled, showBeginnerToast, toggleBeginnerMode]);

  const loadingOverlayNeeded = isLoading || (!repository && progress);
  const showErrorOverlay = !!error && !repository;

  // Baseline hotkeys matching core navigation
  useHotkeys([
    { combo: { key: 'j' }, description: 'Next phage', action: handleNextPhage, modes: ['NORMAL'] },
    { combo: { key: 'k' }, description: 'Previous phage', action: handlePrevPhage, modes: ['NORMAL'] },
    { combo: { key: 't' }, description: 'Cycle theme', action: nextTheme, modes: ['NORMAL'] },
    { combo: { key: '?' }, description: 'Help overlay', action: () => openOverlayCtx('help'), modes: ['NORMAL'] },
    { combo: { key: '/' }, description: 'Search', action: () => openOverlayCtx('search'), modes: ['NORMAL'] },
    { combo: { key: ':' }, description: 'Command palette', action: () => openOverlayCtx('commandPalette'), modes: ['NORMAL'] },
    {
      combo: { key: 'b', modifiers: { ctrl: true } },
      description: 'Toggle beginner mode',
      action: handleToggleBeginnerMode,
      modes: ['NORMAL'],
      category: 'Education',
    },
    {
      combo: { key: 'Escape' },
      description: 'Close overlays',
      action: () => {
        closeAllOverlaysCtx();
        storeCloseAllOverlays();
      },
      modes: ['NORMAL'],
    },
  ]);

  const footerHints = useMemo(() => ([
    { key: 'j/k', label: 'navigate' },
    { key: '/', label: 'search' },
    { key: ':', label: 'command' },
    { key: 't', label: 'theme' },
    { key: '?', label: 'help' },
    { key: 'v/f', label: 'view/frame' },
    { key: 'Home/End', label: 'jump' },
    { key: 'Ctrl+B', label: 'beginner' },
  ]), []);

  // React 19: Dynamic document title
  const documentTitle = currentPhage
    ? `${currentPhage.name} - Phage Explorer`
    : 'Phage Explorer';

  return (
    <>
      <title>{documentTitle}</title>
      {loadingOverlayNeeded && (
        <DataLoadingOverlay
          progress={progress}
          error={null}
          onRetry={load}
        />
      )}
      {showErrorOverlay && (
        <DataLoadingOverlay
          progress={progress}
          error={error}
          onRetry={reload}
        />
      )}

      <AppShell
        enableBackgroundEffects={enableBackgroundEffects}
        header={{
          title: currentPhage?.name ?? 'Phage Explorer',
          subtitle: headerSubtitle,
          mode,
          pendingSequence: pendingSequence ?? undefined,
          children: (
            <>
              <button
                className="btn"
                onClick={nextTheme}
                type="button"
                aria-label={`Switch theme, current theme ${theme.name}`}
              >
                Theme: {theme.name}
              </button>
              <button
                className="btn"
                onClick={() => setHighContrast(!highContrast)}
                type="button"
                aria-pressed={highContrast}
                aria-label={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
              >
                Contrast: {highContrast ? 'High' : 'Standard'}
              </button>
              <button
                className="btn"
                onClick={handleToggleBeginnerMode}
                type="button"
                aria-pressed={beginnerModeEnabled}
                aria-label={beginnerModeEnabled ? 'Disable Beginner Mode' : 'Enable Beginner Mode'}
              >
                Beginner: {beginnerModeEnabled ? 'On' : 'Off'}
              </button>
              <LearnMenu />
            </>
          ),
        }}
        footer={{
          version: '0.0.0',
          hints: footerHints,
          children: <BeginnerModeIndicator />,
        }}
      >
        {/* Database loading/error status - only shown when needed */}
        {(!repository || error) && (
          <section className="panel panel-compact" aria-label="Repository status">
            <div className="panel-header">
              <h2>Database</h2>
              {isCached && <span className="badge">Cached</span>}
            </div>
            {!repository && !error && (
              <p className="text-dim">Loading database...</p>
            )}
            {progress && (
              <div className="status-line">
                <span>{progress.stage}</span>
                <div className="progress-bar">
                  <div className="progress" style={{ width: `${progress.percent}%` }} />
                </div>
                <span>{progress.percent}%</span>
              </div>
            )}
            {error && <div className="text-error">Error: {error}</div>}
          </section>
        )}

        <section className="panel two-column" aria-label="Phage browser">
          <div className="column column--list">
            <div className="panel-header">
              <h3>Phages</h3>
              <span className="badge">{phages.length}</span>
            </div>
            <div className="list">
              {phages.map((phage, idx) => {
                // Use optimistic index for instant visual selection feedback
                const isActive = idx === optimisticIndex;
                return (
                  <button
                    key={phage.id}
                    className={`list-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleSelectPhage(idx)}
                    type="button"
                  >
                    <div className="list-item-main">
                      <div className="list-title">{phage.name}</div>
                      <div className="list-subtitle text-dim">
                        {phage.host ?? 'Unknown host'} · {(phage.genomeLength ?? 0).toLocaleString()} bp
                      </div>
                    </div>
                    <div className="list-item-meta">
                      {phage.lifecycle && (
                        <span className={`badge badge-tiny ${phage.lifecycle === 'lytic' ? 'badge-warning' : 'badge-info'}`}>
                          {phage.lifecycle}
                        </span>
                      )}
                      {phage.gcContent != null && (
                        <span className="meta-gc text-dim">{phage.gcContent.toFixed(1)}%</span>
                      )}
                    </div>
                  </button>
                );
              })}
              {phages.length === 0 && (
                <div className="text-dim">Phage list will appear once the database loads.</div>
              )}
            </div>
          </div>

          <div className="column column--detail">
            <div className="panel-header">
              <h3>Details</h3>
              {isLoadingPhage && <span className="badge">Loading</span>}
            </div>
            {currentPhage ? (
              <div className="detail-card">
                <h4>{currentPhage.name}</h4>
                <p className="text-dim">
                  {currentPhage.family ?? 'Unassigned family'} · {currentPhage.lifecycle ?? 'Lifecycle n/a'}
                </p>
                <div className="metrics">
                  <div>
                    <div className="metric-label">Genome length</div>
                    <div className="metric-value">{(currentPhage.genomeLength ?? 0).toLocaleString()} bp</div>
                  </div>
                  <div>
                    <div className="metric-label">GC content</div>
                    <div className="metric-value">
                      {currentPhage.gcContent != null ? `${currentPhage.gcContent.toFixed(2)}%` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="metric-label">Genes</div>
                    <div className="metric-value">{currentPhage.genes.length}</div>
                  </div>
                </div>
                <div className="text-muted">
                  Accession: {currentPhage.accession} · Baltimore: {currentPhage.baltimoreGroup ?? 'n/a'}
                </div>
                {/* Side-by-side viewers on wide screens, stacked on smaller */}
                <div className="detail-viewers">
                  <div className="viewer-panel">
                    <div className="metric-label" style={{ marginBottom: '0.5rem' }}>Sequence</div>
                    <SequenceView
                      sequence={fullSequence}
                      className="sequence-block"
                    />
                    {!fullSequence && (
                      <pre className="sequence-block" style={{ marginTop: '0.5rem' }}>
                        {sequencePreview
                          ? sequencePreview
                          : 'Sequence preview will appear after phage load completes.'}
                      </pre>
                    )}
                  </div>
                  <div className="viewer-panel">
                    <Model3DView phage={currentPhage} />
                  </div>
                </div>
                {beginnerModeEnabled && fullSequence && (
                  <div style={{ marginTop: '1rem' }}>
                    <ReadingFrameVisualizer sequence={fullSequence} />
                  </div>
                )}
              </div>
            ) : (
              <div className="text-dim">
                {isLoadingPhage
                  ? 'Loading phage details...'
                  : 'Select a phage to view details once the database is ready.'}
              </div>
            )}
          </div>
        </section>
      </AppShell>
      {isGlossaryOpen && (
        <div
          role="complementary"
          aria-label="Glossary"
          style={{
            position: 'fixed',
            top: 'var(--header-height, 64px)',
            right: 0,
            bottom: 'var(--footer-height, 60px)',
            width: 'min(420px, 42%)',
            background: 'var(--color-background)',
            borderLeft: '1px solid var(--color-border-subtle)',
            boxShadow: 'var(--shadow-lg, 0 12px 36px rgba(0,0,0,0.35))',
            zIndex: 15,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.5rem 0.75rem',
              borderBottom: '1px solid var(--color-border-subtle)',
              background: 'var(--color-background-elevated)',
            }}
          >
            <div style={{ fontWeight: 700 }}>Glossary</div>
            <button className="btn" type="button" onClick={closeGlossary}>
              Close
            </button>
          </div>
          <div style={{ padding: '0.75rem', overflow: 'auto', flex: 1 }}>
            <GlossaryPanel />
          </div>
        </div>
      )}
      <OverlayManager repository={repository} currentPhage={currentPhage} />
      {beginnerToast && (
        <div className="toast toast-info" role="status" aria-live="polite">
          {beginnerToast}
        </div>
      )}
      {beginnerModeEnabled && isGlossaryOpen && (
        <div className="glossary-drawer" role="complementary" aria-label="Glossary">
          <div className="glossary-drawer__header">
            <div>
              <div className="glossary-drawer__eyebrow">Beginner Mode</div>
              <div className="glossary-drawer__title">Glossary</div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={closeGlossary}
              aria-label="Close glossary"
            >
              Close
            </button>
          </div>
          <GlossaryPanel />
        </div>
      )}
    </>
  );
}
