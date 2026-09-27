/** Profile likelihood for the accepted growth model, not a fixed-nuisance likelihood slice.
 * Raue et al. (2009), doi:10.1093/bioinformatics/btp358. This traces the connected
 * component around a numerical optimum; bounded multistart optimization is NOT
 * a proof of the global optimum or structural identifiability.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { GROWTH_BOUNDS, GROWTH_PARAMETERS, fitGrowthDataset, createGrowthRecord, resolveGrowthOptions,
  simulateGrowth, validateGrowthDataset, type GrowthDataset, type GrowthFitOptions, type GrowthFitResult,
  type GrowthParameter } from './growth-inference';

// For known independent Gaussian SDs, SSE(candidate)-SSE(MLE) = -2 log LR.
// chi2.ppf(.95, 1); individual-parameter, not simultaneous 3-parameter coverage.
export const GROWTH_PROFILE_CUTOFF = 3.841458820694124;
export const GROWTH_PROFILE_LIMITS = { points: 64, expansionSteps: 16, rootSteps: 14 } as const;
export interface GrowthProfilePoint {
  value: number;
  objective: number | null;
  delta: number | null;
  conditionalObjective: number | null;
  parameters: Record<GrowthParameter, number> | null;
  converged: boolean;
  reason: string | null;
}
export interface GrowthProfileEndpoint {
  status: 'crossed' | 'range-limit' | 'failed' | 'better-fit';
  value: number | null;
  delta: number | null;
  reason: string;
}
export interface GrowthProfileResult {
  parameter: GrowthParameter;
  baselineResultId: string;
  baselineObjective: number;
  cutoff: number;
  lower: GrowthProfileEndpoint;
  upper: GrowthProfileEndpoint;
  interval95: [number, number] | null;
  points: GrowthProfilePoint[];
  warnings: string[];
}
export interface ProfiledGrowthFit {
  dataset: GrowthDataset; options: GrowthFitOptions; result: GrowthFitResult; record: AnalysisRecord;
  profile: GrowthProfileResult; profileRecord: AnalysisRecord;
}

/** Same declared observation model, using the shared ODE solver at refinement tolerance. */
function residuals(dataset: GrowthDataset, parameters: Record<GrowthParameter, number>, budget: { steps: number }, tolerance = 1e-7): number[] {
  const states = simulateGrowth(parameters, dataset.conditions, dataset.observations.map(row => row.timeMin), tolerance, budget);
  return dataset.observations.map((row, i) => {
    const expected = row.type === 'OD' ? states[i].od : row.type === 'PFU' ? states[i].phage : states[i].bacteria;
    if (row.type !== 'OD' && expected <= 0) throw new Error('Profile requires positive predicted counts.');
    const residual = (row.type === 'OD' ? expected - row.value : Math.log10(expected) - Math.log10(row.value)) / row.sigma;
    return residual;
  });
}
function objective(dataset: GrowthDataset, parameters: Record<GrowthParameter, number>, budget: { steps: number }): number {
  return residuals(dataset, parameters, budget).reduce((sum, value) => sum + value * value, 0);
}

const METHOD = { id: 'mechanistic-growth-profile', version: '1',
  implementation: 'Accepted growth-fit-v1; bounded nuisance refits; bidirectional log-space expansion and bisection; individual known-SD likelihood-ratio component' };
const REFERENCE = { id: 'growth-profile-likelihood', version: 'Raue-2009/component-v1',
  description: 'Reoptimize the remaining free parameters at each fixed candidate. Individual 95% asymptotic cutoff delta SSE=3.841458820694124. Trace the local connected component, not all disconnected modes.' };

