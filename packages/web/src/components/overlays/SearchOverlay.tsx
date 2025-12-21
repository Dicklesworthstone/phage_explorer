import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useTheme } from '../../hooks/useTheme';
import { SearchResultsSkeleton } from '../ui/Skeleton';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import {
  getSearchWorker,
  type SearchWorkerAPI,
  type SearchMode,
  type SearchOptions,
  type SearchHit,
  type SearchFeature,
  type SearchRequest,
  type SearchResponse,
  type FuzzySearchEntry,
  type FuzzySearchResult,
} from '../../workers';

type StrandOption = SearchOptions['strand'];

type SearchOverlayFuzzyMeta = {
  feature: SearchFeature;
  label: string;
  matchType: string;
};

interface SearchOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

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

function extractContext(sequence: string, start: number, end: number, pad = 20): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(sequence.length, end + pad);
  return sequence.slice(s, e);
}

export function SearchOverlay({ repository, currentPhage }: SearchOverlayProps): React.ReactElement | null {
  const { isOpen, close } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;

  const [mode, setMode] = useState<SearchMode>('sequence');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [sequence, setSequence] = useState<string>('');
  const [features, setFeatures] = useState<SearchFeature[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'searching'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>('');
  const [workerReady, setWorkerReady] = useState(false);

  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const searchAbortRef = useRef<number | null>(null);
  const searchSeqRef = useRef(0);

  // Track if we're using a preloaded worker (don't terminate on unmount)
  const usingPreloadedRef = useRef(false);

  // Initialize worker - use preloaded if available, otherwise create new
  useEffect(() => {
    let cancelled = false;

    // Try to use preloaded worker first
    const preloaded = getSearchWorker();
    if (preloaded) {
      usingPreloadedRef.current = true;
      workerInstanceRef.current = preloaded.worker;
      workerRef.current = preloaded.api;
      if (preloaded.ready) {
        setWorkerReady(true);
      } else {
        // Preloaded worker exists but isn't ready yet - wait for it
        void (async () => {
          try {
            await preloaded.api.ping();
            if (!cancelled) {
              setWorkerReady(true);
            }
          } catch (e) {
            console.error('Preloaded search worker failed:', e);
          }
        })();
      }
      return;
    }

    // No preloaded worker - create new one (fallback)
    usingPreloadedRef.current = false;
    const worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
    workerInstanceRef.current = worker;
    const wrappedWorker = Comlink.wrap<SearchWorkerAPI>(worker);
    workerRef.current = wrappedWorker;

    // Verify worker is ready by calling ping
    void (async () => {
      try {
        await wrappedWorker.ping();
        if (!cancelled) {
          setWorkerReady(true);
        }
      } catch (e) {
        // Worker failed to initialize - keep workerReady false
        console.error('Search worker failed to initialize:', e);
      }
    })();

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
  }, []);

  // Load sequence + features when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('search')) return;
    if (!repository || !currentPhage) {
      setStatus('idle');
      setSequence('');
      setFeatures([]);
      setHits([]);
      setSummary('');
      setError('Database not loaded yet.');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setError(null);
    setSequence('');
    setFeatures([]);

    const load = async () => {
      try {
        const length = currentPhage.genomeLength ?? 0;
        const seq = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (cancelled) return;
        setSequence(seq);

        const mappedFeatures: SearchFeature[] = (currentPhage.genes ?? []).map((g) => ({
          start: g.startPos,
          end: g.endPos,
          strand: g.strand === '+' || g.strand === '-' ? g.strand : 'both',
          name: g.name ?? g.locusTag ?? undefined,
          product: g.product ?? undefined,
          type: g.type ?? 'CDS',
        }));
        setFeatures(mappedFeatures);
        setStatus('idle');
      } catch (e) {
        if (cancelled) return;
        setStatus('idle');
        const msg = e instanceof Error ? e.message : 'Failed to load sequence';
        setError(msg);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [currentPhage, isOpen, repository]);

  // Build request payload
  const request = useMemo<SearchRequest | null>(() => {
    if (!sequence || !currentPhage) return null;
    return {
      mode,
      query,
      sequence,
      features,
      options,
    };
  }, [sequence, currentPhage, mode, query, features, options]);

  // Keep fuzzy indices in sync for fast gene/feature search.
  useEffect(() => {
    if (!isOpen('search')) return;
    if (!workerReady || !workerRef.current) return;
    if (!currentPhage?.id) return;
    if (features.length === 0) return;

    const geneIndex = `search-overlay-gene:${currentPhage.id}`;
    const featureIndex = `search-overlay-feature:${currentPhage.id}`;

    const geneEntries: Array<FuzzySearchEntry<SearchOverlayFuzzyMeta>> = [];
    const featureEntries: Array<FuzzySearchEntry<SearchOverlayFuzzyMeta>> = [];

    for (let idx = 0; idx < features.length; idx++) {
      const f = features[idx];

      const name = f.name ?? '';
      const product = f.product ?? '';
      const geneText = `${name} ${product}`.trim();
      if (geneText) {
        geneEntries.push({
          id: `${currentPhage.id}:${idx}:${f.start}-${f.end}`,
          text: geneText,
          meta: {
            feature: f,
            label: f.name || f.product || 'Gene/feature match',
            matchType: 'gene/annotation',
          },
        });
      }

      const type = f.type ?? '';
      const featureText = `${type} ${name} ${product}`.trim();
      if (featureText) {
        featureEntries.push({
          id: `${currentPhage.id}:${idx}:${f.start}-${f.end}`,
          text: featureText,
          meta: {
            feature: f,
            label: `${type || 'Feature'}${name ? `: ${name}` : ''}`,
            matchType: 'feature',
          },
        });
      }
    }

    void workerRef.current.setFuzzyIndex({ index: geneIndex, entries: geneEntries });
    void workerRef.current.setFuzzyIndex({ index: featureIndex, entries: featureEntries });
  }, [currentPhage?.id, features, isOpen, workerReady]);

  const runSearch = useCallback(
    async (req: SearchRequest) => {
      if (!workerRef.current) return;
      try {
        setStatus('searching');
        const res = (await workerRef.current.runSearch(req)) as SearchResponse;
        setHits(res.hits);
        const truncated = (req.options?.maxResults ?? DEFAULT_OPTIONS.maxResults ?? 500) ?? 500;
        setSummary(
          `${res.hits.length}/${truncated} results for "${res.query}" in ${res.mode} mode${res.hits.length === truncated ? ' (truncated)' : ''}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Search failed';
        setError(msg);
      } finally {
        setStatus('idle');
      }
    },
    []
  );

  // Debounced search on query/options/mode
  useEffect(() => {
    if (!isOpen('search')) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSummary('');
      return;
    }

    if (searchAbortRef.current) {
      window.clearTimeout(searchAbortRef.current);
    }
    searchAbortRef.current = window.setTimeout(() => {
      const seq = ++searchSeqRef.current;

      const shouldUseFuzzy = (mode === 'gene' || mode === 'feature') && workerReady && workerRef.current && currentPhage?.id;
      if (!shouldUseFuzzy) {
        if (request) void runSearch(request);
        return;
      }

      void (async () => {
        try {
          setStatus('searching');
          const indexName =
            mode === 'gene' ? `search-overlay-gene:${currentPhage!.id}` : `search-overlay-feature:${currentPhage!.id}`;
          const limit = options.maxResults ?? DEFAULT_OPTIONS.maxResults ?? 500;

          const results = (await workerRef.current!.fuzzySearch({
            index: indexName,
            query: q,
            limit,
          })) as Array<FuzzySearchResult<SearchOverlayFuzzyMeta>>;
          if (searchSeqRef.current !== seq) return;

          const mapped: SearchHit[] = results
            .map((r): SearchHit | null => {
              const f = r.meta?.feature;
              if (!f) return null;
              const strand: SearchHit['strand'] = f.strand === '-' ? '-' : '+';
              return {
                position: f.start,
                end: f.end,
                strand,
                label: r.meta?.label ?? r.text,
                context: extractContext(sequence, f.start, f.end),
                feature: f,
                matchType: r.meta?.matchType,
                score: r.score,
              } as SearchHit;
            })
            .filter((h): h is SearchHit => h !== null);

          setHits(mapped);
          setSummary(
            `${mapped.length}/${limit} results for "${q}" in ${mode} mode${mapped.length === limit ? ' (truncated)' : ''}`
          );
        } catch (e) {
          if (searchSeqRef.current !== seq) return;
          const msg = e instanceof Error ? e.message : 'Search failed';
          setError(msg);
        } finally {
          if (searchSeqRef.current !== seq) return;
          setStatus('idle');
        }
      })();
    }, 200);

    return () => {
      if (searchAbortRef.current) {
        window.clearTimeout(searchAbortRef.current);
      }
    };
  }, [currentPhage, isOpen, mode, options.maxResults, query, request, runSearch, sequence, workerReady]);

  const toggleStrand = (value: StrandOption) => {
    setOptions((prev) => ({ ...prev, strand: value }));
  };

  const renderOptions = () => {
    return (
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: colors.text }}>
          <input
            type="checkbox"
            checked={options.caseSensitive ?? false}
            onChange={(e) => setOptions((prev) => ({ ...prev, caseSensitive: e.target.checked }))}
          />
          <span style={{ color: colors.textDim }}>Case sensitive</span>
        </label>

        {(mode === 'sequence' || mode === 'motif') && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: colors.text }}>
            <span style={{ color: colors.textDim }}>Strand:</span>
            <select
              value={options.strand ?? 'both'}
              onChange={(e) => toggleStrand(e.target.value as StrandOption)}
              style={{ background: colors.backgroundAlt, color: colors.text, border: `1px solid ${colors.border}` }}
            >
              <option value="both">both</option>
              <option value="+">+</option>
              <option value="-">-</option>
            </select>
          </label>
        )}

        {mode === 'sequence' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: colors.text }}>
            <span style={{ color: colors.textDim }}>Mismatches</span>
            <input
              type="number"
              min={0}
              max={3}
              value={options.mismatches ?? 0}
              onChange={(e) =>
                setOptions((prev) => ({ ...prev, mismatches: Math.max(0, Math.min(3, Number(e.target.value) || 0)) }))
              }
              style={{ width: '3rem', background: colors.backgroundAlt, color: colors.text, border: `1px solid ${colors.border}` }}
            />
          </label>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: colors.text }}>
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
            style={{ width: '4rem', background: colors.backgroundAlt, color: colors.text, border: `1px solid ${colors.border}` }}
          />
        </label>
      </div>
    );
  };

  if (!isOpen('search')) {
    return null;
  }

  const isReady = workerReady && sequence.length > 0 && status !== 'loading';
  const isInitializing = !workerReady || status === 'loading';

  return (
    <Overlay id="search" title="SEARCH" hotkey="/" size="xl" onClose={() => close('search')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Show skeleton while worker or sequence is loading */}
        {isInitializing && (
          <div aria-busy="true" aria-label="Initializing search">
            <SearchResultsSkeleton count={4} />
          </div>
        )}

        {/* Mode selector - only show when ready */}
        {!isInitializing && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              style={{
                padding: '0.4rem 0.7rem',
                borderRadius: '6px',
                border: `1px solid ${mode === m.id ? colors.borderFocus : colors.border}`,
                background: mode === m.id ? colors.backgroundAlt : colors.background,
                color: colors.text,
                cursor: 'pointer',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        )}

        {/* Query input - only show when ready */}
        {!isInitializing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <label style={{ color: colors.textDim, fontSize: '0.9rem' }}>Query</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              mode === 'sequence'
                ? 'ATCG...'
                : mode === 'motif'
                  ? 'IUPAC motif (e.g., TATAWR or regex fragment)'
                  : mode === 'gene'
                    ? 'Gene name/product'
                    : mode === 'feature'
                      ? 'Feature type/name'
                      : 'Position or range (e.g., 1000-2000, 5000)'
            }
            style={{
              padding: '0.6rem',
              borderRadius: '6px',
              border: `1px solid ${colors.border}`,
              background: colors.backgroundAlt,
              color: colors.text,
            }}
          />
          {renderOptions()}
        </div>
        )}

        {/* Error message - show errors even after initialization */}
        {error && !isInitializing && (
          <div style={{ color: colors.textMuted }}>
            Error: {error}
          </div>
        )}

        {summary && (
          <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
            {summary}
            {status === 'searching' && <span style={{ marginLeft: '0.5rem', color: colors.accent }}>Searching…</span>}
          </div>
        )}

        {isReady && (
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: '6px',
              background: colors.backgroundAlt,
              maxHeight: '360px',
              overflowY: 'auto',
            }}
          >
            {hits.length === 0 ? (
              <div style={{ padding: '1rem', color: colors.textDim }}>
                {query.trim().length === 0 ? 'Type to search within the genome and annotations.' : 'No matches found.'}
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {hits.map((hit, idx) => (
                  <li
                    key={`${hit.position}-${idx}`}
                    style={{
                      padding: '0.75rem 1rem',
                      borderBottom: `1px solid ${colors.border}`,
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      gap: '0.5rem',
                    }}
                  >
                    <div>
                      <div style={{ color: colors.primary, fontWeight: 600 }}>
                        {hit.label} {hit.matchType ? `· ${hit.matchType}` : ''}
                      </div>
                      <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
                        {hit.position.toLocaleString()}-{(hit.end ?? hit.position).toLocaleString()} ({hit.strand})
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
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default SearchOverlay;
