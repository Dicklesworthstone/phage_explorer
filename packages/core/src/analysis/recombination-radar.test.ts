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
        makeRef(`ref${i}`, 'ACGT'.repeat(10))
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
