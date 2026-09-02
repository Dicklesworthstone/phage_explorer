/**
 * RNA Structure & Packaging Signal Explorer
 *
 * Finds structure-constrained segments of coding regions by scoring how much
 * base pairing a window can form, and how much that changes under synonymous
 * substitution.
 *
 * ## What this is not
 *
 * It is not a free-energy calculation. It is a greedy stem scan with toy pair
 * and stacking constants, not a nearest-neighbour thermodynamic model and not a
 * dynamic program over all structures.
 *
 * That distinction used to be confined to this comment. The overlay reported
 * the output as "Global MFE ... kcal/mol", which is a physical quantity with a
 * defined sign convention, and the number it printed could be POSITIVE -- which
 * is meaningless for a minimum free energy and is the tell that no energy model
 * was involved. It was also exactly `0` when no stem was found, so "nothing
 * detected" and "perfectly neutral structure" rendered identically.
 *
 * The metric is therefore named `pairingScore` and carries no unit. It is
 * negative-is-more-paired on the same convention as an energy, because that is
 * what the internal constants encode and flipping it would gain nothing, but it
 * is a score. `null` means no stem was found.
 *
 * Restoring kcal/mol would mean implementing a real Zuker fold with published
 * nearest-neighbour parameters. That is a well-bounded piece of work and is
 * tracked separately; until it exists, the unit does not belong on screen.
 */

import { CODON_TABLE, reverseComplement } from '../codons';
import { CODON_FAMILIES } from './codon-bias';

// ============================================================================
// Types
// ============================================================================

export interface RNAWindow {
  start: number;
  end: number;
  sequence: string;
  /**
   * Base-pairing score: negative is more paired, null when no stem was found.
   * NOT a free energy and carries no unit -- see this file's header.
   */
  pairingScore: number | null;
  gcContent: number;
  pairingDensity: number; // Fraction of bases in predicted pairs
}

export interface SynonymousVariant {
  codon: string;
  aminoAcid: string;
  /**
   * Change in pairing score from the wild-type codon. Unitless, on the same
   * scale as `pairingScore`; NOT a ΔΔG, though the field kept its name where
   * the concept is "difference from wild type".
   */
  deltaG: number;
}

export interface CodonStress {
  position: number;       // Codon position (0-indexed)
  codon: string;
  aminoAcid: string;
  /** Wild-type local pairing score. Unitless -- see this file's header. */
  wildTypeDeltaG: number;
  variants: SynonymousVariant[];
  stress: number;         // Variance of ΔΔG across synonymous variants (0-1 normalized)
  stressPercentile: number;
  isConstrained: boolean; // High stress = structure-constrained
}

export interface RegulatoryHypothesis {
  start: number;
  end: number;
  type: 'stem-loop' | 'riboswitch' | 'attenuator' | 'packaging-signal' | 'slippery-site' | 'rbs' | 'terminator';
  /**
   * 0-1 confidence, or null where none can be computed.
   *
   * Null is not "low confidence". Slippery sites and riboswitch motifs are
   * exact string matches: the site either matches a known heptamer or it does
   * not, and this scan cannot tell a functional signal from the same bases
   * occurring by chance. They carried the constants 0.7 and 0.3, which read as
   * per-site probabilities and were nothing of the kind.
   */
  confidence: number | null;
  description: string;
  sequence: string;
  structure?: string;    // Dot-bracket notation if available
}

export interface RNAStructureAnalysis {
  windows: RNAWindow[];
  codonStress: CodonStress[];
  highStressRegions: Array<{ start: number; end: number; avgStress: number }>;
  regulatoryHypotheses: RegulatoryHypothesis[];
  /**
   * Mean pairing score across windows that formed a stem, or null when none
   * did. Not a free energy and carries no unit -- see this file's header.
   */
  globalPairingScore: number | null;
  avgSynonymousStress: number;
}

// ============================================================================
// Constants
// ============================================================================

// Pair weights. The magnitudes are loosely inspired by 37°C stacking energies
// in kcal/mol, but they are used here as ordinal weights in a greedy scan with
// no loop model and no partition function, so the sum they produce is NOT a
// free energy and is not reported as one.
const BASE_PAIR_ENERGIES: Record<string, number> = {
  'AU': -0.9,
  'UA': -0.9,
  'GC': -2.1,
  'CG': -2.1,
  'GU': -0.5,
  'UG': -0.5,
};

// Stacking energies (simplified nearest-neighbor)
const STACK_BONUS = -0.4;

// Loop penalties
const HAIRPIN_PENALTY = 4.0;  // Base penalty for hairpin loops
// Reserved for future: BULGE_PENALTY = 3.5, INTERNAL_PENALTY = 2.0

