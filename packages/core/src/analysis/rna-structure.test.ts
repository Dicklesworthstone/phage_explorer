/**
 * Unit tests for RNA Structure & Packaging Signal Explorer
 *
 * Note: These tests use minimal sequences to avoid memory issues with
 * the computationally intensive folding algorithms.
 */

import { describe, it, expect } from 'bun:test';
import {
  analyzeRNAWindows,
  computeSynonymousStress,
  findHighStressRegions,
  detectRegulatoryElements,
  analyzeRNAStructure,
  type CodonStress,
} from './rna-structure';

describe('analyzeRNAWindows', () => {
  it('returns empty array for sequence shorter than window', () => {
    const result = analyzeRNAWindows('ACGT', 120, 30);
    expect(result).toEqual([]);
  });

  it('creates windows with correct positions', () => {
    const seq = 'ACGT'.repeat(20); // 80bp
    const result = analyzeRNAWindows(seq, 40, 20);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(40);
    expect(result[0].sequence.length).toBe(40);
  });

  it('calculates GC content correctly', () => {
    const gcSeq = 'GCGCGCGC'.repeat(8); // 64bp
    const result = analyzeRNAWindows(gcSeq, 40, 20);
    expect(result[0].gcContent).toBe(1);
  });

  it('calculates GC content for AT-only sequence', () => {
    const atSeq = 'ATATAT'.repeat(12); // 72bp
    const result = analyzeRNAWindows(atSeq, 40, 20);
    expect(result[0].gcContent).toBe(0);
  });

  it('returns mfe and pairingDensity for each window', () => {
    const seq = 'ACGT'.repeat(15); // 60bp
    const result = analyzeRNAWindows(seq, 40, 20);

    expect(result[0]).toHaveProperty('mfe');
    expect(result[0]).toHaveProperty('pairingDensity');
    expect(typeof result[0].mfe).toBe('number');
    expect(result[0].pairingDensity).toBeGreaterThanOrEqual(0);
    expect(result[0].pairingDensity).toBeLessThanOrEqual(1);
  });
});

describe('computeSynonymousStress', () => {
  it('returns empty array for empty sequence', () => {
    const result = computeSynonymousStress('');
    expect(result).toEqual([]);
  });

  it('returns empty array for sequence shorter than one codon', () => {
    const result = computeSynonymousStress('AC');
    expect(result).toEqual([]);
  });

  it('processes valid coding sequence', () => {
    const seq = 'ATGGCTAGC'; // Met-Ala-Ser
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
    expect(result[0].position).toBe(0);
    expect(result[0].codon).toBe('ATG');
    expect(result[0].aminoAcid).toBe('M');
  });

  it('skips stop codons', () => {
    const seq = 'ATGTAATGA'; // Met-Stop-Stop
    const result = computeSynonymousStress(seq);
    expect(result.length).toBe(1);
    expect(result[0].aminoAcid).toBe('M');
  });

  it('calculates synonymous variants', () => {
    const seq = 'TTA'; // Leucine (has 6 synonymous codons)
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(1);
    expect(result[0].variants.length).toBeGreaterThan(0);
    for (const variant of result[0].variants) {
      expect(variant.aminoAcid).toBe('L');
    }
  });

  it('respects frame parameter', () => {
    const seq = 'AATGGCTAGC'; // A + Met-Ala-Ser (offset by 1)
    const result = computeSynonymousStress(seq, 1);

    expect(result[0].codon).toBe('ATG');
    expect(result[0].aminoAcid).toBe('M');
  });
});

