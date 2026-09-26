import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  analyzeAbundanceDataset, parseAbundanceDataset, serializeAbundanceDataset,
  validateAbundanceDataset, resolveAbundanceOptions, adjustAbundancePValues,
  createAbundanceAnalysisRecord, replayAbundanceAnalysis, ABUNDANCE_LIMITS,
  type AbundanceDataset,
} from './abundance';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';

function dataset(counts: number[][], metadata: AbundanceDataset['metadata'] = []): AbundanceDataset {
  return { format: 'phage-explorer-abundance', version: 1, name: 'Independent fixture', units: 'counts',
    source: { kind: 'local', description: 'Hand-derived mathematical control, not an empirical community', reference: null },
    table: { taxa: counts.map((_, i) => `T${i}`), samples: counts[0].map((_, i) => `S${i}`), counts }, metadata };
}
function close(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
}
// log columns have zero mean, so their exact CLR coordinates are x,x,-2x.
// Only identity and reversal among 5!=120 pairings have |r|=1: p=1/60.
const exactFixture = () => dataset([[-2, -1, 0, 1, 2].map(Math.exp), [-2, -1, 0, 1, 2].map(Math.exp),
  [4, 2, 0, -2, -4].map(Math.exp)]);

describe('local abundance input', () => {
  it('parses BOM, CRLF, quoted identifiers, escaped quotes and scientific counts', () => {
    const result = parseAbundanceDataset('\uFEFFtaxon,"sample,1",sample2,sample3\r\n"Taxon ""α""",1e2,.5,0\r\n<img>,2,3,4\r\n', 'Study.csv');
    assert.deepEqual(result.table, { taxa: ['Taxon "α"', '<img>'], samples: ['sample,1', 'sample2', 'sample3'], counts: [[100, .5, 0], [2, 3, 4]] });
    assert.equal(result.source.kind, 'local');
    assert.equal(result.source.reference, null);
  });
  it('parses TSV with taxa in rows and samples in columns', () => {
    const result = parseAbundanceDataset('taxon_id\tS1\tS2\tS3\nA\t1\t2\t3\nB\t3\t2\t1');
    assert.deepEqual(result.table.counts, [[1, 2, 3], [3, 2, 1]]);
  });
  it('preserves units, keyed metadata and attribution through JSON roundtrips', () => {
    const input = dataset([[.25, .5, .75], [.75, .5, .25]], [{ sampleId: 'S2', habitat: 'soil', host: 'unknown', depth: 12 }]);
    input.units = 'relative-abundance'; input.source.reference = 'Study accession supplied by user';
    assert.deepEqual(parseAbundanceDataset(serializeAbundanceDataset(input)), input);
  });
  it('rejects malformed CSV and refuses to interpret missing or invalid values as zero', () => {
    for (const cell of ['', 'NA', 'null', '-1', 'Infinity', 'NaN', '0x10', '1e999', '1,2']) {
      assert.throws(() => parseAbundanceDataset(`taxon,a,b,c\nT,1,${cell},3`), /number|columns|nonnegative/);
    }
    for (const text of ['a,b,c\n1,2,3', 'taxon,a,b,c\n"unterminated,1,2,3', 'taxon,a,b,c\n"T"tail,1,2,3']) {
      assert.throws(() => parseAbundanceDataset(text));
    }
  });
  it('rejects ragged matrices, duplicate identities and unsupported schemas', () => {
    for (const mutate of [
      (x: AbundanceDataset) => { x.table.counts[1].pop(); },
      (x: AbundanceDataset) => { x.table.taxa[1] = 'T0'; },
      (x: AbundanceDataset) => { x.table.samples[1] = ' S0 '; },
      (x: AbundanceDataset) => { x.table.counts[1][0] = -1; },
      (x: AbundanceDataset) => { x.table.counts[1][0] = NaN; },
      (x: AbundanceDataset) => { (x as unknown as { version: number }).version = 2; },
    ]) { const x = exactFixture(); mutate(x); assert.throws(() => validateAbundanceDataset(x)); }
  });
  it('requires metadata IDs to match known samples exactly once', () => {
    for (const metadata of [[{ sampleId: 'missing', habitat: 'soil' }], [{ sampleId: 'S0' }, { sampleId: 'S0' }]]) {
      assert.throws(() => validateAbundanceDataset(dataset([[1, 2, 3], [3, 2, 1]], metadata)), /unknown or duplicate/);
    }
  });
  it('rejects relative-abundance columns which are not closed and accepts explicit empty columns', () => {
    const x = dataset([[.2, 0, .3], [.8, 0, .7]]); x.units = 'relative-abundance';
    assert.doesNotThrow(() => validateAbundanceDataset(x));
    x.table.counts[1][2] = 7;
    assert.throws(() => validateAbundanceDataset(x), /sum to 1/);
  });
  it('bounds input bytes and identifier dimensions before analysis', () => {
    assert.throws(() => parseAbundanceDataset(' '.repeat(ABUNDANCE_LIMITS.bytes + 1)), /4 MiB/);
    assert.throws(() => validateAbundanceDataset(dataset(Array.from({ length: 101 }, () => [1, 2, 3]))), /Taxa/);
  });
  it('snapshots the data instead of sharing mutable arrays with its caller', () => {
    const x = exactFixture(); const copy = validateAbundanceDataset(x);
    x.table.counts[0][0] = 999;
    assert.notEqual(copy.table.counts[0][0], 999);
  });
});

