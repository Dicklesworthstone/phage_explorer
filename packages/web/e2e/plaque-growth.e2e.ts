import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { replayPlaqueGrowthRecord, type PlaqueGrowthFit } from '../../core/src/analysis/plaque-growth';

interface PlaqueFixture extends Window {
  holdPlaqueReply: boolean; plaqueReplyHeld: boolean; releasePlaqueReply(): void;
  holdPlaqueRead: boolean; plaqueReadHeld: boolean; releasePlaqueRead(): void;
}
let config: UserConfig | undefined;
// Real integrated component, Vite transforms and module worker. Only message/file
// delivery may be delayed; no fit or numerical result is supplied by the fixture.
const test = base.extend<{ plaqueFixture: void }>({
  plaqueFixture: [async ({ page }, use, info) => {
    const root = process.cwd(), fixtureId = resolve(root, 'src/plaque-growth-fixture.tsx');
    if (!config) {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
      if (!loaded) throw new Error('Web build configuration is unavailable.');
      config = loaded.config;
    }
    const server = await createServer(mergeConfig(config, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'), server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{ name: 'plaque-growth-fixture',
        resolveId(id) { if (id === '/src/plaque-growth-fixture.tsx') return fixtureId; },
        load(id) {
          if (id !== fixtureId) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { GrowthCurveExperimentPanel } from './components/overlays/GrowthCurveExperimentPanel';
            import './styles/index.css';
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                super(url, options);
                this.addEventListener('message', event => {
                  if (!window.holdPlaqueReply || event.data?.record?.method?.id !== 'plaque-count-growth') return;
                  window.holdPlaqueReply = false; window.plaqueReplyHeld = true;
                  const data = event.data; event.stopImmediatePropagation();
                  window.releasePlaqueReply = () => this.dispatchEvent(new MessageEvent('message', { data }));
                });
              }
            };
            const originalRead = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = async function() {
              const bytes = await originalRead.call(this);
              if (window.holdPlaqueRead) {
                window.holdPlaqueRead = false; window.plaqueReadHeld = true;
                await new Promise(resolve => { window.releasePlaqueRead = resolve; });
              }
              return bytes;
            };
            createRoot(document.getElementById('root')).render(<React.StrictMode><GrowthCurveExperimentPanel /></React.StrictMode>);
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/plaque-fixture', (_request, response, next) => {
            void vite.transformIndexHtml('/plaque-fixture', '<div id="root"></div><script type="module" src="/src/plaque-growth-fixture.tsx"></script>')
              .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
          });
        },
      }],
    }) as InlineConfig);
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await server.listen(); const address = server.resolvedUrls?.local[0];
      if (!address) throw new Error('Fixture server has no address.');
      await page.goto(`${address}plaque-fixture`);
      await expect(page.getByRole('heading', { name: 'Raw plaque-count growth experiments', exact: true })).toBeVisible();
      await use(); expect(pageErrors).toEqual([]);
    } finally { await server.close(); }
  }, { auto: true }],
});
const csv = 'time_min,plaque_count,dilution_fraction,volume_ml\n' + Array.from({ length: 9 }, (_, time) =>
  `${time},${10 + 100 * Math.max(0, Math.min(1, (time - 3) / 2))},1,1`).join('\n') + '\n';
async function download(page: Page, name: string): Promise<string> {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name, exact: true }).click();
  const path = await (await event).path(); if (!path) throw new Error('Download bytes unavailable.');
  return readFile(path, 'utf8');
}
async function fitExample(page: Page) {
  await page.getByRole('button', { name: 'Load synthetic plate-count example', exact: true }).click();
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect(page.getByTestId('plaque-growth-status')).toContainText('Fresh fit accepted');
  return page.getByTestId('plaque-growth-result').getAttribute('data-result-id');
}

