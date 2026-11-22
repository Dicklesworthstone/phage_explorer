import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { analyzeSyntenyExperiment, exportSyntenyTsv, replaySyntenyExperiment, validateSyntenyInput,
  type SyntenyExperimentInput } from './synteny-experiment';
import { buildSyntenyHeatmap } from './synteny';

const genes = (names: string[]): GeneInfo[] => names.map((name, index) => ({ id: index + 1, name, locusTag: null,
  product: null, startPos: index * 20, endPos: index * 20 + 10, strand: '+', type: 'CDS' }));
function input(names = ['capsid', 'terminase', 'lysin']): SyntenyExperimentInput {
  return { query: { id: 1, name: 'Query', accession: 'Q.1', length: 100, source: 'local', contentId: 'local-query',
    annotationMetadata: null }, reference: { id: 2, name: 'Reference', accession: 'R.1', length: 100, source: 'catalog',
    contentId: null, annotationMetadata: { pfamVersion: 'test-reference' } }, genesQuery: genes(names), genesReference: genes(names) };
}

describe('portable annotation synteny', () => {
  it('retains every annotation, matrix cell and exact coordinate span in a replayable experiment', async () => {
    const source = input(), experiment = await analyzeSyntenyExperiment(source);
    expect(experiment.result.heatmap).toEqual({ rows: 3, cols: 3, min: 0, max: 1, values: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(experiment.result.stats).toEqual({ blockCount: 1, globalScore: 1, scsScore: 1, dtwDistance: 0,
      coverageQuery: 50, coverageReference: 50, inversionCount: 0, translocationCount: 0, indelCount: 0 });
    expect(experiment.result.blocksBp).toEqual([{ startIdxQuery: 0, endIdxQuery: 2, startIdxReference: 0, endIdxReference: 2,
      startBpQuery: 0, endBpQuery: 50, startBpReference: 0, endBpReference: 50, score: 1, orientation: 'forward' }]);
    expect(experiment.record.inputs.map(row => row.source)).toEqual(['local', 'catalog']);
    expect(experiment.record.inputs[1].data).toEqual(analysisJson({ genome: source.reference, genes: source.genesReference }));
    const replay = await replaySyntenyExperiment(serializeAnalysisRecord(experiment.record));
    expect(replay.result).toEqual(experiment.result);
    expect(replay.record.resultId).toBe(experiment.record.resultId);
    expect(replay.input).toEqual(source);
  });

  it('uses the same informative-label and domain distance for the matrix and blocks', async () => {
    const generic = input(['hypothetical protein']);
    const missing = await analyzeSyntenyExperiment(generic);
    expect(missing.result.heatmap.values).toEqual([0]);
    expect(missing.result.analysis.blocks).toEqual([]);
    expect(missing.result.stats.dtwDistance).toBe(1);
    expect(missing.result.stats.coverageQuery).toBe(0);
    generic.genesQuery[0].domains = ['PF1', 'PF2'];
    generic.genesReference[0].domains = ['PF2', 'PF3'];
    const domains = await analyzeSyntenyExperiment(generic);
    expect(domains.result.heatmap.values).toEqual([Math.fround(1 / 3)]);
    expect(domains.result.analysis.blocks[0].score).toBeCloseTo(1 / 3, 12);
    expect(domains.result.stats.dtwDistance).toBeCloseTo(2 / 3, 12);
    const locus = genes(['']);
    locus[0].locusTag = 'identical-label';
    expect([...buildSyntenyHeatmap(locus, locus).values]).toEqual([0]);
  });

  it('preserves input order and maps a reversed block to original forward coordinates', async () => {
    const source = input(['alpha', 'beta', 'gamma', 'delta']);
    source.genesReference = genes(['delta', 'gamma', 'beta', 'alpha']);
    const experiment = await analyzeSyntenyExperiment(source);
    expect(experiment.input.genesReference.map(row => row.name)).toEqual(['delta', 'gamma', 'beta', 'alpha']);
    expect(experiment.result.blocksBp).toEqual([{ startIdxQuery: 0, endIdxQuery: 3, startIdxReference: 0, endIdxReference: 3,
      startBpQuery: 0, endBpQuery: 70, startBpReference: 0, endBpReference: 70, score: 1, orientation: 'reverse' }]);
    expect(experiment.result.heatmap.values).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
  });

  it('includes a long interior annotation when determining block spans', async () => {
    const source = input();
    source.genesQuery[1].endPos = 95;
    const result = (await analyzeSyntenyExperiment(source)).result;
    expect(result.blocksBp[0].endBpQuery).toBe(95);
    expect(result.stats.coverageQuery).toBe(95);
    expect(result.stats.coverageReference).toBe(50);
  });

  it('snapshots caller-owned annotations and distinguishes reused identifiers and reference releases', async () => {
    const source = input();
    source.genesQuery[0].qualifiers = { note: ['original annotation'] };
    const running = analyzeSyntenyExperiment(source);
    source.genesQuery[0].name = 'unrelated';
    (source.genesQuery[0].qualifiers!.note as string[])[0] = 'late edit';
    const first = await running;
    expect(first.input.genesQuery[0].name).toBe('capsid');
    expect(first.input.genesQuery[0].qualifiers).toEqual({ note: ['original annotation'] });
    const changed = await analyzeSyntenyExperiment(source);
    expect(changed.record.cacheKey).not.toBe(first.record.cacheKey);
    expect(changed.result.heatmap.values[0]).toBe(0);
    const metadata = input(); metadata.reference.annotationMetadata = { pfamVersion: 'different-release' };
    expect((await analyzeSyntenyExperiment(metadata)).record.cacheKey).not.toBe((await analyzeSyntenyExperiment(input())).record.cacheKey);
  });

  it('rejects edited checksums and self-consistently forged results or method parameters', async () => {
    const experiment = await analyzeSyntenyExperiment(input());
    const damaged = structuredClone(experiment.record);
    (damaged.fields.synteny.value as unknown as { stats: { dtwDistance: number } }).stats.dtwDistance = 9;
    await expect(replaySyntenyExperiment(JSON.stringify(damaged))).rejects.toThrow('checksum');
    const { format: _format, version: _version, resultId: _resultId, cacheKey: _cacheKey, inputs, ...record } = damaged;
    const forged = await createAnalysisRecord({ ...record, inputs: inputs.map(({ sha256: _sha256, ...row }) => row) });
    await expect(replaySyntenyExperiment(serializeAnalysisRecord(forged))).rejects.toThrow('freshly recomputed');
    const parameters = await createAnalysisRecord({ ...record, fields: experiment.record.fields,
      inputs: inputs.map(({ sha256: _sha256, ...row }) => row), parameters: { ...record.parameters, matchDistanceBelow: 0.9 } });
    await expect(replaySyntenyExperiment(serializeAnalysisRecord(parameters))).rejects.toThrow('freshly recomputed');
    const method = await createAnalysisRecord({ ...record, fields: experiment.record.fields,
      inputs: inputs.map(({ sha256: _sha256, ...row }) => row), method: { ...record.method, version: 'unsupported' } });
    await expect(replaySyntenyExperiment(serializeAnalysisRecord(method))).rejects.toThrow('incompatible');
  });

  it('rejects missing, out-of-bounds and unbounded inputs before alignment', () => {
    const malformed: unknown[] = [
      { ...input(), genesReference: [] },
      { ...input(), unsupported: 'not recorded' },
      { ...input(), query: { ...input().query, length: null } },
      { ...input(), query: { ...input().query, source: ['local'] } },
      { ...input(), query: { ...input().query, annotationMetadata: undefined } },
      { ...input(), genesQuery: [{ ...input().genesQuery[0], endPos: 101 }] },
      { ...input(), genesQuery: [input().genesQuery[0], input().genesQuery[0]] },
      { ...input(), genesQuery: [{ ...input().genesQuery[0], startPos: NaN }] },
    ];
    for (const value of malformed) expect(() => validateSyntenyInput(value)).toThrow();
    const large = input();
    large.query.length = large.reference.length = 50000;
    large.genesQuery = genes(Array.from({ length: 501 }, () => 'capsid'));
    large.genesReference = genes(Array.from({ length: 1000 }, () => 'capsid'));
    expect(() => validateSyntenyInput(large)).toThrow('500,000-cell');
    const bytes = input();
    bytes.genesQuery[0].qualifiers = { note: 'A'.repeat(2 * 1024 * 1024) };
    expect(() => validateSyntenyInput(bytes)).toThrow('2 MiB');
  });

  it('exports all matrix cells including zeroes and all original annotation rows', async () => {
    const experiment = await analyzeSyntenyExperiment(input());
    const rows = (table: 'matrix' | 'blocks' | 'annotations') => exportSyntenyTsv(experiment, table).trimEnd()
      .split('\n').filter(row => !row.startsWith('#'));
    expect(rows('matrix')).toEqual(['query_index\treference_index\tquery_gene_id\treference_gene_id\tannotation_similarity',
      '0\t0\t1\t1\t1', '0\t1\t1\t2\t0', '0\t2\t1\t3\t0',
      '1\t0\t2\t1\t0', '1\t1\t2\t2\t1', '1\t2\t2\t3\t0',
      '2\t0\t3\t1\t0', '2\t1\t3\t2\t0', '2\t2\t3\t3\t1']);
    expect(rows('blocks')[1]).toBe('0\t0\t2\t0\t2\t0\t50\t0\t50\tforward\t1');
    expect(rows('annotations')).toHaveLength(7);
    expect(exportSyntenyTsv(experiment, 'matrix')).toContain(experiment.record.resultId);
    expect(analysisJson(experiment.result)).toEqual(experiment.record.fields.synteny.value);
  });
});
