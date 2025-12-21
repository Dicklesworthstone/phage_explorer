/**
 * Epistasis & Fitness Landscape Explorer
 *
 * Analyzes pairwise epistasis for phage proteins using BLOSUM62-based
 * pseudo-likelihood scoring. Identifies robust vs fragile regions and
 * potential escape mutation routes.
 *
 * Key concepts:
 * - ΔG (single mutant fitness): How deleterious is a single mutation?
 * - ε (epistasis): Does the double mutant behave as expected from singles?
 *   - ε > 0: Antagonistic (compensatory) - double better than expected
 *   - ε < 0: Synergistic - double worse than expected
 *   - ε ≈ 0: Additive - no interaction
 */

import type { GeneInfo } from '../types';

// ============================================================================
// BLOSUM62 Substitution Matrix
// ============================================================================

/**
 * BLOSUM62 matrix values (symmetric)
 * Standard amino acid order: A R N D C Q E G H I L K M F P S T W Y V
 */
const AMINO_ACIDS = 'ARNDCQEGHILKMFPSTWYV';

// BLOSUM62 matrix as flat array (20x20 = 400 entries)
// prettier-ignore
const BLOSUM62_FLAT: readonly number[] = [
//  A  R  N  D  C  Q  E  G  H  I  L  K  M  F  P  S  T  W  Y  V
    4,-1,-2,-2, 0,-1,-1, 0,-2,-1,-1,-1,-1,-2,-1, 1, 0,-3,-2, 0, // A
   -1, 5, 0,-2,-3, 1, 0,-2, 0,-3,-2, 2,-1,-3,-2,-1,-1,-3,-2,-3, // R
   -2, 0, 6, 1,-3, 0, 0, 0, 1,-3,-3, 0,-2,-3,-2, 1, 0,-4,-2,-3, // N
   -2,-2, 1, 6,-3, 0, 2,-1,-1,-3,-4,-1,-3,-3,-1, 0,-1,-4,-3,-3, // D
    0,-3,-3,-3, 9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1, // C
   -1, 1, 0, 0,-3, 5, 2,-2, 0,-3,-2, 1, 0,-3,-1, 0,-1,-2,-1,-2, // Q
   -1, 0, 0, 2,-4, 2, 5,-2, 0,-3,-3, 1,-2,-3,-1, 0,-1,-3,-2,-2, // E
    0,-2, 0,-1,-3,-2,-2, 6,-2,-4,-4,-2,-3,-3,-2, 0,-2,-2,-3,-3, // G
   -2, 0, 1,-1,-3, 0, 0,-2, 8,-3,-3,-1,-2,-1,-2,-1,-2,-2, 2,-3, // H
   -1,-3,-3,-3,-1,-3,-3,-4,-3, 4, 2,-3, 1, 0,-3,-2,-1,-3,-1, 3, // I
   -1,-2,-3,-4,-1,-2,-3,-4,-3, 2, 4,-2, 2, 0,-3,-2,-1,-2,-1, 1, // L
   -1, 2, 0,-1,-3, 1, 1,-2,-1,-3,-2, 5,-1,-3,-1, 0,-1,-3,-2,-2, // K
   -1,-1,-2,-3,-1, 0,-2,-3,-2, 1, 2,-1, 5, 0,-2,-1,-1,-1,-1, 1, // M
   -2,-3,-3,-3,-2,-3,-3,-3,-1, 0, 0,-3, 0, 6,-4,-2,-2, 1, 3,-1, // F
   -1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-4, 7,-1,-1,-4,-3,-2, // P
    1,-1, 1, 0,-1, 0, 0, 0,-1,-2,-2, 0,-1,-2,-1, 4, 1,-3,-2,-2, // S
    0,-1, 0,-1,-1,-1,-1,-2,-2,-1,-1,-1,-1,-2,-1, 1, 5,-2,-2, 0, // T
   -3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1, 1,-4,-3,-2,11, 2,-3, // W
   -2,-2,-2,-3,-2,-1,-2,-3, 2,-1,-1,-2,-1, 3,-3,-2,-2, 2, 7,-1, // Y
    0,-3,-3,-3,-1,-2,-2,-3,-3, 3, 1,-2, 1,-1,-2,-2, 0,-3,-1, 4, // V
] as const;