describe('independently derived CLR and association controls', () => {
  it('centers each sample across taxa, not each taxon across samples', () => {
    const x = dataset([[1, 2, 3], [2, 2, 2], [4, 8, 12]]);
    const result = analyzeAbundanceDataset(x, { pseudocount: 0, numNiches: 1, permutations: 19 });
    for (let s = 0; s < 3; s++) {
      const geometricMean = Math.cbrt(x.table.counts[0][s] * x.table.counts[1][s] * x.table.counts[2][s]);
      for (let t = 0; t < 3; t++) close(result.clr[t][s], Math.log(x.table.counts[t][s] / geometricMean));
      close(result.clr.reduce((sum, row) => sum + row[s], 0), 0);
      close(result.relativeAbundance.reduce((sum, row) => sum + row[s], 0), 1);
    }
    // Unlike the previous row-wise transform, this row is NOT mean centered.
    assert.ok(Math.abs(result.clr[0].reduce((a, b) => a + b, 0)) > .5);
  });
  it('is invariant to per-sample depth scaling without a pseudocount', () => {
    const x = exactFixture(); const scaled = structuredClone(x);
    scaled.table.counts = x.table.counts.map(row => row.map((n, s) => n * [3, 17, .2, 31, 7][s]));
    const a = analyzeAbundanceDataset(x, { pseudocount: 0, numNiches: 1 });
    const b = analyzeAbundanceDataset(scaled, { pseudocount: 0, numNiches: 1 });
    for (let t = 0; t < 3; t++) for (let s = 0; s < 5; s++) close(a.clr[t][s], b.clr[t][s]);
    a.associations.forEach((edge, i) => close(edge.correlation, b.associations[i].correlation));
  });
  it('gets exact two-sided pairing p-values, BH values and edge signs', () => {
    const result = analyzeAbundanceDataset(exactFixture(), { pseudocount: 0, numNiches: 1 });
    assert.equal(result.diagnostics.permutationMode, 'exact'); assert.equal(result.diagnostics.permutationsUsed, 120);
    assert.equal(result.edges.length, 3);
    close(result.associations[0].correlation, 1); close(result.associations[1].correlation, -1);
    for (const edge of result.associations) { close(edge.pvalue, 1 / 60); close(edge.qvalue, 1 / 60); }
    const positive = analyzeAbundanceDataset(exactFixture(), { pseudocount: 0, numNiches: 1, includeNegative: false });
    assert.equal(positive.edges.length, 1);
    assert.equal(positive.associations.length, 3, 'all pairs remain in the testing family');
  });
  it('enumerates the six possible pairings for three samples', () => {
    const result = analyzeAbundanceDataset(dataset([[Math.exp(-1), 1, Math.E], [Math.E, 1, Math.exp(-1)]]),
      { pseudocount: 0, numNiches: 1, permutations: 19, qvalueThreshold: 1 });
    close(result.associations[0].pvalue, 1 / 3);
    assert.equal(result.diagnostics.permutationsUsed, 6);
  });
  it('adjusts all tested p-values before any edge filtering', () => {
    const values = adjustAbundancePValues([.01, .04, .03]);
    [.03, .04, .04].forEach((value, i) => close(values[i], value));
    assert.deepEqual(adjustAbundancePValues([]), []);
    assert.throws(() => adjustAbundancePValues([NaN]));
  });
  it('reports undefined constant correlations rather than manufactured edges', () => {
    const result = analyzeAbundanceDataset(dataset([[1, 2, 3, 4], [2, 4, 6, 8]]), { pseudocount: 0, numNiches: 1 });
    assert.deepEqual(result.diagnostics.constantTaxa, ['T0', 'T1']);
    assert.deepEqual(result.associations, []); assert.deepEqual(result.edges, []);
  });
  it('excludes empty taxa and samples before pseudocounts and reports their identities', () => {
    const x = exactFixture(); x.table.taxa.push('absent'); x.table.counts.push([0, 0, 0, 0, 0]);
    x.table.samples.push('empty'); x.table.counts.forEach(row => row.push(0));
    const result = analyzeAbundanceDataset(x, { pseudocount: 0, numNiches: 1 });
    assert.deepEqual(result.diagnostics.excludedTaxa, ['absent']);
    assert.deepEqual(result.diagnostics.excludedSamples, ['empty']);
    assert.equal(result.samples.length, 5); assert.equal(result.taxa.length, 3);
    close(result.associations[0].pvalue, 1 / 60);
    assert.throws(() => analyzeAbundanceDataset(dataset([[0, 0, 0], [0, 0, 0]])), /at least 2/);
  });
  it('uses pseudocounts explicitly, rejects unhandled zeros and changes the numerical output', () => {
    const x = dataset([[0, 1, 5, 2], [2, 3, 2, 1], [1, 4, 1, 3]]);
    assert.throws(() => analyzeAbundanceDataset(x, { pseudocount: 0 }), /positive pseudocount/);
    const a = analyzeAbundanceDataset(x, { pseudocount: .5 });
    const b = analyzeAbundanceDataset(x, { pseudocount: 2 });
    assert.notDeepEqual(a.clr, b.clr);
    close(a.clr[0][0], Math.log(.5) - (Math.log(.5) + Math.log(2.5) + Math.log(1.5)) / 3);
  });
  it('reproduces seeded Monte Carlo tests and uses a nonzero p-value correction', () => {
    const x = dataset([Array.from({ length: 9 }, (_, i) => Math.exp(i - 4)),
      Array.from({ length: 9 }, (_, i) => Math.exp(4 - i)), Array(9).fill(1)]);
    const options = { pseudocount: 0, numNiches: 2, seed: 0, permutations: 99 };
    const a = analyzeAbundanceDataset(x, options), b = analyzeAbundanceDataset(x, options);
    assert.deepEqual(a, b); assert.equal(a.diagnostics.permutationMode, 'monte-carlo');
    for (const edge of a.associations) assert.ok(edge.pvalue >= 1 / 100);
    const more = analyzeAbundanceDataset(x, { ...options, permutations: 199 });
    assert.deepEqual(more.nmfResult, a.nmfResult, 'permutation count must not alter the NMF RNG stream');
  });
  it('reconstructs an independent rank-one abundance matrix with scaled factors', () => {
    const result = analyzeAbundanceDataset(dataset([[1, 2, 3, 4], [2, 4, 6, 8], [3, 6, 9, 12]]), { numNiches: 1, pseudocount: 0 });
    close(result.nmfResult.H[0].reduce((a, b) => a + b, 0), 1);
    let residual = 0;
    for (let t = 0; t < 3; t++) for (let s = 0; s < 4; s++) {
      const reconstructed = result.nmfResult.W[t][0] * result.nmfResult.H[0][s];
      close(reconstructed, (t + 1) / 6, 1e-7);
      residual += (reconstructed - result.relativeAbundance[t][s]) ** 2;
    }
    close(Math.sqrt(residual), result.nmfResult.error, 1e-9);
  });
  it('joins habitats by sample ID and calculates taxon-specific relative-abundance means', () => {
    const x = dataset([[9, 1, 8, 2], [1, 9, 2, 8]], [
      { sampleId: 'S3', habitat: 'water' }, { sampleId: 'S0', habitat: 'soil' },
      { sampleId: 'S2', habitat: 'soil' }, { sampleId: 'S1', habitat: 'water' },
    ]);
    const result = analyzeAbundanceDataset(x, { numNiches: 1 });
    assert.equal(result.profiles[0].habitats[0].habitat, 'soil');
    close(result.profiles[0].habitats[0].meanRelativeAbundance, .85);
    assert.equal(result.profiles[1].habitats[0].habitat, 'water');
    close(result.profiles[1].habitats[0].meanRelativeAbundance, .85);
    assert.equal(result.diagnostics.metadataSamples, 4);
    x.metadata.reverse(); assert.deepEqual(analyzeAbundanceDataset(x, { numNiches: 1 }), result);
  });
  it('rejects invalid controls and bounds requested computation', () => {
    for (const options of [{ pseudocount: -1 }, { numNiches: 1.2 }, { numNiches: 4 }, { seed: -1 },
      { permutations: 1000 }, { qvalueThreshold: 1.1 }, { correlationThreshold: NaN }]) {
      assert.throws(() => analyzeAbundanceDataset(exactFixture(), options));
    }
    assert.throws(() => resolveAbundanceOptions(exactFixture(), { unknown: 1 } as never), /Unsupported/);
    assert.throws(() => analyzeAbundanceDataset(dataset(Array.from({ length: 100 }, () => Array(500).fill(1)))), /workload/);
  });
});

