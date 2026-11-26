/**
 * PhagePickerSheet - Mobile-first phage discovery and selection
 *
 * Features:
 * - Search across names, accessions, hosts, families, and lifecycle
 * - Saved and recently viewed phage collections shared across the application
 * - Lifecycle filters, useful sorting, and live counts
 * - Random discovery action scoped to the current results
 * - Current phage highlighting and automatic scroll positioning
 * - Lazy worker startup so first paint and database loading stay fast
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import * as Comlink from 'comlink';
import { BottomSheet } from './BottomSheet';
import {
  getSearchWorker,
  type SearchWorkerAPI,
  type FuzzySearchEntry,
} from '../../workers';
import { haptics } from '../../utils/haptics';
import {
  clearRecentPhages,
  getPhageCollectionKey,
  readPhageCollections,
  recordRecentPhage,
  subscribeToPhageCollections,
  toggleFavoritePhage,
} from '../../utils/phage-collections';

export interface PhageListItem {
  id: number;
  slug?: string | null;
  name: string;
  accession?: string | null;
  host?: string | null;
  family?: string | null;
  lifecycle?: string | null;
  morphology?: string | null;
  genomeLength?: number | null;
  gcContent?: number | null;
}

interface PhagePickerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  phages: PhageListItem[];
  currentIndex: number;
  onSelectPhage: (index: number) => void;
}

type LifecycleFilter = 'all' | 'lytic' | 'temperate' | 'other';
type CollectionFilter = 'all' | 'favorites' | 'recent';
export type PhageSortMode = 'relevance' | 'name' | 'genomeLength' | 'gcContent';

interface PickerRanking {
  catalog: PhageListItem[];
  query: string;
  ids: number[];
}

export function getPickerResults(catalog: PhageListItem[], query: string, ranking: PickerRanking | null): PhageListItem[] {
  const term = query.trim().toLowerCase();
  if (!term) return catalog;
  if (ranking && ranking.catalog === catalog && ranking.query === term) {
    const byId = new Map(catalog.map(phage => [phage.id, phage]));
    return ranking.ids.map(id => byId.get(id)).filter((phage): phage is PhageListItem => phage !== undefined);
  }
  // A new query or catalog can render before the worker effect runs.
  return catalog.filter(phage =>
    [phage.name, phage.accession, phage.host, phage.family, phage.lifecycle, phage.morphology]
      .some(value => value?.toLowerCase().includes(term))
  );
}

interface FilterOption<T extends string> {
  id: T;
  label: string;
  count: number;
}

export function classifyLifecycle(lifecycle: string | null | undefined): Exclude<LifecycleFilter, 'all'> {
  const normalized = lifecycle?.trim().toLowerCase() ?? '';
  if (
    normalized.includes('lytic') ||
    normalized.includes('virulent') ||
    normalized.includes('obligately lytic')
  ) {
    return 'lytic';
  }
  if (
    normalized.includes('temperate') ||
    normalized.includes('lysogen') ||
    normalized.includes('prophage')
  ) {
    return 'temperate';
  }
  return 'other';
}

export const getPhageStorageKey = getPhageCollectionKey;

export function sortPhageList(
  phages: readonly PhageListItem[],
  mode: PhageSortMode,
  recentKeys: readonly string[] = []
): PhageListItem[] {
  const sorted = phages.slice();
  const byName = (left: PhageListItem, right: PhageListItem) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });

  if (mode === 'relevance') {
    if (recentKeys.length === 0) return sorted;
    const rank = new Map(recentKeys.map((key, index) => [key, index]));
    return sorted.sort((left, right) => {
      const leftRank = rank.get(getPhageStorageKey(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(getPhageStorageKey(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || byName(left, right);
    });
  }

  if (mode === 'name') return sorted.sort(byName);

  if (mode === 'genomeLength') {
    return sorted.sort((left, right) =>
      (right.genomeLength ?? -1) - (left.genomeLength ?? -1) || byName(left, right)
    );
  }

  return sorted.sort((left, right) =>
    (right.gcContent ?? -1) - (left.gcContent ?? -1) || byName(left, right)
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ShuffleIcon(): React.ReactElement {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 3 21 3 21 8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </svg>
  );
}

function StarIcon({ filled }: { filled: boolean }): React.ReactElement {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9L12 2.8Z" />
    </svg>
  );
}

export function PhagePickerSheet({
  isOpen,
  onClose,
  phages,
  currentIndex,
  onSelectPhage,
}: PhagePickerSheetProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('all');
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>('all');
  const [sortMode, setSortMode] = useState<PhageSortMode>('relevance');
  const [collections, setCollections] = useState(readPhageCollections);
  const { favoriteKeys, recentKeys } = collections;
  const [workerRequested, setWorkerRequested] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);
  const [indexedCatalog, setIndexedCatalog] = useState<PhageListItem[] | null>(null);
  const [ranking, setRanking] = useState<PickerRanking | null>(null);
  const query = searchQuery.trim().toLowerCase();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const usingPreloadedRef = useRef(false);

  useEffect(() => subscribeToPhageCollections(setCollections), []);

  useEffect(() => {
    const currentPhage = phages[currentIndex];
    if (!currentPhage) return;
    recordRecentPhage(currentPhage);
  }, [currentIndex, phages]);

  useEffect(() => {
    if (isOpen) setWorkerRequested(true);
  }, [isOpen]);

  useEffect(() => {
    if (!workerRequested) return;
    let cancelled = false;

    const preloaded = getSearchWorker();
    if (preloaded) {
      usingPreloadedRef.current = true;
      workerInstanceRef.current = preloaded.worker;
      workerRef.current = preloaded.api;
      if (preloaded.ready) {
        setWorkerReady(true);
      } else {
        void (async () => {
          try {
            await preloaded.api.ping();
            if (!cancelled) setWorkerReady(true);
          } catch {
            // The synchronous fallback below remains available.
          }
        })();
      }
    } else {
      usingPreloadedRef.current = false;
      let worker: Worker;
      try {
        worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
      } catch {
        try {
          worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url));
        } catch {
          // Policy or browser capabilities can disallow both kinds of worker.
          return;
        }
      }
      workerInstanceRef.current = worker;
      const wrapped = Comlink.wrap<SearchWorkerAPI>(worker);
      workerRef.current = wrapped;

      void (async () => {
        try {
          await wrapped.ping();
          if (!cancelled) setWorkerReady(true);
        } catch {
          // The synchronous fallback below remains available.
        }
      })();
    }

    return () => {
      cancelled = true;
      if (!usingPreloadedRef.current && workerInstanceRef.current) {
        workerInstanceRef.current.terminate();
      }
      workerInstanceRef.current = null;
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, [workerRequested]);

  useEffect(() => {
    setRanking(null);
    setIndexedCatalog(null);
    const worker = workerRef.current;
    if (!workerReady || !worker) return;
    let active = true;
    const entries: Array<FuzzySearchEntry<{ phageId: number }>> = phages.map((phage) => ({
      id: String(phage.id),
      text: [
        phage.name,
        phage.accession,
        phage.host,
        phage.family,
        phage.lifecycle,
        phage.morphology,
      ].filter(Boolean).join(' '),
      meta: { phageId: phage.id },
    }));
    void Promise.resolve().then(() => worker.setFuzzyIndex({ index: 'phage-picker', entries })).then(
      () => { if (active) setIndexedCatalog(phages); },
      () => { /* The literal catalog search remains available. */ }
    );
    return () => { active = false; };
  }, [phages, workerReady]);

  const phageIndexById = useMemo(
    () => new Map(phages.map((phage, index) => [phage.id, index])),
    [phages]
  );
  const phageKeySet = useMemo(() => new Set(phages.map(getPhageStorageKey)), [phages]);
  const favoriteKeySet = useMemo(() => new Set(favoriteKeys), [favoriteKeys]);
  const recentKeySet = useMemo(() => new Set(recentKeys), [recentKeys]);
  const favoriteCount = useMemo(
    () => favoriteKeys.filter((key) => phageKeySet.has(key)).length,
    [favoriteKeys, phageKeySet]
  );
  const recentCount = useMemo(
    () => recentKeys.filter((key) => phageKeySet.has(key)).length,
    [phageKeySet, recentKeys]
  );

  const collectionOptions = useMemo<FilterOption<CollectionFilter>[]>(() => [
    { id: 'all', label: 'All', count: phages.length },
    { id: 'favorites', label: 'Saved', count: favoriteCount },
    { id: 'recent', label: 'Recent', count: recentCount },
  ], [favoriteCount, phages.length, recentCount]);

  const lifecycleOptions = useMemo<FilterOption<LifecycleFilter>[]>(() => {
    const counts: Record<Exclude<LifecycleFilter, 'all'>, number> = {
      lytic: 0,
      temperate: 0,
      other: 0,
    };
    for (const phage of phages) {
      counts[classifyLifecycle(phage.lifecycle)] += 1;
    }

    return [
      { id: 'all', label: 'Any lifecycle', count: phages.length },
      { id: 'lytic', label: 'Lytic', count: counts.lytic },
      { id: 'temperate', label: 'Temperate', count: counts.temperate },
      { id: 'other', label: 'Other', count: counts.other },
    ].filter((option) => option.id === 'all' || option.count > 0) as FilterOption<LifecycleFilter>[];
  }, [phages]);

  const searchedPhages = useMemo(() => getPickerResults(phages, query, ranking), [phages, query, ranking]);

  const filteredPhages = useMemo(() => {
    let next = searchedPhages;

    if (collectionFilter === 'favorites') {
      next = next.filter((phage) => favoriteKeySet.has(getPhageStorageKey(phage)));
    } else if (collectionFilter === 'recent') {
      next = next.filter((phage) => recentKeySet.has(getPhageStorageKey(phage)));
    }

    if (lifecycleFilter !== 'all') {
      next = next.filter((phage) => classifyLifecycle(phage.lifecycle) === lifecycleFilter);
    }

    return sortPhageList(
      next,
      sortMode,
      collectionFilter === 'recent' && sortMode === 'relevance' ? recentKeys : []
    );
  }, [
    collectionFilter,
    favoriteKeySet,
    lifecycleFilter,
    recentKeySet,
    recentKeys,
    searchedPhages,
    sortMode,
  ]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!isOpen || !query || !workerReady || indexedCatalog !== phages || !worker) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => worker.fuzzySearch({
        index: 'phage-picker',
        query,
        limit: 200,
      })).then(results => {
        if (!active) return;
        const ids = results.map(result => Number(result.id)).filter(Number.isSafeInteger);
        setRanking({ catalog: phages, query, ids });
      }).catch(() => {
        if (active) setRanking(null);
      });
    }, 80);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [indexedCatalog, isOpen, phages, query, workerReady]);

  const handleSelect = useCallback(
    (index: number) => {
      if (index < 0 || index >= phages.length) return;
      haptics.selection();
      onSelectPhage(index);
      onClose();
      setSearchQuery('');
      setRanking(null);
    },
    [onClose, onSelectPhage, phages.length]
  );

  const handleToggleFavorite = useCallback((phage: PhageListItem) => {
    haptics.selection();
    toggleFavoritePhage(phage);
  }, []);

  const handleSurpriseMe = useCallback(() => {
    if (filteredPhages.length === 0) return;
    const eligible = filteredPhages.filter((phage) => phageIndexById.get(phage.id) !== currentIndex);
    const candidates = eligible.length > 0 ? eligible : filteredPhages;

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    const index = phageIndexById.get(chosen.id);
    if (index === undefined) return;
    haptics.medium();
    handleSelect(index);
  }, [currentIndex, filteredPhages, handleSelect, phageIndexById]);

  const resetDiscoveryFilters = useCallback(() => {
    setSearchQuery('');
    setRanking(null);
    setCollectionFilter('all');
    setLifecycleFilter('all');
    setSortMode('relevance');
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen || !selectedItemRef.current) return;
    if (collectionFilter !== 'all' || lifecycleFilter !== 'all' || searchQuery.trim()) return;
    const timer = window.setTimeout(() => {
      selectedItemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [collectionFilter, isOpen, lifecycleFilter, searchQuery]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setRanking(null);
    }
  }, [isOpen]);

  const resultLabel = filteredPhages.length === 1
    ? '1 phage'
    : `${filteredPhages.length} phages`;
  const collectionLabel = collectionFilter === 'favorites'
    ? ' saved'
    : collectionFilter === 'recent'
      ? ' recently viewed'
      : '';
  const emptyTitle = searchQuery.trim()
    ? 'No matching phages'
    : collectionFilter === 'favorites'
      ? 'No saved phages yet'
      : collectionFilter === 'recent'
        ? 'No recently viewed phages yet'
        : 'No phages in this filter';
  const emptyDescription = collectionFilter === 'favorites' && !searchQuery.trim()
    ? 'Tap the star beside any phage to keep it close at hand.'
    : collectionFilter === 'recent' && !searchQuery.trim()
      ? 'Open a phage and it will appear here automatically.'
      : 'Try a different search, collection, or lifecycle filter.';

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Explore phages"
      nativeModal
      initialSnapPoint="full"
      minHeight={45}
      maxHeight={92}
    >
      <div className="phage-picker-sheet" data-testid="phage-picker-sheet">
        <div className="phage-picker-sheet__controls">
          <div className="phage-picker-sheet__search">
            <SearchIcon />
            <input
              ref={searchInputRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Name, host, family, accession..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="phage-picker-sheet__search-input"
              aria-label="Search phages"
            />
            {searchQuery && (
              <button
                type="button"
                className="phage-picker-sheet__clear"
                onClick={() => {
                  setSearchQuery('');
                  setRanking(null);
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear phage search"
              >
                ×
              </button>
            )}
          </div>

          <div className="phage-picker-sheet__scope-row">
            <div className="phage-picker-sheet__filters" aria-label="Choose a phage collection">
              {collectionOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`phage-picker-sheet__filter phage-picker-sheet__filter--collection ${
                    collectionFilter === option.id ? 'phage-picker-sheet__filter--active' : ''
                  }`}
                  onClick={() => {
                    haptics.selection();
                    setCollectionFilter(option.id);
                  }}
                  aria-pressed={collectionFilter === option.id}
                >
                  <span>{option.label}</span>
                  <span className="phage-picker-sheet__filter-count">{option.count}</span>
                </button>
              ))}
            </div>
            {collectionFilter === 'recent' && recentCount > 0 && (
              <button
                type="button"
                className="phage-picker-sheet__clear-recents"
                onClick={() => {
                  haptics.light();
                  clearRecentPhages();
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div className="phage-picker-sheet__toolbar">
            <div className="phage-picker-sheet__filters" aria-label="Filter phages by lifecycle">
              {lifecycleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`phage-picker-sheet__filter ${
                    lifecycleFilter === option.id ? 'phage-picker-sheet__filter--active' : ''
                  }`}
                  onClick={() => {
                    haptics.selection();
                    setLifecycleFilter(option.id);
                  }}
                  aria-pressed={lifecycleFilter === option.id}
                >
                  <span>{option.label}</span>
                  <span className="phage-picker-sheet__filter-count">{option.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="phage-picker-sheet__actions-row">
            <label className="phage-picker-sheet__sort">
              <span>Sort</span>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as PhageSortMode)}
                aria-label="Sort phages"
              >
                <option value="relevance">Recommended</option>
                <option value="name">Name A–Z</option>
                <option value="genomeLength">Largest genome</option>
                <option value="gcContent">Highest GC</option>
              </select>
            </label>

            <button
              type="button"
              className="phage-picker-sheet__surprise"
              onClick={handleSurpriseMe}
              disabled={filteredPhages.length === 0}
              aria-label="Open a random phage from the current results"
            >
              <ShuffleIcon />
              <span>Surprise me</span>
            </button>
          </div>

          <div className="phage-picker-sheet__result-count" role="status" aria-live="polite">
            {resultLabel}{collectionLabel}
            {searchQuery.trim() ? ` matching “${searchQuery.trim()}”` : ''}
          </div>
        </div>

        <div
          className="phage-picker-sheet__list"
          role="list"
          aria-label="Phage list"
        >
          {filteredPhages.length === 0 ? (
            <div className="phage-picker-sheet__empty">
              <strong>{emptyTitle}</strong>
              <span>{emptyDescription}</span>
              <button
                type="button"
                className="phage-picker-sheet__empty-reset"
                onClick={resetDiscoveryFilters}
              >
                Show all phages
              </button>
            </div>
          ) : (
            filteredPhages.map((phage) => {
              const originalIndex = phageIndexById.get(phage.id) ?? -1;
              const isSelected = originalIndex === currentIndex;
              const storageKey = getPhageStorageKey(phage);
              const isFavorite = favoriteKeySet.has(storageKey);
              const headlineMeta = [phage.host, phage.family].filter(Boolean).join(' · ');
              const identifierMeta = [phage.accession, phage.morphology].filter(Boolean).join(' · ');
              const numericMeta = [
                phage.genomeLength ? `${phage.genomeLength.toLocaleString()} bp` : null,
                phage.gcContent !== null && phage.gcContent !== undefined
                  ? `${phage.gcContent.toFixed(1)}% GC`
                  : null,
              ].filter(Boolean).join(' · ');

              return (
                <div
                  key={phage.id}
                  ref={isSelected ? selectedItemRef : undefined}
                  className={`phage-picker-sheet__item ${
                    isSelected ? 'phage-picker-sheet__item--selected' : ''
                  }`}
                  role="listitem"
                  data-testid={`phage-picker-item-${phage.id}`}
                >
                  <button
                    type="button"
                    className="phage-picker-sheet__item-main"
                    onClick={() => handleSelect(originalIndex)}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={`Open ${phage.name}${isSelected ? ', current phage' : ''}`}
                  >
                    <div className="phage-picker-sheet__item-content">
                      <div className="phage-picker-sheet__item-heading">
                        <span className="phage-picker-sheet__item-name">{phage.name}</span>
                        {phage.lifecycle && (
                          <span className="phage-picker-sheet__item-lifecycle">
                            {phage.lifecycle}
                          </span>
                        )}
                      </div>
                      {headlineMeta && (
                        <span className="phage-picker-sheet__item-meta">{headlineMeta}</span>
                      )}
                      {identifierMeta && (
                        <span className="phage-picker-sheet__item-meta phage-picker-sheet__item-meta--identifier">
                          {identifierMeta}
                        </span>
                      )}
                      {numericMeta && (
                        <span className="phage-picker-sheet__item-meta phage-picker-sheet__item-meta--numeric">
                          {numericMeta}
                        </span>
                      )}
                    </div>
                    {isSelected && (
                      <span className="phage-picker-sheet__item-check" aria-hidden="true">
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`phage-picker-sheet__favorite ${
                      isFavorite ? 'phage-picker-sheet__favorite--active' : ''
                    }`}
                    onClick={() => handleToggleFavorite(phage)}
                    aria-label={`${isFavorite ? 'Remove' : 'Save'} ${phage.name}`}
                    aria-pressed={isFavorite}
                  >
                    <StarIcon filled={isFavorite} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </BottomSheet>
  );
}