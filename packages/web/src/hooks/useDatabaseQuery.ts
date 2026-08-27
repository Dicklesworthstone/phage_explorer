import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createDatabaseLoader, type PhageRepository, type DatabaseLoadProgress } from '../db';

const DEFAULT_DATABASE_URL = '/phage.db';

export interface UseDatabaseQueryOptions {
  databaseUrl?: string;
  /** When false, the query will not auto-run; call `load()` manually. */
  enabled?: boolean;
}

export interface UseDatabaseQueryResult {
  repository: PhageRepository | null;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  progress: DatabaseLoadProgress | null;
  isCached: boolean;
  /** Trigger initial load when `enabled` is false. */
  load: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useDatabaseQuery(
  options: UseDatabaseQueryOptions = {}
): UseDatabaseQueryResult {
  const { databaseUrl = DEFAULT_DATABASE_URL, enabled = true } = options;
  const [progress, setProgress] = useState<DatabaseLoadProgress | null>(null);
  const [isCached, setIsCached] = useState(false);
  const loaderRef = useRef<ReturnType<typeof createDatabaseLoader> | null>(null);
  const inFlightLoaderRef = useRef<ReturnType<typeof createDatabaseLoader> | null>(null);
  const loadGenerationRef = useRef(0);

  const query = useQuery<PhageRepository>({
    queryKey: ['database', databaseUrl],
    queryFn: async () => {
      const generation = ++loadGenerationRef.current;
      const previousLoader = loaderRef.current;

      await inFlightLoaderRef.current?.close().catch(() => {});
      const nextLoader = createDatabaseLoader(databaseUrl, (nextProgress) => {
        if (generation !== loadGenerationRef.current) return;
        setProgress(nextProgress);
        if (nextProgress.cached !== undefined) {
          setIsCached(nextProgress.cached);
        }
      });
      inFlightLoaderRef.current = nextLoader;

      setProgress({
        stage: 'checking',
        percent: 0,
        message: 'Starting database load...',
        cached: false,
      });
      setIsCached(false);

      try {
        const repository = await nextLoader.load();
        if (generation !== loadGenerationRef.current) {
          await nextLoader.close().catch(() => {});
          throw new Error('Database load superseded by a newer request');
        }

        loaderRef.current = nextLoader;
        inFlightLoaderRef.current = null;

        if (previousLoader && previousLoader !== nextLoader) {
          await previousLoader.close().catch(() => {});
        }

        return repository;
      } catch (error) {
        if (inFlightLoaderRef.current === nextLoader) {
          inFlightLoaderRef.current = null;
        }
        await nextLoader.close().catch(() => {});
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    enabled,
  });

  useEffect(() => {
    return () => {
      loadGenerationRef.current += 1;
      inFlightLoaderRef.current?.close().catch(() => {});
      inFlightLoaderRef.current = null;
      loaderRef.current?.close().catch(() => {});
      loaderRef.current = null;
    };
  }, [databaseUrl]);

  const load = useCallback(async () => {
    await query.refetch({ cancelRefetch: false });
  }, [query.refetch]);

  const reload = useCallback(async () => {
    const loaders = [loaderRef.current, inFlightLoaderRef.current].filter(
      (loader, index, all): loader is ReturnType<typeof createDatabaseLoader> =>
        loader !== null && all.indexOf(loader) === index
    );

    for (const loader of loaders) {
      await loader.clearCache().catch(() => {});
    }

    await query.refetch({ cancelRefetch: true });
  }, [query.refetch]);

  return {
    repository: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    progress,
    isCached,
    load,
    reload,
  };
}

export default useDatabaseQuery;
