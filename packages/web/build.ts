#!/usr/bin/env bun
/** The production web build: canonical annotated SQLite -> verified shards -> Vite. */
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishProgressiveDatasetToDirectory } from '../../scripts/build-progressive-web-db';
import type { DatasetSqlite } from '../../scripts/progressive-dataset';
import { PROGRESSIVE_LIMITS, datasetArtifacts, parseProgressiveManifest, verifyProgressiveManifest, type ProgressiveManifest } from './src/db/progressive-manifest';

// Never copy an old descriptor, monolith, SQLite journal, or old generation's shards.
// This filters only the staged public tree; source files and terminal assets remain untouched.
function isReplacedData(name: string): boolean {
  return name === 'phage-data' || name === 'phage.db' || name === 'phage.db.gz'
    || name === 'phage.db.manifest.json' || name.startsWith('phage.db-')
    || name.startsWith('phage.db.manifest.json.');
}
async function copyPublicTree(source: string, destination: string, top = true): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (top && isReplacedData(entry.name)) continue;
    const input = join(source, entry.name), output = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Public assets must not be symbolic links: ${input}`);
    if (entry.isDirectory()) {
      await mkdir(output); await copyPublicTree(input, output, false);
    } else if (entry.isFile()) await copyFile(input, output, constants.COPYFILE_EXCL);
    else throw new Error(`Unsupported public asset: ${input}`);
  }
}

/** Production and integration tests both use the real snapshot publisher through this function. */
export async function prepareWebPublicAssets(options: {
  publicDirectory: string;
  openSource: (path: string) => DatasetSqlite;
  createDatabase: () => DatasetSqlite;
  stagingParent?: string;
}): Promise<{ directory: string; manifest: ProgressiveManifest }> {
  const publicDirectory = resolve(options.publicDirectory);
  const sourcePath = join(publicDirectory, 'phage.db');
  if (!(await lstat(publicDirectory)).isDirectory() || !(await lstat(sourcePath)).isFile()) {
    throw new Error('The canonical public/phage.db must be a regular file in the public directory.');
  }
  const directory = await mkdtemp(join(options.stagingParent ?? tmpdir(), 'phage-web-public-'));
  await copyPublicTree(publicDirectory, directory);
  const source = options.openSource(sourcePath);
  try {
    const manifest = await publishProgressiveDatasetToDirectory({ source, createDatabase: options.createDatabase, outputDirectory: directory });
    await verifyWebDataset(directory, manifest);
    return { directory, manifest };
  } finally { source.close(); }
}

/** Fail the build if a bundler/plugin omits or changes a referenced dataset artifact. */
export async function verifyWebDataset(directory: string, expected: ProgressiveManifest): Promise<void> {
  const descriptor = join(directory, 'phage.db.manifest.json');
  const metadata = await lstat(descriptor);
  if (!metadata.isFile() || metadata.size > PROGRESSIVE_LIMITS.manifestBytes) throw new Error('Built dataset manifest is missing, nonregular, or oversized.');
  const actual = parseProgressiveManifest(await readFile(descriptor, 'utf8'));
  await verifyProgressiveManifest(actual);
  if (actual.contentVersion !== expected.contentVersion) throw new Error('Built dataset differs from the verified source snapshot.');
  for (const artifact of datasetArtifacts(actual)) {
    const path = join(directory, artifact.path), stat = await lstat(path);
    if (!stat.isFile() || stat.size !== artifact.bytes) throw new Error(`Built dataset artifact size/type mismatch: ${artifact.path}`);
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > artifact.bytes) throw new Error(`Built artifact grew during verification: ${artifact.path}`);
      digest.update(chunk);
    }
    if (bytes !== artifact.bytes || digest.digest('hex') !== artifact.sha256) throw new Error(`Built artifact checksum mismatch: ${artifact.path}`);
  }
}

export async function buildWebApplication(): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url));
  const { Database } = await import('bun:sqlite');
  // Publication must complete before Vite can replace a previously successful dist.
  const { directory, manifest } = await prepareWebPublicAssets({
    publicDirectory: join(root, 'public'),
    openSource: path => new Database(path, { readonly: true }) as unknown as DatasetSqlite,
    createDatabase: () => new Database(':memory:') as unknown as DatasetSqlite,
  });
  const { build } = await import('vite');
  const outDir = join(root, 'dist');
  await build({ root, configFile: join(root, 'vite.config.ts'), publicDir: directory,
    build: { outDir, copyPublicDir: true } });
  await verifyWebDataset(outDir, manifest);
  process.stdout.write(JSON.stringify({ datasetLayout: manifest.layout, contentVersion: manifest.contentVersion,
    genomes: manifest.genomes.length, ...manifest.bytes }) + '\n');
}
if (import.meta.main) buildWebApplication().catch(error => {
  console.error('Web publication failed:', error); process.exitCode = 1;
});
