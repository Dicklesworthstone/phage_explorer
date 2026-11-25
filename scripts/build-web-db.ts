#!/usr/bin/env bun
/**
 * Build Web Database
 *
 * Prepares the phage database for web deployment:
 * Publishes verified raw and gzip SQLite bytes with separate logical content
 * identity and transport checksums. Immutable web publications switch one
 * manifest pointer; portable release builds retain their three-file contract.
 * In-place builds never rewrite the source database.
 */

import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDatabaseManifest, type DatabaseArtifact, type DatabaseManifest } from "../packages/web/src/db/types";

export interface WebDatabaseBuildOptions {
  source: string;
  outputDirectory: string;
  /** Keep each published generation addressable while atomically replacing its manifest. */
  immutable?: boolean;
}

const checksum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function verifySqlite(bytes: Buffer, contentVersion: string): void {
  const db = Database.deserialize(bytes);
  try {
    const integrity = db.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
    if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign-key check failed.');
    if (computeDatabaseContentDigest(db) !== contentVersion) throw new Error('SQLite content version does not match the manifest.');
  } finally { db.close(); }
}

async function readArtifact(path: string, expected?: Pick<DatabaseArtifact, 'sha256' | 'size'>): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`Database artifact must be a regular file: ${path}`);
  if (expected && metadata.size !== expected.size) throw new Error(`Database artifact size mismatch: ${path}`);
  const bytes = await readFile(path);
  if (expected && (bytes.length !== expected.size || checksum(bytes) !== expected.sha256)) {
    throw new Error(`Database artifact checksum mismatch: ${path}`);
  }
  return bytes;
}

async function verifyDatabaseSet(rawPath: string, gzipPath: string, manifest: DatabaseManifest): Promise<void> {
  const raw = await readArtifact(rawPath, { sha256: manifest.sha256, size: manifest.size });
  const compressed = await readArtifact(gzipPath, manifest.artifacts?.gzip);
  const decompressed = gunzipSync(compressed, { maxOutputLength: manifest.size });
  if (!decompressed.equals(raw)) throw new Error('Gzip database does not match the raw SQLite artifact.');
  verifySqlite(raw, manifest.contentVersion);
}

/** Validate precisely the files a manifest declares, including portable release output. */
export async function checkWebDatabase(outputDirectory: string, suppliedManifest?: DatabaseManifest): Promise<DatabaseManifest> {
  const output = resolve(outputDirectory);
  const value: unknown = suppliedManifest ?? JSON.parse(await readFile(join(output, 'phage.db.manifest.json'), 'utf8'));
  if (!isDatabaseManifest(value)) throw new Error('Unsupported or invalid database manifest.');
  const manifest = value;
  await verifyDatabaseSet(
    join(output, manifest.artifacts?.sqlite.path ?? 'phage.db'),
    join(output, manifest.artifacts?.gzip.path ?? 'phage.db.gz'), manifest,
  );
  return manifest;
}

/** Hard-link a complete staged file without ever overwriting an existing generation. */
async function publishImmutable(stagedPath: string, output: string, artifact: DatabaseArtifact): Promise<void> {
  const path = join(output, artifact.path);
  await mkdir(dirname(path), { recursive: true });
  try { await link(stagedPath, path); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    // Concurrent or repeated publication can reuse exactly matching bytes.
    // A corrupt existing object is a failure, never permission to replace it.
  }
  await readArtifact(path, artifact);
}

