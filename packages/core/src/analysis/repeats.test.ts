import { describe, expect, it } from 'bun:test';
import {
  detectPalindromesJS,
  detectTandemRepeatsJS,
  isComplementBaseCode,
} from './repeats';

describe('repeats JS references', () => {
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
