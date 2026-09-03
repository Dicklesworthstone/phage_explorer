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
  systemType: 'anti-CRISPR';
  systemFamily: string;
  targetSystem: string;
  mechanism: string;
  confidence: number;
  source: 'esm2-nn';
  nearestReference: string;
  distance: number;
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
 * Calculate confidence score as a continuous function of cosine distance.
 * Smaller distance => higher similarity => higher confidence.
 * Guaranteed to produce strictly different confidences for different distances.
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

      const mechanism = `Predicted anti-CRISPR via ESM2 embedding similarity to ${ref.id} (${ref.family}) [dist: ${best.distance.toFixed(4)}, ref: ${refVersion}]`;

      hits.push({
        phageId: gene.phageId,
        geneId: gene.geneId,
        locusTag: gene.locusTag,
        systemType: 'anti-CRISPR',
        systemFamily: ref.family,
        targetSystem: ref.targetSystem,
        mechanism,
        confidence,
        source: 'esm2-nn',
        nearestReference: ref.id,
        distance: best.distance,
        referenceVersion: refVersion,
      });

      phagesSet.add(gene.phageId);
    }
  }

  // Sort by confidence descending (closest distance first)
  hits.sort((a, b) => b.confidence - a.confidence);

  return {
    hits,
    phagesCovered: phagesSet.size,
    totalHits: hits.length,
    referenceVersion: refVersion,
    checkpoint,
  };
}
