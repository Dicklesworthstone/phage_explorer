/**
 * Auxiliary Metabolic Gene (AMG) Flux Potential Analyzer
 *
 * Implements Flux Balance Analysis (FBA) and Delta-FBA to estimate
 * host metabolic pathway flux gains conferred by phage AMGs:
 *
 * 1. AMG detection from Pfam annotations, gene names, and products
 * 2. Mapping to KEGG Orthology (KO) and metabolic reactions
 * 3. Floating-point linear programming for steady-state stoichiometric systems:
 *      Maximize c^T * v subject to S * v = 0, v_lb <= v <= v_ub
 * 4. Delta-FBA comparison: baseline host metabolism vs AMG-augmented metabolism
 * 5. Illustrative pathway responses to assumed capacity changes
 */

import type { PhageFull } from '../types';

export interface KOMapping {
  ko: string; // e.g. "K00525"
  name: string; // e.g. "ribonucleoside-diphosphate reductase alpha subunit"
  reaction: string; // e.g. "R00155"
  pathway: string[]; // e.g. ["map00230", "map00240"]
  ecNumber: string; // e.g. "1.17.4.1"
  confidence: number; // 0..1
}

export type AMGClass =
  | 'nucleotide'
  | 'photosynthesis'
  | 'carbon'
  | 'phosphate'
  | 'sulfur'
  | 'stress'
  | 'other';

export interface AMGDetection {
  geneId: number;
  geneName: string;
  locusTag: string;
  start: number;
  end: number;
  strand: string;
  amgClass: AMGClass;
  koMapping: KOMapping;
  evidence: 'pfam' | 'product_name' | 'gene_name';
  boostedReactions: string[];
}

export interface MetabolicReaction {
  id: string;
  name: string;
  subsystem: string;
  stoichiometry: Record<string, number>; // metabolite -> coefficient (- for consumed, + for produced)
  lowerBound: number;
  upperBound: number;
  reversible: boolean;
  koIds: string[];
}

export interface HostMetabolicModel {
  id: string;
  name: string;
  description: string;
  metabolites: string[];
  reactions: MetabolicReaction[];
  objectiveReaction: string;
}

/** Parse the small, explicit JSON model format used by the browser sandbox. */
export function parseHostMetabolicModel(json: string): HostMetabolicModel {
  const decoded: unknown = JSON.parse(json);
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const value = record(decoded) && record(decoded.model) ? decoded.model : decoded;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0);
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name ||
      typeof value.description !== 'string' || typeof value.objectiveReaction !== 'string' ||
      !strings(value.metabolites) || !Array.isArray(value.reactions) || value.reactions.length === 0 ||
      value.reactions.length > 100 || value.metabolites.length > 100 ||
      !value.reactions.every(r => record(r) && typeof r.id === 'string' && r.id && typeof r.name === 'string' &&
        typeof r.subsystem === 'string' && record(r.stoichiometry) && Object.values(r.stoichiometry).every(Number.isFinite) &&
        Number.isFinite(r.lowerBound) && Number.isFinite(r.upperBound) && typeof r.reversible === 'boolean' && strings(r.koIds))) {
    throw new Error('Invalid model JSON. Supply id, name, description, metabolites, objectiveReaction and up to 100 reactions with finite coefficients and bounds. Export the teaching model for the format.');
  }
  // Shape checks above establish the model type. Structural model errors such
  // as missing objectives and incompatible bounds remain explicit solver statuses.
  return value as unknown as HostMetabolicModel;
}

export type FBAStatus = 'optimal' | 'infeasible' | 'unbounded' | 'invalid_input' | 'iteration_limit' | 'numerical_error';

export type FBAResult =
  | { status: 'optimal'; objectiveValue: number; fluxes: Record<string, number> }
  | { status: Exclude<FBAStatus, 'optimal'>; objectiveValue: null; fluxes: Record<string, number> };

export interface ReactionDelta {
  reactionId: string;
  reactionName: string;
  subsystem: string;
  baselineFlux: number;
  augmentedFlux: number;
  deltaFlux: number;
  percentChange: number;
}

export interface PathwayImpact {
  pathwayName: string;
  totalDeltaFlux: number;
  reactionsCount: number;
  significance: 'high' | 'medium' | 'low';
}

