import { describe, expect, it } from 'bun:test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { executeRNAStructureRequest, mapRNAInterval, parseRNAStructureRecord, replayRNAStructureRecord,
  validateRNAStructureRequest, type RNAStructureRequest } from './rna-structure-experiment';

const fixture = (): RNAStructureRequest => ({
  sequence: 'GGGAAACCC',
  source: { name: 'Local interval', accession: 'private', source: 'local', coordinateSystem: 'genome-forward',
    sourceLength: 300, start: 100, end: 109, strand: '+', gene: null },
  options: { windowSize: 9, stepSize: 9, includeSynonymousStress: false },
});

/** An edited record can have valid public checksums and still contain a false numerical result. */
async function rehash(record: AnalysisRecord): Promise<string> {
  const { format: _format, version: _version, cacheKey: _cacheKey, resultId: _resultId, ...definition } = record;
  return serializeAnalysisRecord(await createAnalysisRecord({ ...definition,
    inputs: definition.inputs.map(({ sha256: _sha256, ...input }) => input) }));
}

describe('portable RNA interval experiments', () => {
  it('replays an independently countable three-pair structure and retains its exact source', async () => {
    const original = await executeRNAStructureRequest(fixture());
    const content = serializeAnalysisRecord(original.record);
    const parsed = await parseRNAStructureRecord(content);
    const replayed = await replayRNAStructureRecord(content);
    expect(parsed.request).toEqual(original.request);
    expect(replayed).toEqual(original);
    // Nine bases and a three-base interior loop allow at most three pairs; all three are GC.
    expect(replayed.analysis.windows[0].pairCount).toBe(3);
    expect(replayed.analysis.windows[0].pairs).toEqual([[0, 8], [1, 7], [2, 6]]);
    expect(replayed.analysis.windows[0].structure).toBe('(((...)))');
    expect(replayed.analysis.windows[0].pairingScore).toBe(-3);
    expect(replayed.analysis.codonStress).toEqual([]);
    expect(replayed.record.inputs[0].data as unknown).toEqual({ sequence: 'GGGAAACCC', source: fixture().source });
    // Existing web producer at 779477d: migrating it into shared core preserves saved v1 identities.
    expect(replayed.record.cacheKey).toBe('10a1b957e993177aeb92fafabbf1da7ab3d86ae8818c1ded02bd520afc4a8fa7');
    expect(replayed.record.resultId).toBe('26b8e685ca684833ec92fe23efeea5eb1ce061d5e4fca76e209c197821a896bc');
  });

  it('replays reverse-strand bases while preserving original forward coordinates', async () => {
    const input = fixture(); input.sequence = 'GGGTTTCCC'; input.source.strand = '-';
    const first = await executeRNAStructureRequest(input);
    const replayed = await replayRNAStructureRecord(serializeAnalysisRecord(first.record));
    expect(replayed.analysis.windows[0].sequence).toBe('GGGAAACCC');
    expect(replayed.analysis.windows[0].pairCount).toBe(3);
    expect(replayed.request.sequence).toBe('GGGTTTCCC');
    expect(mapRNAInterval(replayed.request.source, 1, 4)).toEqual({ start: 105, end: 108 });
    expect(replayed.record.resultId).toBe(first.record.resultId);
  });

  it('preserves selected transcript interpretation, exact settings and ambiguous input', async () => {
    const input = fixture(); input.source.coordinateSystem = 'cds-transcript'; input.source.gene = 'joined CDS';
    input.source.start = 3; input.source.end = 12; input.sequence = 'CCCAANCCC';
    input.options = { windowSize: 9, stepSize: 4, minLoopSize: 4, allowWobble: false, includeSynonymousStress: true };
    const first = await executeRNAStructureRequest(input);
    const replayed = await replayRNAStructureRecord(serializeAnalysisRecord(first.record));
    expect(replayed.request).toEqual(first.request);
    expect(replayed.analysis.coverage.ambiguousBases).toBe(1);
    expect(replayed.analysis.codonStress.map(codon => codon.nucleotideStart)).toEqual([0, 6]);
    expect(mapRNAInterval(replayed.request.source, 6, 9)).toEqual({ start: 9, end: 12 });
    expect(replayed.analysis.windows[0].pairCount).toBe(0);
    expect(replayed.analysis.windows[0].pairingScore).toBeNull();
    expect(replayed.analysis.parameters.allowWobble).toBe(false);
  });

  it('snapshots the original request before asynchronous record creation', async () => {
    const input = fixture(); input.sequence = input.sequence.toLowerCase();
    const pending = executeRNAStructureRequest(input);
    input.sequence = 'AAAAAAAAA'; input.source.name = 'changed'; input.options.allowWobble = false;
    const result = await pending;
    expect(result.request.sequence).toBe('GGGAAACCC');
    expect(result.request.source.name).toBe('Local interval');
    expect(result.request.options.allowWobble).toBe(true);
    expect(result.analysis.windows[0].pairCount).toBe(3);
    expect(result.record.inputs[0].description).toBe('Local interval');
  });

  it('rejects invalid request coordinates, source claims and parameters before computing', () => {
    const changes: Array<(input: RNAStructureRequest) => void> = [
      input => { input.source.start = NaN; },
      input => { input.source.end = 110; },
      input => { input.source.sourceLength = 108; },
      input => { input.options.includeSynonymousStress = true; },
      input => { input.options.frame = 1; },
      input => { input.options.windowSize = 241; },
      input => { input.options.stepSize = 0; },
      input => { input.sequence = 'GGG-UUCCC'; },
      input => { input.source.gene = 'undeclared CDS'; },
      input => { input.source.coordinateSystem = 'cds-transcript'; input.source.gene = 'CDS'; },
      input => { input.sequence = 'A'.repeat(6001); input.source.start = 0; input.source.end = 6001; input.source.sourceLength = 6001; },
    ];
    for (const change of changes) { const input = fixture(); change(input); expect(() => validateRNAStructureRequest(input)).toThrow(); }
    expect(() => validateRNAStructureRequest({ ...fixture(), url: 'https://example.invalid' })).toThrow(/Invalid RNA/);
    expect(() => validateRNAStructureRequest({ ...fixture(), options: { ...fixture().options, approximate: true } })).toThrow(/Unsupported RNA/);
    expect(() => validateRNAStructureRequest(null)).toThrow(/Invalid RNA/);
  });

  it('rejects rehashed invented folds, motif observations and evidence coverage', async () => {
    const { record } = await executeRNAStructureRequest(fixture());
    const changes: Array<(forged: AnalysisRecord) => void> = [
      forged => {
        const analysis = forged.fields.analysis.value as unknown as { windows: Array<{ pairCount: number; pairs: number[][]; structure: string }> };
        analysis.windows[0].pairCount = 0; analysis.windows[0].pairs = []; analysis.windows[0].structure = '.........';
      },
      forged => { (forged.fields.analysis.value as unknown as { regulatoryHypotheses: unknown[] }).regulatoryHypotheses.push({ start: 0, end: 9, type: 'rbs' }); },
      forged => { forged.fields.analysis.coverage.total = 301; },
      forged => { forged.fields.analysis.label = 'Invented thermodynamic measurement'; },
    ];
    for (const change of changes) {
      const forged = structuredClone(record); change(forged);
      const content = await rehash(forged);
      await expect(parseAnalysisRecord(content)).resolves.toBeDefined();
      await expect(replayRNAStructureRecord(content)).rejects.toThrow(/Recomputed RNA/);
    }
  });

  it('rejects rehashed source/parameter mismatches and unsupported method envelopes', async () => {
    const { record } = await executeRNAStructureRequest(fixture());
    const changes: Array<(forged: AnalysisRecord) => void> = [
      forged => { forged.inputs[0].description = 'Different interval'; },
      forged => { forged.inputs[0].accession = 'Different accession'; },
      forged => { forged.inputs[0].source = 'catalog'; },
      forged => { forged.method.version = 'future'; },
      forged => { forged.method.implementation = 'unverified'; },
      forged => { forged.references[0].version = 'different'; },
      forged => { forged.seed = 42; },
      forged => { forged.parameters.unknown = true; },
      forged => { const { allowWobble: _allowWobble, ...incomplete } = forged.parameters; forged.parameters = incomplete; },
    ];
    for (const change of changes) {
      const forged = structuredClone(record); change(forged);
      await expect(parseRNAStructureRecord(await rehash(forged))).rejects.toThrow();
    }
    const corrupt = structuredClone(record);
    (corrupt.inputs[0].data as { sequence: string }).sequence = 'AAAAAAAAA';
    await expect(replayRNAStructureRecord(serializeAnalysisRecord(corrupt))).rejects.toThrow(/checksum/);
  });

  it('honors cancellation before parsing and after asynchronous hashing', async () => {
    const aborted = new AbortController(); aborted.abort();
    await expect(executeRNAStructureRequest(fixture(), aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(parseRNAStructureRecord('not JSON', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const duringHash = new AbortController();
    const pending = executeRNAStructureRequest(fixture(), duringHash.signal);
    duringHash.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
