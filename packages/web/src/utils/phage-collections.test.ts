import { describe, expect, it } from 'bun:test';
import {
  createResilientCollectionStorage,
  getPhageCollectionKey,
  sanitizeCollectionKeys,
} from './phage-collections';

describe('getPhageCollectionKey', () => {
  it('uses a stable normalized slug when one exists', () => {
    expect(
      getPhageCollectionKey({
        id: 12,
        slug: '  PhiX174  ',
        accession: 'NC_001422.1',
      })
    ).toBe('slug:phix174');
  });

  it('falls back to accession and then numeric ID', () => {
    expect(
      getPhageCollectionKey({
        id: 12,
        slug: null,
        accession: ' NC_001422.1 ',
      })
    ).toBe('accession:nc_001422.1');

    expect(getPhageCollectionKey({ id: 12, slug: null, accession: null })).toBe('id:12');
  });
});

describe('sanitizeCollectionKeys', () => {
  it('normalizes, deduplicates, and removes malformed entries', () => {
    expect(
      sanitizeCollectionKeys(
        [' Slug:T4 ', 'slug:t4', '', null, 42, 'accession:NC_000866.4'],
        10
      )
    ).toEqual(['slug:t4', 'accession:nc_000866.4']);
  });

  it('preserves order while enforcing the collection limit', () => {
    expect(sanitizeCollectionKeys(['id:3', 'id:2', 'id:1'], 2)).toEqual(['id:3', 'id:2']);
  });

  it('rejects implausibly long keys and non-positive limits', () => {
    expect(sanitizeCollectionKeys(['x'.repeat(181), 'id:1'], 10)).toEqual(['id:1']);
    expect(sanitizeCollectionKeys(['id:1'], 0)).toEqual([]);
  });
});

describe('createResilientCollectionStorage', () => {
  it('keeps failed writes available for the current session', () => {
    const primary = {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage blocked');
      },
    };
    const storage = createResilientCollectionStorage(() => primary);

    expect(storage.setItem('favorites', '["slug:t4"]')).toBe(false);
    expect(storage.getItem('favorites')).toBe('["slug:t4"]');
  });

  it('flushes the session fallback when persistent storage recovers', () => {
    const values = new Map<string, string>();
    let failWrites = true;
    const primary = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error('quota exceeded');
        values.set(key, value);
      },
    };
    const storage = createResilientCollectionStorage(() => primary);

    expect(storage.setItem('recent', '["slug:lambda"]')).toBe(false);
    failWrites = false;
    expect(storage.getItem('recent')).toBe('["slug:lambda"]');
    expect(values.get('recent')).toBe('["slug:lambda"]');
  });

  it('uses the last observed value if the primary storage later becomes unreadable', () => {
    const values = new Map([['favorites', '["slug:mu"]']]);
    let failReads = false;
    const primary = {
      getItem: (key: string) => {
        if (failReads) throw new Error('storage unavailable');
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const storage = createResilientCollectionStorage(() => primary);

    expect(storage.getItem('favorites')).toBe('["slug:mu"]');
    failReads = true;
    expect(storage.getItem('favorites')).toBe('["slug:mu"]');
  });
});
