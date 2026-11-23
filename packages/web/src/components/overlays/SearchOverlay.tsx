import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { usePhageStore } from '@phage-explorer/state';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useTheme } from '../../hooks/useTheme';
import { SearchResultsSkeleton } from '../ui/Skeleton';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { isSearchResponse } from '../../workers/types';
import {
  OverlayEmptyState,
  OverlayErrorState,
  OverlayLoadingState,
  OverlayStack,
} from './primitives';
import {
  getSearchWorker,
  type SearchWorkerAPI,
  type SearchMode,
  type SearchOptions,
  type SearchHit,
  type SearchFeature,
  type SearchRequest,
  type SearchResponse,
} from '../../workers';

type StrandOption = SearchOptions['strand'];

interface SearchOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface SearchSource {
  repository: PhageRepository;
  phage: PhageFull;
  loadKey: number;
  sequence: string;
  features: SearchFeature[];
  topology: 'linear' | 'circular' | 'unknown';
}
const EMPTY_HITS: SearchHit[] = [];

const MODES: Array<{ id: SearchMode; label: string }> = [
  { id: 'sequence', label: 'Sequence' },
  { id: 'motif', label: 'Motif / IUPAC' },
  { id: 'gene', label: 'Gene' },
  { id: 'feature', label: 'Feature' },
  { id: 'position', label: 'Position' },
];

const DEFAULT_OPTIONS: SearchOptions = {
  strand: 'both',
  mismatches: 0,
  caseSensitive: false,
  maxResults: 500,
};

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return await new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        window.clearTimeout(timer);
        resolve(null);
      });
  });
}

