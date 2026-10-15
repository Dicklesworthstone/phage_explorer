/**
 * Descriptive analysis of dilution-corrected EXTRACELLULAR phage PFU/mL data.
 * Total infective-center titers are a different assay and must not be mixed in.
 *
 * Fits a nonnegative baseline + linear rise + plateau by least squares. Knots
 * are restricted to observed times; this is NOT a mechanistic infection model.
 * Timing estimates describe the population curve, not individual-cell latency.
 * Yield requires an independently measured infected-center concentration, not
 * initial PFU, MOI, or total host concentration.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisField, type AnalysisRecord, type ObservationUnits } from '../analysis-result';

export const GROWTH_CURVE_METHOD = 'nonnegative-grid-ramp-v1' as const;
export const GROWTH_CURVE_LIMITS = { rows: 2048, times: 64, bootstrap: 200, bytes: 1_000_000 } as const;

export interface GrowthObservation {
  timeMin: number;
  pfuPerMl: number;
}

export interface GrowthFitOptions {
  infectedCentersPerMl: number | null;
  bootstrapSamples: number;
  seed: number;
}

export interface GrowthCurveExperiment {
  schemaVersion: 'one-step-growth-v1';
  method: typeof GROWTH_CURVE_METHOD;
  measurement: 'extracellular-pfu-per-ml';
  title: string;
  provenance: { kind: 'user-supplied' | 'synthetic'; source: string };
  observations: GrowthObservation[];
  options: GrowthFitOptions;
}

export interface GrowthEstimates {
  baselinePFUPerMl: number;
  plateauPFUPerMl: number;
  increasePFUPerMl: number;
  riseStartMin: number | null;
  riseEndMin: number | null;
  infectiousYieldPerInfectedCenter: number | null;
}

export type GrowthIntervals = { [K in keyof GrowthEstimates]: [number, number] | null };

export interface GrowthCurveFit extends GrowthEstimates {
  method: typeof GROWTH_CURVE_METHOD;
  rSquared: number | null;
  rmsePFUPerMl: number;
  intervals: GrowthIntervals | null;
  bootstrapSamples: number;
  fitted: Array<GrowthObservation & { predictedPFUPerMl: number; residualPFUPerMl: number }>;
  warnings: string[];
}

const DEFAULT_OPTIONS: GrowthFitOptions = { infectedCentersPerMl: null, bootstrapSamples: 100, seed: 1 };
const NUMBER_CELL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function optionsFor(options: Partial<GrowthFitOptions>): GrowthFitOptions {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const centers = resolved.infectedCentersPerMl;
  if (centers !== null && (!Number.isFinite(centers) || centers <= 0)) {
    throw new Error('Infected centers must be a positive measured concentration, or null.');
  }
  if (!Number.isInteger(resolved.bootstrapSamples) || resolved.bootstrapSamples < 0 || resolved.bootstrapSamples > GROWTH_CURVE_LIMITS.bootstrap) {
    throw new Error(`Bootstrap samples must be an integer from 0 to ${GROWTH_CURVE_LIMITS.bootstrap}.`);
  }
  if (resolved.bootstrapSamples > 0 && resolved.bootstrapSamples < 20) {
    throw new Error('Use at least 20 bootstrap samples, or 0 to disable intervals.');
  }
  if (!Number.isInteger(resolved.seed) || resolved.seed < 0 || resolved.seed > 0xffffffff) {
    throw new Error('Seed must be an unsigned 32-bit integer (zero is supported).');
  }
  return resolved;
}

function observationsFor(input: readonly GrowthObservation[]): GrowthObservation[] {
  if (!Array.isArray(input) || input.length < 6 || input.length > GROWTH_CURVE_LIMITS.rows) {
    throw new Error(`Provide 6–${GROWTH_CURVE_LIMITS.rows} observations.`);
  }
  const rows = Array.from(input, (point, index) => {
    if (!point || !Number.isFinite(point.timeMin) || point.timeMin < 0 || !Number.isFinite(point.pfuPerMl) || point.pfuPerMl < 0) {
      throw new Error(`Observation ${index + 1}: time and PFU/mL must be finite nonnegative numbers.`);
    }
    return { timeMin: point.timeMin, pfuPerMl: point.pfuPerMl };
  }).sort((a, b) => a.timeMin - b.timeMin || a.pfuPerMl - b.pfuPerMl);
  const count = new Set(rows.map(row => row.timeMin)).size;
  if (count < 6 || count > GROWTH_CURVE_LIMITS.times) {
    throw new Error(`Provide 6–${GROWTH_CURVE_LIMITS.times} distinct sampling times, including baseline, rise, and plateau.`);
  }
  return rows;
}

/** Strict two-column CSV/TSV; duplicate times are independent replicate rows. */
export function parseGrowthCurveCSV(text: string): GrowthObservation[] {
  if (typeof text !== 'string' || text.length > GROWTH_CURVE_LIMITS.bytes) throw new Error('Growth-curve input is too large.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'));
  if (!lines.length) throw new Error('Provide a time_min,pfu_per_ml header and measurements.');
  const delimiter = lines[0].line.includes('\t') ? '\t' : ',';
  const cells = (line: string): string[] => line.split(delimiter).map(cell => {
    const value = cell.trim();
    return /^"[^"]*"$/.test(value) ? value.slice(1, -1).trim() : value;
  });
  const header = cells(lines[0].line).map(cell => cell.toLowerCase());
  if (header.length !== 2 || header[0] !== 'time_min' || header[1] !== 'pfu_per_ml') {
    throw new Error('Expected exactly two columns: time_min,pfu_per_ml (minutes and dilution-corrected PFU/mL).');
  }
  if (lines.length - 1 > GROWTH_CURVE_LIMITS.rows) throw new Error(`Provide at most ${GROWTH_CURVE_LIMITS.rows} observations.`);
  return observationsFor(lines.slice(1).map(({ line, number }) => {
    const values = cells(line);
    if (values.length !== 2 || !values.every(value => NUMBER_CELL.test(value))) {
      throw new Error(`Line ${number}: expected two numeric values; missing, censored, and nonnumeric values are not supported.`);
    }
    return { timeMin: Number(values[0]), pfuPerMl: Number(values[1]) };
  }));
}

