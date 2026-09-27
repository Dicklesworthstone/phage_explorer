/** Fixed-topology strict-clock least-squares dating, not root-to-tip regression.
 * For reference date T and scale s, h_i = r(T - t_i)/s. Branch expectations
 * h_parent - h_child and date/rate bounds are linear in h and r. The resulting
 * convex quadratic is solved in the nonnegative dual; a KKT certificate is
 * required before reporting dates. This is an unweighted, fixed-root criterion,
 * not a port of LSD2, a relaxed clock, or an uncertainty/clock-adequacy test.
 * Method family: To et al. (2016), doi:10.1093/sysbio/syv068.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { collectionDateRange, parseTemporalNewick, validateTemporalDataset,
  type TemporalDataset, type TemporalNode } from './temporal-signal';

export const DATING_LIMITS = { tips: 128, nodes: 255, iterations: 20000 } as const;
export interface DatingOptions {
  rateMode: 'estimate' | 'fixed';
  fixedRate: number | null;
  rateSource: string | null;
  minimumRate: number;
  maximumRate: number;
  maxIterations: number;
}
export interface DatedNode {
  id: string;
  parentId: string | null;
  label: string | null;
  isTip: boolean;
  date: number;
  dateRange: { lower: number; upper: number } | null;
  dateSource: string | null;
  sourceLength: number;
  fittedLength: number;
  residual: number;
  duration: number;
  atDateBound: boolean;
}
export interface DatingCertificate {
  converged: boolean;
  iterations: number;
  conditionNumber: number;
  primalViolation: number;
  stationarity: number;
  complementarity: number;
  roundoffAdjustment: number;
}
export interface DatedTreeResult {
  options: DatingOptions;
  status: 'fitted' | 'rate-boundary' | 'unresolved';
  reason: string | null;
  /** Candidate minimizer, not a claimed dated rate when status is not fitted. */
  rate: number;
  rootDate: number | null;
  nodes: DatedNode[];
  sumSquaredResiduals: number;
  rootMeanSquaredResidual: number;
  normalizedResidual: number;
  exactTips: number;
  intervalTips: number;
  zeroDurationBranches: number;
  certificate: DatingCertificate;
  clockValidated: false;
  uncertainty: 'not-estimated';
  warnings: string[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function resolveDatingOptions(value: Partial<DatingOptions> = {}): DatingOptions {
  if (!object(value) || Object.keys(value).some(key => !['rateMode','fixedRate','rateSource','minimumRate','maximumRate','maxIterations'].includes(key))) throw new Error('Unsupported strict-clock options.');
  const result: DatingOptions = { rateMode: 'estimate', fixedRate: null, rateSource: null,
    minimumRate: 1e-10, maximumRate: 1, maxIterations: 10000, ...value };
  if (!['estimate','fixed'].includes(result.rateMode) || !Number.isFinite(result.minimumRate) || !Number.isFinite(result.maximumRate) ||
    result.minimumRate < 1e-12 || result.maximumRate > 10 || result.minimumRate >= result.maximumRate ||
    !Number.isInteger(result.maxIterations) || result.maxIterations < 1 || result.maxIterations > DATING_LIMITS.iterations) throw new Error('Use positive ordered rate bounds within 1e-12–10 substitutions/site/year and 1–20000 iterations.');
  if (result.rateMode === 'fixed') {
    if (typeof result.fixedRate !== 'number' || !Number.isFinite(result.fixedRate) || result.fixedRate < result.minimumRate || result.fixedRate > result.maximumRate ||
      typeof result.rateSource !== 'string' || !result.rateSource.trim() || result.rateSource.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(result.rateSource)) throw new Error('A fixed rate must be within the bounds and have an explicit source/assumption.');
    result.rateSource = result.rateSource.trim();
  } else if (result.fixedRate !== null || result.rateSource !== null) throw new Error('Estimated-rate mode cannot also supply a fixed rate or its source.');
  return result;
}
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const maxAbs = (x: number[]) => x.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const matrixNorm = (a: number[][]) => Math.max(...a.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));

