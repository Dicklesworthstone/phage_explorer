import { describe, expect, it } from 'bun:test';
import {
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
