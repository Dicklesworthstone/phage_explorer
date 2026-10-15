import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { GROWTH_CURVE_METHOD, GROWTH_CURVE_RECORD_METHOD, createGrowthCurveRecord, replayGrowthCurveRecord,
  exportGrowthCurveTsv, parseGrowthCurveRecordInput, serializeGrowthCurveExperiment, fitOneStepGrowth,
  type GrowthCurveExperiment, type GrowthCurveFit } from './one-step-growth';

function input(noisy = false): GrowthCurveExperiment {
  return { schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml',
    title: 'Independent hand-specified corrected-PFU fixture', provenance: { kind: 'synthetic', source: 'Test data only; no biological observations' },
    observations: [10, 10, 10, 60, 110, 110, 110].map((pfuPerMl, timeMin) => ({ timeMin,
      pfuPerMl: pfuPerMl + (noisy ? [1, -1, 2, 3, -4, 2, -1][timeMin] : 0) })),
    options: { infectedCentersPerMl: null, bootstrapSamples: noisy ? 20 : 0, seed: 0 } };
}
async function resign(record: AnalysisRecord, change: (r: AnalysisRecord) => void): Promise<string> {
  const r = structuredClone(record); change(r);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: r.method, inputs: r.inputs.map(({ sha256: _hash, ...i }) => i),
    parameters: r.parameters, seed: r.seed, references: r.references, fields: r.fields }));
}
const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('portable corrected-PFU experiments', () => {
  it('records a hand-derived baseline, increase, knot pair and all individual residuals', async () => {
    const text = JSON.stringify(input(), null, 2), record = await createGrowthCurveRecord(text);
    const fit = record.fields.fit.value as unknown as GrowthCurveFit;
    near(fit.baselinePFUPerMl, 10); near(fit.increasePFUPerMl, 100); near(fit.plateauPFUPerMl, 110);
    assert.equal(fit.riseStartMin, 2); assert.equal(fit.riseEndMin, 4);
    assert.equal(fit.intervals, null); assert.equal(fit.infectiousYieldPerInfectedCenter, null);
    assert.equal(record.fields.infectiousYieldPerInfectedCenter.kind, 'unavailable');
    for (const row of fit.fitted) near(row.residualPFUPerMl, 0);
    assert.equal(record.inputs[0].data, text); assert.equal(record.seed, 0);
    assert.deepEqual(record.method, GROWTH_CURVE_RECORD_METHOD); assert.equal(record.fields.observations.kind, 'demo');
    assert.deepEqual(await replayGrowthCurveRecord(serializeAnalysisRecord(record)), record);
  });
  it('retains conditional scalar bootstrap intervals and explicit denominator units for author-supplied data', async () => {
    const experiment = input(true); experiment.provenance.kind = 'user-supplied'; experiment.options.infectedCentersPerMl = 5;
    const record = await createGrowthCurveRecord(JSON.stringify(experiment)), fit = record.fields.fit.value as unknown as GrowthCurveFit;
    assert.equal(record.inputs[0].source, 'local'); assert.equal(record.fields.observations.kind, 'observation');
    assert.equal(record.fields.increasePFUPerMl.units, 'PFU/mL');
    const field = record.fields.increasePFUPerMl;
    assert.equal(field.kind, 'fitted-estimate');
    if (field.kind !== 'fitted-estimate' || field.fit.uncertainty.kind !== 'interval') throw new Error('Expected conditional bootstrap interval');
    assert.deepEqual([field.fit.uncertainty.lower, field.fit.uncertainty.upper], fit.intervals!.increasePFUPerMl);
    assert.equal(field.fit.uncertainty.level, 0.95); near(fit.infectiousYieldPerInfectedCenter!, fit.increasePFUPerMl / 5);
    assert.deepEqual(fit, fitOneStepGrowth(experiment.observations, experiment.options));
  });
  it('verifies old result-bearing exports instead of throwing away changed numerical evidence', async () => {
    const legacy = serializeGrowthCurveExperiment(input(true));
    const record = await createGrowthCurveRecord(legacy); assert.equal(record.inputs[0].data, legacy);
    for (const change of ['estimate', 'interval', 'residual', 'missing']) {
      const bad = JSON.parse(legacy);
      if (change === 'estimate') bad.result.increasePFUPerMl += 1;
      if (change === 'interval') bad.result.intervals.increasePFUPerMl[0] -= 1;
      if (change === 'residual') bad.result.fitted[0].residualPFUPerMl += 1;
      if (change === 'missing') delete bad.result.warnings;
      await assert.rejects(createGrowthCurveRecord(JSON.stringify(bad)), /legacy saved result/);
    }
  });
  it('rejects rehashed estimates, bootstrap intervals, metadata and seeds during actual numerical replay', async () => {
    const record = await createGrowthCurveRecord(JSON.stringify(input(true)));
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as GrowthCurveFit).increasePFUPerMl += 1; },
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as GrowthCurveFit).intervals!.increasePFUPerMl![0] -= 1; },
      (r: AnalysisRecord) => { r.seed = 123; },
      (r: AnalysisRecord) => { r.parameters.bootstrapSamples = 0; },
      (r: AnalysisRecord) => { r.references[0].description = 'Changed reference'; },
      (r: AnalysisRecord) => { r.inputs[0].source = 'local'; },
      (r: AnalysisRecord) => { r.fields.baselinePFUPerMl.value = 999; },
    ]) {
      const forged = await resign(record, change); await parseAnalysisRecord(forged);
      await assert.rejects(replayGrowthCurveRecord(forged), /Recomputed corrected-PFU/);
    }
  });
  it('does not invent timing, fit quality, intervals or a yield when the data cannot supply them', async () => {
    for (const amount of [0, 10]) {
      const e = input(); e.observations.forEach(row => { row.pfuPerMl = amount; });
      const r = await createGrowthCurveRecord(JSON.stringify(e)), f = r.fields.fit.value as unknown as GrowthCurveFit;
      assert.equal(f.riseStartMin, null); assert.equal(f.riseEndMin, null); assert.equal(f.rSquared, null);
      assert.equal(f.increasePFUPerMl, 0); assert.equal(f.intervals, null); assert.equal(f.infectiousYieldPerInfectedCenter, null);
      assert.equal(r.fields.riseStartMin.kind, 'unavailable'); assert.equal(r.fields.riseEndMin.kind, 'unavailable');
    }
  });
  it('preserves original input identity without changing numerical results for reordered observations', async () => {
    const e = input(true), original = JSON.stringify(e), a = await createGrowthCurveRecord(original);
    e.observations.reverse(); const b = await createGrowthCurveRecord(JSON.stringify(e));
    assert.deepEqual(a.fields.fit.value, b.fields.fit.value); assert.notEqual(a.resultId, b.resultId);
    assert.equal(a.inputs[0].data, original); assert.equal(parseGrowthCurveRecordInput(JSON.stringify(e)).observations[0].timeMin, 0);
  });
  it('exports accepted data without fitting again and keeps raw-count output a different method', async () => {
    const r = await createGrowthCurveRecord(JSON.stringify(input(true))), table = exportGrowthCurveTsv(r);
    assert.match(table, /bootstrapSamples=20; seed=0/); assert.match(table, /observed_pfu_per_ml/);
    const rows = table.trim().split('\n').filter(row => !row.startsWith('#')).slice(1).map(row => row.split('\t').map(Number));
    const fit = r.fields.fit.value as unknown as GrowthCurveFit;
    assert.deepEqual(rows, fit.fitted.map(row => [row.timeMin, row.pfuPerMl, row.predictedPFUPerMl, row.residualPFUPerMl]));
    assert.throws(() => exportGrowthCurveTsv({ ...r, method: { ...r.method, id: 'plaque-count-growth' } }), /corrected-PFU/);
  });
  it('rejects the wrong assay, omitted settings and unexpected options rather than silently defaulting', async () => {
    const e = input();
    for (const bad of [{ ...e, measurement: 'extracellular-plaque-counts' }, { ...e, method: 'future' },
      { ...e, options: { ...e.options, seed: undefined } }, { ...e, options: { ...e.options, weights: [1] } },
      { ...e, observations: e.observations.map(row => ({ ...row, volume: 1 })) },
      { ...e, provenance: { ...e.provenance, verified: true } }, { ...e, filename: 'never read' }, { ...e, result: null }]) {
      await assert.rejects(createGrowthCurveRecord(JSON.stringify(bad)));
    }
  });
  it('enforces UTF-8 byte limits and explicit finite numeric inputs', async () => {
    const e = input();
    for (const bad of [null, [], { ...e, options: { ...e.options, bootstrapSamples: null } },
      { ...e, options: { ...e.options, infectedCentersPerMl: '3' } },
      { ...e, observations: e.observations.map(row => ({ ...row, pfuPerMl: null })) }]) {
      await assert.rejects(createGrowthCurveRecord(JSON.stringify(bad)));
    }
    assert.throws(() => parseGrowthCurveRecordInput(' '.repeat(1_000_001)), /UTF-8 bytes/);
    const content = JSON.stringify({ ...e, title: 'é'.repeat(500_000) });
    assert(content.length < 1_000_000); assert.throws(() => parseGrowthCurveRecordInput(content), /UTF-8 bytes/);
  });
});
