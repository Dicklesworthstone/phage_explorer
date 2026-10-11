import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createProgressiveDatabaseLoader } from '../db/ProgressiveDatabaseLoader';
import { getDatabaseSession } from '../db/DatabaseSession';
import type { DatabaseLoadProgress, PhageRepository } from '../db';

const DEFAULT_DATABASE_URL = '/phage.db';

export interface UseDatabaseQueryOptions {
  databaseUrl?: string;
  /** When false, this observer does not start a load; call load() explicitly. */
  enabled?: boolean;
}
export interface UseDatabaseQueryResult {
  /** Borrowed snapshot. Its loader is owned by the shared session, not the caller. */
  repository: PhageRepository | null;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  progress: DatabaseLoadProgress | null;
  isCached: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * Share the live database within this QueryClient without putting a closeable
 * SQLite object into its result cache. Fetch lifetimes belong to DatabaseSession;
 * use load/reload, not generic query invalidation, to request database work.
 */
export function useDatabaseQuery(options: UseDatabaseQueryOptions = {}): UseDatabaseQueryResult {
  const { databaseUrl = DEFAULT_DATABASE_URL, enabled = true } = options;
  const client = useQueryClient();
  const session = useMemo(() => getDatabaseSession(client, databaseUrl, createProgressiveDatabaseLoader), [client, databaseUrl]);
  const observer = useMemo(() => session.createObserver(), [session]);
  const snapshot = useSyncExternalStore(observer.subscribe, observer.getSnapshot, observer.getSnapshot);

  // Release the previously displayed snapshot only after this render's effects
  // commit. Child queries already running retain their own method-call leases.
  useEffect(() => { observer.commit(snapshot.repository); }, [observer, snapshot.repository]);
  useEffect(() => {
    if (enabled) void session.load().catch(() => {
      // The shared snapshot exposes errors. Explicit load/reload callers still
      // receive rejection; an unmounted auto-loader has no UI left to notify.
    });
  }, [enabled, session]);

  return { ...snapshot,
    isLoading: snapshot.isLoading || (enabled && !snapshot.repository && !snapshot.error),
    load: session.load, reload: session.reload };
}

export default useDatabaseQuery;