interface Design {
  start: number;
  end: number;
  fractions: number[];
  sum: number;
  squares: number;
  variance: number;
}
interface Ramp { baseline: number; increase: number; loss: number; design: Design }

function designsFor(times: number[], counts: number[]): Design[] {
  const designs: Design[] = [];
  // At least two baseline and two plateau times, plus an interior rise sample.
  for (let start = 1; start < times.length - 3; start++) {
    for (let end = start + 2; end < times.length - 1; end++) {
      const fractions = times.map(time => Math.max(0, Math.min(1, (time - times[start]) / (times[end] - times[start]))));
      const sum = fractions.reduce((total, f, i) => total + f * counts[i], 0);
      const mean = sum / counts.reduce((total, count) => total + count, 0);
      designs.push({ start: times[start], end: times[end], fractions, sum,
        squares: fractions.reduce((total, f, i) => total + f * f * counts[i], 0),
        variance: fractions.reduce((total, f, i) => total + (f - mean) ** 2 * counts[i], 0) });
    }
  }
  return designs;
}

/** Solve the two-variable nonnegative least-squares problem, including edges. */
function fitRamp(values: number[], groups: number[], designs: Design[], timeCount: number): Ramp {
  const n = values.length;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  const centeredSums = Array<number>(timeCount).fill(0);
  let centeredYY = 0;
  values.forEach((value, i) => {
    const centered = value - meanY;
    centeredSums[groups[i]] += centered;
    centeredYY += centered * centered;
  });
  let best: Ramp | undefined;
  for (const design of designs) {
    const meanF = design.sum / n;
    const covariance = design.fractions.reduce((sum, f, i) => sum + (f - meanF) * centeredSums[i], 0);
    const increase = covariance / design.variance;
    const baseline = meanY - increase * meanF;
    const sumFY = covariance + meanY * design.sum;
    const candidates = [[Math.max(0, meanY), 0], [0, Math.max(0, sumFY / design.squares)]];
    if (baseline >= 0 && increase >= 0) candidates.push([baseline, increase]);
    for (const [a, b] of candidates) {
      // Center before squaring: raw sum-of-squares subtraction loses small rises
      // on a large background (e.g. 1e9 baseline with a 100 PFU/mL increase).
      const loss = Math.max(0, centeredYY - 2 * b * covariance + b * b * design.variance + n * (meanY - a - b * meanF) ** 2);
      const tolerance = Number.EPSILON * 64 * Math.max(centeredYY, best?.loss ?? 0, Number.MIN_VALUE);
      if (!best || loss < best.loss - tolerance) best = { baseline: a, increase: b, loss, design };
    }
  }
  if (!best) throw new Error('No supported baseline/rise/plateau design.');
  return best;
}

