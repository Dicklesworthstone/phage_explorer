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
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

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
      // Unknown bases are missing evidence, including within the mismatch budget.
      if (/[^ACGT]/.test(kmer1)) continue;

      for (let j = 0; j <= rightRegion.length - kmerLen; j++) {
        // Enforce non-overlapping repeats
        // pos1 = i, pos2 = rightOffset + j
        if (rightOffset + j < i + kmerLen) continue;

        const kmer2 = rightRegion.slice(j, j + kmerLen);
        if (/[^ACGT]/.test(kmer2)) continue;
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


/** Conditional sequence composition from explicitly supplied attachment cores.
 * Biological background: Singh, Ghosh & Hatfull (2013), PLoS Genetics,
 * https://doi.org/10.1371/journal.pgen.1003490, Figure 1 and site-selection results.
 * Compatible core sequence alone does not establish functional attachment sites:
 * binding, synapsis, accessory factors and directionality are not predicted here.
 */
export const ATTACHMENT_LIMITS = {
  sequenceBases: 1_000_000, totalBases: 1_500_000, coreBases: 256,
  flankBases: 1000, inputBytes: 4 * 1024 * 1024,
} as const;
export interface AttachmentSequenceInput {
  name: string; accession: string | null; sequence: string;
  topology: 'linear' | 'circular' | 'unknown';
  source: { kind: 'local' | 'catalog' | 'external'; reference: string; version: string; license: string | null };
}
/** A non-wrapping shared crossover core, not the entire integrase binding site. */
export interface AttachmentCoreSite {
  start: number; end: number; strand: '+' | '-'; evidence: string;
}
export interface AttachmentReconstructionInput {
  format: 'phage-explorer-attachment-reconstruction'; version: 1;
  host: AttachmentSequenceInput; phage: AttachmentSequenceInput;
  attB: AttachmentCoreSite; attP: AttachmentCoreSite;
  circularization: 'already-circular' | 'assumed-circularized';
}
export interface AttachmentOptions { flankLength: number }
export interface AttachmentJunction {
  /** Sequence is oriented to the declared attB strand. */
  sequence: string; strand: '+' | '-';
  /** Offsets inside sequence, not genomic coordinates. */
  core: { start: number; end: number };
  /** Ordered forward-coordinate slices; reverse-complement their concatenation for a minus junction. */
  integratedSegments: Array<{ start: number; end: number }>;
  leftFlankBases: number; rightFlankBases: number;
}
export interface AttachmentProductSegment {
  source: 'host' | 'phage'; sourceStart: number; sourceEnd: number; strand: '+' | '-';
  productStart: number; productEnd: number;
}
export interface AttachmentReconstructionResult {
  options: AttachmentOptions; insertionStrand: '+' | '-'; sharedCore: string;
  integratedSequence: string; integratedTopology: 'linear' | 'circular';
  /** Between-base positions in the original stored source sequences. */
  hostCut: number; phageCut: number;
  segments: AttachmentProductSegment[];
  attL: AttachmentJunction; attR: AttachmentJunction;
  conservation: { hostBases: number; phageBases: number; integratedBases: number; expectedBases: number; conserved: true };
  warnings: string[];
}
function attachmentObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function attachmentKeys(value: Record<string, unknown>, required: string[], context: string): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key))) {
    throw new Error('Unsupported or missing ' + context + ' fields.');
  }
}
function attachmentText(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(context + ' requires nonempty text of at most 2000 characters without control characters.');
  }
  return value.trim();
}
function attachmentDna(value: unknown, maximumBases: number = ATTACHMENT_LIMITS.sequenceBases): string {
  if (typeof value !== 'string' || value.length > ATTACHMENT_LIMITS.inputBytes) throw new Error('Attachment DNA input is absent or too large.');
  const sequence = value.replace(/[ \t\r\n]/g, '').toUpperCase();
  if (!sequence || sequence.length > maximumBases || /[^ACGT]/.test(sequence)) {
    throw new Error('Each attachment sequence requires 1–' + maximumBases.toLocaleString('en-US') + ' unambiguous A/C/G/T bases; ambiguous bases cannot be resolved by reconstruction.');
  }
  return sequence;
}
/** Single-record FASTA or raw DNA; multiple records are never silently concatenated. */
function parseAttachmentSequenceFile(content: string, maximumBases: number): string {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > ATTACHMENT_LIMITS.inputBytes) {
    throw new Error('Attachment sequence file exceeds the 4 MiB limit.');
  }
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0]?.startsWith('>')) {
    if (!lines[0].slice(1).trim() || lines.slice(1).some(line => line.startsWith('>'))) {
      throw new Error('Supply exactly one named FASTA record for the supplied locus.');
    }
    return attachmentDna(lines.slice(1).join(''), maximumBases);
  }
  return attachmentDna(lines.join(''), maximumBases);
}
export function parseAttachmentDna(content: string): string {
  return parseAttachmentSequenceFile(content, ATTACHMENT_LIMITS.sequenceBases);
}
/** Excision accepts the complete output of the bounded two-source integration method. */
export function parseProphageExcisionDna(content: string): string {
  return parseAttachmentSequenceFile(content, ATTACHMENT_LIMITS.totalBases);
}
function validateAttachmentSequence(value: unknown, context: string,
  maximumBases: number = ATTACHMENT_LIMITS.sequenceBases): AttachmentSequenceInput {
  if (!attachmentObject(value) || !attachmentObject(value.source)) throw new Error(context + ' sequence and source are required.');
  attachmentKeys(value, ['name', 'accession', 'sequence', 'topology', 'source'], context);
  attachmentKeys(value.source, ['kind', 'reference', 'version', 'license'], context + ' source');
  if (!['linear', 'circular', 'unknown'].includes(value.topology as string) ||
    !['local', 'catalog', 'external'].includes(value.source.kind as string)) throw new Error('Explicit attachment source kind and topology are required.');
  return { name: attachmentText(value.name, context + ' name'),
    accession: value.accession === null ? null : attachmentText(value.accession, context + ' accession'),
    sequence: attachmentDna(value.sequence, maximumBases), topology: value.topology as AttachmentSequenceInput['topology'],
    source: { kind: value.source.kind as AttachmentSequenceInput['source']['kind'],
      reference: attachmentText(value.source.reference, context + ' reference'),
      version: attachmentText(value.source.version, context + ' source version'),
      license: value.source.license === null ? null : attachmentText(value.source.license, context + ' license') } };
}
function validateAttachmentSite(value: unknown, length: number, context: string): AttachmentCoreSite {
  if (!attachmentObject(value)) throw new Error(context + ' core coordinates and evidence are required.');
  attachmentKeys(value, ['start', 'end', 'strand', 'evidence'], context);
  if (typeof value.start !== 'number' || typeof value.end !== 'number' || !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) || value.start < 0 || value.end <= value.start || value.end > length ||
    value.end - value.start > ATTACHMENT_LIMITS.coreBases || !['+', '-'].includes(value.strand as string)) {
    throw new Error(context + ' requires an explicit strand and a non-wrapping 0-based half-open core of 1–256 bases inside its source.');
  }
  return { start: value.start, end: value.end, strand: value.strand as '+' | '-', evidence: attachmentText(value.evidence, context + ' evidence or assumption') };
}
export function validateAttachmentInput(value: unknown): AttachmentReconstructionInput {
  if (!attachmentObject(value) || value.format !== 'phage-explorer-attachment-reconstruction' || value.version !== 1) {
    throw new Error('Unsupported attachment reconstruction input format/version.');
  }
  attachmentKeys(value, ['format', 'version', 'host', 'phage', 'attB', 'attP', 'circularization'], 'attachment input');
  const host = validateAttachmentSequence(value.host, 'Host locus'), phage = validateAttachmentSequence(value.phage, 'Phage');
  if (host.sequence.length + phage.sequence.length > ATTACHMENT_LIMITS.totalBases) throw new Error('Combined attachment inputs exceed 1,500,000 bases.');
  if (host.topology === 'unknown') throw new Error('Declare the host as a linear locus or a circular sequence; unknown host topology is unsupported.');
  if (!['already-circular', 'assumed-circularized'].includes(value.circularization as string) ||
    value.circularization === 'already-circular' && phage.topology !== 'circular') {
    throw new Error('A linear or unknown phage sequence needs an explicit circularization assumption.');
  }
  const attB = validateAttachmentSite(value.attB, host.sequence.length, 'attB');
  const attP = validateAttachmentSite(value.attP, phage.sequence.length, 'attP');
  const core = (sequence: string, site: AttachmentCoreSite) => site.strand === '+' ? sequence.slice(site.start, site.end) : reverseComplement(sequence.slice(site.start, site.end));
  if (core(host.sequence, attB) !== core(phage.sequence, attP)) {
    throw new Error('The declared attB and attP cores do not match exactly in their supplied orientations. No product was reconstructed.');
  }
  return { format: 'phage-explorer-attachment-reconstruction', version: 1, host, phage, attB, attP,
    circularization: value.circularization as AttachmentReconstructionInput['circularization'] };
}
export function resolveAttachmentOptions(value: unknown = {}): AttachmentOptions {
  if (!attachmentObject(value) || Object.keys(value).some(key => key !== 'flankLength')) throw new Error('Unsupported attachment options.');
  const flankLength = Object.hasOwn(value, 'flankLength') ? value.flankLength : 50;
  if (typeof flankLength !== 'number' || !Number.isInteger(flankLength) || flankLength < 0 || flankLength > ATTACHMENT_LIMITS.flankBases) {
    throw new Error('Junction flank length must be an integer from 0 to 1000 bases.');
  }
  return { flankLength };
}
function attachmentPreview(sequence: string, start: number, length: number, flank: number, circular: boolean, strand: '+' | '-'): AttachmentJunction {
  const n = sequence.length;
  const left = circular ? Math.min(flank, Math.floor((n - length) / 2)) : Math.min(flank, start);
  const right = circular ? Math.min(flank, n - length - left) : Math.min(flank, n - start - length);
  const first = circular ? ((start - left) % n + n) % n : start - left;
  const count = left + length + right;
  const integratedSegments = first + count <= n ? [{ start: first, end: first + count }]
    : [{ start: first, end: n }, { start: 0, end: first + count - n }];
  const forward = integratedSegments.map(segment => sequence.slice(segment.start, segment.end)).join('');
  const leftFlankBases = strand === '+' ? left : right, rightFlankBases = strand === '+' ? right : left;
  return { sequence: strand === '+' ? forward : reverseComplement(forward), strand, integratedSegments,
    core: { start: leftFlankBases, end: leftFlankBases + length }, leftFlankBases, rightFlankBases };
}
/** Conservative composition of a declared circular substrate into a host locus.
 * The canonical splice is at the forward-coordinate start of the identical core.
 * Moving that splice within the shared core yields the same product bases; this
 * convention does not infer an enzyme's strand-cleavage position or activity.
 */