/**
 * Get BLOSUM62 score for amino acid substitution
 */
export function getBlosum62Score(aa1: string, aa2: string): number {
  const i = AMINO_ACIDS.indexOf(aa1.toUpperCase());
  const j = AMINO_ACIDS.indexOf(aa2.toUpperCase());
  if (i < 0 || j < 0) return -4; // Unknown amino acid penalty
  return BLOSUM62_FLAT[i * 20 + j];
}

// ============================================================================
// Types
// ============================================================================

export type EpistasisType = 'synergistic' | 'antagonistic' | 'additive';
export type RegionType = 'robust' | 'fragile' | 'neutral';

export interface SingleMutantEffect {
  position: number;
  wildType: string;
  mutant: string;
  deltaFitness: number; // ΔG approximation (negative = deleterious)
  uncertainty: number; // Confidence interval
  structuralContext: 'core' | 'surface' | 'interface' | 'unknown';
}

export interface EpistasisPair {
  pos1: number;
  pos2: number;
  aa1_wt: string;
  aa2_wt: string;
  aa1_mut: string;
  aa2_mut: string;
  singleEffect1: number; // ΔG for pos1 mutation alone
  singleEffect2: number; // ΔG for pos2 mutation alone
  doubleEffect: number; // ΔG for both mutations
  epistasisScore: number; // ε = ΔΔG
  type: EpistasisType;
  significance: number; // p-value proxy (0-1, lower = more significant)
}

export interface FitnessRegion {
  start: number;
  end: number;
  type: RegionType;
  averageFitness: number;
  mutationalTolerance: number; // Fraction of tolerated mutations
  conservationScore: number; // Position-wise conservation
}

export interface EscapeRoute {
  mutations: Array<{ position: number; from: string; to: string }>;
  fitnessGain: number;
  escapeProbability: number;
  pathDescription: string;
}

export interface PositionFrequencies {
  position: number;
  frequencies: Record<string, number>; // amino acid -> frequency
  entropy: number;
  consensus: string;
}

export interface FitnessLandscape {
  proteinName: string;
  proteinSequence: string;
  singleMutants: SingleMutantEffect[];
  epistasisPairs: EpistasisPair[];
  robustRegions: FitnessRegion[];
  fragileRegions: FitnessRegion[];
  escapeRoutes: EscapeRoute[];
  positionFrequencies: PositionFrequencies[];
  averageFitness: number;
  fitnessVariance: number;
}

// ============================================================================
// Pseudo-Likelihood Fitness Scoring
// ============================================================================

/**
 * Compute pseudo-likelihood fitness delta for a single mutation
 * Uses BLOSUM62 as evolutionary constraint proxy
 *
 * ΔG ≈ -log(P(mut)) + log(P(wt)) ≈ BLOSUM62(wt, mut) - BLOSUM62(wt, wt)
 *
 * Negative values = deleterious mutation
 * Positive values = potentially beneficial (rare)
 */
export function computeSingleMutantFitness(
  wildType: string,
  mutant: string,
  neighborContext?: string[] // Flanking amino acids for context
): number {
  // Base BLOSUM62 score
  const wtScore = getBlosum62Score(wildType, wildType); // Self-score (typically 4-11)
  const mutScore = getBlosum62Score(wildType, mutant);

  // ΔG approximation: difference from wild-type self-score
  let deltaG = mutScore - wtScore;

  // Apply neighbor context bonus/penalty
  if (neighborContext && neighborContext.length >= 2) {
    const [left, right] = neighborContext;
    // Favor mutations that maintain similar chemical properties as neighbors
    const wtLeftScore = getBlosum62Score(wildType, left);
    const mutLeftScore = getBlosum62Score(mutant, left);
    const wtRightScore = getBlosum62Score(wildType, right);
    const mutRightScore = getBlosum62Score(mutant, right);

    // Context adjustment (small effect)
    const contextDelta =
      (mutLeftScore - wtLeftScore + mutRightScore - wtRightScore) * 0.1;
    deltaG += contextDelta;
  }

  return deltaG;
}

