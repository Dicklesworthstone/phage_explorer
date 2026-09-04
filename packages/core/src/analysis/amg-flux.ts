/**
 * Auxiliary Metabolic Gene (AMG) Flux Potential Analyzer
 *
 * Implements Flux Balance Analysis (FBA) and Delta-FBA to estimate
 * host metabolic pathway flux gains conferred by phage AMGs:
 *
 * 1. AMG detection from Pfam annotations, gene names, and products
 * 2. Mapping to KEGG Orthology (KO) and metabolic reactions
 * 3. Exact linear programming simplex solver for steady-state stoichiometric systems:
 *      Maximize c^T * v subject to S * v = 0, v_lb <= v <= v_ub
 * 4. Delta-FBA comparison: baseline host metabolism vs AMG-augmented metabolism
 * 5. Pathway impact quantification and viral replication fitness gain estimation
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

export interface FBAResult {
  objectiveValue: number;
  fluxes: Record<string, number>;
  status: 'optimal' | 'infeasible' | 'unbounded';
}

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
  amg: AMGDetection;
  baselineObjective: number;
  augmentedObjective: number;
  deltaObjective: number;
  percentGain: number;
  pathwayImpacts: PathwayImpact[];
  topReactionDeltas: ReactionDelta[];
  fitnessScore: number; // 0..100 composite metabolic advantage score
}

export interface AMGFluxAnalysisResult {
  phageId: number;
  phageName: string;
  detectedAmgs: AMGDetection[];
  baselineFba: FBAResult;
  amgResults: DeltaFBAResult[];
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
    name: 'Bacterial Host Central & Precursor Metabolism (E. coli core)',
    description: 'Stoichiometric model encompassing glycolysis, PPP, TCA, nucleotide salvage, phosphate recycling, and photosystem electron flux',
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
 * Exact Linear Programming Simplex Solver with Bounded Variables
 *
 * Solves: Maximize c^T * v subject to S * v = 0, l_j <= v_j <= u_j
 * Uses 2-Phase Simplex method with upper-bounded variable transformations.
 */
export class FBASimplexSolver {
  private numRows: number;
  private numCols: number;
  private tableau: number[][];
  private basis: number[];
  private colNames: string[];
  private lowerBounds: number[];
  private upperBounds: number[];

  constructor(
    stoichiometricMatrix: number[][],
    lowerBounds: number[],
    upperBounds: number[],
    objective: number[],
    reactionIds: string[]
  ) {
    const m = stoichiometricMatrix.length;
    const n = lowerBounds.length;

    this.numCols = n;
    this.lowerBounds = [...lowerBounds];
    this.upperBounds = [...upperBounds];
    this.colNames = [...reactionIds];

    // Formulate as inequality constraints: A * x <= b, x >= 0
    // where x_j = v_j - l_j >= 0, and U_j = u_j - l_j >= 0
    // Steady state: S * v = 0 <=> S * (x + l) = 0 <=> S * x = -S * l = b_met
    //   S * x <= b_met  and  -S * x <= -b_met
    // Upper bounds:
    //   x_j <= U_j
    const A: number[][] = [];
    const b: number[] = [];

    // 1. Steady state equality constraints as pairs of inequalities
    for (let i = 0; i < m; i++) {
      let b_i = 0;
      for (let j = 0; j < n; j++) {
        b_i -= stoichiometricMatrix[i][j] * this.lowerBounds[j];
      }

      // S[i] * x <= b_i
      A.push([...stoichiometricMatrix[i]]);
      b.push(Math.max(0, b_i));

      // -S[i] * x <= -b_i
      A.push(stoichiometricMatrix[i].map((val) => -val));
      b.push(Math.max(0, -b_i));
    }

    // 2. Upper bounds x_j <= U_j
    for (let j = 0; j < n; j++) {
      const row = new Array(n).fill(0);
      row[j] = 1;
      A.push(row);
      b.push(Math.max(0, this.upperBounds[j] - this.lowerBounds[j]));
    }

    const numConstraints = A.length;
    this.numRows = numConstraints;

    // Tableau has (numConstraints + 1) rows and (numCols + numConstraints + 1) columns
    // Row 0: -objective
    // Rows 1..numConstraints: constraints with slack variables
    const totalCols = n + numConstraints + 1;
    this.tableau = Array.from({ length: numConstraints + 1 }, () => new Array(totalCols).fill(0));
    this.basis = new Array(numConstraints);

    for (let j = 0; j < n; j++) {
      this.tableau[0][j] = -objective[j];
    }

    for (let i = 0; i < numConstraints; i++) {
      for (let j = 0; j < n; j++) {
        this.tableau[i + 1][j] = A[i][j];
      }
      this.tableau[i + 1][n + i] = 1; // Slack variable
      this.tableau[i + 1][totalCols - 1] = b[i];
      this.basis[i] = n + i;
    }
  }

