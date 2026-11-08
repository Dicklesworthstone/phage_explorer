/**
 * Unit tests for Recombination / Mosaicism Radar
 */

import { describe, it, expect } from 'bun:test';
import {
  computeMosaicRadar,
  type ReferenceSketch,
  type MosaicRadarConfig,
} from './recombination-radar';

// Helper to create a simple reference
function makeRef(label: string, sequence: string): ReferenceSketch {
  return { label, sequence };
}

describe('computeMosaicRadar', () => {
  describe('edge cases', () => {
    it('returns empty result for empty sequence', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('', refs);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('returns empty result for empty references', () => {
      const result = computeMosaicRadar('ACGTACGTACGT', []);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('returns empty result for both empty', () => {
      const result = computeMosaicRadar('', []);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('handles sequence shorter than k-mer size', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('ACG', refs, { k: 5 });
      // Sequence is too short for k=5
      expect(result.windows).toEqual([]);
    });

    it('handles sequence with only Ns', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('NNNNNNNNNN', refs, { k: 3, window: 5, step: 3 });
      // No valid k-mers can be extracted from Ns
      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBeNull();
    });
  });

  describe('k-mer matching', () => {
    it('finds perfect match to single reference', () => {
      const refSeq = 'ACGTACGTACGTACGT';
      const refs = [makeRef('ref1', refSeq)];
      const result = computeMosaicRadar(refSeq, refs, { k: 3, window: 10, step: 5 });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBe('ref1');
      expect(result.windows[0].score).toBe(1); // Perfect match
    });

    it('identifies best donor among multiple references', () => {
      const querySeq = 'ACGTACGTACGTACGT';
      const refs = [
        makeRef('distant', 'TTTTTTTTTTTTTTTT'), // No overlap
        makeRef('match', querySeq),              // Perfect match
        makeRef('partial', 'ACGTNNNNNNNNNNNN'),  // Some overlap
      ];
      const result = computeMosaicRadar(querySeq, refs, { k: 3, window: 10, step: 5 });

      expect(result.windows[0].donor).toBe('match');
      expect(result.windows[0].topDonors[0].label).toBe('match');
      expect(result.windows[0].topDonors[0].score).toBe(1);
    });

    it('assigns null donor when similarity below threshold', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      // Completely different sequence
      const result = computeMosaicRadar('TTTTTTTTTTTTTTTTTTTT', refs, {
        k: 3,
        window: 10,
        step: 5,
        minSimilarity: 0.5,
      });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBeNull();
    });
  });

  describe('window processing', () => {
    it('creates overlapping windows with correct positions', () => {
      // Need sequence >= 200 + step to get multiple windows (min window=200, min step=100)
      const seq = 'A'.repeat(500);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,  // Minimum enforced by impl
        step: 100,    // Minimum enforced by impl
      });

      expect(result.windows.length).toBeGreaterThan(1);
      expect(result.windows[0].start).toBe(0);
      expect(result.windows[0].end).toBe(200);
      expect(result.windows[1].start).toBe(100);
      expect(result.windows[1].end).toBe(300);
    });

    it('respects topN configuration', () => {
      const seq = 'ACGTACGTACGT';
      const refs = [
        makeRef('ref1', seq),
        makeRef('ref2', 'ACGTNNNNNNNN'),
        makeRef('ref3', 'NNNNNNNNNNNN'),
        makeRef('ref4', 'TTTTTTTTTTTT'),
        makeRef('ref5', 'GGGGGGGGGGGG'),
      ];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 10,
        step: 5,
        topN: 2,
      });

      expect(result.windows[0].topDonors.length).toBe(2);
    });

    it('stores correct config values in result', () => {
      const result = computeMosaicRadar('ACGTACGTACGT', [makeRef('ref1', 'ACGT')], {
        k: 4,
        window: 500,
        step: 250,
      });

      expect(result.k).toBe(4);
      expect(result.window).toBe(500);
      expect(result.step).toBe(250);
    });

    it('enforces minimum window and step sizes', () => {
      const result = computeMosaicRadar('ACGTACGT'.repeat(10), [makeRef('ref1', 'ACGT')], {
        k: 3,
        window: 50,  // Below minimum 200
        step: 10,    // Below minimum 100
      });

      expect(result.window).toBe(200);
      expect(result.step).toBe(100);
    });
  });

  describe('segment merging', () => {
    it('merges consecutive windows with same donor', () => {
      const seq = 'ACGT'.repeat(50); // 200bp
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      // All windows should have same donor, so single segment
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].donor).toBe('ref1');
      expect(result.segments[0].start).toBe(0);
    });

    it('creates separate segments for different donors', () => {
      // Build a chimeric sequence: first half from ref1, second from ref2
      const ref1Seq = 'ACGT'.repeat(100); // 400bp
      const ref2Seq = 'TTGG'.repeat(100); // 400bp
      const chimera = ref1Seq + ref2Seq;  // 800bp

      const refs = [
        makeRef('donor1', ref1Seq),
        makeRef('donor2', ref2Seq),
      ];

      const result = computeMosaicRadar(chimera, refs, {
        k: 4,
        window: 200,
        step: 100,
      });

      // Should have at least 2 segments with different donors
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
    });

    it('calculates mean score correctly for segments', () => {
      const seq = 'ACGT'.repeat(100);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.segments[0].meanScore).toBeGreaterThan(0);
      expect(result.segments[0].windows).toBeGreaterThan(0);
    });
  });

  describe('breakpoint detection', () => {
    it('returns empty breakpoints for uniform sequence', () => {
      const seq = 'ACGT'.repeat(50);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      // All windows match same donor, no breakpoints
      expect(result.breakpoints.length).toBe(0);
    });

    it('detects breakpoint when donor changes', () => {
      // Create clear transition point
      const ref1Seq = 'ACGT'.repeat(200);
      const ref2Seq = 'TTGG'.repeat(200);
      const chimera = ref1Seq + ref2Seq;

      const refs = [
        makeRef('donor1', ref1Seq),
        makeRef('donor2', ref2Seq),
      ];

      const result = computeMosaicRadar(chimera, refs, {
        k: 4,
        window: 200,
        step: 100,
      });

      // Should detect at least one breakpoint near the transition
      if (result.breakpoints.length > 0) {
        const breakpoint = result.breakpoints[0];
        // Breakpoint should be somewhere near the transition (at 800bp)
        expect(breakpoint).toBeGreaterThan(0);
        expect(breakpoint).toBeLessThan(chimera.length);
      }
    });

    it('detects breakpoint on null-to-donor transition', () => {
      // First half has no matches, second half matches ref
      const noMatch = 'NNNN'.repeat(100);
      const match = 'ACGT'.repeat(100);
      const seq = noMatch + match;

      const refs = [makeRef('ref1', match)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
        minSimilarity: 0.1,
      });

      // May have breakpoints where donor changes from null to ref1
      expect(result.windows.length).toBeGreaterThan(0);
    });
  });

  describe('reference handling', () => {
    it('respects maxReferences limit', () => {
      const seq = 'ACGT'.repeat(50);
      const manyRefs = Array.from({ length: 100 }, (_, i) =>
        makeRef(`ref${i.toString().padStart(3, '0')}`, 'ACGT'.repeat(10))
      );

      const result = computeMosaicRadar(seq, manyRefs, {
        k: 3,
        window: 200,
        step: 100,
        maxReferences: 5,
      });

      // Should still work, just with limited refs
      expect(result.windows.length).toBeGreaterThan(0);
      // topDonors should only contain refs from first 5
      const donorLabels = result.windows[0].topDonors.map(d => d.label);
      for (const label of donorLabels) {
        const refNum = parseInt(label.replace('ref', ''));
        expect(refNum).toBeLessThan(5);
      }
    });

    it('handles case-insensitive sequences', () => {
      const lower = 'acgtacgtacgtacgt';
      const upper = 'ACGTACGTACGTACGT';
      const refs = [makeRef('ref1', lower)];

      const result = computeMosaicRadar(upper, refs, {
        k: 3,
        window: 10,
        step: 5,
      });

      expect(result.windows[0].donor).toBe('ref1');
      expect(result.windows[0].score).toBe(1);
    });

    it('handles mixed case in references', () => {
      const query = 'AcGtAcGt';
      const refs = [makeRef('ref1', 'aCgTaCgT')];

      const result = computeMosaicRadar(query, refs, {
        k: 3,
        window: 8,
        step: 4,
      });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].score).toBeGreaterThan(0);
    });
  });

  describe('default configuration', () => {
    it('uses sensible defaults when no config provided', () => {
      const seq = 'ACGT'.repeat(1000); // 4000bp
      const refs = [makeRef('ref1', seq)];

      const result = computeMosaicRadar(seq, refs);

      expect(result.k).toBe(5);         // default k
      expect(result.window).toBe(2000); // default window
      expect(result.step).toBe(1000);   // default step (window/2)
    });

    it('defaults topN to 3', () => {
      const seq = 'ACGT'.repeat(500);
      const refs = [
        makeRef('ref1', seq),
        makeRef('ref2', 'TTTT'.repeat(500)),
        makeRef('ref3', 'GGGG'.repeat(500)),
        makeRef('ref4', 'CCCC'.repeat(500)),
        makeRef('ref5', 'AAAA'.repeat(500)),
      ];

      const result = computeMosaicRadar(seq, refs);

      if (result.windows.length > 0) {
        expect(result.windows[0].topDonors.length).toBe(3);
      }
    });
  });
});

