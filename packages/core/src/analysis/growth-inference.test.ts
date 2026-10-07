import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../analysis-result';
import { DEFAULT_GROWTH_CONDITIONS, GROWTH_PARAMETERS, GROWTH_BOUNDS, GROWTH_LIMITS, validateGrowthDataset, parseGrowthData,
  resolveGrowthOptions, simulateGrowth, fitGrowthDataset, createGrowthRecord, replayGrowthRecord, growthLogNormalCdf, growthObservationResidual,
  type GrowthDataset, type GrowthConditions, type GrowthMeasurement } from './growth-inference';

// Independent SciPy 1.17 solve_ivp(method='DOP853', rtol=1e-12, atol=1e-7).
// y=[B,I1,I2,I3,P], y0=[1e7,0,0,0,1e5], a=2e-9*B*P, g=3/20:
// dy=[.005*B-a,a-g*I1,g*(I1-I2),g*(I2-I3),35*g*I3-a-.002*P].
// No production solver or fitter generated these expected values.
const oracle = [
  [0,10000000,100000,0,.0125],
  [5,10243365.688072033,93280.94372026029,9551.265823665317,.012816146192369622],
  [10,10491982.40966677,118586.96354245362,19065.266356034,.013138809595028503],
  [15,10740933.441461252,202532.353341776,32618.84376859328,.013466940356537307],
  [20,10982460.908055,365671.1188761933,57061.04889806161,.013799402446191327],
  [25,11204799.851815766,652430.7256915687,102211.64797897878,.01413376437474343],
  [30,11387615.446612658,1159277.719087575,184331.86281020744,.014464934136778582],
  [40,11458833.99430788,3706946.7041725204,598256.2911443221,.015071362856815252],
  [50,10460237.0643752,12003115.608275421,1866444.2170806192,.015408351601819774],
  [60,6980213.60355128,38230272.161794186,4920792.159401211,.014876257203690612],
  [70,1858838.6444297095,108981059.77823624,8045747.629575333,.012380732842506303],
  [80,68776.9335401689,230184889.17843506,6257566.3867235035,.00790792915032959],
];
const truth = { adsorptionRate: 2e-9, latentPeriod: 20, burstSize: 35 };
const conditions: GrowthConditions = { ...DEFAULT_GROWTH_CONDITIONS, stages: 3, bacterialGrowthRate: .005, phageDecayRate: .002 };
function dataset(types: GrowthMeasurement[] = ['PFU', 'CFU', 'OD']): GrowthDataset {
  return validateGrowthDataset({ format: 'phage-explorer-growth', version: 1, name: 'Independent numerical fixture',
    source: { kind: 'demo', description: 'Synthetic DOP853 reference; not experimental data', reference: null }, conditions,
    observations: oracle.flatMap(([timeMin, bacteria, phage, _infected, od]) => types.map(type => ({
      timeMin, type, value: type === 'PFU' ? phage : type === 'CFU' ? bacteria : od, sigma: type === 'OD' ? .001 : .03,
    }))) });
}
const options = () => resolveGrowthOptions({ initial: { adsorptionRate: 1e-9, latentPeriod: 32, burstSize: 55 }, starts: 3, seed: 0 });
const near = (actual: number, expected: number, tolerance: number) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected} (tolerance ${tolerance})`);

describe('mechanistic growth model and inverse fit', () => {
  it('agrees with an independent high-accuracy solver for every population and observable', () => {
    const actual = simulateGrowth(truth, conditions, oracle.map(row => row[0]), 1e-8);
    for (let i = 0; i < actual.length; i++) {
      const [time, bacteria, phage, infected, od] = oracle[i];
      near(actual[i].timeMin, time, 0);
      for (const [got, want] of [[actual[i].bacteria,bacteria], [actual[i].phage,phage], [actual[i].infected,infected], [actual[i].od,od]]) {
        near(got, want, Math.max(1e-10, Math.abs(want) * 4e-7));
      }
    }
  });
  it('satisfies exact no-infection exponential growth and free-phage decay limits', () => {
    const growth = simulateGrowth({ ...truth, adsorptionRate: 0 }, conditions, [0,13,71]);
    for (const row of growth) {
      near(row.bacteria, conditions.initialBacteria * Math.exp(.005 * row.timeMin), 1e-3);
      near(row.phage, conditions.initialPhage * Math.exp(-.002 * row.timeMin), 1e-5);
      assert.equal(row.infected, 0);
    }
  });
  it('matches the analytic mass-action adsorption solution without phage production', () => {
    const c = { ...conditions, bacterialGrowthRate: 0, phageDecayRate: 0 };
    const delta = c.initialBacteria - c.initialPhage;
    const trajectory = simulateGrowth({ ...truth, burstSize: 0 }, c, [0,5,20,55], 1e-8);
    for (const row of trajectory) {
      const e = Math.exp(-truth.adsorptionRate * delta * row.timeMin);
      const phage = delta * c.initialPhage * e / (c.initialBacteria - c.initialPhage * e);
      near(row.phage, phage, Math.max(1e-3,phage*1e-7));
      near(row.bacteria - row.phage, delta, 1e-5);
    }
  });
  it('makes PFU trajectories respond to adsorption, unlike the old sigmoid path', () => {
    const slow = simulateGrowth({ ...truth, adsorptionRate: 1e-12 }, conditions, [20,40,80]);
    const fast = simulateGrowth({ ...truth, adsorptionRate: 1e-8 }, conditions, [20,40,80]);
    assert.ok(fast[1].phage > 10 * slow[1].phage);
  });
  it('honors stage count and exact unordered/duplicate observation times without aliasing', () => {
    const points = simulateGrowth(truth, conditions, [30,0,5,30]);
    assert.deepEqual(points[0], points[3]); assert.notStrictEqual(points[0], points[3]);
    assert.equal(points[1].phage, conditions.initialPhage);
    const exponential = simulateGrowth(truth, { ...conditions, stages: 1 }, [5]);
    assert.ok(Math.abs(exponential[0].phage - points[2].phage) > 1000);
  });
  it('rejects invalid solver domains and enforces the shared computation budget', () => {
    for (const t of [-1,NaN,Infinity,181]) assert.throws(() => simulateGrowth(truth, conditions, [t]));
    assert.throws(() => simulateGrowth(truth, { ...conditions, stages: 0 }, [5]));
    assert.throws(() => simulateGrowth({ ...truth, adsorptionRate: -1 }, conditions, [5]));
    assert.throws(() => simulateGrowth(truth, conditions, [10], 1e-6, { steps: GROWTH_LIMITS.fitSteps }), /budget/);
    // Fast dynamics are valid if the solver can resolve them within its budget.
    const fast = simulateGrowth({ adsorptionRate: 1e-7, latentPeriod: 1, burstSize: 1000 },
      { ...conditions, initialBacteria: 1e9, initialPhage: 1e9 }, [180]);
    assert.ok(fast.every(row => Object.values(row).every(value => Number.isFinite(value) && value >= 0)));
  });
  it('recovers all three planted parameters from joint independent observations', () => {
    const result = fitGrowthDataset(dataset(), options());
    assert.equal(result.converged, true); assert.equal(result.sensitivityRank, 3);
    assert.ok(result.sensitivityCondition! < 100); assert.ok(result.objective < 1e-6);
    assert.ok(result.solverDiscrepancySigma < .001);
    for (const key of GROWTH_PARAMETERS) {
      near(result.parameters[key], truth[key], truth[key] * 2e-5);
      assert.equal(result.estimates[key].status, 'locally-estimable');
      const interval = result.estimates[key].interval95!;
      assert.ok(interval[0] < truth[key] && interval[1] > truth[key]);
    }
  });
  it('supports one-parameter estimation and never calls fixed guesses estimated', () => {
    const fit = fitGrowthDataset(dataset(), resolveGrowthOptions({ initial: { ...truth, adsorptionRate: 6e-10 }, freeParameters: ['adsorptionRate'], starts: 1 }));
    near(fit.parameters.adsorptionRate, truth.adsorptionRate, truth.adsorptionRate * 2e-5);
    assert.equal(fit.estimates.latentPeriod.status, 'fixed');
    assert.equal(fit.estimates.latentPeriod.interval95, null);
  });
  it('withholds intervals for observations insensitive to all infection parameters', () => {
    const data = dataset(['PFU']); data.conditions.initialBacteria = 0;
    data.observations.forEach(row => { row.value = conditions.initialPhage * Math.exp(-conditions.phageDecayRate * row.timeMin); });
    const fit = fitGrowthDataset(data, options());
    assert.equal(fit.sensitivityRank, 0); assert.equal(fit.sensitivityCondition, null);
    for (const estimate of Object.values(fit.estimates)) {
      assert.equal(estimate.interval95, null); assert.equal(estimate.status, 'unresolved'); assert.match(estimate.reason, /rank deficient/);
    }
  });
  it('does not infer infection parameters from OD before the latent-stage response is observable', () => {
    const data = dataset(['OD']);
    data.conditions = { ...conditions, stages: 8, bacterialGrowthRate: 0 };
    // With a 50-minute mean and eight stages, the Erlang CDF at .05 minutes
    // is bounded by (.008)^8/8!, before even accounting for infection timing.
    // Adsorption alone conserves B + I, so these early OD values carry no
    // measurable information about k, L or burst yield at the supplied SD.
    data.observations = [0,.01,.02,.03,.04,.05].map(timeMin => ({ timeMin, type: 'OD',
      value: data.conditions.initialBacteria / data.conditions.odCellsPerMl, sigma: .0001 }));
    const fit = fitGrowthDataset(data, resolveGrowthOptions({ initial: { ...truth, latentPeriod: 50 }, starts: 1 }));
    assert.ok(fit.sensitivityRank < 3);
    for (const estimate of Object.values(fit.estimates)) {
      assert.equal(estimate.interval95, null); assert.equal(estimate.status, 'unresolved');
    }
  });
  it('withholds unconstrained intervals when a fitted parameter reaches a bound', () => {
    const data = dataset(['PFU','CFU']);
    const trajectory = simulateGrowth({ ...truth, burstSize: 0 }, conditions, data.observations.map(row => row.timeMin), 1e-8);
    data.observations.forEach((row,i) => { row.value = row.type === 'PFU' ? trajectory[i].phage : trajectory[i].bacteria; });
    const fit = fitGrowthDataset(data, resolveGrowthOptions({ initial: { ...truth, burstSize: 2 }, freeParameters: ['burstSize'], starts: 1 }));
    near(fit.parameters.burstSize, GROWTH_BOUNDS.burstSize[0], 1e-6);
    assert.equal(fit.estimates.burstSize.interval95, null);
    assert.match(fit.estimates.burstSize.reason, /bound/);
  });
  it('records nonconvergence rather than declaring a finite objective optimal', () => {
    const fit = fitGrowthDataset(dataset(), resolveGrowthOptions({ initial: { adsorptionRate: 1e-12, latentPeriod: 170, burstSize: 2 }, starts: 1, maxIterations: 10 }));
    assert.equal(fit.converged, false);
    for (const estimate of Object.values(fit.estimates)) assert.equal(estimate.interval95, null);
  });
  it('uses the declared noise scale in both the objective and interval width', () => {
    const a = dataset(), b = dataset(); b.observations.forEach(row => { row.sigma *= 2; });
    const first = fitGrowthDataset(a, options()), second = fitGrowthDataset(b, options());
    for (const key of GROWTH_PARAMETERS) {
      const ci1 = first.estimates[key].interval95!, ci2 = second.estimates[key].interval95!;
      near(Math.log(ci2[1]/ci2[0]) / Math.log(ci1[1]/ci1[0]), 2, .001);
    }
  });
  it('replicating independent measurements four times halves local log-interval width', () => {
    const a = dataset(), b = dataset(); b.observations = Array.from({ length: 4 }, () => structuredClone(a.observations)).flat();
    const first = fitGrowthDataset(a, options()), second = fitGrowthDataset(b, options());
    for (const key of GROWTH_PARAMETERS) {
      const ci1 = first.estimates[key].interval95!, ci2 = second.estimates[key].interval95!;
      near(Math.log(ci2[1]/ci2[0]) / Math.log(ci1[1]/ci1[0]), .5, .001);
    }
  });
  it('checks nominal coverage over 60 seeded known-noise synthetic repetitions, not every interval', () => {
    // Predeclared broad binomial acceptance: 50..60 of 60 per parameter at nominal .95.
    // This is a local model-correct numerical check, not experimental calibration.
    let cursor = 81723;
    const random = () => { cursor = (Math.imul(cursor, 1103515245) + 12345) >>> 0; return (cursor + .5) / 2**32; };
    const counts = Object.fromEntries(GROWTH_PARAMETERS.map(k => [k,0])) as Record<typeof GROWTH_PARAMETERS[number], number>;
    for (let i = 0; i < 60; i++) {
      const data = dataset(['PFU','CFU']);
      data.observations.forEach(row => {
        row.sigma = .01;
        const z = Math.sqrt(-2*Math.log(random())) * Math.cos(2*Math.PI*random());
        row.value *= 10 ** (row.sigma * z);
      });
      const fit = fitGrowthDataset(data, resolveGrowthOptions({ initial: truth, starts: 1 }));
      for (const k of GROWTH_PARAMETERS) {
        const ci = fit.estimates[k].interval95;
        if (ci && ci[0] <= truth[k] && ci[1] >= truth[k]) counts[k]++;
      }
    }
    for (const k of GROWTH_PARAMETERS) assert.ok(counts[k] >= 50 && counts[k] <= 60, `${k}: ${counts[k]}/60`);
  });
  it('reports gross observation/model mismatch without bounded confidence claims', () => {
    const data = dataset(); data.observations[12].value *= 100;
    const fit = fitGrowthDataset(data, options());
    assert.ok(fit.objective / fit.degreesOfFreedom > 4);
    for (const e of Object.values(fit.estimates)) assert.equal(e.interval95, null);
  });
  it('is reproducible for a seed and leaves input datasets and options unchanged', () => {
    const data = dataset(), config = options(), before = structuredClone({ data, config });
    assert.deepEqual(fitGrowthDataset(data, config), fitGrowthDataset(data, config));
    assert.deepEqual({ data, config }, before);
  });
});

describe('growth data and portable evidence', () => {
  const csv = 'timeMin,type,value,sigma\n0,PFU,100000,.03\n5,PFU,93280,.03\n10,PFU,118586,.03\n15,PFU,202532,.03\n20,PFU,365671,.03\n25,PFU,652430,.03\n';
  it('parses explicit numeric units and retains ordered replicate measurements', () => {
    const parsed = parseGrowthData('\uFEFF'+csv, 'local.csv', conditions);
    assert.equal(parsed.source.kind, 'local'); assert.equal(parsed.observations.length, 6);
    assert.equal(parsed.conditions.stages, 3);
    assert.deepEqual(parseGrowthData(csv.replaceAll(',', '\t'), 'local.csv', conditions), parsed);
    assert.deepEqual(parseGrowthData(JSON.stringify(parsed), 'ignored', DEFAULT_GROWTH_CONDITIONS), parsed);
  });
  it('rejects unlabeled zeros, mixed/unknown-unit, blank and malformed observations instead of silently guessing', () => {
    for (const replacement of ['0','-1','NaN','Infinity','NA','']) assert.throws(() => parseGrowthData(csv.replace('100000', replacement), 'bad', conditions));
    assert.throws(() => parseGrowthData(csv.replace('PFU','pfu/ml'), 'bad', conditions), /type/);
    assert.throws(() => parseGrowthData(csv.replace('100000,.03','100000,0'), 'bad', conditions), /SD/);
    assert.throws(() => parseGrowthData(csv.replace('timeMin','hours'), 'bad', conditions), /header/);
    const data = dataset(); data.observations[0].sigma = NaN;
    assert.throws(() => validateGrowthDataset(data));
  });
  it('rejects unsupported options, limits, and duplicate fitted parameter declarations', () => {
    for (const options of [{ freeParameters: [] }, { freeParameters: ['burstSize','burstSize'] }, { fit: 'eval' }, { seed: -1 }, { starts: 6 }, { maxIterations: Infinity }]) {
      assert.throws(() => resolveGrowthOptions(options));
    }
    for (const key of GROWTH_PARAMETERS) assert.throws(() => resolveGrowthOptions({ initial: { ...truth, [key]: GROWTH_BOUNDS[key][1] * 2 } }));
  });
  it('exports, recomputes and verifies complete method/input/result identity', async () => {
    const data = dataset(), config = options(), fit = fitGrowthDataset(data, config);
    const record = await createGrowthRecord(data, config, fit);
    assert.equal(record.fields.estimates.kind, 'demo');
    const replay = await replayGrowthRecord(serializeAnalysisRecord(record));
    assert.deepEqual(replay.result, fit); assert.equal(replay.record.resultId, record.resultId);
    const local = { ...data, source: { kind: 'local' as const, description: 'User-provided assay', reference: 'User-provided identifier, not independently checked' } };
    const observed = await createGrowthRecord(local, config, fit);
    assert.equal(observed.fields.estimates.kind, 'fitted-estimate');
    assert.notEqual(observed.cacheKey, record.cacheKey);
  });
  it('rejects raw tampering and valid-checksum forged estimates on fresh recomputation', async () => {
    const data = dataset(), config = options();
    const record = await createGrowthRecord(data, config, fitGrowthDataset(data, config));
    const changed = JSON.parse(serializeAnalysisRecord(record)); changed.seed++;
    await assert.rejects(replayGrowthRecord(JSON.stringify(changed)), /identity differs/);
    const forged = await parseAnalysisRecord(serializeAnalysisRecord(record));
    (forged.fields.estimates.value as Record<string, AnalysisJson>).burstSize = { value:999, interval95:[998,1000] };
    const resigned = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({sha256:_sha,...input})=>input) });
    await assert.rejects(replayGrowthRecord(serializeAnalysisRecord(resigned)), /Fresh growth fit differs/);
  });
  it('rejects an incompatible reference version even when its checksums are valid', async () => {
    const data = dataset(), config = options(), record = await createGrowthRecord(data, config, fitGrowthDataset(data, config));
    record.references[0].version = 'other';
    const changed = await createAnalysisRecord({ ...record, inputs: record.inputs.map(({sha256:_sha,...input})=>input) });
    await assert.rejects(replayGrowthRecord(serializeAnalysisRecord(changed)), /contract differs/);
  });
});

describe('explicit left-censored extracellular and colony counts', () => {
  function censoredDataset(): GrowthDataset {
    const data = dataset(['PFU', 'CFU']);
    data.observations = data.observations.map(row => row.type === 'PFU' && row.value < 120000
      ? { ...row, value: 120000, censoring: 'left' } : row);
    return validateGrowthDataset(data);
  }
  it('matches independent SciPy log_ndtr values in the center and extreme tails without probability clipping', () => {
    // SciPy special.log_ndtr, independent of our series/continued-fraction implementation.
    for (const [z, expected] of [
      [-100, -5005.524208694205], [-40, -804.6084420137539], [-20, -203.9171553710973],
      [-8, -35.01343715991456], [-3, -6.60772622151035], [-2, -3.7831843336820317],
      [-1.999999, -3.7831819604669423], [-1, -1.8410216450092634], [0, -Math.LN2],
      [.1, -.6165050101150262], [1, -.1727537790234499], [1.999999, -.02301296457688293],
      [2, -.023012909328963476], [3, -.0013508099647481925], [8, -6.220960574271742e-16],
      [20, -2.7536241186061556e-89],
    ]) near(growthLogNormalCdf(z), expected, Math.abs(expected) * 5e-14);
    near(growthLogNormalCdf(-1000000), -500000000014.73456, .0002);
    assert.equal(growthLogNormalCdf(Infinity), 0); assert.equal(growthLogNormalCdf(-Infinity), -Infinity);
    assert.throws(() => growthLogNormalCdf(NaN));
  });
  it('uses event probability, never a residual to an imputed limit or zero', () => {
    const row = { timeMin: 10, type: 'PFU' as const, value: 100, sigma: .1, censoring: 'left' as const };
    near(growthObservationResidual(row, 100) ** 2, 2 * Math.LN2, 1e-14);
    near(growthObservationResidual(row, 10 ** 3) ** 2, 106.46257030102496, 1e-11); // -2 log Phi(-10), SciPy.
    assert.ok(growthObservationResidual(row, 1) < 1e-40);
    assert.equal(growthObservationResidual(row, 0), 0);
    const { censoring: _censoring, ...exact } = row;
    assert.equal(growthObservationResidual(exact, 100), 0);
    assert.throws(() => growthObservationResidual(exact, 0), /positive/i);
    assert.throws(() => growthObservationResidual({ ...row, type: 'OD' }, .1), /PFU/);
    assert.throws(() => growthObservationResidual(row, -1));
    assert.throws(() => growthObservationResidual(row, Infinity));
  });
  it('imports explicit per-row censoring in CSV/TSV and preserves the positive limit through JSON', () => {
    const csv = 'timeMin,type,value,sigma,censoring\n0,PFU,120000,.03,left\n5,CFU,1e7,.03,none\n10,PFU,120000,.03,left\n15,CFU,1e7,.03,none\n20,PFU,3e5,.03,none\n20,PFU,3e5,.03,left';
    const data = parseGrowthData(csv, 'count-limits.csv', conditions);
    assert.deepEqual(data.observations[0], { timeMin: 0, type: 'PFU', value: 120000, sigma: .03, censoring: 'left' });
    assert.equal(data.observations[1].censoring, undefined);
    assert.equal(data.observations.filter(row => row.timeMin === 20).length, 2);
    assert.deepEqual(parseGrowthData(csv.replaceAll(',', '\t'), 'count-limits.csv', conditions), data);
    assert.deepEqual(parseGrowthData(JSON.stringify(data), 'ignored', DEFAULT_GROWTH_CONDITIONS), data);
    for (const value of ['right', 'unknown', '', '0']) assert.throws(() => parseGrowthData(csv.replace(',left', `,${value}`), 'bad', conditions), /none or left/);
    assert.throws(() => parseGrowthData(csv.replace('0,PFU,120000', '0,PFU,0'), 'bad', conditions), /positive detection limit/);
    assert.throws(() => parseGrowthData(csv.replace('0,PFU,120000', '0,OD,.1'), 'bad', conditions), /PFU\/CFU/);
    const malformed = censoredDataset() as unknown as { observations: Array<Record<string, unknown>> };
    malformed.observations[0].censoring = null;
    assert.throws(() => validateGrowthDataset(malformed), /left-censored/);
  });
  it('recovers the independent censored-likelihood optimum and withholds inappropriate Wald precision', () => {
    // SciPy DOP853 (rtol=2e-12, atol=1e-7) + Nelder-Mead in log(k,L,b),
    // xatol=fatol=1e-11. Joint PFU/CFU fixture, PFU below 120000 censored,
    // sigma=.03, objective exact squared residuals plus -2 scipy.special.log_ndtr.
    // This oracle does not call the production RK4, optimizer or CDF implementation.
    const data = censoredDataset(), before = structuredClone(data), result = fitGrowthDataset(data, options());
    assert.equal(result.converged, true);
    const expected = { adsorptionRate: 2.000317734388928e-9, latentPeriod: 20.278954386759395, burstSize: 35.65055269551192 };
    for (const key of GROWTH_PARAMETERS) {
      near(result.parameters[key], expected[key], expected[key] * 5e-5);
      assert.equal(result.estimates[key].interval95, null);
      assert.match(result.estimates[key].reason, /Censored likelihood/);
    }
    near(result.objective, 1.1002942961782112, 2e-6);
    assert.equal(result.censoring?.censoredObservations, 3);
    assert.equal(result.censoring?.quantifiedObservations, 21);
    assert.equal(result.censoring?.quantifiedSensitivityRank, 3);
    for (const row of result.residuals.filter(row => row.censoring === 'left')) {
      assert.equal(row.value, 120000); assert.equal(row.standardizedResidual, null);
      assert.ok(row.likelihoodDeviance! > 0);
    }
    near(result.residuals.reduce((total, row) => total + (row.likelihoodDeviance ?? row.standardizedResidual! ** 2), 0), result.objective, 1e-12);
    assert.deepEqual(data, before);
  });
  it('retains zero-population, all-censored fits as unidentifiable rather than inventing concentrations', () => {
    const data = censoredDataset(); data.conditions.initialBacteria = 0; data.conditions.initialPhage = 0;
    data.observations = data.observations.map(row => ({ ...row, value: 100, censoring: 'left' }));
    const fit = fitGrowthDataset(data, resolveGrowthOptions({ starts: 1 }));
    assert.equal(fit.objective, 0); assert.equal(fit.sensitivityRank, 0);
    assert.equal(fit.censoring?.quantifiedObservations, 0);
    for (const row of fit.residuals) { assert.equal(row.predicted, 0); assert.equal(row.standardizedResidual, null); }
    for (const estimate of Object.values(fit.estimates)) { assert.equal(estimate.interval95, null); assert.equal(estimate.status, 'unresolved'); }
  });
  it('exports and verifies censored fits as v2 while refusing semantic downgrades and changed limits', async () => {
    const data = censoredDataset(), settings = options(), fit = fitGrowthDataset(data, settings);
    const record = await createGrowthRecord(data, settings, fit);
    assert.equal(record.method.version, '2'); assert.equal(record.references[1].version, '2');
    const replay = await replayGrowthRecord(serializeAnalysisRecord(record));
    assert.deepEqual(replay.result, fit); assert.equal(replay.record.resultId, record.resultId);
    const downgraded = await createAnalysisRecord({ ...record, method: { ...record.method, version: '1' },
      inputs: record.inputs.map(({ sha256: _sha, ...input }) => input) });
    await assert.rejects(replayGrowthRecord(serializeAnalysisRecord(downgraded)), /contract differs/);
    const changed = structuredClone(data); changed.observations[0].value *= 2;
    const forged = await createGrowthRecord(changed, settings, fit);
    await assert.rejects(replayGrowthRecord(serializeAnalysisRecord(forged)), /Fresh growth fit differs/);
  });
  it('preserves the known exact-only v1 result identity captured before censoring support', async () => {
    const data = parseGrowthData('timeMin,type,value,sigma\n0,PFU,100000,.1\n5,PFU,95000,.1\n10,PFU,120000,.1\n15,PFU,200000,.1\n20,PFU,350000,.1\n30,PFU,1000000,.1', 'uncensored-v1-regression.csv', DEFAULT_GROWTH_CONDITIONS);
    const settings = resolveGrowthOptions({ starts: 1, freeParameters: ['burstSize'] });
    const record = await createGrowthRecord(data, settings, fitGrowthDataset(data, settings));
    assert.equal(record.method.version, '1');
    assert.equal(record.resultId, 'd2d508e8f9943658f10084ddc7b50d1931d9d81a8ab6283281ab16e9b9444115');
    assert.equal((await replayGrowthRecord(serializeAnalysisRecord(record))).record.resultId, record.resultId);
  });
});