/**
 * Predict fitness effects for all possible single mutants at all positions
 */
export function predictSingleMutants(
  sequence: string,
  options: { maxPositions?: number } = {}
): SingleMutantEffect[] {
  const maxPos = options.maxPositions ?? sequence.length;
  const results: SingleMutantEffect[] = [];

  for (let i = 0; i < Math.min(sequence.length, maxPos); i++) {
    const wt = sequence[i];
    if (!AMINO_ACIDS.includes(wt)) continue;

    const left = i > 0 ? sequence[i - 1] : '';
    const right = i < sequence.length - 1 ? sequence[i + 1] : '';
    const context = left && right ? [left, right] : undefined;

    for (const mut of AMINO_ACIDS) {
      if (mut === wt) continue;

      const deltaFitness = computeSingleMutantFitness(wt, mut, context);

      results.push({
        position: i,
        wildType: wt,
        mutant: mut,
        deltaFitness,
        uncertainty: Math.abs(deltaFitness) * 0.2, // Rough uncertainty estimate
        structuralContext: 'unknown',
      });
    }
  }

  return results;
}

// ============================================================================
// Direct Information (Coupling Detection)
// ============================================================================

/**
 * Compute position-wise amino acid frequencies from an alignment
 * For single sequence, uses pseudo-counts from BLOSUM62 background
 */
export function computePositionFrequencies(
  sequences: string[],
  pseudoCount: number = 0.1
): PositionFrequencies[] {
  if (sequences.length === 0) return [];

  const seqLen = sequences[0].length;
  const results: PositionFrequencies[] = [];

  // BLOSUM62 background frequencies (Robinson-Robinson)
  const bgFreq: Record<string, number> = {
    A: 0.0787, R: 0.0512, N: 0.0406, D: 0.0546, C: 0.0137,
    Q: 0.0393, E: 0.0672, G: 0.0706, H: 0.0227, I: 0.0593,
    L: 0.0966, K: 0.0584, M: 0.0238, F: 0.0386, P: 0.047,
    S: 0.0657, T: 0.0535, W: 0.0108, Y: 0.0298, V: 0.0687,
  };

  for (let pos = 0; pos < seqLen; pos++) {
    const counts: Record<string, number> = {};

    // Initialize with pseudo-counts
    for (const aa of AMINO_ACIDS) {
      counts[aa] = pseudoCount * bgFreq[aa];
    }

    // Count observed amino acids
    for (const seq of sequences) {
      if (pos < seq.length) {
        const aa = seq[pos].toUpperCase();
        if (AMINO_ACIDS.includes(aa)) {
          counts[aa] = (counts[aa] || 0) + 1;
        }
      }
    }

    // Normalize to frequencies
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const frequencies: Record<string, number> = {};
    for (const aa of AMINO_ACIDS) {
      frequencies[aa] = counts[aa] / total;
    }

    // Compute entropy
    let entropy = 0;
    for (const freq of Object.values(frequencies)) {
      if (freq > 0) {
        entropy -= freq * Math.log2(freq);
      }
    }

    // Find consensus
    let maxFreq = 0;
    let consensus = 'X';
    for (const [aa, freq] of Object.entries(frequencies)) {
      if (freq > maxFreq) {
        maxFreq = freq;
        consensus = aa;
      }
    }

    results.push({ position: pos, frequencies, entropy, consensus });
  }

  return results;
}

/**
 * Compute Direct Information between two positions
 * Uses mutual information with average product correction (APC)
 */
