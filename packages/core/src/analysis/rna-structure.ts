/**
 * RNA Structure & Packaging Signal Explorer
 *
 * Exact, bounded maximum-cardinality noncrossing base pairing in local windows.
 * Each base has at most one partner. AU/GC pairs (and optional GU wobble pairs)
 * have unit weight; ambiguous bases cannot pair. The Nussinov-style interval
 * dynamic program returns one optimal structure, not a thermodynamic ensemble.
 * Algorithm family: Nussinov & Jacobson (1980), doi:10.1073/pnas.77.11.6309.
 *
 * pairingScore is minus the number of pairs, with null for no pairs. It has no
 * energy unit. No stacking energies, loop energies, temperature, pseudoknots or
 * kinetic folding are modeled. Synonymous sensitivity measures changes in this
 * mathematical objective; it is not evidence of selection or biological fitness.
 * Candidate regulatory motifs remain hypotheses, without calibrated confidence.
 */
import { CODON_TABLE, reverseComplement } from '../codons';
import { CODON_FAMILIES } from './codon-bias';

export interface RNAWindow {
  start: number;
  end: number;
  sequence: string;
  /** Minus pair count, or null for no pairs; dimensionless, not free energy. */
  pairingScore: number | null;
  gcContent: number;
  pairingDensity: number;
  /** One optimal structure for this window, not a whole-transcript fold. */
  structure: string;
  /** Zero-based, window-relative indices of paired bases (both inclusive). */
  pairs: Array<[number, number]>;
  pairCount: number;
}

export interface SynonymousVariant {
  codon: string;
  aminoAcid: string;
  /** Change in dimensionless pairing score, not thermodynamic energy. */
  deltaG: number;
}
export interface CodonStress {
  position: number;
  /** Exact interval including the reading-frame offset. */
  nucleotideStart?: number;
  nucleotideEnd?: number;
  codon: string;
  aminoAcid: string;
  /** Dimensionless local pairing score. */
  wildTypeDeltaG: number;
  variants: SynonymousVariant[];
  /** Maximum absolute score change, normalized within this input. */
  stress: number;
  stressPercentile: number;
  /** Positive upper-fifth sensitivity by midrank; not biological constraint. */
  isConstrained: boolean;
}
export interface RegulatoryHypothesis {
  start: number;
  end: number;
  type: 'stem-loop' | 'riboswitch' | 'attenuator' | 'packaging-signal' | 'slippery-site' | 'rbs' | 'terminator';
  /** No calibrated probabilities are available for these motif hypotheses. */
  confidence: number | null;
  description: string;
  sequence: string;
  structure?: string;
}
export interface RNAStructureAnalysis {
  method: typeof RNA_PAIRING_METHOD;
  parameters: Required<RNAStructureOptions>;
  coverage: { sequenceBases: number; windows: number; analyzedCodons: number; ambiguousBases: number; dpCandidatesCharged: number };
  windows: RNAWindow[];
  codonStress: CodonStress[];
  highStressRegions: Array<{ start: number; end: number; avgStress: number }>;
  regulatoryHypotheses: RegulatoryHypothesis[];
  /** Mean over windows with pairs; independent windows can overlap. */
  globalPairingScore: number | null;
  avgSynonymousStress: number;
}
export const RNA_STRUCTURE_LIMITS = Object.freeze({
  sequenceBases: 6000,
  foldBases: 240,
  dpCandidates: 100_000_000,
});
export const RNA_PAIRING_METHOD = Object.freeze({
  id: 'rna-maximum-pairing', version: '1',
  implementation: 'Bounded interval dynamic programming with unit pair weights and deterministic noncrossing traceback.',
  objective: 'Maximum number of noncrossing canonical base pairs, with optional GU wobble; one partner per base and a minimum intervening loop length.',
  reference: 'https://doi.org/10.1073/pnas.77.11.6309',
  tieRule: 'Prefer an unpaired right endpoint on ties, then the lowest-index partner.',
  motifMethod: 'Separate sequence-motif and contiguous-stem candidate scans use fixed motif rules, minimum three-base hairpin loops and GU pairing; these are not probabilities or consequences of the window-fold optimum.',
  limitations: 'Unit pair weights; no thermodynamic energy, pseudoknots, ensemble probabilities or experimental validation. Independent windows need not form a compatible whole-transcript structure. Regulatory motifs are uncalibrated candidates. Synonymous substitutions use standard genetic-code table 1 (also valid for the elongation codons of table 11).',
});
export interface RNAFoldOptions { minLoopSize?: number; allowWobble?: boolean }
export interface RNAStructureOptions extends RNAFoldOptions {
  windowSize?: number;
  stepSize?: number;
  frame?: number;
  /** Enable only for a supplied coding region in the declared reading frame. */
  includeSynonymousStress?: boolean;
}
export interface RNAPairingResult {
  sequence: string;
  structure: string;
  pairs: Array<[number, number]>;
  pairCount: number;
  pairingScore: number | null;
  pairingDensity: number;
  minLoopSize: number;
  allowWobble: boolean;
}
interface PairingBudget { charged: number }
const MIN_HAIRPIN_LOOP = 3;

