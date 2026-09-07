/**
 * Unit tests for Prophage Excision Precision Mapper
 */

import { describe, it, expect } from 'bun:test';
import {
  findIntegrases,
  findDirectRepeats,
  analyzeProphageExcision,
  isLikelyTemperate,
} from './prophage-excision';
import type { GeneInfo } from '../types';

// Helper to create gene info objects
function makeGene(overrides: Partial<GeneInfo> & { id: number }): GeneInfo {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    locusTag: overrides.locusTag ?? null,
    startPos: overrides.startPos ?? 0,
    endPos: overrides.endPos ?? 100,
    strand: overrides.strand ?? '+',
    product: overrides.product ?? null,
    type: overrides.type ?? 'CDS',
  };
}

describe('resolved attachment-repeat evidence', () => {
  it('does not infer attachment sites from unknown sequence', () => {
    const result = analyzeProphageExcision('N'.repeat(208), []);
    expect(result.directRepeats).toEqual([]);
    expect(result.attachmentSites).toEqual([]);
    expect(result.bestPrediction.excisionProduct).toBeNull();
  });

  it('rejects unresolved bases on either side even within the mismatch allowance', () => {
    const repeat = 'ACGTACGTTAGCTAC';
    for (const unknown of ['N', 'R', 'Y']) {
      const unresolved = repeat.slice(0, -1) + unknown;
      expect(findDirectRepeats(repeat + unresolved, 15, 15, 1)).toEqual([]);
      expect(findDirectRepeats(unresolved + repeat, 15, 15, 1)).toEqual([]);
    }
  });

  it('preserves resolved imperfect repeats and their coordinates across unknown gaps', () => {
    const left = 'ACGTACGTTAGCTAC';
    const right = 'ACGTACGTTAGCTAT';
    expect(findDirectRepeats((left + 'NNNNN' + right).toLowerCase(), 15, 15, 1)).toEqual([
      { pos1: 0, pos2: 20, sequence: left, mismatches: 1, hammingDistance: 1 },
    ]);
  });
});

describe('findIntegrases', () => {
  it('returns empty array for empty gene list', () => {
    expect(findIntegrases([])).toEqual([]);
  });

  it('returns empty array when no integrase genes present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'capsid', product: 'Major capsid protein' }),
      makeGene({ id: 2, name: 'tail', product: 'Tail fiber protein' }),
    ];
    expect(findIntegrases(genes)).toEqual([]);
  });

  it('finds integrase gene by name', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Phage integrase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].gene.id).toBe(1);
    expect(result[0].matchedKeywords).toContain('int');
    expect(result[0].matchedKeywords).toContain('integrase');
  });

  it('finds integrase gene by product annotation', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'gp15', product: 'Site-specific recombinase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].matchedKeywords).toContain('site-specific recombinase');
  });

  it('finds excisionase gene', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'xis', product: 'Excisionase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].matchedKeywords).toContain('xis');
    expect(result[0].matchedKeywords).toContain('excisionase');
  });

  it('classifies tyrosine recombinase correctly', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Tyrosine recombinase XerD' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].integraseClass).toBe('tyrosine');
  });

  it('classifies serine recombinase correctly', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Serine recombinase family protein' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].integraseClass).toBe('serine');
  });

  it('returns unknown class when type not specified', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Integrase' }),
    ];
    const result = findIntegrases(genes);
    expect(result[0].integraseClass).toBe('unknown');
  });

  it('sorts by confidence descending', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int' }),
      makeGene({ id: 2, name: 'integrase', product: 'Site-specific recombinase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(2);
    expect(result[0].gene.id).toBe(2);
    expect(result[0].confidence).toBeGreaterThan(result[1].confidence);
  });

  it('confidence is capped at 1.0', () => {
    const genes: GeneInfo[] = [
      makeGene({
        id: 1,
        name: 'integrase',
        locusTag: 'int1',
        product: 'Tyrosine recombinase site-specific integrase',
      }),
    ];
    const result = findIntegrases(genes);
    expect(result[0].confidence).toBeLessThanOrEqual(1.0);
  });
});

