/**
 * packages/data-pipeline/src/update-anti-crispr.ts
 *
 * Populates or refreshes the `defense_systems` table with ESM2 nearest-neighbor
 * anti-CRISPR predictions and records metadata in `annotation_meta`.
 */

import { Database } from 'bun:sqlite';
import { refreshDomainAnnotationMetadata } from './domain-annotations';
import {
  detectAntiCrisprCandidates,
  type GeneEmbeddingInput,
  type DetectionResult,
} from './anti-crispr-detector';

export function updateAntiCrisprInDatabase(
  dbPath: string,
  options?: { maxDistance?: number }
): DetectionResult {
  const db = new Database(dbPath);

  try {
    // 1. Fetch real ESM2 embeddings from fold_embeddings
    const rows = db.query(`
      SELECT fe.gene_id, fe.phage_id, fe.dims, fe.vector, g.locus_tag, g.name, g.product
      FROM fold_embeddings fe
      JOIN genes g ON g.id = fe.gene_id
      WHERE fe.model = 'facebook/esm2_t6_8M_UR50D'
      ORDER BY fe.gene_id ASC
    `).all() as Array<{
      gene_id: number;
      phage_id: number;
      dims: number;
      vector: Uint8Array;
      locus_tag: string | null;
      name: string | null;
      product: string | null;
    }>;

    if (rows.length === 0) {
      console.warn(`[anti-crispr] No facebook/esm2_t6_8M_UR50D fold_embeddings found in ${dbPath}`);
      return {
        hits: [],
        phagesCovered: 0,
        totalHits: 0,
        referenceVersion: 'none',
        checkpoint: 'none',
      };
    }

    const geneInputs: GeneEmbeddingInput[] = rows.map((r) => {
      const view = new DataView(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength);
      const vec = new Float32Array(r.dims);
      for (let i = 0; i < r.dims; i++) {
        vec[i] = view.getFloat32(i * 4, true);
      }
      return {
        phageId: r.phage_id,
        geneId: r.gene_id,
        locusTag: r.locus_tag,
        name: r.name,
        product: r.product,
        vector: vec,
      };
    });

    // 2. Detect anti-CRISPR screening candidates
    const maxDist = options?.maxDistance ?? 0.025;
    const result = detectAntiCrisprCandidates(geneInputs, { maxDistance: maxDist });

    // 3. Clear existing esm2-nn rows from defense_systems
    // As established in phage_explorer-98ni, unverified nearest neighbors have ~5% expected
    // precision and contain known non-Acr proteins (e.g. methyltransferases, kinases).
    // They are screening candidates, NOT confirmed defense system annotations.
    db.run(`DELETE FROM defense_systems WHERE source = 'esm2-nn'`);
    refreshDomainAnnotationMetadata(db);

    // 4. Update annotation_meta with calibrated screening metadata and controls
    const metaValue = JSON.stringify({
      status: 'screening_shortlist_only',
      note: 'ESM2 nearest-neighbor candidate shortlist; not confirmed identifications',
      checkpoint: result.checkpoint,
      referenceVersion: result.referenceVersion,
      referenceCount: 10,
      candidatesCount: result.totalHits,
      phagesCovered: result.phagesCovered,
      maxDistance: maxDist,
      topCandidates: result.hits.slice(0, 20).map((h) => ({
        geneId: h.geneId,
        phageId: h.phageId,
        product: h.product,
        nearestRef: h.nearestReference,
        distance: h.distance,
        backgroundPercentile: h.backgroundPercentile,
        isKnownNonAcr: h.isKnownNonAcr,
      })),
    });

    db.run(`
      INSERT OR REPLACE INTO annotation_meta (key, value, updated_at)
      VALUES (?, ?, ?)
    `, ['anti_crispr_esm2', metaValue, Date.now()]);

    console.log(
      `[anti-crispr] Calibrated screening recorded for ${result.totalHits} candidates ` +
      `across ${result.phagesCovered} phages; purged unverified esm2-nn rows from defense_systems in ${dbPath}`
    );

    return result;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dbPath = process.argv[2] ?? 'packages/web/public/phage.db';
  updateAntiCrisprInDatabase(dbPath);
}
