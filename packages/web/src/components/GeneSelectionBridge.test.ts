import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { findGeneAtMapPoint } from './GeneSelectionBridge';

const genes: GeneInfo[] = [
  {
    id: 1,
    name: 'forward gene',
    locusTag: 'gp1',
    startPos: 100,
    endPos: 200,
    strand: '+',
    product: null,
    type: 'CDS',
  },
  {
    id: 2,
    name: 'reverse gene',
    locusTag: 'gp2',
    startPos: 700,
    endPos: 800,
    strand: '-',
    product: null,
    type: 'CDS',
  },
];

const geometry = {
  width: 1_000,
  height: 60,
};

describe('findGeneAtMapPoint', () => {
  it('finds a forward-strand gene on the forward track', () => {
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 150,
        y: 16,
      })?.id
    ).toBe(1);
  });

  it('finds a reverse-strand gene only on the reverse track', () => {
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 750,
        y: 36,
      })?.id
    ).toBe(2);
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 750,
        y: 16,
      })
    ).toBeNull();
  });

  it('keeps narrow genes touchable with the same 44px hit target as the canvas', () => {
    const narrowGene: GeneInfo = {
      ...genes[0],
      id: 3,
      startPos: 500,
      endPos: 501,
    };

    expect(
      findGeneAtMapPoint([narrowGene], 1_000, {
        ...geometry,
        x: 520,
        y: 16,
      })?.id
    ).toBe(3);
  });

  it('returns null outside the gene tracks and canvas bounds', () => {
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 150,
        y: 27,
      })
    ).toBeNull();
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: -1,
        y: 16,
      })
    ).toBeNull();
  });

  it('returns null for invalid genome or canvas dimensions', () => {
    expect(
      findGeneAtMapPoint(genes, 0, {
        ...geometry,
        x: 150,
        y: 16,
      })
    ).toBeNull();
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        width: 0,
        height: 60,
        x: 0,
        y: 16,
      })
    ).toBeNull();
  });
});