async function resign(content: string, change: (record: AnalysisRecord) => void): Promise<string> {
  const record = await parseAnalysisRecord(content); change(record);
  return serializeAnalysisRecord(await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _hash, ...input }) => input) }));
}
describe('reproducible abundance records', () => {
  it('recomputes exact values and record identity after export/import', async () => {
    const input = exactFixture(); const result = analyzeAbundanceDataset(input, { pseudocount: 0, numNiches: 1 });
    const record = await createAbundanceAnalysisRecord(input, result);
    assert.equal(record.fields.associations.kind, 'fitted-estimate'); assert.equal(record.inputs[0].source, 'local');
    const replay = await replayAbundanceAnalysis(serializeAnalysisRecord(record));
    assert.deepEqual(replay.result, result); assert.equal(replay.record.resultId, record.resultId);
    assert.deepEqual(replay.dataset, input);
  });
  it('keeps synthetic outputs explicitly separate from fitted local-data results', async () => {
    const input = exactFixture(); input.source.kind = 'demo';
    const record = await createAbundanceAnalysisRecord(input, analyzeAbundanceDataset(input));
    assert.equal(record.inputs[0].source, 'demo');
    for (const field of Object.values(record.fields)) assert.equal(field.kind, 'demo');
    assert.equal((await replayAbundanceAnalysis(serializeAnalysisRecord(record))).record.resultId, record.resultId);
  });
  it('rejects tampered bytes and internally re-signed but forged numerical results', async () => {
    const input = exactFixture(); const result = analyzeAbundanceDataset(input);
    const content = serializeAnalysisRecord(await createAbundanceAnalysisRecord(input, result));
    const changed = JSON.parse(content); changed.parameters.seed = 7;
    await assert.rejects(replayAbundanceAnalysis(JSON.stringify(changed)), /identity|checksum/);
    const forged = await resign(content, record => { record.fields.associations.value = []; });
    await assert.rejects(replayAbundanceAnalysis(forged), /Recomputed abundance result differs/);
  });
  it('rejects unavailable method and reference versions before trusting stored output', async () => {
    const input = exactFixture(); const content = serializeAnalysisRecord(await createAbundanceAnalysisRecord(input, analyzeAbundanceDataset(input)));
    await assert.rejects(replayAbundanceAnalysis(await resign(content, record => { record.method.version = '999'; })), /incompatible/);
    await assert.rejects(replayAbundanceAnalysis(await resign(content, record => { record.references[0].version = 'other'; })), /reference/);
  });
  it('binds exact counts, sample metadata and parameters into content identity', async () => {
    const input = exactFixture(); const first = await createAbundanceAnalysisRecord(input, analyzeAbundanceDataset(input));
    const modified = structuredClone(input); modified.metadata = [{ sampleId: 'S1', habitat: 'soil' }];
    const second = await createAbundanceAnalysisRecord(modified, analyzeAbundanceDataset(modified));
    assert.notEqual(first.cacheKey, second.cacheKey);
    const changedParams = await createAbundanceAnalysisRecord(input, analyzeAbundanceDataset(input, { pseudocount: 2 }));
    assert.notEqual(first.cacheKey, changedParams.cacheKey);
  });
});
