import { useQuery } from '@tanstack/react-query';
import { loadStructure, type LoadedStructure } from '../visualization/structure-loader';

export interface UseStructureQueryOptions {
  idOrUrl?: string | null;
  enabled?: boolean;
  staleTimeMs?: number;
}

export function useStructureQuery(options: UseStructureQueryOptions) {
  const {
    idOrUrl,
    enabled = true,
    staleTimeMs = 5 * 60 * 1000,
  } = options;

  const query = useQuery<LoadedStructure>({
    queryKey: ['structure', idOrUrl],
    queryFn: ({ signal }) => {
      if (!idOrUrl) throw new Error('No structure id/url provided');
      return loadStructure(idOrUrl, signal);
    },
    enabled: Boolean(idOrUrl) && enabled,
    staleTime: staleTimeMs,
    gcTime: 30 * 60 * 1000,
    retry: 1,
  });

  return query;
}

export default useStructureQuery;

