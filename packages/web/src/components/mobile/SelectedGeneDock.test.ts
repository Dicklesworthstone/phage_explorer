import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import {
  getAdjacentGene,
  getGeneDisplayLabel,
  getGeneFocusPosition,
  sortGenesForNavigation,
} from './SelectedGeneDock';

const genes: GeneInfo[] = [
  {
    id: 3,
    name: 'late gene',
    locusTag: 'gp3',
    startPos: 900,
    endPos: 1_200,
    strand: '+',
    product: 'tail protein',
    type: 'CDS',
  },
  {
    id: 1,
    name: 'early gene',
    locusTag: 'gp1',
    startPos: 100,
    endPos: 500,
    strand: '+',
    product: 'capsid protein',
    type: 'CDS',
  },
  {
    id: 2,
    name: 'middle gene',
    locusTag: null,
    startPos: 500,
    endPos: 850,
    strand: '-',
    product: 'portal protein',
    type: 'CDS',
  },
];

describe('sortGenesForNavigation', () => {
  it('orders genes by genome position without mutating the caller', () => {
    const originalIds = genes.map((gene) => gene.id);
    expect(sortGenesForNavigation(genes).map((gene) => gene.id)).toEqual([1, 2, 3]);
    expect(genes.map((gene) => gene.id)).toEqual(originalIds);
  });

  it('uses ordered bounds and ID as deterministic tie breakers', () => {
    const tied: GeneInfo[] = [
      { ...genes[0], id: 8, startPos: 300, endPos: 100 },
      { ...genes[0], id: 7, startPos: 100, endPos: 200 },
      { ...genes[0], id: 6, startPos: 200, endPos: 100 },
    ];
    expect(sortGenesForNavigation(tied).map((gene) => gene.id)).toEqual([6, 7, 8]);
  });
});

describe('getAdjacentGene', () => {
  it('returns previous and next genes in genomic order', () => {
    expect(getAdjacentGene(genes, 2, 'previous')?.id).toBe(1);
    expect(getAdjacentGene(genes, 2, 'next')?.id).toBe(3);
  });

  it('returns null at boundaries and for an unknown selection', () => {
    expect(getAdjacentGene(genes, 1, 'previous')).toBeNull();
    expect(getAdjacentGene(genes, 3, 'next')).toBeNull();
    expect(getAdjacentGene(genes, 99, 'next')).toBeNull();
  });
});

describe('getGeneFocusPosition', () => {
  it('uses nucleotide coordinates for DNA and dual views', () => {
    expect(getGeneFocusPosition(genes[0], 'dna')).toBe(900);
    expect(getGeneFocusPosition(genes[0], 'dual')).toBe(900);
  });

  it('converts nucleotide coordinates to amino-acid coordinates', () => {
    expect(getGeneFocusPosition({ ...genes[0], startPos: 901 }, 'aa')).toBe(300);
  });

  it('focuses the lower genomic coordinate when endpoints are reversed', () => {
    expect(getGeneFocusPosition({ ...genes[0], startPos: 1_200, endPos: 900 }, 'dna')).toBe(900);
    expect(getGeneFocusPosition({ ...genes[0], startPos: 1_200, endPos: 901 }, 'aa')).toBe(300);
  });

  it('never returns a negative focus position', () => {
    expect(getGeneFocusPosition({ ...genes[0], startPos: -10 }, 'dna')).toBe(0);
  });
});

describe('getGeneDisplayLabel', () => {
  it('prefers locus tag, then gene name, then product, then ID', () => {
    expect(getGeneDisplayLabel(genes[0])).toBe('gp3');
    expect(getGeneDisplayLabel({ ...genes[0], locusTag: null })).toBe('late gene');
    expect(getGeneDisplayLabel({ ...genes[0], locusTag: null, name: null })).toBe('tail protein');
    expect(
      getGeneDisplayLabel({ ...genes[0], locusTag: null, name: null, product: null, id: 42 })
    ).toBe('Gene 42');
  });
});
