#!/usr/bin/env bun

// Build script to create and populate the phage database

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import {
  phages,
  sequences,
  genes,
  codonUsage,
  preferences,
  tropismPredictions,
  foldEmbeddings,
  defenseSystems,
  amgAnnotations,
  models,
  codonAdaptation,
  hostTrnaPools,
} from '@phage-explorer/db-schema';
import {
  countCodonUsage,
  countAminoAcidUsage,
  translateSequence,
  reverseComplement,
  encodeFloat32VectorLE,
} from '@phage-explorer/core';
import { PHAGE_CATALOG } from './phage-catalog';
import { fetchPhageSequence, type NCBISequenceResult } from './ncbi-fetcher';
import { readFileSync, existsSync } from 'fs';
import { updateAntiCrisprInDatabase } from './update-anti-crispr';
import { updateDomainAnnotations } from './domain-annotations';

const DB_PATH = './phage.db';
const CHUNK_SIZE = 10000; // 10kb chunks
const TROPISM_PATH = './data/tropism-embeddings.json';
const BATCH_INSERT_SIZE = 100; // Batch inserts for 5-10x faster writes

interface CodingRegion {
  startPos: number;
  endPos: number;
  strand: string | null;
  qualifiers: string | null;
}

/**
 * Reconstruct the spliced coding sequence for a gene row.
 * Multi-segment features store the exon structure in the `_segments` qualifier.
 */
function getSplicedCodingSequence(seq: string, region: CodingRegion): string {
  let segments: Array<{ start: number; end: number }> | undefined;
  if (region.qualifiers) {
    try {
      const parsed = JSON.parse(region.qualifiers) as Record<string, unknown>;
      if (Array.isArray(parsed._segments)) {
        segments = parsed._segments as Array<{ start: number; end: number }>;
      }
    } catch {
      // Fall through to single-segment reconstruction
    }
  }

  let cds = '';
  if (segments && segments.length > 1) {
    for (const segment of segments) {
      cds += seq.substring(segment.start, segment.end);
    }
  } else {
    cds = seq.substring(region.startPos, region.endPos);
  }

  if (region.strand === '-') {
    cds = reverseComplement(cds);
  }
  return cds;
}

/**
 * Compute Wright's effective number of codons (Nc) from a codon-count map.
 * A lower value means stronger codon bias; the maximum is 61 (no bias,
 * assuming all synonymous codons are used equally).
 */
function calculateNc(codonCounts: Record<string, number>): number {
  // Standard genetic code: amino acid -> codons
  const codonToAa: Record<string, string> = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
    CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
    GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
    CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
    GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
    CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
    GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
    CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
    GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
  };

  // Group counts by amino acid (skip stop codons)
  const aaGroups: Record<string, string[]> = {};
  for (const [codon, aa] of Object.entries(codonToAa)) {
    if (aa === '*') continue;
    (aaGroups[aa] ??= []).push(codon);
  }

  let nc = 0;
  for (const [, codons] of Object.entries(aaGroups)) {
    const k = codons.length;
    if (k <= 1) {
      nc += 1;
      continue;
    }

    let total = 0;
    for (const c of codons) total += codonCounts[c] ?? 0;
    if (total < 2) {
      nc += k;
      continue;
    }

    const sumSquares = codons.reduce((sum, c) => {
      const n = codonCounts[c] ?? 0;
      return sum + (n * n);
    }, 0);

    // Wright's F for this amino acid: F = (n * sum(p_i^2) - 1) / (n - 1)
    const fk = (sumSquares - total) / (total * (total - 1));
    if (fk <= 0 || !Number.isFinite(fk)) {
      nc += k;
    } else {
      nc += 1 / fk;
    }
  }

  return Math.max(1, Math.min(61, nc));
}

/**
 * Default host tRNA gene pools used for tAI approximation.
 * Values are approximate copy numbers (literature-derived) for common lab hosts.
 */