// Known regulatory motifs
const SLIPPERY_SITES = [
  'UUUAAAC', 'UUUAAAU', 'UUUUUUA', 'AAAAAAC', 'AAAUUUU',
  'GGGAAAC', 'UUUAAAG', 'AAAUUUA',
];

const RIBOSWITCH_MOTIFS = [
  'GGCGU', // TPP riboswitch fragment
  'GGGAU', // SAM riboswitch fragment
  'GCGAA', // FMN riboswitch fragment
];

// Shine-Dalgarno patterns
const SD_PATTERNS = [
  { pattern: 'AGGAGG', score: 100 },
  { pattern: 'AGGAG', score: 90 },
  { pattern: 'AGGA', score: 80 },
  { pattern: 'GGAGG', score: 80 },
  { pattern: 'GAGG', score: 70 },
  { pattern: 'AGAG', score: 60 },
  { pattern: 'AGG', score: 50 },
  { pattern: 'GGA', score: 50 },
];

const START_CODONS = ['AUG', 'GUG', 'UUG']; // RNA versions

// ============================================================================
// Helper Functions
// ============================================================================

function dnaToRna(seq: string): string {
  return seq.toUpperCase().replace(/T/g, 'U');
}
function checkedSequence(sequence: string, maximum = RNA_STRUCTURE_LIMITS.sequenceBases): string {
  if (typeof sequence !== 'string' || sequence.length > maximum || !/^[ACGTURYSWKMBDHVN]*$/i.test(sequence)) {
    throw new Error('RNA analysis requires at most ' + maximum + ' IUPAC DNA/RNA bases without gaps or whitespace. Select a shorter interval.');
  }
  return dnaToRna(sequence);
}
function integerOption(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(label + ' must be an integer between ' + min + ' and ' + max + '.');
  }
}
function resolveFoldOptions(options: RNAFoldOptions = {}): Required<RNAFoldOptions> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('RNA pairing options must be an object.');
  const minLoopSize = options.minLoopSize ?? MIN_HAIRPIN_LOOP;
  const allowWobble = options.allowWobble ?? true;
  integerOption(minLoopSize, 0, 30, 'Minimum loop size');
  if (typeof allowWobble !== 'boolean') throw new Error('GU wobble must be explicitly enabled or disabled.');
  return { minLoopSize, allowWobble };
}
export function resolveRNAStructureOptions(options: RNAStructureOptions = {}): Required<RNAStructureOptions> {
  const fold = resolveFoldOptions(options);
  const windowSize = options.windowSize ?? 120;
  const stepSize = options.stepSize ?? 30;
  const frame = options.frame ?? 0;
  const includeSynonymousStress = options.includeSynonymousStress ?? true;
  integerOption(windowSize, 1, RNA_STRUCTURE_LIMITS.foldBases, 'RNA window size');
  integerOption(stepSize, 1, RNA_STRUCTURE_LIMITS.sequenceBases, 'RNA window step');
  integerOption(frame, 0, 2, 'Reading frame');
  if (typeof includeSynonymousStress !== 'boolean') throw new Error('Synonymous analysis must be explicitly enabled or disabled.');
  return { ...fold, windowSize, stepSize, frame, includeSynonymousStress };
}
function canPair(a: string, b: string, allowWobble = true): boolean {
  return (a === 'A' && b === 'U') || (a === 'U' && b === 'A')
    || (a === 'G' && b === 'C') || (a === 'C' && b === 'G')
    || (allowWobble && ((a === 'G' && b === 'U') || (a === 'U' && b === 'G')));
}

