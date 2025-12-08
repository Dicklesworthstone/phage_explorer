import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createDatabaseLoader, type PhageRepository, type DatabaseLoadProgress } from '../db';

const DEFAULT_DATABASE_URL = '/phage.db';

export interface UseDatabaseQueryOptions {
  databaseUrl?: string;
}

export interface UseDatabaseQueryResult {
  repository: PhageRepository | null;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  progress: DatabaseLoadProgress | null;
  isCached: boolean;
  reload: () => Promise<void>;
}

export function useDatabaseQuery(
  options: UseDatabaseQueryOptions = {}
): UseDatabaseQueryResult {
  const { databaseUrl = DEFAULT_DATABASE_URL } = options;
  const [progress, setProgress] = useState<DatabaseLoadProgress | null>(null);
  const [isCached, setIsCached] = useState(false);
  const loaderRef = useRef<ReturnType<typeof createDatabaseLoader> | null>(null);
  const queryClient = useQueryClient();

  const query = useQuery<PhageRepository>({
    queryKey: ['database', databaseUrl],
    queryFn: async () => {
      loaderRef.current?.close().catch(() => {});
      loaderRef.current = createDatabaseLoader(databaseUrl, (p) => {
        setProgress(p);
        if (p.cached !== undefined) {
          setIsCached(p.cached);
        }
      });
      return loaderRef.current.load();
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    return () => {
      loaderRef.current?.close().catch(() => {});
      loaderRef.current = null;
    };
  }, [databaseUrl]);

  const reload = useCallback(async () => {
    if (loaderRef.current) {
      await loaderRef.current.clearCache();
    }
    await queryClient.invalidateQueries({ queryKey: ['database', databaseUrl] });
    await queryClient.refetchQueries({ queryKey: ['database', databaseUrl], type: 'active' });
  }, [databaseUrl, queryClient]);

  return {
    repository: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    progress,
    isCached,
    reload,
  };
}

export default useDatabaseQuery;

