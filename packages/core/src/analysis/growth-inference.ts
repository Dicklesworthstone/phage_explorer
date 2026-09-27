/**
 * Experimental growth-curve inference, separate from burst-kinetics' teaching sigmoid.
 * Susceptible cells + an Erlang infection-age chain + extracellular infectious phage.
 * The stage count and initial conditions are supplied, NOT fitted or inferred from a genome.
 * Stage-model context: https://pmc.ncbi.nlm.nih.gov/articles/PMC11379933/
 * Our equations and observation rules are stated explicitly below; this is not a reproduction of that paper's complete nutrient/lysogeny model.
 * Confidence intervals below are local Gaussian/Wald approximations, not bootstrap,
 * credible intervals, model validation, or proof of global parameter identifiability.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export type GrowthMeasurement = 'PFU' | 'CFU' | 'OD';
export type GrowthParameter = 'adsorptionRate' | 'latentPeriod' | 'burstSize';
export const GROWTH_PARAMETERS: readonly GrowthParameter[] = ['adsorptionRate', 'latentPeriod', 'burstSize'];
export interface GrowthObservation {
  timeMin: number;
  type: GrowthMeasurement;
  value: number;
  /** Known observation SD: log10 units for PFU/CFU, OD units for OD. */
  sigma: number;
}
export interface GrowthConditions {
  initialBacteria: number;
  initialPhage: number;
  bacterialGrowthRate: number;
  phageDecayRate: number;
  odCellsPerMl: number;
  /** Fixed number of infected stages; mean L, SD L/sqrt(stages). */
  stages: number;
}
export interface GrowthDataset {
  format: 'phage-explorer-growth';
  version: 1;
  name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string | null };
  conditions: GrowthConditions;
  observations: GrowthObservation[];
}
export interface GrowthFitOptions {
  initial: Record<GrowthParameter, number>;
  freeParameters: GrowthParameter[];
  seed: number;
  starts: number;
  maxIterations: number;
}
export interface GrowthTrajectoryPoint {
  timeMin: number; bacteria: number; infected: number; phage: number; od: number;
}
export interface GrowthFitResult {
  parameters: Record<GrowthParameter, number>;
  estimates: Record<GrowthParameter, {
    value: number;
    status: 'fixed' | 'locally-estimable' | 'unresolved';
    interval95: [number, number] | null;
    reason: string;
  }>;
  objective: number;
  degreesOfFreedom: number;
  converged: boolean;
  termination: string;
  sensitivityRank: number;
  sensitivityCondition: number | null;
  singularValues: number[];
  solverDiscrepancySigma: number;
  evaluations: number;
  rejectedEvaluations: number;
  starts: Array<{ objective: number | null; converged: boolean; parameters: Record<GrowthParameter, number> }>;
  residuals: Array<GrowthObservation & { predicted: number; standardizedResidual: number }>;
  trajectory: GrowthTrajectoryPoint[];
  warnings: string[];
}
export const GROWTH_LIMITS = { bytes: 2 * 1024 * 1024, observations: 256, minutes: 180, integrationSteps: 8000, fitSteps: 2000000 } as const;
export const GROWTH_BOUNDS: Record<GrowthParameter, readonly [number, number]> = {
  adsorptionRate: [1e-12, 1e-7], latentPeriod: [1, 180], burstSize: [1, 1000],
};
export const DEFAULT_GROWTH_CONDITIONS: GrowthConditions = {
  initialBacteria: 1e7, initialPhage: 1e5, bacterialGrowthRate: 0,
  phageDecayRate: 0, odCellsPerMl: 8e8, stages: 4,
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Record<string, unknown>, expected: readonly string[], context: string): void {
  if (Object.keys(v).length !== expected.length || Object.keys(v).some(k => !expected.includes(k))) throw new Error(`${context} has missing or unsupported fields.`);
}
function text(v: unknown, context: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error(`${context} must be nonempty plain text, at most 512 characters.`);
  return v.trim();
}
function number(v: unknown, min: number, max: number, context: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${context} must be finite, between ${min} and ${max}.`);
  return v;
}
export function validateGrowthConditions(value: unknown): GrowthConditions {
  if (!object(value)) throw new Error('Explicit experimental initial conditions are required.');
  keys(value, Object.keys(DEFAULT_GROWTH_CONDITIONS), 'Conditions');
  const stages = number(value.stages, 1, 8, 'Infected stages');
  if (!Number.isInteger(stages)) throw new Error('Infected stages must be an integer.');
  return {
    initialBacteria: number(value.initialBacteria, 0, 1e9, 'Initial susceptible cells/mL'),
    initialPhage: number(value.initialPhage, 0, 1e9, 'Initial extracellular PFU/mL'),
    bacterialGrowthRate: number(value.bacterialGrowthRate, 0, 0.05, 'Bacterial growth rate /min'),
    phageDecayRate: number(value.phageDecayRate, 0, 0.1, 'Phage decay rate /min'),
    odCellsPerMl: number(value.odCellsPerMl, 1e4, 1e12, 'OD calibration cells/mL per OD'), stages,
  };
}
export function validateGrowthDataset(value: unknown): GrowthDataset {
  if (!object(value) || value.format !== 'phage-explorer-growth' || value.version !== 1 || !object(value.source)) throw new Error('Unsupported growth dataset format/version.');
  keys(value, ['format', 'version', 'name', 'source', 'conditions', 'observations'], 'Growth dataset');
  keys(value.source, ['kind', 'description', 'reference'], 'Growth source');
  if (value.source.kind !== 'local' && value.source.kind !== 'demo') throw new Error('Growth source must be local or demo.');
  if (!Array.isArray(value.observations) || value.observations.length < 6 || value.observations.length > GROWTH_LIMITS.observations) throw new Error('Growth data requires 6–256 observations, including replicates.');
  const observations = value.observations.map((row, index): GrowthObservation => {
    if (!object(row)) throw new Error(`Observation ${index + 1} must be an object.`);
    keys(row, ['timeMin', 'type', 'value', 'sigma'], `Observation ${index + 1}`);
    if (row.type !== 'PFU' && row.type !== 'CFU' && row.type !== 'OD') throw new Error('Measurement type must be PFU, CFU or OD; units cannot be guessed.');
    const v = number(row.value, 0, row.type === 'OD' ? 100 : 1e15, `Observation ${index + 1} value`);
    if (row.type !== 'OD' && v === 0) throw new Error('Zero PFU/CFU is censored under the log observation model. Supply positive quantified counts; do not replace detection limits with zeros.');
    return { timeMin: number(row.timeMin, 0, GROWTH_LIMITS.minutes, 'Observation time in minutes'), type: row.type, value: v,
      sigma: number(row.sigma, 1e-6, row.type === 'OD' ? 10 : 5, 'Known observation SD (OD units or log10 count units)') };
  }).sort((a, b) => a.timeMin - b.timeMin);
  if (new Set(observations.map(row => row.timeMin)).size < 3 || observations.at(-1)!.timeMin === 0) throw new Error('At least three distinct observation times are required.');
  const result: GrowthDataset = {
    format: 'phage-explorer-growth', version: 1, name: text(value.name, 'Dataset name'),
    source: { kind: value.source.kind, description: text(value.source.description, 'Source description'),
      reference: value.source.reference === null ? null : text(value.source.reference, 'Source reference') },
    conditions: validateGrowthConditions(value.conditions), observations,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > GROWTH_LIMITS.bytes) throw new Error('Growth dataset exceeds 2 MiB.');
  return result;
}
/** Numeric long-form CSV/TSV only; the file never supplies executable instructions. */
export function parseGrowthData(content: string, name: string, conditions: GrowthConditions): GrowthDataset {
  if (new TextEncoder().encode(content).length > GROWTH_LIMITS.bytes) throw new Error('Growth input exceeds 2 MiB.');
  const source = content.replace(/^\uFEFF/, '').trim();
  if (source.startsWith('{')) return validateGrowthDataset(JSON.parse(source));
  const lines = source.split(/\r?\n/), delimiter = lines[0].includes('\t') ? '\t' : ',';
  if (lines[0].split(delimiter).map(s => s.trim()).join(',') !== 'timeMin,type,value,sigma') throw new Error('Expected CSV/TSV header timeMin,type,value,sigma. PFU/CFU values are per mL; sigma is log10 SD for counts, ordinary SD for OD.');
  const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const observations = lines.slice(1).map((line, i) => {
    const cells = line.split(delimiter).map(s => s.trim());
    if (cells.length !== 4 || [0, 2, 3].some(j => !decimal.test(cells[j]))) throw new Error(`Invalid numeric observation at line ${i + 2}; blanks/NA are not zeros.`);
    return { timeMin: Number(cells[0]), type: cells[1], value: Number(cells[2]), sigma: Number(cells[3]) };
  });
  return validateGrowthDataset({ format: 'phage-explorer-growth', version: 1, name,
    source: { kind: 'local', description: name, reference: null }, conditions, observations });
}
export function resolveGrowthOptions(value: unknown = {}): GrowthFitOptions {
  if (!object(value) || Object.keys(value).some(k => !['initial', 'freeParameters', 'seed', 'starts', 'maxIterations'].includes(k))) throw new Error('Unsupported fitting options.');
  const initial = value.initial ?? { adsorptionRate: 2e-9, latentPeriod: 25, burstSize: 50 };
  if (!object(initial)) throw new Error('Initial parameters are required.');
  keys(initial, GROWTH_PARAMETERS, 'Initial parameters');
  const parameters = Object.fromEntries(GROWTH_PARAMETERS.map(key => [key, number(initial[key], ...GROWTH_BOUNDS[key], key)])) as Record<GrowthParameter, number>;
  const free = value.freeParameters ?? [...GROWTH_PARAMETERS];
  if (!Array.isArray(free) || !free.length || free.length > 3 || new Set(free).size !== free.length || free.some(k => !GROWTH_PARAMETERS.includes(k))) throw new Error('Fit one to three unique supported parameters.');
  const seed = number(value.seed ?? 42, 0, 0xffffffff, 'Fit seed'), starts = number(value.starts ?? 3, 1, 5, 'Optimizer starts');
  const maxIterations = number(value.maxIterations ?? 80, 10, 160, 'Optimizer iterations per start');
  if (![seed, starts, maxIterations].every(Number.isInteger)) throw new Error('Seed, starts and iterations must be integers.');
  return { initial: parameters, freeParameters: [...free], seed, starts, maxIterations };
}

interface IntegrationBudget { steps: number }
class IntegrationFailure extends Error {}
class FitBudgetExceeded extends Error {}
/** Actual ODE solve, sampled at exact requested times (no rounded counts or interpolation). */
export function simulateGrowth(
  parameters: Record<GrowthParameter, number>, input: GrowthConditions, times: readonly number[],
  tolerance = 1e-6, budget?: IntegrationBudget,
): GrowthTrajectoryPoint[] {
  const c = validateGrowthConditions(input);
  const k = number(parameters.adsorptionRate, 0, 1e-7, 'Adsorption rate');
  const mean = number(parameters.latentPeriod, 1, 180, 'Mean infection-to-lysis time');
  const burst = number(parameters.burstSize, 0, 1000, 'Burst yield');
  number(tolerance, 1e-9, 1e-3, 'Integration tolerance');
  if (!times.length || times.length > 1024 || times.some(t => !Number.isFinite(t) || t < 0 || t > GROWTH_LIMITS.minutes)) throw new Error('Invalid growth trajectory times.');
  const ordered = [...new Set(times)].sort((a, b) => a - b);
  const scale = Math.max(1, c.initialBacteria, c.initialPhage), rate = c.stages / mean, last = c.stages + 1;
  let y = [c.initialBacteria / scale, ...Array(c.stages).fill(0), c.initialPhage / scale];
  let time = 0, h = 0.25, steps = 0;
  const derivative = (v: number[]): number[] => {
    const adsorption = k * scale * v[0] * v[last];
    const d = [c.bacterialGrowthRate * v[0] - adsorption, adsorption - rate * v[1]];
    for (let j = 2; j <= c.stages; j++) d.push(rate * (v[j - 1] - v[j]));
    d.push(burst * rate * v[c.stages] - adsorption - c.phageDecayRate * v[last]);
    return d;
  };
  const valid = (v: number[]) => v.every(x => Number.isFinite(x) && x >= 0 && x * scale <= 1e16);
  const rk4 = (v: number[], dt: number): number[] | null => {
    const a = derivative(v), va = v.map((x, j) => x + dt * a[j] / 2);
    if (!valid(va)) return null;
    const b = derivative(va), vb = v.map((x, j) => x + dt * b[j] / 2);
    if (!valid(vb)) return null;
    const d = derivative(vb), vd = v.map((x, j) => x + dt * d[j]);
    if (!valid(vd)) return null;
    const e = derivative(vd), next = v.map((x, j) => x + dt / 6 * (a[j] + 2 * b[j] + 2 * d[j] + e[j]));
    return valid(next) ? next : null;
  };
  const points = new Map<number, GrowthTrajectoryPoint>();
  for (const target of ordered) {
    while (time < target) {
      if (++steps > GROWTH_LIMITS.integrationSteps) throw new IntegrationFailure('Growth integration exceeded its step budget; reduce the time/rate range.');
      if (budget && ++budget.steps > GROWTH_LIMITS.fitSteps) throw new FitBudgetExceeded('Growth fit exceeded its computation budget; fit fewer parameters or reduce starts, observations or duration.');
      h = Math.min(h, target - time);
      if (h < 1e-10) throw new IntegrationFailure('Growth integration could not advance at the requested tolerance.');
      const full = rk4(y, h), half = rk4(y, h / 2), fine = half ? rk4(half, h / 2) : null;
      if (!full || !fine) { h /= 2; continue; }
      const error = Math.max(...fine.map((x, j) => Math.abs(x - full[j]) / (15 * (1e-12 + tolerance * Math.max(Math.abs(y[j]), Math.abs(x))))));
      if (error <= 1) {
        // Richardson correction removes the leading RK4 error. Never clip a
        // negative population into existence; fall back to the positive fine step.
        const corrected = fine.map((x, j) => x + (x - full[j]) / 15);
        y = valid(corrected) ? corrected : fine;
        time = h === target - time ? target : time + h;
      }
      h *= Math.min(2, Math.max(0.2, error === 0 ? 2 : 0.9 * error ** -0.2));
      h = Math.min(h, 1);
    }
    const infected = y.slice(1, last).reduce((a, b) => a + b, 0) * scale;
    points.set(target, { timeMin: target, bacteria: y[0] * scale, infected, phage: y[last] * scale, od: (y[0] * scale + infected) / c.odCellsPerMl });
  }
  return times.map(t => ({ ...points.get(t)! }));
}
const prediction = (p: GrowthTrajectoryPoint, type: GrowthMeasurement) => type === 'PFU' ? p.phage : type === 'CFU' ? p.bacteria : p.od;
function residuals(dataset: GrowthDataset, p: Record<GrowthParameter, number>, tolerance: number, budget?: IntegrationBudget): number[] {
  const trajectory = simulateGrowth(p, dataset.conditions, dataset.observations.map(row => row.timeMin), tolerance, budget);
  return dataset.observations.map((row, i) => {
    const predicted = prediction(trajectory[i], row.type);
    if (row.type !== 'OD' && predicted <= 0) throw new IntegrationFailure('Positive PFU/CFU measurements require positive model predictions. Check initial conditions.');
    return (row.type === 'OD' ? predicted - row.value : Math.log10(predicted) - Math.log10(row.value)) / row.sigma;
  });
}
const squareSum = (v: number[]) => v.reduce((s, x) => s + x * x, 0);
/** Pivoted small dense solve. Singular systems return null, never invented covariance. */
function solve(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]), n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    if (Math.abs(m[pivot][i]) < 1e-20) return null;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const d = m[i][i];
    for (let j = i; j <= n; j++) m[i][j] /= d;
    for (let j = 0; j < n; j++) if (j !== i) {
      const factor = m[j][i];
      for (let l = i; l <= n; l++) m[j][l] -= factor * m[i][l];
    }
  }
  return m.map(row => row[n]);
}
function eigenvalues(matrix: number[][]): number[] {
  const a = matrix.map(row => [...row]), n = a.length;
  for (let iter = 0; iter < 60 && n > 1; iter++) {
    let p = 0, q = 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) <= 1e-14 * Math.max(1, ...a.map((r, i) => Math.abs(r[i])))) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const ap = a[p][p], aq = a[q][q], cross = a[p][q];
    for (let j = 0; j < n; j++) if (j !== p && j !== q) {
      const x = a[j][p], y = a[j][q];
      a[j][p] = a[p][j] = c * x - s * y;
      a[j][q] = a[q][j] = s * x + c * y;
    }
    a[p][p] = c * c * ap - 2 * c * s * cross + s * s * aq;
    a[q][q] = s * s * ap + 2 * c * s * cross + c * c * aq;
    a[p][q] = a[q][p] = 0;
  }
  return a.map((row, i) => Math.max(0, row[i])).sort((a, b) => b - a);
}

export function fitGrowthDataset(input: GrowthDataset, options: GrowthFitOptions, progress: (message: string) => void = () => {}, sharedBudget?: { steps: number }): GrowthFitResult {
  const dataset = validateGrowthDataset(input), config = resolveGrowthOptions(options), names = config.freeParameters;
  const n = names.length, lower = names.map(k => Math.log(GROWTH_BOUNDS[k][0])), upper = names.map(k => Math.log(GROWTH_BOUNDS[k][1]));
  const clip = (v: number[]) => v.map((x, i) => Math.max(lower[i], Math.min(upper[i], x)));
  const decode = (v: number[]) => ({ ...config.initial, ...Object.fromEntries(names.map((key, i) =>
    [key, Math.max(GROWTH_BOUNDS[key][0], Math.min(GROWTH_BOUNDS[key][1], Math.exp(v[i])))])) });
  let evaluations = 0, rejectedEvaluations = 0;
  // A profile may share the same finite integration budget across nuisance refits.
  const budget = sharedBudget ?? { steps: 0 };
  const evaluate = (v: number[]): { r: number[]; cost: number } => {
    evaluations++;
    try {
      const r = residuals(dataset, decode(v), 1e-6, budget);
      return { r, cost: squareSum(r) };
    } catch (cause) {
      if (!(cause instanceof IntegrationFailure)) throw cause;
      rejectedEvaluations++;
      return { r: [], cost: Infinity };
    }
  };
  const jacobian = (v: number[], base: number[]) => names.map((_, j) => {
    const hi = [...v], lo = [...v];
    hi[j] = Math.min(upper[j], v[j] + 1e-4); lo[j] = Math.max(lower[j], v[j] - 1e-4);
    const plus = evaluate(hi), minus = evaluate(lo);
    if (!Number.isFinite(plus.cost) || !Number.isFinite(minus.cost)) throw new Error('Could not evaluate local parameter sensitivity. Narrow the parameter/condition range.');
    return base.map((_, i) => (plus.r[i] - minus.r[i]) / (hi[j] - lo[j]));
  });
  const gram = (j: number[][]) => j.map(a => j.map(b => a.reduce((sum, x, i) => sum + x * b[i], 0)));
  const optimize = (initial: number[]) => {
    let v = clip(initial), current = evaluate(v), converged = false, termination = 'iteration limit', damping = 0.001;
    if (!Number.isFinite(current.cost)) return { v, ...current, converged, termination: 'initial model integration failed' };
    for (let iteration = 0; iteration < config.maxIterations; iteration++) {
      if (iteration % 10 === 0) progress(`Fitting: ${evaluations} model evaluations`);
      const j = jacobian(v, current.r), g = j.map(col => col.reduce((sum, x, i) => sum + x * current.r[i], 0)), hessian = gram(j);
      const projected = g.map((x, i) => v[i] <= lower[i] + 1e-10 && x > 0 || v[i] >= upper[i] - 1e-10 && x < 0 ? 0 : x);
      if (current.cost < 1e-12 || Math.max(...projected.map(Math.abs)) < 1e-6) { converged = true; termination = 'objective/gradient tolerance'; break; }
      let accepted = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const regularized = hessian.map((row, i) => row.map((x, k) => x + (k === i ? damping * Math.max(1e-8, hessian[i][i]) : 0)));
        const step = solve(regularized, g.map(x => -x));
        if (!step) { damping *= 10; continue; }
        const nextV = clip(v.map((x, i) => x + Math.max(-1, Math.min(1, step[i])))), next = evaluate(nextV);
        const distance = Math.max(...v.map((x, i) => Math.abs(nextV[i] - x)));
        if (next.cost < current.cost) {
          const decrease = current.cost - next.cost;
          v = nextV; current = next; damping = Math.max(1e-10, damping / 3); accepted = true;
          if (distance < 1e-6 && decrease < 1e-8 * Math.max(1, current.cost)) { converged = true; termination = 'step/objective tolerance'; }
          break;
        }
        damping *= 10;
      }
      if (converged) break;
      if (!accepted) { termination = 'no improving step'; break; }
    }
    return { v, ...current, converged, termination };
  };
  let rng = config.seed;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 2 ** 32; };
  const initial = names.map(k => Math.log(config.initial[k]));
  const starts = Array.from({ length: config.starts }, (_, i) => optimize(i === 0 ? initial : initial.map((x, j) => x + (random() - 0.5) * Math.min(4, upper[j] - lower[j]))));
  starts.sort((a, b) => a.cost - b.cost || Number(b.converged) - Number(a.converged));
  const best = starts[0];
  if (!Number.isFinite(best.cost)) throw new Error('No fit produced a valid trajectory. Check initial conditions and measurement definitions.');
  const parameters = decode(best.v), j = jacobian(best.v, best.r), information = gram(j), eigen = eigenvalues(information);
  const singularValues = eigen.map(Math.sqrt), threshold = Math.max(1e-6, singularValues[0] * 1e-6);
  const sensitivityRank = singularValues.filter(x => x > threshold).length;
  const sensitivityCondition = sensitivityRank === n ? singularValues[0] / singularValues[n - 1] : null;
  const covariance = information.map((_, i) => solve(information, names.map((_, j) => i === j ? 1 : 0)));
  const refined = residuals(dataset, parameters, 1e-7, budget);
  const solverDiscrepancySigma = Math.max(...best.r.map((x, i) => Math.abs(x - refined[i])));
  const objective = squareSum(refined);
  const degreesOfFreedom = dataset.observations.length - n;
  const warnings = [
    'Conditional mechanistic fit, not an experimentally validated phage phenotype. Initial counts, growth/decay, stage count and OD calibration are fixed inputs.',
    'PFU means extracellular infectious phage/mL; CFU counts susceptible colony-forming cells only. OD is (susceptible + infected cells)/the supplied calibration, ignoring debris and cell-size changes.',
    'Infected stages imply an Erlang infection-to-lysis distribution, not a fixed delay. No lysogeny, resistance, nutrient limitation, adsorption to infected cells or lysis inhibition is modeled.',
    'Observation errors are independent Gaussian with the supplied SDs: log10 PFU/CFU, linear OD. Censored counts, correlated time-series errors and unknown error scales are unsupported.',
    'Intervals are local 95% Gaussian/Wald approximations in log parameters using inverse JᵀJ and known observation SDs. They are not bootstrap or Bayesian credible intervals, and do not establish global identifiability.',
  ];
  const competing = starts.some(s => Number.isFinite(s.cost) && s.cost - best.cost < 3.841459 && s.v.some((x, i) => Math.abs(x - best.v[i]) > Math.log(2)));
  const atBound = best.v.some((value, index) => value - lower[index] < 1e-6 || upper[index] - value < 1e-6);
  const unresolved = !best.converged ? 'Optimizer did not converge.' : atBound ? 'Best fit touches a parameter bound; unconstrained local confidence intervals are not supported.' : sensitivityRank < n ? 'Sensitivity matrix is rank deficient: fitted parameters cannot be separated locally.'
    : sensitivityCondition! > 1e5 ? 'Sensitivity matrix is ill-conditioned.' : solverDiscrepancySigma > 0.02 ? 'Numerical integration error is material relative to observation noise.'
      : objective / degreesOfFreedom > 4 ? 'Residuals are too large for the declared observation error/model.' : competing ? 'Multiple starts found substantially different parameters with comparable likelihood.' : '';
  if (unresolved) warnings.push(unresolved);
  const estimates = Object.fromEntries(GROWTH_PARAMETERS.map(key => {
    const index = names.indexOf(key), value = parameters[key];
    if (index < 0) return [key, { value, status: 'fixed', interval95: null, reason: 'User-supplied fixed parameter; not an estimate.' }];
    let reason = unresolved;
    const variance = covariance[index]?.[index];
    let interval95: [number, number] | null = null;
    if (!reason && variance !== undefined && variance > 0) {
      const radius = 1.959963984540054 * Math.sqrt(variance), lo = Math.exp(best.v[index] - radius), hi = Math.exp(best.v[index] + radius);
      if (!Number.isFinite(hi) || lo <= GROWTH_BOUNDS[key][0] || hi >= GROWTH_BOUNDS[key][1]) reason = 'Confidence limits reach the permitted parameter range; no bounded interval is supported.';
      else interval95 = [lo, hi];
    } else if (!reason) reason = 'Parameter variance is unavailable.';
    return [key, { value, status: interval95 ? 'locally-estimable' : 'unresolved', interval95,
      reason: reason || 'Local approximation conditional on the supplied model, fixed inputs and observation SDs.' }];
  })) as GrowthFitResult['estimates'];
  const sampled = simulateGrowth(parameters, dataset.conditions, dataset.observations.map(row => row.timeMin), 1e-7, budget);
  const lastTime = dataset.observations.at(-1)!.timeMin;
  const trajectory = simulateGrowth(parameters, dataset.conditions, Array.from({ length: 161 }, (_, i) => lastTime * i / 160), 1e-7, budget);
  return { parameters, estimates, objective, degreesOfFreedom, converged: best.converged, termination: best.termination,
    sensitivityRank, sensitivityCondition, singularValues, solverDiscrepancySigma, evaluations, rejectedEvaluations,
    starts: starts.map(s => ({ objective: Number.isFinite(s.cost) ? s.cost : null, converged: s.converged, parameters: decode(s.v) })),
    residuals: dataset.observations.map((row, i) => ({ ...row, predicted: prediction(sampled[i], row.type), standardizedResidual: refined[i] })), trajectory, warnings };
}

const GROWTH_METHOD = { id: 'mechanistic-growth-fit', version: '1', implementation: 'Erlang infection chain; adaptive RK4 step-doubling; bounded multistart damped least squares in log parameters; local known-SD Wald intervals' };
const GROWTH_REFERENCES = [{ id: 'infection-stage-model', version: '1', description: 'dB=mu B-k BP; dI1=k BP-m I1/L; dIj=m(Ij-1-Ij)/L; dP=b m Im/L-k BP-delta P. Initially all infected compartments are zero.' },
  { id: 'observation-likelihood', version: '1', description: 'Independent normal errors with supplied known SDs in linear OD/log10 counts; local information J^T J, interval multiplier 1.959963984540054.' }];
export async function createGrowthRecord(dataset: GrowthDataset, options: GrowthFitOptions, result: GrowthFitResult): Promise<AnalysisRecord> {
  const data = validateGrowthDataset(dataset), config = resolveGrowthOptions(options);
  const coverage = { available: data.observations.length, total: data.observations.length, unit: 'records' as const };
  const field = (label: string, value: unknown) => data.source.kind === 'demo'
    ? { label, value: analysisJson(value), kind: 'demo' as const, units: 'records' as const, coverage, limitations: result.warnings,
      assumptions: ['Explicit synthetic input; parameter recovery does not validate the model for experimental data.'] }
    : { label, value: analysisJson(value), kind: 'fitted-estimate' as const, units: 'records' as const, coverage, limitations: result.warnings,
      fit: { dataInput: 'growthData', objective: 'Weighted sum of squared log10 count/linear OD residuals under known observation SDs.', uncertainty: { kind: 'not-estimated' as const } } };
  // Parameter-specific interval status is in estimates. No scalar interval is assigned to the aggregate record field.
  return createAnalysisRecord({ method: GROWTH_METHOD, inputs: [{ id: 'growthData', accession: null, source: data.source.kind,
    description: data.source.description, data: analysisJson(data) }], parameters: analysisJson(config) as AnalysisRecord['parameters'], seed: config.seed, references: GROWTH_REFERENCES,
    fields: { estimates: field('Conditional parameter estimates and individual interval availability', result.estimates),
      fit: field('Numerical fit, trajectories, residuals and identifiability diagnostics', result) } });
}
export async function replayGrowthRecord(content: string, progress?: (message: string) => void): Promise<{ dataset: GrowthDataset; options: GrowthFitOptions; result: GrowthFitResult; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: GROWTH_METHOD.id, methodVersion: GROWTH_METHOD.version });
  if (saved.method.implementation !== GROWTH_METHOD.implementation || JSON.stringify(analysisJson(saved.references)) !== JSON.stringify(analysisJson(GROWTH_REFERENCES)) ||
    saved.inputs.length !== 1 || saved.inputs[0].id !== 'growthData') throw new Error('Growth model, reference or input contract differs.');
  const dataset = validateGrowthDataset(saved.inputs[0].data), options = resolveGrowthOptions(saved.parameters);
  const result = fitGrowthDataset(dataset, options, progress), record = await createGrowthRecord(dataset, options, result);
  if (record.resultId !== saved.resultId) throw new Error('Fresh growth fit differs from the saved result; the saved output was not installed.');
  return { dataset, options, result, record };
}
