import { describe, expect, it } from 'bun:test';
import {
  classifyLifecycle,
  getPhageStorageKey,
  sortPhageList,
  type PhageListItem,
} from './PhagePickerSheet';

const phages: PhageListItem[] = [
  {
    id: 1,
    slug: 'gamma-phage',
    name: 'Gamma phage',
    accession: 'NC_GAMMA',
    genomeLength: 90_000,
    gcContent: 52.5,
  },
  {
    id: 2,
    slug: 'alpha-phage',
    name: 'Alpha phage',
    accession: 'NC_ALPHA',
    genomeLength: 120_000,
    gcContent: 38.4,
  },
  {
    id: 3,
    slug: 'beta-phage',
    name: 'Beta phage',
    accession: 'NC_BETA',
    genomeLength: null,
    gcContent: 65.1,
  },
];

describe('classifyLifecycle', () => {
  it('recognizes common lytic labels', () => {
    expect(classifyLifecycle('Lytic')).toBe('lytic');
    expect(classifyLifecycle('Virulent')).toBe('lytic');
    expect(classifyLifecycle('Obligately lytic')).toBe('lytic');
  });

  it('recognizes common temperate labels', () => {
    expect(classifyLifecycle('Temperate')).toBe('temperate');
    expect(classifyLifecycle('Lysogenic')).toBe('temperate');
    expect(classifyLifecycle('Prophage-forming')).toBe('temperate');
  });

  it('normalizes whitespace and casing', () => {
    expect(classifyLifecycle('  TEMPERATE  ')).toBe('temperate');
    expect(classifyLifecycle('  virulent phage ')).toBe('lytic');
  });

  it('keeps missing and unfamiliar labels in other', () => {
    expect(classifyLifecycle(null)).toBe('other');
    expect(classifyLifecycle(undefined)).toBe('other');
    expect(classifyLifecycle('Chronic')).toBe('other');
  });
});

describe('getPhageStorageKey', () => {
  it('prefers a normalized stable slug', () => {
    expect(getPhageStorageKey({ ...phages[0], slug: '  Gamma-Phage  ' })).toBe('slug:gamma-phage');
  });

  it('falls back to accession and then numeric ID', () => {
    expect(getPhageStorageKey({ ...phages[0], slug: null, accession: ' NC_001416 ' })).toBe(
      'accession:nc_001416'
    );
    expect(getPhageStorageKey({ ...phages[0], slug: null, accession: null, id: 42 })).toBe('id:42');
  });
});

describe('sortPhageList', () => {
  it('preserves fuzzy-search relevance order by default', () => {
    expect(sortPhageList(phages, 'relevance').map((phage) => phage.name)).toEqual([
      'Gamma phage',
      'Alpha phage',
      'Beta phage',
    ]);
  });

  it('orders recent results by persisted recency when supplied', () => {
    expect(
      sortPhageList(phages, 'relevance', ['slug:beta-phage', 'slug:gamma-phage']).map(
        (phage) => phage.name
      )
    ).toEqual(['Beta phage', 'Gamma phage', 'Alpha phage']);
  });

  it('sorts names case-insensitively from A to Z', () => {
    expect(sortPhageList(phages, 'name').map((phage) => phage.name)).toEqual([
      'Alpha phage',
      'Beta phage',
      'Gamma phage',
    ]);
  });

  it('sorts largest genomes first and keeps missing values last', () => {
    expect(sortPhageList(phages, 'genomeLength').map((phage) => phage.name)).toEqual([
      'Alpha phage',
      'Gamma phage',
      'Beta phage',
    ]);
  });

  it('sorts highest GC content first', () => {
    expect(sortPhageList(phages, 'gcContent').map((phage) => phage.name)).toEqual([
      'Beta phage',
      'Gamma phage',
      'Alpha phage',
    ]);
  });

  it('never mutates the caller-owned result list', () => {
    const originalOrder = phages.map((phage) => phage.id);
    sortPhageList(phages, 'name');
    expect(phages.map((phage) => phage.id)).toEqual(originalOrder);
  });
});
