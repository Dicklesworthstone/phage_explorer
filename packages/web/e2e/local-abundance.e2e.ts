import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';

// Positive oracle: log columns for A,B,C are affine functions of log(2), with
// sample-wise CLR trajectories proportional to x,x,-2x. Exactly two of the
// 5! pairings attain |r|=1, hence p=BH-p=2/120=1/60 for every pair.
const csv = 'taxon,S1,S2,S3,S4,S5\nPRIVATE_A,1,2,4,8,16\nPRIVATE_B,1,2,4,8,16\nPRIVATE_C,256,64,16,4,1';
const metadata = 'sampleId\thabitat\thost\nS5\tsoil\t\nS1\twater\t\nS3\tsoil\t';

test('local abundance import, metadata, computation, export and verified replay stay private and cancellable', async ({ page }, info) => {
  test.setTimeout(180000);
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/local-abundance-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load abundance fixture configuration');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'local-abundance-fixture',
      resolveId(id) { if (id === '/src/local-abundance-fixture.tsx') return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { NicheNetworkOverlay } from './components/overlays/NicheNetworkOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          const NativeWorker = window.Worker;
          let created = 0, terminated = 0;
          window.Worker = class extends NativeWorker {
            constructor(url, options) { super(url, options); created++; }
            terminate() { terminated++; super.terminate(); }
          };
          const originalText = File.prototype.text;
          window.abundanceFixture = {
            readPending: false, readReleased: false,
            releaseRead: () => {},
            counts: () => ({ created, terminated }),
          };
          File.prototype.text = async function () {
            if (this.name === 'delayed.csv') {
              window.abundanceFixture.readPending = true;
              await new Promise(resolve => { window.abundanceFixture.releaseRead = resolve; });
              window.abundanceFixture.readReleased = true;
            }
            return originalText.call(this);
          };
          function Fixture() {
            const { open, close } = useOverlay();
            useEffect(() => {
              window.abundanceFixture.close = () => close('nicheNetwork');
              open('nicheNetwork');
            }, []);
            return <NicheNetworkOverlay />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/local-abundance-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/local-abundance-fixture', '<div id="root"></div><script type="module" src="/src/local-abundance-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  const uploads: string[] = [];
  const privateRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) uploads.push(`${request.method()} ${request.url()}`);
    if ((request.url() + (request.postData() ?? '')).includes('PRIVATE_')) privateRequests.push(request.url());
  });
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}local-abundance-fixture`);
    const overlay = page.getByTestId('overlay-nicheNetwork');
    await expect(overlay.getByTestId('abundance-source')).toHaveText('NO DATA LOADED');
    await expect(overlay.getByTestId('abundance-result')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).abundanceFixture.counts().created)).toBe(0);
    const load = (content: string, name = 'counts.csv') => overlay.getByLabel('Import abundance CSV, TSV, dataset JSON or saved analysis', { exact: true })
      .setInputFiles({ name, mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv', buffer: Buffer.from(content) });
    await load(csv);
    await expect(overlay.getByTestId('abundance-dataset-name')).toHaveText('counts.csv');
    await expect(overlay.getByTestId('abundance-result')).toHaveCount(0);
    await expect(overlay.getByTestId('abundance-source')).toContainText('LOCAL DATA');
    await expect(overlay.getByTestId('abundance-header-source')).toHaveText('User-supplied local data');
    await overlay.getByLabel('Attach sample metadata CSV, TSV or JSON', { exact: true })
      .setInputFiles({ name: 'metadata.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from(metadata) });
    await expect(overlay).toContainText('3 sample metadata records.');
    await overlay.getByLabel('Pseudocount (input units)', { exact: true }).fill('0');
    await overlay.getByLabel('NMF factors', { exact: true }).fill('1');
    await overlay.getByLabel('Abundance analysis seed', { exact: true }).fill('0');
    await overlay.getByRole('button', { name: 'Run abundance analysis', exact: true }).click();
    await expect(overlay.getByTestId('abundance-summary')).toContainText('3 tested pairs; 3 retained edges.');
    const rows = overlay.getByTestId('abundance-association');
    await expect(rows).toHaveCount(3);
    const cells = await rows.first().locator('td').allTextContents();
    expect(cells.slice(0, 2)).toEqual(['PRIVATE_A', 'PRIVATE_B']);
    expect(Number(cells[2])).toBeCloseTo(1, 6);
    expect(Number(cells[3])).toBeCloseTo(1 / 60, 6);
    expect(Number(cells[4])).toBeCloseTo(1 / 60, 6);
    await expect(overlay.getByTestId('abundance-profile')).toContainText('32.5758%'); // (4/24+16/33)/2
    const exportFile = async (name: string) => {
      const downloading = page.waitForEvent('download');
      await overlay.getByRole('button', { name, exact: true }).click();
      return readFile((await (await downloading).path())!, 'utf8');
    };
    const savedContent = await exportFile('Export abundance analysis');
    const saved = await parseAnalysisRecord(savedContent);
    expect(saved.inputs[0].source).toBe('local');
    expect(saved.parameters).toMatchObject({ pseudocount: 0, numNiches: 1, seed: 0 });
    expect(saved.fields.associations.kind).toBe('fitted-estimate');
    const dataContent = await exportFile('Export abundance dataset');
    const dataset = JSON.parse(dataContent);
    expect(dataset.table.counts).toEqual([[1, 2, 4, 8, 16], [1, 2, 4, 8, 16], [256, 64, 16, 4, 1]]);
    expect(dataset.metadata.map((row: { sampleId: string }) => row.sampleId)).toEqual(['S5', 'S1', 'S3']);
    // An unsubmitted UI edit must not change the displayed result or its export.
    await overlay.getByLabel('Pseudocount (input units)', { exact: true }).fill('2');
    expect((await parseAnalysisRecord(await exportFile('Export abundance analysis'))).resultId).toBe(saved.resultId);
    await load(savedContent, 'saved.json');
    await expect(overlay).toContainText('Verified replay: recomputed values and complete analysis identity match.');
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    await expect(overlay.getByLabel('Pseudocount (input units)', { exact: true })).toHaveValue('0');

    const forged = await parseAnalysisRecord(savedContent);
    forged.fields.associations.value = [];
    const resigned = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _hash, ...input }) => input) });
    await load(serializeAnalysisRecord(resigned), 'forged.json');
    await expect(overlay.getByRole('alert')).toContainText('Recomputed abundance result differs');
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    await load('taxon,S1,S2,S3\nPRIVATE_BAD,NA,1,2');
    await expect(overlay.getByRole('alert')).toContainText('not a nonnegative number');
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    await expect(overlay.getByTestId('abundance-source')).toContainText('LOCAL DATA');

    const beforeRead = await page.evaluate(() => (window as any).abundanceFixture.counts());
    await load(csv, 'delayed.csv');
    await expect.poll(() => page.evaluate(() => (window as any).abundanceFixture.readPending)).toBe(true);
    await overlay.getByRole('button', { name: 'Cancel abundance work', exact: true }).click();
    await page.evaluate(() => (window as any).abundanceFixture.releaseRead());
    await expect.poll(() => page.evaluate(() => (window as any).abundanceFixture.readReleased)).toBe(true);
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    expect(await page.evaluate(() => (window as any).abundanceFixture.counts())).toEqual(beforeRead);

    const unsafeLabel = '<img src=x onerror=alert(1)>';
    await load(csv.replace('PRIVATE_A', unsafeLabel), 'escaped.csv');
    await expect(overlay.getByTestId('abundance-dataset-name')).toHaveText('escaped.csv');
    await overlay.getByRole('button', { name: 'Run abundance analysis', exact: true }).click();
    await expect(overlay.getByLabel('Inspect taxon', { exact: true })).toHaveValue(unsafeLabel);
    await expect(overlay.locator('img')).toHaveCount(0);
    await overlay.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
    await expect(overlay.getByTestId('abundance-source')).toContainText('SYNTHETIC EXAMPLE');
    await expect(overlay.getByTestId('abundance-header-source')).toHaveText('Synthetic example');
    await expect(overlay.getByTestId('abundance-result')).toHaveCount(0);
    await load(savedContent, 'saved.json');
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    // Fresh document and worker: result is restored from the file, not session memory.
    await page.reload();
    await expect(overlay.getByTestId('abundance-source')).toHaveText('NO DATA LOADED');
    await load(savedContent, 'saved.json');
    await expect(overlay.getByTestId('abundance-result')).toHaveAttribute('data-result-id', saved.resultId);
    await expect(overlay).toContainText('Verified replay');
    expect((await parseAnalysisRecord(await exportFile('Export abundance analysis'))).resultId).toBe(saved.resultId);
    await page.evaluate(() => (window as any).abundanceFixture.close());
    await expect(overlay).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(uploads).toEqual([]);
    expect(privateRequests).toEqual([]);
  } finally { await server.close(); }
});
