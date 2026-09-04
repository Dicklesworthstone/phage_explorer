/**
 * Lysogeny/Lysis Decision Circuit Reconstructor
 *
 * Implements the molecular biophysics and systems biology of the bacteriophage
 * lysis-lysogeny genetic switch (such as the classic Lambda CI/Cro bistable toggle):
 *
 * 1. Regulatory element & key gene reconstruction from genome sequences and annotations:
 *    - Promoters: PRM (repressor maintenance), PR (cro/lytic), PL (leftward/N), PRE (repressor establishment)
 *    - Operators: Three-site operator clusters (OR1, OR2, OR3, OL1, OL2, OL3)
 *    - Key proteins: CI repressor, Cro, CII decision factor, CIII stabilizer, N antiterminator, Q antiterminator, Integrase
 * 2. Shea-Ackers three-site operator occupancy partition function Z with cooperative binding
 * 3. Mutual repression ODE system with Hill kinetics, RecA* SOS-cleavage, and CII feedback
 * 4. Phase portrait generation: 2D vector fields, nullclines, attractors (lysogenic vs lytic basins), and separatrix
 * 5. Lysogeny fate probability prediction under environmental perturbations (MOI, UV damage, nutrients)
 */

import type { GeneInfo, PhageFull } from '../types';

export interface Promoter {
  name: string;
  position: number;
  strength: number; // 0..1 relative activity
  direction: '+' | '-';
  sigmaFactor?: string;
  sequence?: string;
}

export interface Operator {
  name: string;
  position: number;
  sequence: string;
  bindingAffinityCi: number; // Kd in arbitrary units / nM
  bindingAffinityCro: number; // Kd in arbitrary units / nM
  boundBy: 'CI' | 'Cro' | 'both';
}

export interface Terminator {
  name: string;
  position: number;
  efficiency: number; // 0..1
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
  confidence: number; // 0..1
  promoters: Promoter[];
  operators: Operator[];
  terminators: Terminator[];
  genes: CircuitKeyGenes;
  summary: string;
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
  type: 'lysogenic' | 'lytic' | 'saddle';
  ci: number;
  cro: number;
  label: string;
}

export interface LysogenyPrediction {
  probability: number; // 0..1
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
  const p = { ...DEFAULT_LYSOGENY_PARAMS, ...params };
  const hill = p.hill;
  const omega = p.omega;

  const safeCi = Math.max(0, ci);
  const safeCro = Math.max(0, cro);

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
  const p = { ...DEFAULT_LYSOGENY_PARAMS, ...params };
  const ci = Math.max(0, state.ci);
  const cro = Math.max(0, state.cro);
  const cII = Math.max(0, state.cII ?? 0.1);
  const recAStar = Math.max(0, state.recAStar ?? 0);

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
 * Step the mutual repression simulation forward by dt (Euler integration with stabilization)
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
  const clampedDt = Math.min(0.5, Math.max(0.01, dt));
  const { dCi, dCro, dCII, dRecAStar, occupancy } = calculateDerivatives(state, params);

