import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  EPISTASIS_ASSAY_LIMITS, EPISTASIS_ASSAY_METHOD, analyzeEpistasisAssay,
  createEpistasisAssayExperiment, createEpistasisAssayTemplate, exportEpistasisAssayTsv,
  parseEpistasisAssayCsv, parseEpistasisAssayDataset, replayEpistasisAssayExperiment,
  resolveEpistasisAssayOptions, validateEpistasisAssayDataset,
  type EpistasisAssayDataset, type EpistasisAssayResult,
} from './epistasis-evidence';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';

const near = (actual: number | null, expected: number, tolerance = 1e-10): void => {
  assert(actual !== null && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    String(actual) + ' differs from ' + expected);
};
function dataset(groups: Record<string, number[]> = {
  WT: [10, 12, 14], A1V: [11, 13, 15], C2S: [15, 17, 19], 'A1V:C2S': [20, 22, 24],
}): EpistasisAssayDataset {
  const input = createEpistasisAssayTemplate();
  input.name = 'Hand-specified arithmetic controls';
  input.source.description = 'Synthetic arithmetic fixture only; not biological measurements.';
  input.observations = Object.entries(groups).flatMap(([variant, values]) =>
    values.map((value, index) => ({ variant, replicateId: 'rep-' + index, value })));
  return input;
}
const noBootstrap = { bootstrapSamples: 0, seed: 0 };
async function resign(record: AnalysisRecord, edit: (copy: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record); edit(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({
    method: copy.method, inputs: copy.inputs.map(({ sha256: _hash, ...input }) => input),
    parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
  }));
}

