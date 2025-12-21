import { describe, expect, it } from 'bun:test';
import { computeSequenceLogo } from './sequence-logo';

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

describe('Sequence logo', () => {
  it('computeSequenceLogo > returns empty for empty alignment', () => {
    expect(computeSequenceLogo([])).toEqual([]);
  });

  it('computeSequenceLogo (DNA) > identical sequences produce a tall single-letter stack', () => {
    const alignment = repeat('ACGT', 100);
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(4);
    for (const col of logo) {
      expect(col.totalBits).toBeGreaterThan(1.9);
      expect(col.totalBits).toBeLessThanOrEqual(2);
      expect(col.letters).toHaveLength(1);
      expect(col.letters[0]?.height).toBeCloseTo(col.totalBits, 6);
    }
  });

  it('computeSequenceLogo (DNA) > ignores gaps/ambiguous chars and still computes from valid letters', () => {
    const alignment = ['ACGT', 'ACGT', 'NNNN', '----'];
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(4);
    // Column 1 has only A from two sequences; N and - should be ignored.
    expect(logo[0]?.letters.map((l) => l.char)).toEqual(['A']);
    expect(logo[0]?.totalBits).toBeGreaterThan(1);
    // Column 4 has only T from two sequences; also ignores N/-.
    expect(logo[3]?.letters.map((l) => l.char)).toEqual(['T']);
  });

  it('computeSequenceLogo (DNA) > sorts letters ascending by height for stacking', () => {
    const alignment = [
      ...repeat('A', 75),
      ...repeat('C', 25),
    ];
    const logo = computeSequenceLogo(alignment, 'dna');

    expect(logo).toHaveLength(1);
    expect(logo[0]?.letters.map((l) => l.char)).toEqual(['C', 'A']);
    expect(logo[0]?.letters[0]?.height).toBeLessThan(logo[0]?.letters[1]?.height ?? 0);
    expect(logo[0]?.letters[0]?.height + (logo[0]?.letters[1]?.height ?? 0)).toBeCloseTo(logo[0]?.totalBits ?? 0, 6);
  });

  it('computeSequenceLogo (protein) > identical sequences approach max information', () => {
    const alignment = repeat('A', 100);
    const logo = computeSequenceLogo(alignment, 'protein');

    expect(logo).toHaveLength(1);
    expect(logo[0]?.totalBits).toBeGreaterThan(4);
    expect(logo[0]?.totalBits).toBeLessThanOrEqual(Math.log2(20));
    expect(logo[0]?.letters).toEqual([{ char: 'A', height: logo[0]?.totalBits ?? 0 }]);
  });
});

