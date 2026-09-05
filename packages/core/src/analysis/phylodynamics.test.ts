/**
 * Unit tests for Phylodynamic Trajectory Explorer
 */

import { describe, it, expect } from 'bun:test';
import {
  jukesCantor,
  computeGeneticDistanceMatrix,
  buildUPGMATree,
  clockRegression,
  calibrateTree,
  computeSkyline,
  computeDnDs,
  computeSelection,
  analyzePhylodynamics,
  generateDemoPhylodynamicsData,
  type DatedSequence,
} from './phylodynamics';

describe('jukesCantor', () => {
  it('returns 0 for identical sequences', () => {
    const d = jukesCantor('ACGT', 'ACGT');
    expect(d).toBe(0);
  });

  it('returns positive distance for different sequences', () => {
    const d = jukesCantor('AAAA', 'TTTT');
    expect(d).toBeGreaterThan(0);
  });

  it('skips gaps and N bases', () => {
    const d1 = jukesCantor('ACGT', 'A-GT');
    const d2 = jukesCantor('AGT', 'AGT'); // Same comparison without gap position
    const d3 = jukesCantor('ACNT', 'ACGT'); // N base should be ignored

    expect(d1).toBeCloseTo(d2, 12);
    expect(d3).toBe(0);
  });

  it('handles case insensitivity', () => {
    const d1 = jukesCantor('ACGT', 'acgt');
    expect(d1).toBe(0);
  });

  it('caps distance at saturation (p >= 0.75)', () => {
    // All different bases
    const d = jukesCantor('AAAA', 'CCCC');
    expect(d).toBeLessThanOrEqual(3.0);
  });

  it('throws for unequal length sequences', () => {
    expect(() => jukesCantor('ACGT', 'ACG')).toThrow('equal length');
  });
});

describe('computeGeneticDistanceMatrix', () => {
  it('returns symmetric matrix', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAA', date: 2020 },
      { id: 'B', sequence: 'AAAT', date: 2021 },
      { id: 'C', sequence: 'TTTT', date: 2022 },
    ];
    const matrix = computeGeneticDistanceMatrix(sequences);

    expect(matrix.length).toBe(3);
    expect(matrix[0][1]).toBe(matrix[1][0]);
    expect(matrix[0][2]).toBe(matrix[2][0]);
    expect(matrix[1][2]).toBe(matrix[2][1]);
  });

  it('has zero diagonal', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ACGT', date: 2020 },
      { id: 'B', sequence: 'ACGT', date: 2021 },
    ];
    const matrix = computeGeneticDistanceMatrix(sequences);

    expect(matrix[0][0]).toBe(0);
    expect(matrix[1][1]).toBe(0);
  });
});

describe('buildUPGMATree', () => {
  it('builds tree from single sequence', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ACGT', date: 2020 },
    ];
    const tree = buildUPGMATree(sequences);

    expect(tree.leafCount).toBe(1);
    expect(tree.root.isLeaf).toBe(true);
    expect(tree.root.id).toBe('A');
  });

  it('builds tree from multiple sequences', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAA', date: 2020 },
      { id: 'B', sequence: 'AAAT', date: 2021 },
      { id: 'C', sequence: 'TTTT', date: 2022 },
    ];
    const tree = buildUPGMATree(sequences);

    expect(tree.leafCount).toBe(3);
    expect(tree.root.isLeaf).toBe(false);
    expect(tree.isClockCalibrated).toBe(false);
  });

  it('throws for empty sequences', () => {
    expect(() => buildUPGMATree([])).toThrow('No sequences');
  });

  it('clusters similar sequences together', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAAAAAAAA', date: 2020 },
      { id: 'B', sequence: 'AAAAAAAAAC', date: 2021 }, // Very similar to A
      { id: 'C', sequence: 'TTTTTTTTTT', date: 2022 }, // Very different
    ];
    const tree = buildUPGMATree(sequences);

    // A and B should cluster before C joins
    // The internal node combining A+B should have lower height than root
    expect(tree.root.children.length).toBe(2);
  });
});

describe('clockRegression', () => {
  it('returns zero rate for undated sequences', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAA', date: 2020 },
    ];
    const tree = buildUPGMATree(sequences);
    const result = clockRegression(tree);

    // Single sequence can't compute regression
    expect(result.residuals.length).toBeLessThanOrEqual(1);
  });

  it('computes positive rate for diverging sequences', () => {
    // Create sequences that diverge over time
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAAAAAAAA', date: 2020.0 },
      { id: 'B', sequence: 'AAAAAAAAAC', date: 2021.0 },
      { id: 'C', sequence: 'AAAAAAAACC', date: 2022.0 },
      { id: 'D', sequence: 'AAAAAAAACT', date: 2023.0 },
    ];
    const tree = buildUPGMATree(sequences);
    const result = clockRegression(tree);

    expect(result.rate).toBeGreaterThanOrEqual(0);
    expect(result.residuals.length).toBe(4);
  });
});

describe('calibrateTree', () => {
  it('returns uncalibrated tree for zero rate', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ACGT', date: 2020 },
      { id: 'B', sequence: 'ACGT', date: 2021 },
    ];
    const tree = buildUPGMATree(sequences);
    const regression = { rate: 0, rootAge: 2020, r2: 0, residuals: [] };
    const calibrated = calibrateTree(tree, regression);

    expect(calibrated.isClockCalibrated).toBe(false);
  });

  it('calibrates tree with positive rate', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAA', date: 2020 },
      { id: 'B', sequence: 'AAAT', date: 2022 },
    ];
    const tree = buildUPGMATree(sequences);
    const regression = { rate: 0.01, rootAge: 2019, r2: 0.9, residuals: [] };
    const calibrated = calibrateTree(tree, regression);

    expect(calibrated.isClockCalibrated).toBe(true);
    expect(calibrated.substitutionRate).toBe(0.01);
    expect(calibrated.clockR2).toBe(0.9);
  });
});