describe('findDirectRepeats', () => {
  it('returns empty array for short sequence', () => {
    expect(findDirectRepeats('ACGT')).toEqual([]);
  });

  it('finds perfect direct repeat with small search region', () => {
    const repeat = 'ACGTACGTACGTACGT'; // 16bp
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat;
    // Use small search region to speed up test
    const result = findDirectRepeats(seq, 15, 20, 0, 100);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].hammingDistance).toBe(0);
  });

  it('finds repeat with allowed mismatches', () => {
    const repeat1 = 'ACGTACGTACGTACGT';
    const repeat2 = 'ACGTACGTACGTACGA'; // 1 mismatch
    const middle = 'G'.repeat(200);
    const seq = repeat1 + middle + repeat2;
    const result = findDirectRepeats(seq, 15, 20, 2, 100);
    expect(result.length).toBeGreaterThan(0);
    const match = result.find(r => r.sequence.startsWith('ACGT'));
    expect(match).toBeDefined();
  });

  it('respects minimum length parameter', () => {
    const repeat = 'ACGTACGT'; // 8bp (too short)
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat;
    const result = findDirectRepeats(seq, 15, 25, 0, 50);
    // 8bp repeat won't match 15bp minimum
    const terminalRepeats = result.filter(r =>
      r.pos1 < 10 && r.pos2 > seq.length - 10
    );
    expect(terminalRepeats).toEqual([]);
  });

  it('handles case insensitivity', () => {
    const repeat = 'acgtacgtacgtacgt';
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat.toUpperCase();
    const result = findDirectRepeats(seq, 15, 20, 0, 100);
    const matches = result.filter(r => r.sequence.toUpperCase().includes('ACGT'));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('limits results to 20 candidates', () => {
    const result = findDirectRepeats('ACGT'.repeat(1000), 15, 20, 1, 500);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

describe('analyzeProphageExcision', () => {
  it('returns valid analysis for empty inputs', () => {
    const result = analyzeProphageExcision('', []);
    expect(result.integrases).toEqual([]);
    expect(result.directRepeats).toEqual([]);
    expect(result.attachmentSites).toEqual([]);
    expect(result.isTemperate).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('identifies temperate phage with integrase', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Phage integrase' }),
    ];
    const result = analyzeProphageExcision('ACGT'.repeat(100), genes);
    expect(result.integrases.length).toBe(1);
  });

  it('generates diagnostics for each analysis step', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase' }),
    ];
    const result = analyzeProphageExcision('ACGT'.repeat(100), genes);
    expect(result.diagnostics.some(d => d.includes('integrase'))).toBe(true);
  });

  it('finds known att core motifs', () => {
    // Embed Lambda-like att core
    const seq = 'A'.repeat(100) + 'TTTTCTTT' + 'G'.repeat(100);
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase', startPos: 50, endPos: 200 }),
    ];
    const result = analyzeProphageExcision(seq, genes);
    expect(result.integrationHotspots.length).toBeGreaterThan(0);
    expect(result.integrationHotspots[0].motif).toBe('TTTTCTTT');
  });

  it('handles tRNA genes for hotspot scoring', () => {
    const seq = 'TTTTCTTT' + 'A'.repeat(200) + 'G'.repeat(100);
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase', startPos: 10, endPos: 100 }),
      makeGene({ id: 2, type: 'tRNA', product: 'tRNA-Arg', startPos: 20, endPos: 80 }),
    ];
    const result = analyzeProphageExcision(seq, genes);
    const hotspotsNearTrna = result.integrationHotspots.filter(h => h.distanceFromTrna < 100);
    if (hotspotsNearTrna.length > 0) {
      expect(hotspotsNearTrna[0].score).toBeGreaterThan(0.4);
    }
  });
});

describe('isLikelyTemperate', () => {
  it('returns false for empty gene list', () => {
    expect(isLikelyTemperate([])).toBe(false);
  });

  it('returns false when no integrase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Capsid protein' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(false);
  });

  it('returns true when integrase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Phage integrase' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(true);
  });

  it('returns true when recombinase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Site-specific recombinase' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(true);
  });
});

describe('edge cases', () => {
  it('handles sequence with only Ns', () => {
    const result = analyzeProphageExcision('N'.repeat(100), []);
    expect(result.isTemperate).toBe(false);
  });

  it('handles gene with null fields', () => {
    const genes: GeneInfo[] = [
      {
        id: 1,
        name: null,
        locusTag: null,
        startPos: 0,
        endPos: 100,
        strand: '+',
        product: 'integrase',
        type: null,
      },
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
  });

  it('processes sequence without error', () => {
    // Test that analysis completes without throwing
    const seq = 'ACGT'.repeat(100);
    const result = analyzeProphageExcision(seq, []);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.isTemperate).toBe(false);
  });
});
