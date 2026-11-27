import { describe, expect, test } from 'bun:test';
import { analyzeStructuralConstraints, predictMutationEffect } from './structure-constraints';
import type { GeneInfo } from './types';

const makeGene = (start: number, end: number, strand: '+' | '-'): GeneInfo => ({
  id: 1,
  name: 'Major capsid',
  locusTag: 'gp23',
  startPos: start,
  endPos: end,
  strand,
  product: 'capsid protein',
  type: 'CDS',
});

describe('analyzeStructuralConstraints', () => {
  test('does not infer a full structural protein from a partial coding fragment', () => {
    const sequence = 'ATGGCTGCTGGTTAA';
    for (const qualifiers of [
      { _location: '<1..15' },
      { _location: 'complement(1..>15)' },
      { _segments: [{ start: 0, end: 15, strand: '+', partial3Prime: true }] },
      { partial: '' },
    ]) {
      const gene = { ...makeGene(0, sequence.length, '+'), qualifiers };
      expect(analyzeStructuralConstraints(sequence, [gene]).proteins).toEqual([]);
    }
  });

  test('scores structural genes on forward strand', () => {
    // Simple capsid-like ORF: ATG GCT GCT GGT TAA -> MAAG*
    const seq = 'ATGGCTGCTGGTTAA';
    const genes = [makeGene(0, seq.length, '+')];

    const report = analyzeStructuralConstraints(seq, genes);
    expect(report.proteins.length).toBe(1);
    const protein = report.proteins[0];
    expect(protein.role).toBe('capsid');
    expect(protein.residues.length).toBeGreaterThan(0);
    expect(protein.avgFragility).toBeGreaterThanOrEqual(0);
    expect(protein.avgFragility).toBeLessThanOrEqual(1);
    expect(protein.hotspots.length).toBeGreaterThan(0);
  });

  test('handles reverse strand translation', () => {
    // Reverse complement of above seq still yields valid AA sequence
    const seq = 'TTAAC CAGCAGCCAT'.replace(/\s+/g, ''); // reverse complement
    const genes = [makeGene(0, seq.length, '-')];
    const report = analyzeStructuralConstraints(seq, genes);
    expect(report.proteins.length).toBe(1);
    const protein = report.proteins[0];
    expect(protein.residues.length).toBeGreaterThan(0);
  });
});

describe('predictMutationEffect', () => {
  test('returns stable vs unstable changes', () => {
    const mild = predictMutationEffect('A', 'G', 0.1);
    const harsh = predictMutationEffect('A', 'W', 0.9);

    expect(mild.allowed).toBe(true);
    expect(harsh.allowed).toBe(false);
    expect(harsh.deltaStability).toBeGreaterThan(mild.deltaStability);
  });
});