// Minimum hairpin loop size
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

function canPair(a: string, b: string): boolean {
  const pair = a + b;
  return pair in BASE_PAIR_ENERGIES;
}

function pairEnergy(a: string, b: string): number {
  return BASE_PAIR_ENERGIES[a + b] ?? 0;
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
 * Find potential stem-loops using a greedy approach
 * Returns array of [start, end] pairs for predicted base pairs
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

/**
 * Score how much base pairing a window can form.
 *
 * Greedy stem scan with toy constants, not a dynamic program and not an energy
 * model. Returns null when no stem is found, which is a different statement
 * from a score of zero.
 */
function estimatePairing(rna: string): { pairingScore: number | null; pairingDensity: number } {
  const pairs = findStemLoops(rna);

  // null, not 0. "No stem found" and "a structure that scores zero" are
  // different findings and used to render identically.
  if (pairs.length === 0) {
    return { pairingScore: null, pairingDensity: 0 };
  }

  let energy = 0;
  const pairedPositions = new Set<number>();

  // Sum base-pairing energies
  for (const [i, j] of pairs) {
    energy += pairEnergy(rna[i], rna[j]);
    pairedPositions.add(i);
    pairedPositions.add(j);
  }

  // Add stacking bonus for consecutive pairs
  const sortedPairs = [...pairs].sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < sortedPairs.length; k++) {
    const [i1, j1] = sortedPairs[k - 1];
    const [i2, j2] = sortedPairs[k];
    if (i2 === i1 + 1 && j2 === j1 - 1) {
      energy += STACK_BONUS;
    }
  }

  // Add loop penalties (simplified)
  const numHairpins = Math.floor(pairs.length / 4); // Rough estimate
  energy += numHairpins * HAIRPIN_PENALTY;

  const pairingDensity = pairedPositions.size / rna.length;

  return { pairingScore: energy, pairingDensity };
}

/**
 * Get synonymous codons for a given amino acid
 */
function getSynonymousCodons(aminoAcid: string): string[] {
  return CODON_FAMILIES[aminoAcid] ?? [];
}

/**
 * Get amino acid from codon
 */
function getAminoAcid(codon: string): string {
  return CODON_TABLE[codon.toUpperCase()] ?? 'X';
}

/**
 * Compute local ΔG around a codon position using a context window
 */
function computeLocalDeltaG(
  sequence: string,
  codonPosition: number,
  codon: string,
  windowBases = 30
): number {
  const startNt = codonPosition * 3;
  const contextStart = Math.max(0, startNt - windowBases);
  const contextEnd = Math.min(sequence.length, startNt + 3 + windowBases);

  // Build context with the specified codon
  const prefix = sequence.slice(contextStart, startNt);
  const suffix = sequence.slice(startNt + 3, contextEnd);
  const context = prefix + codon + suffix;

  const rna = dnaToRna(context);
  const { pairingScore } = estimatePairing(rna);

  return pairingScore ?? 0;
}

// ============================================================================
// Main Analysis Functions
// ============================================================================

/**
 * Analyze RNA structure along a sequence using sliding windows
 */
export function analyzeRNAWindows(
  sequence: string,
  windowSize = 120,
  stepSize = 30
): RNAWindow[] {
  const windows: RNAWindow[] = [];
  const seq = sequence.toUpperCase();

  for (let start = 0; start + windowSize <= seq.length; start += stepSize) {
    const windowSeq = seq.slice(start, start + windowSize);
    const rna = dnaToRna(windowSeq);
    const { pairingScore, pairingDensity } = estimatePairing(rna);

    windows.push({
      start,
      end: start + windowSize,
      sequence: windowSeq,
      pairingScore,
      gcContent: gcContent(rna),
      pairingDensity,
    });
  }

  return windows;
}

/**
 * Calculate synonymous stress for each codon position
 * High stress = structure-constrained (synonymous changes destabilize structure)
 */
