#!/usr/bin/env bun

import React from 'react';
import { render } from 'ink';
import { App } from './components/App';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import path from 'path';
import { homedir } from 'os';

function getDefaultDbPath(): string {
  // Matches install.sh (DATA_DIR="$HOME/.phage-explorer")
  return path.join(homedir(), '.phage-explorer', 'phage.db');
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

  // Development default (repo root)
  add(path.join(process.cwd(), 'phage.db'));

  // Development fallback: the repo ships the complete web database
  add(path.join(process.cwd(), 'packages', 'web', 'public', 'phage.db'));

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

async function main() {
  const dbPath = await resolveDbPath();
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