export interface DeltaFBAResult {
  status: 'optimal';
  amg: AMGDetection;
  baselineObjective: number;
  augmentedObjective: number;
  deltaObjective: number;
  percentGain: number | null; // Undefined when the baseline objective is zero.
  pathwayImpacts: PathwayImpact[];
  topReactionDeltas: ReactionDelta[];
}

export type DeltaFBAFailure = { amg: AMGDetection; status: Exclude<FBAStatus, 'optimal'> };

export interface AMGFluxAnalysisResult {
  phageId: number;
  phageName: string;
  detectedAmgs: AMGDetection[];
  baselineFba: FBAResult;
  amgResults: DeltaFBAResult[];
  failedAmgs: DeltaFBAFailure[];
  totalDeltaFlux: number;
  topOverallImpactedSubsystem: string;
  summary: string;
}

/**
 * Curated knowledge base mapping Pfam domains & marker genes to KEGG Orthologs
 */
export const AMG_KNOWLEDGE_BASE: Array<{
  namePattern: RegExp;
  pfamId?: string;
  amgClass: AMGClass;
  ko: KOMapping;
  reactions: string[];
}> = [
  {
    namePattern: /\bpsba\b|photosystem ii.*d1 protein/i,
    pfamId: 'PF00124',
    amgClass: 'photosynthesis',
    ko: {
      ko: 'K02703',
      name: 'photosystem II P680 reaction center D1 protein',
      reaction: 'R09503',
      pathway: ['map00195', 'map00196'],
      ecNumber: '1.10.3.9',
      confidence: 0.95,
    },
    reactions: ['PSII_ELECTRON_TRANSPORT'],
  },
  {
    namePattern: /\bpsbd\b|photosystem ii.*d2 protein/i,
    pfamId: 'PF00124',
    amgClass: 'photosynthesis',
    ko: {
      ko: 'K02706',
      name: 'photosystem II P680 reaction center D2 protein',
      reaction: 'R09503',
      pathway: ['map00195', 'map00196'],
      ecNumber: '1.10.3.9',
      confidence: 0.95,
    },
    reactions: ['PSII_ELECTRON_TRANSPORT'],
  },
  {
    namePattern: /\bnrda\b|ribonucleoside-diphosphate reductase alpha/i,
    pfamId: 'PF00317',
    amgClass: 'nucleotide',
    ko: {
      ko: 'K00525',
      name: 'ribonucleoside-diphosphate reductase alpha chain',
      reaction: 'R00155',
      pathway: ['map00230', 'map00240'],
      ecNumber: '1.17.4.1',
      confidence: 0.98,
    },
    reactions: ['RNR_REDUCTASE'],
  },
  {
    namePattern: /\bnrdb\b|ribonucleoside-diphosphate reductase beta/i,
    pfamId: 'PF00268',
    amgClass: 'nucleotide',
    ko: {
      ko: 'K00526',
      name: 'ribonucleoside-diphosphate reductase beta chain',
      reaction: 'R00155',
      pathway: ['map00230', 'map00240'],
      ecNumber: '1.17.4.1',
      confidence: 0.98,
    },
    reactions: ['RNR_REDUCTASE'],
  },
  {
    namePattern: /\bthya\b|thymidylate synthase/i,
    pfamId: 'PF00303',
    amgClass: 'nucleotide',
    ko: {
      ko: 'K00560',
      name: 'thymidylate synthase',
      reaction: 'R02101',
      pathway: ['map00240'],
      ecNumber: '2.1.1.45',
      confidence: 0.99,
    },
    reactions: ['THYMIDYLATE_SYNTHASE'],
  },
  {
    namePattern: /\bdut\b|dutpase|deoxyuridine 5'-triphosphate nucleotidohydrolase/i,
    pfamId: 'PF00692',
    amgClass: 'nucleotide',
    ko: {
      ko: 'K01520',
      name: 'dUTP diphosphatase',
      reaction: 'R00438',
      pathway: ['map00240'],
      ecNumber: '3.6.1.23',
      confidence: 0.96,
    },
    reactions: ['DUTPASE_REACTION'],
  },
  {
    namePattern: /\bphoh\b|phosphate starvation-inducible protein phoh/i,
    pfamId: 'PF04997',
    amgClass: 'phosphate',
    ko: {
      ko: 'K06217',
      name: 'phosphate starvation-inducible protein PhoH',
      reaction: 'R00086',
      pathway: ['map02010'],
      ecNumber: '3.6.1.-',
      confidence: 0.92,
    },
    reactions: ['PHOSPHATE_RECOVERY'],
  },
  {
    namePattern: /\bmazg\b|nucleoside triphosphate pyrophosphohydrolase/i,
    pfamId: 'PF03819',
    amgClass: 'phosphate',
    ko: {
      ko: 'K05810',
      name: 'nucleoside triphosphate pyrophosphohydrolase MazG',
      reaction: 'R00130',
      pathway: ['map00230', 'map00240'],
      ecNumber: '3.6.1.8',
      confidence: 0.94,
    },
    reactions: ['MAZG_PYROPHOSPHATASE'],
  },
];

