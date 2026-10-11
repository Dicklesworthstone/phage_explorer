#!/usr/bin/env bun
/** Publish catalog + immutable per-genome SQLite shards; keep the source untouched. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publishProgressiveDataset, type DatasetSqlite, type PublishDatasetOptions } from './progressive-dataset';
import { PROGRESSIVE_LIMITS, type ProgressiveManifest } from '../packages/web/src/db/progressive-manifest';

/** Shared by the standalone publisher and the actual web build, not a separate data pipeline. */
export async function publishProgressiveDatasetToDirectory(
  options: Omit<PublishDatasetOptions, 'writeArtifact'> & { outputDirectory: string },
): Promise<ProgressiveManifest> {
  const output = resolve(options.outputDirectory);
  await mkdir(output, { recursive: true });
  const manifest = await publishProgressiveDataset({
    source: options.source,
    createDatabase: options.createDatabase,
    generatedAt: options.generatedAt,
    onProgress: options.onProgress,
    writeArtifact: async (artifact, bytes) => {
      const path = resolve(output, artifact.path);
      await mkdir(dirname(path), { recursive: true });
      try {
        const existing = await readFile(path);
        if (existing.length !== artifact.bytes || createHash('sha256').update(existing).digest('hex') !== artifact.sha256) {
          throw new Error(`Existing immutable artifact is corrupt: ${path}`);
        }
        return;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, path);
    },
  });
  const path = resolve(output, 'phage.db.manifest.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const text = JSON.stringify(manifest) + '\n';
  if (Buffer.byteLength(text) > PROGRESSIVE_LIMITS.manifestBytes) throw new Error('Published manifest exceeds its byte budget.');
  await writeFile(temporary, text, { flag: 'wx' });
  // Publish only after every immutable artifact and row-conservation check succeeds.
  await rename(temporary, path);
  return manifest;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: {
    // The repository-root database is a build intermediate, not the annotated release source.
    source: { type: 'string', default: resolve(root, 'packages/web/public/phage.db') },
    output: { type: 'string', default: resolve(root, 'packages/web/public') },
  } });
  const { Database } = await import('bun:sqlite');
  const source = new Database(resolve(values.source), { readonly: true });
  try {
    const manifest = await publishProgressiveDatasetToDirectory({
      source: source as unknown as DatasetSqlite,
      createDatabase: () => new Database(':memory:') as unknown as DatasetSqlite,
      outputDirectory: values.output,
      onProgress: (completed, total) => { if (completed % 100 === 0 || completed === total) console.log(`Published ${completed}/${total} genomes`); },
    });
    console.log(JSON.stringify({ contentVersion: manifest.contentVersion, genomes: manifest.genomes.length, ...manifest.bytes }, null, 2));
    console.log('Catalog-first publication complete. No monolithic database or gzip copy was emitted.');
  } finally { source.close(); }
}
if (import.meta.main) main().catch(error => { console.error('Progressive database build failed:', error); process.exitCode = 1; });
