import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from './types';
import { computePhasePortrait, mapCdsResidueRange, prepareCdsPhasePortraitInput } from './phase-portraits';

const gene = (qualifiers: GeneInfo['qualifiers'] = {}): GeneInfo => ({
  id: 1, name: 'joined', locusTag: 'cds1', startPos: 0, endPos: 14, strand: '+',
  product: null, type: 'CDS',
  qualifiers: {
    _segments: [{ start: 0, end: 3, strand: '+' }, { start: 7, end: 14, strand: '+' }],
    codon_start: '2', transl_table: '15', translation: 'MQ', ...qualifiers,
  },
});

describe('exact annotated-CDS phase portraits', () => {
  it('uses joined coding bases, codon_start and the declared recoded table', () => {
    // Raw transcript AATGTAGTAA; skip the first A. NCBI table 15: TAG = Q.
    const input = prepareCdsPhasePortraitInput('AATCCCCGTAGTAA', gene());
    expect(input.reference.cds).toBe('ATGTAGTAA');
    expect(input.reference.protein).toBe('MQ*');
    expect(input.protein).toBe('MQ');
    expect(input.reference.reasons).toEqual([]);
    const portrait = computePhasePortrait(input.protein!, 2, 1);
    expect(portrait.points).toHaveLength(1);
    expect(portrait.points[0].start).toBe(0);
    expect(portrait.points[0].end).toBe(2);
    // Independent averages for M and Q; the stop and gap contribute nothing.
    expect(portrait.points[0].hydropathy).toBeCloseTo((1.9 - 3.5) / 2, 12);
    expect(portrait.points[0].charge).toBe(0);
    expect(portrait.points[0].aromaticity).toBe(0);
    expect(portrait.points[0].flexibility).toBeCloseTo((0.40 + 0.49) / 2, 12);
    expect(portrait.points[0].disorder).toBeCloseTo((0.36 + 0.53) / 2, 12);
    expect(portrait.explained).toEqual([0, 0]);
    expect(mapCdsResidueRange(input.reference, 0, 1)).toEqual([
      { start: 1, end: 3, strand: '+' }, { start: 7, end: 8, strand: '+' },
    ]);
    expect(mapCdsResidueRange(input.reference, 1, 2)).toEqual([{ start: 8, end: 11, strand: '+' }]);
  });

  it('maps reverse transcript residues in coding order, including a split codon', () => {
    const input = prepareCdsPhasePortraitInput('TTACTACGGGGATT', {
      ...gene(), strand: '-', qualifiers: {
        ...gene().qualifiers,
        _segments: [{ start: 11, end: 14, strand: '-' }, { start: 0, end: 7, strand: '-' }],
      },
    });
    expect(input.protein).toBe('MQ');
    expect(mapCdsResidueRange(input.reference, 0, 1)).toEqual([
      { start: 11, end: 13, strand: '-' }, { start: 6, end: 7, strand: '-' },
    ]);
    expect(mapCdsResidueRange(input.reference, 1, 2)).toEqual([{ start: 3, end: 6, strand: '-' }]);
  });

  it('preserves circular-origin segment order and excludes the terminal stop from ranges', () => {
    const input = prepareCdsPhasePortraitInput('TAGTAACCCATG', {
      ...gene(), endPos: 12, qualifiers: {
        transl_table: 15, _segments: [{ start: 9, end: 12, strand: '+' }, { start: 0, end: 6, strand: '+' }],
      },
    });
    expect(input.protein).toBe('MQ');
    expect(mapCdsResidueRange(input.reference, 0, 2)).toEqual([
      { start: 9, end: 12, strand: '+' }, { start: 0, end: 3, strand: '+' },
    ]);
    for (const [start, end] of [[-1, 1], [0, 3], [1, 1], [0.5, 1], [0, Infinity]]) {
      expect(mapCdsResidueRange(input.reference, start, end)).toEqual([]);
    }
  });

  it('does not substitute envelope translations for unsupported CDS inputs', () => {
    for (const qualifiers of [
      { transl_table: 2 }, { pseudo: '' }, { transl_except: '(pos:1..3,aa:Sec)' },
      { translation: 'MK' }, { codon_start: 4 }, { transl_table: 1 },
    ]) {
      const input = prepareCdsPhasePortraitInput('AATCCCCGTAGTAA', gene(qualifiers));
      expect(input.protein).toBeNull();
      expect(input.reference.reasons.length).toBeGreaterThan(0);
      expect(mapCdsResidueRange(input.reference, 0, 1)).toEqual([]);
    }
    expect(prepareCdsPhasePortraitInput('AATCCCCGNAGTAA', gene()).protein).toBeNull();
    expect(prepareCdsPhasePortraitInput('AATCCCCGTAGTAA', { ...gene(), type: 'gene' }).protein).toBeNull();
  });

  it('requires complete residue windows and rejects unbounded or unresolved inputs', () => {
    expect(computePhasePortrait('MQ', 3, 1)).toEqual({ points: [], explained: [0, 0] });
    expect(computePhasePortrait('', 3, 1)).toEqual({ points: [], explained: [0, 0] });
    expect(computePhasePortrait('mq', 2, 1)).toEqual(computePhasePortrait('MQ', 2, 1));
    for (const [window, step] of [[0, 1], [2, 0], [-1, 1], [1, 0.5], [Infinity, 1]]) {
      expect(() => computePhasePortrait('MQ', window, step)).toThrow('positive integers');
    }
    for (const protein of ['M*', 'MX', 'M-']) {
      expect(() => computePhasePortrait(protein, 2, 1)).toThrow('supported protein sequence');
    }
  });
});
