/**
 * Unit tests for Metagenomic Co-Occurrence & Niche Profiler
 */

import { describe, it, expect } from 'bun:test';
import {
  normalizeAbundance,
  clrTransform,
  estimateBasisCorrelations,
  nmf,
  buildCoOccurrenceNetwork,
  analyzeNiches,
  generateDemoAbundanceTable,
  type AbundanceTable,
  type CorrelationMatrix,
  type NMFResult,
  createSeededRng,
} from './metagenomic-niche';

// Seeded RNG for reproducible tests
function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('normalizeAbundance', () => {
  it('returns empty array for empty input', () => {
    expect(normalizeAbundance([])).toEqual([]);
  });

  it('adds pseudocount and normalizes', () => {
    const counts = [[0, 10, 0]];
    const result = normalizeAbundance(counts, 1);

    // With pseudocount=1: [1, 11, 1], total=13
    // Normalized: [1/13, 11/13, 1/13]
    expect(result[0][0]).toBeCloseTo(1 / 13);
    expect(result[0][1]).toBeCloseTo(11 / 13);
    expect(result[0][2]).toBeCloseTo(1 / 13);
  });

  it('normalizes each row independently', () => {
    const counts = [
      [1, 1],
      [2, 2],
    ];
    const result = normalizeAbundance(counts, 0);

    // Each row should sum to 1
    expect(result[0].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(result[1].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('respects custom pseudocount', () => {
    const counts = [[0, 0]];
    const result = normalizeAbundance(counts, 5);

    // With pseudocount=5: [5, 5], total=10
    expect(result[0][0]).toBeCloseTo(0.5);
    expect(result[0][1]).toBeCloseTo(0.5);
  });
});

describe('clrTransform', () => {
  it('returns empty array for empty input', () => {
    expect(clrTransform([])).toEqual([]);
  });

  it('transforms uniform abundances to zeros', () => {
    const abundances = [[0.25, 0.25, 0.25, 0.25]];
    const result = clrTransform(abundances);

    // Uniform distribution -> all CLR values should be 0
    for (const val of result[0]) {
      expect(val).toBeCloseTo(0, 5);
    }
  });

  it('CLR values sum to zero for each row', () => {
    const abundances = [[0.1, 0.2, 0.3, 0.4]];
    const result = clrTransform(abundances);

    const sum = result[0].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(0, 5);
  });

  it('handles multiple rows', () => {
    const abundances = [
      [0.25, 0.25, 0.25, 0.25],
      [0.1, 0.2, 0.3, 0.4],
    ];
    const result = clrTransform(abundances);

    expect(result.length).toBe(2);
    expect(result[0].reduce((a, b) => a + b, 0)).toBeCloseTo(0, 5);
    expect(result[1].reduce((a, b) => a + b, 0)).toBeCloseTo(0, 5);
  });
});

describe('estimateBasisCorrelations', () => {
  it('returns empty array for empty input', () => {
    expect(estimateBasisCorrelations([])).toEqual([]);
  });

  it('returns empty array for empty samples', () => {
    expect(estimateBasisCorrelations([[]])).toEqual([]);
  });

  it('produces symmetric correlation matrix', () => {
    const clrData = [
      [0.1, 0.2, -0.1, 0.0],
      [0.2, 0.3, 0.0, 0.1],
      [-0.1, 0.0, 0.1, -0.2],
    ];
    const result = estimateBasisCorrelations(clrData, 3);

    // Check symmetry
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < result.length; j++) {
        expect(result[i][j]).toBeCloseTo(result[j][i], 5);
      }
    }
  });

  it('diagonal elements are 1', () => {
    const clrData = [
      [0.1, 0.2, -0.1, 0.0],
      [0.2, 0.3, 0.0, 0.1],
    ];
    const result = estimateBasisCorrelations(clrData, 3);

    for (let i = 0; i < result.length; i++) {
      expect(result[i][i]).toBe(1);
    }
  });

  it('correlations are in [-1, 1]', () => {
    const clrData = [
      [0.1, 0.2, -0.1, 0.0, 0.3],
      [0.2, 0.3, 0.0, 0.1, -0.2],
      [-0.1, 0.0, 0.1, -0.2, 0.0],
    ];
    const result = estimateBasisCorrelations(clrData, 5);

    for (const row of result) {
      for (const val of row) {
        expect(val).toBeGreaterThanOrEqual(-1);
        expect(val).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('nmf', () => {
  const rng = seededRng(42);

  it('returns empty result for empty input', () => {
    const result = nmf([], 2, 10, 1e-3, rng);
    expect(result.W).toEqual([]);
    expect(result.H).toEqual([]);
    expect(result.k).toBe(0);
  });

  it('returns empty result for k <= 0', () => {
    const V = [[1, 2], [3, 4]];
    const result = nmf(V, 0, 10, 1e-3, rng);
    expect(result.W).toEqual([]);
    expect(result.H).toEqual([]);
  });

  it('produces correct dimensions', () => {
    const V = [
      [1, 2, 3],
      [4, 5, 6],
    ]; // 2 taxa, 3 samples
    const result = nmf(V, 2, 50, 1e-3, seededRng(123));

    // W should be 2x2 (taxa x k)
    expect(result.W.length).toBe(2);
    expect(result.W[0].length).toBe(2);

    // H should be 2x3 (k x samples)
    expect(result.H.length).toBe(2);
    expect(result.H[0].length).toBe(3);
  });

  it('W and H values are non-negative', () => {
    const V = [
      [10, 20, 30],
      [40, 50, 60],
      [5, 15, 25],
    ];
    const result = nmf(V, 2, 50, 1e-3, seededRng(456));

    for (const row of result.W) {
      for (const val of row) {
        expect(val).toBeGreaterThanOrEqual(0);
      }
    }
    for (const row of result.H) {
      for (const val of row) {
        expect(val).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('converges to low reconstruction error', () => {
    const V = [
      [10, 20, 30, 40],
      [5, 10, 15, 20],
    ];
    const result = nmf(V, 1, 100, 1e-4, seededRng(789));

    // Error should decrease from initial random
    expect(result.error).toBeLessThan(100);
  });
});

describe('buildCoOccurrenceNetwork', () => {
  it('returns empty network for empty inputs', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: [],
      correlations: [],
    };
    const nmfResult: NMFResult = { W: [], H: [], error: 0, k: 0 };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.stats.nodeCount).toBe(0);
    expect(result.stats.edgeCount).toBe(0);
  });

  it('creates nodes for each taxon', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: ['A', 'B', 'C'],
      correlations: [
        [1, 0.5, 0.2],
        [0.5, 1, 0.3],
        [0.2, 0.3, 1],
      ],
    };
    const nmfResult: NMFResult = {
      W: [[0.8, 0.2], [0.3, 0.7], [0.5, 0.5]],
      H: [[1], [1]],
      error: 0,
      k: 2,
    };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult);

    expect(result.nodes.length).toBe(3);
    expect(result.nodes[0].taxon).toBe('A');
    expect(result.nodes[1].taxon).toBe('B');
    expect(result.nodes[2].taxon).toBe('C');
  });

  it('filters edges by correlation threshold', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: ['A', 'B', 'C'],
      correlations: [
        [1, 0.5, 0.1],
        [0.5, 1, 0.2],
        [0.1, 0.2, 1],
      ],
    };
    const nmfResult: NMFResult = {
      W: [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]],
      H: [[1], [1]],
      error: 0,
      k: 2,
    };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult, {
      correlationThreshold: 0.4,
      pvalueThreshold: 1, // Disable p-value filtering
    });

    // Only A-B edge should pass threshold of 0.4
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source).toBe('A');
    expect(result.edges[0].target).toBe('B');
  });

  it('categorizes edges as positive or negative', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: ['A', 'B'],
      correlations: [
        [1, -0.8],
        [-0.8, 1],
      ],
    };
    const nmfResult: NMFResult = {
      W: [[0.5, 0.5], [0.5, 0.5]],
      H: [[1], [1]],
      error: 0,
      k: 2,
    };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult, {
      correlationThreshold: 0.3,
      pvalueThreshold: 1,
    });

    expect(result.edges.length).toBe(1);
    expect(result.edges[0].type).toBe('negative');
  });

  it('excludes negative edges when specified', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: ['A', 'B'],
      correlations: [
        [1, -0.8],
        [-0.8, 1],
      ],
    };
    const nmfResult: NMFResult = {
      W: [[0.5, 0.5], [0.5, 0.5]],
      H: [[1], [1]],
      error: 0,
      k: 2,
    };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult, {
      correlationThreshold: 0.3,
      pvalueThreshold: 1,
      includeNegative: false,
    });

    expect(result.edges.length).toBe(0);
  });

  it('calculates network statistics correctly', () => {
    const corrMatrix: CorrelationMatrix = {
      taxa: ['A', 'B', 'C'],
      correlations: [
        [1, 0.8, 0.7],
        [0.8, 1, 0.6],
        [0.7, 0.6, 1],
      ],
    };
    const nmfResult: NMFResult = {
      W: [[1], [1], [1]],
      H: [[1]],
      error: 0,
      k: 1,
    };

    const result = buildCoOccurrenceNetwork(corrMatrix, nmfResult, {
      correlationThreshold: 0.5,
      pvalueThreshold: 1,
    });

    // 3 nodes, 3 edges (all pass threshold)
    expect(result.stats.nodeCount).toBe(3);
    expect(result.stats.edgeCount).toBe(3);
    expect(result.stats.density).toBeCloseTo(1); // 3/3 = 1 (fully connected)
    expect(result.stats.positiveRatio).toBe(1); // All positive
  });
});