const DEFAULT_TRNA_POOLS: Record<string, Array<{ anticodon: string; aminoAcid: string; codon: string; copyNumber: number }>> = {
  // E. coli K-12 MG1655 approximate tRNA gene copy numbers, grouped by codon
  // recognized (allowing canonical wobble U at anticodon position 1).
  'escherichia coli': [
    { anticodon: 'GAA', aminoAcid: 'Phe', codon: 'TTT', copyNumber: 2 },
    { anticodon: 'GAA', aminoAcid: 'Phe', codon: 'TTC', copyNumber: 2 },
    { anticodon: 'CAG', aminoAcid: 'Leu', codon: 'CTT', copyNumber: 4 },
    { anticodon: 'CAG', aminoAcid: 'Leu', codon: 'CTC', copyNumber: 4 },
    { anticodon: 'CAG', aminoAcid: 'Leu', codon: 'CTA', copyNumber: 4 },
    { anticodon: 'CAG', aminoAcid: 'Leu', codon: 'CTG', copyNumber: 4 },
    { anticodon: 'GAG', aminoAcid: 'Leu', codon: 'TTA', copyNumber: 2 },
    { anticodon: 'GAG', aminoAcid: 'Leu', codon: 'TTG', copyNumber: 2 },
    { anticodon: 'GAU', aminoAcid: 'Ile', codon: 'ATT', copyNumber: 3 },
    { anticodon: 'GAU', aminoAcid: 'Ile', codon: 'ATC', copyNumber: 3 },
    { anticodon: 'CAU', aminoAcid: 'Ile', codon: 'ATA', copyNumber: 1 },
    { anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 6 },
    { anticodon: 'GAC', aminoAcid: 'Val', codon: 'GTT', copyNumber: 4 },
    { anticodon: 'GAC', aminoAcid: 'Val', codon: 'GTC', copyNumber: 4 },
    { anticodon: 'GAC', aminoAcid: 'Val', codon: 'GTA', copyNumber: 4 },
    { anticodon: 'GAC', aminoAcid: 'Val', codon: 'GTG', copyNumber: 4 },
    { anticodon: 'UGA', aminoAcid: 'Ser', codon: 'TCT', copyNumber: 3 },
    { anticodon: 'UGA', aminoAcid: 'Ser', codon: 'TCC', copyNumber: 3 },
    { anticodon: 'UGA', aminoAcid: 'Ser', codon: 'TCA', copyNumber: 3 },
    { anticodon: 'UGA', aminoAcid: 'Ser', codon: 'TCG', copyNumber: 3 },
    { anticodon: 'CGA', aminoAcid: 'Ser', codon: 'AGT', copyNumber: 2 },
    { anticodon: 'CGA', aminoAcid: 'Ser', codon: 'AGC', copyNumber: 2 },
    { anticodon: 'GGG', aminoAcid: 'Pro', codon: 'CCT', copyNumber: 3 },
    { anticodon: 'GGG', aminoAcid: 'Pro', codon: 'CCC', copyNumber: 3 },
    { anticodon: 'GGG', aminoAcid: 'Pro', codon: 'CCA', copyNumber: 3 },
    { anticodon: 'GGG', aminoAcid: 'Pro', codon: 'CCG', copyNumber: 3 },
    { anticodon: 'GGU', aminoAcid: 'Thr', codon: 'ACT', copyNumber: 4 },
    { anticodon: 'GGU', aminoAcid: 'Thr', codon: 'ACC', copyNumber: 4 },
    { anticodon: 'GGU', aminoAcid: 'Thr', codon: 'ACA', copyNumber: 4 },
    { anticodon: 'GGU', aminoAcid: 'Thr', codon: 'ACG', copyNumber: 4 },
    { anticodon: 'GGC', aminoAcid: 'Ala', codon: 'GCT', copyNumber: 4 },
    { anticodon: 'GGC', aminoAcid: 'Ala', codon: 'GCC', copyNumber: 4 },
    { anticodon: 'GGC', aminoAcid: 'Ala', codon: 'GCA', copyNumber: 4 },
    { anticodon: 'GGC', aminoAcid: 'Ala', codon: 'GCG', copyNumber: 4 },
    { anticodon: 'GUA', aminoAcid: 'Tyr', codon: 'TAT', copyNumber: 2 },
    { anticodon: 'GUA', aminoAcid: 'Tyr', codon: 'TAC', copyNumber: 2 },
    { anticodon: 'CUG', aminoAcid: 'His', codon: 'CAT', copyNumber: 2 },
    { anticodon: 'CUG', aminoAcid: 'His', codon: 'CAC', copyNumber: 2 },
    { anticodon: 'CUG', aminoAcid: 'Gln', codon: 'CAA', copyNumber: 3 },
    { anticodon: 'CUG', aminoAcid: 'Gln', codon: 'CAG', copyNumber: 3 },
    { anticodon: 'UUG', aminoAcid: 'Asn', codon: 'AAT', copyNumber: 3 },
    { anticodon: 'UUG', aminoAcid: 'Asn', codon: 'AAC', copyNumber: 3 },
    { anticodon: 'UUG', aminoAcid: 'Lys', codon: 'AAA', copyNumber: 5 },
    { anticodon: 'UUG', aminoAcid: 'Lys', codon: 'AAG', copyNumber: 5 },
    { anticodon: 'GUC', aminoAcid: 'Asp', codon: 'GAT', copyNumber: 4 },
    { anticodon: 'GUC', aminoAcid: 'Asp', codon: 'GAC', copyNumber: 4 },
    { anticodon: 'GUC', aminoAcid: 'Glu', codon: 'GAA', copyNumber: 5 },
    { anticodon: 'GUC', aminoAcid: 'Glu', codon: 'GAG', copyNumber: 5 },
    { anticodon: 'GCA', aminoAcid: 'Cys', codon: 'TGT', copyNumber: 1 },
    { anticodon: 'GCA', aminoAcid: 'Cys', codon: 'TGC', copyNumber: 1 },
    { anticodon: 'CCA', aminoAcid: 'Trp', codon: 'TGG', copyNumber: 6 },
    { anticodon: 'ACG', aminoAcid: 'Arg', codon: 'CGT', copyNumber: 5 },
    { anticodon: 'ACG', aminoAcid: 'Arg', codon: 'CGC', copyNumber: 5 },
    { anticodon: 'ACG', aminoAcid: 'Arg', codon: 'CGA', copyNumber: 5 },
    { anticodon: 'ACG', aminoAcid: 'Arg', codon: 'CGG', copyNumber: 5 },
    { anticodon: 'UCG', aminoAcid: 'Arg', codon: 'AGA', copyNumber: 2 },
    { anticodon: 'UCG', aminoAcid: 'Arg', codon: 'AGG', copyNumber: 2 },
    { anticodon: 'UCC', aminoAcid: 'Gly', codon: 'GGT', copyNumber: 5 },
    { anticodon: 'UCC', aminoAcid: 'Gly', codon: 'GGC', copyNumber: 5 },
    { anticodon: 'UCC', aminoAcid: 'Gly', codon: 'GGA', copyNumber: 5 },
    { anticodon: 'UCC', aminoAcid: 'Gly', codon: 'GGG', copyNumber: 5 },
  ],
};