/**
 * For [i,j], either leave j unpaired or pair it with k, splitting the remaining
 * positions into disjoint intervals [i,k-1] and [k+1,j-1]. These choices exhaust
 * noncrossing structures and cannot reuse a base. Scores maximize pair count.
 */
function foldPairing(rna: string, options: Required<RNAFoldOptions>, budget: PairingBudget): RNAPairingResult {
  const n = rna.length;
  if (n > RNA_STRUCTURE_LIMITS.foldBases) throw new Error('A single RNA fold is limited to ' + RNA_STRUCTURE_LIMITS.foldBases + ' bases.');
  // Sum over all possible interval/partner candidates, independent of sequence
  // composition: q(q+1)(q+2)/6. Charge before allocating/computing each fold.
  const q = Math.max(0, n - options.minLoopSize - 1);
  const work = q * (q + 1) * (q + 2) / 6;
  if (budget.charged + work > RNA_STRUCTURE_LIMITS.dpCandidates) {
    throw new Error('RNA analysis exceeds the 100,000,000 candidate-work budget. Select a shorter interval, increase the window step, or disable synonymous analysis. No partial result is returned.');
  }
  budget.charged += work;
  const scores = new Uint16Array(n * n);
  const choices = new Int16Array(n * n).fill(-1);
  const compatible = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j - options.minLoopSize; k++) {
      compatible[k * n + j] = canPair(rna[k], rna[j], options.allowWobble) ? 1 : 0;
    }
    for (let i = j - options.minLoopSize - 1; i >= 0; i--) {
      let best = scores[i * n + j - 1];
      let partner = -1;
      for (let k = i; k < j - options.minLoopSize; k++) {
        if (!compatible[k * n + j]) continue;
        const left = k > i ? scores[i * n + k - 1] : 0;
        const inside = k + 1 < j ? scores[(k + 1) * n + j - 1] : 0;
        const score = left + inside + 1;
        if (score > best) { best = score; partner = k; }
      }
      scores[i * n + j] = best;
      choices[i * n + j] = partner;
    }
  }
  const pairs: Array<[number, number]> = [];
  const structure = Array<string>(n).fill('.');
  const pending: Array<[number, number]> = n ? [[0, n - 1]] : [];
  while (pending.length) {
    const [i, j] = pending.pop()!;
    if (i >= j) continue;
    const k = choices[i * n + j];
    if (k < 0) { pending.push([i, j - 1]); continue; }
    pairs.push([k, j]);
    structure[k] = '(';
    structure[j] = ')';
    if (k > i) pending.push([i, k - 1]);
    if (k + 1 < j) pending.push([k + 1, j - 1]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return { sequence: rna, structure: structure.join(''), pairs, pairCount: pairs.length,
    pairingScore: pairs.length ? -pairs.length : null, pairingDensity: n ? 2 * pairs.length / n : 0,
    ...options };
}
export function foldRnaPairing(sequence: string, options: RNAFoldOptions = {}): RNAPairingResult {
  return foldPairing(checkedSequence(sequence, RNA_STRUCTURE_LIMITS.foldBases), resolveFoldOptions(options), { charged: 0 });
}

/**
 * Estimate GC content of a sequence
 */
function gcContent(seq: string): number {
  const upper = seq.toUpperCase();
  let gc = 0;
  let total = 0;
  for (const c of upper) {
    if (c === 'G' || c === 'C') gc++;
    if (c === 'A' || c === 'U' || c === 'G' || c === 'C' || c === 'T') total++;
  }
  return total > 0 ? gc / total : 0;
}

/**
 * Enumerate candidate stems for motif discovery only. Candidates can overlap;
 * they are never summed as a secondary structure or used for pairing scores.
 */
function findStemLoops(rna: string, minStemLength = 4): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const n = rna.length;

  // Scan for hairpin loops
  for (let loopStart = MIN_HAIRPIN_LOOP; loopStart < n - MIN_HAIRPIN_LOOP - minStemLength; loopStart++) {
    for (let loopEnd = loopStart + MIN_HAIRPIN_LOOP; loopEnd < Math.min(loopStart + 12, n); loopEnd++) {
      // Check for stem on both sides of the loop
      let stemLength = 0;
      for (let k = 0; k < 20; k++) {
        const i = loopStart - k - 1;
        const j = loopEnd + k;
        if (i < 0 || j >= n) break;
        if (canPair(rna[i], rna[j])) {
          stemLength++;
        } else {
          break;
        }
      }

      if (stemLength >= minStemLength) {
        // Record pairs
        for (let k = 0; k < stemLength; k++) {
          pairs.push([loopStart - k - 1, loopEnd + k]);
        }
        break; // Found a good hairpin at this position
      }
    }
  }

  return pairs;
}

