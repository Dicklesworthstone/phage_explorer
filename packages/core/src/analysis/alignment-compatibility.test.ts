import { describe, expect, test } from 'bun:test';
import { createAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import {
  analyzeAlignmentCompatibility, compatibilityPairWitnesses, createCompatibilityExperiment,
  exportCompatibilityPairsTsv, exportCompatibilitySitesTsv, isIncompatiblePair,
  replayCompatibilityExperiment, validateCompatibilityInput, COMPATIBILITY_LIMITS,
  type CompatibilityInput,
} from './alignment-compatibility';

function input(rows = ['AA', 'AG', 'GA', 'GG']): CompatibilityInput {
  return { format: 'phage-explorer-alignment-compatibility', version: 1, name: 'Synthetic hand-counted alignment',
    source: { kind: 'demo', reference: 'Four explicitly constructed taxa; not experimental observations', version: 'fixture-1', license: 'CC0' },
    alignment: { fasta: rows.map((row, index) => '>t' + (index + 1) + '\n' + row).join('\n') + '\n', homologous: true,
      method: 'Hand-constructed aligned columns', reference: 'Exact two-column fixture, not independently established homology' } };
}
describe('observed aligned-site compatibility', () => {
  test('retains all four exact haplotypes, taxon witnesses and original columns', () => {
    const result = analyzeAlignmentCompatibility(input());
    expect(result.status).toBe('incompatibility-observed');
    expect(result.coverage).toEqual({ selectedColumns: 2, completeColumns: 2, eligibleColumns: 2, comparedPairs: 1, incompatiblePairs: 1 });
    expect(result.sites).toEqual([
      { column: 0, alleles: ['A', 'G'], counts: [2, 2], assignments: '0011' },
      { column: 1, alleles: ['A', 'G'], counts: [2, 2], assignments: '0101' },
    ]);
    expect(result.pairs).toEqual([[0, 1, 1, 1, 1, 1]]);
    expect(compatibilityPairWitnesses(result, result.pairs[0])).toEqual([
      { haplotype: 'AA', count: 1, taxa: ['t1'] }, { haplotype: 'AG', count: 1, taxa: ['t2'] },
      { haplotype: 'GA', count: 1, taxa: ['t3'] }, { haplotype: 'GG', count: 1, taxa: ['t4'] },
    ]);
  });
  test('three haplotypes are compatible and missing information is a distinct outcome', () => {
    const result = analyzeAlignmentCompatibility(input(['AA', 'AA', 'AG', 'AG', 'GG', 'GG']));
    expect(result.pairs).toEqual([[0, 1, 2, 2, 0, 2]]);
    expect(result.status).toBe('no-incompatibility-observed');
    expect(result.coverage.incompatiblePairs).toBe(0);
    const insufficient = analyzeAlignmentCompatibility(input(['AA', 'AA', 'AA', 'AG']));
    expect(insufficient.status).toBe('insufficient-sites');
    expect(insufficient.pairs).toEqual([]);
    expect(insufficient.excluded).toEqual({ missing: [], monomorphic: [0], multiallelic: [], singleton: [1] });
  });
  test('missing calls, multiallelic and singleton columns are explicit, never collapsed coordinates', () => {
    const fixture = input(['AAAAAA-R?', 'AAACAGAAA', 'AGNGAAGGG', 'AGGTCGGGG']);
    const result = analyzeAlignmentCompatibility(fixture);
    expect(result.sites.map(site => site.column)).toEqual([1, 5]);
    expect(result.excluded).toEqual({ missing: [2, 6, 7, 8], monomorphic: [0], multiallelic: [3], singleton: [4] });
    expect(result.coverage).toEqual({ selectedColumns: 9, completeColumns: 5, eligibleColumns: 2, comparedPairs: 1, incompatiblePairs: 1 });
    const interval = analyzeAlignmentCompatibility(fixture, { start: 1, end: 6 });
    expect(interval.sites.map(site => site.column)).toEqual([1, 5]);
    expect(interval.excluded).toEqual({ missing: [2], monomorphic: [], multiallelic: [3], singleton: [4] });
    expect(interval.coverage.selectedColumns).toBe(5);
  });
  test('every pair agrees with an independent set-of-observed-strings oracle', () => {
    const rows = ['AACATG', 'AGTACG', 'GACGTG', 'GGTGCG', 'AACGCG', 'GGTACT', 'AATGTG', 'GGCACT'];
    const result = analyzeAlignmentCompatibility(input(rows));
    expect(result.sites.length).toBeGreaterThan(2);
    expect(result.pairs.length).toBe(result.sites.length * (result.sites.length - 1) / 2);
    for (const pair of result.pairs) {
      const left = result.sites[pair[0]], right = result.sites[pair[1]];
      const observed = rows.map(row => row[left.column] + row[right.column]);
      expect(isIncompatiblePair(pair)).toBe(new Set(observed).size === 4);
      const labels = [left.alleles[0] + right.alleles[0], left.alleles[0] + right.alleles[1], left.alleles[1] + right.alleles[0], left.alleles[1] + right.alleles[1]];
      expect(pair.slice(2)).toEqual(labels.map(label => observed.filter(value => value === label).length));
      expect(pair.slice(2).reduce((sum, value) => sum + value, 0)).toBe(rows.length);
    }
  });
  test('row order preserves the numerical evidence; reverse complement preserves incompatibility', () => {
    const raw = input(['AACG', 'AGCG', 'GACT', 'GGCT']);
    const baseline = analyzeAlignmentCompatibility(raw);
    const reordered = structuredClone(raw);
    reordered.alignment.fasta = '>t4\nGGCT\n>t2\nAGCG\n>t1\nAACG\n>t3\nGACT\n';
    expect(analyzeAlignmentCompatibility(reordered)).toEqual(baseline);
    const reversed = analyzeAlignmentCompatibility(input(['CGTT', 'CGCT', 'AGTC', 'AGCC']));
    expect(reversed.coverage.incompatiblePairs).toBe(baseline.coverage.incompatiblePairs);
    expect(reversed.sites.map(site => site.column)).toEqual(baseline.sites.map(site => 3 - site.column).reverse());
  });
  test('rejects invalid declarations, strict enums and original-interval bounds', () => {
    for (const update of [
      { ...input(), unexpected: true },
      { ...input(), source: { ...input().source, kind: ['demo'] } },
      { ...input(), alignment: { ...input().alignment, homologous: 'true' } },
      { ...input(), alignment: { ...input().alignment, method: '' } },
    ]) expect(() => validateCompatibilityInput(update)).toThrow();
    for (const options of [{ start: 0, end: 0 }, { start: -1, end: 2 }, { start: 0, end: 3 }, { start: 0.5, end: 2 }, { start: 0, end: 2, policy: 'pairwise' }]) {
      expect(() => analyzeAlignmentCompatibility(input(), options)).toThrow();
    }
    expect(() => analyzeAlignmentCompatibility(input(['AA', 'AG', 'GG']))).toThrow('at least four');
    expect(() => analyzeAlignmentCompatibility(input(['AA', 'AG', 'G', 'GG']))).toThrow();
    expect(() => analyzeAlignmentCompatibility({ ...input(), alignment: { ...input().alignment, fasta: '>a\nAA\n>a\nAG\n>b\nGA\n>c\nGG' } })).toThrow();
    expect(() => analyzeAlignmentCompatibility(input(['AA', 'AG', 'GA', 'GX']))).toThrow();
  });
  test('bounds full pair work and rejects overflow instead of sampling', () => {
    const max = COMPATIBILITY_LIMITS.eligibleSites;
    const result = analyzeAlignmentCompatibility(input(['A'.repeat(max), 'A'.repeat(max), 'G'.repeat(max), 'G'.repeat(max)]));
    expect(result.pairs.length).toBe(32640);
    expect(result.coverage.incompatiblePairs).toBe(0);
    expect(() => analyzeAlignmentCompatibility(input(['A'.repeat(max + 1), 'A'.repeat(max + 1), 'G'.repeat(max + 1), 'G'.repeat(max + 1)]))).toThrow('narrower');
    expect(() => validateCompatibilityInput({ ...input(), alignment: { ...input().alignment, fasta: 'A'.repeat(COMPATIBILITY_LIMITS.inputBytes + 1) } })).toThrow('2 MiB');
  });
  test('complete JSON replays freshly, binds exact source bytes and distinguishes demo evidence', async () => {
    const raw = input(), experiment = await createCompatibilityExperiment(raw);
    const content = serializeAnalysisRecord(experiment.record);
    expect((await replayCompatibilityExperiment(content)).record).toEqual(experiment.record);
    expect(experiment.record.fields.compatibility.kind).toBe('demo');
    const local = structuredClone(raw); local.source.kind = 'local';
    const localExperiment = await createCompatibilityExperiment(local);
    expect(localExperiment.record.fields.compatibility.kind).toBe('sequence-score');
    expect(localExperiment.record.cacheKey).not.toBe(experiment.record.cacheKey);
    const changed = structuredClone(raw); changed.alignment.fasta += '\n';
    const changedExperiment = await createCompatibilityExperiment(changed);
    expect(changedExperiment.result).toEqual(experiment.result);
    expect(changedExperiment.record.cacheKey).not.toBe(experiment.record.cacheKey);
  });
  test('fresh replay rejects rehashed fabricated counts, labels, references and policies', async () => {
    const { record } = await createCompatibilityExperiment(input());
    const mutations = [
      (value: typeof record) => { (value.fields.compatibility.value as unknown as { pairs: number[][] }).pairs[0][2] = 9; },
      (value: typeof record) => { value.fields.compatibility.label = 'Validated recombination events'; },
      (value: typeof record) => { value.references[0].version = 'fabricated'; },
      (value: typeof record) => { value.parameters.policy = 'pairwise deletion'; },
      (value: typeof record) => { value.inputs[0].source = 'external'; },
    ];
    for (const mutate of mutations) {
      const edited = structuredClone(record); mutate(edited);
      const rehashed = await createAnalysisRecord(edited);
      await expect(replayCompatibilityExperiment(serializeAnalysisRecord(rehashed))).rejects.toThrow();
    }
    await expect(replayCompatibilityExperiment(' '.repeat(COMPATIBILITY_LIMITS.recordBytes + 1))).rejects.toThrow('10 MiB');
  });
  test('exports every exact pair and every selected column, including exclusions and zero haplotypes', async () => {
    const experiment = await createCompatibilityExperiment(input(['AA', 'AA', 'AG', 'AG', 'GG', 'GG']));
    expect(exportCompatibilityPairsTsv(experiment).split('\n')[3]).toBe('1\t2\tA\tG\tA\tG\t2\t2\t0\t2\tno');
    const mixed = await createCompatibilityExperiment(input(['AAAAAA-R?', 'AAACAGAAA', 'AGNGAAGGG', 'AGGTCGGGG']));
    const lines = exportCompatibilitySitesTsv(mixed).trim().split('\n');
    expect(lines.length).toBe(12);
    expect(lines[3]).toBe('1\tmonomorphic\t4\t0\t0\t0\t0');
    expect(lines[5]).toBe('3\tmissing\t2\t0\t1\t0\t1');
    expect(lines[6]).toBe('4\tmultiallelic\t1\t1\t1\t1\t0');
    expect(lines[7]).toBe('5\tsingleton\t3\t1\t0\t0\t0');
    expect(exportCompatibilityPairsTsv(mixed)).toContain('2\t6\tA\tG\tA\tG\t1\t1\t1\t1\tyes');
  });
});