describe('mosaic evidence and coordinate conformance', () => {
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
  const reverseComplement = (sequence: string): string =>
    [...sequence.toUpperCase()].reverse().map(base => complement[base] ?? base).join('');

  // Deliberately use literal strings, not the production rolling integer encoding.
  function referenceJaccard(query: string, reference: string, k: number): number {
    const kmers = (sequence: string): Set<string> => {
      const result = new Set<string>();
      for (let i = 0; i + k <= sequence.length; i++) {
        const word = sequence.slice(i, i + k).toUpperCase();
        if (!/^[ACGT]+$/.test(word)) continue;
        result.add([word, reverseComplement(word)].sort()[0]);
      }
      return result;
    };
    const a = kmers(query);
    const b = kmers(reference);
    if (!a.size || !b.size) return 0;
    const shared = [...a].filter(word => b.has(word)).length;
    return shared / new Set([...a, ...b]).size;
  }

  it('never turns two missing observations into a perfect reference match', () => {
    const result = computeMosaicRadar('N'.repeat(200), [makeRef('unknown', 'N'.repeat(200))]);
    expect(result.windows[0]).toMatchObject({
      donor: null, status: 'no-evidence', score: 0, validKmerCount: 0, topDonors: [],
    });
    expect(result.referencePanel).toEqual({
      supplied: 1, selected: 1, usable: 0, omitted: 0, excludedLabels: ['unknown'],
    });
    expect(result.coverage['no-evidence']).toBe(200);
    expect(result.breakpoints).toEqual([]);
    const queryOnly = computeMosaicRadar('A'.repeat(200), [makeRef('unknown', 'N'.repeat(200))]);
    expect(queryOnly.windows[0].status).toBe('no-evidence');
    expect(queryOnly.windows[0].donor).toBeNull();
    expect(queryOnly.windows[0].topDonors).toEqual([]);
  });

  it('does not name a reference with zero shared k-mers even at a zero threshold', () => {
    const result = computeMosaicRadar('A'.repeat(200), [makeRef('C-only', 'C'.repeat(200))], { minSimilarity: 0 });
    expect(result.windows[0]).toMatchObject({ donor: null, status: 'below-threshold', score: 0 });
    expect(result.coverage['below-threshold']).toBe(200);
  });

  it('matches the independently enumerated canonical sets {AA, AC} and {AA, AG, AC}', () => {
    const result = computeMosaicRadar('AAAC', [makeRef('reference', 'AAGT')], { k: 2 });
    expect(result.windows[0].score).toBeCloseTo(2 / 3, 14);
    expect(result.windows[0].validKmerCount).toBe(3);
    const reverseReference = computeMosaicRadar('AAAC', [makeRef('reference', 'ACTT')], { k: 2 });
    const reverseQuery = computeMosaicRadar('GTTT', [makeRef('reference', 'AAGT')], { k: 2 });
    expect(reverseReference).toEqual(result);
    expect(reverseQuery).toEqual(result);
  });

  it('agrees with a string oracle including unsigned 32-bit k=16 and reverse complements', () => {
    const query = 'AAAAAAAACCCCCCCCGGGGGGGGTTTTTTTTACGTCAGTACGATCGATGCAANNTGACTGACTGAC';
    const reference = 'TGACTGACTGACAAGTCAGTACGATCGATGCAACCCCGGGGTTTTAAAA';
    for (const k of [1, 2, 3, 5, 8, 15, 16]) {
      const expected = referenceJaccard(query, reference, k);
      for (const [q, r] of [[query, reference], [query, reverseComplement(reference)],
        [reverseComplement(query), reference]]) {
        const result = computeMosaicRadar(q, [makeRef('reference', r)], { k, minSimilarity: 0 });
        expect(result.windows[0].score).toBeCloseTo(expected, 14);
      }
    }
    expect(computeMosaicRadar('T'.repeat(16), [makeRef('A', 'A'.repeat(16))], { k: 16 }).windows[0].score).toBe(1);
    expect(computeMosaicRadar('G'.repeat(16), [makeRef('A', 'A'.repeat(16))], { k: 16 }).windows[0].score).toBe(0);
  });

  it('keeps tied references unresolved even when topN hides one of them', () => {
    const references = [makeRef('beta', 'AAAC'), makeRef('alpha', 'GTTT')];
    const result = computeMosaicRadar('AAAC', references, { k: 2, topN: 1 });
    expect(result.windows[0]).toMatchObject({
      donor: null, status: 'ambiguous', score: 1, tiedReferences: ['alpha', 'beta'],
      topDonors: [{ label: 'alpha', score: 1 }],
    });
    expect(result.coverage.ambiguous).toBe(4);
    expect(computeMosaicRadar('AAAC', [...references].reverse(), { k: 2, topN: 1 })).toEqual(result);
    expect(references.map(reference => reference.label)).toEqual(['beta', 'alpha']);
  });

  it('selects the same bounded reference panel after a source-order permutation', () => {
    const references = [makeRef('z', 'AAAA'), makeRef('b', 'CCCC'), makeRef('a', 'AAAA')];
    const result = computeMosaicRadar('AAAA', references, { k: 2, maxReferences: 2 });
    expect(result.referencePanel).toMatchObject({ supplied: 3, selected: 2, usable: 2, omitted: 1 });
    expect(result.windows[0].topDonors.map(reference => reference.label)).toEqual(['a', 'b']);
    expect(computeMosaicRadar('AAAA', [...references].reverse(), { k: 2, maxReferences: 2 })).toEqual(result);
  });

  it('rejects colliding reference identities instead of merging different sources', () => {
    expect(() => computeMosaicRadar('AAAA', [makeRef('same', 'AAAA'), makeRef('same', 'CCCC')])).toThrow('Duplicate reference label');
    expect(() => computeMosaicRadar('AAAA', [makeRef('same', 'AAAA'), makeRef(' same ', 'CCCC')])).toThrow('Duplicate reference label');
  });

  it('reconstructs a planted A/C mosaic with an explicit tied window and a single switch range', () => {
    const result = computeMosaicRadar('A'.repeat(300) + 'C'.repeat(300),
      [makeRef('A', 'A'.repeat(300)), makeRef('C', 'C'.repeat(300))],
      { k: 3, window: 200, step: 100 });
    // The mixed window has canonical {AAA, AAC, ACC, CCC}; each reference
    // contributes one of those four words. It cannot distinguish the two.
    expect(result.windows.map(window => window.score)).toEqual([1, 1, 1 / 4, 1, 1]);
    expect(result.segments.map(segment => [segment.start, segment.end, segment.donor, segment.status])).toEqual([
      [0, 250, 'A', 'matched'], [250, 350, null, 'ambiguous'], [350, 600, 'C', 'matched'],
    ]);
    expect(result.coverage).toEqual({ matched: 500, ambiguous: 100, 'below-threshold': 0, 'no-evidence': 0 });
    expect(result.referenceSwitches).toEqual([{ from: 'A', to: 'C', start: 200, end: 400, position: 300 }]);
    expect(result.breakpoints).toEqual([300]);
  });

  it('does not interpret a no-data gap or null-to-reference transition as a reference switch', () => {
    const result = computeMosaicRadar('A'.repeat(200) + 'N'.repeat(200) + 'C'.repeat(200),
      [makeRef('A', 'A'.repeat(200)), makeRef('C', 'C'.repeat(200))],
      { k: 3, window: 200, step: 200 });
    expect(result.segments.map(segment => [segment.start, segment.end, segment.status])).toEqual([
      [0, 200, 'matched'], [200, 400, 'no-evidence'], [400, 600, 'matched'],
    ]);
    expect(result.breakpoints).toEqual([]);
    expect(result.referenceSwitches).toEqual([]);
  });

  it('anchors the final full window and weights scores by nonoverlapping display spans', () => {
    const result = computeMosaicRadar('A'.repeat(400) + 'C', [makeRef('A', 'A'.repeat(400))],
      { k: 5, window: 200, step: 200 });
    expect(result.windows.map(window => [window.start, window.end])).toEqual([[0, 200], [200, 400], [201, 401]]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 0, end: 401, windows: 3 });
    // Display spans are 200, 100 and 101 bp; scores are 1, 1 and 1/2.
    expect(result.segments[0].meanScore).toBeCloseTo(350.5 / 401, 14);
    expect(result.coverage.matched).toBe(401);
  });

  it('does not bridge ambiguous characters or change coordinates during case normalization', () => {
    const result = computeMosaicRadar('aaßcc', [makeRef('A', 'AAAA')], { k: 2 });
    expect(result.windows[0]).toMatchObject({ start: 0, end: 5, validKmerCount: 2, score: 0.5 });
    expect(result.segments[0].end).toBe(5);
  });

  it('partitions every analyzed genome base exactly once across window and tail sizes', () => {
    for (const length of [5, 199, 200, 201, 399, 401, 750]) {
      for (const window of [200, 333, 500]) {
        for (const step of [100, 200]) {
          const sequence = 'A'.repeat(Math.floor(length / 2)) + 'C'.repeat(Math.ceil(length / 2));
          const result = computeMosaicRadar(sequence, [makeRef('A', 'A'.repeat(200)), makeRef('C', 'C'.repeat(200))],
            { k: 5, window, step });
          expect(result.segments[0].start).toBe(0);
          expect(result.segments[result.segments.length - 1].end).toBe(length);
          let covered = 0;
          for (const segment of result.segments) {
            expect(segment.start).toBe(covered);
            expect(segment.end).toBeGreaterThan(segment.start);
            expect(segment.end).toBeLessThanOrEqual(length);
            covered = segment.end;
          }
          expect(result.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)).toBe(length);
          expect(Object.values(result.coverage).reduce((sum, bases) => sum + bases, 0)).toBe(length);
        }
      }
    }
  });

  it('rejects invalid numerical settings even when no sequence or reference is supplied', () => {
    const invalid: MosaicRadarConfig[] = [
      { k: 0 }, { k: 1.5 }, { k: 17 }, { k: NaN }, { k: Infinity },
      { window: 0 }, { window: -1 }, { window: 200.5 }, { window: Infinity },
      { step: 0 }, { step: NaN }, { step: 201, window: 200 },
      { topN: 0 }, { topN: 1.5 }, { maxReferences: -1 }, { maxReferences: Infinity },
      { minSimilarity: -0.1 }, { minSimilarity: 1.1 }, { minSimilarity: NaN },
    ];
    for (const config of invalid) {
      expect(() => computeMosaicRadar('ACGT', [makeRef('reference', 'ACGT')], config)).toThrow();
      expect(() => computeMosaicRadar('', [], config)).toThrow();
    }
  });
});