/** Refit from original observations; never trust a saved candidate as the optimum. */
export async function profileGrowthDataset(input: GrowthDataset, settings: GrowthFitOptions, parameter: GrowthParameter,
  report: (message: string) => void = () => {}, expectedBaselineId?: string): Promise<ProfiledGrowthFit> {
  const dataset = validateGrowthDataset(input), options = resolveGrowthOptions(settings);
  if (!GROWTH_PARAMETERS.includes(parameter) || !options.freeParameters.includes(parameter)) throw new Error('Only an estimated growth parameter can be profiled; fixed inputs are not estimates.');
  report('Recomputing the accepted fit before profiling');
  const budget = { steps: 0 };
  const result = fitGrowthDataset(dataset, options, report, budget), record = await createGrowthRecord(dataset, options, result);
  if (expectedBaselineId !== undefined && record.resultId !== expectedBaselineId) throw new Error('Profile input/settings differ from the accepted fit. No profile was installed.');
  const nuisance = options.freeParameters.filter(key => key !== parameter), baseline = result.objective;
  const [minimum, maximum] = GROWTH_BOUNDS[parameter], optimum = result.parameters[parameter];
  const points: GrowthProfilePoint[] = [{ value: optimum, objective: baseline, delta: 0, conditionalObjective: baseline,
    parameters: { ...result.parameters }, converged: result.converged, reason: result.converged ? null : result.termination }];
  const betterTolerance = Math.max(1e-3, 1e-6 * baseline);
  const at = (value: number, warm: Record<GrowthParameter, number>): GrowthProfilePoint => {
    const existing = points.find(point => point.value === value);
    if (existing) return existing;
    if (points.length >= GROWTH_PROFILE_LIMITS.points) throw new Error('Profile reached its bounded point budget.');
    report(`Profiling ${parameter}: candidate ${points.length}`);
    let point: GrowthProfilePoint;
    try {
      const fixed = { ...result.parameters, [parameter]: value }, conditionalObjective = objective(dataset, fixed, budget);
      let parameters = fixed, cost = conditionalObjective, converged = true, reason: string | null = null;
      if (nuisance.length) {
        const continued = { ...warm, [parameter]: value };
        // Continuation is only a starting point. Always compare it with the
        // original optimum at this fixed candidate, then run multiple starts.
        let initial = fixed;
        try { if (objective(dataset, continued, budget) < conditionalObjective) initial = continued; } catch { /* Use the valid baseline start. */ }
        const fitted = fitGrowthDataset(dataset, { ...options, initial, freeParameters: nuisance,
          starts: Math.max(2, options.starts) }, () => {}, budget);
        parameters = fitted.parameters; cost = fitted.objective; converged = fitted.converged;
        // A numerically indistinguishable unconverged start can sort before a
        // genuinely converged one. Use the latter only after re-evaluating its
        // objective; never relabel a failed optimization as converged.
        if (!converged) {
          const alternatives = fitted.starts.filter(start => start.converged).map(start => ({
            parameters: start.parameters, objective: objective(dataset, start.parameters, budget),
          })).sort((a, b) => a.objective - b.objective);
          const certified = alternatives[0];
          if (certified && certified.objective <= cost + Math.max(1e-6, cost * 1e-6)) {
            parameters = certified.parameters; cost = certified.objective; converged = true;
          }
        }
        const coarse = residuals(dataset, parameters, budget), fine = residuals(dataset, parameters, budget, 1e-8);
        const discrepancy = Math.max(...coarse.map((value, index) => Math.abs(value - fine[index])));
        if (!converged) reason = `Nuisance fit did not converge: ${fitted.termination}`;
        else if (nuisance.some(key => Math.log(parameters[key] / GROWTH_BOUNDS[key][0]) < 1e-6 || Math.log(GROWTH_BOUNDS[key][1] / parameters[key]) < 1e-6)) {
          converged = false; reason = 'Nuisance estimate reaches a supported parameter bound; the profile limit is unresolved.';
        }
        else if (fitted.solverDiscrepancySigma > .02 || discrepancy > .02) { converged = false; reason = 'Nuisance solver error is material relative to the declared noise.'; }
        else if (cost > conditionalObjective + Math.max(1e-3, conditionalObjective * 1e-6)) {
          converged = false; reason = 'Nuisance fit is worse than the fixed baseline candidate.';
        }
      }
      point = { value, objective: cost, delta: cost - baseline, conditionalObjective, parameters, converged, reason };
    } catch (cause) {
      point = { value, objective: null, delta: null, conditionalObjective: null, parameters: null, converged: false,
        reason: cause instanceof Error ? cause.message : String(cause) };
    }
    points.push(point);
    return point;
  };
  const endpoint = (status: GrowthProfileEndpoint['status'], point: GrowthProfilePoint | null, reason: string): GrowthProfileEndpoint =>
    ({ status, value: point?.value ?? null, delta: point?.delta ?? null, reason });
  const invalid = (point: GrowthProfilePoint): GrowthProfileEndpoint | null => {
    if (!point.converged || point.delta === null) return endpoint('failed', point, point.reason ?? 'Profile optimization failed.');
    if (point.delta < -betterTolerance) return endpoint('better-fit', point, 'Profile found a better fit than the baseline. Refit before interpreting likelihood limits.');
    return null;
  };
  const trace = (direction: -1 | 1): GrowthProfileEndpoint => {
    let inside = points[0], warm = { ...result.parameters };
    const bound = direction === -1 ? minimum : maximum;
    const local = result.estimates[parameter].interval95;
    let step = local ? Math.max(1e-5, Math.min(.5, Math.log(local[1] / local[0]) / 4)) : .15;
    for (let i = 0; i < GROWTH_PROFILE_LIMITS.expansionSteps; i++) {
      if (inside.value === bound) return endpoint('range-limit', inside, 'Likelihood threshold was not crossed before the supported parameter bound; that bound is not a confidence limit.');
      const value = direction === -1 ? Math.max(bound, inside.value * Math.exp(-step)) : Math.min(bound, inside.value * Math.exp(step));
      let outside = at(value, warm);
      const failure = invalid(outside); if (failure) return failure;
      if (outside.delta! >= GROWTH_PROFILE_CUTOFF) {
        let closest = outside;
        for (let j = 0; j < GROWTH_PROFILE_LIMITS.rootSteps; j++) {
          const middle = at(Math.sqrt(inside.value * outside.value), inside.parameters ?? result.parameters);
          const failure = invalid(middle); if (failure) return failure;
          if (Math.abs(middle.delta! - GROWTH_PROFILE_CUTOFF) < Math.abs(closest.delta! - GROWTH_PROFILE_CUTOFF)) closest = middle;
          if (Math.abs(middle.delta! - GROWTH_PROFILE_CUTOFF) <= .002) return endpoint('crossed', middle, 'Converged nuisance refits bracket an individual asymptotic likelihood-ratio crossing.');
          if (middle.delta! < GROWTH_PROFILE_CUTOFF) inside = middle; else outside = middle;
        }
        return Math.abs(closest.delta! - GROWTH_PROFILE_CUTOFF) <= .01
          ? endpoint('crossed', closest, 'Likelihood-ratio crossing resolved to delta-SSE tolerance 0.01.')
          : endpoint('failed', closest, 'Profile crossing did not resolve to the required objective tolerance.');
      }
      inside = outside; warm = outside.parameters!; step = Math.min(2, step * 1.8);
    }
    return endpoint('failed', inside, 'Profile exhausted its expansion budget before a likelihood crossing or parameter bound.');
  };
  const safeTrace = (direction: -1 | 1) => {
    try { return trace(direction); }
    catch (cause) { return endpoint('failed', null, cause instanceof Error ? cause.message : String(cause)); }
  };
  const lower = safeTrace(-1), upper = safeTrace(1);
  const warnings = [
    'Individual 95% asymptotic likelihood-ratio diagnostic under the supplied known independent Gaussian SDs; not simultaneous coverage, a Bayesian interval or experimental validation.',
    'The remaining estimated parameters are reoptimized; user-fixed parameters and conditions remain fixed. This is not a fixed-nuisance likelihood slice.',
    'Only the connected component around the numerical optimum is traced. Other disconnected optima and structural identifiability are not ruled out.',
    'All refits share the core integration-work budget. Optimization failures and computation limits are reported as unresolved, never converted to likelihood evidence against a candidate.',
  ];
  const competing = result.starts.some(start => start.objective !== null && start.objective - baseline < GROWTH_PROFILE_CUTOFF &&
    options.freeParameters.some(key => Math.abs(Math.log(start.parameters[key] / result.parameters[key])) > Math.log(2)));
  const regular = !competing && result.converged && result.sensitivityRank === options.freeParameters.length &&
    result.sensitivityCondition !== null && result.sensitivityCondition <= 1e5 && result.solverDiscrepancySigma <= .02 &&
    baseline / result.degreesOfFreedom <= 4 && options.freeParameters.every(key => {
      const value = result.parameters[key], bounds = GROWTH_BOUNDS[key];
      return Math.log(value / bounds[0]) > 1e-6 && Math.log(bounds[1] / value) > 1e-6;
    });
  if (!regular) warnings.push('Baseline convergence, competing solutions, rank, conditioning, boundary or noise/model checks do not support regular likelihood-ratio intervals. The profile remains descriptive.');
  const better = points.some(point => point.delta !== null && point.delta < -betterTolerance);
  const interval95: [number, number] | null = regular && !better && lower.status === 'crossed' && upper.status === 'crossed'
    ? [lower.value!, upper.value!] : null;
  const profile: GrowthProfileResult = { parameter, baselineResultId: record.resultId, baselineObjective: baseline,
    cutoff: GROWTH_PROFILE_CUTOFF, lower, upper, interval95, points: points.sort((a, b) => a.value - b.value), warnings };
  const coverage = { available: points.filter(point => point.converged).length, total: points.length, unit: 'records' as const };
  const evidence = dataset.source.kind === 'demo'
    ? { kind: 'demo' as const, assumptions: ['Explicit synthetic observations; this is a numerical uncertainty diagnostic, not biological calibration.'] }
    : { kind: 'fitted-estimate' as const, fit: { dataInput: 'growthData', objective: 'Profile the known-SD Gaussian likelihood over the remaining free parameters.', uncertainty: { kind: 'not-estimated' as const } } };
  const profileRecord = await createAnalysisRecord({ method: METHOD, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input),
    parameters: { fitOptions: analysisJson(options), parameter, baselineResultId: record.resultId }, seed: options.seed,
    references: [...record.references, REFERENCE], fields: { profile: { ...evidence, label: 'Nuisance-refitted profile likelihood and individual interval availability',
      units: 'records', coverage, limitations: [...result.warnings, ...warnings], value: analysisJson(profile) } } });
  return { dataset, options, result, record, profile, profileRecord };
}