/**
 * Standard host metabolic model representing bacterial host central and precursor metabolism.
 * S is stoichiometric matrix: reactions conserve internal metabolites at steady state.
 */
export function createStandardHostMetabolicModel(): HostMetabolicModel {
  return {
    id: 'host_core_metabolism',
    name: 'Illustrative precursor network',
    description: 'Teaching model in arbitrary flux units combining carbon, nucleotide and photosynthetic reactions. Not a calibrated organism-specific reconstruction; bound changes are user assumptions.',
    objectiveReaction: 'BIOMASS_VIRAL_DNTPS',
    metabolites: [
      'glc',
      'g6p',
      'f6p',
      'pep',
      'pyr',
      'accoa',
      'oaa',
      'prpp',
      'ndp',
      'dndp',
      'dump',
      'dtmp',
      'dntp',
      'atp',
      'adp',
      'pi',
      'ppi',
      'nadh',
      'nadph',
      'light',
    ],
    reactions: [
      // Exchange and uptake
      {
        id: 'EX_glc',
        name: 'Glucose intake exchange',
        subsystem: 'Transport',
        stoichiometry: { glc: 1 },
        lowerBound: 0,
        upperBound: 10,
        reversible: false,
        koIds: [],
      },
      {
        id: 'EX_pi',
        name: 'Phosphate intake exchange',
        subsystem: 'Transport',
        stoichiometry: { pi: 1 },
        lowerBound: 0,
        upperBound: 15,
        reversible: false,
        koIds: [],
      },
      {
        id: 'EX_light',
        name: 'Photon / light influx',
        subsystem: 'Transport',
        stoichiometry: { light: 1 },
        lowerBound: 0,
        upperBound: 20,
        reversible: false,
        koIds: [],
      },

      // Central Carbon Metabolism (Glycolysis, TCA)
      {
        id: 'HEXOKINASE',
        name: 'Hexokinase (glc -> g6p)',
        subsystem: 'Glycolysis',
        stoichiometry: { glc: -1, atp: -1, g6p: 1, adp: 1 },
        lowerBound: 0,
        upperBound: 10,
        reversible: false,
        koIds: ['K00844'],
      },
      {
        id: 'GLYCOLYSIS_LOWER',
        name: 'Lower Glycolysis (g6p -> 2 pep + atp + nadh)',
        subsystem: 'Glycolysis',
        stoichiometry: { g6p: -1, adp: -1, pep: 2, atp: 1, nadh: 1 },
        lowerBound: 0,
        upperBound: 10,
        reversible: false,
        koIds: ['K00134', 'K01803'],
      },
      {
        id: 'PYR_KINASE',
        name: 'Pyruvate kinase (pep -> pyr + atp)',
        subsystem: 'Glycolysis',
        stoichiometry: { pep: -1, adp: -1, pyr: 1, atp: 1 },
        lowerBound: 0,
        upperBound: 15,
        reversible: false,
        koIds: ['K00873'],
      },
      {
        id: 'TCA_CYCLE',
        name: 'TCA Cycle (pyr -> 3 atp + 2 nadh)',
        subsystem: 'TCA Cycle',
        stoichiometry: { pyr: -1, adp: -3, atp: 3, nadh: 2 },
        lowerBound: 0,
        upperBound: 10,
        reversible: false,
        koIds: ['K00024', 'K00164'],
      },
      {
        id: 'OX_PHOS',
        name: 'Oxidative phosphorylation (nadh + 2 adp + 2 pi -> 2 atp)',
        subsystem: 'Energy Metabolism',
        stoichiometry: { nadh: -1, adp: -2, pi: -2, atp: 2 },
        lowerBound: 0,
        upperBound: 25,
        reversible: false,
        koIds: ['K02111'],
      },

      // Pentose Phosphate Pathway & PRPP synthesis
      {
        id: 'PPP_PRPP',
        name: 'PRPP synthetase (g6p + atp -> prpp + nadph)',
        subsystem: 'Pentose Phosphate',
        stoichiometry: { g6p: -1, atp: -1, prpp: 1, adp: 1, nadph: 1 },
        lowerBound: 0,
        upperBound: 6,
        reversible: false,
        koIds: ['K00948'],
      },

      // Nucleotide biosynthesis baseline
      {
        id: 'NDP_SYNTHESIS',
        name: 'De novo NDP pool synthesis (prpp + atp + pi -> ndp)',
        subsystem: 'Nucleotide Metabolism',
        stoichiometry: { prpp: -1, atp: -2, pi: -1, ndp: 1, adp: 2 },
        lowerBound: 0,
        upperBound: 8,
        reversible: false,
        koIds: ['K00618'],
      },

      // AMG-TARGETED REACTIONS
      // 1. Ribonucleotide reductase (NrdA/NrdB): baseline upper bound 2.5
      {
        id: 'RNR_REDUCTASE',
        name: 'Ribonucleotide diphosphate reductase (ndp + nadph -> dndp)',
        subsystem: 'Nucleotide Metabolism',
        stoichiometry: { ndp: -1, nadph: -1, dndp: 1 },
        lowerBound: 0,
        upperBound: 2.5, // Constrained in host, boosted by phage nrdA/nrdB
        reversible: false,
        koIds: ['K00525', 'K00526'],
      },

      // 2. dUTPase (Dut): baseline upper bound 2.0
      {
        id: 'DUTPASE_REACTION',
        name: 'dUTP pyrophosphatase (dndp -> dump + ppi)',
        subsystem: 'Nucleotide Metabolism',
        stoichiometry: { dndp: -0.5, dump: 0.5, ppi: 0.5 },
        lowerBound: 0,
        upperBound: 2.0, // Constrained in host, boosted by phage dut
        reversible: false,
        koIds: ['K01520'],
      },

      // 3. Thymidylate synthase (ThyA): baseline upper bound 1.8
      {
        id: 'THYMIDYLATE_SYNTHASE',
        name: 'Thymidylate synthase (dump + nadph -> dtmp)',
        subsystem: 'Nucleotide Metabolism',
        stoichiometry: { dump: -1, nadph: -1, dtmp: 1 },
        lowerBound: 0,
        upperBound: 1.8, // Major bottleneck, boosted by phage thyA
        reversible: false,
        koIds: ['K00560'],
      },

      // 4. PhoH phosphate recovery: baseline upper bound 1.5
      {
        id: 'PHOSPHATE_RECOVERY',
        name: 'PhoH phosphate scavenger (ppi + atp -> 2 pi + adp)',
        subsystem: 'Phosphate Metabolism',
        stoichiometry: { ppi: -1, atp: -1, pi: 2, adp: 1 },
        lowerBound: 0,
        upperBound: 1.5, // Boosted by phage phoH under starvation
        reversible: false,
        koIds: ['K06217'],
      },

      // 5. MazG nucleotide pyrophosphatase: baseline upper bound 2.0
      {
        id: 'MAZG_PYROPHOSPHATASE',
        name: 'MazG nucleotide sanitizer (ppi -> 2 pi)',
        subsystem: 'Phosphate Metabolism',
        stoichiometry: { ppi: -1, pi: 2 },
        lowerBound: 0,
        upperBound: 2.0, // Boosted by phage mazG
        reversible: false,
        koIds: ['K05810'],
      },

      // 6. Photosystem II (PsbA/PsbD): baseline upper bound 1.0 (light -> atp + nadph)
      {
        id: 'PSII_ELECTRON_TRANSPORT',
        name: 'Photosystem II electron transport (light + adp + pi -> atp + nadph)',
        subsystem: 'Photosynthesis',
        stoichiometry: { light: -1, adp: -1, pi: -1, atp: 1, nadph: 1 },
        lowerBound: 0,
        upperBound: 1.0, // Strongly boosted by cyanophage psbA/psbD
        reversible: false,
        koIds: ['K02703', 'K02706'],
      },

      // Viral replication precursor assembly (Target Objective)
      {
        id: 'BIOMASS_VIRAL_DNTPS',
        name: 'Viral genome synthesis (dndp + dtmp + atp -> dntp)',
        subsystem: 'Viral Replication',
        stoichiometry: { dndp: -1, dtmp: -0.5, atp: -2, adp: 2, pi: 1, dntp: 1 },
        lowerBound: 0,
        upperBound: 50,
        reversible: false,
        koIds: [],
      },
      {
        id: 'EX_dntp',
        name: 'Viral dNTP sink',
        subsystem: 'Transport',
        stoichiometry: { dntp: -1 },
        lowerBound: 0,
        upperBound: 50,
        reversible: false,
        koIds: [],
      },
    ],
  };
}

