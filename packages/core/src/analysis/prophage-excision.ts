/**
 * Prophage Excision Precision Mapper
 *
 * Predicts exact attL/attR attachment sites for temperate phages.
 * Finds integrase genes, searches for imperfect direct repeats at boundaries,
 * and models the excision product.
 *
 * Part of: phage_explorer-w71 (Layer 2: Prophage Excision Precision Mapper)
 */

import type { GeneInfo } from '../types';
import { reverseComplement } from '../codons';

// Keywords that indicate integrase/recombinase genes
const INTEGRASE_KEYWORDS = [
  'integrase',
  'recombinase',
  'tyrosine recombinase',
  'serine recombinase',
  'site-specific recombinase',
  'phage integrase',
  'int',
  'xis',
  'excisionase',
];

// Common att site core sequences (from well-characterized phages)
const KNOWN_ATT_CORES = [
  'TTTTCTTT', // Lambda-like
  'TTTGTAT',  // P2-like
  'GTTTTTTG', // Mu-like
  'ATTGCAT',  // P22-like
];

export interface AttachmentSite {
  /** Position in genome (0-indexed) */
  position: number;
  /** The direct repeat sequence */
  sequence: string;
  /** Length of the repeat */
  length: number;
  /** Which site type: left or right boundary */
  type: 'attL' | 'attR';
  /** Partner site position for this repeat */
  partnerPosition: number;
  /** Hamming distance between left/right occurrences */
  hammingDistance: number;
  /** Search parameter used when finding repeats */
  maxMismatches: number;
  /** Confidence score 0-1 based on proximity to integrase, repeat quality */
  confidence: number;
  /** Whether it matches a known att core motif */
  matchesKnownCore: boolean;
  /** Distance from nearest integrase gene */
  distanceFromIntegrase: number;
}

export interface DirectRepeat {
  /** First occurrence position */
  pos1: number;
  /** Second occurrence position */
  pos2: number;
  /** The repeat sequence */
  sequence: string;
  /** Number of mismatches allowed */
  mismatches: number;
  /** Hamming distance (actual mismatches) */
  hammingDistance: number;
}

export interface IntegraseGene {
  /** The gene info */
  gene: GeneInfo;
  /** Keywords that matched */
  matchedKeywords: string[];
  /** Confidence that this is actually an integrase */
  confidence: number;
  /** Best-effort class based on annotations (no HMMER here) */
  integraseClass: 'tyrosine' | 'serine' | 'unknown';
}

export interface IntegrationHotspot {
  /** Position of the motif (0-indexed, on the stored strand) */
  position: number;
  /** Core motif hit */
  motif: string;
  /** Strand of the matched motif */
  strand: '+' | '-';
  /** 0-1 score (heuristic) */
  score: number;
  /** Distance to nearest integrase (if any) */
  distanceFromIntegrase: number;
  /** Distance to nearest tRNA/tmRNA gene in this genome (if any) */
  distanceFromTrna: number;
}

export interface ExcisionRisk {
  /** 0 = low risk (precise), 1 = high risk (imprecise) */
  risk: number;
  label: 'low' | 'medium' | 'high';
  symmetryScore: number;
  mismatchRate: number;
  factors: Array<{ factor: string; contribution: number; notes?: string }>;
}

export interface ExcisionProduct {
  /** attB site in host (circular form after excision) */
  attB: {
    sequence: string;
    reconstructed: boolean;
  };
  /** attP site in phage (circular form) */
  attP: {
    sequence: string;
    reconstructed: boolean;
  };
  /** Estimated circular phage genome size */
  circularGenomeSize: number;
  /** Estimated excised region boundaries in linear form */
  excisedRegion: {
    start: number;
    end: number;
  };
}