export function computeDirectInfo(
  posFreqs: PositionFrequencies[],
  pos1: number,
  pos2: number,
  sequences: string[]
): number {
  if (pos1 >= posFreqs.length || pos2 >= posFreqs.length) return 0;

  const f1 = posFreqs[pos1].frequencies;
  const f2 = posFreqs[pos2].frequencies;

  // Compute joint frequencies
  const joint: Record<string, number> = {};
  for (const seq of sequences) {
    if (pos1 < seq.length && pos2 < seq.length) {
      const aa1 = seq[pos1].toUpperCase();
      const aa2 = seq[pos2].toUpperCase();
      if (AMINO_ACIDS.includes(aa1) && AMINO_ACIDS.includes(aa2)) {
        const key = `${aa1}${aa2}`;
        joint[key] = (joint[key] || 0) + 1;
      }
    }
  }

  // Normalize joint frequencies
  const total = Object.values(joint).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(joint)) {
    joint[key] /= total;
  }

  // Compute mutual information
  let mi = 0;
  for (const [key, pij] of Object.entries(joint)) {
    if (pij > 0) {
      const aa1 = key[0];
      const aa2 = key[1];
      const pi = f1[aa1] || 0.0001;
      const pj = f2[aa2] || 0.0001;
      mi += pij * Math.log2(pij / (pi * pj));
    }
  }

  return Math.max(0, mi);
}

// ============================================================================
// Epistasis Calculation
// ============================================================================

/**
 * Compute epistasis score (ε) for a pair of positions
 *
 * ε = ΔΔG = G_double - (G_single1 + G_single2) + G_wt
 *
 * Positive ε: Antagonistic (compensatory) - double mutant better than expected
 * Negative ε: Synergistic - double mutant worse than expected
 * Near zero: Additive - no interaction
 */
export function computeEpistasis(
  sequence: string,
  pos1: number,
  pos2: number,
  mut1: string,
  mut2: string
): EpistasisPair {
  const wt1 = sequence[pos1];
  const wt2 = sequence[pos2];

  // Get context for each position
  const context1 = [
    pos1 > 0 ? sequence[pos1 - 1] : '',
    pos1 < sequence.length - 1 ? sequence[pos1 + 1] : '',
  ].filter(Boolean);

  const context2 = [
    pos2 > 0 ? sequence[pos2 - 1] : '',
    pos2 < sequence.length - 1 ? sequence[pos2 + 1] : '',
  ].filter(Boolean);

  // Single mutant effects
  const singleEffect1 = computeSingleMutantFitness(
    wt1,
    mut1,
    context1.length === 2 ? context1 : undefined
  );
  const singleEffect2 = computeSingleMutantFitness(
    wt2,
    mut2,
    context2.length === 2 ? context2 : undefined
  );

  // Double mutant effect (including interaction between mutations)
  // The interaction term captures non-additive effects
  const baseDouble = singleEffect1 + singleEffect2;

  // Interaction term based on distance and chemical similarity
  const distance = Math.abs(pos2 - pos1);
  let interaction = 0;

  if (distance < 5) {
    // Close positions: strong coupling possible
    const mutMutScore = getBlosum62Score(mut1, mut2);
    const wtWtScore = getBlosum62Score(wt1, wt2);
    interaction = (mutMutScore - wtWtScore) * 0.3;
  } else if (distance < 15) {
    // Moderate distance: weaker coupling
    const mutMutScore = getBlosum62Score(mut1, mut2);
    const wtWtScore = getBlosum62Score(wt1, wt2);
    interaction = (mutMutScore - wtWtScore) * 0.1;
  }
  // Distant positions: assume additive

  const doubleEffect = baseDouble + interaction;

  // Epistasis score: deviation from additivity
  const epistasisScore = doubleEffect - (singleEffect1 + singleEffect2);

  // Classify epistasis type
  let type: EpistasisType;
  if (epistasisScore > 0.5) {
    type = 'antagonistic';
  } else if (epistasisScore < -0.5) {
    type = 'synergistic';
  } else {
    type = 'additive';
  }

  // Significance (lower = more significant)
  // Based on magnitude of epistasis relative to single effects
  const avgSingle = (Math.abs(singleEffect1) + Math.abs(singleEffect2)) / 2;
  const significance =
    avgSingle > 0
      ? Math.exp(-Math.abs(epistasisScore) / avgSingle)
      : Math.exp(-Math.abs(epistasisScore));

  return {
    pos1,
    pos2,
    aa1_wt: wt1,
    aa2_wt: wt2,
    aa1_mut: mut1,
    aa2_mut: mut2,
    singleEffect1,
    singleEffect2,
    doubleEffect,
    epistasisScore,
    type,
    significance,
  };
}

