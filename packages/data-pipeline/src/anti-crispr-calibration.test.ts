/**
 * Anti-CRISPR ESM-2 Calibration & Quality Controls Test
 *
 * Reproduces and enforces the positive and negative control calibrations
 * for nearest-neighbor anti-CRISPR screening under ESM-2 (facebook/esm2_t6_8M_UR50D).
 *
 * Verifies:
 * 1. Positive control: Leave-one-out sensitivity over 10 Acr references (~70% at 0.025)
 *    and detects reference set incoherence (AcrIF8 and AcrIIA1 further than background median).
 * 2. Background distribution: Smooth distribution over all 2,039 phage gene embeddings,
 *    proving 0.025 cutoff is an arbitrary ~3.6% quantile, not a decision boundary.
 * 3. Negative control: Confirms that top embedding neighbors include genes with known,
 *    non-Acr functions (DNA methyltransferase, superinfection exclusion, kinase, structural),
 *    yielding an expected precision of only ~5% on rare targets.
 * 4. Production database invariant: defense_systems must not assert unverified esm2-nn
 *    screening hits as confirmed annotations with manufactured confidence.
 *
 * @see phage_explorer-98ni
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import refData from '../../core/src/data/anti-crispr-reference.json';

const REPO_ROOT = join(import.meta.dir, '../../..');
const DB_PATH = join(REPO_ROOT, 'packages/web/public/phage.db');

function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let nA = 0;
  let nB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    nA += va * va;
    nB += vb * vb;
  }
  const sim = dot / (Math.sqrt(nA) * Math.sqrt(nB));
  return 1 - sim;
}

describe('Anti-CRISPR Precision & Calibration Controls (phage_explorer-98ni)', () => {
  const refs = refData.references;

  it('positive control: leave-one-out demonstrates ~70% sensitivity and reference incoherence', () => {
    // For each of the 10 published reference Acrs, compute distance to the nearest other reference
    const looDists: Array<{ id: string; nearest: string; dist: number }> = [];

    for (let i = 0; i < refs.length; i++) {
      let minDist = Infinity;
      let nearestId = '';
      for (let j = 0; j < refs.length; j++) {
        if (i === j) continue;
        const d = cosineDistance(refs[i].vector, refs[j].vector);
        if (d < minDist) {
          minDist = d;
          nearestId = refs[j].id;
        }
      }
      looDists.push({ id: refs[i].id, nearest: nearestId, dist: minDist });
    }

    looDists.sort((a, b) => a.dist - b.dist);
    const medianLoo = looDists[Math.floor(looDists.length / 2)].dist;

    // Median held-out Acr distance is ~0.0231
    expect(medianLoo).toBeCloseTo(0.0231, 3);

    // Exactly 7 of 10 references pass the 0.025 cutoff (70% sensitivity)
    const passedCutoff = looDists.filter((r) => r.dist <= 0.025);
    expect(passedCutoff.length).toBe(7);

    // Documented incoherence: AcrIF8 and AcrIIA1 are outliers (>0.05),
    // further from all other Acrs than a typical phage gene (median background 0.0498)
    const acrIF8 = looDists.find((r) => r.id === 'AcrIF8');
    const acrIIA1 = looDists.find((r) => r.id === 'AcrIIA1');
    expect(acrIF8).toBeDefined();
    expect(acrIIA1).toBeDefined();
    expect(acrIF8!.dist).toBeGreaterThan(0.05);
    expect(acrIIA1!.dist).toBeGreaterThan(0.05);
  });

  it('background distribution: 2,039 gene embeddings form a smooth distribution with p3.6 ~ 0.025', () => {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .query<
        { gene_id: number; dims: number; vector: Uint8Array; name: string | null; product: string | null },
        []
      >(`
        SELECT fe.gene_id, fe.dims, fe.vector, g.name, g.product
        FROM fold_embeddings fe
        JOIN genes g ON g.id = fe.gene_id
        WHERE fe.model = 'facebook/esm2_t6_8M_UR50D'
      `)
      .all();

    expect(rows.length).toBe(2039);

    const minDists: number[] = [];
    for (const row of rows) {
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      const vec = new Float32Array(row.dims);
      for (let i = 0; i < row.dims; i++) vec[i] = view.getFloat32(i * 4, true);

      let minDist = Infinity;
      for (const ref of refs) {
        const d = cosineDistance(vec, ref.vector);
        if (d < minDist) minDist = d;
      }
      minDists.push(minDist);
    }

    minDists.sort((a, b) => a - b);
    const q = (pct: number) => minDists[Math.floor(minDists.length * pct)];

    // Background quantiles match empirical values documented in phage_explorer-98ni:
    expect(q(0.001)).toBeCloseTo(0.0166, 3); // p0.1
    expect(q(0.01)).toBeCloseTo(0.0208, 3);  // p1
    expect(q(0.02)).toBeCloseTo(0.0225, 3);  // p2
    expect(q(0.05)).toBeCloseTo(0.0275, 3);  // p5
    expect(q(0.10)).toBeCloseTo(0.0314, 3);  // p10
    expect(q(0.50)).toBeCloseTo(0.0498, 3);  // p50

    // Cutoff of 0.025 admits the top ~3.6% of all proteins (74 of 2,039)
    const admitted = minDists.filter((d) => d <= 0.025);
    expect(admitted.length).toBe(74);

    // Distribution is smooth: no gap > 0.005 exists in the top 100 candidates
    for (let i = 0; i < 99; i++) {
      const step = minDists[i + 1] - minDists[i];
      expect(step).toBeLessThan(0.005);
    }
  });

  it('negative control: candidate hits at <= 0.025 include published non-Acr annotations', () => {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .query<
        { gene_id: number; dims: number; vector: Uint8Array; name: string | null; product: string | null },
        []
      >(`
        SELECT fe.gene_id, fe.dims, fe.vector, g.name, g.product
        FROM fold_embeddings fe
        JOIN genes g ON g.id = fe.gene_id
        WHERE fe.model = 'facebook/esm2_t6_8M_UR50D'
      `)
      .all();

    const candidates: Array<{ geneId: number; product: string; dist: number; nearestRef: string }> = [];

    for (const row of rows) {
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      const vec = new Float32Array(row.dims);
      for (let i = 0; i < row.dims; i++) vec[i] = view.getFloat32(i * 4, true);

      let minDist = Infinity;
      let nearestRef = '';
      for (const ref of refs) {
        const d = cosineDistance(vec, ref.vector);
        if (d < minDist) {
          minDist = d;
          nearestRef = ref.id;
        }
      }
      if (minDist <= 0.025) {
        candidates.push({
          geneId: row.gene_id,
          product: row.product ?? '',
          dist: minDist,
          nearestRef,
        });
      }
    }

    candidates.sort((a, b) => a.dist - b.dist);
    expect(candidates.length).toBe(74);

    // Check published negative controls:
    // Confirms that superinfection exclusion, SMI1/KNR4, nucleotide kinase, DNA methyltransferase,
    // and virion structural protein are among the nearest embedding neighbors.
    const products = candidates.map((c) => c.product.toLowerCase());
    expect(products.some((p) => p.includes('superinfection exclusion'))).toBe(true);
    expect(products.some((p) => p.includes('smi1') || p.includes('knr4'))).toBe(true);
    expect(products.some((p) => p.includes('nucleotide kinase'))).toBe(true);
    expect(products.some((p) => p.includes('methyltransferase'))).toBe(true);
    expect(products.some((p) => p.includes('virion structural'))).toBe(true);

    // Over 40 of 74 candidates have explicit non-hypothetical annotations
    const nonHypo = candidates.filter((c) => c.product && !c.product.toLowerCase().includes('hypothetical'));
    expect(nonHypo.length).toBeGreaterThanOrEqual(40);
  });

  it('defense_systems table in phage.db does not contain unverified esm2-nn false positives', () => {
    const db = new Database(DB_PATH, { readonly: true });
    // Invariant: defense_systems must only contain verified, domain-backed annotations (e.g. pfam-domain),
    // and must NOT assert esm2-nn screening candidates as verified anti-CRISPR systems.
    const esm2Rows = db.query<{ count: number }, []>(
      "SELECT count(*) as count FROM defense_systems WHERE source = 'esm2-nn'"
    ).get();

    expect(esm2Rows?.count ?? 0).toBe(0);

    // Legitimate pfam-domain defense systems remain intact
    const pfamRows = db.query<{ count: number }, []>(
      "SELECT count(*) as count FROM defense_systems WHERE source = 'pfam-domain'"
    ).get();
    expect(pfamRows?.count ?? 0).toBeGreaterThanOrEqual(10);
  });
});