/**
 * Floating-point two-phase simplex for bounded steady-state fluxes.
 *
 * Solves: Maximize c^T * v subject to S * v = 0, l_j <= v_j <= u_j
 * Uses 2-Phase Simplex method with upper-bounded variable transformations.
 */
export class FBASimplexSolver {
  constructor(
    private stoichiometricMatrix: number[][],
    private lowerBounds: number[],
    private upperBounds: number[],
    private objective: number[],
    private reactionIds: string[]
  ) {}

  public solve(maxIterations = 5000): {
    optimal: boolean;
    status: FBAStatus;
    objective: number | null;
    fluxes: Record<string, number>;
  } {
    const { stoichiometricMatrix: S, lowerBounds: lb, upperBounds: ub, objective: c, reactionIds: ids } = this;
    const n = lb.length;
    const eps = 1e-9;
    const fail = (status: Exclude<FBAStatus, 'optimal'>) => ({ optimal: false, status, objective: null, fluxes: {} });
    // Finite lower bounds also support reversible reactions. +Infinity is an
    // explicit absent upper bound, never an arithmetic tableau entry.
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 0 ||
        ub.length !== n || c.length !== n || ids.length !== n || new Set(ids).size !== n ||
        ids.some(id => !id) || lb.some(v => !Number.isFinite(v)) ||
        ub.some(v => !Number.isFinite(v) && v !== Infinity) || c.some(v => !Number.isFinite(v)) ||
        S.some(row => row.length !== n || row.some(v => !Number.isFinite(v)))) return fail('invalid_input');
    if (lb.some((v, j) => v > ub[j])) return fail('infeasible');

