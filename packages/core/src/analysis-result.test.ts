import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisField } from './analysis-result';

const coverage = { available: 2, total: 3, unit: 'records' as const };
const context = { label: 'Value', coverage, limitations: ['Two of three supplied records.'] };
const fields: Record<string, AnalysisField> = {
  observation: { ...context, kind: 'observation', value: [2, 4], units: 'count', sourceInput: 'measurements' },
  score: { ...context, kind: 'sequence-score', value: 0.75, units: 'score' },
  fitted: { ...context, kind: 'fitted-estimate', value: 3, units: 'count', fit: { dataInput: 'measurements', objective: 'least squares', uncertainty: { kind: 'not-estimated' } } },
  simulation: { ...context, kind: 'simulation', value: 8, units: 'model-flux', assumptions: ['Fixed bounds.'] },
  demo: { ...context, kind: 'demo', value: 5, units: 'arbitrary-flux', assumptions: ['Synthetic teaching network.'] },
  unavailable: { ...context, kind: 'unavailable', value: null, units: null, missingInputs: ['Aligned homolog sequences.'] },
};
const options = () => ({ method: { id: 'record-contract-test', version: '1', implementation: 'Test of serialization, not method accuracy' },
  inputs: [{ id: 'measurements', accession: 'LOCAL_α', source: 'local' as const, description: 'Explicit controlled input', data: { counts: [2, 4], note: '<script>literal text</script>' } }],
  parameters: { scale: 2 }, seed: 42, references: [{ id: 'reference', version: 'v1', description: 'Controlled fixture reference' }], fields: structuredClone(fields),
});

describe('portable analysis context', () => {
  test('round trips all evidence kinds and binds actual input bytes independently', async () => {
    const record = await createAnalysisRecord(options());
    const json = serializeAnalysisRecord(record);
    expect(await parseAnalysisRecord(json)).toEqual(record);
    expect(record.inputs[0].sha256).toBe(createHash('sha256').update('{"counts":[2,4],"note":"<script>literal text</script>"}').digest('hex'));
    expect(Object.values(record.fields).map(field => field.kind).sort()).toEqual(['demo', 'fitted-estimate', 'observation', 'sequence-score', 'simulation', 'unavailable']);
    expect(record.fields.unavailable.value).toBeNull();
    expect(json).toContain('LOCAL_α');
  });

  test('snapshots inputs before await and canonicalizes object order', async () => {
    const first = options();
    const pending = createAnalysisRecord(first);
    first.inputs[0].data.counts[0] = 999;
    const record = await pending;
    expect((record.inputs[0].data as { counts: number[] }).counts).toEqual([2, 4]);
    const reordered = options();
    reordered.inputs[0].data = { note: '<script>literal text</script>', counts: [2, 4] };
    expect((await createAnalysisRecord(reordered)).resultId).toBe(record.resultId);
  });

  test('invalidates identity on method, data, source, parameters, seed or reference change', async () => {
    const original = await createAnalysisRecord(options());
    const changes: Array<(value: ReturnType<typeof options>) => void> = [
      value => { value.method.version = '2'; }, value => { value.inputs[0].data.counts[0] = 3; },
      value => { value.inputs[0].accession = 'OTHER'; }, value => { value.parameters.scale = 3; },
      value => { value.seed = 43; }, value => { value.references[0].version = 'v2'; },
    ];
    for (const change of changes) {
      const next = options(); change(next);
      const record = await createAnalysisRecord(next);
      expect(record.cacheKey).not.toBe(original.cacheKey);
      await expect(parseAnalysisRecord(serializeAnalysisRecord(record), { cacheKey: original.cacheKey })).rejects.toThrow('identity differs');
    }
    const resultOnly = options(); resultOnly.fields.score.value = 0.5;
    const changed = await createAnalysisRecord(resultOnly);
    expect(changed.cacheKey).toBe(original.cacheKey);
    expect(changed.resultId).not.toBe(original.resultId);
  });

  test('rejects bad versions, altered input/result bytes and incompatible method', async () => {
    const record = await createAnalysisRecord(options());
    await expect(parseAnalysisRecord(JSON.stringify({ ...record, version: 99 }))).rejects.toThrow('version');
    await expect(parseAnalysisRecord(serializeAnalysisRecord(record), { methodVersion: '2' })).rejects.toThrow('incompatible');
    const input = structuredClone(record); input.inputs[0].data = [999];
    await expect(parseAnalysisRecord(JSON.stringify(input))).rejects.toThrow('input checksum');
    const result = structuredClone(record); result.fields.score.value = 1;
    await expect(parseAnalysisRecord(JSON.stringify(result))).rejects.toThrow('result checksum');
  });

  test('rejects score-as-measurement, demo-as-observation and unsupported uncertainty', async () => {
    const record = await createAnalysisRecord(options());
    const physicalScore = structuredClone(record) as any; physicalScore.fields.score.units = 'minutes';
    await expect(parseAnalysisRecord(JSON.stringify(physicalScore))).rejects.toThrow('score');
    const probability = structuredClone(record) as any; probability.fields.score.confidence = 0.99;
    await expect(parseAnalysisRecord(JSON.stringify(probability))).rejects.toThrow('probability');
    const demoInput = structuredClone(record); demoInput.inputs[0].source = 'demo';
    demoInput.fields = { observation: demoInput.fields.observation };
    await expect(parseAnalysisRecord(JSON.stringify(demoInput))).rejects.toThrow('non-demo observation source');
    const badFit = structuredClone(record) as any; badFit.fields.fitted.fit.uncertainty = { kind: 'interval', method: 'declared', level: 1.5, lower: 5, upper: 2 };
    await expect(parseAnalysisRecord(JSON.stringify(badFit))).rejects.toThrow('uncertainty');
    const noInput = structuredClone(record) as any; noInput.fields.unavailable.missingInputs = [];
    await expect(parseAnalysisRecord(JSON.stringify(noInput))).rejects.toThrow('missing input');
  });

  test('rejects nonfinite payloads, excessive nesting and oversized files', async () => {
    expect(() => analysisJson({ value: Infinity })).toThrow('finite');
    expect(() => analysisJson(new Map())).toThrow('plain JSON');
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => analysisJson(cyclic)).toThrow('nesting');
    await expect(parseAnalysisRecord(' '.repeat(10 * 1024 * 1024 + 1))).rejects.toThrow('10 MiB');
  });
});
