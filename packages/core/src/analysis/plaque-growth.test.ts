import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { fitPlaqueGrowth, parsePlaqueGrowthCSV, parsePlaqueGrowthInput, createPlaqueGrowthRecord,
  replayPlaqueGrowthRecord, exportPlaqueGrowthTsv, fitCensoredPlaqueGrowth, poissonCountLogProbability,
  type CensoredGrowthPlate, type CensoredPlaqueGrowthFit, type GrowthPlate, type PlaqueGrowthInput, type PlaqueGrowthFit } from './plaque-growth';
const options = { infectedCentersPerMl: 2, supportDeviance: 3.84 };
const counts = [10, 10, 10, 10, 60, 110, 110, 110, 110];
const plates = (values = counts): GrowthPlate[] => values.map((count, timeMin) => ({ timeMin, count, dilution: 1, volumeMl: 1 }));
const close = (a: number, b: number, tolerance = 1e-7) => assert(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function input(kind: 'user-supplied' | 'synthetic' = 'synthetic'): PlaqueGrowthInput {
  return { format: 'phage-explorer-plaque-growth-input', version: 1, measurement: 'extracellular-plaque-counts',
    title: 'Synthetic plateau curve', provenance: { kind, source: 'Hand-constructed numerical test, not a measured phage experiment' },
    csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n' + plates().map(p => `${p.timeMin},${p.count},${p.dilution},${p.volumeMl}`).join('\n'),
    options: { ...options } };
}
async function resign(record: AnalysisRecord, change: (value: AnalysisRecord) => void): Promise<string> {
  const r = structuredClone(record); change(r);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: r.method, parameters: r.parameters, references: r.references,
    seed: r.seed, fields: r.fields, inputs: r.inputs.map(({ sha256: _hash, ...i }) => i) }));
}
describe('exposure-aware plaque growth likelihood', () => {
  it('recovers independently specified rates, knots and infected-center yield without PFU conversion averaging', () => {
    const fit = fitPlaqueGrowth(plates(), options);
    close(fit.backgroundPFUPerMl, 10); close(fit.increasePFUPerMl, 100); close(fit.plateauPFUPerMl, 110);
    close(fit.infectiousYieldPerInfectedCenter!, 50); close(fit.deviance, 0);
    assert.equal(fit.riseStartMin, 3); assert.equal(fit.riseEndMin, 5); assert.equal(fit.timingStatus, 'grid-supported');
    assert.equal(fit.candidates, 15); assert.deepEqual(fit.knotSupport.map(k => [k.startMin, k.endMin]), [[3, 5]]);
    fit.fitted.forEach((p, i) => { close(p.expectedCount, counts[i]); close(p.predictedPFUPerMl, counts[i]); });
    assert(fit.increaseSupport[0][0] < 100 && fit.increaseSupport[0][1] > 100);
  });
  it('matches an independent SciPy two-rate optimization and independently rooted profile endpoints', () => {
    // Raw two-rate Poisson deviance minimized with multistart Nelder-Mead for
    // each of the 15 knot pairs; scalar minimization + Brent roots for support.
    // No production grouping, mixture-score or bisection implementation used.
    const c = [5, 18, 9, 22, 48, 73, 29, 152, 86], e = [.5, 2, 1, 2, .8, 1.3, .4, 2.5, 1.4];
    const fit = fitPlaqueGrowth(plates(c).map((p, i) => ({ ...p, volumeMl: e[i] })), options);
    close(fit.backgroundPFUPerMl, 10.28585320918885); close(fit.increasePFUPerMl, 53.26639102696038);
    close(fit.deviance, 12.344840239488345); close(fit.increaseSupport[0][0], 46.304976813114095);
    close(fit.increaseSupport[0][1], 60.492094781082535);
    assert.deepEqual(fit.knotSupport.map(k => [k.startMin, k.endMin]), [[3, 5]]);
  });
  it('retains zero-count evidence and a nonzero upper support limit when all plates are zero', () => {
    const fit = fitPlaqueGrowth(plates(counts.map(() => 0)), options);
    assert.equal(fit.increasePFUPerMl, 0); assert.equal(fit.timingStatus, 'unresolved'); assert.equal(fit.riseStartMin, null);
    assert.equal(fit.knotSupport.length, 15); close(fit.increaseSupport[0][0], 0);
    // At A>=0 and background=0, all-zero deviance is 2*A*sum(exposure*f).
    // The least exposed permissible rise (5..7) has f sum 2.5.
    close(fit.increaseSupport[0][1], 3.84 / (2 * 2.5));
    assert(fit.fitted.every(p => p.expectedCount === 0 && p.devianceResidual === 0));
  });
  it('withholds rise timing for flat or decreasing data instead of assigning arbitrary grid knots', () => {
    for (const c of [counts.map(() => 10), [90, 80, 70, 60, 50, 40, 30, 20, 10]]) {
      const fit = fitPlaqueGrowth(plates(c), options);
      close(fit.increasePFUPerMl, 0); assert.equal(fit.riseStartMin, null); assert.equal(fit.riseEndMin, null);
      assert.equal(fit.timingStatus, 'unresolved'); assert.equal(fit.increaseSupport[0][0], 0);
      assert(fit.increaseSupport[0][1] > 0);
    }
  });
  it('preserves a zero-background boundary solution and does not take log(0) for zero counts', () => {
    const fit = fitPlaqueGrowth(plates([0, 0, 0, 0, 100, 200, 200, 200, 200]), options);
    close(fit.backgroundPFUPerMl, 0); close(fit.increasePFUPerMl, 200); close(fit.deviance, 0);
    assert(fit.increaseSupport[0][0] > 0); assert.equal(fit.riseStartMin, 3);
  });
  it('scales concentration and profile support inversely with exposure while preserving likelihood', () => {
    const a = fitPlaqueGrowth(plates(), options), b = fitPlaqueGrowth(plates().map(p => ({ ...p, dilution: 1e-6, volumeMl: .1 })), options);
    close(b.backgroundPFUPerMl, a.backgroundPFUPerMl * 1e7); close(b.increasePFUPerMl, a.increasePFUPerMl * 1e7);
    for (let i = 0; i < 2; i++) close(b.increaseSupport[0][i], a.increaseSupport[0][i] * 1e7);
    close(b.deviance, a.deviance); assert.deepEqual(b.knotSupport, a.knotSupport);
    b.fitted.forEach((p, i) => close(p.expectedCount, a.fitted[i].expectedCount));
  });
  it('uses counts and summed exposure as sufficient statistics but preserves plate-level deviance', () => {
    const combined = fitPlaqueGrowth(plates(counts.map(c => c * 2)).map(p => ({ ...p, volumeMl: 2 })), options);
    const split = fitPlaqueGrowth(plates().flatMap(p => [{ ...p, count: 0 }, { ...p, count: p.count * 2 }]), options);
    close(split.increasePFUPerMl, combined.increasePFUPerMl); close(split.backgroundPFUPerMl, combined.backgroundPFUPerMl);
    close(split.increaseSupport[0][0], combined.increaseSupport[0][0]); close(split.increaseSupport[0][1], combined.increaseSupport[0][1]);
    assert(split.deviance > 100); close(combined.deviance, 0);
    assert.equal(split.fitted.length, 18);
  });
  it('returns all supported knot pairs and flags boundary support instead of a spurious precision claim', () => {
    const fit = fitPlaqueGrowth(plates([10, 10, 60, 110, 110, 110, 110, 110, 110]), options);
    assert.equal(fit.riseStartMin, 1); assert.equal(fit.timingStatus, 'grid-boundary');
    const wide = fitPlaqueGrowth(plates(), { ...options, supportDeviance: 100 });
    const narrow = fitPlaqueGrowth(plates(), options);
    assert(wide.knotSupport.length > narrow.knotSupport.length);
    assert(wide.increaseSupport[0][0] <= narrow.increaseSupport[0][0]);
    assert(wide.increaseSupport.at(-1)![1] >= narrow.increaseSupport.at(-1)![1]);
    assert(wide.warnings.some(w => w.includes('no nominal confidence')));
  });
  it('is invariant to row order and leaves caller-owned plates and options untouched', () => {
    const rows = plates(), before = structuredClone(rows), settings = { ...options };
    const a = fitPlaqueGrowth(rows, settings), b = fitPlaqueGrowth([...rows].reverse(), settings);
    assert.deepEqual(a, b); assert.deepEqual(rows, before); assert.deepEqual(settings, options);
    assert.equal(fitPlaqueGrowth(rows, { ...options, infectedCentersPerMl: null }).yieldSupport, null);
  });
  it('strictly distinguishes integer plaques, dilution fractions, explicit volumes and uncensored zero observations', () => {
    const source = input().csv;
    assert.deepEqual(parsePlaqueGrowthCSV('\uFEFF# units\r\n' + source.replaceAll(',', '\t').replaceAll('\n', '\r\n')), plates());
    for (const text of [source.replace('plaque_count', 'pfu_per_ml'), source.replace('0,10', '0,TNTC'), source.replace('0,10', '0,'),
      source.replace('0,10', '0,10.5'), source.replace('0,10,1,1', '0,10,1000000,1'), source.replace('0,10,1,1', '0,10,1,0'),
      source.replace('0,10', '-1,10'), source.replace('0,10', '0,Infinity')]) assert.throws(() => parsePlaqueGrowthCSV(text));
    for (const change of [{ count: NaN }, { dilution: 0 }, { timeMin: Infinity }, { count: -1 }, { volumeMl: 11 }, { extra: true }]) {
      assert.throws(() => fitPlaqueGrowth([{ ...plates()[0], ...change }, ...plates().slice(1)], options));
    }
  });
  it('enforces work limits and explicit options before fitting', () => {
    assert.throws(() => fitPlaqueGrowth(plates().slice(0, 5), options));
    assert.throws(() => fitPlaqueGrowth(Array.from({ length: 33 }, (_, timeMin) => ({ ...plates()[0], timeMin })), options), /6–32/);
    assert.throws(() => fitPlaqueGrowth(Array.from({ length: 2049 }, () => plates()[0]), options), /2048/);
    assert.throws(() => fitPlaqueGrowth(Array(9), options));
    for (const value of [{ ...options, supportDeviance: 0 }, { ...options, infectedCentersPerMl: 0 }, { ...options, moi: .1 }, {}]) {
      assert.throws(() => fitPlaqueGrowth(plates(), value as typeof options));
    }
  });
});