    const bounded = ub.flatMap((v, j) => Number.isFinite(v) ? [j] : []);
    const artificialStart = n + bounded.length;
    const rhs = artificialStart + S.length;
    let table: number[][] = [new Array(rhs + 1).fill(0)];
    let basis: number[] = [];
    // Shift v=x+lb. Each equality gets an artificial basic variable; its
    // signed RHS is preserved. Row scaling avoids dependence on chosen units.
    S.forEach((coeff, i) => {
      const scale = Math.max(...coeff.map(Math.abs), 0) || 1;
      const normalized = coeff.map(value => value / scale);
      const b = -normalized.reduce((sum, value, j) => sum + value * lb[j], 0);
      const sign = b < 0 ? -1 : 1;
      const row = new Array(rhs + 1).fill(0);
      normalized.forEach((value, j) => { row[j] = sign * value; });
      row[artificialStart + i] = 1;
      row[rhs] = sign * b;
      table.push(row);
      basis.push(artificialStart + i);
    });
    bounded.forEach((j, i) => {
      const row = new Array(rhs + 1).fill(0);
      row[j] = 1;
      row[n + i] = 1;
      row[rhs] = ub[j] - lb[j];
      table.push(row);
      basis.push(n + i);
    });
    let iterations = 0;
    const finiteTable = () => table.every(row => row.every(Number.isFinite));
    const pivot = (r: number, col: number) => {
      const value = table[r][col];
      for (let j = 0; j <= rhs; j++) table[r][j] /= value;
      for (let i = 0; i < table.length; i++) {
        if (i === r) continue;
        const factor = table[i][col];
        for (let j = 0; j <= rhs; j++) table[i][j] -= factor * table[r][j];
        table[i][col] = 0;
      }
      basis[r - 1] = col;
      iterations++;
    };
    const setObjective = (cost: number[]) => {
      table[0] = new Array(rhs + 1).fill(0);
      cost.forEach((value, j) => { table[0][j] = -value; });
      basis.forEach((basic, i) => {
        const factor = cost[basic] ?? 0;
        for (let j = 0; j <= rhs; j++) table[0][j] += factor * table[i + 1][j];
      });
    };
    const optimize = (columns: number): FBAStatus => {
      for (;;) {
        if (!finiteTable() || table.slice(1).some(row => row[rhs] < -eps)) return 'numerical_error';
        // Bland's entering rule and basis-index tie break prevent cycling.
        const enter = table[0].findIndex((value, j) => j < columns && value < -eps);
        if (enter < 0) return 'optimal';
        if (iterations >= maxIterations) return 'iteration_limit';
        let leave = -1;
        let ratio = Infinity;
        for (let i = 1; i < table.length; i++) {
          if (table[i][enter] <= eps) continue;
          const candidate = table[i][rhs] / table[i][enter];
          if (candidate < ratio - eps || (Math.abs(candidate - ratio) <= eps &&
              (leave < 0 || basis[i - 1] < basis[leave - 1]))) {
            ratio = candidate;
            leave = i;
          }
        }
        if (leave < 0) return 'unbounded';
        pivot(leave, enter);
      }
    };

