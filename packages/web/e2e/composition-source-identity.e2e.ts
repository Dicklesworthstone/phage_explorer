import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';

declare global {
  interface Window {
    compositionIdentityFixture: {
      select: (name: string) => void;
      reads: Record<string, number>;
      holdRead: (name: string, stage?: 'length' | 'sequence') => void;
      releaseRead: () => void;
      readPending: boolean;
      readReleased: boolean;
      holdReply: boolean;
      replyPending: boolean;
      replyReleased: boolean;
      releaseReply: () => void;
      terminatedWorkers: number;
    };
  }
}

const overlays = ['biasDecomposition', 'kmerAnomaly'] as const;
type CompositionOverlay = typeof overlays[number];
let fixtureConfig: UserConfig | undefined;

function plot(overlay: Locator, id: CompositionOverlay): Locator {
  return overlay.getByRole('img', { name: id === 'biasDecomposition'
    ? 'Dinucleotide bias PCA scatter plot'
    : 'K-mer anomaly graph showing unusual sequence patterns. Click to view details.', exact: true });
}

async function plotPixels(canvas: Locator): Promise<string> {
  return canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 16777619);
    return `${canvas.width}x${canvas.height}:${hash >>> 0}`;
  });
}

async function expectReady(overlay: Locator, id: CompositionOverlay): Promise<void> {
  await expect(plot(overlay, id)).toBeVisible();
  await expect(overlay.getByText('Loading sequence data...', { exact: true })).toHaveCount(0);
  await expect(overlay.getByText('Computing PCA decomposition...', { exact: true })).toHaveCount(0);
  if (id === 'biasDecomposition') await expect(overlay.getByText(/\d+ windows \|/)).toContainText('12 windows');
}

async function expectPending(overlay: Locator, id: CompositionOverlay): Promise<void> {
  await expect(plot(overlay, id)).toHaveCount(0);
  await expect(overlay.getByText(/GC: \d/)).toHaveCount(0);
  await expect(overlay.getByText('Top anomalous k-mers:', { exact: true })).toHaveCount(0);
}