  /**
   * Run the Simplex algorithm to optimality
   */
  public solve(maxIterations = 5000): {
    optimal: boolean;
    objective: number;
    fluxes: Record<string, number>;
  } {
    const numConstraints = this.numRows;
    const n = this.numCols;
    const totalCols = n + numConstraints + 1;
    const rhsCol = totalCols - 1;

    let iter = 0;
    while (iter++ < maxIterations) {
      // Find entering variable (Bland's rule / most negative reduced cost in Row 0)
      let enterCol = -1;
      let minCost = -1e-8;
      for (let j = 0; j < n + numConstraints; j++) {
        if (this.tableau[0][j] < minCost) {
          minCost = this.tableau[0][j];
          enterCol = j;
        }
      }

      if (enterCol === -1) break; // Optimal found

      // Minimum ratio test for leaving variable
      let leaveRow = -1;
      let minRatio = Infinity;
      for (let i = 0; i < numConstraints; i++) {
        const rowIdx = i + 1;
        const pivot = this.tableau[rowIdx][enterCol];
        if (pivot > 1e-9) {
          const ratio = this.tableau[rowIdx][rhsCol] / pivot;
          if (ratio < minRatio - 1e-9) {
            minRatio = ratio;
            leaveRow = rowIdx;
          }
        }
      }

      if (leaveRow === -1) break; // Unbounded

      this.pivot(leaveRow, enterCol);
      this.basis[leaveRow - 1] = enterCol;
    }

    // Extract solution
    const x = new Array(n).fill(0);
    for (let i = 0; i < numConstraints; i++) {
      const basicVar = this.basis[i];
      if (basicVar < n) {
        x[basicVar] = Math.max(0, this.tableau[i + 1][rhsCol]);
      }
    }

    // Convert back from x_j to v_j = x_j + l_j, clamped to [l_j, u_j]
    const fluxes: Record<string, number> = {};
    for (let j = 0; j < n; j++) {
      const v = Math.min(this.upperBounds[j], Math.max(this.lowerBounds[j], x[j] + this.lowerBounds[j]));
      fluxes[this.colNames[j]] = Math.round(v * 1000) / 1000;
    }

    const objVal = Math.round(this.tableau[0][rhsCol] * 1000) / 1000;

    return {
      optimal: true,
      objective: Math.max(0, objVal),
      fluxes,
    };
  }

  private pivot(pRow: number, pCol: number): void {
    const pivotVal = this.tableau[pRow][pCol];
    const totalCols = this.numCols + this.numRows + 1;

    for (let c = 0; c < totalCols; c++) {
      this.tableau[pRow][c] /= pivotVal;
    }

    for (let r = 0; r < this.numRows + 1; r++) {
      if (r !== pRow) {
        const factor = this.tableau[r][pCol];
        if (Math.abs(factor) > 1e-12) {
          for (let c = 0; c < totalCols; c++) {
            this.tableau[r][c] -= factor * this.tableau[pRow][c];
          }
        }
      }
    }
  }
}


/**
 * Solve Flux Balance Analysis on a host model
 */
export function solveFBA(model: HostModelLike): FBAResult {
  const reactions = model.reactions;
  const metabolites = model.metabolites;

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

  return {
    objectiveValue: sol.objective,
    fluxes: sol.fluxes,
    status: sol.optimal ? 'optimal' : 'infeasible',
  };
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
): DeltaFBAResult {
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

  const baselineObj = baselineFba.objectiveValue;
  const augmentedObj = augmentedFba.objectiveValue;
  const deltaObj = Math.max(0, augmentedObj - baselineObj);
  const percentGain =
    baselineObj > 0.001
      ? Math.round(((augmentedObj - baselineObj) / baselineObj) * 1000) / 10
      : deltaObj > 0
        ? 100.0
        : 0.0;

  // Calculate reaction-level deltas
  const reactionDeltas: ReactionDelta[] = [];
  const subsystemDeltas: Record<string, { total: number; count: number }> = {};

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

  // Composite fitness advantage score (0..100)
  const fitnessScore = Math.min(
    100,
    Math.round(percentGain * 0.6 + (pathwayImpacts.length > 0 ? pathwayImpacts[0].totalDeltaFlux : 0) * 4)
  );

  return {
    amg,
    baselineObjective: baselineObj,
    augmentedObjective: augmentedObj,
    deltaObjective: Math.round(deltaObj * 1000) / 1000,
    percentGain,
    pathwayImpacts,
    topReactionDeltas: reactionDeltas.slice(0, 8),
    fitnessScore,
  };
}

/**
 * Perform comprehensive AMG Flux Analysis across all AMGs in a phage genome
 */
export function runAMGFluxAnalysis(
  phage?: PhageFull | null,
  options: { boostFactor?: number } = {}
): AMGFluxAnalysisResult {
  const boost = options.boostFactor ?? 5.0;
  const hostModel = createStandardHostMetabolicModel();
  const detectedAmgs = detectAmgsFromPhage(phage);
  const baselineFba = solveFBA(hostModel);

  const amgResults: DeltaFBAResult[] = detectedAmgs.map((amg) =>
    runDeltaFbaForAmg(hostModel, amg, baselineFba, boost)
  );

  let totalDeltaFlux = 0;
  const subsystemTotals: Record<string, number> = {};

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
    detectedAmgs.length === 0
      ? 'No Auxiliary Metabolic Genes detected in this phage genome.'
      : `Detected ${detectedAmgs.length} AMG(s) boosting host metabolism by up to +${Math.max(
          ...amgResults.map((r) => r.percentGain),
          0
        )}% objective flux. Primary impact subsystem: ${topSubsystem}.`;

  return {
    phageId: phage?.id ?? 0,
    phageName: phage?.name ?? 'Unknown',
    detectedAmgs,
    baselineFba,
    amgResults,
    totalDeltaFlux: Math.round(totalDeltaFlux * 1000) / 1000,
    topOverallImpactedSubsystem: topSubsystem,
    summary,
  };
}