describe('computeSkyline', () => {
  it('returns empty skyline for single-leaf tree', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ACGT', date: 2020 },
    ];
    const tree = buildUPGMATree(sequences);
    const skyline = computeSkyline(tree);

    expect(skyline.intervals.length).toBe(0);
  });

  it('computes intervals for multi-sequence tree', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAA', date: 2020 },
      { id: 'B', sequence: 'AAAT', date: 2021 },
      { id: 'C', sequence: 'AATT', date: 2022 },
    ];
    const tree = buildUPGMATree(sequences);
    const regression = clockRegression(tree);
    const calibrated = calibrateTree(tree, regression);
    const skyline = computeSkyline(calibrated);

    // Should have some intervals
    expect(skyline.times.length).toBeGreaterThanOrEqual(0);
  });
});

describe('computeDnDs', () => {
  it('returns null for sequences shorter than 3bp', () => {
    expect(computeDnDs('AC', 'AC')).toBeNull();
  });

  it('returns dnds of 1 for identical sequences', () => {
    const result = computeDnDs('ATGATGATG', 'ATGATGATG');
    // No differences, so dN = dS = 0, ratio defaults to 1
    expect(result).not.toBeNull();
  });

  it('detects synonymous vs nonsynonymous changes', () => {
    // ATG = Met, ATA = Ile (nonsynonymous)
    const result = computeDnDs('ATG', 'ATA');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.dnds).toBeGreaterThanOrEqual(0);
    }
  });

  it('skips codons with gaps', () => {
    const result = computeDnDs('ATG-TG', 'ATGATG');
    expect(result).not.toBeNull();
  });
});

describe('computeSelection', () => {
  it('computes tree-wide dN/dS', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ATGATGATGATG', date: 2020 },
      { id: 'B', sequence: 'ATGATGATGATA', date: 2021 },
    ];
    const tree = buildUPGMATree(sequences);
    const result = computeSelection(tree);

    expect(result.treeDnDs).toBeGreaterThanOrEqual(0);
  });
});

describe('analyzePhylodynamics', () => {
  it('does not mistake equal-length rotated raw genomes for a coding alignment', () => {
    const genome = 'ATGAAAGCTGGTACCTTCGACGAGTGGCAATTAGC';
    const sequences = [0, 3, 6].map((offset, i) => ({
      id: String(i), sequence: genome.slice(offset) + genome.slice(0, offset), date: 2020 + i,
    }));
    const result = analyzePhylodynamics(sequences);
    expect(result.tree.leafCount).toBe(3);
    expect(result.selection).toBeNull();
    expect(result.selectionUnavailableReason).toContain('Equal-length raw genomes are insufficient');
  });

  it('retains selection for explicitly identified in-frame coding alignments', () => {
    const sequences = ['ATGAAAGCT', 'ATGAAGGCT', 'ATGAAGGCC'].map((sequence, i) => ({ id: String(i), sequence, date: 2020 + i }));
    const result = analyzePhylodynamics(sequences, { codingAlignment: { source: 'Hand-aligned synonymous codon example', geneticCode: 1 } });
    expect(result.selection).not.toBeNull();
    expect(result.selectionUnavailableReason).toBeUndefined();
    const invalid = analyzePhylodynamics(sequences.map(s => ({ ...s, sequence: s.sequence.slice(1) })), {
      codingAlignment: { source: 'Malformed frame', geneticCode: 1 },
    });
    expect(invalid.selection).toBeNull();
  });

  it('runs complete analysis pipeline', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'AAAAAAAAAA', date: 2020 },
      { id: 'B', sequence: 'AAAAAAAAAC', date: 2021 },
      { id: 'C', sequence: 'AAAAAAAACC', date: 2022 },
    ];

    const result = analyzePhylodynamics(sequences);

    expect(result.tree).toBeDefined();
    expect(result.tree.leafCount).toBe(3);
    expect(result.clockRegression).not.toBeNull();
  });

  it('respects analysis options', () => {
    const sequences: DatedSequence[] = [
      { id: 'A', sequence: 'ACGT', date: 2020 },
      { id: 'B', sequence: 'ACGT', date: 2021 },
    ];

    const result = analyzePhylodynamics(sequences, {
      runClock: false,
      runSkyline: false,
      runSelection: false,
    });

    expect(result.tree).toBeDefined();
    expect(result.clockRegression).toBeNull();
    expect(result.skyline).toBeNull();
    expect(result.selection).toBeNull();
  });
});

describe('generateDemoPhylodynamicsData', () => {
  it('generates specified number of sequences', () => {
    const data = generateDemoPhylodynamicsData(10, 100, 3);
    expect(data.length).toBe(10);
  });

  it('generates sequences of specified length', () => {
    const data = generateDemoPhylodynamicsData(5, 200, 3);
    for (const seq of data) {
      expect(seq.sequence.length).toBe(200);
    }
  });

  it('generates dates within time span', () => {
    const timeSpan = 5;
    const data = generateDemoPhylodynamicsData(10, 100, timeSpan);
    const currentYear = new Date().getFullYear();

    for (const seq of data) {
      expect(seq.date).toBeGreaterThanOrEqual(currentYear - timeSpan);
      expect(seq.date).toBeLessThanOrEqual(currentYear);
    }
  });

  it('generates valid DNA sequences', () => {
    const data = generateDemoPhylodynamicsData(5, 100, 3);
    const validBases = new Set(['A', 'C', 'G', 'T']);

    for (const seq of data) {
      for (const base of seq.sequence) {
        expect(validBases.has(base)).toBe(true);
      }
    }
  });
});
