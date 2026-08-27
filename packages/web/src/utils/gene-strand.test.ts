import { describe, expect, it } from 'bun:test';
import {
  classifyGeneStrand,
  formatGeneStrand,
  summarizeGeneStrands,
} from './gene-strand';

describe('classifyGeneStrand', () => {
  it('recognizes common forward and reverse encodings', () => {
    expect(classifyGeneStrand('+')).toBe('forward');
    expect(classifyGeneStrand(' +1 ')).toBe('forward');
    expect(classifyGeneStrand('FORWARD')).toBe('forward');
    expect(classifyGeneStrand('-')).toBe('reverse');
    expect(classifyGeneStrand('-1')).toBe('reverse');
    expect(classifyGeneStrand('minus')).toBe('reverse');
  });

  it('does not silently convert missing or unfamiliar values to forward', () => {
    expect(classifyGeneStrand(null)).toBe('unknown');
    expect(classifyGeneStrand('')).toBe('unknown');
    expect(classifyGeneStrand('?')).toBe('unknown');
    expect(formatGeneStrand('sideways')).toBe('Unknown');
  });
});

describe('summarizeGeneStrands', () => {
  it('counts every gene exactly once', () => {
    const summary = summarizeGeneStrands([
      { strand: '+' },
      { strand: '-' },
      { strand: null },
      { strand: 'forward' },
      { strand: 'unexpected' },
    ]);

    expect(summary).toEqual({ forward: 2, reverse: 1, unknown: 2 });
    expect(summary.forward + summary.reverse + summary.unknown).toBe(5);
  });
});