describe('findHighStressRegions', () => {
  it('returns empty array for empty input', () => {
    const result = findHighStressRegions([]);
    expect(result).toEqual([]);
  });

  it('returns empty array when no high stress codons', () => {
    const stressData: CodonStress[] = [
      { position: 0, codon: 'ATG', aminoAcid: 'M', wildTypeDeltaG: 0, variants: [], stress: 0.1, stressPercentile: 0.2, isConstrained: false },
      { position: 1, codon: 'GCT', aminoAcid: 'A', wildTypeDeltaG: 0, variants: [], stress: 0.2, stressPercentile: 0.3, isConstrained: false },
    ];
    const result = findHighStressRegions(stressData);
    expect(result).toEqual([]);
  });

  it('finds contiguous high-stress region', () => {
    const stressData: CodonStress[] = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      codon: 'GCT',
      aminoAcid: 'A',
      wildTypeDeltaG: 0,
      variants: [],
      stress: i < 5 ? 0.2 : 0.8,
      stressPercentile: i < 5 ? 0.3 : 0.9,
      isConstrained: i >= 5,
    }));

    const result = findHighStressRegions(stressData);
    expect(result.length).toBe(1);
    expect(result[0].start).toBe(15); // Position 5 * 3
  });

  it('respects minLength parameter', () => {
    const stressData: CodonStress[] = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      codon: 'GCT',
      aminoAcid: 'A',
      wildTypeDeltaG: 0,
      variants: [],
      stress: i >= 2 && i <= 4 ? 0.8 : 0.2,
      stressPercentile: i >= 2 && i <= 4 ? 0.9 : 0.3,
      isConstrained: i >= 2 && i <= 4,
    }));

    const result = findHighStressRegions(stressData, 5); // Require at least 5
    expect(result).toEqual([]);
  });
});

describe('detectRegulatoryElements', () => {
  it('returns empty array for empty sequence', () => {
    const result = detectRegulatoryElements('', []);
    expect(result).toEqual([]);
  });

  it('detects slippery sites', () => {
    // Include UUUAAAC slippery site (TTTAAAC in DNA)
    const seq = 'ACGTTTTTAAACGCGT';
    const result = detectRegulatoryElements(seq, []);

    const slipperySites = result.filter(h => h.type === 'slippery-site');
    expect(slipperySites.length).toBeGreaterThan(0);
    expect(slipperySites[0].sequence).toBe('UUUAAAC');
  });

  it('detects riboswitch motifs', () => {
    // Include GGCGU riboswitch fragment
    const seq = 'ACGTGGCGUACGTACGT';
    const result = detectRegulatoryElements(seq, []);

    const riboswitches = result.filter(h => h.type === 'riboswitch');
    expect(riboswitches.length).toBeGreaterThan(0);
  });

  it('sorts results by confidence descending', () => {
    const seq = 'TTTAAAC' + 'GGCGU'; // Multiple hits
    const result = detectRegulatoryElements(seq, []);

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence);
    }
  });
});

describe('analyzeRNAStructure', () => {
  it('handles empty sequence', () => {
    const result = analyzeRNAStructure('');

    expect(result.windows).toEqual([]);
    expect(result.codonStress).toEqual([]);
    expect(result.highStressRegions).toEqual([]);
    expect(result.globalMFE).toBe(0);
  });

  it('returns complete analysis structure for small sequence', () => {
    const seq = 'ATGGCTAGC'; // 9bp - 3 codons
    const result = analyzeRNAStructure(seq, { windowSize: 9, stepSize: 3 });

    expect(result).toHaveProperty('windows');
    expect(result).toHaveProperty('codonStress');
    expect(result).toHaveProperty('highStressRegions');
    expect(result).toHaveProperty('regulatoryHypotheses');
    expect(result).toHaveProperty('globalMFE');
    expect(result).toHaveProperty('avgSynonymousStress');
  });
});

describe('edge cases', () => {
  it('handles lowercase input', () => {
    const seq = 'atggctagc'; // lowercase
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
    expect(result[0].aminoAcid).toBe('M');
  });

  it('handles mixed case input', () => {
    const seq = 'AtGgCtAgC';
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
  });

  it('handles sequence with only Ns', () => {
    const seq = 'NNNNNNNNN'; // 3 codons of Ns
    const result = computeSynonymousStress(seq);
    // Should handle gracefully (no valid amino acids)
    expect(Array.isArray(result)).toBe(true);
  });
});
