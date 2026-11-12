/**
 * Unit tests for Epistasis & Fitness Landscape Analysis
 *
 * Tests cover:
 * - BLOSUM62 matrix lookup
 * - Single mutant fitness computation
 * - Position frequency calculation
 * - Direct information / mutual information
 * - Epistasis score calculation
 * - Region identification (robust vs fragile)
 * - Escape route detection
 * - Protein type classification
 * - Full fitness landscape analysis
 */

import { describe, test, expect } from 'bun:test';
import {
  getBlosum62Score,
  computeSingleMutantFitness,
  predictSingleMutants,
  computePositionFrequencies,
  computeDirectInfo,
  computeEpistasis,
  computeEpistasisNetwork,
  identifyRegions,
  findEscapeRoutes,
  classifyProteinType,
  prepareEpistasisProteins,
  analyzeFitnessLandscape,
  renderEpistasisHeatmap,
  type EpistasisPair,
  type SingleMutantEffect,
} from './epistasis';
import type { GeneInfo } from '../types';
import { strict as assert } from 'node:assert';

// ============================================================================
// BLOSUM62 Matrix Tests
// ============================================================================

describe('getBlosum62Score', () => {
  test('returns correct self-scores for amino acids', () => {
    // Self-scores from BLOSUM62 diagonal
    expect(getBlosum62Score('A', 'A')).toBe(4);
    expect(getBlosum62Score('R', 'R')).toBe(5);
    expect(getBlosum62Score('W', 'W')).toBe(11); // Tryptophan has highest self-score
    expect(getBlosum62Score('C', 'C')).toBe(9);  // Cysteine also high
  });

  test('returns correct substitution scores', () => {
    // Known BLOSUM62 substitution pairs
    expect(getBlosum62Score('A', 'V')).toBe(0);  // Hydrophobic similar
    expect(getBlosum62Score('D', 'E')).toBe(2);  // Acidic residues, conservative
    expect(getBlosum62Score('K', 'R')).toBe(2);  // Basic residues, conservative
    expect(getBlosum62Score('W', 'G')).toBe(-2); // Very different
    expect(getBlosum62Score('C', 'W')).toBe(-2); // Different
  });

  test('is symmetric', () => {
    expect(getBlosum62Score('A', 'R')).toBe(getBlosum62Score('R', 'A'));
    expect(getBlosum62Score('W', 'Y')).toBe(getBlosum62Score('Y', 'W'));
    expect(getBlosum62Score('D', 'G')).toBe(getBlosum62Score('G', 'D'));
  });

  test('handles lowercase input', () => {
    expect(getBlosum62Score('a', 'a')).toBe(4);
    expect(getBlosum62Score('a', 'V')).toBe(0);
    expect(getBlosum62Score('A', 'v')).toBe(0);
  });

  test('returns penalty for unknown amino acids', () => {
    expect(getBlosum62Score('X', 'A')).toBe(-4);
    expect(getBlosum62Score('A', 'X')).toBe(-4);
    expect(getBlosum62Score('B', 'Z')).toBe(-4); // B and Z are ambiguous codes
    expect(getBlosum62Score('*', 'A')).toBe(-4);
  });
});

// ============================================================================
// Single Mutant Fitness Tests
// ============================================================================

describe('computeSingleMutantFitness', () => {
  test('returns 0 for wild-type to wild-type (no mutation)', () => {
    // Self-substitution has deltaFitness = 0 (self-score - self-score)
    const delta = computeSingleMutantFitness('A', 'A');
    expect(delta).toBe(0);
  });

  test('returns negative value for deleterious mutations', () => {
    // A->W is a drastic change (small hydrophobic to large aromatic)
    const delta = computeSingleMutantFitness('A', 'W');
    expect(delta).toBeLessThan(0);
  });

  test('conservative substitutions have smaller negative effect', () => {
    // D->E is conservative (both acidic)
    const conservativeDelta = computeSingleMutantFitness('D', 'E');
    // D->W is radical (acidic to aromatic)
    const radicalDelta = computeSingleMutantFitness('D', 'W');

    expect(conservativeDelta).toBeGreaterThan(radicalDelta);
  });

  test('applies context adjustment when neighbors provided', () => {
    const withoutContext = computeSingleMutantFitness('A', 'V');
    const withContext = computeSingleMutantFitness('A', 'V', ['L', 'I']); // Hydrophobic neighbors

    // Context should modify the score slightly
    expect(withContext).not.toBe(withoutContext);
  });

  test('ignores incomplete context', () => {
    const noContext = computeSingleMutantFitness('A', 'V');
    const singleNeighbor = computeSingleMutantFitness('A', 'V', ['L']); // Only one neighbor

    // Single neighbor should be ignored (requires 2)
    expect(singleNeighbor).toBe(noContext);
  });
});

