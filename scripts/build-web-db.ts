#!/usr/bin/env bun
/**
 * Build Web Database
 *
 * Prepares the phage database for web deployment:
 * Publishes raw and gzip SQLite bytes with separate logical content identity
 * and transport checksum. Copies are optimized without changing the source;
 * in-place builds refresh only gzip and the manifest.
 */

import { Database } from "bun:sqlite";
import { mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import type { DatabaseManifest } from "../packages/web/src/db/types";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: { type: "string", default: "phage.db" },
      output: { type: "string", default: "packages/web/public" },
    },
  });
  const SOURCE_DB = values.source;
  const OUTPUT_DIR = values.output;
  const OUTPUT_DB = `${OUTPUT_DIR}/phage.db`;
  const OUTPUT_DB_GZ = `${OUTPUT_DIR}/phage.db.gz`;
  const OUTPUT_MANIFEST = `${OUTPUT_DIR}/phage.db.manifest.json`;
  console.log("Building web database...");

  const sourcePath = resolve(SOURCE_DB);
  const outputPath = resolve(OUTPUT_DB);

  // Check source exists
  try {
    await stat(SOURCE_DB);
  } catch {
    console.error(`Source database not found: ${SOURCE_DB}`);
    process.exit(1);
  }

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Optimize a private snapshot, never the source database. In-place builds
  // only refresh the compressed artifact and manifest beside the existing DB.
  let fileBuffer: Buffer;
  let contentVersion: string;
  const source = new Database(sourcePath, { readonly: true });
  try {
    contentVersion = computeDatabaseContentDigest(source);
    if (sourcePath === outputPath) {
      fileBuffer = Buffer.from(await Bun.file(sourcePath).arrayBuffer());
      const rawSnapshot = Database.deserialize(fileBuffer);
      try {
        if (computeDatabaseContentDigest(rawSnapshot) !== contentVersion) { // ubs:ignore — public dataset identity, not an authentication secret.
          throw new Error('Source changed or has uncheckpointed WAL data. Build to a separate output directory to publish a coherent snapshot.');
        }
      } finally {
        rawSnapshot.close();
      }
    } else {
      const snapshot = Database.deserialize(source.serialize());
      try {
        snapshot.exec("VACUUM");
        snapshot.exec("REINDEX");
        contentVersion = computeDatabaseContentDigest(snapshot);
        fileBuffer = snapshot.serialize();
      } finally {
        snapshot.close();
      }
    }
  } finally {
    source.close();
  }

  if (sourcePath !== outputPath) {
    await Bun.write(OUTPUT_DB, fileBuffer);
  }

  const manifest = createDatabaseManifest(contentVersion, fileBuffer);

  // Generate gzip-compressed artifact for faster cold loads (DatabaseLoader prefers `.db.gz` when present).
  console.log("Generating gzip-compressed database...");
  const gzBytes = gzipSync(fileBuffer, { level: 9 });
  await Bun.write(OUTPUT_DB_GZ, gzBytes);
  const gzStats = await stat(OUTPUT_DB_GZ);
  // Publish the descriptor last. A reader racing an artifact update rejects
  // mismatched bytes and keeps its verified cache until the set is complete.
  await Bun.write(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`✓ Built web database:`);
  console.log(`  Database: ${OUTPUT_DB} (${manifest.sizeFormatted})`);
  console.log(`  Database (gzip): ${OUTPUT_DB_GZ} (${formatBytes(gzStats.size)})`);
  console.log(`  Manifest: ${OUTPUT_MANIFEST}`);
  console.log(`  Content version: ${contentVersion.substring(0, 16)}...`);
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
      'SELECT name FROM sqlite_master WHERE type="table" AND name NOT LIKE "sqlite_%" ORDER BY name'
    )
    .all();

  const hasher = createHash('sha256');
  hasher.update(JSON.stringify(db.query('PRAGMA user_version').get()));
  const schema = db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
  for (const definition of schema) hasher.update(JSON.stringify(definition) + '\n');

  for (const t of tables) {
    const cols = db
      .query<{ name: string }, []>(`PRAGMA table_info(${identifier(t.name)})`)
      .all()
      .map((c) => c.name)
      .sort();
    const colExpr = cols.map((c) => `quote(${identifier(c)})`).join(" || ',' || ");
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