    setObjective(Array.from({ length: rhs }, (_, j) => j >= artificialStart ? -1 : 0));
    const phaseOne = optimize(rhs);
    if (phaseOne !== 'optimal') return fail(phaseOne === 'unbounded' ? 'numerical_error' : phaseOne);
    if (table[0][rhs] < -eps) return fail('infeasible');
    // Artificial variables at zero must leave the basis before phase two.
    // A row with no remaining coefficient is a redundant equality.
    for (let i = basis.length - 1; i >= 0; i--) {
      if (basis[i] < artificialStart) continue;
      const col = table[i + 1].findIndex((v, j) => j < artificialStart && Math.abs(v) > eps);
      if (col >= 0) {
        if (iterations >= maxIterations) return fail('iteration_limit');
        pivot(i + 1, col);
      } else {
        table = table.filter((_, row) => row !== i + 1);
        basis = basis.filter((_, row) => row !== i);
      }
    }
    const objectiveScale = Math.max(...c.map(Math.abs), 0) || 1;
    setObjective(c.map(value => value / objectiveScale));
    const phaseTwo = optimize(artificialStart);
    if (phaseTwo !== 'optimal') return fail(phaseTwo);
    const v = [...lb];
    basis.forEach((basic, i) => { if (basic < n) v[basic] += table[i + 1][rhs]; });
    const tolerance = 1e-7;
    const balanceOK = S.every(row => {
      const terms = row.map((value, j) => value * v[j]);
      return Math.abs(terms.reduce((sum, value) => sum + value, 0)) <=
        tolerance * Math.max(1, terms.reduce((sum, value) => sum + Math.abs(value), 0));
    });
    const boundsOK = v.every((value, j) => Number.isFinite(value) &&
      value >= lb[j] - tolerance * Math.max(1, Math.abs(lb[j])) &&
      (ub[j] === Infinity || value <= ub[j] + tolerance * Math.max(1, Math.abs(ub[j]))));
    const objective = v.reduce((sum, value, j) => sum + c[j] * value, 0);
    const tableauObjective = table[0][rhs] * objectiveScale + lb.reduce((sum, value, j) => sum + c[j] * value, 0);
    if (!balanceOK || !boundsOK || !Number.isFinite(objective) || !Number.isFinite(tableauObjective) ||
        Math.abs(objective - tableauObjective) > tolerance * Math.max(1, Math.abs(objective))) return fail('numerical_error');
    return { optimal: true, status: 'optimal', objective, fluxes: Object.fromEntries(ids.map((id, j) => [id, v[j]])) };
  }
}


/**
 * Solve Flux Balance Analysis on a host model
 */
export function solveFBA(model: HostModelLike): FBAResult {
  const reactions = model.reactions;
  const metabolites = model.metabolites;

  if (!reactions.some(r => r.id === model.objectiveReaction) ||
      new Set(metabolites).size !== metabolites.length ||
      reactions.some(r => Object.keys(r.stoichiometry).some(met => !metabolites.includes(met)))) {
    return { status: 'invalid_input', objectiveValue: null, fluxes: {} };
  }

  const m = metabolites.length;
  const n = reactions.length;

  const metMap = new Map(metabolites.map((name, idx) => [name, idx]));
  const S = Array.from({ length: m }, () => new Array(n).fill(0));

  reactions.forEach((rxn, j) => {
    for (const [met, coeff] of Object.entries(rxn.stoichiometry)) {
      const i = metMap.get(met);
      if (i !== undefined) {
        S[i][j] = coeff;
      }
    }
  });

  const lowerBounds = reactions.map((r) => r.lowerBound);
  const upperBounds = reactions.map((r) => r.upperBound);
  const reactionIds = reactions.map((r) => r.id);

  // Objective vector
  const c = reactions.map((r) => (r.id === model.objectiveReaction ? 1 : 0));

  const solver = new FBASimplexSolver(S, lowerBounds, upperBounds, c, reactionIds);
  const sol = solver.solve();

  if (sol.status !== 'optimal' || sol.objective === null) {
    return { status: sol.status === 'optimal' ? 'numerical_error' : sol.status, objectiveValue: null, fluxes: {} };
  }
  return { status: 'optimal', objectiveValue: sol.objective, fluxes: sol.fluxes };
}

