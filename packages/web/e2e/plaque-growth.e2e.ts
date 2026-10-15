import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { replayPlaqueGrowthRecord, type PlaqueGrowthFit } from '../../core/src/analysis/plaque-growth';
import { replayGrowthCurveRecord, type GrowthCurveFit } from '../../core/src/analysis/one-step-growth';

interface PlaqueFixture extends Window {
  holdPlaqueReply: boolean; plaqueReplyHeld: boolean; releasePlaqueReply(): void;
  holdPlaqueRead: boolean; plaqueReadHeld: boolean; releasePlaqueRead(): void;
  holdPfuReply: boolean; pfuReplyHeld: boolean; releasePfuReply(): void;
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
                  if (window.holdPfuReply && event.data?.record?.method?.id === 'extracellular-pfu-growth') {
                    window.holdPfuReply = false; window.pfuReplyHeld = true;
                    const data = event.data; event.stopImmediatePropagation();
                    window.releasePfuReply = () => this.dispatchEvent(new MessageEvent('message', { data }));
                    return;
                  }
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
  await page.getByLabel('I confirm extracellular free-phage counts and any explicitly recorded inclusive bounds.', { exact: true }).check();
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

async function fitCorrectedExample(page: Page) {
  await page.getByRole('button', { name: 'Load clearly labeled synthetic example', exact: true }).click();
  await page.getByLabel('Bootstrap samples (0, or 20–200)', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Fit observations', exact: true }).click();
  await expect(page.getByTestId('corrected-pfu-status')).toContainText('Fresh fit accepted');
}
const correctedImport = (page: Page) => page.getByLabel('Import CSV, TSV, or experiment JSON (input up to 1 MB; evidence up to 10 MiB)', { exact: true });

test('corrected-PFU worker fit exports old and portable formats, preserves accepted inputs and replays after reload', async ({ page }) => {
  await fitCorrectedExample(page);
  const evidence = await download(page, 'Export verified PFU evidence JSON'), record = await parseAnalysisRecord(evidence);
  const fit = record.fields.fit.value as unknown as GrowthCurveFit;
  expect(record.method.id).toBe('extracellular-pfu-growth');
  expect(Math.abs(fit.baselinePFUPerMl - 10000)).toBeLessThan(1e-5);
  expect(Math.abs(fit.increasePFUPerMl - 100000)).toBeLessThan(1e-5);
  expect([fit.riseStartMin, fit.riseEndMin]).toEqual([15, 30]); expect(fit.bootstrapSamples).toBe(20);
  expect((await replayGrowthCurveRecord(evidence)).resultId).toBe(record.resultId);
  const legacy = await download(page, 'Export replayable experiment JSON'), residuals = await download(page, 'Export residuals CSV');
  expect(JSON.parse(legacy).schemaVersion).toBe('one-step-growth-v1'); expect(JSON.parse(legacy).result).toEqual(fit);
  await page.getByRole('button', { name: 'Pin result for comparison', exact: true }).click();
  await page.getByLabel('Experiment title', { exact: true }).fill('Unapplied corrected-PFU edit');
  await expect(page.getByRole('region', { name: 'Growth-curve fit results' })).toHaveAttribute('data-result-id', record.resultId);
  expect(await download(page, 'Export verified PFU evidence JSON')).toBe(evidence);
  await page.reload();
  await correctedImport(page).setInputFiles({ name: 'corrected.json', mimeType: 'application/json', buffer: Buffer.from(evidence) });
  await expect(page.getByTestId('corrected-pfu-status')).toContainText('verified by fresh replay');
  expect(await download(page, 'Export residuals CSV')).toBe(residuals);
  expect(await download(page, 'Export verified PFU evidence JSON')).toBe(evidence);
});

test('corrected-PFU import refuses false legacy answers and rehashed intervals without losing an accepted result', async ({ page }) => {
  await fitCorrectedExample(page);
  const evidence = await download(page, 'Export verified PFU evidence JSON'), record = await parseAnalysisRecord(evidence);
  const old = JSON.parse(await download(page, 'Export replayable experiment JSON')); old.result.increasePFUPerMl = 0;
  await correctedImport(page).setInputFiles({ name: 'altered-legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.getByRole('alert')).toContainText('legacy saved result');
  await expect(page.getByRole('region', { name: 'Growth-curve fit results' })).toHaveAttribute('data-result-id', record.resultId);
  const changed = structuredClone(record); (changed.fields.fit.value as unknown as GrowthCurveFit).intervals!.increasePFUPerMl = [0, 0];
  const forged = await createAnalysisRecord({ method: changed.method, parameters: changed.parameters, fields: changed.fields,
    references: changed.references, seed: changed.seed, inputs: changed.inputs.map(({ sha256: _sha, ...row }) => row) });
  await correctedImport(page).setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(forged)) });
  await expect(page.getByRole('alert')).toContainText('Recomputed corrected-PFU');
  await expect(page.getByRole('region', { name: 'Growth-curve fit results' })).toHaveAttribute('data-result-id', record.resultId);
  expect(await download(page, 'Export verified PFU evidence JSON')).toBe(evidence);
});

test('cancelling corrected-PFU worker and file deliveries prevents stale results or draft replacement', async ({ page }) => {
  await fitCorrectedExample(page);
  const evidence = await download(page, 'Export verified PFU evidence JSON');
  await page.evaluate(() => { (window as PlaqueFixture).holdPfuReply = true; });
  await page.getByRole('button', { name: 'Fit observations', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as PlaqueFixture).pfuReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel corrected-PFU work', exact: true }).click();
  await page.getByLabel('Experiment title', { exact: true }).fill('New corrected-PFU fit');
  await page.getByRole('button', { name: 'Fit observations', exact: true }).click();
  await expect(page.getByTestId('corrected-pfu-status')).toContainText('Fresh fit accepted');
  const newer = await download(page, 'Export verified PFU evidence JSON'); expect(newer).not.toBe(evidence);
  await page.evaluate(() => (window as PlaqueFixture).releasePfuReply());
  expect(await download(page, 'Export verified PFU evidence JSON')).toBe(newer);
  await page.evaluate(() => { (window as PlaqueFixture).holdPlaqueRead = true; });
  await correctedImport(page).setInputFiles({ name: 'late.json', mimeType: 'application/json', buffer: Buffer.from(evidence) });
  await expect.poll(() => page.evaluate(() => (window as PlaqueFixture).plaqueReadHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel corrected-PFU work', exact: true }).click();
  await page.getByLabel('Experiment title', { exact: true }).fill('Kept draft');
  await page.evaluate(() => (window as PlaqueFixture).releasePlaqueRead());
  await expect(page.getByLabel('Experiment title', { exact: true })).toHaveValue('Kept draft');
  expect(await download(page, 'Export verified PFU evidence JSON')).toBe(newer);
});

test('explicit count bounds retain unknown totals and unavailable residuals through browser export and replay', async ({ page }) => {
  await page.getByLabel('Plate CSV format', { exact: true }).selectOption('2');
  await fitExample(page);
  const result = page.getByTestId('plaque-growth-result');
  await expect(result).toContainText('Accepted method version: 2');
  await expect(result).toContainText('total plaques: Unavailable');
  await expect(page.getByTestId('plaque-count-coverage')).toContainText('upper-bound plates: 1; lower-bound plates: 1');
  await expect(result.locator('svg').first().locator('[data-plate-status="at-most"]')).toHaveCount(1);
  await expect(result.locator('svg').first().locator('[data-plate-status="at-least"]')).toHaveCount(1);
  await result.getByText('Inspect plate residuals and exposures', { exact: true }).click();
  const table = page.getByRole('table', { name: 'Accepted plate counts and residuals' });
  await expect(table.getByRole('row').filter({ hasText: 'at-most' })).toContainText('Unavailable');
  await expect(result.locator('svg').nth(1).locator('[data-plate-status="at-most"], [data-plate-status="at-least"]')).toHaveCount(0);
  const evidence = await download(page, 'Export plaque evidence JSON'), accepted = await replayPlaqueGrowthRecord(evidence);
  expect(accepted.method.version).toBe('2');
  const before = await result.getAttribute('data-result-id'), exported = await download(page, 'Export fitted plates TSV');
  const upper = exported.split('\n').find(row => row.startsWith('2\t'))!.split('\t');
  expect(upper[2]).toBe('at-most'); expect(upper[7]).toBe('');
  await page.getByLabel('Plate CSV format', { exact: true }).selectOption('1');
  await expect(result).toContainText('Accepted method version: 2');
  expect(await download(page, 'Export plaque evidence JSON')).toBe(evidence);
  await page.getByLabel('Restore and verify plaque evidence JSON (up to 10 MiB)', { exact: true }).setInputFiles({ name: 'bounds.json', mimeType: 'application/json', buffer: Buffer.from(evidence) });
  await expect(page.getByTestId('plaque-growth-status')).toContainText('verified by fresh replay');
  await expect(result).toHaveAttribute('data-result-id', before!);
  await expect(page.getByLabel('Plate CSV format', { exact: true })).toHaveValue('2');
  expect(await download(page, 'Export fitted plates TSV')).toBe(exported);
});

test('CSV schema selection does not infer censoring or destroy accepted measurements on failure', async ({ page }) => {
  const before = await fitExample(page);
  const boundedCsv = csv.trimEnd().split('\n').map((row, i) => row + (i === 0 ? ',count_status' : i === 3 ? ',at-most' : ',exact')).join('\n');
  const upload = page.getByLabel('Load plate CSV/TSV for review (up to 1 MB)', { exact: true });
  await upload.setInputFiles({ name: 'bounded.csv', mimeType: 'text/csv', buffer: Buffer.from(boundedCsv) });
  await expect(page.getByRole('alert')).toContainText('Expected');
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', before!);
  await page.getByLabel('Plate CSV format', { exact: true }).selectOption('2');
  await upload.setInputFiles({ name: 'bounded.csv', mimeType: 'text/csv', buffer: Buffer.from(boundedCsv) });
  await expect(page.getByLabel('Raw plate CSV', { exact: true })).toHaveValue(boundedCsv);
  await expect(page.getByTestId('plaque-growth-result')).toHaveAttribute('data-result-id', before!);
  await page.getByLabel('Plate source and assay context', { exact: true }).fill('Synthetic bound-import test, not empirical observations.');
  await page.getByLabel('Plate data provenance', { exact: true }).selectOption('synthetic');
  await page.getByLabel('I confirm extracellular free-phage counts and any explicitly recorded inclusive bounds.', { exact: true }).check();
  await page.getByRole('button', { name: 'Fit raw plaque counts', exact: true }).click();
  await expect(page.getByTestId('plaque-growth-status')).toContainText('Fresh fit accepted');
  await expect(page.getByTestId('plaque-count-coverage')).toContainText('upper-bound plates: 1');
});
