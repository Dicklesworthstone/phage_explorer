#!/usr/bin/env bun

import React from 'react';
import { render } from 'ink';
import { App } from './components/App';
import { TerminalSizeGate } from './components/terminal-size';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { createLocalGenomeRepository, mergeLocalGenomes } from '@phage-explorer/db-runtime/local-genomes';
import { exportLocalGenomeBundle, importLocalGenomes, GENOME_IMPORT_LIMITS, type LocalGenome } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'path';
import { homedir } from 'os';

function terminalLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '�');
}

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
      'Import DNA FASTA, GenBank or a version 1 local genome bundle (up to 10 MiB).\n' +
      'Local records stay in session memory; the curated database is read-only during import.\n' +
      '--no-catalog opens only the imported records. Conflicting accessions require an\n' +
      'explicit --allow-accession-collisions decision; existing records are never replaced.\n' +
      '--export-bundle saves the complete original inputs and selected local view on exit.\n' +
      'The destination must not exist. Full analysis-action replay is not included.\n');
    return;
  }
  if (!values.import && (values['no-catalog'] || values['export-bundle'] || values['allow-accession-collisions'])) {
    throw new Error('--no-catalog, --export-bundle and --allow-accession-collisions require --import FILE');
  }
  const exportPath = values['export-bundle'] ? path.resolve(values['export-bundle']) : undefined;
  if (exportPath) {
    const existing = await lstat(exportPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) throw new Error(`Export destination already exists; refusing to overwrite ${exportPath}`);
  }
  const imported = values.import ? await (async () => {
    const file = Bun.file(values.import!);
    if (!(await file.exists())) throw new Error(`Genome file not found: ${values.import}`);
    if (file.size > GENOME_IMPORT_LIMITS.bytes) throw new Error('Input exceeds the 10 MiB limit.');
    return importLocalGenomes({ name: path.basename(values.import!), text: await file.text() }, (completed, total) => {
      process.stderr.write(`Parsed ${completed} of ${total} local records\n`);
    });
  })() : null;
  const dbPath = values['no-catalog'] ? null : await resolveDbPath();
  if (dbPath) await warnIfShadowedDatabase(dbPath);
  if (!dbPath && !imported) {
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
  const base = dbPath ? new BunSqliteRepository(dbPath, { readonly: imported !== null }) : null;
  let localGenomes: LocalGenome[] = [];
  try {
    if (imported) {
      localGenomes = mergeLocalGenomes([], imported, await base?.listPhages() ?? [], values['allow-accession-collisions']).map(genome => ({
        ...genome,
        // Ink interprets terminal escape sequences. Sanitize display labels,
        // keeping the exact original input and content identity for export.
        phage: { ...genome.phage, name: terminalLabel(genome.phage.name), accession: terminalLabel(genome.phage.accession),
          genes: genome.phage.genes.map(gene => ({ ...gene,
            name: gene.name === null ? null : terminalLabel(gene.name),
            locusTag: gene.locusTag === null ? null : terminalLabel(gene.locusTag),
            product: gene.product === null ? null : terminalLabel(gene.product),
          })),
        },
      }));
      for (const genome of localGenomes) for (const warning of genome.warnings) {
        process.stderr.write(`${genome.phage.accession}: ${terminalLabel(warning)}\n`);
      }
    }
  } catch (error) {
    await base?.close();
    throw error;
  }
  const repository = imported ? createLocalGenomeRepository(base, localGenomes) : base!;
  if (imported) {
    const list = await repository.listPhages();
    const selected = localGenomes.find(genome => genome.phage.localGenome?.contentId === imported.view?.contentId) ?? localGenomes[0];
    const state = usePhageStore.getState();
    state.setPhages(list);
    state.setCurrentPhageIndex(list.findIndex(phage => phage.id === selected.phage.id));
    if (imported.view) {
      state.setViewMode(imported.view.viewMode);
      state.setReadingFrame(imported.view.readingFrame);
      state.setScrollPosition(imported.view.scrollPosition);
    }
  }

  // Render the TUI
  // patchConsole: false prevents Ink from intercepting console output which can cause flickering
  // We don't use console.log during normal operation anyway
  // Gate on terminal size before mounting the app. Overlays declare widths up
  // to 92 columns, so a narrow window produced unreadable wrapping with no
  // explanation, while the README promised graceful degradation.
  const { waitUntilExit } = render(
    <TerminalSizeGate>
      <App repository={repository} />
    </TerminalSizeGate>,
    {
      exitOnCtrlC: true,
      patchConsole: false,
    }
  );

  // Wait for exit
  try {
    await waitUntilExit();
    if (exportPath) {
      const state = usePhageStore.getState();
      const contentId = state.currentPhage?.localGenome?.contentId;
      const view = contentId ? { contentId, viewMode: state.viewMode, readingFrame: state.readingFrame, scrollPosition: state.scrollPosition } : undefined;
      // Exclusive creation also protects against a destination appearing after
      // the startup check. Existing code, input and data are never overwritten.
      await writeFile(exportPath, exportLocalGenomeBundle(localGenomes, view), { encoding: 'utf8', flag: 'wx' });
      process.stderr.write(`Saved local genome bundle: ${exportPath}\n`);
    }
  } finally {
    await repository.close();
  }
}

if (import.meta.main) main().catch(err => {
  console.error('Phage Explorer:', terminalLabel(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
