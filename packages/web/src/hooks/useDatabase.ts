/**
 * useDatabase Hook for Phage Explorer Web
 *
 * React hook for loading and accessing the phage database.
 */

import { useCallback, useMemo } from 'react';
import type { PhageRepository, DatabaseLoadProgress } from '../db';
import { createShareAwareRepository } from '../db/createShareAwareRepository';
import { getInitialShareState } from '../utils/share-state';
import { useDatabaseQuery } from './useDatabaseQuery';

export interface UseDatabaseOptions {
  /** URL to load the database from */
  databaseUrl?: string;
  /** Auto-load on mount */
  autoLoad?: boolean;
}

export interface UseDatabaseResult {
  /** The database repository (null if not loaded) */
  repository: PhageRepository | null;
  /** Whether the database is currently loading */
  isLoading: boolean;
  /** Whether a background refetch is in progress */
  isFetching: boolean;
  /** Load progress information */
  progress: DatabaseLoadProgress | null;
  /** Error message if loading failed */
  error: string | null;
  /** Whether the database was loaded from cache */
  isCached: boolean;
  /** Manually trigger database load */
  load: () => Promise<void>;
  /** Reload the database (clear cache and download fresh) */
  reload: () => Promise<void>;
}

/**
 * Hook for loading and accessing the phage database
 *
 * @example
 * const { repository, isLoading, progress, error } = useDatabase();
 *
 * if (isLoading) {
 *   return <LoadingScreen progress={progress} />;
 * }
 *
 * if (error) {
 *   return <ErrorScreen message={error} />;
 * }
 *
 * // Use repository to query phages
 * const phages = await repository?.listPhages();
 */
export function useDatabase(options: UseDatabaseOptions = {}): UseDatabaseResult {
  const { databaseUrl = '/phage.db', autoLoad = true } = options;
  const query = useDatabaseQuery({ databaseUrl, enabled: autoLoad });
  const initialShareState = getInitialShareState();

  const repository = useMemo(() => {
    if (!query.repository) return null;
    return createShareAwareRepository(query.repository, initialShareState.phageKey);
  }, [initialShareState.phageKey, query.repository]);

  const load = useCallback(async () => {
    await query.load();
  }, [query.load]);

  return {
    repository,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    progress: query.progress,
    error: query.error,
    isCached: query.isCached,
    load,
    reload: query.reload,
  };
}

export default useDatabase;
