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
import { createLocalGenomeRepository, useLocalGenomes } from '../db/local-genomes';

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
  const localGenomes = useLocalGenomes(state => state.genomes);

  const repository = useMemo(() => {
    if (!query.repository && localGenomes.length === 0) return null;
    const combined = localGenomes.length ? createLocalGenomeRepository(query.repository, localGenomes) : query.repository!;
    return createShareAwareRepository(combined, initialShareState.phageKey);
  }, [initialShareState.phageKey, query.repository, localGenomes]);

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