function estimatesFor(ramp: Ramp, scale: number, centers: number | null): GrowthEstimates {
  const increase = ramp.increase * scale;
  const estimates: GrowthEstimates = {
    baselinePFUPerMl: ramp.baseline * scale,
    plateauPFUPerMl: (ramp.baseline + ramp.increase) * scale,
    increasePFUPerMl: increase,
    riseStartMin: ramp.increase > 0 ? ramp.design.start : null,
    riseEndMin: ramp.increase > 0 ? ramp.design.end : null,
    infectiousYieldPerInfectedCenter: centers === null ? null : increase / centers,
  };
  if (Object.values(estimates).some(value => value !== null && !Number.isFinite(value))) {
    throw new Error('The measurement dynamic range exceeds supported numeric precision.');
  }
  return estimates;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], probability: number): number {
  values.sort((a, b) => a - b);
  const index = (values.length - 1) * probability;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return values[lo] * (hi - index || 1) + (hi === lo ? 0 : values[hi] * (index - lo));
}

/**
 * Fixed-design, centered residual bootstrap assumes independent, exchangeable
 * additive errors in PFU/mL. Intervals are descriptive and conditional on this
 * ramp model, sampling grid, and any supplied infected-center denominator.
 */
export function fitOneStepGrowth(input: readonly GrowthObservation[], suppliedOptions: Partial<GrowthFitOptions> = {}): GrowthCurveFit {
  const rows = observationsFor(input);
  const options = optionsFor(suppliedOptions);
  const times = [...new Set(rows.map(row => row.timeMin))];
  const index = new Map(times.map((time, i) => [time, i]));
  const groups = rows.map(row => index.get(row.timeMin)!);
  const counts = Array<number>(times.length).fill(0);
  groups.forEach(group => counts[group]++);
  const designs = designsFor(times, counts);
  const scale = Math.max(...rows.map(row => row.pfuPerMl)) || 1;
  const values = rows.map(row => row.pfuPerMl / scale);
  const ramp = fitRamp(values, groups, designs, times.length);
  const estimates = estimatesFor(ramp, scale, options.infectedCentersPerMl);
  const predicted = groups.map(group => ramp.baseline + ramp.increase * ramp.design.fractions[group]);
  const residuals = values.map((value, i) => value - predicted[i]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const residualMean = residuals.reduce((sum, value) => sum + value, 0) / values.length;
  const sst = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const sse = residuals.reduce((sum, value) => sum + value * value, 0);
  const rSquared = sst > 0 ? Math.max(0, Math.min(1, 1 - sse / sst)) : null;
  const warnings = [
    'Descriptive population-curve fit, not a validated mechanistic inference of latency, adsorption, or single-cell burst size.',
    'Knot times are restricted to sampled times; at least two baseline and two plateau times and one interior rise sample are assumed.',
    'Only extracellular free-phage PFU/mL is supported, not total infective-center counts. Net increase is not total production when phage losses or secondary infection occur.',
    'Rows are weighted equally. Replicate rows must be independent; correlated technical replicates can understate uncertainty.',
  ];
  if (estimates.riseStartMin === null) warnings.push('No positive rise was fitted; rise timing is unidentified.');
  if (rSquared !== null && rSquared < 0.8) warnings.push('The ramp leaves substantial variation unexplained; inspect residuals and assay/model suitability.');
  if (estimates.riseStartMin !== null && (ramp.design.start === times[1] || ramp.design.end === times[times.length - 2])) {
    warnings.push('A fitted knot touches the allowed time boundary; baseline or plateau coverage may be inadequate.');
  }
  if (options.infectedCentersPerMl === null) warnings.push('Infectious yield per infected center is unavailable without an independent infected-center measurement. Initial PFU is not a substitute.');
  else warnings.push('Yield is the fitted PFU/mL increase divided by supplied infected centers/mL; denominator uncertainty is not propagated.');
  let intervals: GrowthIntervals | null = null;
  if (options.bootstrapSamples > 0) {
    const random = seededRandom(options.seed);
    const samples: GrowthEstimates[] = [];
    for (let i = 0; i < options.bootstrapSamples; i++) {
      // Negative bootstrap pseudo-observations are permitted: clipping would bias the resampling model.
      const sampled = predicted.map(value => value + residuals[Math.floor(random() * residuals.length)] - residualMean);
      samples.push(estimatesFor(fitRamp(sampled, groups, designs, times.length), scale, options.infectedCentersPerMl));
    }
    intervals = {} as GrowthIntervals;
    for (const key of Object.keys(estimates) as Array<keyof GrowthEstimates>) {
      const sampleValues = samples.map(sample => sample[key]);
      intervals[key] = estimates[key] === null || sampleValues.some(value => value === null) ? null :
        [percentile(sampleValues as number[], 0.025), percentile(sampleValues as number[], 0.975)];
    }
    warnings.push('95% residual-bootstrap intervals assume exchangeable additive measurement errors and this fixed model/grid; they are not biological validation.');
    if (estimates.riseStartMin !== null && intervals.riseStartMin === null) warnings.push('Some bootstrap fits have no rise: timing intervals are withheld rather than discarding unidentified samples.');
  }
  return { ...estimates, method: GROWTH_CURVE_METHOD, rSquared, rmsePFUPerMl: Math.sqrt(sse / values.length) * scale,
    intervals, bootstrapSamples: options.bootstrapSamples, warnings,
    fitted: rows.map((row, i) => ({ ...row, predictedPFUPerMl: predicted[i] * scale, residualPFUPerMl: residuals[i] * scale })) };
}

function objectFor(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

/** Replays inputs only: a supplied/cached result is never trusted as evidence. */
export function parseGrowthCurveExperiment(text: string): GrowthCurveExperiment {
  if (typeof text !== 'string' || text.length > GROWTH_CURVE_LIMITS.bytes) throw new Error('Experiment input is too large.');
  const value = objectFor(JSON.parse(text), 'Experiment');
  if (value.schemaVersion !== 'one-step-growth-v1' || value.method !== GROWTH_CURVE_METHOD) throw new Error('Unsupported experiment schema or fitting method version.');
  if (value.measurement !== 'extracellular-pfu-per-ml') throw new Error('Only explicitly identified extracellular PFU/mL assays are supported; total infective-center titers use different yield accounting.');
  const provenance = objectFor(value.provenance, 'Provenance');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) throw new Error('Provide a title of 1–200 characters.');
  if ((provenance.kind !== 'user-supplied' && provenance.kind !== 'synthetic') || typeof provenance.source !== 'string' || !provenance.source.trim() || provenance.source.length > 2000) {
    throw new Error('Provide user-supplied/synthetic provenance and a source description of 1–2000 characters.');
  }
  const options = objectFor(value.options, 'Options');
  // Require explicit saved options so replay cannot silently inherit changed defaults.
  for (const key of Object.keys(DEFAULT_OPTIONS)) if (!(key in options)) throw new Error(`Saved experiment is missing option ${key}.`);
  return { schemaVersion: 'one-step-growth-v1', method: GROWTH_CURVE_METHOD, measurement: 'extracellular-pfu-per-ml', title: value.title.trim(),
    provenance: { kind: provenance.kind, source: provenance.source.trim() },
    observations: observationsFor(value.observations as GrowthObservation[]),
    options: optionsFor({ infectedCentersPerMl: options.infectedCentersPerMl as number | null,
      bootstrapSamples: options.bootstrapSamples as number, seed: options.seed as number }) };
}

/** Self-contained inputs + recomputed result; deterministic for the same input. */
export function serializeGrowthCurveExperiment(experiment: GrowthCurveExperiment): string {
  // Validate before JSON encoding: JSON turns Infinity/NaN into null, which is
  // a valid 'denominator not measured' value and must not mask invalid inputs.
  observationsFor(experiment.observations);
  optionsFor(experiment.options);
  const validated = parseGrowthCurveExperiment(JSON.stringify(experiment));
  return JSON.stringify({ ...validated, result: fitOneStepGrowth(validated.observations, validated.options) }, null, 2);
}

/** Portable evidence for the existing corrected-PFU method. This is deliberately
 * not the raw-count Poisson model: dilution/volume information is unavailable.
 */
export const GROWTH_CURVE_RECORD_METHOD = { id: 'extracellular-pfu-growth', version: '1',
  implementation: `${GROWTH_CURVE_METHOD}; equal-row nonnegative least squares; seeded centered-residual bootstrap` } as const;
const GROWTH_REFERENCE = { id: 'corrected-pfu-grid-ramp', version: '1',
  description: 'Complete observed-time knot grid; equal observation weights; nonnegative baseline and rise. Residual-bootstrap intervals are conditional on the fixed model, grid, independent exchangeable additive errors and any supplied denominator.' };
const canonical = (value: unknown): string => JSON.stringify(analysisJson(value));

/** Strict portable envelope, while retaining the older input parser's contract.
 * A legacy result is allowed ONLY so the producer can compare a fresh fit with
 * it. Extra fields are not silently discarded from new portable evidence.
 */
export function parseGrowthCurveRecordInput(content: string): GrowthCurveExperiment {
  if (typeof content !== 'string' || content.length > GROWTH_CURVE_LIMITS.bytes
    || new TextEncoder().encode(content).length > GROWTH_CURVE_LIMITS.bytes) throw new Error('Corrected-PFU input exceeds 1,000,000 UTF-8 bytes.');
  const value = objectFor(JSON.parse(content), 'Corrected-PFU experiment');
  const fields = (object: Record<string, unknown>, keys: string[], label: string) => {
    if (Object.keys(object).sort().join('|') !== [...keys].sort().join('|')) throw new Error(`Unexpected ${label} fields.`);
  };
  fields(value, ['schemaVersion', 'method', 'measurement', 'title', 'provenance', 'observations', 'options',
    ...(Object.hasOwn(value, 'result') ? ['result'] : [])], 'corrected-PFU input');
  fields(objectFor(value.provenance, 'Provenance'), ['kind', 'source'], 'provenance');
  fields(objectFor(value.options, 'Options'), ['infectedCentersPerMl', 'bootstrapSamples', 'seed'], 'corrected-PFU options');
  if (!Array.isArray(value.observations) || value.observations.length > GROWTH_CURVE_LIMITS.rows) throw new Error('Bounded corrected-PFU observations are required.');
  value.observations.forEach(row => fields(objectFor(row, 'Observation'), ['timeMin', 'pfuPerMl'], 'observation'));
  return parseGrowthCurveExperiment(content);
}

/** Compute once, then bind original input bytes, seed, scalar intervals and full
 * residuals to the shared record. A legacy result is verified, never regenerated
 * into an apparently successful replay after its numerical values have changed.
 */
export async function createGrowthCurveRecord(content: string): Promise<AnalysisRecord> {
  const experiment = parseGrowthCurveRecordInput(content);
  const fit = fitOneStepGrowth(experiment.observations, experiment.options);
  const raw = objectFor(JSON.parse(content), 'Corrected-PFU input');
  if (Object.hasOwn(raw, 'result') && canonical(raw.result) !== canonical(fit)) {
    throw new Error('Recomputed corrected-PFU fit differs from the legacy saved result.');
  }
  const coverage = { available: experiment.observations.length, total: experiment.observations.length, unit: 'records' as const };
  const demo = experiment.provenance.kind === 'synthetic';
  const assumptions = ['Author-declared synthetic observations and any supplied denominator; not empirical measurements.'];
  const objective = 'Equal-row nonnegative least squares over complete observed-time ramp knots';
  const metric = (label: string, value: unknown, units: ObservationUnits, key?: keyof GrowthEstimates): AnalysisField => {
    if (value === null) return { label, kind: 'unavailable', value: null, units: null, coverage: { ...coverage, available: 0 },
      limitations: fit.warnings, missingInputs: [key === 'infectiousYieldPerInfectedCenter'
        ? 'An independently measured infected-center concentration on the same concentration basis.'
        : 'A positive fitted population rise; a flat or declining curve does not identify rise timing.'] };
    if (demo) return { label, kind: 'demo', value: analysisJson(value), units, coverage, limitations: fit.warnings, assumptions };
    const interval = key ? fit.intervals?.[key] : null;
    return { label, kind: 'fitted-estimate', value: analysisJson(value), units, coverage, limitations: fit.warnings,
      fit: { dataInput: 'experiment', objective, uncertainty: interval
        ? { kind: 'interval', method: 'Fixed-design centered residual bootstrap; conditional, not biological validation', level: 0.95,
          lower: interval[0], upper: interval[1] }
        : { kind: 'not-estimated' } } };
  };
  const fields: Record<string, AnalysisField> = {
    fit: metric('Corrected-PFU fit, residuals and conditional scalar intervals (no joint interval)', fit, 'records'),
    observations: demo
      ? { label: 'Synthetic corrected-PFU observations', kind: 'demo', value: analysisJson(experiment.observations), units: 'records', coverage, limitations: fit.warnings, assumptions }
      : { label: 'Author-supplied corrected extracellular PFU/mL observations', kind: 'observation', value: analysisJson(experiment.observations), units: 'records', coverage,
        sourceInput: 'experiment', limitations: ['Assay type, source attribution, correction factors and independence are author assertions, not authenticated here.'] },
  };
  for (const [key, label, units] of [
    ['baselinePFUPerMl', 'Fitted baseline', 'PFU/mL'], ['plateauPFUPerMl', 'Fitted plateau', 'PFU/mL'],
    ['increasePFUPerMl', 'Fitted extracellular increase', 'PFU/mL'], ['riseStartMin', 'Population rise start', 'minutes'],
    ['riseEndMin', 'Population rise end', 'minutes'], ['infectiousYieldPerInfectedCenter', 'Conditional net infectious yield', 'dimensionless'],
  ] as const) fields[key] = metric(label, fit[key], units, key);
  return createAnalysisRecord({ method: GROWTH_CURVE_RECORD_METHOD,
    inputs: [{ id: 'experiment', accession: null, source: demo ? 'demo' : 'local',
      description: 'Exact corrected extracellular PFU/mL experiment JSON; original observations, source and options retained.', data: content }],
    parameters: { ...experiment.options }, seed: experiment.options.seed, references: [GROWTH_REFERENCE], fields });
}

export async function replayGrowthCurveRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseAnalysisRecord(content, { methodId: GROWTH_CURVE_RECORD_METHOD.id, methodVersion: GROWTH_CURVE_RECORD_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'experiment' || typeof saved.inputs[0].data !== 'string') {
    throw new Error('Corrected-PFU replay requires one embedded original experiment.');
  }
  const fresh = await createGrowthCurveRecord(saved.inputs[0].data);
  if (fresh.cacheKey !== saved.cacheKey || fresh.resultId !== saved.resultId) {
    throw new Error('Recomputed corrected-PFU values, intervals, seed or input identity differ from the saved result.');
  }
  return fresh;
}

/** Export an accepted producer/replay result without fitting or bootstrapping again. */
export function exportGrowthCurveTsv(record: AnalysisRecord): string {
  if (canonical(record.method) !== canonical(GROWTH_CURVE_RECORD_METHOD)) throw new Error('Expected a corrected-PFU growth record.');
  const fit = record.fields.fit.value as unknown as GrowthCurveFit;
  return [`# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}; inputSha256=${record.inputs[0].sha256}`,
    `# bootstrapSamples=${record.parameters.bootstrapSamples}; seed=${record.seed}; intervals=${JSON.stringify(fit.intervals)}`,
    '# Conditional descriptive corrected-PFU fit; not raw plaque counts, mechanistic latency or biological validation.',
    'time_min\tobserved_pfu_per_ml\tpredicted_pfu_per_ml\tresidual_pfu_per_ml',
    ...fit.fitted.map(row => [row.timeMin, row.pfuPerMl, row.predictedPFUPerMl, row.residualPFUPerMl].join('\t'))].join('\n') + '\n';
}