/** Exact window folds share one budget across the whole analysis. */
function estimatePairing(rna: string, options: Required<RNAFoldOptions>, budget: PairingBudget): RNAPairingResult {
  return foldPairing(rna, options, budget);
}
function computeLocalDeltaG(sequence: string, startNt: number, codon: string,
  options: Required<RNAFoldOptions>, budget: PairingBudget, windowBases = 30): number {
  const contextStart = Math.max(0, startNt - windowBases);
  const contextEnd = Math.min(sequence.length, startNt + 3 + windowBases);
  const context = sequence.slice(contextStart, startNt) + codon + sequence.slice(startNt + 3, contextEnd);
  return estimatePairing(dnaToRna(context), options, budget).pairingScore ?? 0;
}

export function analyzeRNAWindows(sequence: string, windowSize = 120, stepSize = 30,
  options: RNAFoldOptions = {}): RNAWindow[] {
  const parameters = resolveRNAStructureOptions({ ...options, windowSize, stepSize });
  return rnaWindows(checkedSequence(sequence), parameters, { charged: 0 });
}
function rnaWindows(seq: string, options: Required<RNAStructureOptions>, budget: PairingBudget): RNAWindow[] {
  const windows: RNAWindow[] = [];
  const { windowSize, stepSize } = options;
  for (let start = 0; start + windowSize <= seq.length; start += stepSize) {
    const sequence = seq.slice(start, start + windowSize);
    const { pairingScore, pairingDensity, pairs, pairCount, structure } = estimatePairing(sequence, options, budget);
    windows.push({ start, end: start + windowSize, sequence, pairingScore, pairingDensity,
      pairs, pairCount, structure, gcContent: gcContent(sequence) });
  }
  return windows;
}

/** Sensitivity of pair count to synonymous substitutions, not biological fitness. */
export function computeSynonymousStress(codingSequence: string, frame = 0,
  options: RNAFoldOptions = {}): CodonStress[] {
  integerOption(frame, 0, 2, 'Reading frame');
  return synonymousStress(checkedSequence(codingSequence), frame, resolveFoldOptions(options), { charged: 0 });
}
function synonymousStress(rna: string, frame: number, options: Required<RNAFoldOptions>, budget: PairingBudget): CodonStress[] {
  const seq = rna.replace(/U/g, 'T');
  const results: CodonStress[] = [];
  const codonCount = Math.floor((seq.length - frame) / 3);
  const allStress: number[] = [];
  for (let i = 0; i < codonCount; i++) {
    const startNt = frame + i * 3;
    const codon = seq.slice(startNt, startNt + 3);
    const aminoAcid = CODON_TABLE[codon] ?? 'X';
    if (aminoAcid === '*' || aminoAcid === 'X') continue;
    const wildTypeDeltaG = computeLocalDeltaG(seq, startNt, codon, options, budget);
    const variants: SynonymousVariant[] = [];
    for (const altCodon of CODON_FAMILIES[aminoAcid] ?? []) {
      if (altCodon === codon) continue;
      const altScore = computeLocalDeltaG(seq, startNt, altCodon, options, budget);
      variants.push({ codon: altCodon, aminoAcid, deltaG: altScore - wildTypeDeltaG });
    }
    const stress = variants.length ? Math.max(...variants.map(v => Math.abs(v.deltaG))) : 0;
    allStress.push(stress);
    results.push({ position: i, nucleotideStart: startNt, nucleotideEnd: startNt + 3,
      codon, aminoAcid, wildTypeDeltaG, variants, stress, stressPercentile: 0, isConstrained: false });
  }
  const indices = Array.from({ length: allStress.length }, (_, i) => i);
  indices.sort((x, y) => allStress[x] - allStress[y]);
  const maxStress = Math.max(...allStress, 0.01);
  const n = allStress.length;
  for (let first = 0; first < n;) {
    let end = first + 1;
    while (end < n && allStress[indices[end]] === allStress[indices[first]]) end++;
    // Midrank of the tied empirical distribution. All-equal inputs have 0.5.
    const percentile = (first + end) / (2 * n);
    for (let rank = first; rank < end; rank++) {
      const result = results[indices[rank]];
      result.stressPercentile = percentile;
      result.stress /= maxStress;
      result.isConstrained = result.stress > 0 && percentile >= 0.8;
    }
    first = end;
  }
  return results;
}