export function reconstructAttachment(raw: AttachmentReconstructionInput, settings: Partial<AttachmentOptions> = {}): AttachmentReconstructionResult {
  const input = validateAttachmentInput(raw), options = resolveAttachmentOptions(settings);
  const { host, phage, attB, attP } = input, h = host.sequence.length, p = phage.sequence.length;
  const insertionStrand = attB.strand === attP.strand ? '+' : '-';
  const orientedPhage = insertionStrand === '+' ? phage.sequence : reverseComplement(phage.sequence);
  const cut = insertionStrand === '+' ? attP.start : p - attP.end, hostCut = attB.start;
  const rotated = orientedPhage.slice(cut) + orientedPhage.slice(0, cut);
  const integratedSequence = host.sequence.slice(0, hostCut) + rotated + host.sequence.slice(hostCut);
  const segments: AttachmentProductSegment[] = [];
  let productStart = 0;
  const add = (source: 'host' | 'phage', lo: number, hi: number, strand: '+' | '-') => {
    if (lo === hi) return;
    segments.push({ source, sourceStart: lo, sourceEnd: hi, strand, productStart, productEnd: productStart + hi - lo });
    productStart += hi - lo;
  };
  add('host', 0, hostCut, '+');
  if (insertionStrand === '+') { add('phage', cut, p, '+'); add('phage', 0, cut, '+'); }
  else { add('phage', 0, p - cut, '-'); add('phage', p - cut, p, '-'); }
  add('host', hostCut, h, '+');
  if (integratedSequence.length !== h + p || productStart !== h + p) throw new Error('Attachment composition failed its length conservation invariant.');
  const length = attB.end - attB.start, sharedCore = attB.strand === '+' ? host.sequence.slice(attB.start, attB.end) : reverseComplement(host.sequence.slice(attB.start, attB.end));
  const left = attachmentPreview(integratedSequence, hostCut, length, options.flankLength, host.topology === 'circular', attB.strand);
  const right = attachmentPreview(integratedSequence, hostCut + p, length, options.flankLength, host.topology === 'circular', attB.strand);
  const warnings = [
    'This is a conditional sequence reconstruction from supplied core coordinates and orientations, not discovery of functional attachment sites or a prediction of integration, excision, infection, or clinical risk.',
    'Identical cores do not establish integrase binding, accessory-factor availability, directionality, or compatibility of the full attachment sites. Core evidence is a supplied declaration, not independently verified.',
    'The phage is treated as a complete circular substrate. No input bases are removed, duplicated, repaired or resolved; non-wrapping cores and unambiguous input DNA are required.',
    'The splice at the forward start of the identical core is a sequence convention; the biochemical strand-cleavage location is not inferred.',
    'Junction strings are local context previews, not inferred full binding-site boundaries. Flanks are shortened at linear ends or to avoid repeating bases of a circular product.',
  ];
  if (input.circularization === 'assumed-circularized') warnings.push('Circularization of the supplied phage sequence is an explicit modeling assumption; the input topology is retained in the record.');
  if (host.source.license === null || phage.source.license === null) warnings.push('At least one source has no supplied license declaration. No usage permission is inferred.');
  return { options, insertionStrand, sharedCore, integratedSequence, integratedTopology: host.topology as 'linear' | 'circular',
    hostCut, phageCut: insertionStrand === '+' ? cut : p - cut, segments,
    attL: attB.strand === '+' ? left : right, attR: attB.strand === '+' ? right : left,
    conservation: { hostBases: h, phageBases: p, integratedBases: integratedSequence.length, expectedBases: h + p, conserved: true }, warnings };
}
export async function createAttachmentExperimentRecord(raw: AttachmentReconstructionInput, supplied: AttachmentReconstructionResult): Promise<AnalysisRecord> {
  const input = validateAttachmentInput(raw), result = reconstructAttachment(input, supplied.options);
  if (JSON.stringify(analysisJson(result)) !== JSON.stringify(analysisJson(supplied))) throw new Error('Attachment result does not match its exact input and options.');
  const { host, phage, attB, attP, circularization } = input;
  return createAnalysisRecord({
    method: { id: 'attachment-reconstruction', version: '1', implementation: 'explicit oriented identical cores; circular-substrate conservative composition; coordinate-map-v1' },
    inputs: [
      { id: 'hostLocus', accession: host.accession, source: host.source.kind, description: 'Exact supplied host locus bases, declared topology and source metadata.', data: analysisJson(host) },
      { id: 'phageGenome', accession: phage.accession, source: phage.source.kind, description: 'Exact supplied phage bases, input topology and source metadata.', data: analysisJson(phage) },
      { id: 'attachmentSites', accession: null, source: 'local', description: 'Supplied shared-core coordinates, orientations, evidence declarations and circularization assumption.',
        data: analysisJson({ format: input.format, version: input.version, attB, attP, circularization }) },
    ],
    parameters: { flankLength: result.options.flankLength }, seed: null,
    references: [{ id: 'doi:10.1371/journal.pgen.1003490', version: '2013', description: 'Singh, Ghosh and Hatfull: attachment-site half-site identities and biological requirements; sequence composition here does not predict recombinase activity.' }],
    fields: { reconstruction: { label: 'Conditional integrated sequence, oriented junctions and source-coordinate map', kind: 'simulation', units: 'records',
      value: analysisJson(result), coverage: { available: host.sequence.length + phage.sequence.length, total: host.sequence.length + phage.sequence.length, unit: 'bases' },
      assumptions: ['User-supplied attB/attP cores and strand assignments are the intended substrates.', 'A complete circular phage substrate undergoes a conservative sequence exchange at an identical shared core.'],
      limitations: result.warnings } },
  });
}
export async function replayAttachmentExperiment(content: string, expectedPhage?: AttachmentSequenceInput): Promise<{
  input: AttachmentReconstructionInput; options: AttachmentOptions; result: AttachmentReconstructionResult; record: AnalysisRecord;
}> {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > 10 * 1024 * 1024) throw new Error('Saved attachment experiment exceeds the 10 MiB limit.');
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''), { methodId: 'attachment-reconstruction', methodVersion: '1' });
  if (saved.inputs.length !== 3 || saved.seed !== null) throw new Error('Attachment record has unsupported inputs or seed.');
  const get = (id: string) => saved.inputs.find(item => item.id === id)?.data;
  const sites = get('attachmentSites');
  if (!attachmentObject(sites)) throw new Error('Saved attachment coordinates are absent.');
  const input = validateAttachmentInput({ ...sites, host: get('hostLocus'), phage: get('phageGenome') });
  if (expectedPhage && JSON.stringify(analysisJson(validateAttachmentSequence(expectedPhage, 'Selected phage'))) !== JSON.stringify(analysisJson(input.phage))) {
    throw new Error('Selected phage bases or provenance differ from the saved attachment experiment.');
  }
  const options = resolveAttachmentOptions(saved.parameters), result = reconstructAttachment(input, options);
  const record = await createAttachmentExperimentRecord(input, result);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) throw new Error('Fresh attachment reconstruction differs from the saved result or reference contract.');
  return { input, options, result, record };
}