export interface ProphageExcisionAnalysis {
  /** Identified integrase genes */
  integrases: IntegraseGene[];
  /** Candidate integration hotspot hits (known att cores + proximity heuristics) */
  integrationHotspots: IntegrationHotspot[];
  /** Predicted attachment sites */
  attachmentSites: AttachmentSite[];
  /** Direct repeats found near boundaries */
  directRepeats: DirectRepeat[];
  /** Best attL/attR pair prediction */
  bestPrediction: {
    attL: AttachmentSite | null;
    attR: AttachmentSite | null;
    confidence: number;
    excisionProduct: ExcisionProduct | null;
  };
  /** Excision risk estimate (only when bestPrediction has an attL/attR pair) */
  excisionRisk: ExcisionRisk | null;
  /** Is this likely a temperate phage? */
  isTemperate: boolean;
  /** Overall analysis confidence */
  overallConfidence: number;
  /** Diagnostic messages */
  diagnostics: string[];
}

/**
 * Find integrase/recombinase genes from gene annotations
 */
export function findIntegrases(genes: GeneInfo[]): IntegraseGene[] {
  const results: IntegraseGene[] = [];

  for (const gene of genes) {
    const fields = [gene.name, gene.product, gene.locusTag]
      .filter((f): f is string => f !== null)
      .map((f) => f.toLowerCase());

    const matchedKeywords: string[] = [];

    for (const keyword of INTEGRASE_KEYWORDS) {
      if (fields.some((f) => f.includes(keyword))) {
        matchedKeywords.push(keyword);
      }
    }

    if (matchedKeywords.length > 0) {
      // Higher confidence if multiple keywords match or specific terms
      let confidence = 0.5 + matchedKeywords.length * 0.15;
      if (matchedKeywords.includes('integrase')) confidence += 0.2;
      if (matchedKeywords.includes('site-specific recombinase')) confidence += 0.15;

      const integraseClass: IntegraseGene['integraseClass'] = matchedKeywords.includes('tyrosine recombinase')
        ? 'tyrosine'
        : matchedKeywords.includes('serine recombinase')
          ? 'serine'
          : fields.some((f) => f.includes('tyrosine'))
            ? 'tyrosine'
            : fields.some((f) => f.includes('serine'))
              ? 'serine'
              : 'unknown';

      results.push({
        gene,
        matchedKeywords,
        confidence: Math.min(1, confidence),
        integraseClass,
      });
    }
  }

  // Sort by confidence descending
  return results.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Find direct repeats in sequence with allowed mismatches
 *
 * Searches for pairs of similar sequences that could be att sites.
 * Focus on regions near genome termini for prophages.
 */
export function findDirectRepeats(
  sequence: string,
  minLength: number = 15,
  maxLength: number = 25,
  maxMismatches: number = 3,
  searchRegionSize: number = 5000
): DirectRepeat[] {
  const seq = sequence.toUpperCase();
  const len = seq.length;
  const results: DirectRepeat[] = [];

  // Search in terminal regions
  const leftRegion = seq.slice(0, Math.min(searchRegionSize, len));
  const rightRegion = seq.slice(Math.max(0, len - searchRegionSize));
  const rightOffset = Math.max(0, len - searchRegionSize);

  // Compare kmers from left region to right region
  for (let kmerLen = maxLength; kmerLen >= minLength; kmerLen--) {
    for (let i = 0; i <= leftRegion.length - kmerLen; i++) {
      const kmer1 = leftRegion.slice(i, i + kmerLen);

      for (let j = 0; j <= rightRegion.length - kmerLen; j++) {
        // Enforce non-overlapping repeats
        // pos1 = i, pos2 = rightOffset + j
        if (rightOffset + j < i + kmerLen) continue;

        const kmer2 = rightRegion.slice(j, j + kmerLen);
        const hd = hammingDistance(kmer1, kmer2);

        if (hd <= maxMismatches) {
          results.push({
            pos1: i,
            pos2: rightOffset + j,
            sequence: kmer1,
            mismatches: maxMismatches,
            hammingDistance: hd,
          });
        }
      }
    }
  }

  // Deduplicate overlapping repeats, keeping best
  const filtered = deduplicateRepeats(results);

  return filtered.slice(0, 20); // Return top candidates
}

/**
 * Calculate Hamming distance between two equal-length strings
 */
function hammingDistance(s1: string, s2: string): number {
  let dist = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i] !== s2[i]) dist++;
  }
  return dist;
}