/** Contiguous sensitive codons only; skipped stops/ambiguities break a region. */
export function findHighStressRegions(stressData: CodonStress[], minLength = 5, minAvgStress = 0.6):
  Array<{ start: number; end: number; avgStress: number }> {
  integerOption(minLength, 1, RNA_STRUCTURE_LIMITS.sequenceBases, 'Minimum sensitive-region length');
  if (!Number.isFinite(minAvgStress) || minAvgStress < 0 || minAvgStress > 1) {
    throw new Error('Minimum average sensitivity must be between zero and one.');
  }
  const regions: Array<{ start: number; end: number; avgStress: number }> = [];
  let regionStart: number | null = null;
  let regionEnd = 0;
  let regionStress: number[] = [];
  const finish = () => {
    if (regionStart !== null && regionStress.length >= minLength) {
      const avgStress = regionStress.reduce((x, y) => x + y, 0) / regionStress.length;
      if (avgStress >= minAvgStress) regions.push({ start: regionStart, end: regionEnd, avgStress });
    }
    regionStart = null;
    regionStress = [];
  };
  for (const current of stressData) {
    const start = current.nucleotideStart ?? current.position * 3;
    const end = current.nucleotideEnd ?? start + 3;
    if (!current.isConstrained || (regionStart !== null && start !== regionEnd)) finish();
    if (!current.isConstrained) continue;
    if (regionStart === null) regionStart = start;
    regionEnd = end;
    regionStress.push(current.stress);
  }
  finish();
  return regions;
}

/**
 * Detect potential regulatory RNA elements
 */