/**
 * Compute epistasis for position pairs with high direct information
 */
export function computeEpistasisNetwork(
  sequence: string,
  posFreqs: PositionFrequencies[],
  sequences: string[],
  options: {
    topPairs?: number;
    diThreshold?: number;
  } = {}
): EpistasisPair[] {
  const topPairs = options.topPairs ?? 50;
  const diThreshold = options.diThreshold ?? 0.1;

  // Find pairs with high direct information
  const pairs: Array<{ pos1: number; pos2: number; di: number }> = [];

  for (let i = 0; i < posFreqs.length - 1; i++) {
    for (let j = i + 1; j < posFreqs.length; j++) {
      const di = computeDirectInfo(posFreqs, i, j, sequences);
      if (di > diThreshold) {
        pairs.push({ pos1: i, pos2: j, di });
      }
    }
  }

  // Sort by DI and take top pairs
  pairs.sort((a, b) => b.di - a.di);
  const topDIPairs = pairs.slice(0, topPairs);

  // Compute epistasis for each pair
  // For each pair, test the most disruptive mutations
  const results: EpistasisPair[] = [];

  for (const { pos1, pos2 } of topDIPairs) {
    const wt1 = sequence[pos1];
    const wt2 = sequence[pos2];

    // Find most disruptive mutation at each position
    let worstMut1 = 'A';
    let worstScore1 = 0;
    let worstMut2 = 'A';
    let worstScore2 = 0;

    for (const aa of AMINO_ACIDS) {
      if (aa !== wt1) {
        const score = computeSingleMutantFitness(wt1, aa);
        if (score < worstScore1) {
          worstScore1 = score;
          worstMut1 = aa;
        }
      }
      if (aa !== wt2) {
        const score = computeSingleMutantFitness(wt2, aa);
        if (score < worstScore2) {
          worstScore2 = score;
          worstMut2 = aa;
        }
      }
    }

    const epistasis = computeEpistasis(sequence, pos1, pos2, worstMut1, worstMut2);
    results.push(epistasis);
  }

  return results;
}

// ============================================================================
// Region Analysis
// ============================================================================

/**
 * Identify robust vs fragile regions based on mutational tolerance
 */
