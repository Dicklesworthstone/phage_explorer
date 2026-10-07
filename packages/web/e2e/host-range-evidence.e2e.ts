import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type UserConfig, type InlineConfig } from 'vite';

// Exercise the actual overlay without a database dependency. No core calculations
// or component behavior are mocked; only input-file delivery is controlled.
let config: UserConfig | undefined;
async function workbench(page: Page, cacheDir: string, run: () => Promise<void>): Promise<void> {
  const root = process.cwd();
  const fixturePath = resolve(root, 'src/host-range-fixture.tsx');
  if (!config) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load Vite configuration');
    config = loaded.config;
  }
  const server = await createServer(mergeConfig(config, {
    root, configFile: false, cacheDir, server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'host-range-fixture',
      resolveId(id) { if (id === '/src/host-range-fixture.tsx') return fixturePath; },
      load(id) {
        if (id !== fixturePath) return;
        return `
          import React, { useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { CocktailCompatibilityOverlay } from './components/overlays/CocktailCompatibilityOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          function Fixture() {
            const { open } = useOverlay();
            useEffect(() => { open('cocktailCompatibility'); }, []);
            return <CocktailCompatibilityOverlay repository={null} currentPhage={null} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/host-range-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/host-range-fixture', '<div id="root"></div><script type="module" src="/src/host-range-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}host-range-fixture`);
    await run();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
}

test('measured coverage works without a database and replay recomputes source evidence', async ({ page }, info) => {
  await workbench(page, info.outputPath('vite-cache'), async () => {
    const panel = page.getByRole('region', { name: 'Measured host-range evidence', exact: true });
    await panel.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
    await expect(panel).toContainText('SYNTHETIC — NOT EXPERIMENTAL EVIDENCE');
    await expect(panel.getByRole('button', { name: 'Example B / Strain 1: untested', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Example A / Strain 1: positive', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Selected host-range evidence' })).toContainText('Generated fixture');
    await panel.getByRole('button', { name: 'Select by observed coverage', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Observed coverage', exact: true })).toContainText('Supported: 2 / 3');
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export host-range experiment', exact: true }).click();
    const downloaded = await downloading;
    const path = await downloaded.path();
    expect(path).not.toBeNull();
    const saved = JSON.parse(await readFile(path!, 'utf8'));
    expect(saved.selectedPhageIds).toEqual(['Example A', 'Example B']);
    expect(saved.result.supportedHostIds).toEqual(['Strain 1', 'Strain 2']);
    saved.query.minReplicates = 2;
    saved.result = { coverageFraction: 1, supportedHostIds: ['Strain 1', 'Strain 2', 'Strain 3'] };
    await panel.getByLabel('Host-range file (CSV, TSV, or saved JSON)').setInputFiles({ name: 'replay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
    await expect(panel.getByRole('region', { name: 'Observed coverage', exact: true })).toContainText('Supported: 0 / 3');
    await expect(panel.getByRole('button', { name: 'Example A / Strain 1: insufficient', exact: true })).toBeVisible();
    await panel.getByLabel('Assay and condition', { exact: true }).selectOption(JSON.stringify(['spot', 'Synthetic condition']));
    await expect(panel.getByRole('region', { name: 'Observed coverage', exact: true })).toContainText('Selected: none');
    await panel.getByLabel('Minimum independent replicates', { exact: true }).fill('1');
    await expect(panel.getByRole('button', { name: 'Example B / Strain 1: positive', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Example A / Strain 1: untested', exact: true })).toBeVisible();
  });
});

test('late file reads cannot replace newer evidence and duplicate observations fail closed', async ({ page }, info) => {
  await workbench(page, info.outputPath('vite-cache'), async () => {
    const panel = page.getByRole('region', { name: 'Measured host-range evidence', exact: true });
    const input = panel.getByLabel('Host-range file (CSV, TSV, or saved JSON)');
    const raw = panel.getByLabel('Host-range CSV/TSV or experiment JSON', { exact: true });
    const csv = 'phage_id,host_id,assay,condition,replicate,outcome,source\nOld,Host,plaque,C,r1,positive,S';
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = async function () {
        if (this.name === 'delayed.csv') await new Promise<void>(resolve => { (window as Window & { releaseHostRange?: () => void }).releaseHostRange = resolve; });
        const text = await original.call(this);
        if (this.name === 'delayed.csv') (window as Window & { hostRangeReadDone?: boolean }).hostRangeReadDone = true;
        return text;
      };
    });
    await input.setInputFiles({ name: 'delayed.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(panel.getByRole('status')).toContainText('Reading host-range evidence');
    await panel.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
    await page.evaluate(() => (window as Window & { releaseHostRange?: () => void }).releaseHostRange?.());
    await page.waitForFunction(() => (window as Window & { hostRangeReadDone?: boolean }).hostRangeReadDone === true);
    await expect(panel.getByRole('table', { name: 'Measured host-range matrix' })).toContainText('Example A');
    await expect(panel.getByRole('table', { name: 'Measured host-range matrix' })).not.toContainText('Old');
    await raw.fill(csv + '\nOld,Host,plaque,C,r1,negative,S');
    await expect(panel.getByRole('table', { name: 'Measured host-range matrix' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Load evidence', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('duplicate');
    await expect(panel.getByRole('button', { name: 'Export host-range experiment' })).toHaveCount(0);
  });
});


test('terminal-created experiments round trip through the browser and headless replay', async ({ page }, info) => {
  const source = info.outputPath('observations.csv');
  const experiment = info.outputPath('terminal-experiment.json');
  await writeFile(source, 'phage_id,host_id,assay,condition,replicate,outcome,source\nA,H1,plaque,C,r1,positive,Fixture\nA,H1,plaque,C,r2,positive,Fixture\nB,H2,plaque,C,r1,positive,Fixture\nB,H1,spot,C,r1,positive,Fixture');
  const launcher = resolve(process.cwd(), '../tui/src/index.tsx');
  const output = JSON.parse(execFileSync('bun', [launcher, 'host-range', 'analyze', '--input', source,
    '--assay', 'plaque', '--condition', 'C', '--min-replicates', '2', '--synthetic', '--greedy', '--output', experiment], { encoding: 'utf8' }));
  expect(output.coverage.supportedHostIds).toEqual(['H1']);
  await workbench(page, info.outputPath('vite-cache'), async () => {
    const panel = page.getByRole('region', { name: 'Measured host-range evidence', exact: true });
    await panel.getByLabel('Host-range file (CSV, TSV, or saved JSON)').setInputFiles(experiment);
    await expect(panel.getByRole('button', { name: 'A / H1: positive', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'B / H2: insufficient', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'B / H1: untested', exact: true })).toBeVisible();
    await panel.getByRole('checkbox', { name: 'Include B in observed coverage', exact: true }).check();
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export host-range experiment', exact: true }).click();
    const path = await (await downloading).path();
    expect(path).not.toBeNull();
    const saved = JSON.parse(await readFile(path!, 'utf8'));
    expect(saved.selectedPhageIds).toEqual(['A', 'B']);
    expect(saved.observations).toHaveLength(4);
    const replay = JSON.parse(execFileSync('bun', [launcher, 'host-range', 'replay', '--input', path!], { encoding: 'utf8' }));
    expect(replay.coverage).toEqual(saved.result);
    expect(replay.coverage.supportedHostIds).toEqual(['H1']);
    expect(replay.coverage.unresolvedHostIds).toEqual(['H2']);
    expect(replay.query.minReplicates).toBe(2);
    expect(replay.provenance).toBe('synthetic');
  });
});
