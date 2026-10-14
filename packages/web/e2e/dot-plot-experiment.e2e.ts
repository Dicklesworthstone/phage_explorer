import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { createDotPlotExperiment } from '../../core/src/analysis/dot-plot';

const sequenceA = 'ANCGTACGTN'.repeat(16);
const sequenceB = 'CCCCN'.repeat(32);
interface FixtureWindow extends Window {
  selectDotInput(name: 'a' | 'b'): void;
  holdDotReply: boolean;
  dotReplyHeld: boolean;
  releaseDotReply(): void;
  holdDotRead: boolean;
  dotReadPending: boolean;
  dotReadReleased: boolean;
  releaseDotRead(): void;
  experimentJobs: number;
}
let fixtureConfig: UserConfig | undefined;

// Real React, local repository, overlay and browser worker. The fixture only
// controls selection and delivery timing; no numerical response is fabricated.
const test = base.extend<{ dotFixture: void }>({
  dotFixture: [async ({ page }, use, info) => {
    const root = process.cwd();
    const fixtureId = resolve(root, 'src/dot-plot-experiment-fixture.tsx');
    if (!fixtureConfig) {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
      if (!loaded) throw new Error('Could not load the real web configuration');
      fixtureConfig = loaded.config;
    }
    const server = await createServer(mergeConfig(fixtureConfig, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'),
      server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{
        name: 'dot-plot-experiment-fixture',
        resolveId(id) { if (id === '/src/dot-plot-experiment-fixture.tsx') return fixtureId; },
        load(id) {
          if (id !== fixtureId) return;
          return `
            import React, { useEffect, useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { importLocalGenomes } from '@phage-explorer/core';
            import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
            import { DotPlotOverlay } from './components/overlays/DotPlotOverlay';
            import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
            import { ToastProvider } from './components/ui/Toast';
            import { ScrollProvider } from './providers';
            import './styles/index.css';
            async function entry(sequence) {
              const genome = (await importLocalGenomes({ name: 'private.fasta', text: '>dot-local\\n' + sequence })).genomes[0];
              genome.phage = { ...genome.phage, id: 1 };
              return { phage: genome.phage, repository: createLocalGenomeRepository(null, [genome]) };
            }
            const a = await entry(${JSON.stringify(sequenceA)});
            const b = await entry(${JSON.stringify(sequenceB)});
            window.experimentJobs = 0;
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                super(url, options);
                this.addEventListener('message', event => {
                  if (!window.holdDotReply || !event.data.evidenceRecord) return;
                  window.holdDotReply = false;
                  window.dotReplyHeld = true;
                  const data = event.data;
                  event.stopImmediatePropagation();
                  window.releaseDotReply = () => this.dispatchEvent(new MessageEvent('message', { data }));
                });
              }
              postMessage(data, ...args) {
                if (data.experiment) window.experimentJobs++;
                return super.postMessage(data, ...args);
              }
            };
            const read = File.prototype.text;
            File.prototype.text = async function() {
              if (window.holdDotRead) {
                window.holdDotRead = false;
                window.dotReadPending = true;
                await new Promise(resolve => { window.releaseDotRead = resolve; });
                const value = await read.call(this);
                window.dotReadReleased = true;
                return value;
              }
              return read.call(this);
            };
            function Fixture() {
              const [selected, select] = useState(a);
              const { open } = useOverlay();
              useEffect(() => {
                open('dotPlot');
                window.selectDotInput = name => select({ a, b }[name]);
              }, []);
              return <DotPlotOverlay currentPhage={selected.phage} repository={selected.repository} />;
            }
            createRoot(document.getElementById('root')).render(
              <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
            );
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/dot-plot-experiment-fixture', (_request, response, next) => {
            void vite.transformIndexHtml('/dot-plot-experiment-fixture', '<div id="root"></div><script type="module" src="/src/dot-plot-experiment-fixture.tsx"></script>')
              .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
          });
        },
      }],
    } satisfies InlineConfig));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await server.listen();
      await page.goto(`${server.resolvedUrls!.local[0]}dot-plot-experiment-fixture`);
      await expect(page.getByTestId('overlay-dotPlot')).toContainText('Analysis complete.');
      await use();
      expect(errors).toEqual([]);
    } finally {
      await server.close();
    }
  }, { auto: true }],
});

const panel = (page: Page) => page.getByTestId('overlay-dotPlot');
const windowControl = (overlay: Locator) => overlay.getByRole('spinbutton', { name: 'Window size (bp; 0 = automatic)' });
async function prepare(page: Page): Promise<string> {
  const overlay = panel(page);
  await overlay.getByLabel('Resolution:').selectOption('40');
  await windowControl(overlay).fill('4');
  await overlay.getByRole('button', { name: 'Run analysis', exact: true }).click();
  await expect(overlay).toContainText('40x40, window: 4 bp');
  await overlay.getByRole('button', { name: 'Prepare dot plot experiment', exact: true }).click();
  await expect(overlay).toContainText('Experiment prepared:');
  return download(page, 'JSON');
}
async function download(page: Page, kind: 'JSON' | 'TSV'): Promise<string> {
  const downloading = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: kind === 'JSON'
    ? 'Download dot plot experiment (JSON)' : 'Download dot plot matrix (TSV)', exact: true }).click();
  const path = await (await downloading).path();
  if (!path) throw new Error('Expected a real browser download');
  return readFile(path, 'utf8');
}
async function restore(page: Page, content: string): Promise<void> {
  await panel(page).getByLabel('Restore dot plot experiment (.json)').setInputFiles({
    name: 'experiment.json', mimeType: 'application/json', buffer: Buffer.from(content),
  });
}
function assertIndependentMatrix(record: AnalysisRecord, sequence: string): void {
  const bins = Number(record.parameters.bins), window = Number(record.parameters.window);
  const starts = Array.from({ length: bins }, (_, i) => bins === 1 ? 0 : Math.floor(i * (sequence.length - window) / (bins - 1)));
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  const direct: number[] = [], inverted: number[] = [];
  for (const startA of starts) for (const startB of starts) {
    let forward = 0, reverse = 0;
    for (let i = 0; i < window; i++) {
      const a = sequence[startA + i], b = sequence[startB + i];
      if (complement[a] && a === b) forward++;
      if (complement[sequence[startA + window - 1 - i]] === b) reverse++;
    }
    direct.push(Math.fround(forward / window));
    inverted.push(Math.fround(reverse / window));
  }
  expect(record.inputs[0].data).toBe(sequence);
  expect(record.fields.direct.value).toEqual(direct);
  expect(record.fields.inverted.value).toEqual(inverted);
  expect(record.fields.windows.value).toEqual(starts.map(start => ({ start, end: start + window })));
}

test('dot plot experiment downloads, fresh-page replay and rehashed-tamper refusal preserve actual values', async ({ page }) => {
  const json = await prepare(page), saved = await parseAnalysisRecord(json);
  assertIndependentMatrix(saved, sequenceA);
  const tsv = await download(page, 'TSV');
  expect(tsv).not.toContain(sequenceA);
  expect(tsv.trim().split('\n')).toHaveLength(40 * 40 + 4);
  expect(tsv).toContain(saved.resultId);
  await expect(panel(page)).toContainText('JSON includes the complete selected genome');
  await page.reload();
  await expect(panel(page)).toContainText('Analysis complete.');
  await restore(page, json);
  await expect(panel(page)).toContainText('Replay matched:');
  await expect(panel(page).getByLabel('Resolution:')).toHaveValue('40');
  await expect(windowControl(panel(page))).toHaveValue('4');
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(saved.resultId);
  expect(await download(page, 'TSV')).toBe(tsv);

  const directField = saved.fields.direct;
  if (directField.kind !== 'sequence-score' || !Array.isArray(directField.value)) throw new Error('Expected direct scores');
  const values = [...directField.value as number[]];
  values[1] = values[1] === 0 ? 1 : 0;
  const tampered = await createAnalysisRecord({
    method: saved.method, parameters: saved.parameters, seed: saved.seed, references: saved.references,
    inputs: saved.inputs.map(({ sha256: _sha, ...input }) => input),
    fields: { ...saved.fields, direct: { ...directField, value: values } },
  });
  await restore(page, serializeAnalysisRecord(tampered));
  await expect(panel(page).getByRole('alert')).toContainText('Recomputed dot plot');
  await expect(windowControl(panel(page))).toHaveValue('4');
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(saved.resultId);
});

test('cancelled and late experiment replies cannot replace accepted settings or another repository', async ({ page }) => {
  const saved = await parseAnalysisRecord(await prepare(page));
  const alternative = serializeAnalysisRecord((await createDotPlotExperiment({ sequence: sequenceA, accession: 'dot-local', source: 'local' }, { bins: 10, window: 7 })).record);
  await page.evaluate(() => { (window as FixtureWindow).holdDotReply = true; });
  await restore(page, alternative);
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).dotReplyHeld)).toBe(true);
  await panel(page).getByRole('button', { name: 'Cancel experiment operation' }).click();
  await page.evaluate(() => (window as FixtureWindow).releaseDotReply());
  await expect(windowControl(panel(page))).toHaveValue('4');
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(saved.resultId);

  await page.evaluate(() => { const fixture = window as FixtureWindow; fixture.dotReplyHeld = false; fixture.holdDotReply = true; });
  await restore(page, alternative);
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).dotReplyHeld)).toBe(true);
  await page.evaluate(() => (window as FixtureWindow).selectDotInput('b'));
  const replacement = await parseAnalysisRecord(await prepare(page));
  assertIndependentMatrix(replacement, sequenceB);
  expect(replacement.resultId).not.toBe(saved.resultId);
  await page.evaluate(() => (window as FixtureWindow).releaseDotReply());
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(replacement.resultId);
  await expect(windowControl(panel(page))).toHaveValue('4');
  await restore(page, serializeAnalysisRecord(saved));
  await expect(panel(page).getByRole('alert')).toContainText('does not match the selected genome');
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(replacement.resultId);
});

test('a new window edit cancels a pending file read before it can launch or restore an experiment', async ({ page }) => {
  const json = await prepare(page), saved = await parseAnalysisRecord(json);
  const jobs = await page.evaluate(() => { (window as FixtureWindow).holdDotRead = true; return (window as FixtureWindow).experimentJobs; });
  await restore(page, json);
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).dotReadPending)).toBe(true);
  await windowControl(panel(page)).fill('7');
  await expect(panel(page)).toContainText('Experiment operation cancelled.');
  await page.evaluate(() => (window as FixtureWindow).releaseDotRead());
  await expect.poll(() => page.evaluate(() => (window as FixtureWindow).dotReadReleased)).toBe(true);
  await expect(windowControl(panel(page))).toHaveValue('7');
  expect((await parseAnalysisRecord(await download(page, 'JSON'))).resultId).toBe(saved.resultId);
  expect(await page.evaluate(() => (window as FixtureWindow).experimentJobs)).toBe(jobs);
});
