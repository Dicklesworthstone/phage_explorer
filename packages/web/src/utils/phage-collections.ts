export interface PhageCollectionIdentity {
  id: number;
  slug?: string | null;
  accession?: string | null;
}

export interface PhageCollectionsSnapshot {
  favoriteKeys: string[];
  recentKeys: string[];
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ResilientCollectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): boolean;
}

export const FAVORITE_PHAGES_STORAGE_KEY = 'phage-explorer:favorite-phages:v1';
export const RECENT_PHAGES_STORAGE_KEY = 'phage-explorer:recent-phages:v1';
export const PHAGE_COLLECTIONS_EVENT = 'phage-explorer:collections-changed';
export const MAX_RECENT_PHAGES = 12;
export const MAX_FAVORITE_PHAGES = 500;

export function createResilientCollectionStorage(
  getPrimaryStorage: () => KeyValueStorage | null
): ResilientCollectionStorage {
  const fallbackValues = new Map<string, string>();
  const fallbackIsAuthoritative = new Set<string>();

  const getPrimary = (): KeyValueStorage | null => {
    try {
      return getPrimaryStorage();
    } catch {
      return null;
    }
  };

  return {
    getItem(key) {
      if (fallbackIsAuthoritative.has(key)) {
        const fallbackValue = fallbackValues.get(key) ?? null;
        const primary = getPrimary();

        if (primary && fallbackValue !== null) {
          try {
            primary.setItem(key, fallbackValue);
            fallbackIsAuthoritative.delete(key);
          } catch {
            // Keep the current-session value authoritative until persistence recovers.
          }
        }

        return fallbackValue;
      }

      const primary = getPrimary();
      if (primary) {
        try {
          const value = primary.getItem(key);
          if (value === null) {
            fallbackValues.delete(key);
          } else {
            fallbackValues.set(key, value);
          }
          return value;
        } catch {
          // Fall through to the last successfully observed value.
        }
      }

      return fallbackValues.get(key) ?? null;
    },

    setItem(key, value) {
      const primary = getPrimary();
      if (primary) {
        try {
          primary.setItem(key, value);
          fallbackValues.set(key, value);
          fallbackIsAuthoritative.delete(key);
          return true;
        } catch {
          // Preserve the write in memory for this session.
        }
      }

      fallbackValues.set(key, value);
      fallbackIsAuthoritative.add(key);
      return false;
    },
  };
}

const collectionStorage = createResilientCollectionStorage(() => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
});

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
    const parsed = JSON.parse(collectionStorage.getItem(storageKey) ?? '[]');
    return sanitizeCollectionKeys(parsed, maxItems);
  } catch {
    return [];
  }
}

function persistStoredKeys(storageKey: string, values: readonly string[]): void {
  if (typeof window === 'undefined') return;
  collectionStorage.setItem(storageKey, JSON.stringify(values));
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