describe('generateDemoAbundanceTable', () => {
  const rng = seededRng(42);

  it('generates table with correct dimensions', () => {
    const result = generateDemoAbundanceTable(5, 10, 2, rng);

    expect(result.taxa.length).toBe(5);
    expect(result.samples.length).toBe(10);
    expect(result.counts.length).toBe(5);
    expect(result.counts[0].length).toBe(10);
  });

  it('generates non-negative counts', () => {
    const result = generateDemoAbundanceTable(3, 5, 2, seededRng(123));

    for (const row of result.counts) {
      for (const count of row) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('uses provided RNG for reproducibility', () => {
    const result1 = generateDemoAbundanceTable(3, 3, 2, seededRng(100));
    const result2 = generateDemoAbundanceTable(3, 3, 2, seededRng(100));

    expect(result1.counts).toEqual(result2.counts);
  });

  it('generates different data with different seeds', () => {
    const result1 = generateDemoAbundanceTable(3, 3, 2, seededRng(100));
    const result2 = generateDemoAbundanceTable(3, 3, 2, seededRng(200));

    expect(result1.counts).not.toEqual(result2.counts);
  });
});

describe('analyzeNiches', () => {
  const rng = seededRng(42);

  it('runs complete pipeline on small data', () => {
    const table: AbundanceTable = {
      taxa: ['A', 'B', 'C'],
      samples: ['S1', 'S2', 'S3', 'S4'],
      counts: [
        [10, 20, 5, 15],
        [5, 25, 10, 20],
        [15, 10, 20, 5],
      ],
    };

    const result = analyzeNiches(table, undefined, {
      numNiches: 2,
      bootstrapIterations: 10,
      rng,
    });

    expect(result.correlationMatrix.taxa).toEqual(['A', 'B', 'C']);
    expect(result.nmfResult.k).toBe(2);
    expect(result.network.nodes.length).toBe(3);
    expect(result.nicheProfiles.length).toBe(3);
  });

  it('auto-detects number of niches when numNiches=0', () => {
    const table = generateDemoAbundanceTable(5, 10, 3, seededRng(100));

    const result = analyzeNiches(table, undefined, {
      numNiches: 0,
      bootstrapIterations: 5,
      rng: seededRng(200),
    });

    expect(result.nmfResult.k).toBeGreaterThanOrEqual(2);
  });

  it('produces niche profiles with valid structure', () => {
    const table: AbundanceTable = {
      taxa: ['Phage1', 'Phage2'],
      samples: ['S1', 'S2', 'S3'],
      counts: [
        [100, 50, 10],
        [10, 50, 100],
      ],
    };

    const result = analyzeNiches(table, undefined, {
      numNiches: 2,
      bootstrapIterations: 5,
      rng,
    });

    for (const profile of result.nicheProfiles) {
      expect(profile.nicheWeights.length).toBe(2);
      expect(profile.nicheWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      expect(profile.primaryNiche).toBeGreaterThanOrEqual(0);
      expect(profile.primaryNiche).toBeLessThan(2);
      expect(profile.nicheConfidence).toBeGreaterThanOrEqual(0);
      expect(profile.nicheConfidence).toBeLessThanOrEqual(1);
    }
  });

  it('includes metadata-derived habitats when provided', () => {
    const table: AbundanceTable = {
      taxa: ['A', 'B'],
      samples: ['S1', 'S2'],
      counts: [[10, 20], [20, 10]],
    };
    const metadata = [
      { sampleId: 'S1', habitat: 'gut' },
      { sampleId: 'S2', habitat: 'soil' },
    ];

    const result = analyzeNiches(table, metadata, {
      numNiches: 2,
      bootstrapIterations: 5,
      rng,
    });

    // Profiles should have associated habitats
    for (const profile of result.nicheProfiles) {
      expect(Array.isArray(profile.associatedHabitats)).toBe(true);
    }
  });
});

describe('edge cases', () => {
  it('handles single taxon', () => {
    const table: AbundanceTable = {
      taxa: ['OnlyTaxon'],
      samples: ['S1', 'S2'],
      counts: [[10, 20]],
    };

    const result = analyzeNiches(table, undefined, {
      numNiches: 1,
      bootstrapIterations: 5,
      rng: seededRng(42),
    });

    expect(result.nicheProfiles.length).toBe(1);
  });

  it('handles single sample', () => {
    const table: AbundanceTable = {
      taxa: ['A', 'B'],
      samples: ['OnlySample'],
      counts: [[10], [20]],
    };

    // Should not crash
    const result = analyzeNiches(table, undefined, {
      numNiches: 1,
      bootstrapIterations: 5,
      rng: seededRng(42),
    });

    expect(result.nicheProfiles.length).toBe(2);
  });

  it('handles all-zero counts', () => {
    const table: AbundanceTable = {
      taxa: ['A', 'B'],
      samples: ['S1', 'S2'],
      counts: [[0, 0], [0, 0]],
    };

    // Should not crash (pseudocount saves us)
    const result = analyzeNiches(table, undefined, {
      numNiches: 1,
      bootstrapIterations: 5,
      rng: seededRng(42),
    });

    expect(result.nicheProfiles.length).toBe(2);
  });
});

/**
 * Reproducibility of the simulated community.
 *
 * The niche network overlay called `generateDemoAbundanceTable` with the
 * default `Math.random`, so it produced a different community on every open and
 * the same one for every phage. A user could not compare two genomes with it,
 * and could not return to a network they had just been looking at. Neither is
 * acceptable even for an educational simulation.
 */
describe('createSeededRng', () => {
  it('produces the same stream for the same seed', () => {
    const a = Array.from({ length: 20 }, () => createSeededRng('lambda:4')());
    const b = Array.from({ length: 20 }, () => createSeededRng('lambda:4')());
    expect(a).toEqual(b);
  });

  it('advances rather than repeating one value', () => {
    // A generator that returns a constant would satisfy the test above.
    const rng = createSeededRng('lambda:4');
    const draws = Array.from({ length: 20 }, () => rng());
    expect(new Set(draws).size).toBeGreaterThan(10);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 20 }, () => createSeededRng('lambda:4')());
    const b = Array.from({ length: 20 }, () => createSeededRng('t4:4')());
    expect(a).not.toEqual(b);
  });

  it('stays within [0, 1)', () => {
    const rng = createSeededRng(12345);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('does not collapse on a seed that hashes to zero', () => {
    // Guards the fixed-point defence in the implementation.
    const rng = createSeededRng(0);
    const draws = Array.from({ length: 20 }, () => rng());
    expect(new Set(draws).size).toBeGreaterThan(10);
  });
});

describe('the simulated community is reproducible per phage', () => {
  const build = (seed: string) =>
    generateDemoAbundanceTable(10, 12, 3, createSeededRng(seed));

  it('gives the identical table for the same phage and parameters', () => {
    expect(build('1:3').counts).toEqual(build('1:3').counts);
  });

  it('gives a different table for a different phage', () => {
    // Without this the overlay would be reproducible and still identical for
    // every genome, which is the other half of the original defect.
    expect(build('1:3').counts).not.toEqual(build('2:3').counts);
  });

  it('gives a different table when the parameters change', () => {
    expect(build('1:3').counts).not.toEqual(build('1:5').counts);
  });

  it('still defaults to Math.random when no rng is supplied', () => {
    // The seeding is the caller's choice, not a change to the function's
    // contract. Two unseeded calls should differ.
    const a = generateDemoAbundanceTable(10, 12, 3);
    const b = generateDemoAbundanceTable(10, 12, 3);
    expect(a.counts).not.toEqual(b.counts);
  });
});
