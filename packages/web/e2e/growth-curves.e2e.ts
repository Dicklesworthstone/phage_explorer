import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type UserConfig, type InlineConfig } from 'vite';

// A real browser/component journey without a database download. It exercises
// the production hub, keyboard registrations, panel, and core fitting code.
let config: UserConfig | undefined;
async function withGrowthWorkbench(page: Page, cacheDir: string, run: () => Promise<void>): Promise<void> {
  const root = process.cwd();
  const fixturePath = resolve(root, 'src/growth-workbench-fixture.tsx');
  if (!config) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load Vite config for growth workbench fixture.');
    config = loaded.config;
  }
  const server = await createServer(mergeConfig(config, {
    root, configFile: false, cacheDir,
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'growth-workbench-fixture',
      resolveId(id) { if (id === '/src/growth-workbench-fixture.tsx') return fixturePath; },
      load(id) {
        if (id !== fixturePath) return;
        return `
          import React, { useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SimulationHub } from './components/overlays/SimulationHub';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          function Fixture() {
            const { open } = useOverlay();
            useEffect(() => { open('simulationHub'); }, []);
            return <SimulationHub />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/growth-workbench-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/growth-workbench-fixture', '<div id="root"></div><script type="module" src="/src/growth-workbench-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}growth-workbench-fixture`);
    await page.locator('summary').filter({ hasText: 'Analyze measured growth curves' }).click();
    await run();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
}

const fixture = {
  schemaVersion: 'one-step-growth-v1', method: 'nonnegative-grid-ramp-v1', measurement: 'extracellular-pfu-per-ml',
  title: 'Uploaded synthetic assay', provenance: { kind: 'synthetic', source: 'Generated browser regression data; not a biological experiment.' },
  observations: Array.from({ length: 11 }, (_, i) => ({ timeMin: i * 5, pfuPerMl: 10000 + 100000 * Math.max(0, Math.min(1, (i * 5 - 15) / 15)) })),
  options: { infectedCentersPerMl: 2000, bootstrapSamples: 20, seed: 0 },
  result: { infectiousYieldPerInfectedCenter: 99999 }, // Must be ignored on replay.
};

function upload(name: string, contents: string, mimeType = 'application/json') {
  return { name, mimeType, buffer: Buffer.from(contents) };
}

test('growth data can be fitted, edited, compared, exported, and replayed without stale evidence', async ({ page }, info) => {
  await withGrowthWorkbench(page, info.outputPath('vite-cache'), async () => {
    const hub = page.getByTestId('overlay-simulationHub');
    const panel = hub.getByRole('region', { name: 'Measured extracellular growth curves', exact: true });
    const results = panel.getByRole('region', { name: 'Growth-curve fit results' });
    const exportButton = panel.getByRole('button', { name: 'Export replayable experiment JSON' });
    const centers = panel.getByLabel('Measured infected centers/mL (optional)', { exact: true });
    const yieldRow = () => results.getByRole('row').filter({ hasText: 'Net infectious yield per measured infected center' });
    await expect(exportButton).toBeDisabled();
    await panel.getByRole('button', { name: 'Load clearly labeled synthetic example' }).click();
    await panel.getByRole('button', { name: 'Fit observations', exact: true }).click();
    await expect(results).toContainText('SYNTHETIC — NOT EXPERIMENTAL EVIDENCE');
    await expect(yieldRow().getByRole('cell').first()).toHaveText('50');
    await panel.getByRole('button', { name: 'Pin result for comparison' }).click();
    await centers.fill('4000');
    await expect(exportButton).toBeDisabled();
    await expect(results).toHaveCount(0);
    // Enter submits the form, rather than launching a simulation via hub hotkeys.
    await centers.press('Enter');
    await expect(hub).toBeVisible();
    await expect(yieldRow().getByRole('cell').first()).toHaveText('25');
    await expect(yieldRow().getByRole('cell').last()).toHaveText('-25');
    const downloading = page.waitForEvent('download');
    await exportButton.click();
    const downloaded = await downloading;
    const path = await downloaded.path();
    expect(path).not.toBeNull();
    const saved = JSON.parse(await readFile(path!, 'utf8'));
    expect(saved.options.infectedCentersPerMl).toBe(4000);
    expect(saved.provenance.kind).toBe('synthetic');
    expect(saved.result.infectiousYieldPerInfectedCenter).toBeCloseTo(25);
    await panel.getByLabel('Import CSV, TSV, or experiment JSON (up to 1 MB)').setInputFiles(upload('experiment.json', JSON.stringify(fixture)));
    await expect(results.getByRole('heading', { name: fixture.title })).toBeVisible();
    await expect(yieldRow().getByRole('cell').first()).toHaveText('50');
    await expect(panel.getByLabel('Reproducible seed (0–4294967295)')).toHaveValue('0');
    await expect(results).not.toContainText('99999');
    await centers.fill('Infinity');
    await panel.getByRole('button', { name: 'Fit observations', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('positive measured concentration');
    await expect(exportButton).toBeDisabled();
    await centers.fill('');
    await panel.getByRole('button', { name: 'Fit observations', exact: true }).click();
    await expect(yieldRow().getByRole('cell').first()).toHaveText('Not identified / not supplied');
    await page.reload();
    await page.locator('summary').filter({ hasText: 'Analyze measured growth curves' }).click();
    await expect(panel.getByLabel('Experiment title', { exact: true })).toHaveValue(fixture.title);
    await expect(panel.getByLabel('Reproducible seed (0–4294967295)')).toHaveValue('0');
    await expect(exportButton).toBeDisabled(); // Draft restored, old results not trusted.
  });
});

test('late imports cannot replace edits and ambiguous assay files fail closed', async ({ page }, info) => {
  await withGrowthWorkbench(page, info.outputPath('vite-cache'), async () => {
    const panel = page.getByRole('region', { name: 'Measured extracellular growth curves', exact: true });
    const input = panel.getByLabel('Import CSV, TSV, or experiment JSON (up to 1 MB)');
    await input.setInputFiles(upload('wrong-assay.json', JSON.stringify({ ...fixture, measurement: 'total-infective-centers' })));
    await expect(panel.getByRole('alert')).toContainText('extracellular PFU/mL');
    await expect(panel.getByRole('button', { name: 'Export replayable experiment JSON' })).toBeDisabled();
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = async function () {
        if (this.name === 'delayed.json') await new Promise<void>(resolve => {
          (window as Window & { releaseGrowthFile?: () => void }).releaseGrowthFile = resolve;
        });
        const text = await original.call(this);
        if (this.name === 'delayed.json') (window as Window & { growthFileReadFinished?: boolean }).growthFileReadFinished = true;
        return text;
      };
    });
    await input.setInputFiles(upload('delayed.json', JSON.stringify(fixture)));
    await expect(panel.getByRole('status').filter({ hasText: 'Reading experiment file' })).toBeVisible();
    await panel.getByLabel('Experiment title', { exact: true }).fill('Newer local edit');
    await page.evaluate(() => (window as Window & { releaseGrowthFile?: () => void }).releaseGrowthFile?.());
    await page.waitForFunction(() => (window as Window & { growthFileReadFinished?: boolean }).growthFileReadFinished === true);
    await expect(panel.getByLabel('Experiment title', { exact: true })).toHaveValue('Newer local edit');
    await expect(panel.getByRole('region', { name: 'Growth-curve fit results' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Export replayable experiment JSON' })).toBeDisabled();
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
