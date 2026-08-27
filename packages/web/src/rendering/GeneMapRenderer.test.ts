import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import {
  buildGeneDensityBins,
  findGeneAtGenomePosition,
  getGenomePositionAtCanvasX,
  getOrderedGeneBounds,
} from './GeneMapRenderer';

const forwardGene: GeneInfo = {
  id: 1,
  name: 'forward',
  locusTag: 'gp1',
  startPos: 100,
  endPos: 200,
  strand: '+',
  product: null,
  type: 'CDS',
};

const reversedCoordinates: GeneInfo = {
  ...forwardGene,
  id: 2,
  startPos: 500,
  endPos: 300,
  strand: null,
};

describe('getOrderedGeneBounds', () => {
  it('normalizes defensively reversed coordinates', () => {
    expect(getOrderedGeneBounds(reversedCoordinates)).toEqual({ start: 300, end: 500 });
  });
});

describe('getGenomePositionAtCanvasX', () => {
  it('maps canvas coordinates into a clamped half-open genome', () => {
    expect(getGenomePositionAtCanvasX(0, 100, 1_000)).toBe(0);
    expect(getGenomePositionAtCanvasX(50, 100, 1_000)).toBe(500);
    expect(getGenomePositionAtCanvasX(100, 100, 1_000)).toBe(999);
  });

  it('rejects positions outside the canvas and invalid dimensions', () => {
    expect(getGenomePositionAtCanvasX(-1, 100, 1_000)).toBeNull();
    expect(getGenomePositionAtCanvasX(101, 100, 1_000)).toBeNull();
    expect(getGenomePositionAtCanvasX(10, 0, 1_000)).toBeNull();
    expect(getGenomePositionAtCanvasX(10, 100, 0)).toBeNull();
  });
});

describe('findGeneAtGenomePosition', () => {
  it('uses ordered half-open coordinates', () => {
    expect(findGeneAtGenomePosition([forwardGene], 100)?.id).toBe(1);
    expect(findGeneAtGenomePosition([forwardGene], 199)?.id).toBe(1);
    expect(findGeneAtGenomePosition([forwardGene], 200)).toBeNull();
    expect(findGeneAtGenomePosition([reversedCoordinates], 300)?.id).toBe(2);
    expect(findGeneAtGenomePosition([reversedCoordinates], 499)?.id).toBe(2);
  });

  it('rejects invalid positions', () => {
    expect(findGeneAtGenomePosition([forwardGene], -1)).toBeNull();
    expect(findGeneAtGenomePosition([forwardGene], Number.NaN)).toBeNull();
  });
});

describe('buildGeneDensityBins', () => {
  it('counts genes across every covered bin regardless of coordinate order', () => {
    expect(buildGeneDensityBins([forwardGene, reversedCoordinates], 1_000, 10)).toEqual([
      0, 1, 0, 1, 1, 0, 0, 0, 0, 0,
    ]);
  });

  it('clips out-of-range genes and ignores empty intervals', () => {
    const genes: GeneInfo[] = [
      { ...forwardGene, startPos: -50, endPos: 50 },
      { ...forwardGene, id: 3, startPos: 950, endPos: 1_200 },
      { ...forwardGene, id: 4, startPos: 300, endPos: 300 },
    ];
    expect(buildGeneDensityBins(genes, 1_000, 10)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it('uses at least one bin and rejects invalid genomes', () => {
    expect(buildGeneDensityBins([forwardGene], 1_000, 0)).toEqual([1]);
    expect(buildGeneDensityBins([forwardGene], 0, 10)).toEqual([]);
  });
});
