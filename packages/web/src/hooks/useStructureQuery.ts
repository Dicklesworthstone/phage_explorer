import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loadStructure, type LoadedStructure } from '../visualization/structure-loader';

export interface UseStructureQueryOptions {
  idOrUrl?: string | null;
  enabled?: boolean;
  staleTimeMs?: number;
}

const STRUCTURE_STALE_TIME = 5 * 60 * 1000;
const STRUCTURE_GC_TIME = 30 * 60 * 1000;

export function useStructureQuery(options: UseStructureQueryOptions) {
  const {
    idOrUrl,
    enabled = true,
    staleTimeMs = STRUCTURE_STALE_TIME,
  } = options;

  const query = useQuery<LoadedStructure>({
    queryKey: ['structure', idOrUrl],
    queryFn: ({ signal }) => {
      if (!idOrUrl) throw new Error('No structure id/url provided');
      return loadStructure(idOrUrl, signal);
    },
    enabled: Boolean(idOrUrl) && enabled,
    staleTime: staleTimeMs,
    gcTime: STRUCTURE_GC_TIME,
    retry: 1,
  });

  return query;
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
        const existing = queryClient.getQueryData(['structure', pdbId]);
        if (existing) continue;

        // Prefetch with low priority (won't block UI)
        void queryClient.prefetchQuery({
          queryKey: ['structure', pdbId],
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

