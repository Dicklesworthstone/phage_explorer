import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import {
  findNextGenePosition,
  findPreviousGenePosition,
  genePositionToScroll,
} from './gene-navigation';

// The App component is tightly coupled to Ink and the database, so we test
// the navigation helpers directly. These are the same functions used by the
// `[` / `]` key handlers.
describe('gene jump helpers', () => {
  const genes: GeneInfo[] = [
    { id: 1, name: 'A', startPos: 0, endPos: 100, strand: '+', type: 'CDS', product: null, locusTag: null },
    { id: 2, name: 'B', startPos: 250, endPos: 400, strand: '-', type: 'CDS', product: null, locusTag: null },
    { id: 3, name: 'C', startPos: 500, endPos: 700, strand: '+', type: 'CDS', product: null, locusTag: null },
  ];

  describe('findNextGenePosition', () => {
    it('jumps to the next gene start in DNA view', () => {
      expect(findNextGenePosition(genes, 0, 'dna')).toBe(250);
      expect(findNextGenePosition(genes, 250, 'dna')).toBe(500);
      expect(findNextGenePosition(genes, 500, 'dna')).toBeNull();
    });

    it('jumps to the next gene start in AA view (base-pair / 3)', () => {
      expect(findNextGenePosition(genes, 0, 'aa')).toBe(83); // floor(250 / 3)
      expect(findNextGenePosition(genes, 83, 'aa')).toBe(166); // floor(500 / 3)
    });

    it('returns null when there is no later gene', () => {
      expect(findNextGenePosition(genes, 600, 'dna')).toBeNull();
      expect(findNextGenePosition([], 0, 'dna')).toBeNull();
    });
  });

  describe('findPreviousGenePosition', () => {
    it('jumps to the previous gene start in DNA view', () => {
      expect(findPreviousGenePosition(genes, 600, 'dna')).toBe(500);
      expect(findPreviousGenePosition(genes, 500, 'dna')).toBe(250);
      expect(findPreviousGenePosition(genes, 0, 'dna')).toBeNull();
    });

    it('jumps to the previous gene start in AA view', () => {
      expect(findPreviousGenePosition(genes, 200, 'aa')).toBe(166); // floor(500 / 3)
      expect(findPreviousGenePosition(genes, 82, 'aa')).toBe(0);
    });

    it('returns null when there is no earlier gene', () => {
      expect(findPreviousGenePosition(genes, 0, 'dna')).toBeNull();
      expect(findPreviousGenePosition([], 0, 'dna')).toBeNull();
    });
  });

  describe('genePositionToScroll', () => {
    it('maps base-pair coordinates unchanged for DNA and dual views', () => {
      expect(genePositionToScroll(300, 'dna')).toBe(300);
      expect(genePositionToScroll(300, 'dual')).toBe(300);
    });

    it('maps base-pair coordinates to codon positions for AA view', () => {
      expect(genePositionToScroll(0, 'aa')).toBe(0);
      expect(genePositionToScroll(2, 'aa')).toBe(0);
      expect(genePositionToScroll(3, 'aa')).toBe(1);
      expect(genePositionToScroll(299, 'aa')).toBe(99);
    });
  });
});
