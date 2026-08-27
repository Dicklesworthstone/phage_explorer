export interface PhageCollectionIdentity {
  id: number;
  slug?: string | null;
  accession?: string | null;
}

export interface PhageCollectionsSnapshot {
  favoriteKeys: string[];
  recentKeys: string[];
}

export const FAVORITE_PHAGES_STORAGE_KEY = 'phage-explorer:favorite-phages:v1';
export const RECENT_PHAGES_STORAGE_KEY = 'phage-explorer:recent-phages:v1';
export const PHAGE_COLLECTIONS_EVENT = 'phage-explorer:collections-changed';
export const MAX_RECENT_PHAGES = 12;
export const MAX_FAVORITE_PHAGES = 500;

function normalizeCollectionKey(value: string): string {
  return value.trim().toLowerCase();
}

export function getPhageCollectionKey(phage: PhageCollectionIdentity): string {
  const slug = phage.slug?.trim();
  if (slug) return `slug:${slug.toLowerCase()}`;

  const accession = phage.accession?.trim();
  if (accession) return `accession:${accession.toLowerCase()}`;

  return `id:${phage.id}`;
}

export function sanitizeCollectionKeys(values: unknown, maxItems: number): string[] {
  if (!Array.isArray(values) || maxItems <= 0) return [];

  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeCollectionKey(value);
    if (!normalized || normalized.length > 180 || seen.has(normalized)) continue;
    seen.add(normalized);
    sanitized.push(normalized);
    if (sanitized.length >= maxItems) break;
  }

  return sanitized;
}

function readStoredKeys(storageKey: string, maxItems: number): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    return sanitizeCollectionKeys(parsed, maxItems);
  } catch {
    return [];
  }
}

function persistStoredKeys(storageKey: string, values: readonly string[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(values));
  } catch {
    // Collections remain usable for the current interaction when storage is unavailable.
  }
}

export function readPhageCollections(): PhageCollectionsSnapshot {
  return {
    favoriteKeys: readStoredKeys(FAVORITE_PHAGES_STORAGE_KEY, MAX_FAVORITE_PHAGES),
    recentKeys: readStoredKeys(RECENT_PHAGES_STORAGE_KEY, MAX_RECENT_PHAGES),
  };
}

function emitCollections(snapshot: PhageCollectionsSnapshot): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<PhageCollectionsSnapshot>(PHAGE_COLLECTIONS_EVENT, {
      detail: {
        favoriteKeys: snapshot.favoriteKeys.slice(),
        recentKeys: snapshot.recentKeys.slice(),
      },
    })
  );
}

function writeCollections(snapshot: PhageCollectionsSnapshot): PhageCollectionsSnapshot {
  const normalized: PhageCollectionsSnapshot = {
    favoriteKeys: sanitizeCollectionKeys(snapshot.favoriteKeys, MAX_FAVORITE_PHAGES),
    recentKeys: sanitizeCollectionKeys(snapshot.recentKeys, MAX_RECENT_PHAGES),
  };

  persistStoredKeys(FAVORITE_PHAGES_STORAGE_KEY, normalized.favoriteKeys);
  persistStoredKeys(RECENT_PHAGES_STORAGE_KEY, normalized.recentKeys);
  emitCollections(normalized);
  return normalized;
}

export function isFavoritePhage(phage: PhageCollectionIdentity): boolean {
  const key = getPhageCollectionKey(phage);
  return readPhageCollections().favoriteKeys.includes(key);
}

export function toggleFavoritePhage(phage: PhageCollectionIdentity): PhageCollectionsSnapshot {
  const snapshot = readPhageCollections();
  const key = getPhageCollectionKey(phage);
  const favoriteKeys = snapshot.favoriteKeys.includes(key)
    ? snapshot.favoriteKeys.filter((candidate) => candidate !== key)
    : [key, ...snapshot.favoriteKeys];

  return writeCollections({ ...snapshot, favoriteKeys });
}

export function recordRecentPhage(phage: PhageCollectionIdentity): PhageCollectionsSnapshot {
  const snapshot = readPhageCollections();
  const key = getPhageCollectionKey(phage);
  if (snapshot.recentKeys[0] === key) return snapshot;

  return writeCollections({
    ...snapshot,
    recentKeys: [key, ...snapshot.recentKeys.filter((candidate) => candidate !== key)],
  });
}

export function clearRecentPhages(): PhageCollectionsSnapshot {
  const snapshot = readPhageCollections();
  if (snapshot.recentKeys.length === 0) return snapshot;
  return writeCollections({ ...snapshot, recentKeys: [] });
}

export function subscribeToPhageCollections(
  listener: (snapshot: PhageCollectionsSnapshot) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const handleCollectionsEvent = (event: Event) => {
    const customEvent = event as CustomEvent<PhageCollectionsSnapshot>;
    const detail = customEvent.detail;
    listener(
      detail
        ? {
            favoriteKeys: sanitizeCollectionKeys(detail.favoriteKeys, MAX_FAVORITE_PHAGES),
            recentKeys: sanitizeCollectionKeys(detail.recentKeys, MAX_RECENT_PHAGES),
          }
        : readPhageCollections()
    );
  };

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key !== FAVORITE_PHAGES_STORAGE_KEY &&
      event.key !== RECENT_PHAGES_STORAGE_KEY &&
      event.key !== null
    ) {
      return;
    }
    listener(readPhageCollections());
  };

  window.addEventListener(PHAGE_COLLECTIONS_EVENT, handleCollectionsEvent);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(PHAGE_COLLECTIONS_EVENT, handleCollectionsEvent);
    window.removeEventListener('storage', handleStorage);
  };
}