export type HostModelLike = HostMetabolicModel;

/**
 * Scan phage genome for AMGs using gene names, products, and Pfam domains
 */
export function detectAmgsFromPhage(phage?: PhageFull | null): AMGDetection[] {
  if (!phage || !phage.genes || phage.genes.length === 0) {
    return [];
  }

  const detections: AMGDetection[] = [];
  const seenGenes = new Set<number>();

  for (const gene of phage.genes) {
    if (seenGenes.has(gene.id)) continue;

    const name = (gene.name ?? '').toLowerCase();
    const product = (gene.product ?? '').toLowerCase();
    const domains = (gene.domains ?? []).map((d) => d.toUpperCase());

    for (const kb of AMG_KNOWLEDGE_BASE) {
      let matched = false;
      let evidence: 'pfam' | 'product_name' | 'gene_name' = 'gene_name';

      if (kb.pfamId && domains.includes(kb.pfamId)) {
        matched = true;
        evidence = 'pfam';
      } else if (kb.namePattern.test(name)) {
        matched = true;
        evidence = 'gene_name';
      } else if (kb.namePattern.test(product)) {
        matched = true;
        evidence = 'product_name';
      }

      if (matched) {
        seenGenes.add(gene.id);
        detections.push({
          geneId: gene.id,
          geneName: gene.name ?? gene.locusTag ?? 'amg',
          locusTag: gene.locusTag ?? `gene_${gene.id}`,
          start: gene.startPos,
          end: gene.endPos,
          strand: gene.strand ?? '+',
          amgClass: kb.amgClass,
          koMapping: kb.ko,
          evidence,
          boostedReactions: [...kb.reactions],
        });
        break;
      }
    }
  }

  return detections;
}

/**
 * Run Delta-FBA for a single AMG by boosting its associated reactions
 */