test('raw CSV review, fitting, native-compatible evidence and reload/replay preserve the exact assay', async ({ page }) => {
  await page.getByLabel('Load plate CSV/TSV for review (up to 1 MB)', { exact: true }).setInputFiles({ name: 'measurements.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByLabel('Raw plate CSV', { exact: true })).toHaveValue(csv);
  await expect(page.getByTestId('plaque-growth-result')).toHaveCount(0);
  await page.getByLabel('Plate source and assay context', { exact: true }).fill('Synthetic test counts entered through the CSV route; not empirical data.');
  await page.getByLabel('Plate data provenance', { exact: true }).selectOption('synthetic');
  await page.getByLabel('I confirm uncensored extracellular free-phage plaque counts.', { exact: true }).check();
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect(page.getByTestId('plaque-growth-status')).toContainText('Fresh fit accepted');
  const saved = await download(page, 'Export plaque evidence JSON'), record = await parseAnalysisRecord(saved);
  const fit = record.fields.fit.value as unknown as PlaqueGrowthFit;
  expect(Math.abs(fit.backgroundPFUPerMl - 10)).toBeLessThan(1e-6);
  expect(Math.abs(fit.increasePFUPerMl - 100)).toBeLessThan(1e-6);
  expect([fit.riseStartMin, fit.riseEndMin]).toEqual([3, 5]); expect(fit.infectiousYieldPerInfectedCenter).toBeNull();
  expect(JSON.parse(String(record.inputs[0].data)).csv).toBe(csv);
  expect((await replayPlaqueGrowthRecord(saved)).resultId).toBe(record.resultId);
  const table = await download(page, 'Export fitted plates TSV');
  await page.getByLabel('Plate experiment title', { exact: true }).fill('Unapplied edit');
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', record.resultId);
  await expect(page.getByTestId('plaque-growth-result')).toContainText('Draft edits are not applied');
  expect(await download(page, 'Export plaque evidence JSON')).toBe(saved);
  await page.reload();
  await page.getByLabel('Restore and verify plaque evidence JSON (up to 10 MiB)', { exact: true }).setInputFiles({ name: 'evidence.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
  await expect(page.getByTestId('plaque-growth-status')).toContainText('verified by fresh replay');
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', record.resultId);
  expect(await download(page, 'Export fitted plates TSV')).toBe(table);
  // The existing corrected-PFU form was not replaced by the count assay.
  await expect(page.getByRole('button', { name: 'Fit observations', exact: true })).toBeEnabled();
});

test('rehashed false evidence and malformed input cannot replace the accepted browser result', async ({ page }) => {
  const id = await fitExample(page), original = await parseAnalysisRecord(await download(page, 'Export plaque evidence JSON'));
  const changed = structuredClone(original); (changed.fields.fit.value as unknown as PlaqueGrowthFit).increaseSupport = [[0, 0]];
  const forged = await createAnalysisRecord({ method: changed.method, parameters: changed.parameters, fields: changed.fields, references: changed.references, seed: changed.seed,
    inputs: changed.inputs.map(({ sha256: _sha, ...row }) => row) });
  await page.getByLabel('Restore and verify plaque evidence JSON (up to 10 MiB)', { exact: true }).setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(forged)) });
  await expect(page.getByRole('alert')).toContainText('Recomputed');
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', id!);
  await page.getByLabel('Fit plaque input JSON (up to 1 MB)', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from([255]) });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', id!);
});

test('cancelled worker replies and delayed file reads do not overwrite subsequent accepted evidence', async ({ page }) => {
  await page.getByRole('button', { name: 'Load synthetic plate-count example', exact: true }).click();
  await page.evaluate(() => { (window as PlaqueFixture).holdPlaqueReply = true; });
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as PlaqueFixture).plaqueReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel plate-count work', exact: true }).click();
  await page.getByLabel('Plate experiment title', { exact: true }).fill('Subsequent fit');
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect(page.getByTestId('plaque-growth-status')).toContainText('Fresh fit accepted');
  const id = await page.getByTestId('plaque-growth-result').getAttribute('data-result-id');
  await page.evaluate(() => (window as PlaqueFixture).releasePlaqueReply());
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', id!);
  await page.evaluate(() => { (window as PlaqueFixture).holdPlaqueRead = true; });
  await page.getByLabel('Load plate CSV/TSV for review (up to 1 MB)', { exact: true }).setInputFiles({ name: 'delayed.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect.poll(() => page.evaluate(() => (window as PlaqueFixture).plaqueReadHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel plate-count work', exact: true }).click();
  await page.getByLabel('Plate experiment title', { exact: true }).fill('Newer draft');
  await page.evaluate(() => (window as PlaqueFixture).releasePlaqueRead());
  await expect(page.getByLabel('Plate experiment title', { exact: true })).toHaveValue('Newer draft');
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', id!);
});

test('all-zero input shows unavailable timing and nonzero upper support rather than a confident flat-growth claim', async ({ page }) => {
  await page.getByRole('button', { name: 'Load synthetic plate-count example', exact: true }).click();
  await page.getByLabel('Raw plate CSV', { exact: true }).fill(csv.replace(/^(\d+),\d+,/gm, '$1,0,'));
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect(page.getByTestId('plaque-timing-status')).toContainText('timing is unavailable');
  const record = await parseAnalysisRecord(await download(page, 'Export plaque evidence JSON'));
  const fit = record.fields.fit.value as unknown as PlaqueGrowthFit;
  expect(fit.totalPlaques).toBe(0); expect(fit.riseStartMin).toBeNull(); expect(fit.increaseSupport[0][1]).toBeGreaterThan(0);
  await expect(page.getByTestId('plaque-growth-result')).toContainText('not calibrated confidence intervals');
});