/**
 * Remove overlapping repeats, keeping highest quality
 */
function deduplicateRepeats(repeats: DirectRepeat[]): DirectRepeat[] {
  // Sort by quality: longer length, fewer mismatches
  const sorted = [...repeats].sort((a, b) => {
    const scoreA = a.sequence.length - a.hammingDistance * 3;
    const scoreB = b.sequence.length - b.hammingDistance * 3;
    return scoreB - scoreA;
  });

  const kept: DirectRepeat[] = [];
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();

  for (const repeat of sorted) {
    // Check if positions overlap with already kept repeats
    let overlaps = false;
    
    // Check left occurrence
    for (let p = repeat.pos1; p < repeat.pos1 + repeat.sequence.length; p++) {
      if (usedLeft.has(p)) {
        overlaps = true;
        break;
      }
    }
    
    if (overlaps) continue;

    // Check right occurrence
    for (let p = repeat.pos2; p < repeat.pos2 + repeat.sequence.length; p++) {
      if (usedRight.has(p)) {
        overlaps = true;
        break;
      }
    }

    if (!overlaps) {
      kept.push(repeat);
      for (let p = repeat.pos1; p < repeat.pos1 + repeat.sequence.length; p++) {
        usedLeft.add(p);
      }
      for (let p = repeat.pos2; p < repeat.pos2 + repeat.sequence.length; p++) {
        usedRight.add(p);
      }
    }
  }

  return kept;
}

/**
 * Check if a sequence matches known att core motifs
 */
function matchesKnownAttCore(sequence: string): boolean {
  const seq = sequence.toUpperCase();
  return KNOWN_ATT_CORES.some(
    (core) => seq.includes(core) || reverseComplement(seq).includes(core)
  );
}

/**
 * Convert direct repeats to attachment site predictions
 */
