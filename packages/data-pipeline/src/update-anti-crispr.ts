/**
 * packages/data-pipeline/src/update-anti-crispr.ts
 *
 * Populates or refreshes the `defense_systems` table with ESM2 nearest-neighbor
 * anti-CRISPR predictions and records metadata in `annotation_meta`.
 */

import { Database } from 'bun:sqlite';
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

    // 2. Detect anti-CRISPR hits
    const maxDist = options?.maxDistance ?? 0.025;
    const result = detectAntiCrisprCandidates(geneInputs, { maxDistance: maxDist });

    // 3. Clear existing esm2-nn rows from defense_systems
    db.run(`DELETE FROM defense_systems WHERE source = 'esm2-nn'`);

    // 4. Insert new hits in a transaction
    const insertDefense = db.prepare(`
      INSERT INTO defense_systems (
        phage_id, gene_id, locus_tag, system_type, system_family,
        target_system, mechanism, confidence, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((hits) => {
      for (const hit of hits) {
        insertDefense.run(
          hit.phageId,
          hit.geneId,
          hit.locusTag,
          hit.systemType,
          hit.systemFamily,
          hit.targetSystem,
          hit.mechanism,
          hit.confidence,
          hit.source
        );
      }
    });

    insertMany(result.hits);

    // 5. Update annotation_meta
    const metaValue = JSON.stringify({
      checkpoint: result.checkpoint,
      referenceVersion: result.referenceVersion,
      referenceCount: 10,
      hits: result.totalHits,
      phagesCovered: result.phagesCovered,
      maxDistance: maxDist,
    });

    db.run(`
      INSERT OR REPLACE INTO annotation_meta (key, value, updated_at)
      VALUES (?, ?, ?)
    `, ['anti_crispr_esm2', metaValue, Date.now()]);

    console.log(
      `[anti-crispr] Successfully inserted ${result.totalHits} anti-CRISPR hits ` +
      `across ${result.phagesCovered} phages into ${dbPath}`
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