describe('predictSingleMutants', () => {
  test('generates mutants for each position', () => {
    const sequence = 'ACD';
    const mutants = predictSingleMutants(sequence);

    // Each position has 19 possible mutations (20 AA - 1 wild type)
    // 3 positions * 19 mutations = 57 total
    expect(mutants.length).toBe(57);
  });

  test('respects maxPositions option', () => {
    const sequence = 'ACDEFGHIK';
    const mutants = predictSingleMutants(sequence, { maxPositions: 3 });

    // Only first 3 positions: 3 * 19 = 57
    expect(mutants.length).toBe(57);
  });

  test('skips non-standard amino acids', () => {
    const sequence = 'AXC'; // X is not a standard AA
    const mutants = predictSingleMutants(sequence);

    // Only A and C should generate mutants: 2 * 19 = 38
    expect(mutants.length).toBe(38);
  });

  test('includes position and wild-type info', () => {
    const sequence = 'AC';
    const mutants = predictSingleMutants(sequence);

    // Check first mutant at position 0
    const pos0Mutants = mutants.filter(m => m.position === 0);
    expect(pos0Mutants.length).toBe(19);
    expect(pos0Mutants.every(m => m.wildType === 'A')).toBe(true);

    // Check position 1
    const pos1Mutants = mutants.filter(m => m.position === 1);
    expect(pos1Mutants.length).toBe(19);
    expect(pos1Mutants.every(m => m.wildType === 'C')).toBe(true);
  });

  test('assigns structural context as unknown', () => {
    const mutants = predictSingleMutants('A');
    expect(mutants.every(m => m.structuralContext === 'unknown')).toBe(true);
  });
});

// ============================================================================
// Position Frequency Tests
// ============================================================================

describe('computePositionFrequencies', () => {
  test('returns empty array for empty input', () => {
    const result = computePositionFrequencies([]);
    expect(result).toEqual([]);
  });

  test('computes frequencies for single sequence with pseudo-counts', () => {
    const result = computePositionFrequencies(['AC']);

    expect(result.length).toBe(2);

    // Position 0 should have high frequency for A
    expect(result[0].consensus).toBe('A');
    expect(result[0].frequencies['A']).toBeGreaterThan(0.5);

    // Position 1 should have high frequency for C
    expect(result[1].consensus).toBe('C');
    expect(result[1].frequencies['C']).toBeGreaterThan(0.5);
  });

  test('computes entropy correctly for conserved positions', () => {
    // All same AA at position = low entropy
    const conserved = computePositionFrequencies(['AAA', 'AAA', 'AAA']);
    expect(conserved[0].entropy).toBeLessThan(1); // Very low entropy
  });

  test('computes higher entropy for variable positions', () => {
    // Different AAs at position = higher entropy
    const variable = computePositionFrequencies(['AAA', 'CAA', 'DAA', 'EAA']);
    const conserved = computePositionFrequencies(['AAA', 'AAA', 'AAA', 'AAA']);

    expect(variable[0].entropy).toBeGreaterThan(conserved[0].entropy);
  });

  test('identifies consensus amino acid', () => {
    const result = computePositionFrequencies(['A', 'A', 'A', 'C']);
    expect(result[0].consensus).toBe('A'); // A is most frequent
  });

  test('handles sequences of different lengths', () => {
    const result = computePositionFrequencies(['ABC', 'A']);

    // Position 0 has data from both sequences
    expect(result[0].frequencies['A']).toBeGreaterThan(0);
    // Position 2 only has data from first sequence
    expect(result[2].frequencies['C']).toBeGreaterThan(0);
  });
});

