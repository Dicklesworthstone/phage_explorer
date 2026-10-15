/** Exposure-aware inference for extracellular plaque counts (v1 exact; v2 explicit bounds).
 * E[count_i] = dilution_i * volume_i * (background + increase * ramp(time_i)).
 * Every admissible observed-time knot pair is searched; rates are nonnegative.
 * The ramp is descriptive, not a mechanistic infection or single-cell model.
 *
 * Poisson assay rationale: Wyshak & Detre, 1972, doi:10.1128/am.23.4.784-790.1972.
 * Profile support interpretation: Raue et al., 2009, doi:10.1093/bioinformatics/btp358.
 * A user-specified deviance cutoff defines a likelihood SUPPORT set, not a
 * calibrated confidence level (grid selection and zero-rise boundaries matter).
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisField, type AnalysisRecord } from '../analysis-result';

export const PLAQUE_GROWTH_METHOD = { id: 'plaque-count-growth', version: '1',
  implementation: 'Poisson exposure likelihood; exhaustive observed-time ramps; nonnegative rate profiling' } as const;
export const CENSORED_PLAQUE_GROWTH_METHOD = { id: 'plaque-count-growth', version: '2',
  implementation: 'Poisson exact-count and inclusive-tail likelihood; exhaustive observed-time ramps; nonnegative rate profiling' } as const;
export function plaqueGrowthMethod(version: number) {
  if (version === 1) return PLAQUE_GROWTH_METHOD;
  if (version === 2) return CENSORED_PLAQUE_GROWTH_METHOD;
  throw new Error('Unsupported plaque-count method version.');
}
export const PLAQUE_GROWTH_LIMITS = { bytes: 1_000_000, rows: 2048, times: 32, count: 1_000_000 } as const;
export interface GrowthPlate { timeMin: number; count: number; dilution: number; volumeMl: number }
export type PlateCountStatus = 'exact' | 'at-most' | 'at-least';
export interface CensoredGrowthPlate extends GrowthPlate { countStatus: PlateCountStatus }
export interface PlaqueGrowthOptions { infectedCentersPerMl: number | null; supportDeviance: number }
export interface PlaqueGrowthInput {
  format: 'phage-explorer-plaque-growth-input'; version: 1 | 2;
  measurement: 'extracellular-plaque-counts'; title: string;
  provenance: { kind: 'user-supplied' | 'synthetic'; source: string };
  csv: string; options: PlaqueGrowthOptions;
}
export interface PlaqueGrowthFit {
  backgroundPFUPerMl: number; increasePFUPerMl: number; plateauPFUPerMl: number;
  infectiousYieldPerInfectedCenter: number | null;
  riseStartMin: number | null; riseEndMin: number | null;
  /** No positive increase is required by the support set => timing withheld. */
  timingStatus: 'unresolved' | 'grid-supported' | 'grid-boundary';
  deviance: number; constantDeviance: number; totalPlaques: number;
  increaseSupport: Array<[number, number]>;
  yieldSupport: Array<[number, number]> | null;
  knotSupport: Array<{ startMin: number; endMin: number; deltaDeviance: number }>;
  candidates: number; supportDeviance: number;
  fitted: Array<GrowthPlate & { expectedCount: number; predictedPFUPerMl: number; devianceResidual: number }>;
  warnings: string[];
}
export interface CensoredPlaqueGrowthFit extends Omit<PlaqueGrowthFit, 'totalPlaques' | 'fitted'> {
  /** Unknown when any bound was reported; thresholds are never summed as counts. */
  totalPlaques: number | null;
  exactPlaques: number;
  countCoverage: { exact: number; atMost: number; atLeast: number };
  fitted: Array<CensoredGrowthPlate & { expectedCount: number; predictedPFUPerMl: number;
    devianceResidual: number | null; devianceContribution: number }>;
}
export type PlaqueGrowthResult = PlaqueGrowthFit | CensoredPlaqueGrowthFit;
const canonical = (value: unknown) => JSON.stringify(analysisJson(value));
function exact(value: unknown, names: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== names.sort().join('|')) throw new Error(`Unexpected ${label} fields.`);
}
function number(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is outside supported numeric bounds.`);
}
function optionsFor(value: unknown): PlaqueGrowthOptions {
  exact(value, ['infectedCentersPerMl', 'supportDeviance'], 'plaque fit options');
  if (value.infectedCentersPerMl !== null) number(value.infectedCentersPerMl, 1e-18, 1e18, 'Independent infected-center concentration');
  number(value.supportDeviance, 0.01, 100, 'Likelihood support deviance');
  return { infectedCentersPerMl: value.infectedCentersPerMl, supportDeviance: value.supportDeviance };
}
function platesFor(input: readonly GrowthPlate[]): GrowthPlate[] {
  if (!Array.isArray(input) || input.length < 6 || input.length > PLAQUE_GROWTH_LIMITS.rows) throw new Error('Provide 6–2048 independent uncensored plates.');
  const plates = Array.from(input, (row, i) => {
    exact(row, ['timeMin', 'count', 'dilution', 'volumeMl'], `plate ${i + 1}`);
    number(row.timeMin, 0, 1e6, 'Time in minutes'); number(row.count, 0, PLAQUE_GROWTH_LIMITS.count, 'Plaque count');
    if (!Number.isSafeInteger(row.count)) throw new Error('Plaque counts must be nonnegative integers; censored/confluent plates are unsupported.');
    number(row.dilution, 1e-12, 1, 'Dilution fraction (not its reciprocal)'); number(row.volumeMl, 1e-6, 10, 'Plated volume in mL');
    return { timeMin: row.timeMin, count: row.count, dilution: row.dilution, volumeMl: row.volumeMl };
  }).sort((a, b) => a.timeMin - b.timeMin || a.dilution - b.dilution || a.volumeMl - b.volumeMl || a.count - b.count);
  const times = new Set(plates.map(row => row.timeMin));
  if (times.size < 6 || times.size > PLAQUE_GROWTH_LIMITS.times) throw new Error('Provide 6–32 distinct sampling times, covering baseline, rise and plateau.');
  return plates;
}
/** v2 adds an explicit inclusive bound status; bare TNTC supplies no numeric bound. */
export function parsePlaqueGrowthCSV(text: string, version: 2): CensoredGrowthPlate[];
export function parsePlaqueGrowthCSV(text: string, version?: 1): GrowthPlate[];
export function parsePlaqueGrowthCSV(text: string, version: 1 | 2): Array<GrowthPlate | CensoredGrowthPlate>;
export function parsePlaqueGrowthCSV(text: string, version: 1 | 2 = 1): Array<GrowthPlate | CensoredGrowthPlate> {
  plaqueGrowthMethod(version);
  if (typeof text !== 'string' || text.length > PLAQUE_GROWTH_LIMITS.bytes || new TextEncoder().encode(text).length > PLAQUE_GROWTH_LIMITS.bytes) throw new Error('Plaque CSV exceeds 1,000,000 UTF-8 bytes.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/).map((line, index) => ({ line: line.trim(), index }))
    .filter(row => row.line && !row.line.startsWith('#'));
  const separator = lines[0]?.line.includes('\t') ? '\t' : ',';
  const header = 'time_min,plaque_count,dilution_fraction,volume_ml' + (version === 2 ? ',count_status' : '');
  if (lines[0]?.line.split(separator).map(s => s.trim()).join(',') !== header) {
    throw new Error(`Expected ${header}.`);
  }
  if (lines.length > PLAQUE_GROWTH_LIMITS.rows + 1) throw new Error('Plaque CSV exceeds 2048 rows.');
  const rows = lines.slice(1).map(({ line, index }) => {
    const cells = line.split(separator).map(s => s.trim());
    if (cells.length !== (version === 2 ? 5 : 4) || !cells.slice(0, 4).every(s => /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s))) throw new Error(`Line ${index + 1}: four explicit numeric cells required; bare TNTC and blanks are unsupported.`);
    const [timeMin, count, dilution, volumeMl] = cells.slice(0, 4).map(Number);
    return { timeMin, count, dilution, volumeMl, ...(version === 2 ? { countStatus: cells[4] as PlateCountStatus } : {}) };
  });
  return version === 2 ? censoredPlatesFor(rows as CensoredGrowthPlate[]) : platesFor(rows);
}
export function parsePlaqueGrowthInput(text: string): PlaqueGrowthInput {
  if (typeof text !== 'string' || text.length > PLAQUE_GROWTH_LIMITS.bytes || new TextEncoder().encode(text).length > PLAQUE_GROWTH_LIMITS.bytes) throw new Error('Plaque input exceeds 1,000,000 UTF-8 bytes.');
  const input: unknown = JSON.parse(text);
  exact(input, ['format', 'version', 'measurement', 'title', 'provenance', 'csv', 'options'], 'plaque input');
  if (input.format !== 'phage-explorer-plaque-growth-input' || (input.version !== 1 && input.version !== 2) || input.measurement !== 'extracellular-plaque-counts') throw new Error('Expected version 1 or 2 extracellular plaque-count input, not PFU/OD/total infective-center data.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('Provide a 1–200 character experiment title.');
  exact(input.provenance, ['kind', 'source'], 'provenance');
  const source = input.provenance;
  if ((source.kind !== 'synthetic' && source.kind !== 'user-supplied') || typeof source.source !== 'string' || !source.source.trim() || source.source.length > 2000) throw new Error('Provide explicit synthetic/user-supplied source attribution.');
  if (typeof input.csv !== 'string') throw new Error('Embed the original plate CSV text, not a filename.');
  parsePlaqueGrowthCSV(input.csv, input.version);
  return { format: input.format, version: input.version, measurement: input.measurement, title: input.title,
    provenance: { kind: source.kind, source: source.source }, csv: input.csv, options: optionsFor(input.options) };
}
/** Stable Poisson deviance, including zero counts and zero fitted means. */
function deviance(count: number, mean: number): number {
  if (count === 0) return 2 * mean;
  if (mean <= 0) return Infinity;
  const x = (mean - count) / count;
  if (Math.abs(x) < 1e-4) return count * x * x * (1 - 2 * x / 3 + x * x / 2 - 2 * x ** 3 / 5);
  return Math.max(0, 2 * (mean - count + count * Math.log(count / mean)));
}
interface Group { time: number; count: number; exposure: number }
interface Design { start: number; end: number; f: number[]; exposure: number; riseExposure: number }
interface Fit { background: number; increase: number; loss: number; design: Design }
function loss(groups: Group[], design: Design, background: number, increase: number): number {
  return groups.reduce((sum, g, i) => sum + deviance(g.count, g.exposure * (background + increase * design.f[i])), 0);
}
/** At the MLE, the total expected count equals the total observed count.
 * Condition on that total: q is the fraction contributed by background.
 * sum count*log(q/exposure + (1-q)*f/riseExposure) is concave in q.
 * Its monotone score has one root or an exact boundary solution, no local optimizer.
 */
function fitDesign(groups: Group[], design: Design, total: number): Fit {
  if (!total) return { background: 0, increase: 0, loss: 0, design };
  const score = (q: number) => groups.reduce((sum, g, i) => {
    if (!g.count) return sum;
    const u = 1 / design.exposure, v = design.f[i] / design.riseExposure;
    const p = q * u + (1 - q) * v;
    return sum + (p === 0 ? Infinity : g.count * (u - v) / p);
  }, 0);
  let q: number;
  if (score(0) <= 0) q = 0;
  else if (score(1) >= 0) q = 1;
  else {
    let lo = 0, hi = 1;
    for (let i = 0; i < 64; i++) { const mid = (lo + hi) / 2; if (score(mid) > 0) lo = mid; else hi = mid; }
    q = (lo + hi) / 2;
  }
  const background = q * total / design.exposure, increase = (1 - q) * total / design.riseExposure;
  return { background, increase, loss: loss(groups, design, background, increase), design };
}
/** Fixed increase: minimize over the nuisance background using its monotone score. */
function profile(groups: Group[], design: Design, total: number, increase: number): number {
  const score = (background: number) => groups.reduce((sum, g, i) => {
    if (!g.count) return sum;
    const rate = background + increase * design.f[i];
    return sum + (rate === 0 ? Infinity : g.count / rate);
  }, -design.exposure);
  let lo = 0, hi = total / design.exposure;
  if (score(0) <= 0) hi = 0;
  else for (let i = 0; i < 64; i++) { const mid = (lo + hi) / 2; if (score(mid) > 0) lo = mid; else hi = mid; }
  return loss(groups, design, (lo + hi) / 2, increase);
}
function supportFor(groups: Group[], fit: Fit, total: number, ceiling: number): [number, number] {
  let lower = 0;
  if (profile(groups, fit.design, total, 0) > ceiling) {
    let lo = 0, hi = fit.increase;
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (profile(groups, fit.design, total, mid) > ceiling) lo = mid; else hi = mid; }
    lower = (lo + hi) / 2;
  }
  let lo = fit.increase, hi = Math.max(1, 2 * fit.increase);
  // A plateau has positive exposure in every design, so the upper bound is finite.
  for (let i = 0; profile(groups, fit.design, total, hi) <= ceiling; i++) {
    if (i >= 128 || !Number.isFinite(hi * 2)) throw new Error('Likelihood support could not be bracketed; no result was produced.');
    hi *= 2;
  }
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (profile(groups, fit.design, total, mid) <= ceiling) lo = mid; else hi = mid; }
  return [lower, (lo + hi) / 2];
}
function union(intervals: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged[merged.length - 1];
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}
const LIMITATIONS = [
  'Conditional independent Poisson counts with known dilution fractions and plated volumes; uncensored extracellular samples only. Dilution error, biological overdispersion, plaque overlap and correlated plates are not modeled.',
  'A descriptive nonnegative baseline/rise/plateau model. Knots are observed times with at least two baseline and plateau times and one interior rise time. Population rise timing is not single-cell latency.',
  'Likelihood-ratio support uses the explicitly chosen deviance cutoff; no nominal confidence level or p-value is claimed. Support can be disconnected or reach the knot-grid boundary.',
  'Yield divides the fitted extracellular increase by an independent infected-center concentration. Its uncertainty is conditional on that denominator; secondary infection and losses invalidate burst-size interpretation.',
];
export function fitPlaqueGrowth(input: readonly GrowthPlate[], suppliedOptions: PlaqueGrowthOptions): PlaqueGrowthFit {
  const plates = platesFor(input), options = optionsFor(suppliedOptions);
  const groupsByTime = new Map<number, Group>();
  for (const p of plates) {
    const g = groupsByTime.get(p.timeMin) ?? { time: p.timeMin, count: 0, exposure: 0 };
    g.count += p.count; g.exposure += p.dilution * p.volumeMl; groupsByTime.set(p.timeMin, g);
  }
  const groups = [...groupsByTime.values()], total = groups.reduce((sum, g) => sum + g.count, 0);
  const rawExposure = groups.reduce((sum, g) => sum + g.exposure, 0);
  // Normalize rates so background is O(1), including tiny dilution exposures.
  const scale = Math.max(1, total) / rawExposure;
  groups.forEach(g => { g.exposure *= scale; });
  const exposure = groups.reduce((sum, g) => sum + g.exposure, 0), fits: Fit[] = [];
  for (let start = 1; start < groups.length - 3; start++) for (let end = start + 2; end < groups.length - 1; end++) {
    const a = groups[start].time, b = groups[end].time;
    const f = groups.map(g => Math.max(0, Math.min(1, (g.time - a) / (b - a))));
    const design = { start: a, end: b, f, exposure, riseExposure: groups.reduce((sum, g, i) => sum + g.exposure * f[i], 0) };
    fits.push(fitDesign(groups, design, total));
  }
  const best = fits.reduce((a, b) => b.loss < a.loss - 1e-10 ? b : a);
  const ceiling = best.loss + options.supportDeviance;
  const supported = fits.filter(fit => fit.loss <= ceiling);
  const increaseSupport = union(supported.map(fit => supportFor(groups, fit, total, ceiling)))
    .map(([lo, hi]): [number, number] => [lo * scale, hi * scale]);
  const constantDeviance = loss(groups, best.design, total / exposure, 0);
  const unresolved = constantDeviance <= ceiling;
  const boundary = supported.some(fit => fit.design.start === groups[1].time || fit.design.end === groups[groups.length - 2].time);
  const backgroundPFUPerMl = best.background * scale, increasePFUPerMl = best.increase * scale;
  const fitted = plates.map(p => {
    const f = Math.max(0, Math.min(1, (p.timeMin - best.design.start) / (best.design.end - best.design.start)));
    const predictedPFUPerMl = backgroundPFUPerMl + increasePFUPerMl * f;
    const expectedCount = predictedPFUPerMl * p.dilution * p.volumeMl;
    return { ...p, expectedCount, predictedPFUPerMl, devianceResidual: Math.sign(p.count - expectedCount) * Math.sqrt(deviance(p.count, expectedCount)) };
  });
  const fullDeviance = fitted.reduce((sum, p) => sum + p.devianceResidual ** 2, 0);
  const warnings: string[] = [...LIMITATIONS];
  if (unresolved) warnings.push('The constant curve remains in the likelihood support set: rise timing is withheld, not assigned arbitrary knots.');
  if (boundary) warnings.push('Timing support reaches the search grid boundary; additional baseline or plateau sampling may be needed.');
  if (options.infectedCentersPerMl === null) warnings.push('Yield is unavailable: no independently measured infected-center denominator was provided.');
  const result: PlaqueGrowthFit = { backgroundPFUPerMl, increasePFUPerMl, plateauPFUPerMl: backgroundPFUPerMl + increasePFUPerMl,
    infectiousYieldPerInfectedCenter: options.infectedCentersPerMl === null ? null : increasePFUPerMl / options.infectedCentersPerMl,
    riseStartMin: unresolved ? null : best.design.start, riseEndMin: unresolved ? null : best.design.end,
    timingStatus: unresolved ? 'unresolved' : boundary ? 'grid-boundary' : 'grid-supported',
    deviance: fullDeviance, constantDeviance: constantDeviance + Math.max(0, fullDeviance - best.loss), totalPlaques: total,
    increaseSupport, yieldSupport: options.infectedCentersPerMl === null ? null : increaseSupport.map(([lo, hi]) => [lo / options.infectedCentersPerMl!, hi / options.infectedCentersPerMl!]),
    knotSupport: supported.map(fit => ({ startMin: fit.design.start, endMin: fit.design.end, deltaDeviance: Math.max(0, fit.loss - best.loss) })),
    candidates: fits.length, supportDeviance: options.supportDeviance, fitted, warnings };
  analysisJson(result); // Fail, rather than serialize an overflow as null.
  return result;
}

function censoredPlatesFor(input: readonly CensoredGrowthPlate[]): CensoredGrowthPlate[] {
  if (!Array.isArray(input) || input.length < 6 || input.length > PLAQUE_GROWTH_LIMITS.rows) throw new Error('Provide 6–2048 independent plates.');
  const rows = Array.from(input, (p, index): CensoredGrowthPlate => {
    exact(p, ['timeMin', 'count', 'dilution', 'volumeMl', 'countStatus'], `bounded plate ${index + 1}`);
    if (p.countStatus !== 'exact' && p.countStatus !== 'at-most' && p.countStatus !== 'at-least') throw new Error('Count status must be exact, at-most or at-least. Bounds are inclusive.');
    number(p.timeMin, 0, 1e6, 'Time in minutes'); number(p.count, 0, PLAQUE_GROWTH_LIMITS.count, 'Count or bound');
    number(p.dilution, 1e-12, 1, 'Dilution fraction'); number(p.volumeMl, 1e-6, 10, 'Plated volume in mL');
    if (p.countStatus === 'at-least' && p.count === 0) throw new Error('At-least zero conveys no count information; provide an informative bound.');
    return { timeMin: p.timeMin, count: p.count, dilution: p.dilution, volumeMl: p.volumeMl, countStatus: p.countStatus };
  });
  platesFor(rows.map(({ countStatus: _status, ...p }) => p));
  rows.sort((a, b) => a.timeMin - b.timeMin || a.dilution - b.dilution || a.volumeMl - b.volumeMl
    || a.count - b.count || (a.countStatus < b.countStatus ? -1 : a.countStatus > b.countStatus ? 1 : 0));
  return rows;
}

/** Count recurrences, not subtraction of nearly equal CDFs. See SciPy's
 * poisson.logcdf/logsf definitions and DLMF 8.4.7–8.4.8. Inclusive lower bounds
 * use P(N >= k), NOT P(N > k). Work exhaustion never yields a partial fit.
 */
export const CENSORED_PLAQUE_WORK_LIMIT = 50_000_000;
function budget(limit: number): () => void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CENSORED_PLAQUE_WORK_LIMIT) throw new Error('Invalid censored-likelihood work budget.');
  return () => { if (--limit < 0) throw new Error('Censored-likelihood work budget exhausted; no result was produced. Use fewer plates or sampling times.'); };
}
function logMass(k: number, mean: number): number {
  if (!k) return mean ? -mean : 0;
  if (!mean) return -Infinity;
  if (k < 16) {
    let factorial = 0;
    for (let i = 2; i <= k; i++) factorial += Math.log(i);
    return k * Math.log(mean) - mean - factorial;
  }
  // Stirling correction through n^-9; the next term is < 1.1e-16 at n=16.
  // Center the large terms with the same stable Poisson deviance used by v1.
  const v = 1 / k, v2 = v * v;
  const correction = v * (1 / 12 + v2 * (-1 / 360 + v2 * (1 / 1260 + v2 * (-1 / 1680 + v2 / 1188))));
  return -deviance(k, mean) / 2 - Math.log(2 * Math.PI * k) / 2 - correction;
}
function logComplement(logP: number): number {
  return logP < -Math.LN2 ? Math.log1p(-Math.exp(logP)) : Math.log(-Math.expm1(logP));
}
/** Small tail expanded relative to its endpoint mass. Terms decrease, including
 * around million-count thresholds; no normal approximation or tail cutoff.
 */
function logSmallTail(k: number, mean: number, upper: boolean, charge: () => void): number {
  let term = 1, sum = 1, n = k;
  for (;;) {
    charge();
    if (!upper && !n) break;
    term *= upper ? mean / ++n : n-- / mean;
    sum += term;
    if (term <= sum * 2e-16) break;
  }
  return Math.min(0, logMass(k, mean) + Math.log(sum));
}
function logEvent(k: number, mean: number, status: PlateCountStatus, charge: () => void): number {
  if (status === 'exact') return logMass(k, mean);
  if (!mean) return status === 'at-most' || !k ? 0 : -Infinity;
  if (status === 'at-most') return mean >= k ? logSmallTail(k, mean, false, charge)
    : logComplement(logSmallTail(k + 1, mean, true, charge));
  if (!k) return 0;
  return mean <= k ? logSmallTail(k, mean, true, charge)
    : logComplement(logSmallTail(k - 1, mean, false, charge));
}
/** Log probability of a recorded exact count or inclusive count-bound event. */
export function poissonCountLogProbability(count: number, mean: number, status: PlateCountStatus): number {
  number(count, 0, PLAQUE_GROWTH_LIMITS.count, 'Count or bound');
  number(mean, 0, 1e100, 'Expected count');
  if (!Number.isSafeInteger(count) || !['exact', 'at-most', 'at-least'].includes(status)) throw new Error('An integer count and explicit count status are required.');
  return logEvent(count, mean, status, budget(CENSORED_PLAQUE_WORK_LIMIT));
}
interface RateEvaluation { loss: number; da: number; db: number; aa: number; ab: number; bb: number }
/** Solve a convex one-dimensional nonnegative problem with a bracketed score.
 * Newton steps accelerate roots; bisection remains the fallback. No rate is
 * clipped to a guessed biological bound and no unconverged iterate is accepted.
 */
function rateRoot(score: (rate: number) => { g: number; h: number }): number {
  if (score(0).g >= 0) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; score(hi).g < 0; i++) {
    if (i === 128) throw new Error('A finite rate optimum could not be bracketed.');
    hi *= 2;
  }
  let x = hi / 2;
  for (let i = 0; i < 100; i++) {
    const { g, h } = score(x);
    const step = g / h;
    if (Number.isFinite(step) && Math.abs(step) <= 2e-12 * Math.max(1, x)) return x;
    if (g < 0) lo = x; else hi = x;
    if (hi - lo <= 2e-12 * Math.max(1, hi)) return (lo + hi) / 2;
    const next = x - step;
    x = next > lo && next < hi && Number.isFinite(next) ? next : (lo + hi) / 2;
  }
  throw new Error('Censored rate optimization did not converge; no result was produced.');
}
const CENSORED_LIMITATIONS = [
  'Independent Poisson count/bound events with known exposures. Exact means N=k; at-most means N<=k; at-least means N>=k. A threshold is not an observed count. Bounds and the censoring mechanism are author assertions.',
  'A finite upper observation (exact or at-most) at one of the last two sampling times is required to bound every candidate plateau. All-lower-bound plateaus are unsupported, not replaced by arbitrary finite estimates.',
  'Count bounds must describe the uncensored latent plate count. Bare TNTC, a guessed countability threshold, selection of only countable plates, unknown dilution error, plaque overlap, overdispersion and correlated replicates are not modeled.',
  ...LIMITATIONS.slice(1),
  'Exact plates retain signed Poisson deviance residuals. Bound plates have no observed residual; their contribution is -2 log P(recorded bound event). This mixed objective is not a calibrated goodness-of-fit test.',
];
export function fitCensoredPlaqueGrowth(input: readonly CensoredGrowthPlate[], suppliedOptions: PlaqueGrowthOptions,
  workLimit = CENSORED_PLAQUE_WORK_LIMIT): CensoredPlaqueGrowthFit {
  const plates = censoredPlatesFor(input), options = optionsFor(suppliedOptions), charge = budget(workLimit);
  const times = [...new Set(plates.map(p => p.timeMin))];
  if (!plates.some(p => p.timeMin >= times[times.length - 2] && p.countStatus !== 'at-least')) {
    throw new Error('A finite upper observation (exact or at-most) at one of the last two times is required; the plateau may otherwise be unbounded. No fit was produced.');
  }
  const scale = Math.max(1, plates.reduce((sum, p) => sum + p.count, 0)) / plates.reduce((sum, p) => sum + p.dilution * p.volumeMl, 0);
  const exposures = plates.map(p => p.dilution * p.volumeMl * scale);
  const evaluate = (f: number[], a: number, b: number): RateEvaluation => {
    let loss = 0, da = 0, db = 0, aa = 0, ab = 0, bb = 0;
    plates.forEach((p, i) => {
      charge();
      const e = exposures[i], mu = e * (a + b * f[i]), k = p.count;
      let g: number, h: number;
      if (p.countStatus === 'exact') {
        loss += deviance(k, mu) / 2;
        g = k ? mu ? 1 - k / mu : -Infinity : 1;
        h = k ? mu ? k / (mu * mu) : Infinity : 0;
      } else {
        const logP = logEvent(k, mu, p.countStatus, charge);
        loss -= logP;
        if (!mu) {
          g = p.countStatus === 'at-least' ? -Infinity : k ? 0 : 1;
          h = p.countStatus === 'at-least' ? Infinity : k === 1 ? 1 : 0;
        } else {
          const n = p.countStatus === 'at-most' ? k : k - 1;
          const ratio = Math.exp(logMass(n, mu) - logP);
          g = p.countStatus === 'at-most' ? ratio : -ratio;
          h = Math.max(0, g * (n / mu - 1) + g * g);
        }
      }
      da += e * g; aa += e * e * h;
      // Zero times infinity must not turn a valid boundary score into NaN.
      if (f[i]) { db += e * f[i] * g; ab += e * e * f[i] * h; bb += e * e * f[i] * f[i] * h; }
    });
    return { loss: loss * 2, da, db, aa, ab, bb };
  };
  const profileAt = (f: number[], b: number) => {
    const a = rateRoot(a => { const q = evaluate(f, a, b); return { g: q.da, h: q.aa }; });
    const q = evaluate(f, a, b);
    return { a, ...q, g: q.db, h: a > 0 && q.aa > 0 ? Math.max(0, q.bb - q.ab * q.ab / q.aa) : q.bb };
  };
  const fits: Array<{ start: number; end: number; f: number[]; a: number; b: number; loss: number }> = [];
  for (let start = 1; start < times.length - 3; start++) for (let end = start + 2; end < times.length - 1; end++) {
    const f = plates.map(p => Math.max(0, Math.min(1, (p.timeMin - times[start]) / (times[end] - times[start]))));
    const b = rateRoot(b => profileAt(f, b)), q = profileAt(f, b);
    fits.push({ start: times[start], end: times[end], f, a: q.a, b, loss: q.loss });
  }
  const best = fits.reduce((a, b) => b.loss < a.loss - 1e-9 ? b : a), ceiling = best.loss + options.supportDeviance;
  const supported = fits.filter(fit => fit.loss <= ceiling);
  const supports = supported.map(fit => {
    const value = (b: number) => profileAt(fit.f, b).loss;
    let lower = 0;
    if (value(0) > ceiling) {
      let lo = 0, hi = fit.b;
      for (let i = 0; i < 42; i++) { const mid = (lo + hi) / 2; if (value(mid) > ceiling) lo = mid; else hi = mid; }
      lower = (lo + hi) / 2;
    }
    let lo = fit.b, hi = Math.max(1, 2 * fit.b);
    for (let i = 0; value(hi) <= ceiling; i++) {
      if (i === 128) throw new Error('Censored support could not be bracketed; no result was produced.');
      hi *= 2;
    }
    for (let i = 0; i < 42; i++) { const mid = (lo + hi) / 2; if (value(mid) <= ceiling) lo = mid; else hi = mid; }
    return [lower * scale, (lo + hi) / 2 * scale] as [number, number];
  });
  const constantDeviance = profileAt(best.f, 0).loss, unresolved = constantDeviance <= ceiling;
  const boundary = supported.some(fit => fit.start === times[1] || fit.end === times[times.length - 2]);
  const backgroundPFUPerMl = best.a * scale, increasePFUPerMl = best.b * scale, increaseSupport = union(supports);
  const countCoverage = { exact: 0, atMost: 0, atLeast: 0 };
  let exactPlaques = 0;
  const fitted = plates.map((p, i) => {
    const predictedPFUPerMl = backgroundPFUPerMl + increasePFUPerMl * best.f[i], expectedCount = predictedPFUPerMl * p.dilution * p.volumeMl;
    const exact = p.countStatus === 'exact';
    countCoverage[exact ? 'exact' : p.countStatus === 'at-most' ? 'atMost' : 'atLeast']++;
    if (exact) exactPlaques += p.count;
    const devianceContribution = exact ? deviance(p.count, expectedCount) : -2 * logEvent(p.count, expectedCount, p.countStatus, charge);
    return { ...p, expectedCount, predictedPFUPerMl, devianceContribution,
      devianceResidual: exact ? Math.sign(p.count - expectedCount) * Math.sqrt(devianceContribution) : null };
  });
  const warnings = [...CENSORED_LIMITATIONS];
  if (unresolved) warnings.push('The constant curve remains supported: rise timing is withheld.');
  if (boundary) warnings.push('Timing support reaches the search grid boundary.');
  if (options.infectedCentersPerMl === null) warnings.push('Yield is unavailable without an independent infected-center denominator.');
  const result: CensoredPlaqueGrowthFit = { backgroundPFUPerMl, increasePFUPerMl, plateauPFUPerMl: backgroundPFUPerMl + increasePFUPerMl,
    infectiousYieldPerInfectedCenter: options.infectedCentersPerMl === null ? null : increasePFUPerMl / options.infectedCentersPerMl,
    riseStartMin: unresolved ? null : best.start, riseEndMin: unresolved ? null : best.end,
    timingStatus: unresolved ? 'unresolved' : boundary ? 'grid-boundary' : 'grid-supported',
    deviance: fitted.reduce((sum, p) => sum + p.devianceContribution, 0), constantDeviance,
    totalPlaques: countCoverage.exact === plates.length ? exactPlaques : null, exactPlaques, countCoverage,
    increaseSupport, yieldSupport: options.infectedCentersPerMl === null ? null : increaseSupport.map(([lo, hi]) => [lo / options.infectedCentersPerMl!, hi / options.infectedCentersPerMl!]),
    knotSupport: supported.map(f => ({ startMin: f.start, endMin: f.end, deltaDeviance: Math.max(0, f.loss - best.loss) })),
    candidates: fits.length, supportDeviance: options.supportDeviance, fitted, warnings };
  analysisJson(result);
  return result;
}
export async function createPlaqueGrowthRecord(content: string): Promise<AnalysisRecord> {
  const input = parsePlaqueGrowthInput(content), plates = parsePlaqueGrowthCSV(input.csv, input.version);
  const result = input.version === 1 ? fitPlaqueGrowth(plates, input.options) : fitCensoredPlaqueGrowth(plates as CensoredGrowthPlate[], input.options);
  const limitations = input.version === 1 ? LIMITATIONS : CENSORED_LIMITATIONS;
  const coverage = { available: plates.length, total: plates.length, unit: 'records' as const };
  const synthetic = input.provenance.kind === 'synthetic';
  const fitted = (label: string, value: unknown): AnalysisField => synthetic
    ? { label, kind: 'demo', units: 'records', value: analysisJson(value), coverage, limitations: result.warnings,
      assumptions: ['Synthetic source explicitly declared by the author; these are not empirical measurements.'] }
    : { label, kind: 'fitted-estimate', units: 'records', value: analysisJson(value), coverage, limitations: result.warnings,
      fit: { dataInput: 'experiment', objective: input.version === 1 ? 'Independent Poisson count likelihood with known plate exposures; exhaustive observed-time knots'
        : 'Independent Poisson exact-count/inclusive-tail likelihood with known plate exposures; exhaustive observed-time knots', uncertainty: { kind: 'not-estimated' } } };
  return createAnalysisRecord({ method: plaqueGrowthMethod(input.version),
    inputs: [{ id: 'experiment', source: synthetic ? 'demo' : 'local', accession: null,
      description: 'Exact user-authored input JSON, including original plate CSV, assay declaration and source attribution.', data: content }],
    parameters: { ...input.options }, seed: null,
    references: [{ id: 'plaque-count-exposure-model', version: String(input.version), description: input.version === 1
      ? 'Poisson exposure mean = dilution fraction * plated mL * (background + increase * clipped linear rise). Likelihood support is not a calibrated confidence interval.'
      : 'Poisson exposure ramp with exact N=k, inclusive at-most N<=k and at-least N>=k events. Count bounds are not exact observations. Profile support is not a calibrated confidence interval.' }],
    fields: { fit: fitted('Exposure-aware plate-count fit and profile support', result),
      plates: synthetic ? { label: 'Synthetic input plates', kind: 'demo', units: 'records', value: analysisJson(plates), coverage,
        limitations, assumptions: ['Synthetic format/example data, not measured counts.'] }
        : { label: 'Author-supplied extracellular plaque counts', kind: 'observation', units: 'records', value: analysisJson(plates), coverage,
          limitations: ['Source attribution, assay type, independence and countability are author assertions, not remotely authenticated.'], sourceInput: 'experiment' } } });
}
export async function replayPlaqueGrowthRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseAnalysisRecord(content, { methodId: PLAQUE_GROWTH_METHOD.id });
  if (!['1', '2'].includes(saved.method.version)) throw new Error('Unsupported plaque-count method version.');
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'experiment' || typeof saved.inputs[0].data !== 'string') throw new Error('Plaque replay requires one embedded original experiment.');
  const fresh = await createPlaqueGrowthRecord(saved.inputs[0].data);
  if (fresh.cacheKey !== saved.cacheKey || fresh.resultId !== saved.resultId) throw new Error('Recomputed plate-count likelihood, support or input identity differs from the saved result.');
  return fresh;
}
/** Use a producer/replay result; table export is not itself numerical verification. */
export function exportPlaqueGrowthTsv(record: AnalysisRecord): string {
  if (canonical(record.method) !== canonical(plaqueGrowthMethod(Number(record.method.version)))) throw new Error('Expected a plate-count growth record.');
  if (record.method.version === '2') {
    const fit = record.fields.fit.value as unknown as CensoredPlaqueGrowthFit;
    return [`# method=${record.method.id}; version=2; result=${record.resultId}`,
      '# Inclusive count bounds; censored thresholds are not counts. Empty residuals are unavailable, not zero. Likelihood support is not a calibrated confidence interval.',
      `# timingStatus=${fit.timingStatus}; supportDeviance=${fit.supportDeviance}; increaseSupport=${JSON.stringify(fit.increaseSupport)}; yieldSupport=${JSON.stringify(fit.yieldSupport)}`,
      'time_min\tcount_or_bound\tcount_status\tdilution_fraction\tvolume_ml\texpected_count\tpredicted_pfu_per_ml\tdeviance_residual\tdeviance_contribution',
      ...fit.fitted.map(p => [p.timeMin, p.count, p.countStatus, p.dilution, p.volumeMl, p.expectedCount, p.predictedPFUPerMl, p.devianceResidual ?? '', p.devianceContribution].join('\t'))].join('\n') + '\n';
  }
  const fit = record.fields.fit.value as unknown as PlaqueGrowthFit;
  return [`# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}`,
    '# Descriptive Poisson exposure model; likelihood support is not a calibrated confidence interval.',
    `# timingStatus=${fit.timingStatus}; supportDeviance=${fit.supportDeviance}; increaseSupport=${JSON.stringify(fit.increaseSupport)}; yieldSupport=${JSON.stringify(fit.yieldSupport)}`,
    'time_min\tplaque_count\tdilution_fraction\tvolume_ml\texpected_count\tpredicted_pfu_per_ml\tdeviance_residual',
    ...fit.fitted.map(p => [p.timeMin, p.count, p.dilution, p.volumeMl, p.expectedCount, p.predictedPFUPerMl, p.devianceResidual].join('\t'))].join('\n') + '\n';
}