/** Positive definite normal matrix, factored once. No ridge that invents identification. */
function factor(matrix: number[][]): (rhs: number[]) => number[] {
  const n = matrix.length, lower = Array.from({length:n}, () => Array<number>(n).fill(0));
  const scale = Math.max(...matrix.map((row, i) => row[i]));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i][j];
    for (let k = 0; k < j; k++) value -= lower[i][k] * lower[j][k];
    if (i === j) {
      if (!(value > 1e-13 * scale)) throw new Error('Dating is numerically unidentifiable from these exact dates and this topology. No dates were estimated.');
      lower[i][j] = Math.sqrt(value);
    } else lower[i][j] = value / lower[j][j];
  }
  return rhs => {
    const x = [...rhs];
    for (let i = 0; i < n; i++) { for (let j = 0; j < i; j++) x[i] -= lower[i][j] * x[j]; x[i] /= lower[i][i]; }
    for (let i = n - 1; i >= 0; i--) { for (let j = i + 1; j < n; j++) x[i] -= lower[j][i] * x[j]; x[i] /= lower[i][i]; }
    return x;
  };
}
interface Constraint { row: number[]; bound: number }
interface FlatNode { node: TemporalNode; parent: number | null; variable: number | null;
  range: { lower: number; upper: number } | null; dateSource: string | null }