function repeatsToAttSites(
  repeats: DirectRepeat[],
  integrases: IntegraseGene[]
): AttachmentSite[] {
  const sites: AttachmentSite[] = [];

  for (const repeat of repeats) {
    // Find closest integrase to each position
    const distL = minIntegraseDistance(repeat.pos1, integrases);
    const distR = minIntegraseDistance(repeat.pos2, integrases);

    // Calculate confidence based on repeat quality and integrase proximity
    const repeatQuality =
      (repeat.sequence.length - 10) / 15 - repeat.hammingDistance * 0.15;
    const integraseBonus = distL < 10000 || distR < 10000 ? 0.2 : 0;
    const knownCoreBonus = matchesKnownAttCore(repeat.sequence) ? 0.25 : 0;

    const baseConfidence = Math.max(
      0,
      Math.min(1, 0.3 + repeatQuality + integraseBonus + knownCoreBonus)
    );

    // Left site (closer to start)
    sites.push({
      position: repeat.pos1,
      sequence: repeat.sequence,
      length: repeat.sequence.length,
      type: 'attL',
      partnerPosition: repeat.pos2,
      hammingDistance: repeat.hammingDistance,
      maxMismatches: repeat.mismatches,
      confidence: baseConfidence,
      matchesKnownCore: matchesKnownAttCore(repeat.sequence),
      distanceFromIntegrase: distL,
    });

    // Right site (closer to end)
    sites.push({
      position: repeat.pos2,
      sequence: repeat.sequence,
      length: repeat.sequence.length,
      type: 'attR',
      partnerPosition: repeat.pos1,
      hammingDistance: repeat.hammingDistance,
      maxMismatches: repeat.mismatches,
      confidence: baseConfidence,
      matchesKnownCore: matchesKnownAttCore(repeat.sequence),
      distanceFromIntegrase: distR,
    });
  }

  return sites.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Find minimum distance from a position to any integrase gene
 */
function minIntegraseDistance(
  position: number,
  integrases: IntegraseGene[]
): number {
  if (integrases.length === 0) return Infinity;

  let minDist = Infinity;
  for (const int of integrases) {
    const geneStart = int.gene.startPos;
    const geneEnd = int.gene.endPos;
    const dist = Math.min(
      Math.abs(position - geneStart),
      Math.abs(position - geneEnd)
    );
    minDist = Math.min(minDist, dist);
  }

  return minDist;
}

/**
 * Model the excision product from predicted att sites
 */
function modelExcisionProduct(
  attL: AttachmentSite,
  attR: AttachmentSite
): ExcisionProduct {
  // After excision, attL and attR recombine:
  // - attB forms in the host chromosome
  // - attP forms in the circular phage

  // The att sites share a core sequence - during recombination
  // the crossover happens within this core

  const excisedStart = attL.position;
  const excisedEnd = attR.position + attR.length;

  // Circular genome size is the prophage region
  const circularGenomeSize = excisedEnd - excisedStart;

  const consensusCore = (() => {
    const a = attL.sequence.toUpperCase();
    const b = attR.sequence.toUpperCase();
    const len = Math.min(a.length, b.length);
    let core = '';
    for (let i = 0; i < len; i++) {
      core += a[i] === b[i] ? a[i] : 'N';
    }
    return core;
  })();

  return {
    attB: {
      sequence: consensusCore, // Reconstructed best-effort consensus
      reconstructed: true,
    },
    attP: {
      sequence: consensusCore,
      reconstructed: true,
    },
    circularGenomeSize,
    excisedRegion: {
      start: excisedStart,
      end: excisedEnd,
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function gcFraction(sequence: string): number {
  const seq = sequence.toUpperCase();
  let gc = 0;
  let total = 0;
  for (const ch of seq) {
    if (ch === 'G' || ch === 'C') {
      gc++;
      total++;
    } else if (ch === 'A' || ch === 'T') {
      total++;
    }
  }
  return total > 0 ? gc / total : 0.5;
}

function findTrnaGenes(genes: GeneInfo[]): GeneInfo[] {
  return genes.filter((g) => {
    const type = (g.type ?? '').toLowerCase();
    const product = (g.product ?? '').toLowerCase();
    return type.includes('trna') || type.includes('tmrna') || product.includes('trna') || product.includes('tmrna');
  });
}

function minDistanceToGene(position: number, genes: GeneInfo[]): number {
  if (genes.length === 0) return Infinity;
  let minDist = Infinity;
  for (const gene of genes) {
    const dist = Math.min(Math.abs(position - gene.startPos), Math.abs(position - gene.endPos));
    minDist = Math.min(minDist, dist);
  }
  return minDist;
}

function findIntegrationHotspots(
  sequence: string,
  genes: GeneInfo[],
  integrases: IntegraseGene[]
): IntegrationHotspot[] {
  const seq = sequence.toUpperCase();
  const trnaGenes = findTrnaGenes(genes);

  const seen = new Set<string>();
  const hits: IntegrationHotspot[] = [];

  const pushHit = (position: number, motif: string, strand: '+' | '-', distanceFromIntegrase: number) => {
    const key = `${position}:${strand}:${motif}`;
    if (seen.has(key)) return;
    seen.add(key);

    const distanceFromTrna = minDistanceToGene(position, trnaGenes);

    let score = 0.45;
    // Integrase proximity bonus
    if (Number.isFinite(distanceFromIntegrase)) {
      if (distanceFromIntegrase < 2000) score += 0.35;
      else if (distanceFromIntegrase < 8000) score += 0.25;
      else if (distanceFromIntegrase < 20000) score += 0.15;
      else if (distanceFromIntegrase < 40000) score += 0.05;
    }
    // tRNA/tmRNA proximity bonus (best-effort proxy for common attB targets)
    if (distanceFromTrna < 1000) score += 0.1;

    hits.push({
      position,
      motif,
      strand,
      score: clamp01(score),
      distanceFromIntegrase,
      distanceFromTrna,
    });
  };

  for (const core of KNOWN_ATT_CORES) {
    const motifPlus = core.toUpperCase();
    const motifMinus = reverseComplement(motifPlus).toUpperCase();

    let idx = 0;
    while (true) {
      const pos = seq.indexOf(motifPlus, idx);
      if (pos === -1) break;
      pushHit(pos, motifPlus, '+', minIntegraseDistance(pos, integrases));
      idx = pos + 1;
    }

    idx = 0;
    while (true) {
      const pos = seq.indexOf(motifMinus, idx);
      if (pos === -1) break;
      pushHit(pos, motifPlus, '-', minIntegraseDistance(pos, integrases));
      idx = pos + 1;
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 50);
}

function computeExcisionRisk(
  attL: AttachmentSite,
  attR: AttachmentSite,
  integrases: IntegraseGene[]
): ExcisionRisk {
  const length = Math.max(1, Math.min(attL.length, attR.length));
  const hammingDistance = Math.max(attL.hammingDistance, attR.hammingDistance);
  const mismatchRate = hammingDistance / length;
  const symmetryScore = clamp01(1 - mismatchRate);

  const minDist = Math.min(attL.distanceFromIntegrase, attR.distanceFromIntegrase);
  const distPenalty = clamp01(minDist / 30000); // 0 at 0bp, 1 at 30kb+

  const corePenalty = length < 16 ? 1 : length < 20 ? 0.6 : length < 24 ? 0.25 : 0;

  const gc = gcFraction(attL.sequence);
  const gcPenalty = clamp01(Math.abs(gc - 0.5) * 2); // 0 at 50%, 1 at extremes

  const knownCoreBonus = attL.matchesKnownCore || attR.matchesKnownCore ? 0.15 : 0;
  const hasSerineIntegrase = integrases.some((i) => i.integraseClass === 'serine');
  const serineBonus = hasSerineIntegrase ? 0.05 : 0;

  // Weighted risk model (heuristic)
  const factors: ExcisionRisk['factors'] = [];
  const mismatchContribution = 0.45 * clamp01(mismatchRate * 1.5);
  factors.push({ factor: 'mismatches', contribution: mismatchContribution, notes: `${hammingDistance}/${length}` });

  const distContribution = 0.25 * distPenalty;
  factors.push({ factor: 'integrase-distance', contribution: distContribution, notes: Number.isFinite(minDist) ? `${Math.round(minDist)} bp` : 'no integrase' });

  const coreContribution = 0.15 * clamp01(corePenalty);
  factors.push({ factor: 'core-length', contribution: coreContribution, notes: `${length} bp` });

  const gcContribution = 0.15 * gcPenalty;
  factors.push({ factor: 'core-GC-extremity', contribution: gcContribution, notes: `${Math.round(gc * 100)}% GC` });

  if (knownCoreBonus > 0) factors.push({ factor: 'known-core-bonus', contribution: -knownCoreBonus });
  if (serineBonus > 0) factors.push({ factor: 'serine-integrase-bonus', contribution: -serineBonus });

  const raw = mismatchContribution + distContribution + coreContribution + gcContribution - knownCoreBonus - serineBonus;
  const risk = clamp01(raw);

  const label: ExcisionRisk['label'] = risk < 0.33 ? 'low' : risk < 0.66 ? 'medium' : 'high';
  return { risk, label, symmetryScore, mismatchRate, factors };
}

/**
 * Main analysis function: predict prophage excision sites
 */
export function analyzeProphageExcision(
  sequence: string,
  genes: GeneInfo[]
): ProphageExcisionAnalysis {
  const diagnostics: string[] = [];

  // Step 1: Find integrase genes
  const integrases = findIntegrases(genes);
  if (integrases.length === 0) {
    diagnostics.push('No integrase/recombinase genes found');
  } else {
    diagnostics.push(
      `Found ${integrases.length} potential integrase gene(s): ${integrases.map((i) => i.gene.name || i.gene.locusTag || 'unnamed').join(', ')}`
    );
  }

  // Step 2: Find direct repeats in terminal regions
  const directRepeats = findDirectRepeats(sequence);
  if (directRepeats.length === 0) {
    diagnostics.push('No direct repeats found at genome boundaries');
  } else {
    diagnostics.push(`Found ${directRepeats.length} candidate direct repeat pair(s)`);
  }

  // Step 2b: Scan for known att core hotspots (best-effort proxy; no host genome context)
  const integrationHotspots = findIntegrationHotspots(sequence, genes, integrases);
  if (integrationHotspots.length === 0) {
    diagnostics.push('No known att core motifs found in genome');
  } else {
    diagnostics.push(`Found ${integrationHotspots.length} known att core motif hit(s)`);
  }

  // Step 3: Convert repeats to attachment site predictions
  const attachmentSites = repeatsToAttSites(
    directRepeats,
    integrases
  );

  // Step 4: Find best attL/attR pair
  let bestAttL: AttachmentSite | null = null;
  let bestAttR: AttachmentSite | null = null;
  let bestPairConfidence = 0;

  // Group sites by their underlying repeat
  const attLSites = attachmentSites.filter((s) => s.type === 'attL');
  const attRSites = attachmentSites.filter((s) => s.type === 'attR');

  // Find best matching pair
  for (const attL of attLSites) {
    for (const attR of attRSites) {
      // Must be same sequence (from same repeat)
      if (attL.sequence !== attR.sequence) continue;

      const pairConfidence = (attL.confidence + attR.confidence) / 2;
      if (pairConfidence > bestPairConfidence) {
        bestAttL = attL;
        bestAttR = attR;
        bestPairConfidence = pairConfidence;
      }
    }
  }

  // Step 5: Model excision product if we have a pair
  let excisionProduct: ExcisionProduct | null = null;
  let excisionRisk: ExcisionRisk | null = null;
  if (bestAttL && bestAttR) {
    excisionProduct = modelExcisionProduct(bestAttL, bestAttR);
    excisionRisk = computeExcisionRisk(bestAttL, bestAttR, integrases);
    diagnostics.push(
      `Best att site pair: attL@${bestAttL.position}, attR@${bestAttR.position} (${bestAttL.sequence.slice(0, 10)}...)`
    );
    diagnostics.push(
      `Predicted circular phage size: ${excisionProduct.circularGenomeSize.toLocaleString()} bp`
    );
    diagnostics.push(`Excision risk: ${excisionRisk.label} (${Math.round(excisionRisk.risk * 100)}%)`);
  } else {
    diagnostics.push('Could not identify confident attL/attR pair');
  }

  // Determine if this is likely a temperate phage
  const isTemperate = integrases.length > 0 && bestPairConfidence > 0.3;

  // Overall confidence
  const integraseScore = integrases.length > 0 ? integrases[0].confidence : 0;
  const repeatScore = bestPairConfidence;
  const overallConfidence = (integraseScore * 0.4 + repeatScore * 0.6);

  return {
    integrases,
    integrationHotspots,
    attachmentSites,
    directRepeats,
    bestPrediction: {
      attL: bestAttL,
      attR: bestAttR,
      confidence: bestPairConfidence,
      excisionProduct,
    },
    excisionRisk,
    isTemperate,
    overallConfidence,
    diagnostics,
  };
}

/**
 * Quick check if phage is likely temperate (has integrase)
 */
export function isLikelyTemperate(genes: GeneInfo[]): boolean {
  return findIntegrases(genes).length > 0;
}