const bounded = (values = counts): CensoredGrowthPlate[] => plates(values).map(p => ({ ...p, countStatus: 'exact' }));
function boundedInput(rows = bounded()): PlaqueGrowthInput {
  return { ...input(), version: 2, csv: 'time_min,plaque_count,dilution_fraction,volume_ml,count_status\n'
    + rows.map(p => `${p.timeMin},${p.count},${p.dilution},${p.volumeMl},${p.countStatus}`).join('\n') + '\n' };
}
describe('inclusive censored plaque-count likelihood', () => {
  it('uses the actual discrete bound probabilities, including zero means and inclusive endpoints', () => {
    const logP = poissonCountLogProbability;
    close(Math.exp(logP(0, 2, 'at-most')), Math.exp(-2));
    close(Math.exp(logP(1, 2, 'at-least')), 1 - Math.exp(-2));
    close(Math.exp(logP(2, 2, 'at-least')), 1 - 3 * Math.exp(-2));
    close(Math.exp(logP(2, 2, 'at-most')), 5 * Math.exp(-2));
    close(Math.exp(logP(2, 2, 'exact')), 2 * Math.exp(-2));
    assert.equal(logP(0, 0, 'exact'), 0); assert.equal(logP(1, 0, 'at-most'), 0);
    assert.equal(logP(1, 0, 'at-least'), -Infinity); assert.equal(logP(0, 0, 'at-least'), 0);
    for (const k of [0, 1, 2, 16, 50, 1000]) for (const mean of [.001, 1, 17, 1000]) {
      close(Math.exp(logP(k, mean, 'at-most')) + Math.exp(logP(k + 1, mean, 'at-least')), 1, 2e-12);
    }
  });
  it('retains rare tails below probability underflow and agrees with independent 70-digit incomplete gamma values', () => {
    // mpmath gammainc/gamma, not the endpoint-mass recurrence used in production.
    close(poissonCountLogProbability(10000, 100, 'at-least'), -36157.215927617784, 2e-12);
    close(poissonCountLogProbability(1000, 10000, 'at-most'), -6701.682458338879, 2e-12);
    close(poissonCountLogProbability(1000000, 1000000, 'at-most'), -.6926153990082546, 2e-11);
    close(poissonCountLogProbability(1, 1e-8, 'at-least'), -18.420680748952364, 2e-12);
    for (const [count, mean] of [[1.5, 2], [-1, 2], [1, NaN], [1, -1], [1000001, 1]]) {
      assert.throws(() => poissonCountLogProbability(count, mean, 'exact'));
    }
    assert.throws(() => poissonCountLogProbability(1, 2, 'TNTC' as never));
  });
  it('matches an independent multistart SciPy likelihood fit and nuisance-profile Brent roots for mixed bounds/exposures', () => {
    const c = [5, 18, 9, 22, 48, 73, 29, 152, 86], e = [.5, 2, 1, 2, .8, 1.3, .4, 2.5, 1.4];
    const rows = bounded(c).map((p, i) => ({ ...p, volumeMl: e[i], countStatus: (i === 2 ? 'at-most' : i === 5 ? 'at-least' : 'exact') as CensoredGrowthPlate['countStatus'] }));
    const fit = fitCensoredPlaqueGrowth(rows, options);
    close(fit.backgroundPFUPerMl, 9.918719181509935); close(fit.increasePFUPerMl, 56.054993897146815);
    close(fit.deviance, 12.512925982802981); close(fit.increaseSupport[0][0], 48.48750184837084);
    close(fit.increaseSupport[0][1], 64.11999616837777);
    assert.deepEqual(fit.knotSupport.map(p => [p.startMin, p.endMin]), [[3, 5]]);
    assert(Math.abs(fit.increasePFUPerMl - fitPlaqueGrowth(plates(c).map((p, i) => ({ ...p, volumeMl: e[i] })), options).increasePFUPerMl) > 2,
      'Using a threshold as an exact count must not reproduce the censored likelihood.');
    assert.equal(fit.totalPlaques, null); assert.equal(fit.exactPlaques, 5 + 18 + 22 + 48 + 29 + 152 + 86);
    assert.deepEqual(fit.countCoverage, { exact: 7, atMost: 1, atLeast: 1 });
    assert.equal(fit.fitted[2].devianceResidual, null); assert.equal(fit.fitted[5].devianceResidual, null);
    close(fit.fitted[5].devianceContribution, -2 * poissonCountLogProbability(73, fit.fitted[5].expectedCount, 'at-least'));
  });
  it('reproduces the original exact-count estimates and support when all v2 statuses are exact', () => {
    const old = fitPlaqueGrowth(plates(), options), fresh = fitCensoredPlaqueGrowth(bounded(), options);
    for (const key of ['backgroundPFUPerMl', 'increasePFUPerMl', 'plateauPFUPerMl', 'deviance'] as const) close(fresh[key], old[key]);
    fresh.increaseSupport[0].forEach((x, i) => close(x, old.increaseSupport[0][i]));
    assert.equal(fresh.totalPlaques, old.totalPlaques); assert.equal(fresh.riseStartMin, 3);
    assert.deepEqual(fresh.countCoverage, { exact: 9, atMost: 0, atLeast: 0 });
  });
  it('retains positive upper support for all at-most-zero observations without inventing signed residuals or timing', () => {
    const fit = fitCensoredPlaqueGrowth(bounded(counts.map(() => 0)).map(p => ({ ...p, countStatus: 'at-most' })), options);
    assert.equal(fit.backgroundPFUPerMl, 0); assert.equal(fit.increasePFUPerMl, 0);
    assert.equal(fit.riseStartMin, null); assert.equal(fit.riseEndMin, null); assert.equal(fit.timingStatus, 'unresolved');
    close(fit.increaseSupport[0][1], 3.84 / 5);
    assert(fit.fitted.every(p => p.devianceResidual === null && p.devianceContribution === 0));
  });
  it('supports zero-background fits and finite plateaus with censored plateau observations', () => {
    const rows = bounded([0, 0, 0, 0, 100, 200, 200, 200, 200]);
    rows[6] = { ...rows[6], count: 180, countStatus: 'at-least' };
    rows[8] = { ...rows[8], count: 230, countStatus: 'at-most' };
    const fit = fitCensoredPlaqueGrowth(rows, options);
    assert.equal(fit.backgroundPFUPerMl, 0); assert(fit.increasePFUPerMl > 190 && fit.increasePFUPerMl < 210);
    assert(fit.increaseSupport[0][0] > 0); assert.equal(fit.riseStartMin, 3);
  });
  it('refuses potentially unbounded plateau designs instead of capping the fitted rate at a guessed maximum', () => {
    const rows = bounded().map(p => ({ ...p, countStatus: 'at-least' as const }));
    assert.throws(() => fitCensoredPlaqueGrowth(rows, options), /plateau may otherwise be unbounded/);
    const lastBounded = rows.map(p => ({ ...p })) as CensoredGrowthPlate[];
    lastBounded[7].countStatus = 'exact'; // Either of the last two times bounds every candidate rise.
    assert(Number.isFinite(fitCensoredPlaqueGrowth(lastBounded, options).plateauPFUPerMl));
  });
  it('preserves exposure rescaling, row permutation, and conditional yield without mutating inputs', () => {
    const rows = bounded(); rows[2].countStatus = 'at-most'; rows[5].countStatus = 'at-least';
    const original = structuredClone(rows), a = fitCensoredPlaqueGrowth(rows, options);
    assert.deepEqual(fitCensoredPlaqueGrowth([...rows].reverse(), options), a); assert.deepEqual(rows, original);
    const b = fitCensoredPlaqueGrowth(rows.map(p => ({ ...p, dilution: 1e-6, volumeMl: .1 })), options);
    close(b.increasePFUPerMl, a.increasePFUPerMl * 1e7); close(b.deviance, a.deviance);
    a.increaseSupport[0].forEach((x, i) => close(b.increaseSupport[0][i], x * 1e7));
    close(a.infectiousYieldPerInfectedCenter!, a.increasePFUPerMl / 2);
    assert.equal(fitCensoredPlaqueGrowth(rows, { ...options, infectedCentersPerMl: null }).yieldSupport, null);
  });
  it('uses explicit inclusive status fields and retains source row semantics through CSV and TSV parsing', () => {
    const rows = bounded(); rows[2].countStatus = 'at-most'; rows[5].countStatus = 'at-least';
    const text = boundedInput(rows).csv;
    assert.deepEqual(parsePlaqueGrowthCSV(text, 2), rows);
    assert.deepEqual(parsePlaqueGrowthCSV('\uFEFF# bounded observations\r\n' + text.replaceAll(',', '\t'), 2), rows);
    assert.throws(() => parsePlaqueGrowthCSV(text, 1)); assert.throws(() => parsePlaqueGrowthCSV(input().csv, 2));
    for (const status of ['', 'TNTC', '>=', 'at-least,extra', 'Exact']) assert.throws(() => parsePlaqueGrowthCSV(text.replace('exact', status), 2));
    assert.throws(() => fitCensoredPlaqueGrowth([{ ...rows[0], count: 0, countStatus: 'at-least' }, ...rows.slice(1)], options), /no count information/);
    assert.throws(() => fitCensoredPlaqueGrowth(Array(9), options));
  });
  it('bounds actual work and rejects invalid budgets without returning a partial result', () => {
    const rows = bounded(); rows[3].countStatus = 'at-most';
    assert.throws(() => fitCensoredPlaqueGrowth(rows, options, 50), /budget exhausted/);
    for (const value of [0, -1, 1.5, NaN, Infinity, 50000001]) assert.throws(() => fitCensoredPlaqueGrowth(rows, options, value), /budget/);
  });
  it('records bounds as observations, with unavailable totals/residuals and versioned replay, without reinterpreting v1', async () => {
    const rows = bounded(); rows[2].countStatus = 'at-most'; rows[5].countStatus = 'at-least';
    const source = boundedInput(rows); source.provenance.kind = 'user-supplied';
    const text = JSON.stringify(source, null, 2), record = await createPlaqueGrowthRecord(text);
    assert.equal(record.method.version, '2'); assert.equal(record.references[0].version, '2');
    assert.equal(record.inputs[0].data, text); assert.equal(record.fields.plates.kind, 'observation');
    assert.equal((record.fields.fit.value as unknown as CensoredPlaqueGrowthFit).totalPlaques, null);
    assert.deepEqual(await replayPlaqueGrowthRecord(serializeAnalysisRecord(record)), record);
    const tsv = exportPlaqueGrowthTsv(record); assert(tsv.includes('count_or_bound\tcount_status'));
    assert.equal(tsv, exportPlaqueGrowthTsv(await replayPlaqueGrowthRecord(serializeAnalysisRecord(record))));
    const line = tsv.split('\n').find(line => line.startsWith('2\t'))!.split('\t');
    assert.equal(line[2], 'at-most'); assert.equal(line[7], ''); assert(Number(line[8]) >= 0);
    const legacy = await createPlaqueGrowthRecord(JSON.stringify(input())); assert.equal(legacy.method.version, '1');
    await replayPlaqueGrowthRecord(serializeAnalysisRecord(legacy));
    assert.throws(() => parsePlaqueGrowthInput(JSON.stringify({ ...source, version: 1 })));
  });
  it('rejects rehashed changed bound semantics, numerical support and method versions on replay', async () => {
    const rows = bounded(); rows[2].countStatus = 'at-most';
    const record = await createPlaqueGrowthRecord(JSON.stringify(boundedInput(rows)));
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.plates.value as unknown as CensoredGrowthPlate[])[2].countStatus = 'exact'; },
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as CensoredPlaqueGrowthFit).fitted[2].devianceResidual = 0; },
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as CensoredPlaqueGrowthFit).increaseSupport = [[1, 2]]; },
      (r: AnalysisRecord) => { r.method.version = '1'; },
    ]) {
      const changed = await resign(record, change); await parseAnalysisRecord(changed);
      await assert.rejects(replayPlaqueGrowthRecord(changed), /Recomputed/);
    }
  });
});
describe('portable plate-count evidence', () => {
  it('requires the original CSV, exact assay declaration, explicit options and source attribution', () => {
    const value = input(); assert.deepEqual(parsePlaqueGrowthInput(JSON.stringify(value)), value);
    for (const change of [{ measurement: 'total-infective-centers' }, { measurement: 'PFU' }, { version: 2 }, { expected: {} },
      { csv: '/private/never-read.csv' }, { options: { supportDeviance: 3.84 } }, { provenance: { kind: 'measured', source: 'guess' } }]) {
      assert.throws(() => parsePlaqueGrowthInput(JSON.stringify({ ...value, ...change })));
    }
    assert.throws(() => parsePlaqueGrowthInput(' '.repeat(1_000_001)), /UTF-8/);
    assert.throws(() => parsePlaqueGrowthInput('é'.repeat(500_001)), /UTF-8/);
  });
  it('captures original bytes and replays all numerical evidence with identical record identity', async () => {
    const text = JSON.stringify(input(), null, 2), record = await createPlaqueGrowthRecord(text);
    assert.equal(record.inputs[0].data, text); assert.equal(record.fields.plates.kind, 'demo'); assert.equal(record.fields.fit.kind, 'demo');
    assert.deepEqual(await replayPlaqueGrowthRecord(serializeAnalysisRecord(record)), record);
    assert.deepEqual(await parseAnalysisRecord(serializeAnalysisRecord(record)), record);
    const fit = record.fields.fit.value as unknown as PlaqueGrowthFit; close(fit.infectiousYieldPerInfectedCenter!, 50);
  });
  it('labels author-supplied observations and model estimates separately without inventing confidence levels', async () => {
    const record = await createPlaqueGrowthRecord(JSON.stringify(input('user-supplied')));
    assert.equal(record.inputs[0].source, 'local'); assert.equal(record.fields.plates.kind, 'observation');
    const fit = record.fields.fit; assert.equal(fit.kind, 'fitted-estimate');
    if (fit.kind !== 'fitted-estimate') throw new Error('Expected fit');
    assert.deepEqual(fit.fit.uncertainty, { kind: 'not-estimated' }); // Support is not a calibrated interval.
    assert(fit.limitations.some(s => s.includes('no nominal confidence')));
  });
  it('rejects changed likelihoods, support, references and observations even with valid recalculated hashes', async () => {
    const record = await createPlaqueGrowthRecord(JSON.stringify(input()));
    for (const change of [
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as PlaqueGrowthFit).increasePFUPerMl = 999; },
      (r: AnalysisRecord) => { (r.fields.fit.value as unknown as PlaqueGrowthFit).increaseSupport = [[100, 100]]; },
      (r: AnalysisRecord) => { r.references[0].version = 'changed'; },
      (r: AnalysisRecord) => { r.parameters.supportDeviance = 10; },
      (r: AnalysisRecord) => { r.inputs[0].data = String(r.inputs[0].data).replace('0,10,1,1', '0,20,1,1'); },
    ]) {
      const text = await resign(record, change); await parseAnalysisRecord(text);
      await assert.rejects(replayPlaqueGrowthRecord(text), /Recomputed/);
    }
    await assert.rejects(replayPlaqueGrowthRecord(await resign(record, r => { r.method.version = '999'; })));
  });
  it('exports plate-level numerical residuals without free-text spreadsheet content', async () => {
    const value = input(); value.title = '=UNTRUSTED\tTITLE';
    const record = await createPlaqueGrowthRecord(JSON.stringify(value)), table = exportPlaqueGrowthTsv(record);
    assert(!table.includes('UNTRUSTED')); assert(!table.includes(value.provenance.source));
    assert.equal(table.trim().split('\n').length, 13); assert(table.includes('time_min\tplaque_count\tdilution_fraction\tvolume_ml'));
    assert(table.includes('likelihood support is not a calibrated confidence'));
    assert.equal(table, exportPlaqueGrowthTsv(await replayPlaqueGrowthRecord(serializeAnalysisRecord(record))));
  });
});