export function fitDatedTree(input: TemporalDataset, settings: Partial<DatingOptions> = {},
  progress: (phase: string) => void = () => {}): DatedTreeResult {
  const dataset = validateTemporalDataset(input), options = resolveDatingOptions(settings);
  const tree = parseTemporalNewick(dataset.tree.newick), samples = new Map(dataset.samples.map(s => [s.id, s]));
  const flat: FlatNode[] = []; let variables = 0;
  const visit = (node: TemporalNode, parent: number | null) => {
    const tip = node.children.length === 0, sample = tip ? samples.get(node.label!) : null;
    const range = sample ? collectionDateRange(sample.collectionDate) : null;
    if (tip && !range) throw new Error('Every dated-tree tip needs a sourced collection date or interval. Missing dates are not silently inferred or pruned.');
    const index = flat.length;
    flat.push({node, parent, range, dateSource: sample?.dateSource ?? null,
      variable: !tip || range!.lower !== range!.upper ? variables++ : null});
    node.children.forEach(child => visit(child, index));
  };
  visit(tree, null);
  const tips = flat.filter(n => n.node.children.length === 0), exact = tips.filter(n => n.range!.lower === n.range!.upper);
  if (tips.length > DATING_LIMITS.tips || flat.length > DATING_LIMITS.nodes) throw new Error('Strict-clock dating supports at most 128 tips and 255 nodes; diagnostic-only trees can be larger.');
  if (!exact.length || options.rateMode === 'estimate' && new Set(exact.map(n => n.range!.lower)).size < 2) throw new Error('Estimating a rate requires at least two different exact tip dates; a supplied fixed rate requires at least one exact tip date. Interval-only trees are not identified here.');
  const referenceDate = Math.max(...tips.map(n => n.range!.upper));
  const timeScale = Math.max(1, referenceDate - Math.min(...tips.map(n => n.range!.lower)));
  const lengthScale = Math.max(...flat.map(n => n.node.length));
  if (!(lengthScale > 0)) throw new Error('An all-zero phylogram cannot identify a positive clock rate or ancestral dates.');
  const rateVariable = options.rateMode === 'estimate' ? variables++ : null;
  const fixedRho = (options.fixedRate ?? 0) * timeScale / lengthScale;
  const age = (date: number) => (referenceDate - date) / timeScale;
  const zero = () => Array<number>(variables).fill(0);
  const design: number[][] = [], observed: number[] = [], offsets: number[] = [], constraints: Constraint[] = [];
  for (const n of flat.slice(1)) {
    const row = zero(); row[flat[n.parent!].variable!] = 1; let offset = 0;
    if (n.variable !== null) row[n.variable] = -1;
    else if (rateVariable !== null) row[rateVariable] = -age(n.range!.lower);
    else offset = -fixedRho * age(n.range!.lower);
    design.push(row); observed.push(n.node.length / lengthScale - offset); offsets.push(offset);
    constraints.push({row, bound: -offset}); // Every parent must precede its child.
  }
  if (rateVariable !== null) {
    const row = zero(); row[rateVariable] = 1;
    constraints.push({row, bound:options.minimumRate * timeScale / lengthScale},
      {row:row.map(v => -v), bound:-options.maximumRate * timeScale / lengthScale});
  }
  for (const tip of tips) if (tip.variable !== null) {
    const lower = zero(), upper = zero(); lower[tip.variable] = 1; upper[tip.variable] = -1;
    if (rateVariable !== null) { lower[rateVariable] = -age(tip.range!.upper); upper[rateVariable] = age(tip.range!.lower); }
    constraints.push({row:lower, bound:rateVariable === null ? fixedRho * age(tip.range!.upper) : 0},
      {row:upper, bound:rateVariable === null ? -fixedRho * age(tip.range!.lower) : 0});
  }
  const hessian = Array.from({length:variables}, zero), rhs = zero();
  for (let k = 0; k < design.length; k++) {
    const row = design[k], indices = row.map((v,i) => v ? i : -1).filter(i => i >= 0);
    for (const i of indices) { rhs[i] += row[i] * observed[k]; for (const j of indices) hessian[i][j] += row[i] * row[j]; }
  }
  const solve = factor(hessian), unconstrained = solve(rhs);
  const inverse = Array.from({length:variables}, (_,i) => { const row = zero(); row[i] = 1; return solve(row); });
  const conditionNumber = matrixNorm(hessian) * matrixNorm(inverse);
  if (!Number.isFinite(conditionNumber) || conditionNumber > 1e12) throw new Error('Dating design is too ill-conditioned for supported numerical precision. Wider exact-date information or a sourced fixed rate is required.');
  const directions = constraints.map(c => solve(c.row)), diagonals = directions.map((d,i) => dot(constraints[i].row,d));
  if (diagonals.some(d => !(d > 0) || !Number.isFinite(d))) throw new Error('Dating constraint system is numerically degenerate.');
  const multipliers = constraints.map(() => 0); let x = [...unconstrained], iterations = 0;
  const objective = () => design.reduce((sum,row,i) => sum + (dot(row,x)-observed[i]) ** 2, 0);
  const certificate = (): DatingCertificate => {
    let primalViolation = 0, complementarity = 0; const dual = zero();
    for (let i = 0; i < constraints.length; i++) {
      const {row,bound} = constraints[i], slack = dot(row,x)-bound;
      primalViolation = Math.max(primalViolation, Math.max(0,-slack));
      complementarity = Math.max(complementarity, Math.abs(multipliers[i] * slack));
      for (let j = 0; j < variables; j++) dual[j] += multipliers[i] * row[j];
    }
    const gradient = hessian.map((row,i) => dot(row,x)-rhs[i]-dual[i]);
    const stationarity = maxAbs(gradient)/(1+maxAbs(rhs)+maxAbs(dual));
    return {converged:primalViolation <= 1e-12 && stationarity <= 1e-12 && complementarity <= 1e-12 * (1+objective()),
      iterations, conditionNumber, primalViolation, stationarity, complementarity, roundoffAdjustment:0};
  };
  let cert = certificate();
  // Exact cyclic dual coordinate minimization. Feasibility/optimality, not a
  // small iterate change, decides completion. No date/branch clipping as a solver.
  while (!cert.converged && iterations < options.maxIterations) {
    for (let i = 0; i < constraints.length; i++) {
      const slack = dot(constraints[i].row,x)-constraints[i].bound;
      const next = Math.max(0,multipliers[i]-slack/diagonals[i]), change = next-multipliers[i];
      if (change !== 0) { for (let j = 0; j < variables; j++) x[j] += change*directions[i][j]; multipliers[i] = next; }
    }
    iterations++;
    if (iterations % 100 === 0) {
      x = unconstrained.map((v,j) => v+directions.reduce((sum,d,i) => sum+d[j]*multipliers[i],0));
      progress(`Solving chronological branch constraints (${iterations} iterations)`);
    }
    cert = certificate();
    if (!x.every(Number.isFinite)) throw new Error('Nonfinite strict-clock iterate; no dates were produced.');
  }
  const rho = rateVariable === null ? fixedRho : x[rateVariable], rate = rho*lengthScale/timeScale;
  const warnings = [
    'Dates and rate are conditional on the supplied fixed topology/root and a single strict molecular clock. A small residual does not validate the clock, root, homology, substitution model, or sampling design.',
    'Unweighted least squares gives every supplied branch equal weight; no branch-length variance or covariance model is inferred.',
    'No confidence intervals, tree/root uncertainty, skyline or effective population sizes are estimated. Interval-dated tips are fitted inside supplied bounds, not converted to exact midpoints.',
    'All tree tips are retained. Diagnostic exclusions and date-randomization settings are not pruning instructions for this separate full-tree fit.',
  ];
  if (dataset.source.kind === 'demo') warnings.unshift('Synthetic teaching phylogram and dates; not empirical evolutionary calibration.');
  if (options.rateMode === 'fixed') warnings.push('The rate is supplied, not inferred from this cohort. Calendar dates remain conditional on its source and applicability.');
  const atRateBound = options.rateMode === 'estimate' && (rate <= options.minimumRate*(1+1e-6) || rate >= options.maximumRate*(1-1e-6));
  let status: DatedTreeResult['status'] = !cert.converged ? 'unresolved' : atRateBound ? 'rate-boundary' : 'fitted';
  let reason = !cert.converged ? 'The solver did not certify primal feasibility and optimality within the iteration limit. No node dates are published.'
    : atRateBound ? 'The inferred rate reaches a user search bound. It is not an identified interior rate; no node dates are published.' : null;
  let nodes: DatedNode[] = [];
  if (status === 'fitted') {
    const before = [...x], heights = flat.map(n => n.variable === null ? rho*age(n.range!.lower) : x[n.variable]);
    // Repair floating-point-only (< certificate tolerance) chronology violations,
    // then recertify the adjusted solution. This is not clipping an unconstrained fit.
    for (let i = 0; i < flat.length; i++) if (flat[i].range && flat[i].variable !== null) {
      heights[i] = Math.max(rho*age(flat[i].range!.upper),Math.min(rho*age(flat[i].range!.lower),heights[i]));
    }
    for (let i = flat.length-1; i > 0; i--) heights[flat[i].parent!] = Math.max(heights[flat[i].parent!],heights[i]);
    flat.forEach((n,i) => {if(n.variable !== null)x[n.variable] = heights[i];});
    const adjustment = maxAbs(x.map((v,i) => v-before[i])); cert = {...certificate(),roundoffAdjustment:adjustment};
    if (!cert.converged || adjustment > 1e-8) {
      status = 'unresolved'; reason = 'Chronology could not be represented within the numerical optimality tolerance. No node dates are published.';
    } else {
      const dates = flat.map((n,i) => n.range && n.range.lower === n.range.upper ? n.range.lower : referenceDate-heights[i]*timeScale/rho);
      nodes = flat.map((n,i) => {
        const duration = n.parent === null ? 0 : dates[i]-dates[n.parent];
        return {id:`n${i}`,parentId:n.parent === null ? null : `n${n.parent}`,label:n.node.label,isTip:!n.node.children.length,
          date:dates[i],dateRange:n.range,dateSource:n.dateSource,sourceLength:n.node.length,
          fittedLength:rate*duration,residual:n.parent === null ? 0 : n.node.length-rate*duration,duration,
          atDateBound:!!n.range && n.range.lower !== n.range.upper && Math.min(Math.abs(dates[i]-n.range.lower),Math.abs(dates[i]-n.range.upper)) < 1e-7};
      });
      const representationError = Math.max(...nodes.slice(1).map((n,i) => Math.abs(n.fittedLength/lengthScale-dot(design[i],x)-offsets[i])));
      if (nodes.some(n => !Number.isFinite(n.date) || n.duration < 0) || representationError > 1e-8) {
        status = 'unresolved'; reason = 'Calendar-date conversion loses supported numerical precision. No node dates are published.'; nodes = [];
      }
    }
  }
  const sumSquaredResiduals = nodes.length ? nodes.reduce((sum,n) => sum+n.residual**2,0) : objective()*lengthScale**2;
  const rootMeanSquaredResidual = Math.sqrt(sumSquaredResiduals/(flat.length-1));
  const normalizedResidual = rootMeanSquaredResidual/lengthScale;
  if (normalizedResidual > .1) warnings.push('The root-mean-square branch residual exceeds 10% of the longest input branch. This descriptive warning is not a calibrated goodness-of-fit test.');
  const zeroDurationBranches = nodes.filter(n => n.parentId !== null && n.duration === 0).length;
  if (zeroDurationBranches) warnings.push('Some chronological constraints are active: fitted branches have zero duration. Nodes/topology are retained, not silently collapsed.');
  return {options,status,reason,rate,rootDate:nodes[0]?.date??null,nodes,sumSquaredResiduals,rootMeanSquaredResidual,normalizedResidual,
    exactTips:exact.length,intervalTips:tips.length-exact.length,zeroDurationBranches,certificate:cert,clockValidated:false,uncertainty:'not-estimated',warnings};
}

