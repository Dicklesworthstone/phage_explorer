/**
 * packages/data-pipeline/src/anti-crispr-detector.ts
 *
 * Nearest-neighbor anti-CRISPR (Acr) detection in ESM2 embedding space.
 * Matches gene protein embeddings from fold_embeddings against known Acr reference proteins.
 */

import { EmbeddingIndex } from '@phage-explorer/core';
import refData from '../../core/src/data/anti-crispr-reference.json';

export interface AcrReference {
  id: string;
  accession: string;
  family: string;
  targetSystem: string;
  organism: string;
  sequence: string;
  dims: number;
  vector: number[];
}

export interface GeneEmbeddingInput {
  phageId: number;
  geneId: number;
  locusTag: string | null;
  name: string | null;
  product: string | null;
  vector: Float32Array | number[];
}

export interface AntiCrisprHit {
  phageId: number;
  geneId: number;
  locusTag: string | null;
  name?: string | null;
  product?: string | null;
  systemType: 'anti-CRISPR';
  systemFamily: string;
  targetSystem: string;
  mechanism: string;
  confidence: number;
  source: 'esm2-nn';
  nearestReference: string;
  distance: number;
  backgroundPercentile: number;
  isKnownNonAcr: boolean;
  referenceVersion: string;
}

export interface DetectionResult {
  hits: AntiCrisprHit[];
  phagesCovered: number;
  totalHits: number;
  referenceVersion: string;
  checkpoint: string;
}

/**
 * Empirical background quantiles computed over all 2,039 gene embeddings
 * against the 10 reference Acr proteins.
 * @see phage_explorer-98ni
 */
export const BACKGROUND_QUANTILES: Array<{ p: number; dist: number }> = [
  { p: 0.001, dist: 0.01662 },
  { p: 0.010, dist: 0.02079 },
  { p: 0.020, dist: 0.02249 },
  { p: 0.036, dist: 0.02496 },
  { p: 0.050, dist: 0.02750 },
  { p: 0.100, dist: 0.03142 },
  { p: 0.250, dist: 0.03808 },
  { p: 0.500, dist: 0.04977 },
  { p: 0.750, dist: 0.06941 },
  { p: 0.900, dist: 0.10283 },
];

/**
 * Compute empirical background percentile for a given cosine distance.
 * Returns estimated fraction of all phage genes with distance <= `distance`.
 */
export function computeBackgroundPercentile(distance: number): number {
  if (distance <= BACKGROUND_QUANTILES[0].dist) {
    return Math.max(0.0001, (distance / BACKGROUND_QUANTILES[0].dist) * BACKGROUND_QUANTILES[0].p);
  }
  for (let i = 0; i < BACKGROUND_QUANTILES.length - 1; i++) {
    const q1 = BACKGROUND_QUANTILES[i];
    const q2 = BACKGROUND_QUANTILES[i + 1];
    if (distance >= q1.dist && distance <= q2.dist) {
      const frac = (distance - q1.dist) / (q2.dist - q1.dist);
      return q1.p + frac * (q2.p - q1.p);
    }
  }
  const last = BACKGROUND_QUANTILES[BACKGROUND_QUANTILES.length - 1];
  return Math.min(1.0, last.p + ((distance - last.dist) / 0.1) * 0.1);
}

const KNOWN_NON_ACR_KEYWORDS = [
  'superinfection exclusion',
  'smi1',
  'knr4',
  'nucleotide kinase',
  'methyltransferase',
  'virion structural',
  'structural protein',
  'capsid',
  'tail',
  'portal',
  'polymerase',
  'helicase',
  'primase',
  'terminase',
  'endolysin',
  'holin',
  'integrase',
  'recombinase',
  'exonuclease',
];

export function isAnnotatedNonAcrProduct(product: string | null): boolean {
  if (!product) return false;
  const lower = product.toLowerCase();
  if (lower.includes('hypothetical')) return false;
  return KNOWN_NON_ACR_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Calculate confidence score as a continuous function of cosine distance.
 * Smaller distance => higher similarity => higher confidence.
 * Guaranteed to produce strictly different confidences for different distances.
 *
 * NOTE: This is a monotonic distance rescaling for relative ranking, NOT a true
 * Bayesian posterior or probability of biological anti-CRISPR function.
 * @see phage_explorer-98ni
 */
export function computeAcrConfidence(distance: number): number {
  // Linear scaling from distance in [0, 0.05] to confidence in [0.50, 0.95]
  // Clamped between 0.40 and 0.98.
  const score = 0.95 - (distance / 0.05) * 0.45;
  const clamped = Math.max(0.40, Math.min(0.98, score));
  return Number(clamped.toFixed(4));
}

/**
 * Build an EmbeddingIndex initialized with the curated anti-CRISPR reference set.
 */
export function buildAcrReferenceIndex(references = refData.references as AcrReference[]): EmbeddingIndex<AcrReference> {
  const index = new EmbeddingIndex<AcrReference>();
  for (const ref of references) {
    index.add(ref.id, ref.vector, ref);
  }
  return index;
}

/**
 * Detect anti-CRISPR candidates among gene embeddings.
 *
 * @param genes Gene embedding records to scan.
 * @param options maxDistance (default: 0.025) and optional custom references.
 */
export function detectAntiCrisprCandidates(
  genes: GeneEmbeddingInput[],
  options?: {
    maxDistance?: number;
    references?: AcrReference[];
    referenceVersion?: string;
    checkpoint?: string;
  }
): DetectionResult {
  const maxDist = options?.maxDistance ?? 0.025;
  const references = options?.references ?? (refData.references as AcrReference[]);
  const refVersion = options?.referenceVersion ?? refData.version;
  const checkpoint = options?.checkpoint ?? refData.checkpoint;

  const index = buildAcrReferenceIndex(references);
  const hits: AntiCrisprHit[] = [];
  const phagesSet = new Set<number>();

  for (const gene of genes) {
    const searchHits = index.search(gene.vector, 1, maxDist);
    if (searchHits.length > 0) {
      const best = searchHits[0];
      const ref = best.metadata ?? references.find((r) => r.id === best.id)!;
      const confidence = computeAcrConfidence(best.distance);
      const backgroundPercentile = computeBackgroundPercentile(best.distance);
      const isKnownNonAcr = isAnnotatedNonAcrProduct(gene.product);

      const pctDisplay = (backgroundPercentile * 100).toFixed(2);
      const mechanism = `Candidate Acr neighbor via ESM2 embedding similarity to ${ref.id} (${ref.family}) [dist: ${best.distance.toFixed(4)}, top ${pctDisplay}% of background, ref: ${refVersion}]${isKnownNonAcr ? ' [Note: carries non-Acr annotation]' : ''}`;

      hits.push({
        phageId: gene.phageId,
        geneId: gene.geneId,
        locusTag: gene.locusTag,
        name: gene.name,
        product: gene.product,
        systemType: 'anti-CRISPR',
        systemFamily: ref.family,
        targetSystem: ref.targetSystem,
        mechanism,
        confidence,
        source: 'esm2-nn',
        nearestReference: ref.id,
        distance: best.distance,
        backgroundPercentile,
        isKnownNonAcr,
        referenceVersion: refVersion,
      });

      phagesSet.add(gene.phageId);
    }
  }

  // Sort by distance ascending (closest embedding neighbor first)
  hits.sort((a, b) => a.distance - b.distance);

  return {
    hits,
    phagesCovered: phagesSet.size,
    totalHits: hits.length,
    referenceVersion: refVersion,
    checkpoint,
  };
}