export async function buildWebDatabase(options: WebDatabaseBuildOptions): Promise<DatabaseManifest> {
  const sourcePath = resolve(options.source);
  const output = resolve(options.outputDirectory);
  const outputPath = join(output, 'phage.db');
  let fileBuffer: Buffer;
  let contentVersion: string;
  const source = new Database(sourcePath, { readonly: true });
  try {
    // Keep the identity and serialized bytes on one SQLite read snapshot even
    // when an annotation producer commits while publication is being prepared.
    source.exec('BEGIN');
    contentVersion = computeDatabaseContentDigest(source);
    if (sourcePath === outputPath) {
      fileBuffer = await readFile(sourcePath);
      try { verifySqlite(fileBuffer, contentVersion); }
      catch (error) {
        throw new Error('Source changed, is invalid, or has uncheckpointed WAL data. Build to a separate output directory to publish a coherent snapshot.', { cause: error });
      }
    } else {
      const snapshotBytes = source.serialize();
      // serialize() includes the committed WAL pages in this read snapshot,
      // but retains the WAL-mode header. An in-memory deserialized database
      // cannot open a WAL; normalize only this owned snapshot, never the source
      // file (whose committed pages may still live in its separate WAL).
      // https://sqlite.org/c3ref/deserialize.html
      if (snapshotBytes[18] === 2 && snapshotBytes[19] === 2) {
        snapshotBytes[18] = 1;
        snapshotBytes[19] = 1;
      }
      const snapshot = Database.deserialize(snapshotBytes);
      try {
        snapshot.exec('VACUUM');
        snapshot.exec('REINDEX');
        fileBuffer = snapshot.serialize();
      } finally { snapshot.close(); }
    }
    source.exec('COMMIT');
  } finally { source.close(); }
  verifySqlite(fileBuffer, contentVersion);

  // Compression and validation finish before any previous published file changes.
  const compressed = gzipSync(fileBuffer, { level: 9 });
  const manifest = createDatabaseManifest(contentVersion, fileBuffer);
  if (options.immutable) {
    const gzipHash = checksum(compressed);
    manifest.artifacts = {
      sqlite: { path: `phage-data/${manifest.sha256}.db`, sha256: manifest.sha256, size: fileBuffer.length },
      gzip: { path: `phage-data/${gzipHash}.db.gz`, sha256: gzipHash, size: compressed.length },
    };
  }

  // Sibling staging stays on the destination filesystem without accidentally
  // becoming a public/static asset. Retain it for failure diagnostics.
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), '.phage-db-stage-'));
  const stagedRaw = join(stage, 'phage.db');
  const stagedGzip = join(stage, 'phage.db.gz');
  const stagedManifest = join(stage, 'phage.db.manifest.json');
  await writeFile(stagedRaw, fileBuffer, { flag: 'wx' });
  await writeFile(stagedGzip, compressed, { flag: 'wx' });
  await writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await verifyDatabaseSet(stagedRaw, stagedGzip, manifest);

  // Alias files must have separate inodes from immutable objects: a future
  // external in-place edit of phage.db must never alter a published generation.
  const aliasRaw = join(stage, 'portable.db');
  const aliasGzip = join(stage, 'portable.db.gz');
  if (sourcePath !== outputPath) await copyFile(stagedRaw, aliasRaw, constants.COPYFILE_EXCL);
  await copyFile(stagedGzip, aliasGzip, constants.COPYFILE_EXCL);
  await mkdir(output, { recursive: true });
  if (manifest.artifacts) {
    await publishImmutable(stagedRaw, output, manifest.artifacts.sqlite);
    await publishImmutable(stagedGzip, output, manifest.artifacts.gzip);
    await checkWebDatabase(output, manifest);
  }

  // Older browser/terminal consumers still receive the conventional filenames.
  // These aliases are individually atomic; only immutable manifest readers get
  // generation-atomic publication across both files. Releases publish after the
  // complete portable build succeeds, never while these aliases are replaced.
  if (sourcePath !== outputPath) await rename(aliasRaw, outputPath);
  await rename(aliasGzip, join(output, 'phage.db.gz'));
  await rename(stagedManifest, join(output, 'phage.db.manifest.json'));
  return manifest;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: "string", default: "phage.db" },
      output: { type: "string", default: "packages/web/public" },
      immutable: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  const manifest = values.check
    ? await checkWebDatabase(values.output)
    : await buildWebDatabase({ source: values.source, outputDirectory: values.output, immutable: values.immutable });
  console.log(`✓ ${values.check ? 'Verified' : 'Built'} ${manifest.artifacts ? 'immutable web' : 'portable'} database:`);
  console.log(`  Database: ${values.output}/${manifest.artifacts?.sqlite.path ?? 'phage.db'} (${manifest.sizeFormatted})`);
  console.log(`  Manifest: ${values.output}/phage.db.manifest.json`);
  console.log(`  Content version: ${manifest.contentVersion.substring(0, 16)}...`);
  console.log(`  SHA-256: ${manifest.sha256.substring(0, 16)}...`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createDatabaseManifest(contentVersion: string, bytes: Uint8Array): DatabaseManifest {
  return {
    version: 2,
    contentVersion,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    sizeFormatted: formatBytes(bytes.byteLength),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Compute deterministic logical content digest of SQLite database.
 * Independent of page fragmentation, balancing order, or VACUUM differences across environments.
 */
export function computeDatabaseContentDigest(db: Database): string {
  const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = db
    .query<{ name: string }, []>(
      'SELECT name FROM sqlite_master WHERE type="table" AND name NOT GLOB "sqlite_*" ORDER BY name'
    )
    .all();

  const hasher = createHash('sha256');
  hasher.update(JSON.stringify(db.query('PRAGMA user_version').get()));
  const schema = db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
  ).all();
  for (const definition of schema) hasher.update(JSON.stringify(definition) + '\n');

  for (const t of tables) {
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(${identifier(t.name)})`)
      .all()
      .map((c) => c.name)
      .sort();
    const colExpr = cols.map((c) => {
      const column = identifier(c);
      // SQLite quote() stops TEXT at its first NUL. JSON string escaping
      // preserves the complete value, including Unicode and control characters.
      // The tag is disjoint from SQL literals; ordinary cells keep their
      // existing serialization so unchanged datasets retain their identity.
      return `CASE WHEN typeof(${column}) = 'text' AND instr(${column}, char(0)) > 0 THEN 'TEXT:' || json_quote(${column}) ELSE quote(${column}) END`;
    }).join(" || ',' || ");
    const rows = db.query<{ r: string }, []>(`SELECT ${colExpr} as r FROM ${identifier(t.name)} ORDER BY 1`).all();
    hasher.update(`table:${t.name}:${rows.length}\n`);
    for (const row of rows) {
      hasher.update(row.r);
      hasher.update('\n');
    }
  }

  return hasher.digest('hex');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Build failed:", err);
    process.exit(1);
  });
}
