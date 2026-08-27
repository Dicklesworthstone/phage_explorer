import { describe, expect, it } from 'bun:test';
import type { PhageSummary } from '@phage-explorer/core';
import {
  buildShareUrl,
  findPhageIndex,
  isShareableOverlayId,
  normalizeShareableOverlayId,
  parseShareState,
} from './share-state';

const phages: PhageSummary[] = [
  {
    id: 1,
    slug: 'lambda-phage',
    name: 'Enterobacteria phage lambda',
    accession: 'NC_001416',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48_502,
    gcContent: 49.86,
    morphology: 'Siphovirus',
    lifecycle: 'Temperate',
  },
  {
    id: 2,
    slug: 't4',
    name: 'Escherichia phage T4',
    accession: 'NC_000866',
    family: 'Straboviridae',
    host: 'Escherichia coli',
    genomeLength: 168_903,
    gcContent: 35.32,
    morphology: 'Myovirus',
    lifecycle: 'Lytic',
  },
];

describe('parseShareState', () => {
  it('parses a complete validated share state', () => {
    expect(
      parseShareState(
        'https://phage-explorer.org/?phage=t4&view=aa&pos=12345&frame=-2&model=0&tool=gcSkew'
      )
    ).toEqual({
      phageKey: 't4',
      viewMode: 'aa',
      position: 12_345,
      readingFrame: -2,
      show3DModel: false,
      tool: 'gcSkew',
    });
  });

  it('rejects malformed or unsupported values without throwing', () => {
    expect(
      parseShareState('/?phage=%20&view=protein&pos=-1&frame=7&model=maybe&tool=settings')
    ).toEqual({
      phageKey: null,
      viewMode: null,
      position: null,
      readingFrame: null,
      show3DModel: null,
      tool: null,
    });
  });

  it('normalizes boolean and overlay spellings', () => {
    const parsed = parseShareState('/?model=TRUE&tool=GENOMICSIGNATUREPCA');
    expect(parsed.show3DModel).toBe(true);
    expect(parsed.tool).toBe('genomicSignaturePCA');
  });
});

describe('buildShareUrl', () => {
  it('builds a deterministic clean URL and removes tracking fragments', () => {
    const url = buildShareUrl('https://phage-explorer.org/?utm_source=test#old', {
      phageKey: 'lambda-phage',
      viewMode: 'dual',
      position: 900.9,
      readingFrame: 1,
      show3DModel: true,
      tool: 'tropism',
    });

    expect(url).toBe(
      'https://phage-explorer.org/?phage=lambda-phage&view=dual&pos=900&frame=1&model=1&tool=tropism'
    );
  });

  it('omits an absent analysis tool', () => {
    const url = new URL(
      buildShareUrl('https://preview.example/app?stale=1', {
        phageKey: 'NC_000866',
        viewMode: 'dna',
        position: 0,
        readingFrame: 0,
        show3DModel: false,
      })
    );

    expect(url.pathname).toBe('/app');
    expect(url.searchParams.get('phage')).toBe('NC_000866');
    expect(url.searchParams.get('tool')).toBeNull();
    expect(url.searchParams.get('stale')).toBeNull();
  });
});

describe('findPhageIndex', () => {
  it('matches stable slugs, accessions, IDs, and exact names case-insensitively', () => {
    expect(findPhageIndex(phages, 'T4')).toBe(1);
    expect(findPhageIndex(phages, 'nc_001416')).toBe(0);
    expect(findPhageIndex(phages, '2')).toBe(1);
    expect(findPhageIndex(phages, 'enterobacteria phage lambda')).toBe(0);
  });

  it('returns -1 for empty and unknown keys', () => {
    expect(findPhageIndex(phages, null)).toBe(-1);
    expect(findPhageIndex(phages, 'unknown-phage')).toBe(-1);
  });
});

describe('shareable overlays', () => {
  it('accepts analysis views and rejects transient application chrome', () => {
    expect(isShareableOverlayId('gcSkew')).toBe(true);
    expect(normalizeShareableOverlayId('RNASECONDARY')).toBeNull();
    expect(normalizeShareableOverlayId('RNASTRUCTURE')).toBe('rnaStructure');
    expect(isShareableOverlayId('settings')).toBe(false);
    expect(isShareableOverlayId('welcome')).toBe(false);
  });
});