export function computeSynonymousStress(
  codingSequence: string,
  frame = 0
): CodonStress[] {
  const seq = codingSequence.toUpperCase();
  const results: CodonStress[] = [];

  // Process each codon
  const codonCount = Math.floor((seq.length - frame) / 3);
  const allStress: number[] = [];

  for (let i = 0; i < codonCount; i++) {
    const startNt = frame + i * 3;
    const codon = seq.slice(startNt, startNt + 3);
    const aminoAcid = getAminoAcid(codon);

    if (aminoAcid === '*' || aminoAcid === 'X') {
      continue; // Skip stop codons and unknowns
    }

    // Get wild-type ΔG
    const wildTypeDeltaG = computeLocalDeltaG(seq, i, codon);

    // Get synonymous variants
    const synonymousCodons = getSynonymousCodons(aminoAcid);
    const variants: SynonymousVariant[] = [];

    for (const altCodon of synonymousCodons) {
      if (altCodon === codon) continue;

      const altDeltaG = computeLocalDeltaG(seq, i, altCodon);
      variants.push({
        codon: altCodon,
        aminoAcid,
        deltaG: altDeltaG - wildTypeDeltaG, // ΔΔG
      });
    }

    // Calculate stress as variance of ΔΔG values
    let stress = 0;
    if (variants.length > 0) {
      const deltaGs = variants.map(v => Math.abs(v.deltaG));
      const maxDelta = Math.max(...deltaGs, 0.01);
      stress = maxDelta; // Use max ΔΔG as stress measure
    }

    allStress.push(stress);

    results.push({
      position: i,
      codon,
      aminoAcid,
      wildTypeDeltaG,
      variants,
      stress,
      stressPercentile: 0, // Will fill in later
      isConstrained: false,
    });
  }

  // Calculate percentiles efficiently O(N log N)
  const indices = Array.from({ length: allStress.length }, (_, i) => i);
  indices.sort((a, b) => allStress[a] - allStress[b]);

  const maxStress = Math.max(...allStress, 0.01);
  const n = allStress.length;

  for (let rank = 0; rank < n; rank++) {
    const originalIndex = indices[rank];
    const result = results[originalIndex];
    result.stressPercentile = (rank + 1) / n;
    result.stress = result.stress / maxStress; // Normalize to 0-1
    result.isConstrained = result.stressPercentile >= 0.8; // Top 20%
  }

  return results;
}

/**
 * Find contiguous high-stress regions
 */
export function findHighStressRegions(
  stressData: CodonStress[],
  minLength = 5,
  minAvgStress = 0.6
): Array<{ start: number; end: number; avgStress: number }> {
  const regions: Array<{ start: number; end: number; avgStress: number }> = [];

  let regionStart: number | null = null;
  let regionStress: number[] = [];

  for (let i = 0; i <= stressData.length; i++) {
    const current = stressData[i];
    const isHigh = current?.isConstrained ?? false;

    if (isHigh && regionStart === null) {
      regionStart = current.position;
      regionStress = [current.stress];
    } else if (isHigh && regionStart !== null) {
      regionStress.push(current.stress);
    } else if (!isHigh && regionStart !== null) {
      // End of region
      if (regionStress.length >= minLength) {
        const avgStress = regionStress.reduce((a, b) => a + b, 0) / regionStress.length;
        if (avgStress >= minAvgStress) {
          regions.push({
            start: regionStart * 3,
            end: (regionStart + regionStress.length) * 3,
            avgStress,
          });
        }
      }
      regionStart = null;
      regionStress = [];
    }
  }

  return regions;
}

/**
 * Detect potential regulatory RNA elements
 */