export function SearchOverlay({ repository, currentPhage }: SearchOverlayProps): React.ReactElement | null {
  const { isOpen, close } = useOverlay();
  const overlayOpen = isOpen('search');
  const { theme } = useTheme();
  const colors = theme.colors;

  const [mode, setMode] = useState<SearchMode>('sequence');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [status, setStatus] = useState<'idle' | 'loading' | 'searching'>('idle');
  const [workerReady, setWorkerReady] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [workerInitKey, setWorkerInitKey] = useState(0);
  const [sequenceLoadKey, setSequenceLoadKey] = useState(0);
  const [manualSearchTrigger, setManualSearchTrigger] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loaded, setLoaded] = useState<{
    repository: PhageRepository; phage: PhageFull; loadKey: number;
    source: SearchSource | null; error: string | null;
  } | null>(null);
  // Ownership is checked while rendering, before effects can clear stale state.
  // Numeric IDs alone are reusable across catalog generations and local inputs.
  const currentLoad = loaded?.repository === repository && loaded?.phage === currentPhage
    && loaded?.loadKey === sequenceLoadKey ? loaded : null;
  const source = currentLoad?.source ?? null;
  const sequence = source?.sequence ?? '';
  const loadError = currentLoad?.error ?? null;
  const [topologyChoice, setTopologyChoice] = useState<{ source: SearchSource; value: 'linear' | 'circular' } | null>(null);
  // A manual topology assumption belongs to these exact loaded bases. It must
  // not silently become the default for the next selected genome/repository.
  const topologyOverride = topologyChoice && topologyChoice.source === source ? topologyChoice.value : null;
  const topology = topologyOverride ?? (source?.topology === 'circular' ? 'circular' : 'linear');
  const request = useMemo<SearchRequest | null>(() => source ? {
    mode, query: query.trim(), sequence: source.sequence, features: source.features,
    options: { ...options, topology, fuzzy: mode === 'gene' || mode === 'feature' },
  } : null, [source, mode, query, options, topology]);
  const [outcome, setOutcome] = useState<{
    request: SearchRequest; hits: SearchHit[]; summary: string; error: string | null;
  } | null>(null);
  const currentOutcome = outcome?.request === request ? outcome : null;
  const hits = currentOutcome?.hits ?? EMPTY_HITS;
  const summary = currentOutcome?.summary ?? '';
  const searchError = currentOutcome?.error ?? null;

  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const searchSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);

  // Store action to navigate to position
  const setScrollPosition = usePhageStore((s) => s.setScrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  // Track if we're using a preloaded worker (don't terminate on unmount)
  const usingPreloadedRef = useRef(false);

  // Keep hotkeys mounted, but start compute only when the panel is opened.
  useEffect(() => {
    if (!overlayOpen) return;
    let cancelled = false;
    usingPreloadedRef.current = false;

    setWorkerReady(false);
    setWorkerError(null);

    const init = async () => {
      // Prefer the preloaded singleton worker when available, but fall back if it isn't responsive.
      const preloaded = getSearchWorker();
      if (preloaded) {
        const ok = preloaded.ready ? true : await withTimeout(preloaded.api.ping(), 2500);
        if (cancelled) return;

        if (ok === true) {
          usingPreloadedRef.current = true;
          workerInstanceRef.current = preloaded.worker;
          workerRef.current = preloaded.api;
          setWorkerReady(true);
          return;
        }
      }

      // No usable preloaded worker - create a new instance.
      usingPreloadedRef.current = false;
      let worker: Worker;
      try {
        worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url));
      }
      workerInstanceRef.current = worker;
      const wrappedWorker = Comlink.wrap<SearchWorkerAPI>(worker);
      workerRef.current = wrappedWorker;

      const ok = await withTimeout(wrappedWorker.ping(), 2500);
      if (cancelled) return;

      if (ok === true) {
        setWorkerReady(true);
        return;
      }

      setWorkerError('Search engine timed out during startup.');
    };

    void init().catch((e) => {
      if (cancelled) return;
      if (isDev) console.error('Search worker failed to initialize:', e);
      const msg = e instanceof Error ? e.message : 'Search engine failed to start';
      setWorkerError(msg);
    });

    return () => {
      cancelled = true;
      // Only terminate if we created the worker (not preloaded)
      if (!usingPreloadedRef.current && workerInstanceRef.current) {
        workerInstanceRef.current.terminate();
      }
      workerInstanceRef.current = null;
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, [overlayOpen, workerInitKey]);

  const hasDatabase = Boolean(repository);
  const hasPhage = Boolean(currentPhage);
  const isInitializing = (!workerReady && !workerError) || (!!repository && !!currentPhage && !currentLoad);
  const hasSequence = sequence.length > 0;
  const showSearchUI = overlayOpen && hasDatabase && hasPhage && !workerError && !isInitializing && !loadError && hasSequence;

  // Ensure input focus once the "real" search UI is available (worker + sequence loaded).
  // Without this, the Overlay's initial focus (close button) can remain focused if the
  // input isn't mounted yet (loading state), causing Enter to close the overlay.
  useEffect(() => {
    if (!showSearchUI) return;
    const input = inputRef.current;
    if (!input) return;
    if (document.activeElement === input) return;
    input.focus();
  }, [showSearchUI]);

  // Reset selection when hits change
  useEffect(() => {
    setSelectedIndex(0);
  }, [hits]);

  // Navigate to selected result
  const navigateToResult = useCallback((hit: SearchHit) => {
    if (!hits.includes(hit)) return;
    const target = viewMode === 'aa' ? Math.floor(hit.position / 3) : hit.position;
    setScrollPosition(target);
    close('search');
  }, [close, setScrollPosition, viewMode, hits]);

  // Keyboard handler for navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'Escape':
        if (query.trim()) {
          e.preventDefault();
          setQuery('');
          setSelectedIndex(0);
        }
        break;
      case 'ArrowDown':
        if (hits.length === 0) break;
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, hits.length - 1));
        break;
      case 'ArrowUp':
        if (hits.length === 0) break;
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        if (hits.length > 0 && selectedIndex < hits.length) {
          e.preventDefault();
          navigateToResult(hits[selectedIndex]);
        }
        break;
    }
  }, [hits, navigateToResult, query, selectedIndex]);

  // Scroll selected result into view
  useEffect(() => {
    const list = resultsRef.current;
    if (!list || hits.length === 0) return;
    const selectedElement = list.querySelector<HTMLElement>(`[data-result-index="${selectedIndex}"]`);
    selectedElement?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, hits.length]);

  // Load sequence + features when overlay opens or phage changes
  useEffect(() => {
    if (!overlayOpen) return;
    if (!repository || !currentPhage) {
      setStatus('idle');
      setLoaded(null);
      setOutcome(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setLoaded(null);
    setOutcome(null);

    const load = async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (cancelled) return;
        if (!Number.isSafeInteger(length) || length < 0 || length > 5_000_000) throw new Error('Search requires a complete genome of at most 5,000,000 bases.');
        const [seq, genes, phage] = await Promise.all([
          repository.getSequenceWindow(currentPhage.id, 0, length),
          repository.getGenes(currentPhage.id),
          repository.getPhageById(currentPhage.id),
        ]);
        if (cancelled) return;
        if (seq.length !== length) throw new Error('The complete genome could not be read. Reload before searching.');
        if (!phage || phage.id !== currentPhage.id) throw new Error('The selected genome is no longer available. Reload before searching.');

        // A repository replacement can precede the store's PhageFull refresh.
        // Load annotations with the bases, never from that previous UI object.
        const mappedFeatures: SearchFeature[] = genes.map((g) => ({
          start: g.startPos,
          end: g.endPos,
          strand: g.strand === '+' || g.strand === '-' ? g.strand : 'both',
          name: g.name ?? g.locusTag ?? undefined,
          product: g.product ?? undefined,
          type: g.type ?? 'CDS',
        }));
        const source: SearchSource = { repository, phage: currentPhage, loadKey: sequenceLoadKey, sequence: seq,
          features: mappedFeatures, topology: phage.localGenome?.topology ?? 'unknown' };
        setLoaded({ repository, phage: currentPhage, loadKey: sequenceLoadKey, source, error: null });
        setStatus('idle');
      } catch (e) {
        if (cancelled) return;
        setStatus('idle');
        const msg = e instanceof Error ? e.message : 'Failed to load sequence';
        setLoaded({ repository, phage: currentPhage, loadKey: sequenceLoadKey, source: null, error: msg });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [currentPhage, overlayOpen, repository, sequenceLoadKey]);

  const runSearch = useCallback(
    async (req: SearchRequest, seq: number) => {
      if (!workerRef.current) return;
      try {
        setStatus('searching');
        const res = (await workerRef.current.runSearch(req)) as SearchResponse;
        if (searchSeqRef.current !== seq) return;
        if (!isSearchResponse(req, res)) throw new Error('Search engine returned mismatched or invalid results.');
        const limit = req.options?.maxResults ?? DEFAULT_OPTIONS.maxResults ?? 500;
        setOutcome({ request: req, hits: res.hits, error: null,
          summary: `${res.hits.length}/${limit} results for "${res.query}" in ${res.mode} mode${res.hits.length === limit ? ' (result limit reached)' : ''}` });
      } catch (e) {
        if (searchSeqRef.current !== seq) return;
        const msg = e instanceof Error ? e.message : 'Search failed';
        setOutcome({ request: req, hits: [], summary: '', error: msg });
      } finally {
        if (searchSeqRef.current !== seq) return;
        setStatus('idle');
      }
    },
    []
  );

  // Invalidate at cleanup, not when the next debounce timer fires. A reply
  // during the 200 ms input window cannot repopulate a newer query or source.
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    setOutcome(null);
    if (!overlayOpen || !workerReady || !request?.query || !request.sequence) {
      setStatus('idle');
      return;
    }
    setStatus('searching');
    const timer = window.setTimeout(() => { void runSearch(request, seq); }, 200);
    return () => {
      searchSeqRef.current++;
      window.clearTimeout(timer);
    };
  }, [overlayOpen, request, runSearch, workerReady, manualSearchTrigger]);

  const toggleStrand = (value: StrandOption) => {
    setOptions((prev) => ({ ...prev, strand: value }));
  };

  const renderOptions = () => {
    // Common styles for touch-friendly controls (44px minimum touch targets)
    const labelStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      color: colors.text,
      minHeight: '44px',
      padding: '0.25rem 0',
    };
    const selectStyle: React.CSSProperties = {
      background: colors.backgroundAlt,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      borderRadius: '6px',
      padding: '0.5rem 0.75rem',
      minHeight: '40px',
      fontSize: '16px', // Prevents iOS zoom
    };
    const numberInputStyle: React.CSSProperties = {
      background: colors.backgroundAlt,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      borderRadius: '6px',
      padding: '0.5rem',
      minHeight: '40px',
      fontSize: '16px', // Prevents iOS zoom
    };
    const checkboxStyle: React.CSSProperties = {
      width: '20px',
      height: '20px',
      accentColor: colors.accent,
    };

    return (
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={labelStyle}>
          <input
            type="checkbox"
            checked={options.caseSensitive ?? false}
            onChange={(e) => setOptions((prev) => ({ ...prev, caseSensitive: e.target.checked }))}
            style={checkboxStyle}
          />
          <span style={{ color: colors.textDim }}>Case sensitive</span>
        </label>

        {(mode === 'sequence' || mode === 'motif') && (
          <label style={labelStyle}>
            <span style={{ color: colors.textDim }}>Strand:</span>
            <select
              value={options.strand ?? 'both'}
              onChange={(e) => toggleStrand(e.target.value as StrandOption)}
              style={selectStyle}
            >
              <option value="both">both</option>
              <option value="+">+</option>
              <option value="-">-</option>
            </select>
          </label>
        )}

        {(mode === 'sequence' || mode === 'motif') && source && (
          <label style={labelStyle}>
            <span style={{ color: colors.textDim }}>Sequence topology:</span>
            <select value={topologyOverride ?? 'annotation'} style={selectStyle} onChange={event => {
              const value = event.target.value;
              setTopologyChoice(value === 'annotation' ? null : { source, value: value as 'linear' | 'circular' });
            }}>
              <option value="annotation">{source.topology === 'unknown' ? 'Unknown · linear interval' : `Annotated ${source.topology}`}</option>
              <option value="linear">Search linear interval</option>
              <option value="circular">Complete circular molecule</option>
            </select>
          </label>
        )}

        {mode === 'sequence' && (
          <label style={labelStyle}>
            <span style={{ color: colors.textDim }}>Mismatches</span>
            <input
              type="number"
              min={0}
              max={3}
              value={options.mismatches ?? 0}
              onChange={(e) =>
                setOptions((prev) => ({ ...prev, mismatches: Math.max(0, Math.min(3, Number(e.target.value) || 0)) }))
              }
              style={{ ...numberInputStyle, width: '4rem' }}
            />
          </label>
        )}

        <label style={labelStyle}>
          <span style={{ color: colors.textDim }}>Limit</span>
          <input
            type="number"
            min={10}
            max={2000}
            value={options.maxResults ?? DEFAULT_OPTIONS.maxResults ?? 500}
            onChange={(e) =>
              setOptions((prev) => ({
                ...prev,
                maxResults: Math.max(10, Math.min(2000, Number(e.target.value) || 500)),
              }))
            }
            style={{ ...numberInputStyle, width: '5rem' }}
          />
        </label>
      </div>
    );
  };

  if (!overlayOpen) {
    return null;
  }

  return (
    <Overlay id="search" title="SEARCH" hotkey="/" size="xl" onClose={() => close('search')}>
      <OverlayStack>
        {!hasDatabase ? (
          <OverlayEmptyState
            message="Database is still loading."
            hint="Wait a moment for the genome database to finish initializing, then try Search again."
            action={
              <button type="button" className="btn btn-ghost" onClick={() => close('search')}>
                Close
              </button>
            }
          />
        ) : !hasPhage ? (
          <OverlayEmptyState
            message="Select a phage to search."
            hint="Pick a phage first, then reopen Search to query its genome and annotations."
            action={
              <button type="button" className="btn btn-ghost" onClick={() => close('search')}>
                Close
              </button>
            }
          />
        ) : workerError ? (
          <OverlayErrorState
            message="Search engine failed to start."
            details={workerError}
            onRetry={() => setWorkerInitKey((k) => k + 1)}
          />
        ) : isInitializing ? (
          <OverlayLoadingState
            message={!workerReady ? 'Starting search engine…' : 'Loading genome sequence…'}
          >
            <SearchResultsSkeleton count={4} />
          </OverlayLoadingState>
        ) : loadError ? (
          <OverlayErrorState
            message="Couldn’t load this genome for searching."
            details={loadError}
            onRetry={() => setSequenceLoadKey((k) => k + 1)}
          />
        ) : !hasSequence ? (
          <OverlayEmptyState
            message="No sequence data available for this phage."
            hint="Try selecting a different phage or reopen Search after the database finishes loading."
            action={
              <button type="button" className="btn btn-ghost" onClick={() => close('search')}>
                Close
              </button>
            }
          />
        ) : (
          <>
            {/* Mode selector */}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  style={{
                    padding: '0.625rem 1rem',
                    minHeight: '44px',
                    borderRadius: '6px',
                    border: `1px solid ${mode === m.id ? colors.borderFocus : colors.border}`,
                    background: mode === m.id ? colors.backgroundAlt : colors.background,
                    color: colors.text,
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    fontWeight: mode === m.id ? 600 : 500,
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Query input */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label htmlFor="phage-search-query" style={{ color: colors.textDim, fontSize: '0.9rem' }}>Query</label>
              <input
                id="phage-search-query"
                ref={inputRef}
                data-overlay-autofocus="true"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  mode === 'sequence'
                    ? 'ATCG...'
                    : mode === 'motif'
                      ? 'IUPAC motif (e.g., TATAWR)'
                      : mode === 'gene'
                        ? 'Gene name/product'
                        : mode === 'feature'
                          ? 'Feature type/name'
                          : 'Position or range (e.g., 1000-2000, 5000)'
                }
                style={{
                  padding: '0.75rem',
                  minHeight: '48px',
                  fontSize: '16px', // Prevents iOS zoom on focus
                  borderRadius: '6px',
                  border: `1px solid ${colors.border}`,
                  background: colors.backgroundAlt,
                  color: colors.text,
                }}
              />
              {renderOptions()}
              <p style={{ color: colors.textDim, fontSize: '0.9rem', margin: 0 }}>
                Positions are 0-based; range ends are exclusive. A single position selects one base.
                {mode === 'motif' && ' Motifs include overlapping matches; ambiguity in the query matches resolved A/C/G/T bases.'}
              </p>
              {(mode === 'sequence' || mode === 'motif') && <p style={{ color: colors.textDim, fontSize: '0.9rem', margin: 0 }}>
                {topology === 'circular'
                  ? `${topologyOverride ? 'User-selected' : 'Annotated'} circular topology: matches may cross the origin once. Split ranges show both pieces; | marks the origin in forward-strand context. Queries cannot exceed the complete genome length.`
                  : source?.topology === 'unknown' && !topologyOverride
                    ? 'Genome topology is unknown. Searches stop at sequence ends; select circular only for a complete circular molecule.'
                    : 'Searching a linear interval: matches stop at sequence ends.'}
              </p>}
            </div>

            {(summary || status === 'searching') && (
              <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
                {summary || `Searching “${query.trim()}”…`}
                {status === 'searching' && summary && (
                  <span style={{ marginLeft: '0.5rem', color: colors.accent }}>Searching…</span>
                )}
              </div>
            )}

            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: '6px',
                background: colors.backgroundAlt,
                maxHeight: 'clamp(200px, 40vh, 500px)',
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {searchError ? (
                <OverlayErrorState
                  message="Search failed."
                  details={searchError}
                  onRetry={() => setManualSearchTrigger((t) => t + 1)}
                />
              ) : status === 'searching' ? (
                <OverlayLoadingState message="Searching the selected genome…">
                  <SearchResultsSkeleton count={4} />
                </OverlayLoadingState>
              ) : hits.length === 0 ? (
                <OverlayEmptyState
                  message={query.trim().length === 0 ? 'Type to search within the genome and annotations.' : 'No matches found.'}
                  hint={query.trim().length === 0 ? 'Try “ATG…”, a gene/product name, or a bp range like “1000-2000”.' : 'Try broadening the query or increasing the result limit.'}
                  style={{ padding: 'var(--space-4)' }}
                />
              ) : (
                <ul ref={resultsRef} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {hits.map((hit, idx) => {
                    const isSelected = idx === selectedIndex;
                    return (
                      <li
                        key={`${hit.position}-${idx}`}
                        data-result-index={idx}
                        onClick={() => navigateToResult(hit)}
                        style={{
                          padding: '0.75rem 1rem',
                          borderBottom: `1px solid ${colors.border}`,
                          display: 'grid',
                          gridTemplateColumns: '1fr auto',
                          gap: '0.5rem',
                          backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                          outline: isSelected ? `2px solid ${colors.accent}` : 'none',
                          outlineOffset: '-2px',
                          cursor: 'pointer',
                        }}
                      >
                      <div>
                        <div style={{ color: colors.primary, fontWeight: 600 }}>
                          {hit.label} {hit.matchType ? `· ${hit.matchType}` : ''}
                        </div>
                        <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
                          {hit.wrapsOrigin && hit.segments
                            ? `${hit.segments.map(segment => `${segment.start.toLocaleString()}-${segment.end.toLocaleString()}`).join(' + ')} (${hit.strand}) · crosses origin`
                            : `${hit.position.toLocaleString()}-${(hit.end ?? hit.position).toLocaleString()} (${hit.strand})`}
                        </div>
                        {hit.feature?.product && (
                          <div style={{ color: colors.textDim, fontSize: '0.9rem' }}>{hit.feature.product}</div>
                        )}
                        {hit.context && (
                          <pre
                            style={{
                              background: colors.background,
                              color: colors.text,
                              padding: '0.4rem',
                              borderRadius: '4px',
                              marginTop: '0.35rem',
                              fontSize: '0.85rem',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {hit.context}
                          </pre>
                        )}
                      </div>
                      {hit.score !== undefined && (
                        <div style={{ textAlign: 'right', color: colors.text }}>
                          <span style={{ color: colors.accent }}>Score</span>
                          <div style={{ fontFamily: 'monospace' }}>{hit.score.toFixed(2)}</div>
                        </div>
                      )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default SearchOverlay;
