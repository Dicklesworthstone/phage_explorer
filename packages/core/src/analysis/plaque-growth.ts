/** Exposure-aware inference for uncensored extracellular plaque counts.
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
export const PLAQUE_GROWTH_LIMITS = { bytes: 1_000_000, rows: 2048, times: 32, count: 1_000_000 } as const;
export interface GrowthPlate { timeMin: number; count: number; dilution: number; volumeMl: number }
export interface PlaqueGrowthOptions { infectedCentersPerMl: number | null; supportDeviance: number }
export interface PlaqueGrowthInput {
  format: 'phage-explorer-plaque-growth-input'; version: 1;
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
/** Exact numeric CSV/TSV columns; zero counts are observations, blank/TNTC are not. */
export function parsePlaqueGrowthCSV(text: string): GrowthPlate[] {
  if (typeof text !== 'string' || text.length > PLAQUE_GROWTH_LIMITS.bytes || new TextEncoder().encode(text).length > PLAQUE_GROWTH_LIMITS.bytes) throw new Error('Plaque CSV exceeds 1,000,000 UTF-8 bytes.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/).map((line, index) => ({ line: line.trim(), index }))
    .filter(row => row.line && !row.line.startsWith('#'));
  const separator = lines[0]?.line.includes('\t') ? '\t' : ',';
  if (lines[0]?.line.split(separator).map(s => s.trim()).join(',') !== 'time_min,plaque_count,dilution_fraction,volume_ml') {
    throw new Error('Expected time_min,plaque_count,dilution_fraction,volume_ml.');
  }
  if (lines.length > PLAQUE_GROWTH_LIMITS.rows + 1) throw new Error('Plaque CSV exceeds 2048 rows.');
  return platesFor(lines.slice(1).map(({ line, index }) => {
    const cells = line.split(separator).map(s => s.trim());
    if (cells.length !== 4 || !cells.every(s => /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s))) throw new Error(`Line ${index + 1}: four explicit numeric cells required; censored data are unsupported.`);
    const [timeMin, count, dilution, volumeMl] = cells.map(Number);
    return { timeMin, count, dilution, volumeMl };
  }));
}
export function parsePlaqueGrowthInput(text: string): PlaqueGrowthInput {
  if (typeof text !== 'string' || text.length > PLAQUE_GROWTH_LIMITS.bytes || new TextEncoder().encode(text).length > PLAQUE_GROWTH_LIMITS.bytes) throw new Error('Plaque input exceeds 1,000,000 UTF-8 bytes.');
  const input: unknown = JSON.parse(text);
  exact(input, ['format', 'version', 'measurement', 'title', 'provenance', 'csv', 'options'], 'plaque input');
  if (input.format !== 'phage-explorer-plaque-growth-input' || input.version !== 1 || input.measurement !== 'extracellular-plaque-counts') throw new Error('Expected version 1 extracellular plaque-count input, not PFU/OD/total infective-center data.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('Provide a 1–200 character experiment title.');
  exact(input.provenance, ['kind', 'source'], 'provenance');
  const source = input.provenance;
  if ((source.kind !== 'synthetic' && source.kind !== 'user-supplied') || typeof source.source !== 'string' || !source.source.trim() || source.source.length > 2000) throw new Error('Provide explicit synthetic/user-supplied source attribution.');
  if (typeof input.csv !== 'string') throw new Error('Embed the original plate CSV text, not a filename.');
  parsePlaqueGrowthCSV(input.csv);
  return { format: input.format, version: 1, measurement: input.measurement, title: input.title,
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
export async function createPlaqueGrowthRecord(content: string): Promise<AnalysisRecord> {
  const input = parsePlaqueGrowthInput(content), plates = parsePlaqueGrowthCSV(input.csv), result = fitPlaqueGrowth(plates, input.options);
  const coverage = { available: plates.length, total: plates.length, unit: 'records' as const };
  const synthetic = input.provenance.kind === 'synthetic';
  const fitted = (label: string, value: unknown): AnalysisField => synthetic
    ? { label, kind: 'demo', units: 'records', value: analysisJson(value), coverage, limitations: result.warnings,
      assumptions: ['Synthetic source explicitly declared by the author; these are not empirical measurements.'] }
    : { label, kind: 'fitted-estimate', units: 'records', value: analysisJson(value), coverage, limitations: result.warnings,
      fit: { dataInput: 'experiment', objective: 'Independent Poisson count likelihood with known plate exposures; exhaustive observed-time knots', uncertainty: { kind: 'not-estimated' } } };
  return createAnalysisRecord({ method: PLAQUE_GROWTH_METHOD,
    inputs: [{ id: 'experiment', source: synthetic ? 'demo' : 'local', accession: null,
      description: 'Exact user-authored input JSON, including original plate CSV, assay declaration and source attribution.', data: content }],
    parameters: { ...input.options }, seed: null,
    references: [{ id: 'plaque-count-exposure-model', version: '1', description: 'Poisson exposure mean = dilution fraction * plated mL * (background + increase * clipped linear rise). Likelihood support is not a calibrated confidence interval.' }],
    fields: { fit: fitted('Exposure-aware plate-count fit and profile support', result),
      plates: synthetic ? { label: 'Synthetic input plates', kind: 'demo', units: 'records', value: analysisJson(plates), coverage,
        limitations: LIMITATIONS, assumptions: ['Synthetic format/example data, not measured counts.'] }
        : { label: 'Author-supplied extracellular plaque counts', kind: 'observation', units: 'records', value: analysisJson(plates), coverage,
          limitations: ['Source attribution, assay type, independence and countability are author assertions, not remotely authenticated.'], sourceInput: 'experiment' } } });
}
export async function replayPlaqueGrowthRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseAnalysisRecord(content, { methodId: PLAQUE_GROWTH_METHOD.id, methodVersion: PLAQUE_GROWTH_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'experiment' || typeof saved.inputs[0].data !== 'string') throw new Error('Plaque replay requires one embedded original experiment.');
  const fresh = await createPlaqueGrowthRecord(saved.inputs[0].data);
  if (fresh.cacheKey !== saved.cacheKey || fresh.resultId !== saved.resultId) throw new Error('Recomputed plate-count likelihood, support or input identity differs from the saved result.');
  return fresh;
}
/** Use a producer/replay result; table export is not itself numerical verification. */
export function exportPlaqueGrowthTsv(record: AnalysisRecord): string {
  if (canonical(record.method) !== canonical(PLAQUE_GROWTH_METHOD)) throw new Error('Expected a plate-count growth record.');
  const fit = record.fields.fit.value as unknown as PlaqueGrowthFit;
  return [`# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}`,
    '# Descriptive Poisson exposure model; likelihood support is not a calibrated confidence interval.',
    `# timingStatus=${fit.timingStatus}; supportDeviance=${fit.supportDeviance}; increaseSupport=${JSON.stringify(fit.increaseSupport)}; yieldSupport=${JSON.stringify(fit.yieldSupport)}`,
    'time_min\tplaque_count\tdilution_fraction\tvolume_ml\texpected_count\tpredicted_pfu_per_ml\tdeviance_residual',
    ...fit.fitted.map(p => [p.timeMin, p.count, p.dilution, p.volumeMl, p.expectedCount, p.predictedPFUPerMl, p.devianceResidual].join('\t'))].join('\n') + '\n';
}