export function identifyRegions(
  singleMutants: SingleMutantEffect[],
  windowSize: number = 10
): FitnessRegion[] {
  if (singleMutants.length === 0) return [];

  // Group by position
  const byPosition = new Map<number, SingleMutantEffect[]>();
  for (const m of singleMutants) {
    const list = byPosition.get(m.position) || [];
    list.push(m);
    byPosition.set(m.position, list);
  }

  // Compute average fitness per position
  const positions = Array.from(byPosition.keys()).sort((a, b) => a - b);
  const positionScores = new Map<number, number>();
  const positionTolerance = new Map<number, number>();

  for (const pos of positions) {
    const mutants = byPosition.get(pos) || [];
    const avgFitness = mutants.reduce((s, m) => s + m.deltaFitness, 0) / mutants.length;
    const toleratedCount = mutants.filter((m) => m.deltaFitness > -2).length;
    const tolerance = toleratedCount / mutants.length;

    positionScores.set(pos, avgFitness);
    positionTolerance.set(pos, tolerance);
  }

  // Sliding window to identify regions
  const regions: FitnessRegion[] = [];
  let currentRegion: {
    start: number;
    positions: number[];
    scores: number[];
    tolerances: number[];
  } | null = null;

  for (let i = 0; i < positions.length; i += windowSize / 2) {
    const windowPositions = positions.slice(i, i + windowSize);
    if (windowPositions.length < 3) continue;

    const windowScores = windowPositions.map((p) => positionScores.get(p) || 0);
    const windowTolerances = windowPositions.map((p) => positionTolerance.get(p) || 0);

    const avgScore = windowScores.reduce((a, b) => a + b, 0) / windowScores.length;
    const avgTolerance = windowTolerances.reduce((a, b) => a + b, 0) / windowTolerances.length;

    // Classify region type
    let type: RegionType;
    if (avgTolerance > 0.6 && avgScore > -3) {
      type = 'robust';
    } else if (avgTolerance < 0.3 || avgScore < -5) {
      type = 'fragile';
    } else {
      type = 'neutral';
    }

    // Merge with previous region if same type
    if (currentRegion && regions.length > 0 && regions[regions.length - 1].type === type) {
      const lastRegion = regions[regions.length - 1];
      lastRegion.end = windowPositions[windowPositions.length - 1];
      lastRegion.averageFitness =
        (lastRegion.averageFitness + avgScore) / 2;
      lastRegion.mutationalTolerance =
        (lastRegion.mutationalTolerance + avgTolerance) / 2;
    } else {
      regions.push({
        start: windowPositions[0],
        end: windowPositions[windowPositions.length - 1],
        type,
        averageFitness: avgScore,
        mutationalTolerance: avgTolerance,
        conservationScore: 1 - avgTolerance, // Inverse relationship
      });
    }
  }

  return regions;
}

// ============================================================================
// Escape Route Detection
// ============================================================================

/**
 * Find potential escape routes (compensatory mutation pairs)
 */
export function findEscapeRoutes(
  epistasisPairs: EpistasisPair[],
  singleMutants: SingleMutantEffect[],
  topN: number = 10
): EscapeRoute[] {
  // Find antagonistic pairs (compensatory)
  const compensatory = epistasisPairs.filter((p) => p.type === 'antagonistic');

  // Also find pairs where each single is deleterious but double is neutral/beneficial
  const escapeCandidates = compensatory.filter(
    (p) =>
      p.singleEffect1 < -1 &&
      p.singleEffect2 < -1 &&
      p.doubleEffect > p.singleEffect1 + p.singleEffect2 + 0.5
  );

  // Sort by fitness gain
  escapeCandidates.sort((a, b) => b.epistasisScore - a.epistasisScore);

  return escapeCandidates.slice(0, topN).map((pair) => {
    const fitnessGain = pair.epistasisScore;
    const escapeProbability = Math.min(
      1,
      Math.exp(pair.epistasisScore / 2) /
        (1 + Math.exp(pair.epistasisScore / 2))
    );

    return {
      mutations: [
        { position: pair.pos1, from: pair.aa1_wt, to: pair.aa1_mut },
        { position: pair.pos2, from: pair.aa2_wt, to: pair.aa2_mut },
      ],
      fitnessGain,
      escapeProbability,
      pathDescription: `${pair.aa1_wt}${pair.pos1 + 1}${pair.aa1_mut} + ${pair.aa2_wt}${pair.pos2 + 1}${pair.aa2_mut} (ε = ${fitnessGain.toFixed(2)})`,
    };
  });
}

// ============================================================================
// Main Analysis Entry Point
// ============================================================================

export type ProteinType = 'capsid' | 'tail_fiber' | 'portal' | 'polymerase' | 'other';

/**
 * Identify protein type from gene product annotation
 */
export function classifyProteinType(gene: GeneInfo): ProteinType {
  const product = (gene.product || '').toLowerCase();
  const name = (gene.gene || '').toLowerCase();
  const combined = `${product} ${name}`;

  if (/capsid|coat|mcp|major\s*capsid|head/i.test(combined)) {
    return 'capsid';
  }
  if (/tail\s*fiber|tailspike|receptor.*binding|tsp|fiber/i.test(combined)) {
    return 'tail_fiber';
  }
  if (/portal|connector/i.test(combined)) {
    return 'portal';
  }
  if (/polymerase|dnap|rnap|replicase/i.test(combined)) {
    return 'polymerase';
  }
  return 'other';
}