  const nextCi = clamp(state.ci + dCi * clampedDt, 0, 4.0);
  const nextCro = clamp(state.cro + dCro * clampedDt, 0, 4.0);
  const nextCII = clamp((state.cII ?? 0.1) + dCII * clampedDt, 0, 3.0);
  const nextRecA = clamp((state.recAStar ?? 0) + dRecAStar * clampedDt, 0, 5.0);

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
 * Compute 2D Phase Portrait grid (vector field dCI/dt vs dCro/dt)
 */
export function computeCircuitPhasePortrait(
  params: Partial<LysogenySwitchParameters> = {},
  gridSize = 16,
  maxCi = 3.0,
  maxCro = 3.0
): PhasePortraitPoint[] {
  const points: PhasePortraitPoint[] = [];

  for (let i = 0; i <= gridSize; i++) {
    const ci = (i / gridSize) * maxCi;
    for (let j = 0; j <= gridSize; j++) {
      const cro = (j / gridSize) * maxCro;
      const { dCi, dCro } = calculateDerivatives({ ci, cro, cII: 0.2, recAStar: 0 }, params);
      const mag = Math.sqrt(dCi * dCi + dCro * dCro);

      // Fate basin proxy: if projected trajectory moves toward high CI / low Cro -> lysogenic
      const fate: 'lysogenic' | 'lytic' | 'undecided' =
        ci > cro && dCi >= -0.1
          ? 'lysogenic'
          : cro > ci && dCro >= -0.1
            ? 'lytic'
            : dCi > dCro
              ? 'lysogenic'
              : 'lytic';

      points.push({
        ci,
        cro,
        dCi,
        dCro,
        magnitude: mag,
        fate,
      });
    }
  }

  return points;
}

/**
 * Compute nullclines (curves where dCI/dt = 0 and dCro/dt = 0)
 */
export function computeNullclines(
  params: Partial<LysogenySwitchParameters> = {},
  steps = 30,
  maxCi = 3.0,
  maxCro = 3.0
): { ciNullcline: NullclinePoint[]; croNullcline: NullclinePoint[] } {
  const ciNullcline: NullclinePoint[] = [];
  const croNullcline: NullclinePoint[] = [];

  // Find CI-nullcline: for fixed cro, find ci where dCi ≈ 0
  for (let j = 0; j <= steps; j++) {
    const cro = (j / steps) * maxCro;
    let bestCi = 0;
    let minDiff = Infinity;
    for (let i = 0; i <= 60; i++) {
      const ci = (i / 60) * maxCi;
      const { dCi } = calculateDerivatives({ ci, cro, cII: 0.1, recAStar: 0 }, params);
      if (Math.abs(dCi) < minDiff) {
        minDiff = Math.abs(dCi);
        bestCi = ci;
      }
    }
    ciNullcline.push({ ci: bestCi, cro });
  }

  // Find Cro-nullcline: for fixed ci, find cro where dCro ≈ 0
  for (let i = 0; i <= steps; i++) {
    const ci = (i / steps) * maxCi;
    let bestCro = 0;
    let minDiff = Infinity;
    for (let j = 0; j <= 60; j++) {
      const cro = (j / 60) * maxCro;
      const { dCro } = calculateDerivatives({ ci, cro, cII: 0.1, recAStar: 0 }, params);
      if (Math.abs(dCro) < minDiff) {
        minDiff = Math.abs(dCro);
        bestCro = cro;
      }
    }
    croNullcline.push({ ci, cro: bestCro });
  }

  return { ciNullcline, croNullcline };
}

/**
 * Compute key attractors and saddle point in phase space
 */
export function computeAttractors(
  params: Partial<LysogenySwitchParameters> = {}
): AttractorPoint[] {
  // Simulate forward from lysogenic attractor basin
  let lysoState = { ci: 2.2, cro: 0.1, cII: 0.5, recAStar: 0 };
  for (let i = 0; i < 40; i++) {
    lysoState = simulateSwitchStep(lysoState, 0.1, params);
  }

  // Simulate forward from lytic attractor basin
  let lyticState = { ci: 0.05, cro: 2.0, cII: 0.0, recAStar: 0 };
  for (let i = 0; i < 40; i++) {
    lyticState = simulateSwitchStep(lyticState, 0.1, params);
  }

  return [
    {
      type: 'lysogenic',
      ci: lysoState.ci,
      cro: lysoState.cro,
      label: `Lysogenic Attractor (${lysoState.ci.toFixed(2)}, ${lysoState.cro.toFixed(2)})`,
    },
    {
      type: 'lytic',
      ci: lyticState.ci,
      cro: lyticState.cro,
      label: `Lytic Attractor (${lyticState.ci.toFixed(2)}, ${lyticState.cro.toFixed(2)})`,
    },
    {
      type: 'saddle',
      ci: (lysoState.ci + lyticState.ci) / 2,
      cro: (lysoState.cro + lyticState.cro) / 2,
      label: 'Separatrix / Saddle Threshold',
    },
  ];
}

/**
 * Predict lysogeny fate probability and contributing factors
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
        'Obligately lytic phage: lacks repressor/integrase cassette',
        'Infection strictly commits to virulent lysis',
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
    factors.push('Intact CII activator gene detected in genome');
  }
  if (circuit?.genes.integrase) {
    logOdds += 0.3;
    factors.push('Site-specific integrase cassette verified');
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
 * Scan DNA sequence for promoters, operators, and terminators
 */
export function findRegulatoryElements(
  sequence: string,
  _genes: GeneInfo[] = []
): { promoters: Promoter[]; operators: Operator[]; terminators: Terminator[] } {
  const promoters: Promoter[] = [];
  const operators: Operator[] = [];
  const terminators: Terminator[] = [];

  if (!sequence || sequence.length < 50) {
    return { promoters, operators, terminators };
  }

  const upper = sequence.toUpperCase();

  // 1. Promoter motif scanning: -35 (TTGACA) and -10 (TATAAT) with 15-19 bp spacer
  const minus35Regex = /TTGAC[AT]/g;
  let m35;
  while ((m35 = minus35Regex.exec(upper)) !== null && promoters.length < 12) {
    const pos = m35.index;
    const spacerRegion = upper.substring(pos + 6, Math.min(pos + 30, upper.length));
    const minus10Match = spacerRegion.search(/TA[TA]AAT/);
    if (minus10Match !== -1) {
      const pPos = pos;
      promoters.push({
        name: `P_${pPos}`,
        position: pPos,
        strength: 0.85,
        direction: '+',
        sigmaFactor: 'sigma70',
        sequence: upper.substring(pos, pos + 6 + minus10Match + 6),
      });
    }
  }

  // 2. Operator motif scanning: 16-17bp palindromic Lambdoid/P22 operator consensus (TATCAC[C]...GGT...)
  const operatorRegex = /TATCACC[ACGT]{2,6}GGT[ACGT]{0,4}|TATCAC[ACGT]{3,6}GTG[ACGT]{0,4}/g;
  let opMatch;
  while ((opMatch = operatorRegex.exec(upper)) !== null && operators.length < 8) {
    operators.push({
      name: `O_${opMatch.index}`,
      position: opMatch.index,
      sequence: opMatch[0],
      bindingAffinityCi: 0.5,
      bindingAffinityCro: 0.6,
      boundBy: 'both',
    });
  }

  // 3. Intrinsic terminator motif: GC stem-loop followed by 4+ Ts/Us
  const polyTRegex = /[GC]{5,12}[ATGC]{3,8}[GC]{5,12}T{4,8}/g;
  let termMatch;
  while ((termMatch = polyTRegex.exec(upper)) !== null && terminators.length < 6) {
    terminators.push({
      name: `t_${termMatch.index}`,
      position: termMatch.index,
      efficiency: 0.9,
    });
  }

  return { promoters, operators, terminators };
}

/**
 * Reconstruct lysogeny regulatory circuit from phage metadata, gene annotations, and sequence
 */
export function reconstructLysogenyCircuit(
  phage?: PhageFull | null,
  sequence?: string
): LysogenyCircuitReconstruction {
  const genes: CircuitKeyGenes = {};
  const geneList = phage?.genes ?? [];

  for (const gene of geneList) {
    const name = (gene.name ?? '').toLowerCase();
    const product = (gene.product ?? '').toLowerCase();
    const domains = (gene.domains ?? []).map(d => d.toLowerCase()).join(' ');

    if (
      name === 'ci' ||
      name === 'c1' ||
      name.includes('repressor') ||
      product.includes('ci repressor') ||
      product.includes('immunity repressor') ||
      product.includes('phage repressor') ||
      domains.includes('pf01381') ||
      domains.includes('pf00717')
    ) {
      if (!genes.ci) genes.ci = gene;
    } else if (
      name === 'cro' ||
      product.includes('cro') ||
      product.includes('antirepressor') ||
      product.includes('transcriptional regulator cro')
    ) {
      if (!genes.cro) genes.cro = gene;
    } else if (name === 'cii' || name === 'c2' || product.includes('cii') || product.includes('c2 protein')) {
      if (!genes.cII) genes.cII = gene;
    } else if (name === 'ciii' || name === 'c3' || product.includes('ciii') || product.includes('c3 protein')) {
      if (!genes.cIII) genes.cIII = gene;
    } else if (name === 'n' || product.includes('antiterminator n') || product.includes('antitermination protein n')) {
      if (!genes.n) genes.n = gene;
    } else if (name === 'q' || product.includes('antiterminator q') || product.includes('late control gene q')) {
      if (!genes.q) genes.q = gene;
    } else if (
      name.includes('int') ||
      product.includes('integrase') ||
      product.includes('site-specific recombinase') ||
      domains.includes('pf00589')
    ) {
      if (!genes.integrase) genes.integrase = gene;
    } else if (name.includes('xis') || product.includes('excisionase')) {
      if (!genes.excisionase) genes.excisionase = gene;
    }
  }

  // Scan sequence if available
  const seq = sequence ?? '';
  const elements = findRegulatoryElements(seq, geneList);
  const promoters = [...elements.promoters];
  const operators = [...elements.operators];
  const terminators = [...elements.terminators];

  // If no sequence was provided or motifs were sparse, populate synteny-derived canonical sites
  if (promoters.length === 0 && (genes.ci || genes.cro)) {
    const ciPos = genes.ci ? (genes.ci.startPos + genes.ci.endPos) / 2 : 37900;
    promoters.push(
      { name: 'PRM', position: ciPos - 20, strength: 0.8, direction: '-', sigmaFactor: 'sigma70' },
      { name: 'PR', position: ciPos + 50, strength: 1.0, direction: '+', sigmaFactor: 'sigma70' },
      { name: 'PL', position: ciPos - 2000, strength: 0.9, direction: '-', sigmaFactor: 'sigma70' }
    );
  }

  if (operators.length === 0 && (genes.ci || genes.cro)) {
    const ciPos = genes.ci ? (genes.ci.startPos + genes.ci.endPos) / 2 : 37900;
    operators.push(
      { name: 'OR1', position: ciPos + 30, sequence: 'TATCACCGCAGGTGGT', bindingAffinityCi: 0.4, bindingAffinityCro: 1.2, boundBy: 'both' },
      { name: 'OR2', position: ciPos + 10, sequence: 'TAACACCGTGCGTGTT', bindingAffinityCi: 0.8, bindingAffinityCro: 0.9, boundBy: 'both' },
      { name: 'OR3', position: ciPos - 10, sequence: 'TATCACCGCAGGTGGT', bindingAffinityCi: 1.6, bindingAffinityCro: 0.5, boundBy: 'both' }
    );
  }

  // Lifecycle detection
  const lifecycle = (phage?.lifecycle ?? '').toLowerCase();
  const name = (phage?.name ?? '').toLowerCase();
  const isKnownLytic =
    lifecycle.includes('virulent') ||
    lifecycle.includes('lytic') ||
    name.includes('t4') ||
    name.includes('t7') ||
    name.includes('phikz');

  let architecture: CircuitArchitecture = 'unknown';
  let isTemperate = false;
  let confidence = 0.5;

  if (genes.ci && genes.cro) {
    architecture = 'lambda-like';
    isTemperate = true;
    confidence = 0.95;
  } else if (genes.ci || genes.integrase || lifecycle.includes('temperate') || lifecycle.includes('lysogen')) {
    architecture = 'temperate';
    isTemperate = true;
    confidence = 0.8;
  } else if (isKnownLytic || (!genes.ci && !genes.integrase && geneList.length > 10)) {
    architecture = 'obligately-lytic';
    isTemperate = false;
    confidence = 0.9;
  }

  const summary =
    architecture === 'lambda-like'
      ? 'Classical Lambda-like bistable switch: CI repressor and Cro antirepressor with cooperative operator sites'
      : architecture === 'temperate'
        ? 'Temperate phage circuit: Integrase and/or CI-like repressor identified'
        : architecture === 'obligately-lytic'
          ? 'Obligately lytic architecture: Lacks CI repressor and integrase cassette; locked in lytic cycle'
          : 'Atypical or uncharacterized regulatory circuit';

  const inferredParams = isTemperate
    ? {
        ciProd: genes.cII ? 0.9 : 0.75,
        croProd: 0.6,
        hill: 2.2,
        decay: 0.05,
        omega: 10.0,
      }
    : {
        ciProd: 0.05,
        croProd: 1.2,
        hill: 1.5,
        decay: 0.06,
        omega: 1.0,
      };

  return {
    architecture,
    isTemperate,
    confidence,
    promoters,
    operators,
    terminators,
    genes,
    summary,
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
  return {
    ciProd: circuit.inferredParams.ciProd,
    croProd: circuit.inferredParams.croProd,
    hill: circuit.inferredParams.hill,
    decay: circuit.inferredParams.decay,
  };
}
