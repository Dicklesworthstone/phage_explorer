import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mashDistance,
  computeAlignmentFreeDistanceMatrix,
  jukesCantor,
  type DatedSequence,
} from './phylodynamics';

/**
 * Alignment-free distance, and the fabrication it replaces.
 *
 * Phylodynamics computed its tree, molecular clock, skyline and dN/dS from
 * `generatePseudoSequence(accession)` — a hash of the accession string — while
 * displaying a green "REAL DATA" banner. The stated reason was that real
 * sequences "would need alignment which is expensive", which was true of
 * Jukes-Cantor: it requires aligned, equal-length input, and aligning 30 phage
 * genomes in a browser is not practical.
 *
 * Mash distance removes that constraint, so the real sequences can be used.
 */

describe('mashDistance', () => {
  it('is zero for identical genomes', () => {
    expect(mashDistance(1, 16)).toBe(0);
  });

  it('saturates when no k-mers are shared', () => {
    // Reported at the same ceiling Jukes-Cantor uses, so the two are
    // interchangeable within one distance matrix.
    expect(mashDistance(0, 16)).toBe(1);
    expect(mashDistance(-0.5, 16)).toBe(1);
  });

  it('decreases monotonically as similarity rises', () => {
    const distances = [0.05, 0.2, 0.5, 0.8, 0.95].map(j => mashDistance(j, 16));
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeLessThan(distances[i - 1]);
    }
  });

  it('matches the published formula', () => {
    // D = -(1/k) ln(2j / (1+j)), Ondov et al. 2016.
    const j = 0.6;
    const k = 16;
    const expected = -(1 / k) * Math.log((2 * j) / (1 + j));
    expect(mashDistance(j, k)).toBeCloseTo(expected, 10);
  });

  it('gives smaller distances at larger k for the same Jaccard', () => {
    // k appears as 1/k, so the same shared fraction implies less divergence
    // when measured with longer k-mers.
    expect(mashDistance(0.5, 21)).toBeLessThan(mashDistance(0.5, 16));
  });

  it('stays within [0,1]', () => {
    for (const j of [0, 0.001, 0.5, 0.999, 1]) {
      const d = mashDistance(j, 16);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('handles a nonsensical k without producing NaN', () => {
    expect(mashDistance(0.5, 0)).toBe(1);
  });
});

describe('computeAlignmentFreeDistanceMatrix', () => {
  const seqs: DatedSequence[] = [
    { id: 'a', date: 2020, sequence: 'AAAA' },
    { id: 'b', date: 2021, sequence: 'CCCC' },
    { id: 'c', date: 2022, sequence: 'GGGG' },
  ];

  // Stand-in similarity: a and b are close, c is distant from both.
  const similarity = (x: DatedSequence, y: DatedSequence): number => {
    if (x.id === y.id) return 1;
    const pair = [x.id, y.id].sort().join('');
    return pair === 'ab' ? 0.8 : 0.05;
  };

  it('is symmetric with a zero diagonal', () => {
    const m = computeAlignmentFreeDistanceMatrix(seqs, similarity, 16);
    for (let i = 0; i < seqs.length; i++) {
      expect(m[i][i]).toBe(0);
      for (let j = 0; j < seqs.length; j++) {
        expect(m[i][j]).toBeCloseTo(m[j][i], 12);
      }
    }
  });

  it('places the similar pair closer than the dissimilar ones', () => {
    const m = computeAlignmentFreeDistanceMatrix(seqs, similarity, 16);
    expect(m[0][1]).toBeLessThan(m[0][2]);
    expect(m[0][1]).toBeLessThan(m[1][2]);
  });

  it('needs no alignment, unlike jukesCantor', () => {
    // The constraint that forced the fabrication: Jukes-Cantor throws on
    // unequal lengths, which is the normal case for unaligned genomes.
    expect(() => jukesCantor('ACGT', 'ACGTACGT')).toThrow();

    const unaligned: DatedSequence[] = [
      { id: 'x', date: 2020, sequence: 'ACGT' },
      { id: 'y', date: 2021, sequence: 'ACGTACGTACGT' },
    ];
    expect(() =>
      computeAlignmentFreeDistanceMatrix(unaligned, () => 0.5, 16)
    ).not.toThrow();
  });

  it('handles an empty input', () => {
    expect(computeAlignmentFreeDistanceMatrix([], similarity, 16)).toEqual([]);
  });
});

describe('phylodynamics no longer synthesises its input', () => {
  const OVERLAY = readFileSync(
    join(import.meta.dir, '../../../web/src/components/overlays/PhylodynamicsOverlay.tsx'),
    'utf8'
  );

  it('reads the overlay source, so the checks below are not vacuous', () => {
    expect(OVERLAY.length).toBeGreaterThan(1000);
    expect(OVERLAY).toContain('PhylodynamicsOverlay');
  });

  it('no longer defines a pseudo-sequence generator', () => {
    expect(OVERLAY).not.toContain('function generatePseudoSequence');
  });

  it('never calls one', () => {
    // Comments are stripped: the fix documents what was removed, and that
    // prose must not trip a check that the call is gone.
    const code = OVERLAY.split('\n')
      .filter(line => {
        const t = line.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain('generatePseudoSequence(');
  });

  it('fetches real sequences on the real-data path', () => {
    expect(OVERLAY).toContain('fetchSequencesFasta');
  });

  it('the source check is discriminating', () => {
    // Guards the guard: the original call form must be detectable.
    const original = '  sequence: generatePseudoSequence(seq.accession, seq.sequenceLength, i),';
    expect(original).toContain('generatePseudoSequence(');
  });
});