/**
 * Find the closest host tRNA pool for a phage host string.
 */
export function findTrnaPool(host: string): typeof DEFAULT_TRNA_POOLS[keyof typeof DEFAULT_TRNA_POOLS] | undefined {
  const normalized = host.toLowerCase();
  for (const key of Object.keys(DEFAULT_TRNA_POOLS)) {
    if (normalized.includes(key)) return DEFAULT_TRNA_POOLS[key];
  }
  return undefined;
}

/**
 * Compute intrinsic CAI for a gene using the phage's own codon usage as the
 * reference. For each amino acid, the most-used synonymous codon gets weight 1;
 * others are weighted by relative frequency.
 */
export function calculateIntrinsicCai(
  geneCodonCounts: Record<string, number>,
  phageCodonCounts: Record<string, number>
): number {
  const codonToAa: Record<string, string> = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
    CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
    GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
    CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
    GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
    CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
    GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
    CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
    GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
  };

  // Determine the most-used codon per amino acid from phage counts.
  const maxByAa: Record<string, number> = {};
  for (const [codon, count] of Object.entries(phageCodonCounts)) {
    const aa = codonToAa[codon];
    if (!aa || aa === '*') continue;
    maxByAa[aa] = Math.max(maxByAa[aa] ?? 0, count);
  }

  let logSum = 0;
  let totalCodons = 0;
  for (const [codon, count] of Object.entries(geneCodonCounts)) {
    const aa = codonToAa[codon];
    if (!aa || aa === '*') continue;
    const max = maxByAa[aa];
    if (!max || count <= 0) continue;
    const phageCount = phageCodonCounts[codon] ?? 0;
    const weight = phageCount / max;
    if (weight <= 0) continue;
    logSum += count * Math.log(weight);
    totalCodons += count;
  }

  if (totalCodons === 0) return 0;
  return Math.exp(logSum / totalCodons);
}

/**
 * Compute a simplified tAI for a gene using a host tRNA copy-number pool.
 * For each codon, we sum copy numbers of tRNAs recognizing it via canonical
 * wobble, then take the geometric mean across all codons in the gene.
 */
export function calculateTai(
  geneCodonCounts: Record<string, number>,
  pool: typeof DEFAULT_TRNA_POOLS[keyof typeof DEFAULT_TRNA_POOLS]
): number {
  const codonToAa: Record<string, string> = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
    CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
    GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
    CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
    GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
    CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
    GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
    CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
    GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
  };

  const weightByCodon: Record<string, number> = {};
  for (const entry of pool) {
    weightByCodon[entry.codon] = (weightByCodon[entry.codon] ?? 0) + entry.copyNumber;
  }

  // Normalize by the maximum weight across all codons.
  const maxWeight = Math.max(1, ...Object.values(weightByCodon));

  let logSum = 0;
  let totalCodons = 0;
  for (const [codon, count] of Object.entries(geneCodonCounts)) {
    if (count <= 0) continue;
    const aa = codonToAa[codon];
    // Skip stop codons and any unrecognized/ambiguous codons.
    if (!aa || aa === '*') continue;
    const weight = (weightByCodon[codon] ?? 0.1) / maxWeight;
    if (weight <= 0) continue;
    logSum += count * Math.log(Math.max(weight, 0.001));
    totalCodons += count;
  }

  if (totalCodons === 0) return 0;
  return Math.exp(logSum / totalCodons);
}