describe('measured epistasis contrasts', () => {
  it('uses all four measured genotypes and the observed WT baseline, with an independently derived error', () => {
    // Means 2, 4, 4, 8. The four sample-mean variances are 1, 4/3, 5/3, 2.
    const input = dataset({ WT: [1, 3], A1V: [2, 4, 6], C2S: [1, 3, 5, 7], 'A1V:C2S': [4, 6, 8, 10, 12] });
    const result = analyzeEpistasisAssay(input, noBootstrap), pair = result.pairs[0];
    assert.equal(pair.status, 'estimated'); near(pair.contrast, 2); near(pair.standardError, Math.sqrt(6));
    near(pair.expectedDouble, 6); near(pair.observedDouble, 8);
    assert.deepEqual(pair.components.map(row => row.transformedMean), [2, 4, 4, 8]);
    assert.deepEqual(pair.components.map(row => row.observations), [2, 3, 4, 5]);
    assert.equal(pair.interval95, null); assert.match(pair.uncertainty.reason, /disabled/);
    assert.equal(pair.uncertainty.method, 'independent-replicate-variance');
    assert.equal(result.coverage.observations, 14);
    assert.equal(result.contrastUnits, input.assay.units);
  });

  it('preserves matched-block covariance instead of pretending correlated rows are independent', () => {
    // Each block has a large common offset. The three within-block interactions are 1, 3, 6.
    const input = dataset({ WT: [10, 110, 210], A1V: [12, 112, 212], C2S: [13, 113, 213], 'A1V:C2S': [16, 118, 221] });
    const independent = analyzeEpistasisAssay(input, noBootstrap).pairs[0];
    input.assay.replicateDesign = 'paired';
    const paired = analyzeEpistasisAssay(input, { bootstrapSamples: 2000, seed: 0 }).pairs[0];
    near(paired.contrast, 10 / 3); near(paired.standardError, Math.sqrt(19) / 3);
    assert(independent.standardError! > paired.standardError! * 50);
    assert.deepEqual(paired.completeBlocks, ['rep-0', 'rep-1', 'rep-2']);
    assert.deepEqual(paired.incompleteBlocks, []);
    assert.equal(paired.uncertainty.method, 'paired-block-contrast-variance');
    // Every resampled mean lies in the convex hull of the observed block
    // contrasts. Finite Monte Carlo percentiles need not equal population endpoints.
    assert(paired.interval95 !== null);
    assert(paired.interval95[0] >= 1 && paired.interval95[1] <= 6);
    assert(paired.interval95[0] < paired.interval95[1]);
    assert.equal(paired.uncertainty.bootstrapSamples, 2000);
  });

  it('keeps unmatched rows visible and uses the same complete blocks for every component', () => {
    const input = dataset({ WT: [10, 110, 210], A1V: [12, 112, 212], C2S: [13, 113, 213], 'A1V:C2S': [16, 118, 221] });
    input.assay.replicateDesign = 'paired';
    input.observations = input.observations.filter(row => !(row.variant === 'A1V' && row.replicateId === 'rep-1'));
    input.observations.push({ variant: 'A1V:C2S', replicateId: 'unmatched', value: 1e10 });
    const result = analyzeEpistasisAssay(input), pair = result.pairs[0];
    near(pair.contrast, 3.5); near(pair.standardError, 2.5);
    assert.deepEqual(pair.completeBlocks, ['rep-0', 'rep-2']);
    assert.deepEqual(pair.components.map(row => row.observations), [2, 2, 2, 2]);
    assert.deepEqual(pair.components.map(row => row.transformedMean), [110, 112, 113, 118.5]);
    assert.deepEqual(pair.incompleteBlocks, [
      { replicateId: 'rep-1', missingVariants: ['A1V'] },
      { replicateId: 'unmatched', missingVariants: ['WT', 'A1V', 'C2S'] },
    ]);
    assert.equal(result.observations.length, input.observations.length);
    assert.equal(result.variants.find(row => row.variant === 'A1V:C2S')!.observations, 4);
    assert.equal(pair.interval95, null); assert.match(pair.uncertainty.reason, /fewer than three/);
    assert(pair.warnings.some(warning => warning.includes('Missingness may bias')));
  });

  it('distinguishes missing controls and absent blocks from a measured zero interaction', () => {
    const missing = dataset({ A1V: [2], C2S: [3], 'A1V:C2S': [5] });
    const unavailable = analyzeEpistasisAssay(missing).pairs[0];
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.contrast, null);
    assert.equal(unavailable.standardError, null); assert.equal(unavailable.interval95, null);
    assert.deepEqual(unavailable.missingVariants, ['WT']);
    missing.observations.push({ variant: 'WT', replicateId: 'rep-0', value: 0 });
    const observedZero = analyzeEpistasisAssay(missing).pairs[0];
    assert.equal(observedZero.status, 'estimated'); near(observedZero.contrast, 0);
    assert.equal(observedZero.standardError, null); assert.match(observedZero.uncertainty.reason, /two independent/);
    missing.assay.replicateDesign = 'paired';
    missing.observations.forEach(row => { row.replicateId = row.variant; });
    const disjoint = analyzeEpistasisAssay(missing).pairs[0];
    assert.deepEqual(disjoint.missingVariants, []); assert.deepEqual(disjoint.completeBlocks, []);
    assert.equal(disjoint.status, 'unavailable'); assert.equal(disjoint.contrast, null);
    assert.equal(disjoint.incompleteBlocks.length, 4);
  });

  it('uses explicit log-transformed observations and the geometric multiplicative null', () => {
    const input = dataset({ WT: [2, 2, 2], A1V: [3, 3, 3], C2S: [4, 4, 4], 'A1V:C2S': [6, 6, 6] });
    near(analyzeEpistasisAssay(input, noBootstrap).pairs[0].contrast, 1);
    input.assay.scale = 'natural-log';
    const result = analyzeEpistasisAssay(input, noBootstrap);
    near(result.pairs[0].contrast, 0); near(result.pairs[0].expectedDouble, Math.log(6));
    assert.equal(result.contrastUnits, 'dimensionless natural-log contrast');
    assert(result.observations.every(row => row.transformedValue === Math.log(row.value)));
    const scaled = structuredClone(input); scaled.observations.forEach(row => { row.value *= 1e8; });
    near(analyzeEpistasisAssay(scaled, noBootstrap).pairs[0].contrast, 0);
    // Unequal positive replicates expose log(mean(x)) versus mean(log(x)).
    input.observations = dataset({ WT: [1, 4], A1V: [2, 8], C2S: [3, 12], 'A1V:C2S': [6, 24] }).observations;
    const geometric = analyzeEpistasisAssay(input, noBootstrap);
    near(geometric.variants.find(row => row.variant === 'WT')!.rawMean, 2.5);
    near(geometric.variants.find(row => row.variant === 'WT')!.transformedMean, Math.log(2));
    near(geometric.pairs[0].contrast, 0);
  });

  it('is equivariant to an identity-scale unit change and invariant to a common additive offset', () => {
    const input = dataset(), original = analyzeEpistasisAssay(input, { bootstrapSamples: 500, seed: 7 }).pairs[0];
    const changed = structuredClone(input);
    changed.observations.forEach(row => { row.value = row.value * 2 + 100; });
    const converted = analyzeEpistasisAssay(changed, { bootstrapSamples: 500, seed: 7 }).pairs[0];
    near(converted.contrast, 2 * original.contrast!);
    near(converted.standardError, 2 * original.standardError!);
    near(converted.interval95![0], 2 * original.interval95![0]);
    near(converted.interval95![1], 2 * original.interval95![1]);
  });

  it('withholds invented intervals for inadequate or degenerate replication while retaining estimates', () => {
    const constant = dataset({ WT: [10, 10, 10], A1V: [12, 12, 12], C2S: [13, 13, 13], 'A1V:C2S': [18, 18, 18] });
    const result = analyzeEpistasisAssay(constant).pairs[0];
    near(result.contrast, 3); near(result.standardError, 0);
    assert.equal(result.interval95, null); assert.match(result.uncertainty.reason, /no empirical variation/);
    const variable = dataset(); variable.assay.replicateDesign = 'paired';
    const cancellation = analyzeEpistasisAssay(variable).pairs[0];
    near(cancellation.contrast, 4); near(cancellation.standardError, 0);
    assert.equal(cancellation.interval95, null);
    const two = dataset({ WT: [1, 2], A1V: [2, 3], C2S: [3, 4], 'A1V:C2S': [5, 6] });
    const twoResult = analyzeEpistasisAssay(two).pairs[0];
    assert(twoResult.standardError! > 0); assert.equal(twoResult.interval95, null);
    assert.match(twoResult.uncertainty.reason, /fewer than three/);
  });

  it('returns every measured double, distinct substitutions at a position, and uncovered pairs without fabricating others', () => {
    const input = dataset({ WT: [1], A1V: [2], C2S: [3], 'A1V:C2S': [7],
      A1G: [4], 'A1G:C2S': [9], 'A1V:D3N': [20] });
    const result = analyzeEpistasisAssay(input, noBootstrap);
    assert.equal(result.pairs.length, 3);
    assert.deepEqual(result.pairs.map(row => row.variant), ['A1G:C2S', 'A1V:C2S', 'A1V:D3N']);
    near(result.pairs[0].contrast, 3); near(result.pairs[1].contrast, 3);
    assert.equal(result.pairs[2].contrast, null); assert.deepEqual(result.pairs[2].missingVariants, ['D3N']);
    assert.deepEqual(result.coverage, { observations: 7, variants: 7, doubleVariants: 3, estimatedPairs: 2, unavailablePairs: 1 });
    const singles = analyzeEpistasisAssay(dataset({ WT: [1], A1V: [2] }), noBootstrap);
    assert.deepEqual(singles.pairs, []); assert(singles.warnings.some(warning => warning.includes('No measured double mutant')));
  });

  it('is deterministic with seed zero, canonical row order and reversed mutation notation, without changing callers', () => {
    const input = dataset(), before = structuredClone(input), options = { bootstrapSamples: 1000, seed: 0 };
    const first = analyzeEpistasisAssay(input, options);
    const reversed = structuredClone(input); reversed.observations.reverse();
    reversed.observations.forEach(row => { if (row.variant === 'A1V:C2S') row.variant = 'C2S:A1V'; });
    assert.deepEqual(analyzeEpistasisAssay(reversed, options), first);
    assert.deepEqual(input, before); assert.deepEqual(options, { bootstrapSamples: 1000, seed: 0 });
    assert.deepEqual(analyzeEpistasisAssay(input, options), first);
    // Distinct seeds may legitimately yield the same discrete percentile endpoints.
    const otherSeed = analyzeEpistasisAssay(input, { ...options, seed: 10 });
    assert.equal(otherSeed.options.seed, 10);
  });
});