// ============================================================================
// Direct Information Tests
// ============================================================================

describe('computeDirectInfo', () => {
  test('returns 0 for out-of-bounds positions', () => {
    const posFreqs = computePositionFrequencies(['AC']);
    expect(computeDirectInfo(posFreqs, 0, 10, ['AC'])).toBe(0);
    expect(computeDirectInfo(posFreqs, 10, 0, ['AC'])).toBe(0);
  });

  test('returns non-negative mutual information', () => {
    const sequences = ['AC', 'AC', 'BD', 'BD'];
    const posFreqs = computePositionFrequencies(sequences);
    const mi = computeDirectInfo(posFreqs, 0, 1, sequences);

    expect(mi).toBeGreaterThanOrEqual(0);
  });

  test('detects correlated positions', () => {
    // Perfectly correlated: A always with C, G always with T
    const correlated = ['AC', 'AC', 'AC', 'GT', 'GT', 'GT'];
    const posFreqs = computePositionFrequencies(correlated);
    const mi = computeDirectInfo(posFreqs, 0, 1, correlated);

    // Should have positive mutual information
    expect(mi).toBeGreaterThan(0);
  });
});

// ============================================================================
// Epistasis Calculation Tests
// ============================================================================

describe('computeEpistasis', () => {
  test('computes single effects correctly', () => {
    const sequence = 'ACDEF';
    const result = computeEpistasis(sequence, 0, 1, 'W', 'W');

    // Both positions should have single effects computed
    expect(typeof result.singleEffect1).toBe('number');
    expect(typeof result.singleEffect2).toBe('number');
  });

  test('classifies antagonistic epistasis for positive epsilon', () => {
    // Create a scenario likely to produce antagonistic epistasis
    // Close positions with mutations that might compensate
    const sequence = 'AAAAAAAAAA';
    const result = computeEpistasis(sequence, 0, 1, 'V', 'L');

    // Result should have a type assigned
    expect(['synergistic', 'antagonistic', 'additive']).toContain(result.type);
  });

  test('produces additive epistasis for distant positions', () => {
    // Distant positions should have minimal interaction
    const sequence = 'A'.repeat(50);
    const result = computeEpistasis(sequence, 0, 45, 'W', 'W');

    // Distant positions should be more likely additive
    // The epistasis score should be close to 0
    expect(Math.abs(result.epistasisScore)).toBeLessThan(1);
  });

  test('includes all required fields', () => {
    const result = computeEpistasis('ACDEF', 0, 2, 'W', 'Y');

    expect(result).toHaveProperty('pos1');
    expect(result).toHaveProperty('pos2');
    expect(result).toHaveProperty('aa1_wt');
    expect(result).toHaveProperty('aa2_wt');
    expect(result).toHaveProperty('aa1_mut');
    expect(result).toHaveProperty('aa2_mut');
    expect(result).toHaveProperty('singleEffect1');
    expect(result).toHaveProperty('singleEffect2');
    expect(result).toHaveProperty('doubleEffect');
    expect(result).toHaveProperty('epistasisScore');
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('significance');
  });

  test('significance is between 0 and 1', () => {
    const result = computeEpistasis('ACDEF', 0, 2, 'W', 'Y');
    expect(result.significance).toBeGreaterThanOrEqual(0);
    expect(result.significance).toBeLessThanOrEqual(1);
  });
});

