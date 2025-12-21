/**
 * PhagePickerSheet - Bottom sheet for quick phage selection
 *
 * Features:
 * - Searchable list of all phages
 * - Current phage highlighted
 * - Tap to select and close
 * - Uses BottomSheet for native-feeling interaction
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import * as Comlink from 'comlink';
import { BottomSheet } from './BottomSheet';
import {
  getSearchWorker,
  type SearchWorkerAPI,
  type FuzzySearchEntry,
  type FuzzySearchResult,
} from '../../workers';

interface PhageListItem {
  id: number;
  name: string;
  host?: string | null;
  genomeLength?: number | null;
}

interface PhagePickerSheetProps {
  /** Whether the sheet is open */
  isOpen: boolean;
  /** Handler to close the sheet */
  onClose: () => void;
  /** List of all phages */
  phages: PhageListItem[];
  /** Index of currently selected phage */
  currentIndex: number;
  /** Handler when a phage is selected */
  onSelectPhage: (index: number) => void;
}

/**
 * Search icon SVG
 */
function SearchIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
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

/**
 * Check icon for selected item
 */
function CheckIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
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

export function PhagePickerSheet({
  isOpen,
  onClose,
  phages,
  currentIndex,
  onSelectPhage,
}: PhagePickerSheetProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const workerRef = useRef<Comlink.Remote<SearchWorkerAPI> | null>(null);
  const workerInstanceRef = useRef<Worker | null>(null);
  const usingPreloadedRef = useRef(false);
  const searchSeqRef = useRef(0);
  const [rankedIds, setRankedIds] = useState<number[] | null>(null);

  // Initialize search worker (prefer preloaded instance).
  useEffect(() => {
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
            // Keep workerReady false; fallback will still work.
          }
        })();
      }
      return;
    }

    usingPreloadedRef.current = false;
    const worker = new Worker(new URL('../../workers/search.worker.ts', import.meta.url), { type: 'module' });
    workerInstanceRef.current = worker;
    const wrapped = Comlink.wrap<SearchWorkerAPI>(worker);
    workerRef.current = wrapped;

    void (async () => {
      try {
        await wrapped.ping();
        if (!cancelled) setWorkerReady(true);
      } catch {
        // Keep workerReady false; fallback will still work.
      }
    })();

    return () => {
      cancelled = true;
      if (!usingPreloadedRef.current && workerInstanceRef.current) {
        workerInstanceRef.current.terminate();
      }
      workerInstanceRef.current = null;
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, []);

  // Keep worker index in sync with phage list.
  useEffect(() => {
    if (!workerReady || !workerRef.current) return;
    const entries: Array<FuzzySearchEntry<{ phageId: number }>> = phages.map((p) => ({
      id: String(p.id),
      text: `${p.name} ${p.host ?? ''}`.trim(),
      meta: { phageId: p.id },
    }));
    void workerRef.current.setFuzzyIndex({ index: 'phage-picker', entries });
  }, [phages, workerReady]);

  // Filter phages by search query
  const filteredPhages = useMemo(() => {
    if (!searchQuery.trim()) return phages;
    if (rankedIds && rankedIds.length > 0) {
      const byId = new Map(phages.map((p) => [p.id, p] as const));
      const ranked = rankedIds.map((id) => byId.get(id)).filter(Boolean) as PhageListItem[];
      if (ranked.length > 0) return ranked;
    }
    // Fallback while the worker warms up / for very small datasets.
    const query = searchQuery.toLowerCase();
    return phages.filter(
      (phage) =>
        phage.name.toLowerCase().includes(query) ||
        phage.host?.toLowerCase().includes(query)
    );
  }, [phages, searchQuery, rankedIds]);

  // Run fuzzy search in worker when query changes.
  useEffect(() => {
    if (!isOpen) return;
    if (!searchQuery.trim()) {
      setRankedIds(null);
      return;
    }
    if (!workerReady || !workerRef.current) return;

    const seq = ++searchSeqRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const results = (await workerRef.current!.fuzzySearch({
            index: 'phage-picker',
            query: searchQuery,
            limit: 200,
          })) as Array<FuzzySearchResult<{ phageId: number }>>;
          if (searchSeqRef.current !== seq) return;
          setRankedIds(
            results
              .map((r) => Number(r.id))
              .filter((id) => Number.isFinite(id))
          );
        } catch {
          if (searchSeqRef.current !== seq) return;
          setRankedIds(null);
        }
      })();
    }, 80);

    return () => window.clearTimeout(timer);
  }, [isOpen, searchQuery, workerReady]);

  // Handle phage selection
  const handleSelect = useCallback(
    (index: number) => {
      onSelectPhage(index);
      onClose();
      setSearchQuery(''); // Reset search on close
      setRankedIds(null);
    },
    [onSelectPhage, onClose]
  );

  // Focus search input when sheet opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      // Small delay to let animation start
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Reset search when sheet closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setRankedIds(null);
    }
  }, [isOpen]);

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="Select Phage"
      initialSnapPoint="half"
      maxHeight={85}
    >
      <div className="phage-picker-sheet">
        {/* Search Input */}
        <div className="phage-picker-sheet__search">
          <SearchIcon />
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search phages..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="phage-picker-sheet__search-input"
            aria-label="Search phages"
          />
        </div>

        {/* Phage List */}
        <div
          className="phage-picker-sheet__list"
          role="listbox"
          aria-label="Phage list"
        >
          {filteredPhages.length === 0 ? (
            <div className="phage-picker-sheet__empty">
              No phages match "{searchQuery}"
            </div>
          ) : (
            filteredPhages.map((phage) => {
              // Find original index (for navigation)
              const originalIndex = phages.findIndex((p) => p.id === phage.id);
              const isSelected = originalIndex === currentIndex;

              return (
                <button
                  key={phage.id}
                  type="button"
                  className={`phage-picker-sheet__item ${
                    isSelected ? 'phage-picker-sheet__item--selected' : ''
                  }`}
                  onClick={() => handleSelect(originalIndex)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="phage-picker-sheet__item-content">
                    <span className="phage-picker-sheet__item-name">
                      {phage.name}
                    </span>
                    <span className="phage-picker-sheet__item-meta">
                      {phage.host ?? 'Unknown host'}
                      {phage.genomeLength && (
                        <>
                          {' '}
                          · {phage.genomeLength.toLocaleString()} bp
                        </>
                      )}
                    </span>
                  </div>
                  {isSelected && (
                    <span className="phage-picker-sheet__item-check">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

export default PhagePickerSheet;