export async function replayGrowthProfile(content: string, report?: (message: string) => void): Promise<ProfiledGrowthFit> {
  const saved = await parseAnalysisRecord(content, { methodId: METHOD.id, methodVersion: METHOD.version });
  if (saved.method.implementation !== METHOD.implementation || saved.inputs.length !== 1 || saved.inputs[0].id !== 'growthData' ||
    Object.keys(saved.parameters).sort().join(',') !== 'baselineResultId,fitOptions,parameter' ||
    typeof saved.parameters.baselineResultId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.parameters.baselineResultId) ||
    !GROWTH_PARAMETERS.includes(saved.parameters.parameter as GrowthParameter)) throw new Error('Unsupported growth-profile contract.');
  const options = resolveGrowthOptions(saved.parameters.fitOptions);
  if (saved.seed !== options.seed) throw new Error('Growth-profile seed differs from its fitting options.');
  const expectedReferences = [
    { id: 'infection-stage-model', version: '1', description: 'dB=mu B-k BP; dI1=k BP-m I1/L; dIj=m(Ij-1-Ij)/L; dP=b m Im/L-k BP-delta P. Initially all infected compartments are zero.' },
    { id: 'observation-likelihood', version: '1', description: 'Independent normal errors with supplied known SDs in linear OD/log10 counts; local information J^T J, interval multiplier 1.959963984540054.' }, REFERENCE,
  ];
  if (JSON.stringify(analysisJson(saved.references)) !== JSON.stringify(analysisJson(expectedReferences))) throw new Error('Growth-profile reference contract differs.');
  const fresh = await profileGrowthDataset(validateGrowthDataset(saved.inputs[0].data), options,
    saved.parameters.parameter as GrowthParameter, report, saved.parameters.baselineResultId);
  if (saved.resultId !== fresh.profileRecord.resultId) throw new Error('Fresh growth profile differs from the saved result; no saved profile was installed.');
  return fresh;
}
