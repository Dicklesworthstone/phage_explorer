import { createHash } from 'node:crypto';
import {
  PROGRESSIVE_LIMITS, datasetByteLedger, parseProgressiveManifest, progressiveIdentity,
  type DataArtifact, type ProgressiveManifest,
} from '../packages/web/src/db/progressive-manifest';

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;
/** Small adapter surface so the publication algorithm is independently testable. */
export interface DatasetSqlite {
  query(sql: string): {
    iterate(...bindings: SqlValue[]): Iterable<SqlRow>;
    get(...bindings: SqlValue[]): unknown;
    run(...bindings: SqlValue[]): unknown;
  };
  exec(sql: string): unknown;
  serialize(): Uint8Array;
  close(): void;
}
interface Table {
  name: string;
  sql: string;
  columns: string[];
  order: string[];
  scoped: boolean;
}
export interface PublishDatasetOptions {
  source: DatasetSqlite;
  createDatabase: () => DatasetSqlite;
  writeArtifact: (artifact: DataArtifact, bytes: Uint8Array) => Promise<void>;
  generatedAt?: string;
  onProgress?: (completed: number, total: number) => void;
}
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const rows = (db: DatasetSqlite, sql: string, ...bindings: SqlValue[]): SqlRow[] => Array.from(db.query(sql).iterate(...bindings));
function count(db: DatasetSqlite, sql: string, ...bindings: SqlValue[]): number {
  const result = db.query(sql).get(...bindings) as { n?: unknown } | null;
  if (!result || typeof result.n !== 'number' || !Number.isSafeInteger(result.n) || result.n < 0) throw new Error('Invalid SQLite row count.');
  return result.n;
}
function checkSize(db: DatasetSqlite, budget: number, label: string): void {
  const pages = db.query('PRAGMA page_count').get() as { page_count: number };
  const size = db.query('PRAGMA page_size').get() as { page_size: number };
  if (pages.page_count * size.page_size > budget) throw new Error(`${label} exceeds its ${budget}-byte budget; repartition the input instead of publishing an oversized file.`);
}

/**
 * Publish a single consistent read snapshot without serializing the source DB.
 * Peak SQLite working data is one catalog or one genome, not the whole dataset.
 * Every source row is accounted for; unknown tables are retained, not discarded.
 */