export function detectRegulatoryElements(
  sequence: string,
  stressData: CodonStress[]
): RegulatoryHypothesis[] {
  const hypotheses: RegulatoryHypothesis[] = [];
  const rna = dnaToRna(sequence);

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
        end: pos + motif.length + 20,
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
        end: region.end,
        type: 'attenuator',
        confidence: 0.5 + region.avgStress * 0.3,
        description: `High-stress region with stable stem-loop, possible attenuator`,
        sequence: regionSeq.slice(0, 60),
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
    const { pairingScore, pairingDensity } = estimatePairing(region);

    if (gc > 0.5 && pairingDensity > 0.3) {
      // A strongly paired window raises confidence in the hypothesis.
      const stabilityBonus = pairingScore !== null && pairingScore < -5 ? 0.1 : 0;
      hypotheses.push({
        start,
        end,
        type: 'packaging-signal',
        confidence: Math.min(0.9, gc * pairingDensity * 2 + stabilityBonus),
        description: `${label} terminal packaging signal candidate (GC=${(gc * 100).toFixed(1)}%, paired=${(pairingDensity * 100).toFixed(0)}%)`,
        sequence: region.slice(0, 50),
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
              confidence: Math.min(1, totalScore / 100),
              sequence: rna.slice(rbsStart, pos + 3),
              description: `SD: ${sd.pattern}, spacing: ${spacing} nt`,
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

/**
 * Find rho-independent terminators (Stem-loop + U-tract)
 */
function findTerminators(rna: string): RegulatoryHypothesis[] {
  const results: RegulatoryHypothesis[] = [];
  
  // Search for stem-loops followed by U-tract
  const stems = findStemLoops(rna, 5); // Use existing finder, min stem 5
  
  for (const [start, end] of stems) {
    // end is exclusive index of the pairing region? 
    // findStemLoops returns [i, j] inclusive indices of the base pair.
    // So stem ends at j.
    // Check downstream for U-tract
    const j = end;
    if (j + 10 >= rna.length) continue;
    
    const downstream = rna.slice(j + 1, j + 15);
    const uCount = (downstream.match(/U/g) || []).length;
    
    if (uCount >= 4) {
      // It's a candidate
      // Estimate loop size
      // [i, j] is the outer pair.
	      // Need to find inner pair? `findStemLoops` returns ALL pairs.
	      // We need to group them into structures.
	      // Simplified: Just take the pair and check U-tract.
	      // Calculate a confidence score
	      // Actually `findStemLoops` iterates.
	      
	      results.push({
	        type: 'terminator',
	        start,
        end: j + 1 + uCount, // Include U-tract roughly
        confidence: 0.7 + (uCount >= 6 ? 0.2 : 0),
        sequence: rna.slice(start, j + 10),
        description: `Terminator with ${uCount} U's`,
      });
    }
  }
  
  // Deduplicate (since findStemLoops returns nested pairs)
  return deduplicateHypotheses(results);
}

function deduplicateHypotheses(items: RegulatoryHypothesis[]): RegulatoryHypothesis[] {
  // Same ordering rule as above: scored first, unscored kept rather than
  // treated as zero-confidence and dropped by the overlap filter.
  const sorted = [...items].sort((a, b) => {
    if (a.confidence !== null && b.confidence !== null) return b.confidence - a.confidence;
    if (a.confidence !== null) return -1;
    if (b.confidence !== null) return 1;
    return 0;
  });
  const filtered: RegulatoryHypothesis[] = [];
  
  for (const item of sorted) {
    const overlap = filtered.some(e => 
      (item.start >= e.start && item.start < e.end) || 
      (item.end > e.start && item.end <= e.end) ||
      (item.start <= e.start && item.end >= e.end)
    );
    if (!overlap) filtered.push(item);
  }
  return filtered.sort((a, b) => a.start - b.start);
}

/**
 * Full RNA structure analysis
 */
export function analyzeRNAStructure(
  sequence: string,
  options: {
    windowSize?: number;
    stepSize?: number;
    frame?: number;
  } = {}
): RNAStructureAnalysis {
  const { windowSize = 120, stepSize = 30, frame = 0 } = options;
  const rna = dnaToRna(sequence);

  // Sliding window pairing analysis
  const windows = analyzeRNAWindows(sequence, windowSize, stepSize);

  // Synonymous stress analysis
  const codonStress = computeSynonymousStress(sequence, frame);

  // Find high-stress (structure-constrained) regions
  const highStressRegions = findHighStressRegions(codonStress);

  // Detect regulatory elements (advanced + basic)
  const advancedRegulatory = detectRegulatoryElements(sequence, codonStress);
  const rbs = findRBS(rna);
  const terminators = findTerminators(rna);
  
  const allRegulatory = deduplicateHypotheses([
    ...advancedRegulatory, 
    ...rbs, 
    ...terminators
  ]);

  // Global metrics
  // Average over the windows that actually formed a stem. Including the ones
  // that did not, as zeroes, dragged the mean toward zero in proportion to how
  // much UNSTRUCTURED sequence there was, which inverts the meaning.
  const scored = windows.map(w => w.pairingScore).filter((v): v is number => v !== null);
  const globalPairingScore =
    scored.length > 0 ? scored.reduce((sum, v) => sum + v, 0) / scored.length : null;
  const avgSynonymousStress = codonStress.reduce((sum, c) => sum + c.stress, 0) / Math.max(codonStress.length, 1);

  return {
    windows,
    codonStress,
    highStressRegions,
    regulatoryHypotheses: allRegulatory,
    globalPairingScore,
    avgSynonymousStress,
  };
}

/**
 * Get a detailed analysis for a specific gene region
 */
export function analyzeGeneRNAStructure(
  genomeSequence: string,
  geneStart: number,
  geneEnd: number,
  strand: '+' | '-' = '+'
): RNAStructureAnalysis {
  let geneSeq = genomeSequence.slice(geneStart, geneEnd);

  if (strand === '-') {
    geneSeq = reverseComplement(geneSeq);
  }

  return analyzeRNAStructure(geneSeq, {
    windowSize: Math.min(120, Math.floor(geneSeq.length / 3)),
    stepSize: Math.min(30, Math.floor(geneSeq.length / 10)),
    frame: 0,
  });
}
