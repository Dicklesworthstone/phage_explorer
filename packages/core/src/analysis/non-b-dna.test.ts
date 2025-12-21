import { describe, expect, it } from 'bun:test';
import { analyzeNonBDNA, detectG4, detectZDNA } from './non-b-dna';

describe('Non-B DNA detection', () => {
  it('detectG4 > returns empty for sequences shorter than window size', () => {
    expect(detectG4('GGGGGG', 25, 1.5)).toEqual([]);
  });

  it('detectG4 > detects strong G-run region on + strand', () => {
    const seq = 'G'.repeat(30);
    const hits = detectG4(seq, 25, 1.5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      type: 'G4',
      start: 0,
      end: 29,
      strand: '+',
      sequence: seq,
    });
    expect(hits[0]!.score).toBeGreaterThanOrEqual(1.5);
  });

  it('detectG4 > detects strong C-run region as - strand (G-rich on complement)', () => {
    const seq = 'C'.repeat(30);
    const hits = detectG4(seq, 25, 1.5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      type: 'G4',
      start: 0,
      end: 29,
      strand: '-',
      sequence: seq,
    });
  });

  it('detectZDNA > detects alternating CG/GC high-propensity region', () => {
    const seq = 'CGCGCGCGCGCG'; // length 12, default windowSize 12 should produce a single window
    const hits = detectZDNA(seq, 12, 0.5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      type: 'Z-DNA',
      start: 0,
      end: seq.length - 1,
      strand: 'both',
      sequence: seq,
    });
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.5);
  });

  it('analyzeNonBDNA > combines and sorts by start position', () => {
    const seq = `${'G'.repeat(30)}${'A'.repeat(10)}CGCGCGCGCGCG`;
    const hits = analyzeNonBDNA(seq);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.start).toBeLessThanOrEqual(hits[1]!.start);
  });
});