function proteinKmerHashEmbedding(aa: string, options?: { k?: number; dims?: number }): number[] {
  const k = options?.k ?? 3;
  const dims = options?.dims ?? 256;
  const vec = new Array<number>(dims).fill(0);
  const seq = aa.toUpperCase();
  if (seq.length < k) return vec;

  for (let i = 0; i <= seq.length - k; i++) {
    let hash = 2166136261; // FNV-1a
    let hasInvalid = false;
    for (let j = 0; j < k; j++) {
      const code = seq.charCodeAt(i + j);
      // Skip kmers that contain stop/unknowns (common in partial translations)
      if (code < 65 || code > 90 || code === 42) {
        hasInvalid = true;
        break;
      }
      hash ^= code;
      hash = Math.imul(hash, 16777619);
    }
    if (hasInvalid) continue;
    vec[(hash >>> 0) % dims] += 1;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

interface HeuristicDefenseHit {
  geneId: number;
  locusTag: string | null;
  systemType: string;
  systemFamily: string | null;
  targetSystem: string | null;
  mechanism: string;
  confidence: number;
}

/**
 * Lightweight heuristic scan for phage-encoded anti-defense systems.
 *
 * This is intentionally simple: it looks for known gene names / product keywords
 * so the `defense_systems` table is populated during a local `bun run build:db`.
 * A full annotation pipeline (InterPro/Pfam, AcrDB, DefenseFinder) can replace
 * these heuristics later.
 */
interface HeuristicAmgHit {
  geneId: number;
  locusTag: string | null;
  amgType: string;
  keggOrtholog: string | null;
  pathwayName: string;
  confidence: number;
  evidence: string;
}

export function detectAuxiliaryMetabolicGenes(
  geneRows: Array<{
    id: number;
    name: string | null;
    locusTag: string | null;
    product: string | null;
    type: string | null;
  }>
): HeuristicAmgHit[] {
  const rules: Array<{
    pattern: RegExp;
    amgType: string;
    keggOrtholog: string | null;
    pathwayName: string;
    confidence: number;
  }> = [
    { pattern: /\bpsba\b|photosystem ii.*d1 protein/i, amgType: 'photosynthesis', keggOrtholog: 'K02703', pathwayName: 'Photosynthesis', confidence: 0.9 },
    { pattern: /\bpsbd\b|photosystem ii.*d2 protein/i, amgType: 'photosynthesis', keggOrtholog: 'K02706', pathwayName: 'Photosynthesis', confidence: 0.9 },
    { pattern: /\bphoh\b|phosphate starvation.*phoh/i, amgType: 'phosphorus-metabolism', keggOrtholog: 'K06217', pathwayName: 'Phosphonate and phosphinate metabolism', confidence: 0.8 },
    { pattern: /\bmazg\b|nucleoside triphosphate pyrophosphohydrolase/i, amgType: 'nucleotide-metabolism', keggOrtholog: 'K02428', pathwayName: 'Purine metabolism', confidence: 0.8 },
    { pattern: /\bnrda\b|ribonucleoside.diphosphate reductase.*alpha/i, amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.85 },
    { pattern: /\bnrdb\b|ribonucleoside.diphosphate reductase.*beta/i, amgType: 'nucleotide-metabolism', keggOrtholog: 'K00526', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.85 },
    { pattern: /\bthya\b|thymidylate synthase/i, amgType: 'nucleotide-metabolism', keggOrtholog: 'K00560', pathwayName: 'Pyrimidine metabolism', confidence: 0.85 },
    { pattern: /\bdut\b|dutp diphosphatase|dutpase/i, amgType: 'nucleotide-metabolism', keggOrtholog: 'K01520', pathwayName: 'Pyrimidine metabolism', confidence: 0.85 },
  ];

  const hits: HeuristicAmgHit[] = [];
  for (const gene of geneRows) {
    if (gene.type !== 'CDS') continue;
    const annotation = `${gene.name ?? ''} ${gene.product ?? ''}`.trim();
    for (const rule of rules) {
      if (!rule.pattern.test(annotation)) continue;
      hits.push({
        geneId: gene.id,
        locusTag: gene.locusTag,
        amgType: rule.amgType,
        keggOrtholog: rule.keggOrtholog,
        pathwayName: rule.pathwayName,
        confidence: rule.confidence,
        evidence: JSON.stringify({ source: 'heuristic-keyword', annotation }),
      });
      break;
    }
  }
  return hits;
}

function detectDefenseSystems(
  geneRows: Array<{ id: number; name: string | null; locusTag: string | null; product: string | null; type: string | null }>
): HeuristicDefenseHit[] {
  const hits: HeuristicDefenseHit[] = [];
  const haystackFor = (g: typeof geneRows[0]) =>
    `${g.name ?? ''} ${g.locusTag ?? ''} ${g.product ?? ''}`.toLowerCase();

  for (const g of geneRows) {
    if (g.type !== 'CDS') continue;
    const hay = haystackFor(g);

    // Anti-CRISPR proteins (Acr family). Note: Ocr is an anti-restriction
    // protein, so it is handled in the anti-RM block, not here.
    const antiCrisprPattern = /(?:\b|_)acr[0-9]?[a-z]{0,4}\b|\banti.crispr\b|\banti.cas\b/;
    if (antiCrisprPattern.test(hay)) {
      const family = /\bacr([iv]?[a-z]*\d+[a-z]*)\b/.exec(hay)?.[1]?.toUpperCase() ?? null;
      const targetSystem = family
        ? `Type ${family.replace(/\d+$/, '')} CRISPR-Cas`
        : 'CRISPR-Cas';
      hits.push({
        geneId: g.id,
        locusTag: g.locusTag,
        systemType: 'anti-CRISPR',
        systemFamily: family,
        targetSystem,
        mechanism: 'Inhibits CRISPR-Cas surveillance via direct protein interaction or DNA mimicry',
        confidence: 0.6,
      });
    }

    // Anti-restriction / anti-modification (including Ocr, a classic anti-RM
    // protein found e.g. in T7-like phages).
    if (/\banti.restriction\b|\banti.modification\b|\bdar[a-z]?\b|\bocr\b/.test(hay)) {
      let systemFamily: string | null = null;
      if (hay.includes('dar')) systemFamily = 'Dar';
      else if (hay.includes('ocr')) systemFamily = 'Ocr';
      hits.push({
        geneId: g.id,
        locusTag: g.locusTag,
        systemType: 'anti-RM',
        systemFamily,
        targetSystem: 'Type I/II/III restriction-modification',
        mechanism: 'Blocks host restriction enzyme cleavage or modification',
        confidence: 0.55,
      });
    }

    // Abortive infection (anti-Abi)
    if (/\banti.abi\b|\babortive infection\b|\babi[a-z]?\b/.test(hay)) {
      hits.push({
        geneId: g.id,
        locusTag: g.locusTag,
        systemType: 'anti-Abi',
        systemFamily: null,
        targetSystem: 'Abortive infection systems',
        mechanism: 'Protects against host abortive infection defense',
        confidence: 0.5,
      });
    }
  }

  return hits;
}

async function main() {
  console.log('Building phage database...\n');

  // Create/overwrite database
  const sqlite = new Database(DB_PATH);
  const db = drizzle(sqlite);

  // Create tables using raw SQL (Drizzle's createTable isn't available in all versions)
  console.log('Creating tables...');

  sqlite.exec(`
    DROP TABLE IF EXISTS codon_adaptation;
    DROP TABLE IF EXISTS host_trna_pools;
    DROP TABLE IF EXISTS defense_systems;
    DROP TABLE IF EXISTS amg_annotations;
    DROP TABLE IF EXISTS protein_domains;
    DROP TABLE IF EXISTS annotation_meta;
    DROP TABLE IF EXISTS preferences;
    DROP TABLE IF EXISTS fold_embeddings;
    DROP TABLE IF EXISTS tropism_predictions;
    DROP TABLE IF EXISTS models;
    DROP TABLE IF EXISTS codon_usage;
    DROP TABLE IF EXISTS genes;
    DROP TABLE IF EXISTS sequences;
    DROP TABLE IF EXISTS phages;

    CREATE TABLE phages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE,
      name TEXT NOT NULL,
      accession TEXT UNIQUE NOT NULL,
      family TEXT,
      genus TEXT,
      host TEXT,
      morphology TEXT,
      lifecycle TEXT,
      genome_length INTEGER,
      genome_type TEXT,
      gc_content REAL,
      baltimore_group TEXT,
      description TEXT,
      pdb_ids TEXT,
      tags TEXT,
      last_updated INTEGER
    );

    CREATE TABLE sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      chunk_index INTEGER NOT NULL,
      sequence TEXT NOT NULL,
      UNIQUE(phage_id, chunk_index)
    );
    CREATE INDEX idx_sequences_phage ON sequences(phage_id);

    CREATE TABLE genes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      name TEXT,
      locus_tag TEXT,
      start_pos INTEGER NOT NULL,
      end_pos INTEGER NOT NULL,
      strand TEXT,
      product TEXT,
      type TEXT,
      qualifiers TEXT
    );
    CREATE INDEX idx_genes_phage ON genes(phage_id);
    CREATE INDEX idx_genes_position ON genes(phage_id, start_pos, end_pos);

    CREATE TABLE codon_usage (
      phage_id INTEGER PRIMARY KEY REFERENCES phages(id),
      aa_counts TEXT NOT NULL,
      codon_counts TEXT NOT NULL
    );

    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      role TEXT NOT NULL,
      pdb_id TEXT,
      source TEXT NOT NULL,
      obj_data BLOB,
      ascii_frames TEXT,
      meta TEXT
    );
    CREATE INDEX idx_models_phage ON models(phage_id);

    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE tropism_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      gene_id INTEGER REFERENCES genes(id),
      locus_tag TEXT,
      receptor TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence TEXT,
      source TEXT NOT NULL
    );
    CREATE INDEX idx_tropism_phage ON tropism_predictions(phage_id);
    CREATE INDEX idx_tropism_gene ON tropism_predictions(gene_id);

    CREATE TABLE fold_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      gene_id INTEGER NOT NULL REFERENCES genes(id),
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      meta TEXT,
      created_at INTEGER
    );
    CREATE INDEX idx_fold_embeddings_phage ON fold_embeddings(phage_id);
    CREATE INDEX idx_fold_embeddings_gene ON fold_embeddings(gene_id);
    CREATE UNIQUE INDEX uniq_fold_embeddings_gene_model ON fold_embeddings(gene_id, model);

    -- Annotation tables (populated by annotation pipeline)
    CREATE TABLE annotation_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE protein_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      gene_id INTEGER REFERENCES genes(id),
      locus_tag TEXT,
      domain_id TEXT NOT NULL,
      domain_name TEXT,
      domain_type TEXT,
      start INTEGER,
      end INTEGER,
      score REAL,
      e_value REAL,
      description TEXT
    );
    CREATE INDEX idx_domains_phage ON protein_domains(phage_id);
    CREATE INDEX idx_domains_gene ON protein_domains(gene_id);
    CREATE INDEX idx_domains_domain ON protein_domains(domain_id);

    CREATE TABLE amg_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      gene_id INTEGER REFERENCES genes(id),
      locus_tag TEXT,
      amg_type TEXT NOT NULL,
      kegg_ortholog TEXT,
      kegg_reaction TEXT,
      kegg_pathway TEXT,
      pathway_name TEXT,
      confidence REAL,
      evidence TEXT
    );
    CREATE INDEX idx_amg_phage ON amg_annotations(phage_id);
    CREATE INDEX idx_amg_type ON amg_annotations(amg_type);

    CREATE TABLE defense_systems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      gene_id INTEGER REFERENCES genes(id),
      locus_tag TEXT,
      system_type TEXT NOT NULL,
      system_family TEXT,
      target_system TEXT,
      mechanism TEXT,
      confidence REAL,
      source TEXT
    );
    CREATE INDEX idx_defense_phage ON defense_systems(phage_id);
    CREATE INDEX idx_defense_type ON defense_systems(system_type);

    CREATE TABLE host_trna_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_name TEXT NOT NULL,
      host_tax_id INTEGER,
      anticodon TEXT NOT NULL,
      amino_acid TEXT NOT NULL,
      codon TEXT,
      copy_number INTEGER,
      relative_abundance REAL
    );
    CREATE INDEX idx_trna_host ON host_trna_pools(host_name);
    CREATE INDEX idx_trna_anticodon ON host_trna_pools(anticodon);

    CREATE TABLE codon_adaptation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phage_id INTEGER NOT NULL REFERENCES phages(id),
      host_name TEXT NOT NULL,
      gene_id INTEGER REFERENCES genes(id),
      locus_tag TEXT,
      cai REAL,
      tai REAL,
      cpb REAL,
      enc_prime REAL
    );
    CREATE INDEX idx_adaptation_phage ON codon_adaptation(phage_id);
    CREATE INDEX idx_adaptation_host ON codon_adaptation(host_name);
  `);

  console.log('Tables created.\n');

  // Insert default host tRNA pools (used for tAI approximation).
  for (const [hostKey, pool] of Object.entries(DEFAULT_TRNA_POOLS)) {
    await db.insert(hostTrnaPools).values(
      pool.map((entry) => ({
        hostName: hostKey,
        hostTaxId: null,
        anticodon: entry.anticodon,
        aminoAcid: entry.aminoAcid,
        codon: entry.codon,
        copyNumber: entry.copyNumber,
        relativeAbundance: null,
      }))
    );
    console.log(`  Inserted ${pool.length} default tRNA pool entries for ${hostKey}`);
  }

  // Process each phage in the catalog
  for (const entry of PHAGE_CATALOG) {
    console.log(`\nProcessing ${entry.name} (${entry.accession})...`);

    let sequenceData: NCBISequenceResult;

    try {
      // Fetch sequence from NCBI
      sequenceData = await fetchPhageSequence(entry.accession);
      console.log(`  Fetched: ${sequenceData.length} bp, ${sequenceData.features.length} features`);
    } catch (error) {
      console.error(`  ERROR fetching ${entry.accession}:`, error);
      continue;
    }

    // Run database operations in a transaction
    try {
      sqlite.exec('BEGIN IMMEDIATE');

      // Insert phage record
      const [phageRecord] = await db
        .insert(phages)
        .values({
          slug: entry.slug,
          name: entry.name,
          accession: entry.accession,
          family: entry.family,
          genus: entry.genus,
          host: entry.host,
          morphology: entry.morphology,
          lifecycle: entry.lifecycle,
          genomeLength: sequenceData.length,
          genomeType: entry.genomeType,
          gcContent: sequenceData.gcContent,
          baltimoreGroup: entry.baltimoreGroup,
          description: entry.description,
          pdbIds: entry.pdbIds ? JSON.stringify(entry.pdbIds) : null,
          lastUpdated: Date.now(),
        })
        .returning({ id: phages.id });

      const phageId = phageRecord.id;
      console.log(`  Inserted phage record (id: ${phageId})`);

      // Insert PDB structure references from the catalog so the 3D viewer knows
      // which structures are available without fetching metadata first.
      if (entry.pdbIds && entry.pdbIds.length > 0) {
        const modelValues = entry.pdbIds.map((pdbId) => ({
          phageId,
          role: 'structure',
          pdbId,
          source: 'pdb',
          meta: JSON.stringify({
            url: `https://www.rcsb.org/structure/${pdbId}`,
            fetched: false,
          }),
        }));
        await db.insert(models).values(modelValues);
        console.log(`  Inserted ${modelValues.length} PDB references`);
      }

      // Insert sequence chunks (batched for performance)
      const seq = sequenceData.sequence;
      const numChunks = Math.ceil(seq.length / CHUNK_SIZE);
      const seqChunks: Array<{ phageId: number; chunkIndex: number; sequence: string }> = [];

      for (let i = 0; i < numChunks; i++) {
        seqChunks.push({
          phageId,
          chunkIndex: i,
          sequence: seq.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        });
      }

      // Insert in batches
      for (let i = 0; i < seqChunks.length; i += BATCH_INSERT_SIZE) {
        const batch = seqChunks.slice(i, i + BATCH_INSERT_SIZE);
        await db.insert(sequences).values(batch);
      }
      console.log(`  Inserted ${numChunks} sequence chunks`);

      // Insert gene annotations (batched for performance)
      const geneValues: Array<{
        phageId: number;
        name: string | null;
        locusTag: string | null;
        startPos: number;
        endPos: number;
        strand: string | null;
        product: string | null;
        type: string | null;
        qualifiers: string;
      }> = [];

      for (const feature of sequenceData.features) {
        const qualObj = feature.qualifiers || {};
        
        // If segments exist, store them in qualifiers so we don't lose the structure
        if (feature.segments && feature.segments.length > 1) {
          qualObj['_segments'] = JSON.stringify(feature.segments);
          
          // Multi-segment feature (e.g. wrap-around or join)
          // Insert a row for each segment to avoid implying coverage of the gap/intron
          for (const segment of feature.segments) {
            geneValues.push({
              phageId,
              name: feature.gene || null,
              locusTag: feature.locusTag || null,
              startPos: segment.start,
              endPos: segment.end,
              strand: feature.strand,
              product: feature.product || null,
              type: feature.type,
              qualifiers: JSON.stringify(qualObj),
            });
          }
        } else {
          // Single feature
          geneValues.push({
            phageId,
            name: feature.gene || null,
            locusTag: feature.locusTag || null,
            startPos: feature.start,
            endPos: feature.end,
            strand: feature.strand,
            product: feature.product || null,
            type: feature.type,
            qualifiers: JSON.stringify(qualObj),
          });
        }
      }

      for (let i = 0; i < geneValues.length; i += BATCH_INSERT_SIZE) {
        const batch = geneValues.slice(i, i + BATCH_INSERT_SIZE);
        await db.insert(genes).values(batch);
      }
      console.log(`  Inserted ${geneValues.length} gene annotations`);

      // Insert simple protein embeddings for CDS genes (used by FoldQuickview)
      // Note: This is a lightweight, deterministic hash embedding (not a true structure model).
      const insertedGenes = await db
        .select({
          id: genes.id,
          startPos: genes.startPos,
          endPos: genes.endPos,
          strand: genes.strand,
          name: genes.name,
          locusTag: genes.locusTag,
          product: genes.product,
          type: genes.type,
          qualifiers: genes.qualifiers,
        })
        .from(genes)
        .where(eq(genes.phageId, phageId));

      const embeddingModel = 'protein-k3-hash-v1';
      const embeddingDims = 256;
      const now = Date.now();
      const embeddingValues: Array<{
        phageId: number;
        geneId: number;
        model: string;
        dims: number;
        vector: Uint8Array;
        meta: string;
        createdAt: number;
      }> = [];

      for (const g of insertedGenes) {
        if (g.type !== 'CDS') continue;
        const dna = getSplicedCodingSequence(seq, g);
        const aa = translateSequence(dna, 0);
        const vector = proteinKmerHashEmbedding(aa, { k: 3, dims: embeddingDims });
        embeddingValues.push({
          phageId,
          geneId: g.id,
          model: embeddingModel,
          dims: embeddingDims,
          vector: encodeFloat32VectorLE(vector),
          meta: JSON.stringify({ k: 3, dims: embeddingDims, source: 'hash-kmer' }),
          createdAt: now,
        });
      }

      for (let i = 0; i < embeddingValues.length; i += BATCH_INSERT_SIZE) {
        const batch = embeddingValues.slice(i, i + BATCH_INSERT_SIZE);
        await db.insert(foldEmbeddings).values(batch);
      }
      console.log(`  Inserted ${embeddingValues.length} fold embeddings (${embeddingModel})`);

      // Heuristic scan for phage-encoded anti-defense systems
      const defenseHits = detectDefenseSystems(insertedGenes);
      if (defenseHits.length > 0) {
        const defenseValues = defenseHits.map((hit) => ({
          phageId,
          geneId: hit.geneId,
          locusTag: hit.locusTag,
          systemType: hit.systemType,
          systemFamily: hit.systemFamily,
          targetSystem: hit.targetSystem,
          mechanism: hit.mechanism,
          confidence: hit.confidence,
          source: 'heuristic',
        }));
        await db.insert(defenseSystems).values(defenseValues);
        console.log(`  Inserted ${defenseValues.length} heuristic defense-system predictions`);
      }

      const amgHits = detectAuxiliaryMetabolicGenes(insertedGenes);
      if (amgHits.length > 0) {
        await db.insert(amgAnnotations).values(amgHits.map((hit) => ({
          phageId,
          geneId: hit.geneId,
          locusTag: hit.locusTag,
          amgType: hit.amgType,
          keggOrtholog: hit.keggOrtholog,
          keggReaction: null,
          keggPathway: null,
          pathwayName: hit.pathwayName,
          confidence: hit.confidence,
          evidence: hit.evidence,
        })));
        console.log(`  Inserted ${amgHits.length} heuristic AMG predictions`);
      }

      // Calculate and insert codon usage
      // We must calculate this from the CDS features, not the raw genome frame 0
      const totalCodonCounts: Record<string, number> = {};
      const totalAACounts: Record<string, number> = {};

      for (const feature of sequenceData.features) {
        if (feature.type === 'CDS') {
          let cdsSeq = '';
          
          if (feature.segments && feature.segments.length > 1) {
             // Concatenate segments
             for (const segment of feature.segments) {
                cdsSeq += seq.substring(segment.start, segment.end);
             }
          } else {
             cdsSeq = seq.substring(feature.start, feature.end);
          }
          
          if (feature.strand === '-') {
            cdsSeq = reverseComplement(cdsSeq);
          }
          
          const codonCounts = countCodonUsage(cdsSeq, 0);
          const aaSeq = translateSequence(cdsSeq, 0);
          const aaCounts = countAminoAcidUsage(aaSeq);
          
          // Accumulate
          for (const [codon, count] of Object.entries(codonCounts)) {
            totalCodonCounts[codon] = (totalCodonCounts[codon] || 0) + count;
          }
          for (const [aa, count] of Object.entries(aaCounts)) {
            totalAACounts[aa] = (totalAACounts[aa] || 0) + count;
          }
        }
      }

      await db.insert(codonUsage).values({
        phageId,
        aaCounts: JSON.stringify(totalAACounts),
        codonCounts: JSON.stringify(totalCodonCounts),
      });
      console.log(`  Calculated codon usage from CDS features`);

      // Compute intrinsic codon-adaptation metrics from the phage's own codon usage.
      const nc = calculateNc(totalCodonCounts);
      await db.insert(codonAdaptation).values({
        phageId,
        hostName: 'intrinsic',
        geneId: null,
        locusTag: null,
        cai: null,
        tai: null,
        cpb: null,
        encPrime: nc,
      });
      console.log(`  Computed intrinsic Nc (enc_prime): ${nc.toFixed(2)}`);

      // Per-gene intrinsic CAI and host-specific tAI (where a default pool exists).
      const trnaPool = findTrnaPool(entry.host);
      const caiValues: Array<{
        phageId: number;
        hostName: string;
        geneId: number;
        locusTag: string | null;
        cai: number | null;
        tai: number | null;
        cpb: number | null;
        encPrime: number | null;
      }> = [];

      for (const g of insertedGenes) {
        if (g.type !== 'CDS') continue;
        const dna = getSplicedCodingSequence(seq, g);
        const geneCodonCounts = countCodonUsage(dna, 0);
        const cai = calculateIntrinsicCai(geneCodonCounts, totalCodonCounts);
        const tai = trnaPool ? calculateTai(geneCodonCounts, trnaPool) : null;
        caiValues.push({
          phageId,
          hostName: trnaPool ? entry.host : 'self-reference',
          geneId: g.id,
          locusTag: g.locusTag,
          cai,
          tai,
          cpb: null,
          encPrime: null,
        });
      }

      for (let i = 0; i < caiValues.length; i += BATCH_INSERT_SIZE) {
        const batch = caiValues.slice(i, i + BATCH_INSERT_SIZE);
        await db.insert(codonAdaptation).values(batch);
      }
      console.log(`  Computed per-gene CAI${trnaPool ? ' and tAI' : ''} for ${caiValues.length} CDS genes`);

      sqlite.exec('COMMIT');
    } catch (txError) {
      sqlite.exec('ROLLBACK');
      console.error(`  ERROR inserting ${entry.accession} into DB:`, txError);
    }

    // Small delay between fetches to be nice to NCBI
    await new Promise(r => setTimeout(r, 500));
  }

  // Insert default preferences
  await db.insert(preferences).values({ key: 'theme', value: 'holographic' });
  await db.insert(preferences).values({ key: 'show3DModel', value: 'true' });

  // Optional: load precomputed tropism predictions (embedding-based) if available
  if (existsSync(TROPISM_PATH)) {
    console.log('\nLoading tropism predictions from', TROPISM_PATH);
    try {
      const raw = readFileSync(TROPISM_PATH, 'utf8');
      const data = JSON.parse(raw) as Array<{
        phageSlug?: string;
        accession?: string;
        locusTag?: string;
        receptor: string;
        confidence: number;
        evidence?: string[];
        source?: string;
      }>;

      // Build lookup for phage slug/accession -> id
      const phageRows = await db.select({ id: phages.id, slug: phages.slug, accession: phages.accession }).from(phages);
      const bySlug = new Map<string, number>();
      const byAcc = new Map<string, number>();
      phageRows.forEach(p => {
        if (p.slug) bySlug.set(p.slug.toLowerCase(), p.id);
        byAcc.set(p.accession.toLowerCase(), p.id);
      });

      // Build lookup for genes per phage
      const geneRows = await db.select({ id: genes.id, phageId: genes.phageId, locusTag: genes.locusTag, name: genes.name }).from(genes);
      const geneMap = new Map<number, Map<string, number>>();
      geneRows.forEach(g => {
        const key = g.phageId;
        if (!geneMap.has(key)) geneMap.set(key, new Map());
        const map = geneMap.get(key)!;
        if (g.locusTag) map.set(g.locusTag.toLowerCase(), g.id);
        if (g.name) map.set(g.name.toLowerCase(), g.id);
      });

      // Collect all valid tropism prediction values
      const tropismValues: Array<{
        phageId: number;
        geneId: number | null;
        locusTag: string | null;
        receptor: string;
        confidence: number;
        evidence: string | null;
        source: string;
      }> = [];

      for (const row of data) {
        const phageId =
          (row.phageSlug && bySlug.get(row.phageSlug.toLowerCase())) ||
          (row.accession && byAcc.get(row.accession.toLowerCase()));
        if (!phageId) continue;
        const geneId = row.locusTag
          ? geneMap.get(phageId)?.get(row.locusTag.toLowerCase()) ?? null
          : null;
        tropismValues.push({
          phageId,
          geneId,
          locusTag: row.locusTag ?? null,
          receptor: row.receptor,
          confidence: row.confidence,
          evidence: row.evidence ? JSON.stringify(row.evidence) : null,
          source: row.source ?? 'embedding',
        });
      }

      // Insert in batches for performance
      for (let i = 0; i < tropismValues.length; i += BATCH_INSERT_SIZE) {
        const batch = tropismValues.slice(i, i + BATCH_INSERT_SIZE);
        await db.insert(tropismPredictions).values(batch);
      }
      console.log(`Inserted ${tropismValues.length} tropism predictions`);
    } catch (err) {
      console.error('Failed to load tropism predictions:', err);
    }
  } else {
    console.log('\nNo tropism embedding file found; skipping tropism_predictions import.');
  }

  sqlite.close();

  // Populate or update anti-CRISPR annotations if ESM2 fold_embeddings exist
  updateAntiCrisprInDatabase(DB_PATH);

  // Derive domain-based defense and AMG annotations from Pfam protein_domains
  const domainSqlite = new Database(DB_PATH);
  const domainStats = updateDomainAnnotations(domainSqlite);
  domainSqlite.close();
  console.log(`Derived domain annotations: ${domainStats.defenseCount} defense hits (${domainStats.defensePhages} phages), ${domainStats.amgCount} AMG hits (${domainStats.amgPhages} phages)`);

  console.log('\n========================================');
  console.log(`Database created: ${DB_PATH}`);
  console.log(`Total phages: ${PHAGE_CATALOG.length}`);
  console.log('========================================\n');
}

if (import.meta.main) main().catch(console.error);
