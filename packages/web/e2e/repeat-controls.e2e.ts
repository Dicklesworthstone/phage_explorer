import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';

declare global {
  interface Window {
    repeatControlFixture: {
      pending: boolean;
      released: boolean;
      holdRead: () => void;
      releaseRead: () => void;
      workerCounts: () => { created: number; terminated: number };
      cancelActive: () => Promise<{ errorName: string; total: number; busy: number; queued: number }>;
    };
  }
}

test('repeat controls preserve submitted provenance and cancel real worker/read operations', async ({ page }, info) => {
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/repeat-controls-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load browser fixture configuration');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'repeat-controls-fixture',
      resolveId(id) { if (id === '/src/repeat-controls-fixture.tsx') return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect } from 'react';
          import { createRoot } from 'react-dom/client';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { RepeatsOverlay } from './components/overlays/RepeatsOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import { getOrchestrator } from './workers/ComputeOrchestrator';
          import './styles/index.css';
          const NativeWorker = window.Worker;
          let created = 0, terminated = 0;
          window.Worker = class extends NativeWorker {
            constructor(url, options) { super(url, options); created++; }
            terminate() { terminated++; super.terminate(); }
          };
          const orchestrator = getOrchestrator({ maxWorkers: 1 });
          const genome = (await importLocalGenomes({ name: 'private.fasta', text: '>private\\n' + 'ACGTTGCACCGATATG'.repeat(20) })).genomes[0];
          const repository = createLocalGenomeRepository(null, [genome]);
          const originalRead = repository.getSequenceWindow.bind(repository);
          let gate = null;
          let release = () => {};
          window.repeatControlFixture = {
            pending: false, released: false,
            holdRead() {
              this.pending = false; this.released = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            releaseRead() { const held = release; gate = null; held(); },
            workerCounts: () => ({ created, terminated }),
            async cancelActive() {
              const controller = new AbortController();
              const task = orchestrator.runAnalysis({ type: 'gc-skew', sequence: 'ACGT'.repeat(1000) }, controller.signal);
              controller.abort();
              let errorName = '';
              try { await task; } catch (error) { errorName = error.name; }
              const { total, busy, queued } = orchestrator.getStats();
              return { errorName, total, busy, queued };
            },
          };
          repository.getSequenceWindow = async (...args) => {
            const held = gate;
            if (held) {
              window.repeatControlFixture.pending = true;
              await held;
              window.repeatControlFixture.released = true;
            }
            return originalRead(...args);
          };
          function Fixture() {
            const { open } = useOverlay();
            useEffect(() => { open('repeats'); }, []);
            return <RepeatsOverlay currentPhage={genome.phage} repository={repository} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/repeat-controls-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/repeat-controls-fixture', '<div id="root"></div><script type="module" src="/src/repeat-controls-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}repeat-controls-fixture`);
    const overlay = page.getByTestId('overlay-repeats');
    const exportButton = overlay.getByRole('button', { name: 'Export repeat experiment', exact: true });
    const exported = async () => {
      await expect(exportButton).toBeVisible();
      const downloading = page.waitForEvent('download');
      await exportButton.click();
      return parseAnalysisRecord(await readFile((await (await downloading).path())!, 'utf8'));
    };
    const initial = await exported();
    expect(initial.parameters).toMatchObject({ minLength: 8, maxGap: 5000 });
    expect(initial.inputs[0].source).toBe('local');

    await overlay.getByLabel('Minimum pair arm length (bp)').fill('0');
    await expect(overlay.getByRole('button', { name: 'Run analysis', exact: true })).toBeDisabled();
    await expect(overlay.getByRole('alert')).toContainText('whole number from 4 to 256');
    await overlay.getByLabel('Minimum pair arm length (bp)').fill('12');
    await overlay.getByLabel('Maximum pair gap (bp)').fill('200');
    // Unsaved edits cannot relabel a completed result or its portable record.
    expect((await exported()).resultId).toBe(initial.resultId);
    await overlay.getByRole('button', { name: 'Run analysis', exact: true }).click();
    await expect(overlay).toContainText('Pairs: 12 bp arms');
    const changed = await exported();
    expect(changed.parameters).toMatchObject({ minLength: 12, maxGap: 200 });
    expect(changed.cacheKey).not.toBe(initial.cacheKey);
    expect(changed.inputs[0].sha256).toBe(initial.inputs[0].sha256);

    const countsBefore = await page.evaluate(() => window.repeatControlFixture.workerCounts());
    expect(await page.evaluate(() => window.repeatControlFixture.cancelActive())).toEqual({ errorName: 'AbortError', total: 0, busy: 0, queued: 0 });
    const countsAfter = await page.evaluate(() => window.repeatControlFixture.workerCounts());
    expect(countsAfter.terminated).toBe(countsBefore.terminated + 1);

    await page.evaluate(() => window.repeatControlFixture.holdRead());
    await overlay.getByRole('button', { name: 'Run analysis', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.repeatControlFixture.pending)).toBe(true);
    await overlay.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
    await expect(overlay).toContainText('Analysis cancelled. Run analysis to try again.');
    await expect(exportButton).toHaveCount(0);
    await page.evaluate(() => window.repeatControlFixture.releaseRead());
    await expect.poll(() => page.evaluate(() => window.repeatControlFixture.released)).toBe(true);
    expect(await page.evaluate(() => window.repeatControlFixture.workerCounts())).toEqual(countsAfter);
    await expect(exportButton).toHaveCount(0);

    await overlay.getByRole('button', { name: 'Run analysis', exact: true }).click();
    expect((await exported()).resultId).toBe(changed.resultId);
    expect(await page.evaluate(() => window.repeatControlFixture.workerCounts().created)).toBe(countsAfter.created + 1);

    const restoreInput = overlay.getByLabel('Restore repeat experiment (.json)');
    await restoreInput.setInputFiles({ name: 'original.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(initial)) });
    await expect(overlay).toContainText('Replay matched: repeat results, search limits and evidence fields agree.');
    await expect(overlay.getByLabel('Minimum pair arm length (bp)')).toHaveValue('8');
    await expect(overlay.getByLabel('Maximum pair gap (bp)')).toHaveValue('5000');
    expect((await exported()).resultId).toBe(initial.resultId);

    // A valid checksum proves content identity, not that the saved outputs are
    // correct. The UI must recompute and diagnose a disagreement.
    const divergent = structuredClone(initial);
    divergent.fields.repeats.value = [];
    const rehashed = await createAnalysisRecord(divergent);
    await restoreInput.setInputFiles({ name: 'divergent.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(rehashed)) });
    await expect(overlay).toContainText('Replay differs: repeat results, search limits or evidence fields.');
    expect((await exported()).resultId).toBe(initial.resultId);

    const wrongInput = structuredClone(initial);
    wrongInput.inputs[0].data = String(wrongInput.inputs[0].data) + 'A';
    const wrongRecord = await createAnalysisRecord(wrongInput);
    const beforeMismatch = await page.evaluate(() => window.repeatControlFixture.workerCounts());
    await restoreInput.setInputFiles({ name: 'other-genome.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(wrongRecord)) });
    await expect(overlay).toContainText('Saved experiment sequence does not match the selected genome.');
    await expect(exportButton).toHaveCount(0);
    expect(await page.evaluate(() => window.repeatControlFixture.workerCounts())).toEqual(beforeMismatch);

    await restoreInput.setInputFiles({ name: 'original.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(initial)) });
    await expect(overlay).toContainText('Replay matched:');
    const tampered = structuredClone(initial);
    tampered.inputs[0].data = 'ACGT';
    await restoreInput.setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) });
    await expect(overlay).toContainText('Could not restore repeat experiment: Analysis input checksum mismatch');
    expect((await exported()).resultId).toBe(initial.resultId);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
});
