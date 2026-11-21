import { describe, test, expect } from 'bun:test';
import { analyzeStructuralVariants, structuralVariantsFromDiff } from './structural-variants';
import { computeSequenceDiff } from './sequence-diff';
import type { GeneInfo } from '@phage-explorer/core';
import type { StructuralVariantReport } from './types';

let geneId = 0;
const gene = (name: string, startPos: number, endPos: number): GeneInfo => ({
  id: ++geneId, name, product: name, locusTag: name, startPos, endPos, strand: '+', type: 'CDS',
});
function complete(report: StructuralVariantReport) {
  expect(report.status).toBe('complete');
  if (report.status !== 'complete') throw new Error(report.reason);
  return report;
}
const reference = 'CCGG';
const inserted = 'A'.repeat(60);
const query = 'CC' + inserted + 'GG';

describe('sequence-backed aligned indels', () => {
  test('finds an exact insertion without gene annotations, with original-axis coordinates and alleles', () => {
    const result = complete(analyzeStructuralVariants(reference, query));
    expect(result.calls).toHaveLength(1);
    expect(result.counts).toEqual({ insertion: 1, deletion: 0 });
    expect(result.calls[0]).toMatchObject({ type: 'insertion', startA: 2, endA: 2, startB: 2, endB: 62,
      sizeA: 0, sizeB: 60, referenceAllele: '', alternateAllele: inserted,
      affectedGenesA: [], affectedGenesB: [] });
    expect(result.alignment).toMatchObject({ distance: 60, insertions: 60, deletions: 0, substitutions: 0,
      matches: 4, lengthA: 4, lengthB: 64 });
    expect(result.calls[0]).not.toHaveProperty('confidence');
    expect(result.counts).not.toHaveProperty('inversion');
    expect(result.limitations.join(' ')).toContain('Inversions, duplications and translocations are not inferred');
  });

  test('reversing the inputs turns the same exact inserted allele into a deletion', () => {
    const result = complete(analyzeStructuralVariants(query.toLowerCase(), reference.toLowerCase()));
    expect(result.calls).toHaveLength(1);
    expect(result.counts).toEqual({ insertion: 0, deletion: 1 });
    expect(result.calls[0]).toMatchObject({ type: 'deletion', startA: 2, endA: 62, startB: 2, endB: 2,
      sizeA: 60, sizeB: 0, referenceAllele: inserted, alternateAllele: '' });
    expect(result.alignment.distance).toBe(60);
  });

  test('never infers deleted sequence from differing annotations on identical bases', () => {
    // The previous annotation-only detector calls a deletion across these two
    // matching blocks, despite receiving exactly the same genome twice.
    const genesA = [gene('alpha', 0, 10), gene('beta', 10, 20),
      gene('unmatched-1', 30, 40), gene('unmatched-2', 50, 60), gene('unmatched-3', 70, 80),
      gene('gamma', 1000, 1010), gene('delta', 1010, 1020)];
    const genesB = [gene('alpha', 0, 10), gene('beta', 10, 20), gene('gamma', 100, 110), gene('delta', 110, 120)];
    const bases = 'ACGT'.repeat(300);
    const result = complete(analyzeStructuralVariants(bases, bases, genesA, genesB));
    expect(result.calls).toEqual([]);
    expect(result.counts).toEqual({ deletion: 0, insertion: 0 });
    expect(result.alignment.distance).toBe(0);
  });

  test('annotation name/order changes cannot create inversions or alter the actual alleles', () => {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const genesA = names.map((name, i) => gene(name, i, i + 1));
    const genesB = [...names].reverse().map((name, i) => gene(name, i, i + 1));
    const identical = complete(analyzeStructuralVariants(reference, reference, genesA, genesB));
    expect(identical.calls).toEqual([]);
    const changed = complete(analyzeStructuralVariants(reference, query, genesA, genesB));
    expect(changed.calls.map(({ type, startA, endA, startB, endB, referenceAllele, alternateAllele }) =>
      ({ type, startA, endA, startB, endB, referenceAllele, alternateAllele })))
      .toEqual([{ type: 'insertion', startA: 2, endA: 2, startB: 2, endB: 62, referenceAllele: '', alternateAllele: inserted }]);
  });

  test('reports only genuine half-open annotation overlaps, including interior insertion sites', () => {
    const genesA = [gene('covers-site', 0, 4), gene('ends-at-site', 0, 2), gene('starts-at-site', 2, 4),
      gene('invalid-negative', -1, 3), gene('outside-genome', 1, 10)];
    const genesB = [gene('inside-allele', 5, 10), gene('ends-at-allele', 0, 2), gene('starts-after-allele', 62, 64)];
    const result = complete(analyzeStructuralVariants(reference, query, genesA, genesB));
    expect(result.calls[0].affectedGenesA).toEqual(['covers-site']);
    expect(result.calls[0].affectedGenesB).toEqual(['inside-allele']);
    expect(genesA.map(item => item.name)).toEqual(['covers-site', 'ends-at-site', 'starts-at-site', 'invalid-negative', 'outside-genome']);
  });

  test('preserves terminal interbase coordinates rather than inventing a covered reference base', () => {
    const leading = complete(analyzeStructuralVariants('GG', inserted + 'GG'));
    expect(leading.calls[0]).toMatchObject({ startA: 0, endA: 0, startB: 0, endB: 60 });
    const trailing = complete(analyzeStructuralVariants('CC', 'CC' + inserted));
    expect(trailing.calls[0]).toMatchObject({ startA: 2, endA: 2, startB: 2, endB: 62 });
  });

  test('applies the explicit 50-base default threshold inclusively and counts omitted runs', () => {
    for (const length of [49, 50, 51]) {
      const result = complete(analyzeStructuralVariants(reference, 'CC' + 'A'.repeat(length) + 'GG'));
      expect(result.minGapBp).toBe(50);
      expect(result.calls).toHaveLength(length < 50 ? 0 : 1);
      expect(result.belowThreshold).toBe(length < 50 ? 1 : 0);
    }
    const largerThreshold = complete(analyzeStructuralVariants(reference, query, [], [], { minGapBp: 61 }));
    expect(largerThreshold.calls).toEqual([]);
    expect(largerThreshold.belowThreshold).toBe(1);
  });

  test('excludes unresolved alleles without converting them to resolved nucleotide events', () => {
    const result = complete(analyzeStructuralVariants(reference, 'CC' + 'N'.repeat(60) + 'GG'));
    expect(result.calls).toEqual([]);
    expect(result.unresolved).toBe(1);
    expect(result.belowThreshold).toBe(0);
    expect(result.alignment.ambiguousColumns).toBe(60);
    expect(result.alignment.insertions).toBe(60);
  });

  test('no sequence, all ambiguity or unsupported symbols produce unavailable, not zero-variant success', () => {
    for (const [a, b] of [['', ''], ['', query], [reference, ''], ['N'.repeat(30), 'N'.repeat(90)],
      ['NNNN', query], ['ACUT', query], ['ACßT', query]]) {
      const result = analyzeStructuralVariants(a, b);
      expect(result.status).toBe('unavailable');
      expect(result.counts).toBeNull();
      expect(result.alignment).toBeNull();
      expect(result.calls).toEqual([]);
      expect(result.reason).toBeString();
    }
  });

  test('alignment work exhaustion remains unavailable with its actual reason and no partial counts', () => {
    for (const options of [{ maxStates: 0 }, { maxComparisons: 0 }]) {
      const result = analyzeStructuralVariants('ACGT', 'TGCA', [], [], options);
      expect(result.status).toBe('unavailable');
      expect(result.reason).toContain('budget');
      expect(result.counts).toBeNull();
      expect(result.calls).toEqual([]);
    }
  });

  test('rejects invalid thresholds and retired heuristic confidence controls', () => {
    for (const minGapBp of [0, -1, 0.5, NaN, Infinity, 250001]) {
      expect(() => analyzeStructuralVariants(reference, query, [], [], { minGapBp })).toThrow('Minimum indel size');
    }
    expect(() => analyzeStructuralVariants(reference, query, [], [], { minConfidence: 0.9 } as never))
      .toThrow('Unsupported aligned indel options');
  });

  test('the shared alignment producer gives the same indels without changing masks or runs', () => {
    const diff = computeSequenceDiff(reference, query);
    const before = structuredClone(diff);
    expect(structuralVariantsFromDiff(reference, query, diff)).toEqual(analyzeStructuralVariants(reference, query));
    expect(diff).toEqual(before);
    expect(() => structuralVariantsFromDiff('CCCCGGGG', query, diff)).toThrow('input sequence lengths');
  });

  test('each reported indel is consistent with an independent optimal-edit calculation on tiny inputs', () => {
    // Independent full-matrix DP oracle; the production code uses wavefronts.
    const distance = (a: string, b: string) => {
      const rows = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
          rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      return rows[a.length][b.length];
    };
    const inputs = ['A', 'C', 'AC', 'AA', 'CA', 'AAC', 'CCA', 'ACGT', 'CGTA', 'AGT'];
    for (const a of inputs) for (const b of inputs) {
      const result = complete(analyzeStructuralVariants(a, b, [], [], { minGapBp: 1 }));
      expect(result.alignment.distance).toBe(distance(a, b));
      expect(result.calls.reduce((sum, call) => sum + call.sizeA + call.sizeB, 0)
        + result.alignment.substitutions).toBe(distance(a, b));
      for (const call of result.calls) {
        expect(call.referenceAllele).toBe(a.slice(call.startA, call.endA));
        expect(call.alternateAllele).toBe(b.slice(call.startB, call.endB));
        expect(call.type).toBe(call.sizeA === 0 ? 'insertion' : 'deletion');
      }
    }
  });
});
