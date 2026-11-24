/**
 * Lysogeny/Lysis Decision Circuit Reconstructor
 *
 * Implements the molecular biophysics and systems biology of the bacteriophage
 * lysis-lysogeny genetic switch (such as the classic Lambda CI/Cro bistable toggle):
 *
 * 1. Explicit CDS annotation hypotheses and conservative sequence motif candidates.
 *    Generic model sites OR1/OR2/OR3 and PR/PRM are not genomic annotations.
 * 2. Shea-Ackers three-site operator occupancy partition function Z with cooperative binding
 * 3. Mutual repression ODE system with Hill kinetics, RecA* SOS-cleavage, and CII feedback
 * 4. Quasi-steady 2D vector fields, sampled nullcline zeros, and residual-checked equilibria
 * 5. An uncalibrated teaching score under environmental perturbations (MOI, UV damage, nutrients)
 */

import type { GeneInfo, PhageFull } from '../types';
import { reverseComplement } from '../codons';

export interface Promoter {
  name: string;
  position: number;
  strength: number | null; // No calibrated promoter activity is inferred from a motif
  direction: '+' | '-';
  sigmaFactor?: string;
  sequence?: string;
}

export interface Operator {
  name: string;
  position: number;
  sequence: string;
  /** Strand of the observed sequence match; position is its lower genomic bound. */
  direction?: '+' | '-';
  bindingAffinityCi: number | null; // Unknown without a binding measurement/model
  bindingAffinityCro: number | null; // Unknown without a binding measurement/model
  /** Sequence identity alone does not establish binding in the selected genome. */
  boundBy: 'CI' | 'Cro' | 'both' | 'unknown';
}

export interface Terminator {
  name: string;
  position: number;
  /** Oriented observed hairpin-and-tail sequence, in genomic coordinates. */
  sequence?: string;
  direction?: '+' | '-';
  efficiency: number | null; // Unknown without a termination measurement/model
}

export interface CircuitKeyGenes {
  ci?: GeneInfo;
  cro?: GeneInfo;
  cII?: GeneInfo;
  cIII?: GeneInfo;
  n?: GeneInfo;
  q?: GeneInfo;
  integrase?: GeneInfo;
  excisionase?: GeneInfo;
}

export type CircuitArchitecture =
  | 'lambda-like'
  | 'p22-like'
  | 'temperate'
  | 'obligately-lytic'
  | 'unknown';

export interface LysogenyCircuitReconstruction {
  architecture: CircuitArchitecture;
  isTemperate: boolean;
  confidence: number | null; // No calibrated confidence is available for annotation hypotheses
  promoters: Promoter[];
  operators: Operator[];
  terminators: Terminator[];
  genes: CircuitKeyGenes;
  summary: string;
  /** Distinguishes unsearched input from no candidates under the declared rules. */
  sequenceStatus: 'not-supplied' | 'scanned';
  sequenceLength: number | null;
  limitations: string[];
  inferredParams: {
    ciProd: number;
    croProd: number;
    hill: number;
    decay: number;
    omega: number;
  };
}

export interface OperatorOccupancy {
  or1Ci: number;
  or2Ci: number;
  or3Ci: number;
  orCro: number;
  prmActivity: number;
  prActivity: number;
  partitionZ: number;
}

export interface PhasePortraitPoint {
  ci: number;
  cro: number;
  dCi: number;
  dCro: number;
  magnitude: number;
  fate: 'lysogenic' | 'lytic' | 'undecided';
}

export interface NullclinePoint {
  ci: number;
  cro: number;
}

export interface AttractorPoint {
  type: 'lysogenic' | 'lytic' | 'undecided' | 'saddle' | 'unresolved';
  ci: number;
  cro: number;
  cII: number;
  recAStar: number;
  /** Classification of the full four-variable ODE, not a simulated endpoint. */
  stability: 'stable' | 'saddle' | 'unresolved';
  /** Maximum absolute residual across all four derivatives. */
  residual: number;
  eigenvalues: Array<{ real: number; imaginary: number }>;
  label: string;
}

export interface LysogenyPrediction {
  probability: number; // Uncalibrated logistic teaching score in [0,1], not measured probability
  fate: 'lysogenic' | 'lytic' | 'undecided';
  factors: string[];
}

export interface LysogenySwitchParameters {
  moi: number;
  uv: number;
  nutrients: number;
  ciProd: number;
  croProd: number;
  decay: number;
  hill: number;
  omega: number;
  kdCiOr1: number;
  kdCiOr2: number;
  kdCiOr3: number;
  kdCroOr: number;
  kCleavage: number;
}

export const DEFAULT_LYSOGENY_PARAMS: LysogenySwitchParameters = {
  moi: 1.0,
  uv: 0.0,
  nutrients: 1.0,
  ciProd: 0.8,
  croProd: 0.6,
  decay: 0.05,
  hill: 2.0,
  omega: 10.0,
  kdCiOr1: 0.25,
  kdCiOr2: 0.5,
  kdCiOr3: 3.2,
  kdCroOr: 0.4,
  kCleavage: 0.25,
};

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Bounds on computation, not caps on the simulated concentrations. */
export const LYSOGENY_INTEGRATION_LIMITS = {
  elapsedTime: 10000,
  attempts: 50000,
  relativeTolerance: 1e-7,
  absoluteTolerance: 1e-10,
} as const;