/** Exact conditional excision from declared direct attachment cores.
 * Bxb1 attL/attR excision produces attP and attB, with biological activity
 * requiring the cognate machinery and directionality factor; see Figure 1A:
 * https://doi.org/10.1371/journal.pgen.1003490 .
 * Only the conservative sequence operation is implemented here.
 */
export const PROPHAGE_EXCISION_METHOD = {
  id: 'prophage-excision-reconstruction', version: '1',
  implementation: 'declared oriented identical direct cores; conservative linear/circular arc excision; complete product and source-coordinate maps-v1',
} as const;
export interface ProphageExcisionInput {
  format: 'phage-explorer-prophage-excision'; version: 1;
  locus: AttachmentSequenceInput;
  attL: AttachmentCoreSite; attR: AttachmentCoreSite;
}
export interface ExcisionSequenceProduct {
  sequence: string; topology: 'linear' | 'circular';
  /** Forward coordinate of the first output base in the integrated input. */
  sourceOrigin: number;
  /** Ordered exact input slices; every product follows the input's forward strand. */
  segments: Array<{ sourceStart: number; sourceEnd: number; strand: '+';
    productStart: number; productEnd: number }>;
}
export interface ExcisionJunction extends Omit<AttachmentJunction, 'integratedSegments'> {
  /** Intervals in the named output molecule, not in the original input. */
  productSegments: Array<{ start: number; end: number }>;
}
export interface ProphageExcisionResult {
  options: AttachmentOptions; sharedCore: string; attachmentStrand: '+' | '-';
  /** Half-open forward arc removed from the original input; start > end wraps. */
  sourceCuts: { start: number; end: number; wrapsOrigin: boolean };
  excisedPhage: ExcisionSequenceProduct; restoredHost: ExcisionSequenceProduct;
  attP: ExcisionJunction; attB: ExcisionJunction;
  conservation: { inputBases: number; excisedBases: number; restoredBases: number;
    recoveredBases: number; conserved: true };
  warnings: string[];
}
export function validateProphageExcisionInput(value: unknown): ProphageExcisionInput {
  if (!attachmentObject(value) || value.format !== 'phage-explorer-prophage-excision' || value.version !== 1) {
    throw new Error('Unsupported prophage excision input format/version.');
  }
  attachmentKeys(value, ['format', 'version', 'locus', 'attL', 'attR'], 'prophage excision input');
  const locus = validateAttachmentSequence(value.locus, 'Integrated locus', ATTACHMENT_LIMITS.totalBases);
  if (locus.topology === 'unknown') throw new Error('Declare whether the integrated locus is linear or circular before reconstructing excision.');
  const attL = validateAttachmentSite(value.attL, locus.sequence.length, 'attL');
  const attR = validateAttachmentSite(value.attR, locus.sequence.length, 'attR');
  if (attL.strand !== attR.strand) {
    throw new Error('Excision requires the two declared sites to have the same orientation. Opposite orientations describe inversion, which this operation does not reconstruct.');
  }
  if (!(attL.end <= attR.start || attR.end <= attL.start)) {
    throw new Error('The declared attL and attR cores must be distinct and non-overlapping.');
  }
  const oriented = (site: AttachmentCoreSite) => site.strand === '+'
    ? locus.sequence.slice(site.start, site.end) : reverseComplement(locus.sequence.slice(site.start, site.end));
  if (oriented(attL) !== oriented(attR)) {
    throw new Error('The declared attL and attR crossover cores must match exactly in their supplied orientations. An ambiguous crossover is not reconstructed.');
  }
  const start = attL.strand === '+' ? attL.start : attR.start;
  const end = attL.strand === '+' ? attR.start : attL.start;
  if (locus.topology === 'linear' && start >= end) {
    throw new Error('A linear locus requires attL before attR on the forward strand, or attR before attL on the reverse strand. Origin-crossing excision requires circular input.');
  }
  return { format: 'phage-explorer-prophage-excision', version: 1, locus, attL, attR };
}
/** Compose each product from its retained input slices, preserving an exact map. */
function excisionMolecule(source: string, intervals: Array<{ start: number; end: number }>,
  topology: 'linear' | 'circular'): ExcisionSequenceProduct {
  const segments: ExcisionSequenceProduct['segments'] = [];
  const pieces: string[] = [];
  let productStart = 0;
  for (const interval of intervals) {
    if (interval.start === interval.end) continue;
    pieces.push(source.slice(interval.start, interval.end));
    segments.push({ sourceStart: interval.start, sourceEnd: interval.end, strand: '+',
      productStart, productEnd: productStart + interval.end - interval.start });
    productStart += interval.end - interval.start;
  }
  if (!segments.length) throw new Error('Excision cannot produce an empty host or phage molecule.');
  return { sequence: pieces.join(''), topology, sourceOrigin: segments[0].sourceStart, segments };
}
export function reconstructProphageExcision(raw: ProphageExcisionInput,
  settings: Partial<AttachmentOptions> = {}): ProphageExcisionResult {
  const input = validateProphageExcisionInput(raw), options = resolveAttachmentOptions(settings);
  const { locus, attL, attR } = input, n = locus.sequence.length;
  const start = attL.strand === '+' ? attL.start : attR.start;
  const end = attL.strand === '+' ? attR.start : attL.start;
  const wrapsOrigin = start > end;
  const phageParts = wrapsOrigin ? [{ start, end: n }, { start: 0, end }] : [{ start, end }];
  // Keep the stored host origin if retained. If it was excised, the restored
  // circular host starts at the first retained base, at the second cut.
  const hostParts = wrapsOrigin ? [{ start: end, end: start }] : [{ start: 0, end: start }, { start: end, end: n }];
  const excisedPhage = excisionMolecule(locus.sequence, phageParts, 'circular');
  const restoredHost = excisionMolecule(locus.sequence, hostParts, locus.topology as 'linear' | 'circular');
  const allParts = [...excisedPhage.segments, ...restoredHost.segments].sort((a, b) => a.sourceStart - b.sourceStart);
  let covered = 0;
  for (const part of allParts) {
    if (part.sourceStart !== covered) throw new Error('Excision failed its source-coordinate conservation invariant.');
    covered = part.sourceEnd;
  }
  if (covered !== n || excisedPhage.sequence.length + restoredHost.sequence.length !== n) {
    throw new Error('Excision failed its whole-source base conservation invariant.');
  }
  const coreLength = attL.end - attL.start;
  const preview = (product: ExcisionSequenceProduct, coreStart: number): ExcisionJunction => {
    const { integratedSegments, ...junction } = attachmentPreview(product.sequence, coreStart, coreLength,
      options.flankLength, product.topology === 'circular', attL.strand);
    return { ...junction, productSegments: integratedSegments };
  };
  const sharedCore = attL.strand === '+' ? locus.sequence.slice(attL.start, attL.end)
    : reverseComplement(locus.sequence.slice(attL.start, attL.end));
  const warnings = [
    'This is conditional sequence reconstruction from supplied attL/attR coordinates, not discovery of a prophage or a prediction of excision efficiency, infectivity or clinical risk.',
    'Matching crossover cores do not establish full-site recognition, integrase compatibility, accessory factors or recombination directionality. Site identities and evidence are supplied declarations.',
    'The forward-coordinate starts of the identical cores define the splice convention. A biochemical cleavage position inside the shared core is not inferred.',
    'Both output sequences retain the original input forward orientation. The phage product is circular; its stored origin is the first cut. Junction previews follow the declared attachment-site strand.',
    'Every input base occurs in exactly one output molecule. No bases are added, removed, corrected or assigned from ambiguous input.',
  ];
  if (restoredHost.sourceOrigin !== 0) warnings.push('The original stored origin lies in the excised arc; the restored host is stored from its first retained source base.');
  if (locus.source.license === null) warnings.push('No source license was supplied. Usage permission is not inferred.');
  return { options, sharedCore, attachmentStrand: attL.strand, sourceCuts: { start, end, wrapsOrigin },
    excisedPhage, restoredHost, attP: preview(excisedPhage, 0), attB: preview(restoredHost, wrapsOrigin ? 0 : start),
    conservation: { inputBases: n, excisedBases: excisedPhage.sequence.length, restoredBases: restoredHost.sequence.length,
      recoveredBases: excisedPhage.sequence.length + restoredHost.sequence.length, conserved: true }, warnings };
}
export async function createProphageExcisionRecord(raw: ProphageExcisionInput,
  supplied: ProphageExcisionResult): Promise<AnalysisRecord> {
  const input = validateProphageExcisionInput(raw), result = reconstructProphageExcision(input, supplied.options);
  if (JSON.stringify(analysisJson(result)) !== JSON.stringify(analysisJson(supplied))) {
    throw new Error('Excision products do not match the exact integrated source and declared sites.');
  }
  return createAnalysisRecord({
    method: { ...PROPHAGE_EXCISION_METHOD },
    inputs: [
      { id: 'integratedLocus', accession: input.locus.accession, source: input.locus.source.kind,
        description: 'Exact integrated locus bases, topology and supplied source metadata.', data: analysisJson(input.locus) },
      { id: 'excisionSites', accession: null, source: 'local',
        description: 'Declared oriented attL/attR crossover cores and supporting evidence or assumptions.',
        data: analysisJson({ format: input.format, version: input.version, attL: input.attL, attR: input.attR }) },
    ],
    parameters: { flankLength: result.options.flankLength }, seed: null,
    references: [{ id: 'doi:10.1371/journal.pgen.1003490', version: '2013',
      description: 'Singh, Ghosh and Hatfull, Figure 1A: attL/attR excision produces attP/attB with appropriate recombination machinery; sequence composition here does not predict that activity.' }],
    fields: { reconstruction: { label: 'Conditional excised phage, restored host, junctions and source-coordinate maps',
      kind: 'simulation', units: 'records', value: analysisJson(result),
      coverage: { available: input.locus.sequence.length, total: input.locus.sequence.length, unit: 'bases' },
      assumptions: ['The supplied attL and attR are the intended compatible, directly oriented sites.',
        'A conservative sequence exchange occurs within their identical, explicitly declared crossover cores.'],
      limitations: result.warnings } },
  });
}
export async function replayProphageExcisionRecord(content: string, expectedLocus?: AttachmentSequenceInput): Promise<{
  input: ProphageExcisionInput; options: AttachmentOptions; result: ProphageExcisionResult; record: AnalysisRecord;
}> {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > 10 * 1024 * 1024) {
    throw new Error('Saved excision experiment exceeds the 10 MiB limit.');
  }
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''),
    { methodId: PROPHAGE_EXCISION_METHOD.id, methodVersion: PROPHAGE_EXCISION_METHOD.version });
  if (saved.inputs.length !== 2 || saved.seed !== null) throw new Error('Excision record has unsupported inputs or seed.');
  const get = (id: string) => saved.inputs.find(item => item.id === id)?.data;
  const sites = get('excisionSites');
  if (!attachmentObject(sites)) throw new Error('Saved excision coordinates are absent.');
  const input = validateProphageExcisionInput({ ...sites, locus: get('integratedLocus') });
  if (expectedLocus && JSON.stringify(analysisJson(validateAttachmentSequence(expectedLocus, 'Selected integrated locus',
    ATTACHMENT_LIMITS.totalBases))) !== JSON.stringify(analysisJson(input.locus))) {
    throw new Error('Selected integrated bases or provenance differ from the saved excision experiment.');
  }
  const options = resolveAttachmentOptions(saved.parameters), result = reconstructProphageExcision(input, options);
  const record = await createProphageExcisionRecord(input, result);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) {
    throw new Error('Fresh excision reconstruction differs from the saved result or reference contract.');
  }
  return { input, options, result, record };
}
