import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

declare global {
  interface Window {
    syntenyIdentityFixture: {
      select: (name: string) => void;
      reopen: () => void;
      holdRead: (name: string) => void;
      releaseRead: () => void;
      readPending: boolean;
      readReleased: boolean;
      holdReply: boolean;
      replyPending: boolean;
      releaseReply: () => void;
      failNextWorker: boolean;
      failList: boolean;
      absentReferenceReads: number;
      terminatedWorkers: number;
    };
  }
}

async function result(overlay: Locator, score: string, genes: number) {
  await expect(overlay.getByText('Global Score', { exact: true }).locator('..')).toContainText(score + '%');
  await expect(overlay.getByText(`Gene Similarity Matrix (${genes} × ${genes})`, { exact: true })).toBeVisible();
}

const fixtureSource = String.raw`
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { importLocalGenomes } from '@phage-explorer/core';
  import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
  import { SyntenyOverlay } from './components/overlays/SyntenyOverlay';
  import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
  import { ToastProvider } from './components/ui/Toast';
  import { ScrollProvider } from './providers';
  import './styles/index.css';

  let select = () => {}, reopen = () => {}, heldName = null, gate = null, release = () => {};
  const fixture = window.syntenyIdentityFixture = {
    select: name => select(name), reopen: () => reopen(), readPending: false, readReleased: false,
    holdReply: false, replyPending: false, releaseReply: () => {}, failNextWorker: false, terminatedWorkers: 0,
    failList: false, absentReferenceReads: 0,
    holdRead(name) {
      heldName = name; this.readPending = false; this.readReleased = false;
      gate = new Promise(resolve => { release = resolve; });
    },
    releaseRead() { heldName = null; release(); },
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      if (fixture.failNextWorker && String(url).includes('synteny-worker')) {
        fixture.failNextWorker = false; throw new Error('synteny worker unavailable');
      }
      super(url, options);
      this.addEventListener('message', event => {
        if (!fixture.holdReply || event.data?.ok !== true || !event.data.heatmap) return;
        fixture.holdReply = false; event.stopImmediatePropagation();
        fixture.replyPending = true;
        // Deliver a real computed message after cancellation to exercise queued replies.
        fixture.releaseReply = () => this.dispatchEvent(new MessageEvent('message', { data: event.data }));
      });
    }
    terminate() { fixture.terminatedWorkers++; super.terminate(); }
  };
  const genes = names => names.map((name, index) => ({ id: index + 1, name, locusTag: null, product: null,
    startPos: index * 20, endPos: index * 20 + 10, strand: '+', type: 'CDS' }));
  async function entry(name, query, reference) {
    const imported = await importLocalGenomes({ name: name + '.fasta',
      text: '>Query\n' + 'ACGT'.repeat(25) + '\n>Reference\n' + 'ACGT'.repeat(25) });
    const genomes = imported.genomes.map((genome, index) => ({ ...genome, phage: { ...genome.phage,
      id: -1 - index, name: index === 0 ? 'Query' : 'Reference', accession: index === 0 ? 'same-query' : 'same-reference',
      genes: genes(index === 0 ? query : reference) } }));
    const repository = createLocalGenomeRepository(null, genomes);
    const list = repository.listPhages.bind(repository);
    repository.listPhages = async () => {
      if (name === 'listFailure' && fixture.failList) throw new Error('catalog listing failed');
      const phages = await list();
      return name === 'noReference' ? phages.filter(phage => phage.id !== -2) : phages;
    };
    const read = repository.getPhageById.bind(repository);
    repository.getPhageById = async id => {
      if (name === 'noReference' && id === -2) fixture.absentReferenceReads++;
      if (name === heldName && id === -2) {
        const pending = gate; fixture.readPending = true; await pending; fixture.readReleased = true;
      }
      return read(id);
    };
    return { repository, query: genomes[0].phage };
  }
  const same = ['alpha', 'beta', 'gamma'];
  const entries = {
    a: await entry('a', same, same),
    b: await entry('b', ['delta', 'epsilon', 'zeta'], same),
    c: await entry('c', [...same, 'theta'], [...same, 'theta']),
    missing: await entry('missing', same, []),
    noReference: await entry('noReference', same, same),
    listFailure: await entry('listFailure', same, same),
  };
  function Fixture() {
    const [name, setName] = useState('a');
    const { open } = useOverlay();
    useEffect(() => {
      select = next => flushSync(() => setName(next));
      reopen = () => flushSync(() => open('synteny'));
      open('synteny');
    }, []);
    // Reuse the exact query prop as well as every numeric ID/name/accession/length.
    // Only repository-owned metadata can distinguish the current annotations.
    return React.createElement(SyntenyOverlay, { repository: name === 'none' ? null : entries[name].repository,
      currentPhage: entries.a.query });
  }
  createRoot(document.getElementById('root')).render(
    React.createElement(ScrollProvider, null, React.createElement(ToastProvider, null,
      React.createElement(OverlayProvider, null, React.createElement(Fixture))))
  );
`;

