import { describe, expect, it } from 'bun:test';
import { RESTRICTION_ENZYMES, type RestrictionEnzyme } from '../data/restriction-enzymes';
import { calculateMigration, digestGenome } from './restriction-digest';

function getEnzyme(name: string): RestrictionEnzyme {
  const enzyme = RESTRICTION_ENZYMES.find((e) => e.name === name);
  if (!enzyme) {
    throw new Error(`Missing enzyme fixture: ${name}`);
  }
  return enzyme;
}

describe('Restriction digest', () => {
  it('digestGenome > returns a single fragment when no cut sites exist', () => {
    const enzyme = getEnzyme('EcoRI');
    const seq = 'acgtacgt';

    const result = digestGenome(seq, enzyme, false);
    expect(result.enzyme).toBe('EcoRI');
    expect(result.cutSites).toEqual([]);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({
      start: 0,
      end: 8,
      length: 8,
      sequence: 'ACGTACGT',
    });
  });

  it('digestGenome > linear > splits at cutOffset and reconstructs original sequence', () => {
    const enzyme = getEnzyme('EcoRI'); // GAATTC, cutOffset=1 (G^AATTC)
    const seq = 'AAAAGAATTCTTT';

    const result = digestGenome(seq, enzyme, false);
    expect(result.cutSites).toEqual([5]);
    expect(result.fragments).toHaveLength(2);

    const reconstructed = [...result.fragments]
      .sort((a, b) => a.start - b.start)
      .map((f) => f.sequence)
      .join('');
    expect(reconstructed).toBe(seq.toUpperCase());

    const lengths = result.fragments.map((f) => f.length).sort((a, b) => a - b);
    expect(lengths).toEqual([5, 8]);
  });

  it('digestGenome > circular > single cut yields one full-length rotated fragment', () => {
    const enzyme = getEnzyme('EcoRI');
    const seq = 'AAAAGAATTCTTT';

    const result = digestGenome(seq, enzyme, true);
    expect(result.cutSites).toEqual([5]);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.length).toBe(seq.length);

    const expectedRotation = seq.toUpperCase().slice(5) + seq.toUpperCase().slice(0, 5);
    expect(result.fragments[0]?.sequence).toBe(expectedRotation);
  });

  it('digestGenome > supports IUPAC ambiguity codes (AvaII: GGWCC)', () => {
    const enzyme = getEnzyme('AvaII'); // GGWCC, cutOffset=1
    const seq = 'GGACCTTTTGGTCCAAAA';

    const result = digestGenome(seq, enzyme, false);
    expect(result.cutSites).toEqual([1, 10]);
    expect(result.fragments).toHaveLength(3);

    const reconstructed = [...result.fragments]
      .sort((a, b) => a.start - b.start)
      .map((f) => f.sequence)
      .join('');
    expect(reconstructed).toBe(seq.toUpperCase());

    const lengths = result.fragments.map((f) => f.length).sort((a, b) => a - b);
    expect(lengths).toEqual([1, 8, 9]);
  });
});

describe('Gel migration model', () => {
  it('calculateMigration > clamps to maxRun for non-positive lengths', () => {
    expect(calculateMigration(0)).toBe(100);
    expect(calculateMigration(-5)).toBe(100);
    expect(calculateMigration(0, 75)).toBe(75);
  });

  it('calculateMigration > matches expected mapping for common sizes', () => {
    expect(calculateMigration(100)).toBeCloseTo(95, 1);
    expect(calculateMigration(20000)).toBeCloseTo(5, 1);
    expect(calculateMigration(1)).toBeGreaterThanOrEqual(0);
    expect(calculateMigration(1)).toBeLessThanOrEqual(100);
  });
});

