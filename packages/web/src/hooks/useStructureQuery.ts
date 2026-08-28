import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  loadStructure,
  type BondDetail,
  type LoadedStructure,
  type ProgressInfo,
  type LoadingStage,
} from '../visualization/structure-loader';

export interface UseStructureQueryOptions {
  idOrUrl?: string | null;
  enabled?: boolean;
  staleTimeMs?: number;
  includeBonds?: BondDetail;
  includeFunctionalGroups?: boolean;
}

export interface StructureQueryResult {
  data: LoadedStructure | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  progress: number;
  loadingStage: LoadingStage | null;
  /** Whether the structure was loaded from IndexedDB cache (fast path) */
  fromCache: boolean;
}

const STRUCTURE_STALE_TIME = 5 * 60 * 1000;
const STRUCTURE_GC_TIME = 30 * 60 * 1000;

export function useStructureQuery(options: UseStructureQueryOptions): StructureQueryResult {
  const {
    idOrUrl,
    enabled = true,
    staleTimeMs = STRUCTURE_STALE_TIME,
    includeBonds = 'auto',
    includeFunctionalGroups = false,
  } = options;

  const [progress, setProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState<LoadingStage | null>(null);
  const lastIdRef = useRef<string | null>(null);
  // Create a stable progress callback
  const onProgress = useCallback((info: ProgressInfo) => {
    setProgress(info.percent);
    setLoadingStage(info.stage);
  }, []);

  // Keep previous data only when the structure ID stays the same (e.g. toggling options).
  const keepPreviousData = lastIdRef.current !== null && lastIdRef.current === idOrUrl;
  useEffect(() => {
    lastIdRef.current = idOrUrl ?? null;
  }, [idOrUrl]);

  const query = useQuery<LoadedStructure>({
    queryKey: ['structure', idOrUrl, includeBonds, includeFunctionalGroups],
    queryFn: async ({ signal }) => {
      if (!idOrUrl) throw new Error('No structure id/url provided');
      // Reset progress and cache status on new load
      setProgress(0);
      setLoadingStage(null);

      return loadStructure(idOrUrl, signal, onProgress, {
        includeBonds,
        includeFunctionalGroups,
      });
    },
    enabled: Boolean(idOrUrl) && enabled,
    staleTime: staleTimeMs,
    gcTime: STRUCTURE_GC_TIME,
    retry: 1,
    placeholderData: keepPreviousData ? (prev) => prev : undefined,
  });

  // Reset progress when query succeeds, update cache status
  useEffect(() => {
    if (query.data && !query.isFetching) {
      setProgress(100);
      setLoadingStage(null);
    }
  }, [query.data, query.isFetching]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    progress,
    loadingStage,
    fromCache: query.data?.fromCache ?? false,
  };
}

/**
 * Prefetch structures for adjacent phages to reduce perceived load time.
 * Runs in the background after a short delay to not block current loading.
 */
export function usePrefetchAdjacentStructures(
  adjacentPdbIds: (string | null | undefined)[],
  enabled = true
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    // Delay prefetch to not compete with current structure loading
    const timeoutId = setTimeout(() => {
      for (const pdbId of adjacentPdbIds) {
        if (!pdbId) continue;

        // Only prefetch if not already in cache
        const existing = queryClient.getQueryData(['structure', pdbId, 'auto', false]);
        if (existing) continue;

        // Prefetch with low priority (won't block UI)
        void queryClient.prefetchQuery({
          queryKey: ['structure', pdbId, 'auto', false],
          queryFn: ({ signal }) => loadStructure(pdbId, signal),
          staleTime: STRUCTURE_STALE_TIME,
          gcTime: STRUCTURE_GC_TIME,
        });
      }
    }, 1500); // Wait 1.5s after current phage loads before prefetching

    return () => clearTimeout(timeoutId);
  }, [adjacentPdbIds, enabled, queryClient]);
}

export default useStructureQuery;