/** Numerical budgets; a finite search does not prove every equilibrium was found. */
export const LYSOGENY_PHASE_LIMITS = {
  residualTolerance: 1e-8,
  stabilityTolerance: 1e-6,
  rootIterations: 64,
  nullclineSamples: 128,
  maximumGridSize: 128,
} as const;

function resolveSwitchParameters(params: Partial<LysogenySwitchParameters>): LysogenySwitchParameters {
  const resolved = { ...DEFAULT_LYSOGENY_PARAMS, ...params };
  for (const name of Object.keys(DEFAULT_LYSOGENY_PARAMS) as Array<keyof LysogenySwitchParameters>) {
    const value = resolved[name];
    const strictlyPositive = name === 'hill' || name === 'omega' || name.startsWith('kd');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || strictlyPositive && value === 0) {
      throw new Error(`${name} must be finite and ${strictlyPositive ? 'positive' : 'nonnegative'}.`);
    }
  }
  return resolved;
}

function concentration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative concentration.`);
  return value;
}

/**
 * Calculate Shea-Ackers three-site operator occupancy partition function Z
 * and resulting promoter transcription activities for PRM and PR.
 *
 * OR1: highest affinity for CI (maintains repression of PR)
 * OR2: intermediate affinity for CI (activates PRM via cooperative interaction with RNAP)
 * OR3: lowest affinity for CI, but highest affinity for Cro (represses PRM)
 * omega: cooperativity factor when CI dimers occupy adjacent OR1 and OR2 sites
 */
export function calculateOperatorOccupancy(
  ci: number,
  cro: number,
  params: Partial<LysogenySwitchParameters> = {}
): OperatorOccupancy {
  const p = resolveSwitchParameters(params);
  const hill = p.hill;
  const omega = p.omega;

  const safeCi = concentration(ci, 'CI');
  const safeCro = concentration(cro, 'Cro');

  // Dimensionless affinities with cooperativity exponent
  const u = Math.pow(safeCi / p.kdCiOr1, hill); // OR1 binding weight
  const v = Math.pow(safeCi / p.kdCiOr2, hill); // OR2 binding weight
  const w = Math.pow(safeCi / p.kdCiOr3, hill); // OR3 binding weight

  // Cooperativity: CI forms cooperative tetramer specifically between OR1 and OR2 (omega)
  const k12 = omega * u * v;
  const k23 = v * w;
  const k13 = u * w;
  const k123 = omega * u * v * w;

  // Cro competitive binding at OR region (Cro dimer binds preferentially at OR3, then OR2/OR1)
  const croWeight = Math.pow(safeCro / p.kdCroOr, hill);

  // Partition function Z (sum of Boltzmann weights of all microstates)
  const partitionZ = 1 + u + v + w + k12 + k23 + k13 + k123 + croWeight * 2.5;

  // Fractional site occupancies
  const or1Ci = clamp((u + k12 + k13 + k123) / partitionZ, 0, 1);
  const or2Ci = clamp((v + k12 + k23 + k123) / partitionZ, 0, 1);
  const or3Ci = clamp((w + k23 + k13 + k123) / partitionZ, 0, 1);
  const orCro = clamp((croWeight * 2.5) / partitionZ, 0, 1);

  // PRM activity (CI synthesis):
  // Activated by CI bound at OR2 while OR3 is vacant and Cro is not repressing
  // Plus basal low transcription when OR3 is free
  const prmActivated = or2Ci * (1 - or3Ci) * (1 - orCro);
  const prmBasal = 0.05 * (1 - or3Ci) * (1 - orCro);
  const prmActivity = clamp(prmActivated + prmBasal, 0, 1);

  // PR activity (Cro & lytic operon):
  // Active when OR1 and OR2 are free of CI
  const prActivity = clamp((1 - or1Ci) * (1 - or2Ci), 0, 1);

  return {
    or1Ci,
    or2Ci,
    or3Ci,
    orCro,
    prmActivity,
    prActivity,
    partitionZ,
  };
}

/**
 * Calculate time derivatives (dCI/dt, dCro/dt, dCII/dt, dRecA/dt)
 */
export function calculateDerivatives(
  state: { ci: number; cro: number; cII?: number; recAStar?: number },
  params: Partial<LysogenySwitchParameters> = {}
): { dCi: number; dCro: number; dCII: number; dRecAStar: number; occupancy: OperatorOccupancy } {
  const p = resolveSwitchParameters(params);
  const ci = concentration(state.ci, 'CI');
  const cro = concentration(state.cro, 'Cro');
  const cII = concentration(state.cII ?? 0.1, 'CII');
  const recAStar = concentration(state.recAStar ?? 0, 'RecA*');

  const occupancy = calculateOperatorOccupancy(ci, cro, p);

  // Host SOS RecA* response: UV induces RecA activation, auto-deactivates at rate 0.2
  const dRecAStar = p.uv * 10 - 0.2 * recAStar;

  // CI cleavage mediated by RecA*
  const cleavage = p.kCleavage * recAStar * ci + 0.2 * p.uv * ci;

  // Cro inhibition of CII and PRE:
  // When Cro is elevated, it represses PR and blocks CII accumulation and PRE establishment
  const croInhibition = clamp(1 - occupancy.orCro, 0, 1);

  // CII synthesis from PR, modulated by MOI and nutrient conditions, inhibited by high Cro
  const cIISynth = 0.5 * occupancy.prActivity * croInhibition * Math.sqrt(p.moi) * p.nutrients;
  const cIIDecay = 0.25 * cII;
  const dCII = cIISynth - cIIDecay;

  // CII activates PRE (Repressor Establishment promoter), boosting CI during initial infection,
  // also blocked when Cro dominates
  const cIIHill = Math.pow(cII / 0.5, 2);
  const preBoost = 0.6 * (cIIHill / (1 + cIIHill)) * croInhibition;

  // CI synthesis = PRM transcription (scaled by MOI and CI synthesis parameter) + PRE boost
  const ciSynth = p.ciProd * occupancy.prmActivity * Math.sqrt(p.moi) + preBoost;
  const ciDecay = p.decay * ci;
  const dCi = ciSynth - ciDecay - cleavage;

  // Cro synthesis = PR transcription (scaled by Cro synthesis parameter) + basal leak
  const croSynth = p.croProd * occupancy.prActivity + 0.05;
  const croDecay = p.decay * cro;
  const dCro = croSynth - croDecay;

  return {
    dCi,
    dCro,
    dCII,
    dRecAStar,
    occupancy,
  };
}

/**
 * Integrate the complete requested interval with adaptive RK4 step doubling.
 * Negative trial states are rejected and retried at a smaller step; concentrations
 * are never clipped to fabricate a trajectory. The independent RecA* equation
 * provides an analytic conformance check in the accompanying tests.
 */
export function simulateSwitchStep(
  state: { ci: number; cro: number; cII?: number; recAStar?: number; time?: number },
  dt: number,
  params: Partial<LysogenySwitchParameters> = {}
): {
  ci: number;
  cro: number;
  cII: number;
  recAStar: number;
  phase: 'lysogenic' | 'lytic' | 'undecided';
  occupancy: OperatorOccupancy;
} {
  if (!Number.isFinite(dt) || dt < 0 || dt > LYSOGENY_INTEGRATION_LIMITS.elapsedTime) {
    throw new Error('Lysogeny elapsed time must be finite and between 0 and 10,000 model time units.');
  }
  const p = resolveSwitchParameters(params);
  let y = [concentration(state.ci, 'CI'), concentration(state.cro, 'Cro'),
    concentration(state.cII ?? 0.1, 'CII'), concentration(state.recAStar ?? 0, 'RecA*')];
  const valid = (values: number[]) => values.every(value => Number.isFinite(value) && value >= 0);
  const rates = (values: number[]) => {
    const { dCi, dCro, dCII, dRecAStar } = calculateDerivatives({
      ci: values[0], cro: values[1], cII: values[2], recAStar: values[3],
    }, p);
    return [dCi, dCro, dCII, dRecAStar];
  };
  const rk4 = (values: number[], h: number): number[] | null => {
    const a = rates(values), va = values.map((value, i) => value + h * a[i] / 2);
    if (!valid(va)) return null;
    const b = rates(va), vb = values.map((value, i) => value + h * b[i] / 2);
    if (!valid(vb)) return null;
    const c = rates(vb), vc = values.map((value, i) => value + h * c[i]);
    if (!valid(vc)) return null;
    const d = rates(vc);
    const next = values.map((value, i) => value + h * (a[i] + 2 * b[i] + 2 * c[i] + d[i]) / 6);
    return valid(next) ? next : null;
  };

  let elapsed = 0, h = Math.min(0.25, dt), attempts = 0;
  while (elapsed < dt) {
    if (++attempts > LYSOGENY_INTEGRATION_LIMITS.attempts) {
      throw new Error('Lysogeny integration exceeded its step budget; reduce elapsed time or the kinetic rates.');
    }
    h = Math.min(h, dt - elapsed);
    if (elapsed + h === elapsed || h <= 0) throw new Error('Lysogeny integration cannot advance at the requested tolerance.');
    const coarse = rk4(y, h), half = rk4(y, h / 2), fine = half ? rk4(half, h / 2) : null;
    if (!coarse || !fine) { h /= 2; continue; }
    const error = Math.max(...fine.map((value, i) => Math.abs(value - coarse[i]) /
      (15 * (LYSOGENY_INTEGRATION_LIMITS.absoluteTolerance + LYSOGENY_INTEGRATION_LIMITS.relativeTolerance * Math.max(y[i], value)))));
    if (error <= 1) {
      const corrected = fine.map((value, i) => value + (value - coarse[i]) / 15);
      y = valid(corrected) ? corrected : fine;
      elapsed = h === dt - elapsed ? dt : elapsed + h;
    }
    h *= Math.min(2, Math.max(0.2, error === 0 ? 2 : 0.9 * error ** -0.2));
    h = Math.min(h, 0.5);
  }
  const [nextCi, nextCro, nextCII, nextRecA] = y;
  const occupancy = calculateOperatorOccupancy(nextCi, nextCro, p);

  const phase: 'lysogenic' | 'lytic' | 'undecided' =
    nextCi - nextCro > 0.25 ? 'lysogenic' : nextCro - nextCi > 0.25 ? 'lytic' : 'undecided';

  return {
    ci: nextCi,
    cro: nextCro,
    cII: nextCII,
    recAStar: nextRecA,
    phase,
    occupancy,
  };
}

/**
 * The portrait eliminates CII and RecA* at their instantaneous steady values:
 * CII = 2 PR (1 - Cro occupancy) sqrt(MOI) nutrients; RecA* = 50 UV.
 * This is a quasi-steady reduction, not a slice of the live four-variable
 * trajectory. Its zeros are equilibria of that full ODE; its arrows need not
 * describe transient trajectories while CII and RecA* are still relaxing.
 */
export function calculateQuasiSteadyState(
  ci: number,
  cro: number,
  params: Partial<LysogenySwitchParameters> = {}
): { ci: number; cro: number; cII: number; recAStar: number } {
  const p = resolveSwitchParameters(params);
  const occupancy = calculateOperatorOccupancy(ci, cro, p);
  return { ci, cro,
    cII: 2 * occupancy.prActivity * (1 - occupancy.orCro) * Math.sqrt(p.moi) * p.nutrients,
    recAStar: 50 * p.uv };
}

function reducedRates(ci: number, cro: number, p: LysogenySwitchParameters): [number, number] {
  const { dCi, dCro } = calculateDerivatives(calculateQuasiSteadyState(ci, cro, p), p);
  return [dCi, dCro];
}

function validatePortraitGrid(steps: number, maxCi: number, maxCro: number): void {
  if (!Number.isInteger(steps) || steps < 1 || steps > LYSOGENY_PHASE_LIMITS.maximumGridSize) {
    throw new Error(`Phase portrait resolution must be an integer from 1 to ${LYSOGENY_PHASE_LIMITS.maximumGridSize}.`);
  }
  if (![maxCi, maxCro].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Phase portrait concentration bounds must be positive and finite.');
  }
}

/** Compute the quasi-steady CI/Cro vector field, using the same reduction as the nullclines. */
export function computeCircuitPhasePortrait(
  params: Partial<LysogenySwitchParameters> = {},
  gridSize = 16,
  maxCi = 3.0,
  maxCro = 3.0
): PhasePortraitPoint[] {
  validatePortraitGrid(gridSize, maxCi, maxCro);
  const p = resolveSwitchParameters(params);
  const points: PhasePortraitPoint[] = [];

  for (let i = 0; i <= gridSize; i++) {
    const ci = (i / gridSize) * maxCi;
    for (let j = 0; j <= gridSize; j++) {
      const cro = (j / gridSize) * maxCro;
      const [dCi, dCro] = reducedRates(ci, cro, p);
      const mag = Math.hypot(dCi, dCro);
      if (!Number.isFinite(mag)) throw new Error('Phase portrait exceeds finite model arithmetic.');

      points.push({
        ci,
        cro,
        dCi,
        dCro,
        magnitude: mag,
        // An instantaneous arrow does not establish a basin of attraction.
        fate: 'undecided',
      });
    }
  }

  return points;
}

/** Bracket crossings, refine by bisection, and retain only residual-checked zeros. */
function sampledZeros(rate: (value: number) => number, maximum: number): number[] {
  const roots: number[] = [];
  const tolerance = LYSOGENY_PHASE_LIMITS.residualTolerance;
  const add = (value: number) => {
    if (Math.abs(rate(value)) <= tolerance && !roots.some(root => Math.abs(root - value) <= 1e-6 * Math.max(1, value))) {
      roots.push(value);
    }
  };
  let left = 0, leftRate = rate(left);
  if (leftRate === 0) add(left);
  for (let i = 1; i <= LYSOGENY_PHASE_LIMITS.nullclineSamples; i++) {
    // Denser near zero, where the low-CI branch can be much smaller than one grid cell.
    const right = maximum * (i / LYSOGENY_PHASE_LIMITS.nullclineSamples) ** 2;
    const rightRate = rate(right);
    if (rightRate === 0) add(right);
    if (Number.isFinite(leftRate) && Number.isFinite(rightRate) && Math.sign(leftRate) * Math.sign(rightRate) < 0) {
      let lo = left, hi = right, flo = leftRate;
      for (let iteration = 0; iteration < LYSOGENY_PHASE_LIMITS.rootIterations; iteration++) {
        const mid = (lo + hi) / 2, fm = rate(mid);
        if (!Number.isFinite(fm)) break;
        if (Math.abs(fm) <= tolerance) { add(mid); break; }
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; }
        else hi = mid;
      }
    }
    left = right; leftRate = rightRate;
  }
  return roots;
}

/**
 * Sample all bracketed nullcline zeros within the requested rectangle. Multiple
 * roots in one row are retained; rows with no zero contribute no point. These
 * unordered samples must not be joined into a single curve across branches.
 * Tangencies between samples can be missed; no closest-point substitute is used.
 */
export function computeNullclines(
  params: Partial<LysogenySwitchParameters> = {},
  steps = 30,
  maxCi = 3.0,
  maxCro = 3.0
): { ciNullcline: NullclinePoint[]; croNullcline: NullclinePoint[] } {
  validatePortraitGrid(steps, maxCi, maxCro);
  const p = resolveSwitchParameters(params);
  const ciNullcline: NullclinePoint[] = [];
  const croNullcline: NullclinePoint[] = [];

  for (let j = 0; j <= steps; j++) {
    const cro = (j / steps) * maxCro;
    for (const ci of sampledZeros(value => reducedRates(value, cro, p)[0], maxCi)) ciNullcline.push({ ci, cro });
  }

  for (let i = 0; i <= steps; i++) {
    const ci = (i / steps) * maxCi;
    for (const cro of sampledZeros(value => reducedRates(ci, value, p)[1], maxCro)) croNullcline.push({ ci, cro });
  }

  return { ciNullcline, croNullcline };
}

/** Finite differences with a one-sided stencil at a nonnegative concentration boundary. */
function jacobian(rates: (state: number[]) => number[], state: number[]): number[][] {
  const columns = state.map((value, column) => {
    const h = 1e-5 * Math.max(1, value);
    const lo = [...state], hi = [...state];
    lo[column] = Math.max(0, value - h); hi[column] = value + h;
    const a = rates(lo), b = rates(hi);
    return b.map((rate, row) => (rate - a[row]) / (hi[column] - lo[column]));
  });
  return state.map((_, row) => columns.map(column => column[row]));
}

/** Eigenvalues of a real 3x3 Jacobian, scaled before solving its characteristic cubic. */
function eigenvalues3(matrix: number[][]): Array<{ real: number; imaginary: number }> {
  const scale = Math.max(...matrix.flat().map(Math.abs));
  if (!Number.isFinite(scale)) return [];
  if (scale === 0) return Array.from({ length: 3 }, () => ({ real: 0, imaginary: 0 }));
  const m = matrix.map(row => row.map(value => value / scale));
  const a = -(m[0][0] + m[1][1] + m[2][2]);
  const b = m[0][0] * m[1][1] + m[0][0] * m[2][2] + m[1][1] * m[2][2]
    - m[0][1] * m[1][0] - m[0][2] * m[2][0] - m[1][2] * m[2][1];
  const c = -(m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]));
  const p = b - a * a / 3, q = 2 * a ** 3 / 27 - a * b / 3 + c;
  const discriminant = (q / 2) ** 2 + (p / 3) ** 3;
  if (discriminant > 0) {
    const u = Math.cbrt(-q / 2 + Math.sqrt(discriminant));
    const v = Math.cbrt(-q / 2 - Math.sqrt(discriminant));
    const real = (-0.5 * (u + v) - a / 3) * scale;
    const imaginary = Math.sqrt(3) * (u - v) * scale / 2;
    return [{ real: (u + v - a / 3) * scale, imaginary: 0 },
      { real, imaginary }, { real, imaginary: -imaginary }];
  }
  if (p >= 0) return Array.from({ length: 3 }, () => ({ real: -a * scale / 3, imaginary: 0 }));
  const radius = 2 * Math.sqrt(-p / 3);
  const angle = Math.acos(clamp(-q / (2 * Math.sqrt(-((p / 3) ** 3))), -1, 1)) / 3;
  return [0, 1, 2].map(k => ({ real: (radius * Math.cos(angle - 2 * Math.PI * k / 3) - a / 3) * scale, imaginary: 0 }));
}

/**
 * Bounded multistart Newton search for zeros of the quasi-steady reduction.
 * Every returned state satisfies all four ODEs and is classified using the full
 * Jacobian. A finite search may miss roots, especially near a bifurcation; an
 * empty list means no verified roots found, not proof of monostability.
 */
export function computeAttractors(
  params: Partial<LysogenySwitchParameters> = {}
): AttractorPoint[] {
  const p = resolveSwitchParameters(params);
  // Cro has strictly positive basal production, so decay=0 has no finite fixed point.
  if (p.decay === 0) return [];
  const maxCi = (p.ciProd * Math.sqrt(p.moi) + 0.6) / (p.decay + (50 * p.kCleavage + 0.2) * p.uv);
  const maxCro = (p.croProd + 0.05) / p.decay;
  if (![maxCi, maxCro].every(Number.isFinite)) throw new Error('Equilibrium search bounds exceed finite model arithmetic.');
  const tolerance = LYSOGENY_PHASE_LIMITS.residualTolerance;
  const seeds = (maximum: number, affinities: number[]) => [...new Set([
    ...Array.from({ length: 9 }, (_, i) => maximum * (i / 8) ** 3),
    ...affinities.filter(value => value <= maximum),
  ])];
  const roots: AttractorPoint[] = [];
  const rates = ([ci, cro]: number[]) => reducedRates(ci, cro, p);
  for (const ciSeed of seeds(maxCi, [p.kdCiOr1, p.kdCiOr2, p.kdCiOr3])) {
    for (const croSeed of seeds(maxCro, [p.kdCroOr])) {
      let state = [ciSeed, croSeed];
      for (let iteration = 0; iteration < LYSOGENY_PHASE_LIMITS.rootIterations; iteration++) {
        const f = rates(state), residual = Math.max(...f.map(Math.abs));
        if (!Number.isFinite(residual) || residual <= tolerance) break;
        const [[a, b], [c, d]] = jacobian(rates, state);
        const determinant = a * d - b * c;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-16) break;
        const delta = [(b * f[1] - d * f[0]) / determinant, (c * f[0] - a * f[1]) / determinant];
        if (!delta.every(Number.isFinite)) break;
        let improved = false;
        for (let damping = 1; damping >= 2 ** -20; damping /= 2) {
          const candidate = [clamp(state[0] + damping * delta[0], 0, maxCi), clamp(state[1] + damping * delta[1], 0, maxCro)];
          if (Math.max(...rates(candidate).map(Math.abs)) < residual) { state = candidate; improved = true; break; }
        }
        if (!improved) break;
      }
      const [ci, cro] = state;
      const fullState = calculateQuasiSteadyState(ci, cro, p);
      const derivative = calculateDerivatives(fullState, p);
      const residual = Math.max(...[derivative.dCi, derivative.dCro, derivative.dCII, derivative.dRecAStar].map(Math.abs));
      if (!Number.isFinite(residual) || residual > tolerance || roots.some(root =>
        Math.abs(root.ci - ci) <= 1e-5 * Math.max(1, ci) && Math.abs(root.cro - cro) <= 1e-5 * Math.max(1, cro))) continue;
      const matrix = jacobian(([x, y, z]) => {
        const value = calculateDerivatives({ ci: x, cro: y, cII: z, recAStar: fullState.recAStar }, p);
        return [value.dCi, value.dCro, value.dCII];
      }, [ci, cro, fullState.cII]);
      // The RecA* equation is independent: the full Jacobian is block triangular.
      const eigenvalues = [...eigenvalues3(matrix), { real: -0.2, imaginary: 0 }];
      const margin = LYSOGENY_PHASE_LIMITS.stabilityTolerance;
      // Fractional Hill powers have a singular derivative at zero. A root
      // within the one-sided stencil cannot support a reliable linearization.
      const nearSingularBoundary = p.hill < 1 && [ci, cro].some(value => value <= 1e-5 * Math.max(1, value));
      const resolved = eigenvalues.length === 4 && eigenvalues.every(value => Number.isFinite(value.real) && Number.isFinite(value.imaginary))
        && !nearSingularBoundary;
      const stability = !resolved || eigenvalues.some(value => Math.abs(value.real) <= margin) ? 'unresolved'
        : eigenvalues.every(value => value.real < -margin) ? 'stable' : 'saddle';
      const type = stability === 'stable' ? ci - cro > 0.25 ? 'lysogenic' : cro - ci > 0.25 ? 'lytic' : 'undecided' : stability;
      const name = stability === 'stable' ? `${type === 'undecided' ? 'Mixed CI/Cro' : type === 'lysogenic' ? 'CI-dominant' : 'Cro-dominant'} stable equilibrium`
        : stability === 'saddle' ? 'Saddle equilibrium' : 'Equilibrium (stability unresolved)';
      roots.push({ ...fullState, type, stability, residual, eigenvalues: resolved ? eigenvalues : [],
        label: `${name} (${ci.toFixed(2)}, ${cro.toFixed(2)})` });
    }
  }
  return roots.sort((a, b) => a.ci - b.ci || a.cro - b.cro);
}

/**
 * Compute an uncalibrated teaching score and the model assumptions contributing to it
 */
export function predictLysogenyFate(
  params: Partial<LysogenySwitchParameters> = {},
  circuit?: LysogenyCircuitReconstruction
): LysogenyPrediction {
  const p = { ...DEFAULT_LYSOGENY_PARAMS, ...params };
  const factors: string[] = [];

  // Check if phage is obligately lytic (cannot form lysogens)
  if (circuit?.architecture === 'obligately-lytic') {
    return {
      probability: 0.0,
      fate: 'lytic',
      factors: [
        'Obligately lytic model preset selected from explicit lifecycle metadata',
        'This teaching-model score is not an experimentally calibrated infection probability',
      ],
    };
  }

  let logOdds = 0.0;

  // MOI effect
  if (p.moi >= 3.0) {
    logOdds += 2.2;
    factors.push(`High MOI (${p.moi.toFixed(1)}) drives CII accumulation favoring lysogeny`);
  } else if (p.moi >= 1.5) {
    logOdds += 0.9;
    factors.push(`Moderate MOI (${p.moi.toFixed(1)}) favors lysogeny`);
  } else if (p.moi <= 0.6) {
    logOdds -= 1.8;
    factors.push(`Low MOI (${p.moi.toFixed(1)}) favors immediate lytic replication`);
  } else {
    logOdds -= 0.3;
    factors.push('Single infection balance favors lytic cycle');
  }

  // Host nutrient conditions
  if (p.nutrients <= 0.4) {
    logOdds += 1.4;
    factors.push('Starved host: HflB protease inactive, stabilizing CII for lysogenic dormancy');
  } else if (p.nutrients >= 1.4) {
    logOdds -= 0.9;
    factors.push('Rich host nutrients: active protease degrades CII, pushing toward lysis');
  }

  // UV Damage / DNA damage SOS response
  if (p.uv >= 0.4) {
    logOdds -= 3.0;
    factors.push(`Severe UV/SOS damage (${p.uv.toFixed(2)}): RecA* cleaves CI repressor (prophage induction)`);
  } else if (p.uv >= 0.1) {
    logOdds -= 1.2;
    factors.push(`Sublethal UV damage (${p.uv.toFixed(2)}): activates RecA* cleavage pathway`);
  }

  // Circuit genetic makeup factor
  if (circuit?.genes.cII) {
    logOdds += 0.4;
    factors.push('CII annotation contributes to this illustrative model score');
  }
  if (circuit?.genes.integrase) {
    logOdds += 0.3;
    factors.push('Integrase annotation contributes to this illustrative model score; activity is unverified');
  }

  const probability = clamp(1 / (1 + Math.exp(-logOdds)), 0.0, 1.0);
  const fate = probability > 0.65 ? 'lysogenic' : probability < 0.35 ? 'lytic' : 'undecided';

  return {
    probability,
    fate,
    factors,
  };
}

/**
 * Conservative, linear-coordinate motif candidates on both strands.
 * No sequence means no sites; annotations cannot synthesize binding sequences.
 * A match is not measured activity, binding or regulation. Unmeasured strengths,
 * affinities and efficiencies are null, separate from the illustrative ODE model.
 *
 * Sigma70 boxes/spacer: https://pmc.ncbi.nlm.nih.gov/articles/PMC3209215/
 * Exact lambda OR1 17-mer: https://pubmed.ncbi.nlm.nih.gov/2949139/
 * Hairpin/U-tract principle: https://pmc.ncbi.nlm.nih.gov/articles/PMC2295211/
 * The deliberately restricted terminator rule below is not a calibrated
 * predictor: 5–12 complementary GC pairs, a 3–8-base loop and 4–8 terminal Ts.
 * Only the cited lambda OR1 sequence is searched; other operators, mismatches,
 * circular-origin motifs, non-sigma70 promoters and noncanonical terminators
 * remain outside this scanner's reference coverage.
 */
export function findRegulatoryElements(
  sequence: string,
  _genes: GeneInfo[] = []
): { promoters: Promoter[]; operators: Operator[]; terminators: Terminator[] } {
  const promoters: Promoter[] = [];
  const operators: Operator[] = [];
  const terminators: Terminator[] = [];
  if (typeof sequence !== 'string' || sequence.length > 5_000_000 || /[^ACGTRYSWKMBDHVN]/i.test(sequence)) {
    throw new Error('Regulatory motif scanning requires at most 5,000,000 IUPAC DNA bases without gaps or changed coordinates.');
  }
  if (!sequence.length) return { promoters, operators, terminators };
  const upper = sequence.toUpperCase();
  const admit = () => {
    if (promoters.length + operators.length + terminators.length >= 10_000) {
      throw new Error('The genome exceeds the supported limit of 10,000 regulatory motif candidates; no partial result was returned.');
    }
  };
  for (const direction of ['+', '-'] as const) {
    const oriented = direction === '+' ? upper : reverseComplement(upper);
    const genomicStart = (start: number, length: number) =>
      direction === '+' ? start : upper.length - start - length;

    // Enumerate every allowed spacer; an early invalid -10-like word must not
    // hide a later valid box. lookahead preserves overlapping -35 occurrences.
    const boxes = /(?=(TTGAC[AT]))/g;
    let box: RegExpExecArray | null;
    while ((box = boxes.exec(oriented)) !== null) {
      const start = box.index;
      boxes.lastIndex = start + 1;
      for (let spacer = 15; spacer <= 19; spacer++) {
        const minus10 = start + 6 + spacer;
        if (!/^TA[TA]AAT$/.test(oriented.slice(minus10, minus10 + 6))) continue;
        const motif = oriented.slice(start, minus10 + 6);
        if (!/^[ACGT]+$/.test(motif)) continue;
        const position = genomicStart(start, motif.length);
        admit();
        promoters.push({
          name: `sigma70_candidate_${position}_${direction}`, position,
          strength: null, direction, sigmaFactor: 'sigma70', sequence: motif,
        });
      }
    }

    // Exact reference length: never append arbitrary bases via a greedy flank.
    const or1 = 'TATCACCGCCAGAGGTA';
    for (let start = oriented.indexOf(or1); start !== -1; start = oriented.indexOf(or1, start + 1)) {
      const position = genomicStart(start, or1.length);
      admit();
      operators.push({
        name: `lambda_OR1_sequence_match_${position}_${direction}`, position,
        sequence: or1, direction, bindingAffinityCi: null, bindingAffinityCro: null, boundBy: 'unknown',
      });
    }

    // Require actual antiparallel complementarity, not merely two GC-rich runs.
    // The longest supported stem (then shortest loop) represents each T tract.
    const tails = /T{4,}/g;
    let tail: RegExpExecArray | null;
    while ((tail = tails.exec(oriented)) !== null) {
      const tailStart = tail.index;
      let candidate: { start: number; sequence: string } | null = null;
      for (let stem = 12; stem >= 5 && !candidate; stem--) {
        const rightStart = tailStart - stem;
        if (rightStart < 0) continue;
        const right = oriented.slice(rightStart, tailStart);
        if (!/^[GC]+$/.test(right)) continue;
        for (let loop = 3; loop <= 8; loop++) {
          const start = rightStart - loop - stem;
          if (start < 0) continue;
          const left = oriented.slice(start, start + stem);
          if (left !== reverseComplement(right) ||
            !/^[ACGT]+$/.test(oriented.slice(start + stem, rightStart))) continue;
          candidate = { start, sequence: oriented.slice(start, tailStart + Math.min(8, tail[0].length)) };
          break;
        }
      }
      if (candidate) {
        const position = genomicStart(candidate.start, candidate.sequence.length);
        admit();
        terminators.push({
          name: `hairpin_tail_candidate_${position}_${direction}`,
          position, sequence: candidate.sequence, direction, efficiency: null,
        });
      }
    }
  }
  promoters.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  operators.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  terminators.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return { promoters, operators, terminators };
}

/**
 * Reconstruct lysogeny regulatory circuit from phage metadata, gene annotations, and sequence
 */
export function reconstructLysogenyCircuit(
  phage?: PhageFull | null,
  sequence?: string
): LysogenyCircuitReconstruction {
  if (sequence !== undefined && phage?.genomeLength != null && sequence.length !== phage.genomeLength) {
    throw new Error('Regulatory reconstruction requires the complete selected genome sequence, with unchanged coordinates.');
  }
  const genes: CircuitKeyGenes = {};
  const geneList = phage?.genes ?? [];

  for (const gene of geneList) {
    // Gene features can duplicate their CDS, and generic HTH/peptidase domains
    // do not establish a CI/Cro regulatory role. Keep only explicit CDS labels.
    if (gene.type !== 'CDS') continue;
    const name = (gene.name ?? '').trim().toLowerCase();
    const product = (gene.product ?? '').trim().toLowerCase();

    // Match specific tokens before broader roles. In particular, CIII is not
    // CII, Cro/antirepressor is not CI, and "internal" is not an int gene.
    if (name === 'cro' || /\bcro\b/.test(product)) {
      if (!genes.cro) genes.cro = gene;
    } else if (name === 'ciii' || /\bciii\b/.test(product)) {
      if (!genes.cIII) genes.cIII = gene;
    } else if (name === 'cii' || /\bcii\b/.test(product)) {
      if (!genes.cII) genes.cII = gene;
    } else if (
      name === 'ci' || name === 'c1' ||
      /\b(?:ci|c1)\b.*\brepressor\b|\brepressor\b.*\b(?:ci|c1)\b|\b(?:immunity|phage) repressor\b/.test(product)
    ) {
      if (!genes.ci) genes.ci = gene;
    } else if (name === 'n' || /\bantiterminator n\b|\bantitermination protein n\b/.test(product)) {
      if (!genes.n) genes.n = gene;
    } else if (name === 'q' || /\bantiterminator q\b|\blate control (?:gene|protein) q\b/.test(product)) {
      if (!genes.q) genes.q = gene;
    } else if (name === 'int' || name === 'integrase' ||
      /\bintegrase\b|\bsite[- ]specific recombinase\b/.test(product)) {
      if (!genes.integrase) genes.integrase = gene;
    } else if (name === 'xis' || /\bexcisionase\b/.test(product)) {
      if (!genes.excisionase) genes.excisionase = gene;
    }
  }

  // Scan sequence if available
  const seq = sequence ?? '';
  const elements = findRegulatoryElements(seq, geneList);
  const promoters = [...elements.promoters];
  const operators = [...elements.operators];
  const terminators = [...elements.terminators];

  // Empty motif arrays are meaningful. A CI/Cro annotation cannot supply
  // canonical PR/PRM/PL coordinates or lambda operator sequences for this genome.

  // Only an explicit lifecycle declaration supports the lytic model preset.
  // Names, an unspecified "lytic" phase, and unrecognized annotations do not.
  const lifecycle = (phage?.lifecycle ?? '').trim().toLowerCase();
  const declaredLytic = /^(?:virulent|strictly[ -]lytic|obligately[ -]lytic)$/.test(lifecycle);
  const declaredTemperate = /^(?:temperate|lysogenic|lysogeny)$/.test(lifecycle);
  const conflictingEvidence = declaredLytic && !!(genes.ci || genes.integrase);

  let architecture: CircuitArchitecture = 'unknown';
  let isTemperate = false;
  const confidence = null;

  if (!conflictingEvidence) {
    if (genes.ci && genes.cro) {
      architecture = 'lambda-like';
      isTemperate = true;
    } else if (genes.ci || genes.integrase || declaredTemperate) {
      architecture = 'temperate';
      isTemperate = true;
    } else if (declaredLytic) {
      architecture = 'obligately-lytic';
    }
  }

  const summary = conflictingEvidence
    ? 'Lytic lifecycle metadata conflicts with repressor/integrase annotations; the circuit is unresolved.'
    : architecture === 'lambda-like'
      ? 'CI and Cro annotations support a Lambda-like model hypothesis; operator binding and circuit function are unverified.'
      : architecture === 'temperate'
        ? 'Temperate lifecycle metadata and/or specific repressor/integrase annotations; regulatory topology is unverified.'
        : architecture === 'obligately-lytic'
          ? 'Supplied lifecycle metadata declares a lytic phage; missing annotations are not used to infer this.'
          : 'No supported regulatory architecture was established from the supplied annotations or lifecycle metadata.';

  // These are teaching-model presets, not kinetic quantities inferred from DNA.
  // An unresolved genome retains the generic switch rather than a lytic preset.
  const inferredParams = isTemperate
    ? {
        ciProd: genes.cII ? 0.9 : 0.75,
        croProd: 0.6,
        hill: 2.2,
        decay: 0.05,
        omega: 10.0,
      }
    : architecture === 'obligately-lytic'
      ? { ciProd: 0.05, croProd: 1.2, hill: 1.5, decay: 0.06, omega: 1.0 }
      : { ciProd: 0.8, croProd: 0.6, hill: 2.0, decay: 0.05, omega: 10.0 };

  return {
    architecture,
    isTemperate,
    confidence,
    promoters,
    operators,
    terminators,
    genes,
    summary,
    sequenceStatus: sequence === undefined ? 'not-supplied' : 'scanned',
    sequenceLength: sequence === undefined ? null : sequence.length,
    limitations: [
      'Annotations identify candidate roles, not functional regulation, measured kinetic rates or binding affinities.',
      'Sequence scanning covers both strands in linear coordinates. Circular-origin sites are not searched.',
      'Only the exact cited lambda OR1 sequence, restricted sigma70 box/spacer motifs and complementary GC hairpin/T-tail motifs are searched. No match does not exclude regulatory sites.',
      'The generic three-site occupancy model and teaching fate score are separate from these genomic candidates; neither is calibrated to this phage.',
    ],
    inferredParams,
  };
}

/**
 * Derive simulation parameters from phage genome
 */
export function deriveLysogenyCircuitParams(
  phage?: PhageFull | null
): Record<string, number | boolean | string> {
  if (!phage || !phage.genes || phage.genes.length === 0) {
    return {};
  }

  const circuit = reconstructLysogenyCircuit(phage);
  if (circuit.architecture === 'unknown') return {};
  return {
    ciProd: circuit.inferredParams.ciProd,
    croProd: circuit.inferredParams.croProd,
    hill: circuit.inferredParams.hill,
    decay: circuit.inferredParams.decay,
  };
}