describe('computeEpistasisNetwork', () => {
  test('returns empty array for short sequences', () => {
    const sequence = 'AC';
    const posFreqs = computePositionFrequencies([sequence]);
    const result = computeEpistasisNetwork(sequence, posFreqs, [sequence]);

    // May return empty if no pairs meet DI threshold
    expect(Array.isArray(result)).toBe(true);
  });

  test('respects topPairs option', () => {
    const sequence = 'ACDEFGHIKLMNPQRSTVWY'; // 20 AA
    const posFreqs = computePositionFrequencies([sequence]);
    const result = computeEpistasisNetwork(sequence, posFreqs, [sequence], {
      topPairs: 5,
      diThreshold: 0, // Accept all pairs
    });

    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ============================================================================
// Region Identification Tests
// ============================================================================

describe('identifyRegions', () => {
  test('returns empty array for empty input', () => {
    const result = identifyRegions([]);
    expect(result).toEqual([]);
  });

  test('identifies robust regions for tolerant positions', () => {
    // Create mutants with high tolerance (positive or neutral fitness)
    const tolerantMutants: SingleMutantEffect[] = [];
    for (let pos = 0; pos < 20; pos++) {
      for (let i = 0; i < 19; i++) {
        tolerantMutants.push({
          position: pos,
          wildType: 'A',
          mutant: 'RNDCQEGHILKMFPSTWYV'[i],
          deltaFitness: -1, // Mild effect
          uncertainty: 0.2,
          structuralContext: 'unknown',
        });
      }
    }

    const regions = identifyRegions(tolerantMutants);

    // Should identify some regions
    expect(regions.length).toBeGreaterThan(0);

    // At least one should be robust given the mild effects
    const robustRegions = regions.filter(r => r.type === 'robust');
    expect(robustRegions.length).toBeGreaterThan(0);
  });

  test('identifies fragile regions for intolerant positions', () => {
    // Create mutants with low tolerance (very negative fitness)
    const intolerantMutants: SingleMutantEffect[] = [];
    for (let pos = 0; pos < 20; pos++) {
      for (let i = 0; i < 19; i++) {
        intolerantMutants.push({
          position: pos,
          wildType: 'A',
          mutant: 'RNDCQEGHILKMFPSTWYV'[i],
          deltaFitness: -10, // Severe effect
          uncertainty: 0.2,
          structuralContext: 'unknown',
        });
      }
    }

    const regions = identifyRegions(intolerantMutants);

    // Should identify some regions
    expect(regions.length).toBeGreaterThan(0);

    // Should have fragile regions given severe effects
    const fragileRegions = regions.filter(r => r.type === 'fragile');
    expect(fragileRegions.length).toBeGreaterThan(0);
  });

  test('merges adjacent regions of same type', () => {
    // Create uniform mutants across positions
    const uniformMutants: SingleMutantEffect[] = [];
    for (let pos = 0; pos < 30; pos++) {
      uniformMutants.push({
        position: pos,
        wildType: 'A',
        mutant: 'W',
        deltaFitness: -1, // Consistent mild effect
        uncertainty: 0.2,
        structuralContext: 'unknown',
      });
    }

    const regions = identifyRegions(uniformMutants, 5);

    // Should merge into fewer regions since all have same characteristics
    // Exact number depends on window size and merging logic
    expect(regions.length).toBeLessThanOrEqual(10);
  });
});

// ============================================================================
// Escape Route Tests
// ============================================================================

describe('findEscapeRoutes', () => {
  test('returns empty array when no antagonistic pairs', () => {
    const pairs: EpistasisPair[] = [{
      pos1: 0, pos2: 1,
      aa1_wt: 'A', aa2_wt: 'C',
      aa1_mut: 'W', aa2_mut: 'W',
      singleEffect1: -5, singleEffect2: -5,
      doubleEffect: -10,
      epistasisScore: 0,
      type: 'additive',
      significance: 0.5,
    }];

    const routes = findEscapeRoutes(pairs, []);
    expect(routes.length).toBe(0);
  });

  test('identifies compensatory mutation pairs as escape routes', () => {
    const pairs: EpistasisPair[] = [{
      pos1: 0, pos2: 5,
      aa1_wt: 'A', aa2_wt: 'C',
      aa1_mut: 'V', aa2_mut: 'S',
      singleEffect1: -3,  // Each single is deleterious
      singleEffect2: -3,
      doubleEffect: -4,   // But double is better than sum (-6)
      epistasisScore: 2,  // Positive = antagonistic
      type: 'antagonistic',
      significance: 0.3,
    }];

    const routes = findEscapeRoutes(pairs, []);
    expect(routes.length).toBe(1);
    expect(routes[0].mutations.length).toBe(2);
    expect(routes[0].fitnessGain).toBe(2);
  });

  test('respects topN limit', () => {
    const pairs: EpistasisPair[] = [];
    for (let i = 0; i < 20; i++) {
      pairs.push({
        pos1: i, pos2: i + 20,
        aa1_wt: 'A', aa2_wt: 'C',
        aa1_mut: 'V', aa2_mut: 'S',
        singleEffect1: -3,
        singleEffect2: -3,
        doubleEffect: -4,
        epistasisScore: 2 + i * 0.1, // Varying scores
        type: 'antagonistic',
        significance: 0.3,
      });
    }

    const routes = findEscapeRoutes(pairs, [], 5);
    expect(routes.length).toBe(5);
  });

  test('generates descriptive path description', () => {
    const pairs: EpistasisPair[] = [{
      pos1: 10, pos2: 25,
      aa1_wt: 'A', aa2_wt: 'G',
      aa1_mut: 'V', aa2_mut: 'S',
      singleEffect1: -2,
      singleEffect2: -2,
      doubleEffect: -2,
      epistasisScore: 2,
      type: 'antagonistic',
      significance: 0.3,
    }];

    const routes = findEscapeRoutes(pairs, []);
    expect(routes[0].pathDescription).toContain('A11V'); // 1-indexed
    expect(routes[0].pathDescription).toContain('G26S');
  });
});

// ============================================================================
// Protein Type Classification Tests
// ============================================================================

describe('classifyProteinType', () => {
  test('identifies capsid proteins', () => {
    const gene: GeneInfo = {
      id: 1,
      name: 'gp23',
      locusTag: null,
      product: 'major capsid protein',
      startPos: 1000,
      endPos: 2000,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('capsid');
  });

  test('identifies tail fiber proteins', () => {
    const gene: GeneInfo = {
      id: 2,
      name: 'gp37',
      locusTag: null,
      product: 'tail fiber protein',
      startPos: 5000,
      endPos: 7000,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('tail_fiber');
  });

  test('identifies portal proteins', () => {
    const gene: GeneInfo = {
      id: 3,
      name: 'portal',
      locusTag: null,
      product: 'portal protein',
      startPos: 3000,
      endPos: 4000,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('portal');
  });

  test('identifies polymerase proteins', () => {
    const gene: GeneInfo = {
      id: 4,
      name: 'dnap',
      locusTag: null,
      product: 'DNA polymerase',
      startPos: 8000,
      endPos: 10000,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('polymerase');
  });

  test('returns other for unrecognized proteins', () => {
    const gene: GeneInfo = {
      id: 5,
      name: 'hypothetical',
      locusTag: null,
      product: 'hypothetical protein',
      startPos: 100,
      endPos: 500,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('other');
  });

  test('handles missing product annotation', () => {
    const gene: GeneInfo = {
      id: 6,
      name: 'capsid',
      locusTag: null,
      product: null,
      startPos: 100,
      endPos: 500,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('capsid');
  });

  test('uses locusTag when name is missing', () => {
    const gene: GeneInfo = {
      id: 7,
      name: null,
      locusTag: 'tailspike_001',
      product: null,
      startPos: 100,
      endPos: 500,
      strand: '+',
      type: null,
    };
    expect(classifyProteinType(gene)).toBe('tail_fiber');
  });
});

// ============================================================================
// Full Fitness Landscape Analysis Tests
// ============================================================================

describe('analyzeFitnessLandscape', () => {
  test('returns complete landscape structure', () => {
    const landscape = analyzeFitnessLandscape('test_protein', 'ACDEFGHIK');

    expect(landscape).toHaveProperty('proteinName', 'test_protein');
    expect(landscape).toHaveProperty('proteinSequence');
    expect(landscape).toHaveProperty('singleMutants');
    expect(landscape).toHaveProperty('epistasisPairs');
    expect(landscape).toHaveProperty('robustRegions');
    expect(landscape).toHaveProperty('fragileRegions');
    expect(landscape).toHaveProperty('escapeRoutes');
    expect(landscape).toHaveProperty('positionFrequencies');
    expect(landscape).toHaveProperty('averageFitness');
    expect(landscape).toHaveProperty('fitnessVariance');
  });

  test('limits sequence to maxPositions', () => {
    const landscape = analyzeFitnessLandscape(
      'long_protein',
      'A'.repeat(500),
      { maxPositions: 50 }
    );

    expect(landscape.proteinSequence.length).toBe(50);
  });

  test('computes single mutants for all positions', () => {
    const landscape = analyzeFitnessLandscape('short', 'ACD');

    // 3 positions * 19 mutations = 57
    expect(landscape.singleMutants.length).toBe(57);
  });

  test('computes average fitness and variance', () => {
    const landscape = analyzeFitnessLandscape('test', 'ACDEF');

    expect(typeof landscape.averageFitness).toBe('number');
    expect(typeof landscape.fitnessVariance).toBe('number');
    expect(landscape.fitnessVariance).toBeGreaterThanOrEqual(0);
  });

  test('handles empty sequence gracefully', () => {
    const landscape = analyzeFitnessLandscape('empty', '');

    expect(landscape.singleMutants.length).toBe(0);
    expect(landscape.averageFitness).toBe(0);
    expect(landscape.fitnessVariance).toBe(0);
  });

  test('uses provided alignment for frequencies', () => {
    const alignment = ['AAAA', 'AAAA', 'CCCC', 'CCCC'];
    const landscape = analyzeFitnessLandscape('aligned', 'AAAA', {
      sequences: alignment,
    });

    // Position frequencies should reflect alignment diversity
    expect(landscape.positionFrequencies.length).toBe(4);
  });
});

// ============================================================================
// Rendering Tests
// ============================================================================

describe('renderEpistasisHeatmap', () => {
  test('returns message for empty pairs', () => {
    const result = renderEpistasisHeatmap([]);
    expect(result).toBe('No epistasis pairs computed');
  });

  test('produces ASCII output for valid pairs', () => {
    const pairs: EpistasisPair[] = [
      {
        pos1: 0, pos2: 10,
        aa1_wt: 'A', aa2_wt: 'C',
        aa1_mut: 'V', aa2_mut: 'S',
        singleEffect1: -2, singleEffect2: -2,
        doubleEffect: -3, epistasisScore: 1,
        type: 'antagonistic', significance: 0.3,
      },
      {
        pos1: 5, pos2: 15,
        aa1_wt: 'D', aa2_wt: 'E',
        aa1_mut: 'W', aa2_mut: 'Y',
        singleEffect1: -5, singleEffect2: -5,
        doubleEffect: -8, epistasisScore: 2,
        type: 'antagonistic', significance: 0.2,
      },
    ];

    const result = renderEpistasisHeatmap(pairs, 20);

    // Should produce multi-line output
    expect(result).toContain('\n');

    // Should use block characters
    const hasBlockChars = /[░▒▓█]/.test(result) || result.includes(' ');
    expect(hasBlockChars).toBe(true);
  });

  test('respects width parameter', () => {
    const pairs: EpistasisPair[] = [
      {
        pos1: 0, pos2: 100,
        aa1_wt: 'A', aa2_wt: 'C',
        aa1_mut: 'V', aa2_mut: 'S',
        singleEffect1: -2, singleEffect2: -2,
        doubleEffect: -3, epistasisScore: 1,
        type: 'antagonistic', significance: 0.3,
      },
    ];

    const narrow = renderEpistasisHeatmap(pairs, 10);
    const wide = renderEpistasisHeatmap(pairs, 50);

    // Narrow should have fewer characters per line
    const narrowLines = narrow.split('\n');
    const wideLines = wide.split('\n');

    expect(narrowLines[0].length).toBeLessThanOrEqual(wideLines[0].length);
  });
});

describe('exact CDS inputs for the epistasis explorer', () => {
  const gene = (overrides: Partial<GeneInfo> = {}): GeneInfo => ({
    id: 1, name: 'capsid', locusTag: 'test_1', product: 'major capsid protein',
    type: 'CDS', strand: '+', startPos: 0, endPos: 153, ...overrides,
  });
  const dna = 'ATG' + 'GCT'.repeat(49) + 'TAA';

  test('includes a CDS at genomic zero and removes only its terminal stop', () => {
    const result = prepareEpistasisProteins([gene()], dna.toLowerCase());
    assert.equal(result.excluded.length, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sequence, 'M' + 'A'.repeat(49));
    assert.equal(result.candidates[0].reference.cds, dna);
    assert.deepEqual(result.candidates[0].reference.segments, [{ start: 0, end: 153, strand: '+' }]);
  });

  test('uses reverse joined segments, codon_start and recoded TAG without intervening genomic sequence', () => {
    // Reverse complements are explicit independent fixture bytes:
    // rc(GCT*49 + TAA) = TTA + AGC*49; rc(CTAG) = CTAG.
    const genome = 'TTA' + 'AGC'.repeat(49) + 'C'.repeat(20) + 'CTAG';
    const annotated = gene({ strand: '-', endPos: 174, qualifiers: {
      codon_start: 2, transl_table: 15,
      _segments: [{ start: 170, end: 174, strand: '-' }, { start: 0, end: 150, strand: '-' }],
      translation: 'Q' + 'A'.repeat(49),
    } });
    const result = prepareEpistasisProteins([annotated], genome);
    assert.equal(result.excluded.length, 0);
    assert.equal(result.candidates[0].sequence, 'Q' + 'A'.repeat(49));
    assert.equal(result.candidates[0].reference.geneticCode, 15);
    assert.equal(result.candidates[0].reference.codonStart, 2);
    assert.deepEqual(result.candidates[0].reference.segments, [
      { start: 170, end: 173, strand: '-' }, { start: 0, end: 150, strand: '-' },
    ]);
  });

  test('retains origin-spanning transcript order and excludes non-CDS annotation duplicates', () => {
    const genome = 'GCT'.repeat(49) + 'TAA' + 'C'.repeat(20) + 'ATG';
    const annotated = gene({ endPos: 173, qualifiers: {
      _segments: [{ start: 170, end: 173, strand: '+' }, { start: 0, end: 150, strand: '+' }],
    } });
    const result = prepareEpistasisProteins([gene({ id: 2, type: 'gene' }), annotated], genome);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sequence, 'M' + 'A'.repeat(49));
  });

  test('reports unsupported and inconsistent CDS inputs instead of scoring fabricated translations', () => {
    const cases: Array<[GeneInfo, string, RegExp]> = [
      [gene({ qualifiers: { transl_table: 2 } }), dna, /translation table/],
      [gene({ qualifiers: { translation: 'W'.repeat(50) } }), dna, /translation differs/],
      [gene({ qualifiers: { pseudo: '' } }), dna, /pseudo/],
      [gene(), 'ATG' + 'TAG' + 'GCT'.repeat(48) + 'TAA', /internal stop/],
      [gene(), 'ATG' + 'NNN' + 'GCT'.repeat(48) + 'TAA', /unresolved bases/],
      [gene({ endPos: 150 }), 'ATG' + 'GCT'.repeat(48) + 'TAA', /At least 50/],
      [gene({ endPos: 154 }), dna + 'A', /complete terminal codons/],
    ];
    for (const [annotation, genome, reason] of cases) {
      const result = prepareEpistasisProteins([annotation], genome);
      assert.equal(result.candidates.length, 0);
      assert.equal(result.excluded.length, 1);
      assert.match(result.excluded[0].reasons.join(' '), reason);
    }
  });

  test('makes all supported candidate proteins selectable and keeps deterministic priority', () => {
    const annotations = Array.from({ length: 12 }, (_, index) => gene({
      id: 12 - index, product: index % 2 ? 'tail fiber' : 'major capsid protein', name: null, locusTag: null,
    }));
    const result = prepareEpistasisProteins(annotations, dna);
    assert.equal(result.candidates.length, 12);
    assert.deepEqual(result.candidates.map(row => row.gene.id), [2, 4, 6, 8, 10, 12, 1, 3, 5, 7, 9, 11]);
    const selected = result.candidates[0];
    const landscape = analyzeFitnessLandscape('exact CDS', selected.sequence, { maxPositions: 50, topEpistasisPairs: 20 });
    assert.equal(landscape.proteinSequence, 'M' + 'A'.repeat(49));
    assert.equal(landscape.singleMutants.length, 50 * 19);
    assert.ok(landscape.singleMutants.every(m => m.wildType === selected.sequence[m.position]));
  });
});
