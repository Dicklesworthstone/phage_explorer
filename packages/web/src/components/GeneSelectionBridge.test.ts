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
  {
    id: 3,
    name: 'unstranded gene',
    locusTag: 'gp3',
    startPos: 400,
    endPos: 500,
    strand: null,
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

  it('keeps unknown strands distinct instead of treating them as forward', () => {
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 450,
        y: 52,
      })?.id
    ).toBe(3);
    expect(
      findGeneAtMapPoint(genes, 1_000, {
        ...geometry,
        x: 450,
        y: 16,
      })
    ).toBeNull();
  });

  it('keeps narrow genes touchable with a 44px horizontal hit target', () => {
    const narrowGene: GeneInfo = {
      ...genes[0],
      id: 4,
      startPos: 500,
      endPos: 501,
    };

    expect(
      findGeneAtMapPoint([narrowGene], 1_000, {
        ...geometry,
        x: 520,
        y: 16,
      })?.id
    ).toBe(4);
  });

  it('supports defensively reversed coordinates', () => {
    const reversedCoordinates: GeneInfo = {
      ...genes[0],
      id: 5,
      startPos: 600,
      endPos: 550,
    };

    expect(
      findGeneAtMapPoint([reversedCoordinates], 1_000, {
        ...geometry,
        x: 575,
        y: 16,
      })?.id
    ).toBe(5);
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