export function detectRegulatoryElements(sequence: string, stressData: CodonStress[],
  options: RNAFoldOptions = {}): RegulatoryHypothesis[] {
  return regulatoryElements(checkedSequence(sequence), stressData, resolveFoldOptions(options), { charged: 0 });
}
function regulatoryElements(rna: string, stressData: CodonStress[], options: Required<RNAFoldOptions>,
  budget: PairingBudget): RegulatoryHypothesis[] {
  const hypotheses: RegulatoryHypothesis[] = [];

  // Check for slippery sites (frameshift signals)
  for (const motif of SLIPPERY_SITES) {
    let pos = 0;
    while ((pos = rna.indexOf(motif, pos)) !== -1) {
      hypotheses.push({
        start: pos,
        end: pos + motif.length,
        type: 'slippery-site',
        // No confidence. This was the constant 0.7 on every hit, which reads as
        // a per-site probability and is not one: the site either matches a
        // known heptamer or it does not, and this scan cannot distinguish a
        // functional frameshift signal from the same seven bases occurring by
        // chance. A match is reported; how much to believe it is not something
        // this code knows.
        confidence: null,
        description: `Potential programmed frameshift: ${motif}`,
        sequence: rna.slice(pos, pos + motif.length),
      });
      pos++;
    }
  }

  // Check for riboswitch-like motifs
  for (const motif of RIBOSWITCH_MOTIFS) {
    let pos = 0;
    while ((pos = rna.indexOf(motif, pos)) !== -1) {
      hypotheses.push({
        start: pos,
        end: Math.min(pos + motif.length + 20, rna.length),
        type: 'riboswitch',
        // Was the constant 0.3 with the comment "Low confidence without full
        // aptamer check". The comment was right and the number was still a
        // fabrication; a real confidence needs the aptamer check.
        confidence: null,
        description: `Potential riboswitch motif fragment`,
        sequence: rna.slice(pos, Math.min(pos + motif.length + 20, rna.length)),
      });
      pos++;
    }
  }

  // Look for strong stem-loops in high-stress regions
  const highStressRegions = findHighStressRegions(stressData);
  for (const region of highStressRegions) {
    const regionSeq = rna.slice(region.start, Math.min(region.end + 60, rna.length));
    const pairs = findStemLoops(regionSeq, 5);

    if (pairs.length >= 5) {
      hypotheses.push({
        start: region.start,
        end: Math.min(region.end + 60, rna.length),
        type: 'attenuator',
        confidence: null,
        description: 'Synonymous-sensitive region with a candidate stem; attenuation function is untested.',
        sequence: regionSeq,
      });
    }
  }

  // Detect packaging signals (high GC, stable structure in terminal regions)
  const terminalWindow = 200;
  const fivePrimeStart = 0;
  const fivePrimeEnd = Math.min(terminalWindow, rna.length);
  const threePrimeStart = Math.max(0, rna.length - terminalWindow);
  const threePrimeEnd = rna.length;

  const terminalRegions: Array<{ start: number; end: number; label: "5'" | "3'" }> = [
    { start: fivePrimeStart, end: fivePrimeEnd, label: "5'" },
  ];
  if (threePrimeStart !== fivePrimeStart) {
    terminalRegions.push({ start: threePrimeStart, end: threePrimeEnd, label: "3'" });
  }

  for (const { start, end, label } of terminalRegions) {
    const region = rna.slice(start, end);
    const gc = gcContent(region);
    const { pairingDensity, pairCount, structure } = estimatePairing(region, options, budget);

    if (gc > 0.5 && pairingDensity > 0.3) {
      hypotheses.push({
        start,
        end,
        type: 'packaging-signal',
        confidence: null,
        description: `GC-rich ${label} end of the supplied interval (GC=${(gc * 100).toFixed(1)}%, ${pairCount} optimal pairs); packaging function is untested.`,
        sequence: region,
        structure,
      });
    }
  }

  // Scored hypotheses first, ordered by confidence; unscored ones after, in
  // discovery order. Sorting nulls as zero would bury exact motif matches
  // beneath weakly-scored guesses.
  return hypotheses.sort((a, b) => {
    if (a.confidence !== null && b.confidence !== null) return b.confidence - a.confidence;
    if (a.confidence !== null) return -1;
    if (b.confidence !== null) return 1;
    return 0;
  });
}

/**
 * Find RBS candidates (Shine-Dalgarno sequences upstream of start codons)
 */
function findRBS(rna: string): RegulatoryHypothesis[] {
  const results: RegulatoryHypothesis[] = [];
  
  for (const startCodon of START_CODONS) {
    let pos = 0;
    while ((pos = rna.indexOf(startCodon, pos)) !== -1) {
      if (pos < 4) {
        pos++;
        continue;
      }

      // Scan -20 to -4 upstream
      const upstreamStart = Math.max(0, pos - 20);
      const upstreamEnd = pos - 4;
      const upstream = rna.slice(upstreamStart, upstreamEnd);

      for (const sd of SD_PATTERNS) {
        const sdPos = upstream.indexOf(sd.pattern);
        if (sdPos !== -1) {
          const rbsStart = upstreamStart + sdPos;
          const spacing = pos - (rbsStart + sd.pattern.length);
          const spacingScore = spacing >= 5 && spacing <= 9 ? 20 : spacing >= 3 && spacing <= 12 ? 10 : 0;
          const totalScore = sd.score + spacingScore;

          if (totalScore >= 60) {
            results.push({
              type: 'rbs',
              start: rbsStart,
              end: pos + 3,
              confidence: null,
              sequence: rna.slice(rbsStart, pos + 3),
              description: `Shine–Dalgarno motif ${sd.pattern}, spacing ${spacing} nt before ${startCodon}; initiation function is untested.`,
            });
            break; 
          }
        }
      }
      pos++;
    }
  }
  return results;
}

