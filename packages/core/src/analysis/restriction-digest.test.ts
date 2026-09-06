import { describe, expect, it } from 'bun:test';
import { RESTRICTION_ENZYMES, type RestrictionEnzyme } from '../data/restriction-enzymes';
import { calculateMigration, digestGenome, findRestrictionCutSites } from './restriction-digest';

function getEnzyme(name: string): RestrictionEnzyme {
  const enzyme = RESTRICTION_ENZYMES.find((e) => e.name === name);
  if (!enzyme) {
    throw new Error(`Missing enzyme fixture: ${name}`);
  }
  return enzyme;
}

describe('Restriction digest', () => {
  it('retains overlapping NotI sites', () => {
    const result = digestGenome('GCGGCCGCGGCCGC', getEnzyme('NotI'));
    expect(result.cutSites).toEqual([2, 8]);
    expect(result.fragments.map(fragment => fragment.length)).toEqual([6, 6, 2]);
  });

  it('finds an origin-spanning EcoRI site only on circular DNA', () => {
    const sequence = 'AATTCAAAAG';
    expect(digestGenome(sequence, getEnzyme('EcoRI')).cutSites).toEqual([]);
    const circular = digestGenome(sequence, getEnzyme('EcoRI'), true);
    expect(circular.cutSites).toEqual([0]);
    expect(circular.fragments).toEqual([{ start: 0, end: 0, length: 10, sequence }]);
  });

  it('preserves circular fragment sizes under every rotation and reverse complement', () => {
    const sequence = 'GAATTCAAAGAATTCT';
    for (let shift = 0; shift < sequence.length; shift++) {
      const rotated = sequence.slice(shift) + sequence.slice(0, shift);
      const reverse = [...rotated].reverse().map(base => ({ A: 'T', T: 'A', C: 'G', G: 'C' })[base]).join('');
      for (const input of [rotated, reverse]) {
        const result = digestGenome(input, getEnzyme('EcoRI'), true);
        expect(result.fragments.map(fragment => fragment.length)).toEqual([9, 7]);
        expect(result.fragments.map(fragment => fragment.sequence.length)).toEqual([9, 7]);
        expect(result.fragments.reduce((sum, fragment) => sum + fragment.length, 0)).toBe(input.length);
      }
    }
  });

  it('does not infer definite N-site cuts from unknown bases or punctuation', () => {
    const enzyme: RestrictionEnzyme = { name: 'test-N', site: 'GNNC', cutOffset: 2, overhang: 'blunt' };
    expect(digestGenome('GATCGNNCG..C', enzyme).cutSites).toEqual([2]);
  });

  it('returns no fragments for an empty molecule', () => {
    expect(digestGenome('', getEnzyme('EcoRI')).fragments).toEqual([]);
  });

  it('combines enzymes without duplicate cuts or zero-length terminal fragments', () => {
    const result = digestGenome('GAATTCGATCGATC', [getEnzyme('EcoRI'), getEnzyme('MboI'), getEnzyme('EcoRI')]);
    expect(result.cutSites).toEqual([1, 6, 10]);
    expect(result.fragments.map(fragment => fragment.length)).toEqual([5, 4, 4, 1]);
    expect(digestGenome('GATC', getEnzyme('MboI')).fragments.map(fragment => fragment.length)).toEqual([4]);
    expect(digestGenome('AC', getEnzyme('EcoRI'), true).cutSites).toEqual([]);
  });

  it('matches an independent base-by-base oracle for every catalog enzyme and circular rotation', () => {
    const allowed: Record<string, string> = {
      A: 'A', C: 'C', G: 'G', T: 'T', W: 'AT', R: 'AG', Y: 'CT',
      S: 'CG', M: 'AC', K: 'GT', B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
    };
    for (const enzyme of RESTRICTION_ENZYMES) {
      const motif = [...enzyme.site].map(base => allowed[base][0]).join('');
      const sequence = motif + 'AT' + motif;
      for (let shift = 0; shift < sequence.length; shift++) {
        const input = sequence.slice(shift) + sequence.slice(0, shift);
        for (const circular of [false, true]) {
          const expected: number[] = [];
          for (let start = 0; start < input.length; start++) {
            if (!circular && start + motif.length > input.length) continue;
            if ([...enzyme.site].every((base, offset) => allowed[base].includes(input[(start + offset) % input.length]))) {
              expected.push(circular ? (start + enzyme.cutOffset) % input.length : start + enzyme.cutOffset);
            }
          }
          expect(findRestrictionCutSites(input.toLowerCase(), enzyme, circular)).toEqual([...new Set(expected)].sort((a, b) => a - b));
          const result = digestGenome(input, enzyme, circular);
          expect(result.fragments.reduce((sum, fragment) => sum + fragment.length, 0)).toBe(input.length);
          expect(result.fragments.every(fragment => fragment.length > 0 && fragment.sequence.length === fragment.length)).toBe(true);
        }
      }
    }
  });

  it('rejects invalid site definitions instead of looping on empty matches', () => {
    const enzyme = getEnzyme('EcoRI');
    for (const site of ['', 'G.*C']) expect(() => findRestrictionCutSites('ACGT', { ...enzyme, site })).toThrow(RangeError);
    expect(() => findRestrictionCutSites('ACGT', { ...enzyme, cutOffset: NaN })).toThrow(RangeError);
  });

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
  it('scales the same log-size ordering to terminal rows', () => {
    const lengths = [20000, 10000, 5000, 2000, 1000, 500, 200];
    const rows = lengths.map(length => Math.floor(calculateMigration(length, 19)));
    expect(rows).toEqual([0, 3, 5, 8, 10, 12, 15]);
    for (const length of lengths) {
      expect(calculateMigration(length, 19)).toBeCloseTo(calculateMigration(length) * 0.19, 10);
    }
  });

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
