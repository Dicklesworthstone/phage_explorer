#!/usr/bin/env bun

import React from 'react';
import { render } from 'ink';
import { App } from './components/App';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import path from 'path';
import { homedir } from 'os';

function getDefaultDbPath(): string | null {
  // Matches install.sh (DATA_DIR="$HOME/.phage-explorer")
  // Guard against environments where os.homedir() throws (e.g., HOME unset).
  try {
    return path.join(homedir(), '.phage-explorer', 'phage.db');
  } catch {
    return null;
  }
}

function getCandidateDbPaths(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string | null | undefined) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  // Explicit override (useful for CI / custom installs)
  add(process.env.PHAGE_EXPLORER_DB_PATH);
  add(process.env.PHAGE_DB_PATH);

  // Development default: the COMMITTED database.
  //
  // This is deliberately ahead of the repo-root `phage.db`, which used to come
  // first. The root file is a build INTERMEDIATE: `bun run build:db` writes it,
  // and `scripts/build-web-db.ts` then VACUUMs it into the path below, which is
  // the one that is tracked in git, shipped in releases, and read by the web
  // app.
  //
  // With the root file first, a developer who ran the plain `bun run build:db`
  // -- which produces no Pfam domains and no ESM2 embeddings, unlike
  // `build:db:annotated` -- would silently get a TUI missing those annotations
  // while the web app showed them. Two people would see different data for the
  // same phage with no way to tell.
  //
  // `PHAGE_EXPLORER_DB_PATH` above still overrides this for anyone deliberately
  // iterating on the pipeline, and the intermediate is reported below rather
  // than ignored in silence.
  add(path.join(process.cwd(), 'packages', 'web', 'public', 'phage.db'));

  // Build intermediate, kept as a fallback so a fresh `build:db` in a tree
  // without the committed database still works.
  add(path.join(process.cwd(), 'phage.db'));

  // Installer default
  add(getDefaultDbPath());

  // If compiled, the DB may live next to the executable
  if (process.execPath) {
    add(path.join(path.dirname(process.execPath), 'phage.db'));
  }

  return candidates;
}

async function resolveDbPath(): Promise<string | null> {
  for (const candidate of getCandidateDbPaths()) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

/**
 * Warn when a stale build intermediate is being shadowed.
 *
 * If both databases exist and differ, the developer is looking at the committed
 * one while a locally built `phage.db` sits in the repo root. That is the right
 * default, but silently preferring one of two databases is how the original
 * confusion arose, so say which one is in use.
 *
 * Compares size only. Hashing 10 MB on every start to produce a warning would
 * cost more than the warning is worth, and a size difference is enough to catch
 * the case that matters: an unannotated build:db output is materially smaller
 * than the annotated one.
 */
async function warnIfShadowedDatabase(inUse: string): Promise<void> {
  const intermediate = path.resolve(path.join(process.cwd(), 'phage.db'));
  if (path.resolve(inUse) === intermediate) return;

  const other = Bun.file(intermediate);
  if (!(await other.exists())) return;

  const [usedSize, otherSize] = [Bun.file(inUse).size, other.size];
  if (usedSize === otherSize) return;

  console.error(
    `Note: using ${inUse} (${usedSize} bytes).\n` +
      `      A different ${intermediate} (${otherSize} bytes) is also present and is\n` +
      `      being ignored. That file is a build intermediate; the one in use is the\n` +
      `      committed database the web app reads. Set PHAGE_EXPLORER_DB_PATH to\n` +
      `      override.`
  );
}

async function main() {
  const dbPath = await resolveDbPath();
  if (dbPath) await warnIfShadowedDatabase(dbPath);
  if (!dbPath) {
    const candidates = getCandidateDbPaths();
    console.error('Phage Explorer database not found.');
    console.error('Tried the following paths:');
    for (const candidate of candidates) {
      console.error(`  - ${candidate}`);
    }
    console.error('');
    console.error('Fix options:');
    console.error('  - If you installed via install.sh: re-run with `--with-database` to download it.');
    console.error(`  - Or place a database file at: ${getDefaultDbPath()}`);
    console.error('  - If working from source: run `bun run build:db` from the repo root.');
    console.error('  - Or set `PHAGE_EXPLORER_DB_PATH` to point to your `phage.db`.');
    process.exit(1);
  }

  // Create repository
  const repository = new BunSqliteRepository(dbPath);

  // Render the TUI
  // patchConsole: false prevents Ink from intercepting console output which can cause flickering
  // We don't use console.log during normal operation anyway
  const { waitUntilExit } = render(
    <App repository={repository} />,
    {
      exitOnCtrlC: true,
      patchConsole: false,
    }
  );

  // Wait for exit
  await waitUntilExit();

  // Cleanup
  await repository.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
