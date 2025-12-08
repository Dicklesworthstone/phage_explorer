import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';

/** Number of bases to show in the sequence preview */
const SEQUENCE_PREVIEW_LENGTH = 500;

import { AppShell } from './components/layout/AppShell';
import OverlayManager from './components/overlays/OverlayManager';
import { OverlayProvider } from './components/overlays/OverlayProvider';
import { DataLoadingOverlay } from './components/DataLoadingOverlay';
import { useDatabase } from './hooks/useDatabase';
import {
  useHotkeys,
  useKeyboardMode,
  usePendingSequence,
} from './hooks';
import { useTheme } from './hooks/useTheme';
import type { PhageRepository } from './db';
import {
  initializeStorePersistence,
  usePhageStore,
} from './store';
import { Model3DView } from './components/Model3DView';

export default function App(): JSX.Element {
  const { theme, nextTheme } = useTheme();
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
    phages,
    currentPhageIndex,
    currentPhage,
    isLoadingPhage,
    setPhages,
    setCurrentPhageIndex,
    setCurrentPhage,
    setLoadingPhage,
    setError,
    openOverlay,
    setTheme: storeSetTheme,
    closeAllOverlays,
  } = usePhageStore((state) => ({
    phages: state.phages,
    currentPhageIndex: state.currentPhageIndex,
    currentPhage: state.currentPhage,
    isLoadingPhage: state.isLoadingPhage,
    setPhages: state.setPhages,
    setCurrentPhageIndex: state.setCurrentPhageIndex,
    setCurrentPhage: state.setCurrentPhage,
    setLoadingPhage: state.setLoadingPhage,
    setError: state.setError,
    openOverlay: state.openOverlay,
    setTheme: state.setTheme,
    closeAllOverlays: state.closeAllOverlays,
  }));
  const { mode } = useKeyboardMode();
  const pendingSequence = usePendingSequence();
  const [sequencePreview, setSequencePreview] = useState<string>('');

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
        const phage = await repo.getPhageByIndex(index);
        if (!phage) return;
        setCurrentPhageIndex(index);
        setCurrentPhage(phage);
        const windowEnd = Math.min(phage.genomeLength ?? 0, SEQUENCE_PREVIEW_LENGTH);
        const seq = await repo.getSequenceWindow(phage.id, 0, windowEnd);
        setSequencePreview(seq);
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
      await loadPhage(repository, index);
    },
    [loadPhage, repository]
  );

  const handleNextPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const nextIndex = (currentPhageIndex + 1) % phages.length;
    void loadPhage(repository, nextIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository]);

  const handlePrevPhage = useCallback(() => {
    if (!repository || phages.length === 0) return;
    const prevIndex = (currentPhageIndex - 1 + phages.length) % phages.length;
    void loadPhage(repository, prevIndex);
  }, [currentPhageIndex, loadPhage, phages.length, repository]);

  const headerSubtitle = useMemo(() => {
    if (error) return 'db: error';
    if (isLoading) return 'db: loading';
    if (repository) return isCached ? 'db: cached' : 'db: ready';
    return 'db: idle';
  }, [error, isCached, isLoading, repository]);

  const loadingOverlayNeeded = isLoading || (!repository && progress);
  const showErrorOverlay = !!error && !repository;

  // Baseline hotkeys matching core navigation
  useHotkeys([
    { combo: { key: 'j' }, description: 'Next phage', action: handleNextPhage, modes: ['NORMAL'] },
    { combo: { key: 'k' }, description: 'Previous phage', action: handlePrevPhage, modes: ['NORMAL'] },
    { combo: { key: 't' }, description: 'Cycle theme', action: nextTheme, modes: ['NORMAL'] },
    { combo: { key: '?' }, description: 'Help overlay', action: () => openOverlay('help'), modes: ['NORMAL'] },
    { combo: { key: '/' }, description: 'Search', action: () => openOverlay('search'), modes: ['NORMAL'] },
    { combo: { key: ':' }, description: 'Command palette', action: () => openOverlay('commandPalette'), modes: ['NORMAL'] },
    { combo: { key: 'Escape' }, description: 'Close overlays', action: closeAllOverlays, modes: ['NORMAL'] },
  ]);

  const footerHints = useMemo(() => ([
    { key: 'j/k', label: 'navigate' },
    { key: '/', label: 'search' },
    { key: ':', label: 'command' },
    { key: 't', label: 'theme' },
    { key: '?', label: 'help' },
  ]), []);

  return (
    <OverlayProvider>
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
        header={{
          title: currentPhage?.name ?? 'Phage Explorer',
          subtitle: headerSubtitle,
          mode,
          pendingSequence: pendingSequence ?? undefined,
          children: (
            <button className="btn" onClick={nextTheme} type="button">
              Theme: {theme.name}
            </button>
          ),
        }}
        footer={{
          version: '0.0.0',
          hints: footerHints,
        }}
      >
        <section className="panel" aria-label="Repository status">
          <div className="panel-header">
            <h2>Database</h2>
            {isCached && <span className="badge">Cached</span>}
          </div>
          <p className="text-dim">
            {repository
              ? 'SQLite loaded via sql.js. Data flows into the shared Zustand store.'
              : 'Waiting for database to finish loading...'}
          </p>
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

        <section className="panel two-column" aria-label="Phage browser">
          <div className="column">
            <div className="panel-header">
              <h3>Phages</h3>
              <span className="badge">{phages.length}</span>
            </div>
            <div className="list">
              {phages.map((phage, idx) => {
                const isActive = idx === currentPhageIndex;
                return (
                  <button
                    key={phage.id}
                    className={`list-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleSelectPhage(idx)}
                    type="button"
                  >
                    <div className="list-title">{phage.name}</div>
                    <div className="list-subtitle text-dim">
                      {phage.host ?? 'Unknown host'} · {(phage.genomeLength ?? 0).toLocaleString()} bp
                    </div>
                  </button>
                );
              })}
              {phages.length === 0 && (
                <div className="text-dim">Phage list will appear once the database loads.</div>
              )}
            </div>
          </div>

          <div className="column">
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
                      {currentPhage.gcContent !== null ? `${currentPhage.gcContent.toFixed(2)}%` : '—'}
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
                <div className="sequence-preview">
                  <div className="metric-label">Sequence preview</div>
                  <pre className="sequence-block">
                    {sequencePreview
                      ? sequencePreview
                      : 'Sequence preview will appear after phage load completes.'}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="text-dim">
                {isLoadingPhage
                  ? 'Loading phage details...'
                  : 'Select a phage to view details once the database is ready.'}
              </div>
            )}
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Model3DView phage={currentPhage} />
            </div>
          </div>
        </section>
      </AppShell>
      <OverlayManager />
    </OverlayProvider>
  );
}
