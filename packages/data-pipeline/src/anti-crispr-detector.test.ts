import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  computeAcrConfidence,
  detectAntiCrisprCandidates,
  buildAcrReferenceIndex,
  type AcrReference,
  type GeneEmbeddingInput,
} from './anti-crispr-detector';
import refData from '../../core/src/data/anti-crispr-reference.json';

describe('anti-crispr-detector', () => {
  it('confidence varies with distance: two different distances do not produce the same confidence', () => {
    const d1 = 0.0124;
    const d2 = 0.0180;
    const c1 = computeAcrConfidence(d1);
    const c2 = computeAcrConfidence(d2);

    expect(c1).not.toBe(c2);
    expect(c1).toBeGreaterThan(c2); // smaller distance => higher confidence

    const d3 = 0.0225;
    const c3 = computeAcrConfidence(d3);
    expect(c2).not.toBe(c3);
    expect(c2).toBeGreaterThan(c3);
  });

  it('every call carries its neighbour, distance and reference set version', () => {
    const mockRef: AcrReference = {
      id: 'AcrIIA4',
      accession: 'A0A247D711',
      family: 'AcrIIA4',
      targetSystem: 'Type II-A CRISPR-Cas',
      organism: 'Listeria',
      sequence: 'MNIND...',
      dims: 4,
      vector: [0.5, 0.5, 0.5, 0.5],
    };

    const mockGene: GeneEmbeddingInput = {
      phageId: 42,
      geneId: 101,
      locusTag: 'gp42',
      name: 'hypothetical',
      product: 'hypothetical protein',
      vector: [0.51, 0.49, 0.50, 0.50],
    };

    const result = detectAntiCrisprCandidates([mockGene], {
      maxDistance: 0.1,
      references: [mockRef],
      referenceVersion: 'test-v1',
      checkpoint: 'test-checkpoint',
    });

    expect(result.totalHits).toBe(1);
    const hit = result.hits[0];
    expect(hit.systemType).toBe('anti-CRISPR');
    expect(hit.nearestReference).toBe('AcrIIA4');
    expect(hit.systemFamily).toBe('AcrIIA4');
    expect(hit.targetSystem).toBe('Type II-A CRISPR-Cas');
    expect(hit.referenceVersion).toBe('test-v1');
    expect(hit.source).toBe('esm2-nn');
    expect(hit.distance).toBeGreaterThan(0);
    expect(hit.mechanism).toContain('AcrIIA4');
    expect(hit.mechanism).toContain('dist:');
    expect(hit.mechanism).toContain('ref: test-v1');
  });

  it('planted case: reference vector retrieves itself as nearest neighbor with dist ~0', () => {
    const references = refData.references as AcrReference[];
    const index = buildAcrReferenceIndex(references);

    const plantedRef = references[0]; // AcrIIA4
    const hits = index.search(plantedRef.vector, 2);

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].id).toBe(plantedRef.id);
    expect(hits[0].distance).toBeCloseTo(0, 5);
    expect(hits[0].similarity).toBeCloseTo(1, 5);
  });

  it('scans real phage.db embeddings and achieves coverage across > 2 of 24 phages', () => {
    const dbPath = 'packages/web/public/phage.db';
    const db = new Database(dbPath);

    const rows = db.query(`
      SELECT fe.gene_id, fe.phage_id, fe.dims, fe.vector, g.locus_tag, g.name, g.product
      FROM fold_embeddings fe
      JOIN genes g ON g.id = fe.gene_id
      WHERE fe.model = 'facebook/esm2_t6_8M_UR50D'
    `).all() as Array<{
      gene_id: number;
      phage_id: number;
      dims: number;
      vector: Uint8Array;
      locus_tag: string | null;
      name: string | null;
      product: string | null;
    }>;

    expect(rows.length).toBeGreaterThan(2000);

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

    const result = detectAntiCrisprCandidates(geneInputs, { maxDistance: 0.025 });

    // Anti-CRISPR coverage rises strictly above 2 of 24 phages
    expect(result.phagesCovered).toBeGreaterThan(2);
    expect(result.totalHits).toBeGreaterThan(20);
    expect(result.referenceVersion).toBe('acr-ref-v1');
    expect(result.checkpoint).toBe('facebook/esm2_t6_8M_UR50D');

    // Confirm that every hit has valid confidence, distance, and metadata
    for (const hit of result.hits) {
      expect(hit.systemType).toBe('anti-CRISPR');
      expect(hit.source).toBe('esm2-nn');
      expect(hit.confidence).toBeGreaterThanOrEqual(0.4);
      expect(hit.confidence).toBeLessThanOrEqual(0.98);
      expect(hit.mechanism).toContain('dist:');
      expect(hit.mechanism).toContain('ref: acr-ref-v1');
    }
  });
});