/**
 * Analyze fitness landscape for a protein sequence
 */
export function analyzeFitnessLandscape(
  proteinName: string,
  proteinSequence: string,
  options: {
    sequences?: string[]; // For computing position frequencies from alignment
    maxPositions?: number;
    topEpistasisPairs?: number;
  } = {}
): FitnessLandscape {
  const sequences = options.sequences || [proteinSequence];
  const maxPos = options.maxPositions ?? Math.min(proteinSequence.length, 200);

  // Limit sequence for analysis
  const seq = proteinSequence.slice(0, maxPos);

  // Compute single mutant effects
  const singleMutants = predictSingleMutants(seq, { maxPositions: maxPos });

  // Compute position frequencies
  const posFreqs = computePositionFrequencies(
    sequences.map((s) => s.slice(0, maxPos))
  );

  // Compute epistasis network
  const epistasisPairs = computeEpistasisNetwork(seq, posFreqs, sequences, {
    topPairs: options.topEpistasisPairs ?? 50,
  });

  // Identify regions
  const allRegions = identifyRegions(singleMutants);
  const robustRegions = allRegions.filter((r) => r.type === 'robust');
  const fragileRegions = allRegions.filter((r) => r.type === 'fragile');

  // Find escape routes
  const escapeRoutes = findEscapeRoutes(epistasisPairs, singleMutants);

  // Compute overall statistics
  const avgFitness =
    singleMutants.reduce((s, m) => s + m.deltaFitness, 0) / singleMutants.length;
  const fitnessVariance =
    singleMutants.reduce((s, m) => s + Math.pow(m.deltaFitness - avgFitness, 2), 0) /
    singleMutants.length;

  return {
    proteinName,
    proteinSequence: seq,
    singleMutants,
    epistasisPairs,
    robustRegions,
    fragileRegions,
    escapeRoutes,
    positionFrequencies: posFreqs,
    averageFitness,
    fitnessVariance,
  };
}

// ============================================================================
// Rendering Helpers
// ============================================================================

const BLOCK_CHARS = [' ', '░', '▒', '▓', '█'];

/**
 * Render a simple ASCII heatmap of epistasis scores
 */
export function renderEpistasisHeatmap(
  pairs: EpistasisPair[],
  width: number = 40
): string {
  if (pairs.length === 0) return 'No epistasis pairs computed';

  // Find position range
  const allPos = pairs.flatMap((p) => [p.pos1, p.pos2]);
  const minPos = Math.min(...allPos);
  const maxPos = Math.max(...allPos);
  const range = maxPos - minPos + 1;

  // Create grid
  const scale = Math.ceil(range / width);
  const gridSize = Math.ceil(range / scale);
  const grid: number[][] = Array(gridSize)
    .fill(null)
    .map(() => Array(gridSize).fill(0));

  // Fill grid with epistasis scores
  for (const pair of pairs) {
    const x = Math.floor((pair.pos1 - minPos) / scale);
    const y = Math.floor((pair.pos2 - minPos) / scale);
    if (x < gridSize && y < gridSize) {
      grid[y][x] = Math.max(grid[y][x], Math.abs(pair.epistasisScore));
      grid[x][y] = Math.max(grid[x][y], Math.abs(pair.epistasisScore));
    }
  }

  // Find max for normalization
  const maxVal = Math.max(...grid.flat());

  // Render as ASCII
  const lines: string[] = [];
  for (let y = 0; y < gridSize; y++) {
    let line = '';
    for (let x = 0; x < gridSize; x++) {
      const normalized = maxVal > 0 ? grid[y][x] / maxVal : 0;
      const charIdx = Math.min(4, Math.floor(normalized * 5));
      line += BLOCK_CHARS[charIdx];
    }
    lines.push(line);
  }

  return lines.join('\n');
}