for (const scenario of ['source-and-reads', 'cancel-and-recover'] as const) test(
  'synteny owns its ' + scenario, async ({ page }, info) => {
    test.setTimeout(180000);
    const root = process.cwd(), fixtureId = resolve(root, 'src/synteny-identity-fixture.tsx');
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load the synteny fixture configuration.');
    const server = await createServer(mergeConfig(loaded.config, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'),
      server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{
        name: 'synteny-identity-fixture',
        resolveId(source) { if (source === '/src/synteny-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
        load(source) { if (source === fixtureId) return fixtureSource; },
        configureServer(vite) {
          vite.middlewares.use('/synteny-identity-fixture', (_request, response, next) => {
            void vite.transformIndexHtml('/synteny-identity-fixture', '<div id="root"></div><script type="module" src="/src/synteny-identity-fixture.tsx"></script>')
              .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
          });
        },
      }],
    } satisfies InlineConfig));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await server.listen();
      await page.goto(server.resolvedUrls!.local[0] + 'synteny-identity-fixture');
      const overlay = page.getByTestId('overlay-synteny');
      const reference = overlay.getByRole('combobox', { name: 'Reference Phage:', exact: true });
      await expect(reference.getByRole('option', { name: 'Reference', exact: true })).toHaveCount(1);
      await reference.selectOption('-2');
      await result(overlay, '100.0', 3);
      if (scenario === 'source-and-reads') {
        const track = overlay.getByRole('img', { name: 'Query genome synteny blocks', exact: true });
        await track.click({ position: { x: 120, y: 20 } });
        await expect(overlay.getByText('Synteny Block Details', { exact: true })).toBeVisible();
        await page.evaluate(() => {
          window.syntenyIdentityFixture.holdRead('b');
          window.syntenyIdentityFixture.select('b');
        });
        await expect.poll(() => page.evaluate(() => window.syntenyIdentityFixture.readPending)).toBe(true);
        await expect(overlay.getByText('Global Score', { exact: true })).toHaveCount(0);
        await expect(overlay.getByText('Synteny Block Details', { exact: true })).toHaveCount(0);
        await page.evaluate(() => window.syntenyIdentityFixture.select('c'));
        await result(overlay, '100.0', 4);
        await page.evaluate(() => window.syntenyIdentityFixture.releaseRead());
        await expect.poll(() => page.evaluate(() => window.syntenyIdentityFixture.readReleased)).toBe(true);
        await result(overlay, '100.0', 4);
        await page.evaluate(() => window.syntenyIdentityFixture.select('b'));
        await result(overlay, '0.0', 3);
        await expect(overlay.getByText('Synteny Blocks', { exact: true }).locator('..')).toContainText('0');
      } else {
        await page.evaluate(() => {
          window.syntenyIdentityFixture.holdReply = true;
          window.syntenyIdentityFixture.select('b');
        });
        await expect.poll(() => page.evaluate(() => window.syntenyIdentityFixture.replyPending)).toBe(true);
        const terminated = await page.evaluate(() => window.syntenyIdentityFixture.terminatedWorkers);
        await reference.selectOption('');
        await expect(overlay.getByText('Select a reference phage to compare', { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.syntenyIdentityFixture.terminatedWorkers)).toBeGreaterThan(terminated);
        await page.evaluate(() => window.syntenyIdentityFixture.releaseReply());
        await expect(overlay.getByText('Global Score', { exact: true })).toHaveCount(0);
        await reference.selectOption('-2');
        await result(overlay, '0.0', 3);

        await page.evaluate(() => {
          window.syntenyIdentityFixture.replyPending = false;
          window.syntenyIdentityFixture.holdReply = true;
          window.syntenyIdentityFixture.select('c');
        });
        await expect.poll(() => page.evaluate(() => window.syntenyIdentityFixture.replyPending)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(overlay).toHaveCount(0);
        await page.evaluate(() => window.syntenyIdentityFixture.releaseReply());
        await page.evaluate(() => window.syntenyIdentityFixture.reopen());
        await result(overlay, '100.0', 4);

        await page.evaluate(() => window.syntenyIdentityFixture.select('missing'));
        await expect(overlay.getByText('Both phages need gene annotations for synteny analysis', { exact: true })).toBeVisible();
        await expect(overlay.getByText('Global Score', { exact: true })).toHaveCount(0);
        await page.evaluate(() => {
          window.syntenyIdentityFixture.failNextWorker = true;
          window.syntenyIdentityFixture.select('b');
        });
        await expect(overlay.getByText('synteny worker unavailable', { exact: true })).toBeVisible();
        await overlay.getByRole('button', { name: 'Retry synteny analysis', exact: true }).click();
        await result(overlay, '0.0', 3);
        await page.evaluate(() => {
          window.syntenyIdentityFixture.failList = true;
          window.syntenyIdentityFixture.select('listFailure');
        });
        await expect(overlay.getByText('catalog listing failed', { exact: true })).toBeVisible();
        await expect(overlay.getByText('Global Score', { exact: true })).toHaveCount(0);
        await page.evaluate(() => { window.syntenyIdentityFixture.failList = false; });
        await overlay.getByRole('button', { name: 'Retry synteny analysis', exact: true }).click();
        await result(overlay, '100.0', 3);
        await page.evaluate(() => window.syntenyIdentityFixture.select('noReference'));
        await expect(reference).toHaveValue('');
        await expect(overlay.getByText('Select a reference phage to compare', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.syntenyIdentityFixture.absentReferenceReads)).toBe(0);
        await page.evaluate(() => window.syntenyIdentityFixture.select('none'));
        await expect(overlay.getByText('Database is still loading.', { exact: true })).toBeVisible();
        await expect(overlay.getByText('Global Score', { exact: true })).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); await server.close(); }
  }
);
