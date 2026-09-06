import { describe, expect, it } from 'bun:test';
import {
  detectPalindromesJS,
  detectTandemRepeatsJS,
  isComplementBaseCode,
} from './repeats';

describe('repeats JS references', () => {
  it('reports real odd spacers and exact half-open coordinates', () => {
    for (const gap of [1, 3, 5]) {
      const sequence = 'ACGTA' + 'N'.repeat(gap) + 'TACGT';
      expect(detectPalindromesJS(sequence, 5, gap)).toEqual([
        { start: 0, end: sequence.length, arm_length: 5, gap, sequence },
      ]);
    }
    expect(detectPalindromesJS('ACGTATACGT', 5, 1)).toEqual([
      { start: 0, end: 10, arm_length: 5, gap: 0, sequence: 'ACGTATACGT' },
    ]);
  });

  it('does not count runs of unresolved bases as exact tandem repeats', () => {
    expect(detectTandemRepeatsJS('NNNNNNNN', 2, 4, 2)).toEqual([]);
    expect(detectTandemRepeatsJS('ACNNACNNACNN', 4, 4, 2)).toEqual([]);
  });

  it('matches exhaustive substring/strand oracles rather than another center-expansion implementation', () => {
    const complement: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
    const sequences = ['ACGTANNNTACGT', 'acgtaNtacgt', 'GCNNGC', '', 'N', 'ATATAT', 'ACGTATACGT'];
    for (let value = 0; value < 256; value++) {
      sequences.push(Array.from({ length: 4 }, (_, index) => 'ACGT'[(value >> (index * 2)) & 3]).join(''));
    }
    for (const sequence of sequences) {
      const upper = sequence.toUpperCase();
      const expected = [];
      for (let start = 0; start < sequence.length; start++) {
        for (let arm = 1; arm <= sequence.length; arm++) {
          for (let gap = 0; gap <= 3; gap++) {
            const end = start + arm * 2 + gap;
            if (end > sequence.length) continue;
            const left = upper.slice(start, start + arm);
            if (/[^ACGT]/.test(left)) continue;
            const right = upper.slice(start + arm + gap, end);
            if ([...left].reverse().map(base => complement[base]).join('') !== right) continue;
            // The kernel reports the maximal arm for each inner boundary/gap.
            if (start > 0 && end < sequence.length && complement[upper[start - 1]] === upper[end]) continue;
            expected.push({ start, end, arm_length: arm, gap, sequence: sequence.slice(start, end) });
          }
        }
      }
      expected.sort((a, b) => (a.start + a.arm_length) - (b.start + b.arm_length) || a.gap - b.gap);
      expect(detectPalindromesJS(sequence, 1, 3)).toEqual(expected);
      expect(detectPalindromesJS(sequence, 1, 3, 2)).toEqual(expected.slice(0, 2));
    }
  });

  it('bounds output at the deterministic prefix and rejects non-advancing parameters', () => {
    const sequence = 'AC'.repeat(100);
    const all = detectTandemRepeatsJS(sequence, 2, 4, 2);
    expect(all.length).toBeGreaterThan(2);
    expect(detectTandemRepeatsJS(sequence, 2, 4, 2, 2)).toEqual(all.slice(0, 2));
    expect(detectTandemRepeatsJS(sequence, 2, 4, 2, 0)).toEqual([]);
    expect(detectPalindromesJS('ACGT', 1, Number.MAX_SAFE_INTEGER)).toEqual(detectPalindromesJS('ACGT', 1, 4));
    for (const minUnit of [0, -1, 1.5, NaN]) expect(() => detectTandemRepeatsJS('ACGT', minUnit, 4, 2)).toThrow(RangeError);
    expect(() => detectTandemRepeatsJS('ACGT', 2, 1, 2)).toThrow(RangeError);
    expect(() => detectTandemRepeatsJS('ACGT', 1, 2, 1)).toThrow(RangeError);
    expect(() => detectPalindromesJS('ACGT', 0, 0)).toThrow(RangeError);
    expect(() => detectPalindromesJS('ACGT', 1, -1)).toThrow(RangeError);
    for (const input of ['AA"TT', 'AAéTT', 'A T']) {
      expect(() => detectPalindromesJS(input, 1, 3)).toThrow(RangeError);
      expect(() => detectTandemRepeatsJS(input, 1, 2, 2)).toThrow(RangeError);
    }
  });

  it('identifies complementary base codes correctly', () => {
    // A-T, T-A
    expect(isComplementBaseCode('A'.charCodeAt(0), 'T'.charCodeAt(0))).toBe(true);
    expect(isComplementBaseCode('T'.charCodeAt(0), 'A'.charCodeAt(0))).toBe(true);
    // G-C, C-G
    expect(isComplementBaseCode('G'.charCodeAt(0), 'C'.charCodeAt(0))).toBe(true);
    expect(isComplementBaseCode('C'.charCodeAt(0), 'G'.charCodeAt(0))).toBe(true);
    // A-U, U-A
    expect(isComplementBaseCode('A'.charCodeAt(0), 'U'.charCodeAt(0))).toBe(true);
    expect(isComplementBaseCode('U'.charCodeAt(0), 'A'.charCodeAt(0))).toBe(true);
    // Non-complements
    expect(isComplementBaseCode('A'.charCodeAt(0), 'A'.charCodeAt(0))).toBe(false);
    expect(isComplementBaseCode('G'.charCodeAt(0), 'T'.charCodeAt(0))).toBe(false);
    expect(isComplementBaseCode('N'.charCodeAt(0), 'N'.charCodeAt(0))).toBe(false);
  });

  it('detects palindromes with and without central gap', () => {
    // Perfect palindrome: 5-base stem: ACGTA - TACGT (reversed complement of ACGTA is TACGT)
    const perfectStem = 'ACGTATACGT';
    const hits = detectPalindromesJS(perfectStem, 5, 0);
    expect(hits.length).toBe(1);
    expect(hits[0].arm_length).toBe(5);
    expect(hits[0].gap).toBe(0);
    expect(hits[0].sequence).toBe('ACGTATACGT');

    // Palindrome with gap of 2: ACGTA - NN - TACGT
    const withGap = 'ACGTA' + 'NN' + 'TACGT';
    const hitsGap = detectPalindromesJS(withGap, 5, 2);
    expect(hitsGap.length).toBeGreaterThanOrEqual(1);
    expect(hitsGap.some((h) => h.arm_length === 5 && h.gap === 2)).toBe(true);
  });

  it('detects tandem repeats with multiple consecutive copies', () => {
    const seq = 'TTT' + 'ATCGATCGATCG' + 'TTT'; // (ATCG) x 3 bordered by T
    const hits = detectTandemRepeatsJS(seq, 4, 4, 3);
    expect(hits.length).toBe(1);
    expect(hits[0].unit).toBe('ATCG');
    expect(hits[0].copies).toBe(3);
    expect(hits[0].start).toBe(3);
    expect(hits[0].end).toBe(15);
  });
});