const METHOD = {id:'fixed-root-strict-clock-dating',version:'1',implementation:'Scaled-age convex unweighted branch least squares; nonnegative dual coordinate solver with KKT certificate; date intervals and chronological constraints'};
const REFERENCES = [{id:'least-squares-dating',version:'To-et-al-2016-syv068',description:'Least-squares dating method family; this is a fixed-root unweighted implementation, not LSD2 or its variance/outlier/root-search procedures.'}];
export async function createDatedTreeRecord(input: TemporalDataset, result: DatedTreeResult): Promise<AnalysisRecord> {
  const dataset = validateTemporalDataset(input), coverage = {available:result.exactTips+result.intervalTips,total:result.exactTips+result.intervalTips,unit:'records' as const};
  const context = {label:'Full conditional strict-clock fit, branch residuals and numerical certificate',units:'records' as const,value:analysisJson(result),coverage,
    limitations:result.warnings,assumptions:['Fixed supplied root/topology; branch units substitutions/site; time unit calendar years; explicit exact/interval tip dates.']};
  return createAnalysisRecord({method:METHOD,inputs:[{id:'datedTree',accession:null,source:dataset.source.kind,description:dataset.source.description,data:analysisJson(dataset)}],
    parameters:analysisJson(result.options) as AnalysisRecord['parameters'],seed:null,references:REFERENCES,
    fields:{dating:dataset.source.kind === 'demo'?{...context,kind:'demo'}:{...context,kind:'fitted-estimate',
      fit:{dataInput:'datedTree',objective:'Minimize the unweighted sum of squared branch-length residuals subject to chronological order and supplied date/rate bounds.',uncertainty:{kind:'not-estimated'}}}}});
}
export async function replayDatedTreeRecord(content: string): Promise<{dataset:TemporalDataset;dating:DatedTreeResult;datingRecord:AnalysisRecord}> {
  const saved = await parseAnalysisRecord(content,{methodId:METHOD.id,methodVersion:METHOD.version});
  if(saved.inputs.length !== 1 || saved.inputs[0].id !== 'datedTree')throw new Error('Unsupported strict-clock input contract.');
  const dataset = validateTemporalDataset(saved.inputs[0].data), dating = fitDatedTree(dataset,saved.parameters as Partial<DatingOptions>);
  const datingRecord = await createDatedTreeRecord(dataset,dating);
  if(datingRecord.resultId !== saved.resultId || datingRecord.cacheKey !== saved.cacheKey)throw new Error('Fresh strict-clock dating differs from the saved result or method contract.');
  return {dataset,dating,datingRecord};
}
export function exportDatedNewick(result: DatedTreeResult): string {
  if(result.status !== 'fitted' || !result.nodes.length)throw new Error('Only a certified, interior or supplied-rate fit has a dated tree to export.');
  const children = new Map<string,DatedNode[]>();
  for(const node of result.nodes)if(node.parentId)children.set(node.parentId,[...children.get(node.parentId)??[],node]);
  const visit = (node:DatedNode):string => {
    const descendants=children.get(node.id),label=node.label?`'${node.label.replaceAll("'","''")}'`:'';
    return `${descendants?`(${descendants.map(visit).join(',')})`:''}${label}[&date=${node.date},source_node=${node.id}]${node.parentId?`:${node.duration}`:''}`;
  };
  return `[&R][&branch_units=years,rate=${result.rate},clock_validated=false]\n${visit(result.nodes[0])};\n`;
}
