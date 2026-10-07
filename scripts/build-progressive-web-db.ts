#!/usr/bin/env bun
/** Publish catalog + immutable per-genome SQLite shards; keep the source untouched. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { publishProgressiveDataset, type DatasetSqlite } from './progressive-dataset';
import { PROGRESSIVE_LIMITS } from '../packages/web/src/db/progressive-manifest';

async function main(): Promise<void> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    source: { type: 'string', default: 'phage.db' },
    output: { type: 'string', default: 'packages/web/public' },
  } });
  const source = new Database(resolve(values.source), { readonly: true });
  const output = resolve(values.output);
  try {
    const manifest = await publishProgressiveDataset({
      source: source as unknown as DatasetSqlite,
      createDatabase: () => new Database(':memory:') as unknown as DatasetSqlite,
      writeArtifact: async (artifact, bytes) => {
        const path = resolve(output, artifact.path);
        await mkdir(dirname(path), { recursive: true });
        try {
          const existing = await readFile(path);
          if (existing.length !== artifact.bytes || createHash('sha256').update(existing).digest('hex') !== artifact.sha256) throw new Error(`Existing immutable artifact is corrupt: ${path}`);
          return;
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, path);
      },
      onProgress: (completed, total) => { if (completed % 100 === 0 || completed === total) console.log(`Published ${completed}/${total} genomes`); },
    });
    const path = resolve(output, 'phage.db.manifest.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    const text = JSON.stringify(manifest) + '\n';
    if (Buffer.byteLength(text) > PROGRESSIVE_LIMITS.manifestBytes) throw new Error('Published manifest exceeds its byte budget.');
    await writeFile(temporary, text, { flag: 'wx' });
    // Publish only after every immutable artifact and row-conservation check succeeds.
    await rename(temporary, path);
    console.log(JSON.stringify({ contentVersion: manifest.contentVersion, genomes: manifest.genomes.length, ...manifest.bytes }, null, 2));
    console.log('Catalog-first publication complete. No monolithic database or gzip copy was emitted.');
  } finally { source.close(); }
}
if (import.meta.main) main().catch(error => { console.error('Progressive database build failed:', error); process.exitCode = 1; });
