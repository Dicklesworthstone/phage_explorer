#!/usr/bin/env bun

import React from 'react';
import { render } from 'ink';
import { LocalGenomeApp, currentTerminalGenomeView, installTerminalGenomes } from './components/LocalGenomeApp';
import { TerminalGenomeSession, loadTerminalGenomeFile, terminalGenomeLabel as terminalLabel } from './local-genome-session';
import { TerminalSizeGate } from './components/terminal-size';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { mergeLocalGenomes } from '@phage-explorer/db-runtime/local-genomes';
import type { LocalGenome } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { parseArgs } from 'node:util';
import { lstat } from 'node:fs/promises';
import path from 'path';
import { homedir } from 'os';
import { version } from '../../../package.json';

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
  if (Bun.argv[2] === '--version' || Bun.argv[2] === '-V') {
    process.stdout.write(`phage-explorer ${version}\n`);
    return;
  }
  // Headless scientific workflows must not require a catalog or initialize Ink.
  if (Bun.argv[2] === 'host-metabolism') {
    const { runHostMetabolismProcess } = await import('./commands/host-metabolism');
    await runHostMetabolismProcess(Bun.argv.slice(3));
    return;
  }
  if (Bun.argv[2] === 'abundance') {
    if (Bun.argv[3] === 'view') {
      const { launchAbundanceView } = await import('./components/AbundanceView');
      await launchAbundanceView(Bun.argv.slice(4));
    } else {
      const { runAbundanceProcess } = await import('./commands/abundance');
      await runAbundanceProcess(Bun.argv.slice(3));
    }
    return;
  }
  const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, allowPositionals: false, options: {
    import: { type: 'string' },
    'allow-accession-collisions': { type: 'boolean', default: false },
    'no-catalog': { type: 'boolean', default: false },
    'export-bundle': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    process.stdout.write('Phage Explorer\n\n' +
      'Usage: phage-explorer [--import FILE] [--no-catalog]\n' +
      '                      [--allow-accession-collisions] [--export-bundle NEW_FILE]\n\n' +
      'phage-explorer --version prints the release version without opening a catalog.\n\n' +
      'Import DNA FASTA, GenBank or a version 1 local genome bundle (up to 10 MiB).\n' +
      'Local records stay in session memory; the curated database is read-only during import.\n' +
      '--no-catalog opens a private workspace, even without a startup --import file.\n' +
      'Open Ctrl+P and choose Local genomes to import, restore or export without restarting.\n' +
      'Conflicting startup accessions require an\n' +
      'explicit --allow-accession-collisions decision; existing records are never replaced.\n' +
      '--export-bundle saves the complete original inputs and selected local view on exit.\n' +
      'The destination must not exist. Full analysis-action replay is not included.\n\n' +
      'Local community analysis: phage-explorer abundance view|inspect|analyze|replay FILE\n' +
      'See phage-explorer abundance --help for metadata, parameters, stdin and exports.\n' +
      'Host-model scenarios: phage-explorer host-metabolism reference|inspect|analyze|replay INPUT\n' +
      'See phage-explorer host-metabolism --help for published references and offline replay.\n');
    return;
  }
  if (!values.import && values['allow-accession-collisions']) {
    throw new Error('--allow-accession-collisions requires --import FILE; in-app imports have their own explicit decision.');
  }
  const exportPath = values['export-bundle'] ? path.resolve(values['export-bundle']) : undefined;
  if (exportPath) {
    const existing = await lstat(exportPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) throw new Error(`Export destination already exists; refusing to overwrite ${exportPath}`);
  }
  const imported = values.import
    ? await loadTerminalGenomeFile(path.resolve(values.import), new AbortController().signal)
    : null;
  const dbPath = values['no-catalog'] ? null : await resolveDbPath();
  if (dbPath) await warnIfShadowedDatabase(dbPath);
  if (!dbPath && !imported && !values['no-catalog']) {
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
    console.error('  - Or set PHAGE_EXPLORER_DB_PATH to point to your `phage.db`.');
    process.exit(1);
  }

  // Create repository
  const base = dbPath ? new BunSqliteRepository(dbPath, { readonly: imported !== null }) : null;
  let localGenomes: LocalGenome[] = [];
  try {
    if (imported) {
      localGenomes = mergeLocalGenomes([], imported, await base?.listPhages() ?? [], values['allow-accession-collisions']);
      for (const genome of localGenomes) for (const warning of genome.warnings) {
        process.stderr.write(`${terminalLabel(genome.phage.accession)}: ${terminalLabel(warning)}\n`);
      }
    }
  } catch (error) {
    await base?.close();
    throw error;
  }
  const session = new TerminalGenomeSession(base, localGenomes);
  try {
    const repository = session.getSnapshot().repository;
    const list = await repository.listPhages();
    usePhageStore.getState().setPhages(list);
    if (imported) {
      const selected = localGenomes.find(genome => genome.phage.localGenome?.contentId === imported.view?.contentId) ?? localGenomes[0];
      const view = imported.view ?? { contentId: selected.phage.localGenome!.contentId,
        viewMode: 'dna' as const, readingFrame: 0 as const, scrollPosition: 0 };
      session.exportBundle(view); // validate the exact view before changing the store
      const displayed = await repository.getPhageById(selected.phage.id);
      if (!displayed) throw new Error('The imported selection is unavailable.');
      installTerminalGenomes({ repository, phages: list, selected: displayed, view });
    }

    // The manager temporarily owns the screen and input; App remounts with the
    // accepted repository so no old analysis cache can leak into a new session.
    const { waitUntilExit } = render(
      <TerminalSizeGate>
        <LocalGenomeApp session={session} initiallyOpen={list.length === 0} />
      </TerminalSizeGate>,
      { exitOnCtrlC: true, patchConsole: false }
    );
    await waitUntilExit();
    if (exportPath) {
      // This includes records added IN the running app, not just startup input.
      if (!await session.save(exportPath, currentTerminalGenomeView())) {
        throw new Error(session.getSnapshot().error ?? 'Local genome bundle was not saved.');
      }
      process.stderr.write(`Saved local genome bundle: ${terminalLabel(exportPath)}\n`);
    }
  } finally {
    await session.close();
  }
}

if (import.meta.main) main().catch(err => {
  console.error('Phage Explorer:', terminalLabel(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