export function runDeltaFbaForAmg(
  baseModel: HostMetabolicModel,
  amg: AMGDetection,
  baselineFba: FBAResult,
  boostFactor = 5.0
): DeltaFBAResult | DeltaFBAFailure {
  if (baselineFba.status !== 'optimal') return { amg, status: baselineFba.status };
  if (!Number.isFinite(boostFactor) || boostFactor <= 0) return { amg, status: 'invalid_input' };
  // Create augmented model: multiply upper bounds of AMG-associated reactions
  const augmentedModel: HostMetabolicModel = {
    ...baseModel,
    reactions: baseModel.reactions.map((rxn) => {
      if (amg.boostedReactions.includes(rxn.id)) {
        return {
          ...rxn,
          upperBound: rxn.upperBound * boostFactor,
        };
      }
      return { ...rxn };
    }),
  };

  const augmentedFba = solveFBA(augmentedModel);
  if (augmentedFba.status !== 'optimal') return { amg, status: augmentedFba.status };

  const baselineObj = baselineFba.objectiveValue;
  const augmentedObj = augmentedFba.objectiveValue;
  const deltaObj = augmentedObj - baselineObj;
  const percentGain =
    Math.abs(baselineObj) > 1e-9
      ? Math.round((deltaObj / Math.abs(baselineObj)) * 1000) / 10
      : null;

  // Calculate reaction-level deltas
  const reactionDeltas: ReactionDelta[] = [];
  const subsystemDeltas: Record<string, { total: number; count: number }> = Object.create(null);

  for (const rxn of baseModel.reactions) {
    const baseFlux = baselineFba.fluxes[rxn.id] ?? 0;
    const augFlux = augmentedFba.fluxes[rxn.id] ?? 0;
    const dFlux = Math.round((augFlux - baseFlux) * 1000) / 1000;

    if (Math.abs(dFlux) > 0.005) {
      const pct =
        Math.abs(baseFlux) > 0.01
          ? Math.round((dFlux / Math.abs(baseFlux)) * 100)
          : dFlux > 0
            ? 100
            : 0;

      reactionDeltas.push({
        reactionId: rxn.id,
        reactionName: rxn.name,
        subsystem: rxn.subsystem,
        baselineFlux: baseFlux,
        augmentedFlux: augFlux,
        deltaFlux: dFlux,
        percentChange: pct,
      });

      if (!subsystemDeltas[rxn.subsystem]) {
        subsystemDeltas[rxn.subsystem] = { total: 0, count: 0 };
      }
      subsystemDeltas[rxn.subsystem].total += Math.abs(dFlux);
      subsystemDeltas[rxn.subsystem].count += 1;
    }
  }

  // Sort reactions by absolute flux change
  reactionDeltas.sort((a, b) => Math.abs(b.deltaFlux) - Math.abs(a.deltaFlux));

  const pathwayImpacts: PathwayImpact[] = Object.entries(subsystemDeltas).map(
    ([name, stats]) => ({
      pathwayName: name,
      totalDeltaFlux: Math.round(stats.total * 100) / 100,
      reactionsCount: stats.count,
      significance: stats.total > 5 ? 'high' : stats.total > 1 ? 'medium' : 'low',
    })
  );

  pathwayImpacts.sort((a, b) => b.totalDeltaFlux - a.totalDeltaFlux);

  return {
    status: 'optimal',
    amg,
    baselineObjective: baselineObj,
    augmentedObjective: augmentedObj,
    deltaObjective: Math.round(deltaObj * 1000) / 1000,
    percentGain,
    pathwayImpacts,
    topReactionDeltas: reactionDeltas.slice(0, 8),
  };
}

/**
 * Perform comprehensive AMG Flux Analysis across all AMGs in a phage genome
 */
export function runAMGFluxAnalysis(
  phage?: PhageFull | null,
  options: { boostFactor?: number; hostModel?: HostMetabolicModel } = {}
): AMGFluxAnalysisResult {
  const boost = options.boostFactor ?? 5.0;
  const hostModel = options.hostModel ?? createStandardHostMetabolicModel();
  const detectedAmgs = detectAmgsFromPhage(phage);
  const baselineFba = solveFBA(hostModel);

  const outcomes = detectedAmgs.map((amg) =>
    runDeltaFbaForAmg(hostModel, amg, baselineFba, boost)
  );
  const amgResults = outcomes.filter((result): result is DeltaFBAResult => result.status === 'optimal');
  const failedAmgs = outcomes.filter((result): result is DeltaFBAFailure => result.status !== 'optimal');

  let totalDeltaFlux = 0;
  const subsystemTotals: Record<string, number> = Object.create(null);

  for (const res of amgResults) {
    totalDeltaFlux += res.deltaObjective;
    for (const p of res.pathwayImpacts) {
      subsystemTotals[p.pathwayName] = (subsystemTotals[p.pathwayName] ?? 0) + p.totalDeltaFlux;
    }
  }

  let topSubsystem = 'None';
  let maxFlux = 0;
  for (const [sub, flux] of Object.entries(subsystemTotals)) {
    if (flux > maxFlux) {
      maxFlux = flux;
      topSubsystem = sub;
    }
  }

  const summary =
    baselineFba.status !== 'optimal'
      ? `Flux analysis unavailable: ${baselineFba.status}. No objective gain is reported.`
      : detectedAmgs.length === 0
      ? 'No Auxiliary Metabolic Genes detected in this phage genome.'
      : `Detected ${detectedAmgs.length} AMG(s). Assumed capacity changes in ${hostModel.name} give up to +${Math.max(
          ...amgResults.map((r) => r.percentGain ?? 0),
          0
        )}% model objective flux (${failedAmgs.length} failed solves). This is not a measured fitness gain. Primary impact subsystem: ${topSubsystem}.`;

  return {
    phageId: phage?.id ?? 0,
    phageName: phage?.name ?? 'Unknown',
    detectedAmgs,
    baselineFba,
    amgResults,
    failedAmgs,
    totalDeltaFlux: Math.round(totalDeltaFlux * 1000) / 1000,
    topOverallImpactedSubsystem: topSubsystem,
    summary,
  };
}