describe('epistasis assay input boundaries', () => {
  it('requires exact reference residues, distinct positions and uniquely identified independent units', () => {
    const input = dataset();
    for (const invalid of ['A0V', 'A01V', 'C1V', 'A10V', 'A1A', 'A1*', 'A1X', 'a1v', 'A1V:A1G', 'A1V:C2S:D3N', 'WT:A1V']) {
      const changed = structuredClone(input); changed.observations[0].variant = invalid;
      assert.throws(() => validateEpistasisAssayDataset(changed));
    }
    input.observations.push({ variant: 'C2S:A1V', replicateId: 'rep-0', value: 99 });
    assert.throws(() => validateEpistasisAssayDataset(input), /Duplicate variant\/replicate/);
    for (const sequence of ['', 'ACX', 'AC-', 'acdef', 'AC*', 'A'.repeat(EPISTASIS_ASSAY_LIMITS.proteinResidues + 1)]) {
      const changed = dataset(); changed.protein.sequence = sequence;
      assert.throws(() => validateEpistasisAssayDataset(changed), /Reference protein/);
    }
  });

  it('refuses omitted assumptions, unknown fields, missing values, censoring and nonpositive log observations', () => {
    const input = dataset();
    for (const changed of [
      null, [], { ...input, version: 2 }, { ...input, observedFitness: true },
      { ...input, source: { ...input.source, license: undefined } },
      { ...input, assay: { ...input.assay, scale: 'automatic' } },
      { ...input, assay: { ...input.assay, replicateDesign: 'technical' } },
      { ...input, assay: { ...input.assay, conditions: '' } },
      { ...input, protein: { ...input.protein, fetch: 'remote.fa' } },
      { ...input, observations: [] }, { ...input, observations: Array(4) },
    ]) assert.throws(() => validateEpistasisAssayDataset(changed));
    for (const value of [null, '', '5', NaN, Infinity, -Infinity, 1e13]) {
      const changed = structuredClone(input);
      changed.observations[0].value = value as number;
      assert.throws(() => validateEpistasisAssayDataset(changed));
    }
    for (const value of [0, -1]) {
      const changed = structuredClone(input); changed.assay.scale = 'natural-log'; changed.observations[0].value = value;
      assert.throws(() => validateEpistasisAssayDataset(changed), /strictly positive/);
      changed.assay.scale = 'identity'; assert.doesNotThrow(() => validateEpistasisAssayDataset(changed));
    }
    assert.throws(() => validateEpistasisAssayDataset({ ...input,
      observations: input.observations.map(row => ({ ...row, censoring: 'left' })) }), /unsupported fields/);
  });

  it('parses only explicit numerical tables with metadata, keeping zero and negative identity-scale observations', () => {
    const input = dataset({ WT: [0], A1V: [-2], C2S: [3.5], 'A1V:C2S': [1e-3] });
    const { observations: _rows, ...metadata } = input;
    const table = 'variant,replicate_id,value\nWT,r,0\nA1V,r,-2\nC2S,r,3.5\nC2S:A1V,r,1e-3\n';
    const parsed = parseEpistasisAssayCsv(table, metadata);
    assert.deepEqual(parsed.observations.map(row => row.value), [-2, .001, 3.5, 0]);
    assert.deepEqual(parseEpistasisAssayCsv('\uFEFF' + table.replaceAll(',', '\t').replaceAll('\n', '\r\n'), metadata), parsed);
    assert.deepEqual(parseEpistasisAssayDataset('\uFEFF' + JSON.stringify(parsed)), parsed);
    for (const invalid of [
      table.replace('value', 'fitness'), table.replace('WT,r,0', 'WT,r,'),
      table.replace('WT,r,0', 'WT,r,NA'), table.replace('WT,r,0', 'WT,r,<1'),
      table.replace('WT,r,0', 'WT,r,0x10'), table.replace('WT,r,0', 'WT,"r",0'),
      table.replace('WT,r,0', 'WT,r,Infinity'), table.replace('WT,r,0', 'WT,r,0,unknown'),
    ]) assert.throws(() => parseEpistasisAssayCsv(invalid, metadata));
  });

  it('checks bounded input, expansion and bootstrap settings instead of silently dropping data', () => {
    const input = dataset();
    assert.throws(() => parseEpistasisAssayDataset(' '.repeat(EPISTASIS_ASSAY_LIMITS.bytes + 1)), /2 MiB/);
    assert.throws(() => validateEpistasisAssayDataset({ ...input,
      observations: Array.from({ length: 4097 }, (_, i) => ({ variant: 'WT', replicateId: 'r' + i, value: 1 })) }), /1–4096/);
    assert.deepEqual(resolveEpistasisAssayOptions(), { bootstrapSamples: 1000, seed: 1 });
    assert.deepEqual(resolveEpistasisAssayOptions(noBootstrap), noBootstrap);
    for (const bad of [null, { seed: null }, { bootstrapSamples: null }, { seed: -1 }, { seed: 2 ** 32 },
      { seed: .5 }, { bootstrapSamples: 199 }, { bootstrapSamples: 2001 }, { bootstrapSamples: 2.5 }, { pValue: true }]) {
      assert.throws(() => resolveEpistasisAssayOptions(bad));
    }
    const expanded = dataset({ WT: Array.from({ length: 1000 }, (_, i) => i), A1V: [1] });
    expanded.protein.sequence = 'A'.repeat(60);
    for (let position = 2; position <= 54; position++) {
      expanded.observations.push({ variant: 'A' + position + 'V', replicateId: 'r', value: 2 });
      expanded.observations.push({ variant: 'A1V:A' + position + 'V', replicateId: 'r', value: 3 });
    }
    assert.throws(() => analyzeEpistasisAssay(expanded, noBootstrap), /50,000 observation uses/);
  });

  it('handles unusual safe IDs as data and creates separate snapshots', () => {
    const input = dataset();
    input.observations.forEach(row => { row.replicateId = '__proto__-' + row.replicateId; });
    const parsed = validateEpistasisAssayDataset(input);
    input.protein.sequence = 'A'; input.observations[0].value = 999;
    assert.equal(parsed.protein.sequence, 'ACDEFGHIK'); assert.notEqual(parsed.observations[0].value, 999);
    assert.equal(analyzeEpistasisAssay(parsed, noBootstrap).pairs[0].contrast, 4);
  });
});

