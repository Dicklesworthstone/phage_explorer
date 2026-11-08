import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

type ReadStage = 'queryLength' | 'querySequence' | 'referenceLength' | 'referenceSequence';
declare global {
  interface Window {
    mosaicIdentityFixture: {
      select: (name: string) => void;
      reads: Record<string, Record<ReadStage, number>>;
      hold: (name: string, stage: ReadStage) => void;
      release: () => void;
      pending: boolean;
      released: boolean;
    };
  }
}

async function ready(overlay: Locator, name: 'a' | 'b'): Promise<void> {
  await expect(overlay.getByRole('img', { name: 'Mosaic reference similarity track', exact: true })).toBeVisible();
  await expect(overlay.getByText(`${name} matching donor #-2`, { exact: true }).first()).toBeVisible();
  const references = name === 'a' ? 1 : 2;
  await expect(overlay.getByText(`${references} of ${references} selected references contain valid k-mers. Panel: at most 30 other genomes by catalogue ID, first 150,000 bp each.`, { exact: true })).toBeVisible();
  await expect(overlay.getByText('100.0% of display partition', { exact: true })).toBeVisible();
  await expect(overlay.getByText('J=1.00', { exact: true })).toBeVisible();
}

test('mosaic references, query reads and segment details belong to the current repository and parameters', async ({ page }, info) => {
  const root = process.cwd(), fixtureId = resolve(root, 'src/mosaic-identity-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load the Mosaic Radar fixture configuration.');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'mosaic-identity-fixture',
      resolveId(source) { if (source === '/src/mosaic-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) {
        if (source !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { MosaicRadarOverlay } from './components/overlays/MosaicRadarOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {}, heldName = null, heldStage = null, gate = null, release = () => {};
          const fixture = window.mosaicIdentityFixture = {
            select: name => select(name), reads: {}, pending: false, released: false,
            hold(name, stage) {
              heldName = name; heldStage = stage; this.pending = false; this.released = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            release() { heldName = null; heldStage = null; release(); },
          };
          async function pause(name, stage) {
            if (name === heldName && stage === heldStage) {
              const current = gate;
              fixture.pending = true;
              await current;
              fixture.released = true;
            }
          }
          async function entry(name, sequence, extraDonor = false) {
            const data = await importLocalGenomes({ name: name + '.fasta', text: '>query\\n' + sequence +
              '\\n>' + name + ' matching donor\\n' + sequence +
              (extraDonor ? '\\n>' + name + ' unrelated donor\\n' + 'T'.repeat(6500) : '') });
            const genomes = data.genomes.map((genome, index) => ({ ...genome, phage: { ...genome.phage,
              id: -1 - index, name: index === 0 ? 'Same-ID query' : name + (index === 1 ? ' matching donor' : ' unrelated donor') } }));
            const repository = createLocalGenomeRepository(null, genomes);
            const length = repository.getFullGenomeLength.bind(repository), read = repository.getSequenceWindow.bind(repository);
            fixture.reads[name] = { queryLength: 0, querySequence: 0, referenceLength: 0, referenceSequence: 0 };
            repository.getFullGenomeLength = async id => {
              const stage = id === -1 ? 'queryLength' : 'referenceLength';
              fixture.reads[name][stage]++;
              const value = await length(id);
              await pause(name, stage);
              return value;
            };
            repository.getSequenceWindow = async (...args) => {
              const stage = args[0] === -1 ? 'querySequence' : 'referenceSequence';
              fixture.reads[name][stage]++;
              const value = await read(...args);
              await pause(name, stage);
              return value;
            };
            return { repository, phage: genomes[0].phage };
          }
          const entries = {
            a: await entry('a', 'A'.repeat(6000)),
            b: await entry('b', 'C'.repeat(8000), true),
            missing: await entry('missing', 'N'.repeat(6000)),
            tied: await entry('tied', 'A'.repeat(6000), true),
            queryLength: await entry('queryLength', 'G'.repeat(7000)),
            querySequence: await entry('querySequence', 'G'.repeat(7200)),
            referenceLength: await entry('referenceLength', 'G'.repeat(7400), true),
            referenceSequence: await entry('referenceSequence', 'G'.repeat(7600), true),
          };
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => { select = next => flushSync(() => setName(next)); open('mosaicRadar'); }, []);
            return <MosaicRadarOverlay repository={entries[name].repository} currentPhage={entries[name].phage} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/mosaic-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/mosaic-identity-fixture', '<div id="root"></div><script type="module" src="/src/mosaic-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}mosaic-identity-fixture`);
    const overlay = page.getByTestId('overlay-mosaicRadar');
    await ready(overlay, 'a');
    await page.keyboard.press(']'); await page.keyboard.press('='); await page.keyboard.press('Shift+M');
    await expect(overlay.getByText('k=6', { exact: true })).toBeVisible();
    await expect(overlay.getByText('window=2500bp', { exact: true })).toBeVisible();
    await expect(overlay.getByText('minSim=0.07', { exact: true })).toBeVisible();
    const track = overlay.getByRole('img', { name: 'Mosaic reference similarity track', exact: true });
    await track.hover({ position: { x: 120, y: 20 } }); await track.click({ position: { x: 120, y: 20 } });
    await expect(overlay.getByText('Mean window Jaccard: 1.000', { exact: true })).toBeVisible();

    // Repositories deliberately reuse query ID -1 and reference IDs -2/-3.
    // Their exact sequences, donor labels and reference panel sizes differ.
    await page.evaluate(() => window.mosaicIdentityFixture.select('b'));
    await expect.poll(() => page.evaluate(() => window.mosaicIdentityFixture.reads.b.querySequence)).toBeGreaterThan(0);
    await ready(overlay, 'b');
    await expect.poll(() => page.evaluate(() => window.mosaicIdentityFixture.reads.b.referenceSequence)).toBe(2);
    await expect(overlay.getByText('a matching donor #-2', { exact: true })).toHaveCount(0);
    await expect(overlay.getByText('Mean window Jaccard: 1.000', { exact: true })).toHaveCount(0);
    await track.hover({ position: { x: 120, y: 20 } }); await track.click({ position: { x: 120, y: 20 } });
    await expect(overlay.getByText('Mean window Jaccard: 1.000', { exact: true })).toBeVisible();
    await page.keyboard.press(']');
    await expect(overlay.getByText('k=7', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Mean window Jaccard: 1.000', { exact: true })).toHaveCount(0);
    await page.keyboard.press('[');

    for (const stage of ['queryLength', 'referenceLength', 'querySequence', 'referenceSequence'] as const) {
      await page.evaluate(stage => { window.mosaicIdentityFixture.hold(stage, stage); window.mosaicIdentityFixture.select(stage); }, stage);
      await expect.poll(() => page.evaluate(() => window.mosaicIdentityFixture.pending)).toBe(true);
      await expect(overlay.getByRole('img', { name: 'Mosaic reference similarity track', exact: true })).toHaveCount(0);
      await expect(overlay.getByText('b matching donor #-2', { exact: true })).toHaveCount(0);
      await page.evaluate(() => window.mosaicIdentityFixture.select('b'));
      await ready(overlay, 'b');
      await page.evaluate(() => window.mosaicIdentityFixture.release());
      await expect.poll(() => page.evaluate(() => window.mosaicIdentityFixture.released)).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (stage === 'queryLength') expect(await page.evaluate(() => window.mosaicIdentityFixture.reads.queryLength.querySequence)).toBe(0);
      if (stage === 'referenceLength') expect(await page.evaluate(() => window.mosaicIdentityFixture.reads.referenceLength.referenceSequence)).toBe(0);
      await ready(overlay, 'b');
      await expect(overlay.getByText(`${stage} matching donor #-2`, { exact: true })).toHaveCount(0);
      await expect(overlay.getByText('k=6', { exact: true })).toBeVisible();
      await expect(overlay.getByText('window=2500bp', { exact: true })).toBeVisible();
      await expect(overlay.getByText('minSim=0.07', { exact: true })).toBeVisible();
    }

    // Real imported N-only sequences supply no k-mers, including against each
    // other. They must clear the previous result rather than become a match.
    await page.evaluate(() => window.mosaicIdentityFixture.select('missing'));
    await expect(track).toBeVisible();
    await expect(overlay.getByText('No unique reference assignments at the current similarity threshold.', { exact: true })).toBeVisible();
    await expect(overlay.getByText('b matching donor #-2', { exact: true })).toHaveCount(0);
    await expect(overlay.getByText('J=1.00', { exact: true })).toHaveCount(0);
    await expect(overlay.getByText('0 of 1 selected references contain valid k-mers. Panel: at most 30 other genomes by catalogue ID, first 150,000 bp each.', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Unresolved display spans: 0 bp tied, 0 bp below threshold, 6,000 bp without comparable k-mers.', { exact: true })).toBeVisible();
    await track.click({ position: { x: 120, y: 20 } });
    await expect(overlay.getByText('No comparable k-mers', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Mean window Jaccard: 0.000', { exact: true })).toBeVisible();

    // The A and T reference strings are reverse complements. Canonical k-mers
    // therefore tie exactly, regardless of their label or catalogue order.
    await page.evaluate(() => window.mosaicIdentityFixture.select('tied'));
    await expect(track).toBeVisible();
    await expect(overlay.getByText('No unique reference assignments at the current similarity threshold.', { exact: true })).toBeVisible();
    await expect(overlay.getByText('2 of 2 selected references contain valid k-mers. Panel: at most 30 other genomes by catalogue ID, first 150,000 bp each.', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Unresolved display spans: 6,000 bp tied, 0 bp below threshold, 0 bp without comparable k-mers.', { exact: true })).toBeVisible();
    await expect(overlay.getByText('100.0% of display partition', { exact: true })).toHaveCount(0);
    await expect(overlay.getByRole('img', { name: 'Reference switch ranges', exact: true })).toHaveCount(0);
    await track.click({ position: { x: 120, y: 20 } });
    await expect(overlay.getByText('Tied references: tied matching donor #-2, tied unrelated donor #-3', { exact: true })).toBeVisible();
    await expect(overlay.getByText('Mean window Jaccard: 1.000', { exact: true })).toBeVisible();
    await page.evaluate(() => window.mosaicIdentityFixture.select('b'));
    await ready(overlay, 'b');
    await expect(overlay.getByText('Tied references: tied matching donor #-2, tied unrelated donor #-3', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
});
