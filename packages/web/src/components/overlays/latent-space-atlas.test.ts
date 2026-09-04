import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ActionRegistry, ActionIds, ActionRegistryList } from '../../keyboard';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';

const DB_PATH = join(import.meta.dir, '../../../public/phage.db');

describe('Pan-Phage Latent Space Atlas (phage_explorer-qf8k.5)', () => {
  it('precomputes and ships 2D coordinates in SQLite without browser dimensionality reduction', () => {
    if (!existsSync(DB_PATH)) return;
    const db = new Database(DB_PATH, { readonly: true });

    const countRow = db.query<{ count: number }, [string]>(`
      SELECT count(*) as count FROM fold_embedding_coords WHERE model = ?
    `).get('facebook/esm2_t6_8M_UR50D');

    expect(countRow).toBeDefined();
    expect(countRow!.count).toBe(2039);

    const metaRow = db.query<{ value: string }, [string]>(`
      SELECT value FROM annotation_meta WHERE key = ?
    `).get('latent_space_atlas');

    expect(metaRow).toBeDefined();
    const meta = JSON.parse(metaRow!.value);
    expect(meta.model).toBe('facebook/esm2_t6_8M_UR50D');
    expect(meta.count).toBe(2039);
    expect(meta.clusters).toBeGreaterThan(50);
    expect(meta.outliers).toBeGreaterThan(100);
  });

  it('asserts that genes with similar products (terminase large subunits) land near each other', () => {
    if (!existsSync(DB_PATH)) return;
    const db = new Database(DB_PATH, { readonly: true });

    const terminases = db.query<{
      geneId: number;
      phageId: number;
      x: number;
      y: number;
      clusterId: number;
      product: string;
    }, []>(`
      SELECT c.gene_id as geneId, c.phage_id as phageId, c.x, c.y, c.cluster_id as clusterId, g.product
      FROM fold_embedding_coords c
      JOIN genes g ON g.id = c.gene_id
      WHERE g.product LIKE '%terminase large subunit%'
      ORDER BY c.gene_id ASC
    `).all();

    expect(terminases.length).toBeGreaterThanOrEqual(10);

    // Compute pairwise distances among terminase large subunits in the 2D latent space
    let terminaseDistSum = 0;
    let terminasePairCount = 0;
    for (let i = 0; i < terminases.length; i++) {
      for (let j = i + 1; j < terminases.length; j++) {
        const dx = terminases[i].x - terminases[j].x;
        const dy = terminases[i].y - terminases[j].y;
        terminaseDistSum += Math.sqrt(dx * dx + dy * dy);
        terminasePairCount++;
      }
    }
    const avgTerminaseDist = terminaseDistSum / terminasePairCount;

    // Compute pairwise distances among random genes across the manifold
    const allCoords = db.query<{ x: number; y: number }, []>(`
      SELECT x, y FROM fold_embedding_coords LIMIT 200
    `).all();

    let randomDistSum = 0;
    let randomPairCount = 0;
    for (let i = 0; i < allCoords.length; i += 5) {
      for (let j = i + 5; j < allCoords.length; j += 5) {
        const dx = allCoords[i].x - allCoords[j].x;
        const dy = allCoords[i].y - allCoords[j].y;
        randomDistSum += Math.sqrt(dx * dx + dy * dy);
        randomPairCount++;
      }
    }
    const avgRandomDist = randomDistSum / randomPairCount;

    // Terminase subunits must be clustered much closer than the overall manifold spread
    expect(avgTerminaseDist).toBeLessThan(avgRandomDist * 0.4);

    // Specifically, majority of terminases share clusters 31 or 32
    const coreClusterTerminases = terminases.filter(t => t.clusterId === 31 || t.clusterId === 32);
    expect(coreClusterTerminases.length).toBeGreaterThanOrEqual(terminases.length * 0.5);
  });

  it('outlier score is present and non-constant, isolating viral dark matter', () => {
    if (!existsSync(DB_PATH)) return;
    const db = new Database(DB_PATH, { readonly: true });

    const stats = db.query<{
      minScore: number;
      maxScore: number;
      avgScore: number;
      noiseCount: number;
    }, []>(`
      SELECT
        min(outlier_score) as minScore,
        max(outlier_score) as maxScore,
        avg(outlier_score) as avgScore,
        sum(CASE WHEN cluster_id = -1 THEN 1 ELSE 0 END) as noiseCount
      FROM fold_embedding_coords
    `).get();

    expect(stats).toBeDefined();
    expect(stats!.minScore).toBeLessThan(0.01);
    expect(stats!.maxScore).toBeGreaterThan(0.9);
    expect(stats!.maxScore - stats!.minScore).toBeGreaterThan(0.8);
    expect(stats!.noiseCount).toBeGreaterThan(200);
  });

  it('is registered with measured provenance and appears in keyboard and analysis actions', () => {
    const action = ActionRegistry[ActionIds.OverlayLatentSpaceAtlas];
    expect(action).toBeDefined();
    expect(action.overlayId).toBe('latentSpaceAtlas');
    expect(action.provenance).toBe('measured');
    expect(action.category).toBe('Analysis');

    const inList = ActionRegistryList.find(a => a.id === ActionIds.OverlayLatentSpaceAtlas);
    expect(inList).toBeDefined();
  });

  it('BunSqliteRepository exposes getLatentSpaceAtlas and returns populated points', async () => {
    if (!existsSync(DB_PATH)) return;
    const repo = new BunSqliteRepository(DB_PATH);
    const all = await repo.getLatentSpaceAtlas();
    expect(all.length).toBe(2039);

    const first = all[0];
    expect(first.phageId).toBeGreaterThan(0);
    expect(first.geneId).toBeGreaterThan(0);
    expect(typeof first.x).toBe('number');
    expect(typeof first.y).toBe('number');
    expect(typeof first.outlierScore).toBe('number');
    expect(first.model).toBe('facebook/esm2_t6_8M_UR50D');

    const lambdaOnly = await repo.getLatentSpaceAtlas({ phageId: 1 });
    expect(lambdaOnly.length).toBe(73);
    expect(lambdaOnly.every(p => p.phageId === 1)).toBe(true);
  });
});