describe('portable measured epistasis evidence', () => {
  it('preserves complete source/license, exact reference protein, rows, settings and reproducible fresh replay', async () => {
    const input = dataset(), experiment = await createEpistasisAssayExperiment(input, { bootstrapSamples: 500, seed: 0 });
    assert.deepEqual(experiment.record.method, EPISTASIS_ASSAY_METHOD);
    assert.equal(experiment.record.inputs[0].id, 'assay');
    assert.deepEqual(experiment.record.inputs[0].data, experiment.dataset);
    assert.equal(experiment.record.seed, 0);
    assert.deepEqual(experiment.record.parameters, { bootstrapSamples: 500, seed: 0 });
    assert.equal(experiment.record.fields.result.kind, 'demo');
    assert.equal(experiment.record.fields.observations.kind, 'demo');
    assert.deepEqual(experiment.record.fields.result.value, experiment.result);
    const restored = await replayEpistasisAssayExperiment(serializeAnalysisRecord(experiment.record));
    assert.deepEqual(restored, experiment);
    input.source.kind = 'local'; input.source.license = 'Private research use; no redistribution.';
    const local = await createEpistasisAssayExperiment(input, noBootstrap);
    assert.equal(local.record.fields.observations.kind, 'observation');
    assert.equal(local.record.fields.result.kind, 'fitted-estimate');
    assert(local.record.references.some(row => row.description.includes(input.source.license)));
    assert.notEqual(local.record.resultId, experiment.record.resultId);
  });

  it('rejects fabricated contrasts, uncertainty, incomplete blocks and rehashed metadata during computation replay', async () => {
    const input = dataset(); input.assay.replicateDesign = 'paired';
    input.observations.find(row => row.variant === 'A1V:C2S' && row.replicateId === 'rep-2')!.value += 2;
    const { record } = await createEpistasisAssayExperiment(input, { bootstrapSamples: 500, seed: 0 });
    const result = (copy: AnalysisRecord) => copy.fields.result.value as unknown as EpistasisAssayResult;
    const edits: Array<(copy: AnalysisRecord) => void> = [
      copy => { result(copy).pairs[0].contrast! += 1; },
      copy => { result(copy).pairs[0].standardError = 0; },
      copy => { result(copy).pairs[0].interval95![0] -= 1; },
      copy => { result(copy).pairs[0].completeBlocks = []; },
      copy => { result(copy).pairs[0].components[0].transformedMean = 100; },
      copy => { result(copy).observations[0].transformedValue += 1; },
      copy => { copy.seed = 9; },
      copy => { copy.parameters.bootstrapSamples = 0; },
      copy => { copy.references[0].description = 'A fabricated attribution'; },
      copy => { copy.fields.result.label = 'Measured binding free energy'; },
      copy => { copy.method.implementation = 'Different estimator'; },
      copy => { copy.inputs[0].description = 'A different protein'; },
    ];
    for (const edit of edits) {
      const forged = await resign(record, edit);
      await parseAnalysisRecord(forged); // The ordinary checksum layer alone accepts a re-signed payload.
      await assert.rejects(replayEpistasisAssayExperiment(forged), /Recomputed epistasis/);
    }
    await assert.rejects(replayEpistasisAssayExperiment(await resign(record, copy => { copy.inputs[0].id = 'renamed'; })));
  });

  it('exports all accepted contrast and observation rows, including unavailable pairs and exact sampling context', async () => {
    const input = dataset();
    input.observations.push({ variant: 'A1V:D3N', replicateId: 'missing-controls', value: 123 });
    input.source.license = 'Private use with "quoted" attribution';
    const { record, result } = await createEpistasisAssayExperiment(input, noBootstrap);
    const pairs = exportEpistasisAssayTsv(record), observations = exportEpistasisAssayTsv(record, 'observations');
    const rows = (content: string) => content.trim().split('\n').filter(line => !line.startsWith('#'));
    assert.equal(rows(pairs).length, result.pairs.length + 1);
    assert.equal(rows(observations).length, input.observations.length + 1);
    assert.match(pairs, /interaction_contrast/); assert.match(pairs, /A1V:D3N/); assert.match(pairs, /unavailable/);
    assert.match(pairs, /bootstrap_samples=0; seed=0/);
    assert(pairs.includes(JSON.stringify(input.source.license)));
    assert.match(observations, /observed_value\tassay_units\ttransformed_value/);
    assert(observations.includes('\t123\t' + input.assay.units + '\t123'));
    assert.throws(() => exportEpistasisAssayTsv({ ...record, method: { ...record.method, id: 'synthetic-landscape' } }), /accepted measured/);
    assert.throws(() => exportEpistasisAssayTsv(record, 'missing' as 'pairs'), /section/);
  });

  it('makes user-supplied TSV labels spreadsheet-safe without converting signed numerical observations to text', async () => {
    const input = dataset();
    input.assay.units = '=1+1';
    input.observations[0].replicateId = '@external';
    input.observations[0].value = -2;
    const { record } = await createEpistasisAssayExperiment(input, noBootstrap);
    const table = exportEpistasisAssayTsv(record, 'observations');
    assert(table.includes("\t'@external\t-2\t'=1+1\t-2"));
    assert(!table.includes("\t'-2\t"));
  });

  it('binds assay conditions, scale, protein and license to identity while keeping canonical input order reproducible', async () => {
    const input = dataset(), original = await createEpistasisAssayExperiment(input, noBootstrap);
    const otherSeed = await createEpistasisAssayExperiment(input, { ...noBootstrap, seed: 1 });
    assert.equal(otherSeed.record.seed, 1);
    assert.notEqual(otherSeed.record.cacheKey, original.record.cacheKey);
    assert.notEqual(otherSeed.record.resultId, original.record.resultId);
    const reversed = structuredClone(input); reversed.observations.reverse();
    assert.deepEqual((await createEpistasisAssayExperiment(reversed, noBootstrap)).record, original.record);
    for (const edit of [
      (value: EpistasisAssayDataset) => { value.assay.conditions = 'A distinct assay context'; },
      (value: EpistasisAssayDataset) => { value.assay.scale = 'natural-log'; },
      (value: EpistasisAssayDataset) => { value.protein.sequence += 'A'; },
      (value: EpistasisAssayDataset) => { value.source.license = 'Changed source terms'; },
    ]) {
      const changed = structuredClone(input); edit(changed);
      const fresh = await createEpistasisAssayExperiment(changed, noBootstrap);
      assert.notEqual(fresh.record.cacheKey, original.record.cacheKey);
      assert.notEqual(fresh.record.resultId, original.record.resultId);
    }
  });
});
