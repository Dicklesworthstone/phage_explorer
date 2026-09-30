import { describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import {
  GROWTH_CURVE_METHOD, GROWTH_CURVE_LIMITS, fitOneStepGrowth,
  parseGrowthCurveCSV, parseGrowthCurveExperiment, serializeGrowthCurveExperiment,
  type GrowthCurveExperiment, type GrowthObservation,
} from './one-step-growth';

const rows: GrowthObservation[] = Array.from({ length: 11 }, (_, i) => ({
  timeMin: i * 5,
  pfuPerMl: 10 + 100 * Math.max(0, Math.min(1, (i * 5 - 15) / 15)),
}));
const csv = 'time_min,pfu_per_ml\n' + rows.map(row => `${row.timeMin},${row.pfuPerMl}`).join('\n');
const experiment: GrowthCurveExperiment = {
  schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml',
  title: 'Synthetic regression fixture',
  provenance: { kind: 'synthetic', source: 'Exact baseline/ramp/plateau function, not experimental data.' },
  observations: rows, options: { infectedCentersPerMl: 2, bootstrapSamples: 20, seed: 0 },
};
function near(actual: number | null, expected: number, tolerance = 1e-8): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

describe('measured growth-curve ingestion', () => {
  test('accepts CSV and retains measured units', () => assert.deepEqual(parseGrowthCurveCSV(csv), rows));
  test('accepts BOM, quoted cells, TSV, CRLF, and comments', () => {
    const text = '\ufeff# assay\r\n"time_min"\t"pfu_per_ml"\r\n' + rows.map(row => `"${row.timeMin}"\t"${row.pfuPerMl}"`).join('\r\n');
    assert.deepEqual(parseGrowthCurveCSV(text), rows);
  });
  test('accepts scientific notation and independent replicates at the same time', () => {
    const parsed = parseGrowthCurveCSV(csv + '\n0,1e1');
    assert.equal(parsed.length, rows.length + 1);
    assert.deepEqual(parsed.slice(0, 2), [rows[0], rows[0]]);
  });
  for (const cell of ['', 'NaN', 'Infinity', '0x10', '<10', '1_000', '1junk', '1,2']) {
    test(`rejects invalid/missing/censored cell ${JSON.stringify(cell)}`, () => assert.throws(() => parseGrowthCurveCSV(csv + `\n60,${cell}`), /Line 13/));
  }
  test('rejects a silent unit/type mismatch', () => assert.throws(() => parseGrowthCurveCSV(csv.replace('pfu_per_ml', 'OD600')), /two columns/));
  test('rejects negative measurements and times', () => {
    assert.throws(() => parseGrowthCurveCSV(csv + '\n60,-1'), /nonnegative/);
    assert.throws(() => parseGrowthCurveCSV(csv + '\n-1,10'), /nonnegative/);
  });
  test('rejects numeric overflow', () => assert.throws(() => parseGrowthCurveCSV(csv + '\n60,1e999'), /finite/));
  test('requires six distinct times, not just six replicates', () => assert.throws(() => fitOneStepGrowth(Array(6).fill(rows[0])), /distinct/));
  test('bounds file size, rows, and unique time count', () => {
    assert.throws(() => parseGrowthCurveCSV('x'.repeat(GROWTH_CURVE_LIMITS.bytes + 1)), /large/);
    assert.throws(() => fitOneStepGrowth(Array(GROWTH_CURVE_LIMITS.rows + 1).fill(rows[0])), /observations/);
    assert.throws(() => fitOneStepGrowth(Array.from({ length: 65 }, (_, i) => ({ timeMin: i, pfuPerMl: i }))), /distinct/);
  });
});

describe('bounded nonnegative grid-ramp fitting', () => {
  test('recovers a known baseline, rise, plateau, and independently normalized yield', () => {
    const fit = fitOneStepGrowth(rows, { infectedCentersPerMl: 2, bootstrapSamples: 0 });
    near(fit.baselinePFUPerMl, 10); near(fit.plateauPFUPerMl, 110); near(fit.increasePFUPerMl, 100);
    near(fit.riseStartMin, 15); near(fit.riseEndMin, 30); near(fit.infectiousYieldPerInfectedCenter, 50);
    near(fit.rSquared, 1); near(fit.rmsePFUPerMl, 0); assert.equal(fit.intervals, null);
  });
  test('preserves small rises against a large extracellular background', () => {
    const fit = fitOneStepGrowth(rows.map(row => ({ ...row, pfuPerMl: 1e9 + row.pfuPerMl })), { bootstrapSamples: 0 });
    near(fit.increasePFUPerMl, 100, 1e-7); near(fit.riseStartMin, 15); near(fit.riseEndMin, 30);
  });
  test('does not substitute initial PFU or hosts for infected centers', () => {
    const fit = fitOneStepGrowth(rows, { bootstrapSamples: 20 });
    assert.equal(fit.infectiousYieldPerInfectedCenter, null);
    assert.equal(fit.intervals?.infectiousYieldPerInfectedCenter, null);
    assert.ok(fit.warnings.some(warning => warning.includes('not a substitute')));
  });
  test('zero/constant/declining curves do not acquire a fictional rise', () => {
    for (const measurements of [rows.map(row => ({ ...row, pfuPerMl: 0 })), rows.map(row => ({ ...row, pfuPerMl: 10 })), rows.map((row, i) => ({ ...row, pfuPerMl: 100 - i }))]) {
      const fit = fitOneStepGrowth(measurements, { bootstrapSamples: 20 });
      assert.equal(fit.riseStartMin, null); assert.equal(fit.riseEndMin, null);
      assert.equal(fit.increasePFUPerMl, 0); assert.equal(fit.intervals?.riseStartMin, null);
    }
    assert.equal(fitOneStepGrowth(rows.map(row => ({ ...row, pfuPerMl: 10 })), { bootstrapSamples: 0 }).rSquared, null);
  });
  test('solves the zero-baseline nonnegative boundary', () => {
    const fit = fitOneStepGrowth(rows.map(row => ({ ...row, pfuPerMl: row.pfuPerMl - 10 })), { bootstrapSamples: 0 });
    near(fit.baselinePFUPerMl, 0); near(fit.increasePFUPerMl, 100);
  });
  test('handles irregular sampling, not array-index timing', () => {
    const irregular = [0, 2, 8, 11, 17, 28, 35, 49, 70].map(timeMin => ({ timeMin, pfuPerMl: 7 + 80 * Math.max(0, Math.min(1, (timeMin - 8) / 27)) }));
    const fit = fitOneStepGrowth(irregular, { bootstrapSamples: 0 });
    near(fit.riseStartMin, 8); near(fit.riseEndMin, 35); near(fit.increasePFUPerMl, 80);
  });
  test('is input-order independent and does not mutate caller-owned data', () => {
    const original = rows.map(row => Object.freeze({ ...row })).reverse();
    const before = JSON.stringify(original); Object.freeze(original);
    assert.deepEqual(fitOneStepGrowth(original, { seed: 0, bootstrapSamples: 20 }), fitOneStepGrowth(rows, { seed: 0, bootstrapSamples: 20 }));
    assert.equal(JSON.stringify(original), before);
  });
  test('is scale invariant over small and very large finite concentrations', () => {
    for (const factor of [1e-120, 1e120]) {
      const fit = fitOneStepGrowth(rows.map(row => ({ ...row, pfuPerMl: row.pfuPerMl * factor })), { bootstrapSamples: 0 });
      near(fit.baselinePFUPerMl / factor, 10); near(fit.increasePFUPerMl / factor, 100);
      near(fit.riseStartMin, 15); near(fit.riseEndMin, 30);
    }
  });
  test('reports insufficient plateau/baseline coverage at the design boundary', () => {
    const fit = fitOneStepGrowth(rows.map(row => ({ ...row, pfuPerMl: row.timeMin })), { bootstrapSamples: 0 });
    assert.ok(fit.warnings.some(warning => warning.includes('boundary')));
  });
  test('bootstrap is reproducible with seed zero and changes with a different seed', () => {
    const noisy = rows.map((row, i) => ({ ...row, pfuPerMl: row.pfuPerMl + (i % 3 - 1) * 4 }));
    const first = fitOneStepGrowth(noisy, { seed: 0, bootstrapSamples: 100 });
    assert.deepEqual(first, fitOneStepGrowth(noisy, { seed: 0, bootstrapSamples: 100 }));
    assert.notDeepEqual(first.intervals, fitOneStepGrowth(noisy, { seed: 1, bootstrapSamples: 100 }).intervals);
    for (const interval of Object.values(first.intervals!)) if (interval) assert.ok(Number.isFinite(interval[0]) && interval[0] <= interval[1]);
  });
  for (const options of [{ infectedCentersPerMl: 0 }, { infectedCentersPerMl: -1 }, { infectedCentersPerMl: Infinity }, { bootstrapSamples: 1 }, { bootstrapSamples: 201 }, { bootstrapSamples: 20.5 }, { seed: -1 }, { seed: 2 ** 32 }, { seed: NaN }]) {
    test(`rejects invalid fitting options ${JSON.stringify(options)}`, () => assert.throws(() => fitOneStepGrowth(rows, options)));
  }
});

describe('versioned experiments and replay', () => {
  test('exports self-contained inputs and recomputable results', () => {
    const saved = serializeGrowthCurveExperiment(experiment);
    const loaded = parseGrowthCurveExperiment(saved);
    assert.deepEqual(loaded, experiment);
    assert.deepEqual(JSON.parse(saved).result, fitOneStepGrowth(loaded.observations, loaded.options));
    assert.equal(serializeGrowthCurveExperiment(loaded), saved);
  });
  test('does not trust a tampered cached result', () => {
    const saved = JSON.parse(serializeGrowthCurveExperiment(experiment));
    saved.result = { infectiousYieldPerInfectedCenter: 99999 };
    const loaded = parseGrowthCurveExperiment(JSON.stringify(saved));
    near(fitOneStepGrowth(loaded.observations, loaded.options).infectiousYieldPerInfectedCenter, 50);
  });
  test('rejects ambiguous or total-infective-center assay identity', () => {
    assert.throws(() => parseGrowthCurveExperiment(JSON.stringify({ ...experiment, measurement: undefined })), /extracellular/);
    assert.throws(() => parseGrowthCurveExperiment(JSON.stringify({ ...experiment, measurement: 'total-infective-centers' })), /extracellular/);
  });
  test('preserves synthetic provenance and seed zero', () => {
    const loaded = parseGrowthCurveExperiment(serializeGrowthCurveExperiment(experiment));
    assert.equal(loaded.provenance.kind, 'synthetic'); assert.equal(loaded.options.seed, 0);
  });
  test('rejects unknown versions, missing provenance/options, malformed rows, and nonobjects', () => {
    for (const changed of [{ ...experiment, method: 'future-v99' }, { ...experiment, schemaVersion: 'future-v99' }, { ...experiment, provenance: {} }, { ...experiment, options: { seed: 0 } }, { ...experiment, observations: [null, ...rows] }, { ...experiment, title: ' ' }, null, []]) {
      assert.throws(() => parseGrowthCurveExperiment(JSON.stringify(changed)));
    }
  });
  test('changing saved data or denominator actually changes the replay', () => {
    const changed = { ...experiment, options: { ...experiment.options, infectedCentersPerMl: 4 } };
    const loaded = parseGrowthCurveExperiment(serializeGrowthCurveExperiment(changed));
    near(fitOneStepGrowth(loaded.observations, loaded.options).infectiousYieldPerInfectedCenter, 25);
  });
});