/** Stem plus an adjacent uninterrupted U tract; function remains untested. */
function findTerminators(rna: string): RegulatoryHypothesis[] {
  const results: RegulatoryHypothesis[] = [];
  const stems = findStemLoops(rna, 5);
  const pairSet = new Set(stems.map(([i, j]) => i + ':' + j));
  const seen = new Set<string>();
  for (const [start, end] of stems) {
    const key = start + ':' + end;
    if (seen.has(key) || pairSet.has((start - 1) + ':' + (end + 1))) continue;
    seen.add(key);
    let stemLength = 0;
    while (pairSet.has((start + stemLength) + ':' + (end - stemLength))) stemLength++;
    if (stemLength < 5) continue;
    const tract = /^U{4,}/.exec(rna.slice(end + 1))?.[0];
    if (!tract) continue;
    const exclusiveEnd = end + 1 + tract.length;
    results.push({
      type: 'terminator', start, end: exclusiveEnd, confidence: null,
      sequence: rna.slice(start, exclusiveEnd),
      structure: '('.repeat(stemLength) + '.'.repeat(end - start + 1 - 2 * stemLength)
        + ')'.repeat(stemLength) + '.'.repeat(tract.length),
      description: 'Candidate ' + stemLength + '-pair stem followed immediately by ' + tract.length + ' U bases; termination function is untested.',
    });
  }
  return deduplicateHypotheses(results);
}

function deduplicateHypotheses(items: RegulatoryHypothesis[]): RegulatoryHypothesis[] {
  // Different hypotheses may occupy the same bases. A broad paired terminal
  // window must not hide a specific RBS or terminator motif within it.
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.type + ':' + item.start + ':' + item.end;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((x, y) => x.start - y.start || x.end - y.end || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
}

/**
 * Analyze a bounded supplied interval. Window folds are independent; sensitivity
 * is meaningful only for an explicitly supplied coding region and frame.
 */
export function analyzeRNAStructure(sequence: string, options: RNAStructureOptions = {}): RNAStructureAnalysis {
  const parameters = resolveRNAStructureOptions(options);
  const rna = checkedSequence(sequence);
  const budget: PairingBudget = { charged: 0 };
  const windows = rnaWindows(rna, parameters, budget);
  const codonStress = parameters.includeSynonymousStress ? synonymousStress(rna, parameters.frame, parameters, budget) : [];
  const highStressRegions = findHighStressRegions(codonStress);
  const regulatoryHypotheses = deduplicateHypotheses([
    ...regulatoryElements(rna, codonStress, parameters, budget),
    ...findRBS(rna),
    ...findTerminators(rna),
  ]);
  const scored = windows.map(w => w.pairingScore).filter((v): v is number => v !== null);
  const globalPairingScore = scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null;
  const avgSynonymousStress = codonStress.reduce((sum, value) => sum + value.stress, 0) / Math.max(codonStress.length, 1);
  return {
    method: RNA_PAIRING_METHOD, parameters,
    coverage: { sequenceBases: rna.length, windows: windows.length, analyzedCodons: codonStress.length,
      ambiguousBases: (rna.match(/[^ACGU]/g) ?? []).length, dpCandidatesCharged: budget.charged },
    windows, codonStress, highStressRegions, regulatoryHypotheses, globalPairingScore, avgSynonymousStress,
  };
}

/** Coordinates are zero-based and half-open; result coordinates are transcript-relative. */
export function analyzeGeneRNAStructure(genomeSequence: string, geneStart: number, geneEnd: number,
  strand: '+' | '-' = '+'): RNAStructureAnalysis {
  if (typeof genomeSequence !== 'string' || !Number.isSafeInteger(geneStart) || !Number.isSafeInteger(geneEnd)
    || geneStart < 0 || geneEnd < geneStart || geneEnd > genomeSequence.length) {
    throw new Error('Gene interval must be within the supplied genome and use zero-based half-open integer coordinates.');
  }
  if (strand !== '+' && strand !== '-') throw new Error('Gene strand must be + or -.');
  let geneSeq = checkedSequence(genomeSequence.slice(geneStart, geneEnd)).replace(/U/g, 'T');
  if (strand === '-') geneSeq = reverseComplement(geneSeq);
  return analyzeRNAStructure(geneSeq, {
    windowSize: Math.min(120, Math.max(1, geneSeq.length)),
    stepSize: Math.min(30, Math.max(1, Math.floor(geneSeq.length / 10))),
    frame: 0,
  });
}