for (const id of overlays) test(`${id} binds cached DNA, pending work and selections to their repository`, async ({ page }, info) => {
  const root = process.cwd(), fixtureId = resolve(root, 'src/composition-identity-fixture.tsx');
  if (!fixtureConfig) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load composition fixture configuration');
    fixtureConfig = loaded.config;
  }
  const server = await createServer(mergeConfig(fixtureConfig, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'composition-identity-fixture',
      resolveId(source) { if (source === '/src/composition-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) {
        if (source !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { BiasDecompositionOverlay } from './components/overlays/BiasDecompositionOverlay';
          import { KmerAnomalyOverlay } from './components/overlays/KmerAnomalyOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {}, heldName = null, heldStage = null, gate = null, release = () => {};
          const fixture = window.compositionIdentityFixture = {
            select: name => select(name), reads: {}, readPending: false, readReleased: false,
            holdReply: false, replyPending: false, replyReleased: false, releaseReply: () => {}, terminatedWorkers: 0,
            holdRead(name, stage = 'sequence') {
              heldName = name; heldStage = stage; this.readPending = false; this.readReleased = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            releaseRead() { heldName = null; release(); },
          };
          // Delay an actual computed Comlink reply, leaving DNA and numerical
          // results untouched. A replaced analysis must cancel this worker.
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(url, options) {
              super(url, options);
              this.addEventListener('message', event => {
                if (!fixture.holdReply || event.data?.type !== 'RAW' || !event.data.value?.decomposition) return;
                fixture.holdReply = false; event.stopImmediatePropagation();
                const data = event.data;
                fixture.replyPending = true;
                fixture.releaseReply = () => {
                  fixture.replyReleased = true;
                  this.dispatchEvent(new MessageEvent('message', { data }));
                };
              });
            }
            terminate() { fixture.terminatedWorkers++; super.terminate(); }
          };
          async function entry(name, sequence) {
            const imported = await importLocalGenomes({ name: name + '.fasta', text: '>input\\n' + sequence });
            const genome = imported.genomes[0];
            genome.phage = { ...genome.phage, id: -1 };
            const repository = createLocalGenomeRepository(null, [genome]);
            const length = repository.getFullGenomeLength.bind(repository), read = repository.getSequenceWindow.bind(repository);
            fixture.reads[name] = 0;
            const wait = async stage => {
              if (heldName === name && heldStage === stage) {
                const pending = gate;
                fixture.readPending = true;
                await pending;
                fixture.readReleased = true;
              }
            };
            repository.getFullGenomeLength = async (...args) => { await wait('length'); return length(...args); };
            repository.getSequenceWindow = async (...args) => {
              fixture.reads[name]++; await wait('sequence'); return read(...args);
            };
            return { repository, phage: genome.phage };
          }
          // Different bytes with the same ID and length exercise both the
          // overlay cache and the real shared sequence pool's source identity.
          const entries = {
            a: await entry('a', 'AT'.repeat(1500) + 'A'.repeat(3000)),
            b: await entry('b', 'GC'.repeat(1000) + 'ACGT'.repeat(500) + 'G'.repeat(2000)),
            c: await entry('c', 'CA'.repeat(1000) + 'GT'.repeat(1000) + 'TC'.repeat(1000)),
            delayed: await entry('delayed', 'AGTC'.repeat(1000) + 'C'.repeat(2000)),
            delayedLength: await entry('delayedLength', 'TGCA'.repeat(1000) + 'T'.repeat(2000)),
          };
          const Component = '${id}' === 'biasDecomposition' ? BiasDecompositionOverlay : KmerAnomalyOverlay;
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => { select = next => flushSync(() => setName(next)); open('${id}'); }, []);
            return <Component repository={entries[name].repository} currentPhage={entries[name].phage} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/composition-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/composition-identity-fixture', '<div id="root"></div><script type="module" src="/src/composition-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}composition-identity-fixture`);
    const overlay = page.getByTestId(`overlay-${id}`), canvas = plot(overlay, id);
    await expect(canvas).toBeVisible();
    const parameter = id === 'biasDecomposition'
      ? overlay.getByRole('combobox', { name: 'Window:', exact: true }) : overlay.getByRole('combobox');
    await parameter.selectOption(id === 'biasDecomposition' ? '500' : '6');
    await expectReady(overlay, id);
    const originalPixels = await plotPixels(canvas);
    if (id === 'biasDecomposition') {
      // ScatterCanvas selects the nearest point inside the axes. The center
      // avoids rounding on the plot boundary, including scaled viewports.
      await canvas.hover({ position: { x: 250, y: 175 } });
      await expect(overlay.getByText('GC: 0.0%', { exact: true })).toBeVisible();
    } else {
      await canvas.click({ position: { x: 5, y: 40 } });
      await expect(overlay.locator('tbody tr').first()).toContainText('ATATAT');
    }

    await page.evaluate(() => window.compositionIdentityFixture.select('b'));
    await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.reads.b)).toBeGreaterThan(0);
    await expectReady(overlay, id);
    await expect.poll(() => plotPixels(canvas)).not.toBe(originalPixels);
    await expect(parameter).toHaveValue(id === 'biasDecomposition' ? '500' : '6');
    await expect(overlay.getByText('GC: 0.0%', { exact: true })).toHaveCount(0);
    await expect(overlay.getByText('Top anomalous k-mers:', { exact: true })).toHaveCount(0);
    const replacementPixels = await plotPixels(canvas);
    if (id === 'kmerAnomaly') {
      await canvas.click({ position: { x: 5, y: 40 } });
      await expect(overlay.locator('tbody tr').first()).toContainText('GCGCGC');
      await parameter.selectOption('5');
      await expect(overlay.getByText('Top anomalous k-mers:', { exact: true })).toHaveCount(0);
      await parameter.selectOption('6');
    }

    await page.evaluate(() => { window.compositionIdentityFixture.holdRead('delayed'); window.compositionIdentityFixture.select('delayed'); });
    await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.readPending)).toBe(true);
    await expectPending(overlay, id);
    await page.evaluate(() => window.compositionIdentityFixture.select('a'));
    await expectReady(overlay, id);
    await page.evaluate(() => window.compositionIdentityFixture.releaseRead());
    await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.readReleased)).toBe(true);
    await expect.poll(() => plotPixels(canvas)).toBe(originalPixels);

    // If the obsolete length lookup finishes late, its sequence read should
    // not even start, and it must not replace the currently rendered input.
    await page.evaluate(() => { window.compositionIdentityFixture.holdRead('delayedLength', 'length'); window.compositionIdentityFixture.select('delayedLength'); });
    await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.readPending)).toBe(true);
    await expectPending(overlay, id);
    await page.evaluate(() => { window.compositionIdentityFixture.select('b'); window.compositionIdentityFixture.releaseRead(); });
    await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.readReleased)).toBe(true);
    await expectReady(overlay, id);
    expect(await page.evaluate(() => window.compositionIdentityFixture.reads.delayedLength)).toBe(0);
    await expect.poll(() => plotPixels(canvas)).toBe(replacementPixels);

    if (id === 'biasDecomposition') {
      await page.evaluate(() => { window.compositionIdentityFixture.holdReply = true; window.compositionIdentityFixture.select('c'); });
      await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.replyPending)).toBe(true);
      const terminated = await page.evaluate(() => window.compositionIdentityFixture.terminatedWorkers);
      await page.evaluate(() => { window.compositionIdentityFixture.holdRead('delayed'); window.compositionIdentityFixture.select('delayed'); });
      await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.readPending)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.terminatedWorkers)).toBeGreaterThan(terminated);
      await page.evaluate(() => window.compositionIdentityFixture.releaseReply());
      await expect.poll(() => page.evaluate(() => window.compositionIdentityFixture.replyReleased)).toBe(true);
      await expectPending(overlay, id);
      await page.evaluate(() => { window.compositionIdentityFixture.select('b'); window.compositionIdentityFixture.releaseRead(); });
      await expectReady(overlay, id);
      await expect.poll(() => plotPixels(canvas)).toBe(replacementPixels);
    }
    await expect(parameter).toHaveValue(id === 'biasDecomposition' ? '500' : '6');
    expect(errors).toEqual([]);
  } finally { await page.close(); await server.close(); }
});