export async function publishProgressiveDataset(options: PublishDatasetOptions): Promise<ProgressiveManifest> {
  const { source, createDatabase, writeArtifact } = options;
  source.exec('BEGIN');
  try {
    const definitions = rows(source, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tables: Table[] = definitions.map(row => {
      if (typeof row.name !== 'string' || typeof row.sql !== 'string' || /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)) throw new Error('Progressive publication requires ordinary SQLite tables.');
      const columns = rows(source, `PRAGMA table_info(${quote(row.name)})`);
      const names = columns.map(column => String(column.name));
      if (!names.length) throw new Error(`Table ${row.name} has no columns.`);
      if (names.includes('gene_id') && !names.includes('phage_id')) throw new Error(`Table ${row.name} needs explicit genome ownership before it can be partitioned.`);
      const primary = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
      return { name: row.name, sql: row.sql, columns: names, order: primary.length ? primary : names, scoped: names.includes('phage_id') };
    });
    for (const name of ['phages', 'genes', 'sequences', 'codon_usage', 'models', 'preferences']) {
      if (!tables.some(table => table.name === name)) throw new Error(`Required repository table is missing: ${name}.`);
    }
    const phages = rows(source, 'SELECT id, genome_length FROM phages ORDER BY id');
    if (!phages.length || phages.length > PROGRESSIVE_LIMITS.genomes) throw new Error('Cannot publish an empty or over-budget catalog.');
    for (const row of phages) {
      if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.genome_length !== 'number' || !Number.isSafeInteger(row.genome_length) || row.genome_length < 0) throw new Error('Catalog contains an invalid genome ID or length.');
    }
    // Fail closed on orphaned/null ownership, rather than dropping scientific data.
    for (const table of tables.filter(table => table.scoped)) {
      const orphans = count(source, `SELECT COUNT(*) AS n FROM ${quote(table.name)} WHERE phage_id IS NULL OR phage_id NOT IN (SELECT id FROM phages)`);
      if (orphans) throw new Error(`${table.name} contains ${orphans} rows without a catalog genome.`);
    }
    const indexes = rows(source, "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name");
    const views = rows(source, "SELECT sql FROM sqlite_master WHERE type='view' ORDER BY name");
    const version = source.query('PRAGMA user_version').get() as { user_version: number };
    if (!Number.isInteger(version.user_version) || version.user_version < 0) throw new Error('Invalid SQLite schema version.');
    const copied = new Map(tables.map(table => [table.name, 0]));

    const emit = async (bytes: Uint8Array, extension: 'sqlite' | 'json'): Promise<DataArtifact> => {
      if (bytes.length > PROGRESSIVE_LIMITS.artifactBytes) throw new Error('Artifact exceeds the deployable shard budget.');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const descriptor = { path: `phage-data/${sha256}.${extension}`, sha256, bytes: bytes.length };
      await writeArtifact(descriptor, bytes);
      return descriptor;
    };
    const copyDatabase = (phageId?: number): Uint8Array => {
      const db = createDatabase();
      const budget = phageId === undefined ? PROGRESSIVE_LIMITS.catalogBytes : PROGRESSIVE_LIMITS.artifactBytes;
      const label = phageId === undefined ? 'Catalog' : `Genome ${phageId}`;
      try {
        db.exec(`PRAGMA foreign_keys=OFF; PRAGMA user_version=${version.user_version}; BEGIN;`);
        for (const table of tables) db.exec(table.sql);
        for (const table of tables) {
          const catalog = phageId === undefined;
          const include = table.name === 'phages' || (catalog ? !table.scoped : table.scoped);
          if (!include) continue;
          const where = catalog ? '' : table.name === 'phages' ? ' WHERE id = ?' : ' WHERE phage_id = ?';
          const bindings = catalog ? [] : [phageId];
          const statement = db.query(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
          let n = 0;
          for (const row of source.query(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)}${where} ORDER BY ${table.order.map(quote).join(',')}`).iterate(...bindings)) {
            statement.run(...table.columns.map(column => row[column]));
            n++;
            if (n % 256 === 0) checkSize(db, budget, label);
          }
          if (catalog || table.name !== 'phages') copied.set(table.name, copied.get(table.name)! + n);
          checkSize(db, budget, label);
        }
        // Source triggers are intentionally not installed on read-only publication copies.
        for (const index of indexes) db.exec(String(index.sql));
        for (const view of views) db.exec(String(view.sql));
        db.exec('COMMIT');
        checkSize(db, budget, label);
        return db.serialize();
      } finally { db.close(); }
    };

    const catalog = await emit(copyDatabase(), 'sqlite');
    const genomes: ProgressiveManifest['genomes'] = [];
    for (const phage of phages) {
      const id = phage.id as number;
      const genomeLength = phage.genome_length as number;
      const chunks = source.query('SELECT chunk_index, length(sequence) AS n FROM sequences WHERE phage_id = ? ORDER BY chunk_index').iterate(id);
      let chunkIndex = 0;
      let sequenceLength = 0;
      for (const chunk of chunks) {
        const expected = Math.min(10_000, genomeLength - chunkIndex * 10_000);
        if (chunk.chunk_index !== chunkIndex || chunk.n !== expected || expected <= 0) throw new Error(`Genome ${id} has missing, misordered, or truncated sequence chunks.`);
        sequenceLength += expected; chunkIndex++;
      }
      if (sequenceLength !== genomeLength) throw new Error(`Genome ${id} declares ${genomeLength} bases but supplies ${sequenceLength}.`);
      genomes.push({ id, genomeLength, artifact: await emit(copyDatabase(id), 'sqlite') });
      options.onProgress?.(genomes.length, phages.length);
    }
    for (const table of tables) {
      const expected = count(source, `SELECT COUNT(*) AS n FROM ${quote(table.name)}`);
      if (copied.get(table.name) !== expected) throw new Error(`Row conservation failed for ${table.name}: ${copied.get(table.name)} of ${expected}.`);
    }

    // A global atlas is an explicit analysis request, never part of first load.
    // Compact projection pages preserve the cross-genome view without fetching every SQLite shard.
    const atlas: ProgressiveManifest['atlas'] = [];
    if (tables.some(table => table.name === 'fold_embedding_coords')) {
      const models = rows(source, 'SELECT DISTINCT model FROM fold_embedding_coords').map(row => {
        if (typeof row.model !== 'string' || !row.model.trim()) throw new Error('Atlas model identifiers must be nonempty strings.');
        return row.model;
      }).sort();
      for (const model of models) {
        const pages: DataArtifact[] = [];
        let page: string[] = [];
        let pageBytes = 2;
        let seen = 0;
        const flush = async () => {
          if (!page.length) return;
          pages.push(await emit(Buffer.from(`[${page.join(',')}]`), 'json'));
          page = []; pageBytes = 2;
        };
        const points = source.query(`SELECT c.id, c.phage_id AS phageId, p.name AS phageName,
          c.gene_id AS geneId, g.name AS geneName, g.locus_tag AS locusTag, g.product,
          c.model, c.x, c.y, c.cluster_id AS clusterId, c.outlier_score AS outlierScore
          FROM fold_embedding_coords c JOIN phages p ON p.id = c.phage_id JOIN genes g ON g.id = c.gene_id AND g.phage_id = c.phage_id
          WHERE c.model = ? ORDER BY c.cluster_id ASC, c.outlier_score DESC, c.id ASC`).iterate(model);
        for (const point of points) {
          if (!['id', 'phageId', 'geneId', 'clusterId'].every(key => Number.isSafeInteger(point[key])) ||
              !['x', 'y', 'outlierScore'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]))) {
            throw new Error(`Atlas ${model} contains invalid projection coordinates.`);
          }
          const text = JSON.stringify(point);
          const bytes = Buffer.byteLength(text) + 1;
          if (pageBytes + bytes > 1024 * 1024) await flush();
          page.push(text); pageBytes += bytes; seen++;
        }
        await flush();
        const expected = count(source, 'SELECT COUNT(*) AS n FROM fold_embedding_coords WHERE model = ?', model);
        if (seen !== expected) throw new Error(`Atlas ${model} has orphaned gene references.`);
        if (seen) atlas.push({ model, count: seen, pages });
      }
    }
    const manifest: ProgressiveManifest = {
      version: 3, layout: 'per-phage-sqlite-v1', contentVersion: '', generatedAt: options.generatedAt ?? new Date().toISOString(),
      catalog, genomes, atlas, bytes: datasetByteLedger({ catalog, genomes, atlas }),
    };
    manifest.contentVersion = createHash('sha256').update(progressiveIdentity(manifest)).digest('hex');
    const validated = parseProgressiveManifest(JSON.stringify(manifest));
    source.exec('COMMIT');
    return validated;
  } catch (error) {
    source.exec('ROLLBACK'); // End only our read transaction; the source is never modified.
    throw error;
  }
}
