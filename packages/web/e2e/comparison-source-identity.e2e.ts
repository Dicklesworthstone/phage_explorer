import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';

declare global {
  interface Window {
    comparisonIdentityFixture: {
      select: (name: string) => void;
      reopen: () => void;
      replaceSummaries: () => void;
      snapshot: () => { loading: boolean; hasResult: boolean; gcA: number | null };
      reads: Record<string, number>;
      metadataWaits: number;
      holdRead: (name: string, stage?: 'metadata' | 'sequence') => void;
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
let fixtureConfig: UserConfig | undefined;
async function expectGC(overlay: Locator, left: string, right: string): Promise<void> {
  await overlay.getByRole('button', { name: 'Biological', exact: true }).click();
  await expect(overlay.getByText('GC content', { exact: true }).locator('..')).toContainText(left + '% / ' + right + '%');
}

const fixtureSource = String.raw`
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { importLocalGenomes } from '@phage-explorer/core';
  import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
  import { usePhageStore } from '@phage-explorer/state';
  import { ComparisonOverlay } from './components/overlays/ComparisonOverlay';
  import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
  import { ToastProvider } from './components/ui/Toast';
  import { ScrollProvider } from './providers';
  import './styles/index.css';

  let select = () => {}, reopen = () => {}, heldName = null, heldStage = null, gate = null, release = () => {};
  const fixture = window.comparisonIdentityFixture = {
    select: name => select(name), reopen: () => reopen(), reads: {}, metadataWaits: 0,
    readPending: false, readReleased: false, holdReply: false, replyPending: false,
    replyReleased: false, releaseReply: () => {}, terminatedWorkers: 0,
    replaceSummaries() {
      flushSync(() => usePhageStore.setState({ phages: usePhageStore.getState().phages.map(p => ({ ...p })) }));
    },
    snapshot() {
      const state = usePhageStore.getState();
      return { loading: state.comparisonLoading, hasResult: state.comparisonResult !== null,
        gcA: state.comparisonResult?.biological.gcContentA ?? null };
    },
    holdRead(name, stage = 'sequence') {
      heldName = name; heldStage = stage; this.readPending = false; this.readReleased = false; this.metadataWaits = 0;
      gate = new Promise(resolve => { release = resolve; });
    },
    releaseRead() { heldName = null; release(); },
  };
  // Hold an actual computed reply; do not substitute either its sequence data
  // or numbers. Dispatching it after termination also exercises queued callbacks.
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.addEventListener('message', event => {
        if (!fixture.holdReply || event.data?.ok !== true || !event.data.diff) return;
        fixture.holdReply = false; event.stopImmediatePropagation();
        const data = event.data;
        fixture.replyPending = true; fixture.replyReleased = false;
        fixture.releaseReply = () => {
          fixture.replyReleased = true;
          this.dispatchEvent(new MessageEvent('message', { data }));
        };
      });
    }
    terminate() { fixture.terminatedWorkers++; super.terminate(); }
  };

  async function entry(name, a, b) {
    const imported = await importLocalGenomes({ name: name + '.fasta', text: '>reference\n' + a + '\n>query\n' + b });
    imported.genomes.forEach((genome, i) => {
      genome.phage = { ...genome.phage, id: -i - 1, name: i === 0 ? 'Reference' : 'Query',
        accession: i === 0 ? 'same-reference' : 'same-query' };
    });
    const repository = createLocalGenomeRepository(null, imported.genomes);
    const metadata = repository.getPhageById.bind(repository), read = repository.getSequenceWindow.bind(repository);
    fixture.reads[name] = 0;
    const wait = async (stage, id) => {
      if (id === -1 && heldName === name && heldStage === stage) {
        const pending = gate; fixture.readPending = true;
        if (stage === 'metadata') fixture.metadataWaits++;
        await pending; fixture.readReleased = true;
      }
    };
    repository.getPhageById = async id => { await wait('metadata', id); return metadata(id); };
    repository.getSequenceWindow = async (...args) => {
      fixture.reads[name]++; await wait('sequence', args[0]);
      const sequence = await read(...args);
      return name === 'truncated' && args[0] === -1 ? sequence.slice(0, -1) : sequence;
    };
    return { repository, phages: imported.genomes.map(genome => genome.phage) };
  }
  // All repositories deliberately reuse IDs, names, accessions AND lengths.
  // Changing only the repository must still change both metrics and exact diff.
  const entries = {
    a: await entry('a', 'A'.repeat(120), 'A'.repeat(120)),
    b: await entry('b', 'G'.repeat(120), 'G'.repeat(119) + 'C'),
    c: await entry('c', 'C'.repeat(120), 'C'.repeat(118) + 'TT'),
    delayed: await entry('delayed', 'T'.repeat(120), 'T'.repeat(120)),
    replaced: await entry('replaced', 'AC'.repeat(60), 'AC'.repeat(60)),
    truncated: await entry('truncated', 'A'.repeat(120), 'A'.repeat(120)),
  };
  function Fixture() {
    const [name, setName] = useState('a');
    const { open } = useOverlay();
    useEffect(() => {
      select = next => flushSync(() => setName(next));
      reopen = () => flushSync(() => open('comparison'));
      usePhageStore.setState({ phages: entries.a.phages, comparisonPhageAIndex: 0, comparisonPhageBIndex: 1,
        comparisonTab: 'biological', comparisonResult: null, comparisonLoading: false, overlays: [] });
      open('comparison');
    }, []);
    // Keep the component mounted during provider closure to cover Escape as
    // well as the normal OverlayManager unmount path.
    return React.createElement(ComparisonOverlay, { repository: name === 'none' ? null : entries[name].repository });
  }
  createRoot(document.getElementById('root')).render(
    React.createElement(ScrollProvider, null,
      React.createElement(ToastProvider, null,
        React.createElement(OverlayProvider, null, React.createElement(Fixture))))
  );
`;

for (const scenario of ['source-and-reads', 'cancel-and-recover'] as const) test(
  'comparison owns its ' + scenario, async ({ page }, info) => {
    const root = process.cwd(), fixtureId = resolve(root, 'src/comparison-identity-fixture.tsx');
    if (!fixtureConfig) {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
      if (!loaded) throw new Error('Could not load comparison fixture configuration');
      fixtureConfig = loaded.config;
    }
    const server = await createServer(mergeConfig(fixtureConfig, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'),
      server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{
        name: 'comparison-identity-fixture',
        resolveId(source) { if (source === '/src/comparison-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
        load(source) { if (source === fixtureId) return fixtureSource; },
        configureServer(vite) {
          vite.middlewares.use('/comparison-identity-fixture', (_request, response, next) => {
            void vite.transformIndexHtml('/comparison-identity-fixture', '<div id="root"></div><script type="module" src="/src/comparison-identity-fixture.tsx"></script>')
              .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
          });
        },
      }],
    } satisfies InlineConfig));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await server.listen();
      await page.goto(server.resolvedUrls!.local[0] + 'comparison-identity-fixture');
      const overlay = page.getByTestId('overlay-comparison');
      await expectGC(overlay, '0.00', '0.00');
      if (scenario === 'source-and-reads') {
        await overlay.getByRole('button', { name: 'Diff', exact: true }).click();
        await expect(overlay.getByTestId('comparison-identical')).toBeVisible();
        await page.evaluate(() => {
          window.comparisonIdentityFixture.holdRead('b', 'sequence');
          window.comparisonIdentityFixture.select('b');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.readPending)).toBe(true);
        await expect(overlay.getByTestId('comparison-identical')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.snapshot().hasResult)).toBe(false);
        await page.evaluate(() => window.comparisonIdentityFixture.releaseRead());
        await expect(overlay.getByText(/Edit distance:/)).toContainText('Edit distance: 1.');
        await expectGC(overlay, '100.00', '100.00');

        // Releasing abandoned metadata must not launch old sequence reads.
        await page.evaluate(() => {
          window.comparisonIdentityFixture.holdRead('delayed', 'metadata');
          window.comparisonIdentityFixture.select('delayed');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.readPending)).toBe(true);
        await page.evaluate(() => window.comparisonIdentityFixture.select('a'));
        await expectGC(overlay, '0.00', '0.00');
        await page.evaluate(() => window.comparisonIdentityFixture.releaseRead());
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.readReleased)).toBe(true);
        expect(await page.evaluate(() => window.comparisonIdentityFixture.reads.delayed)).toBe(0);

        // Replacing catalog objects with the same IDs also revokes pending reads.
        await page.evaluate(() => {
          window.comparisonIdentityFixture.holdRead('replaced', 'metadata');
          window.comparisonIdentityFixture.select('replaced');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.metadataWaits)).toBe(1);
        await page.evaluate(() => window.comparisonIdentityFixture.replaceSummaries());
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.metadataWaits)).toBe(2);
        await page.evaluate(() => window.comparisonIdentityFixture.releaseRead());
        await expectGC(overlay, '50.00', '50.00');
        expect(await page.evaluate(() => window.comparisonIdentityFixture.reads.replaced)).toBe(2);
      } else {
        await page.evaluate(() => {
          window.comparisonIdentityFixture.holdReply = true;
          window.comparisonIdentityFixture.select('c');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.replyPending)).toBe(true);
        const terminated = await page.evaluate(() => window.comparisonIdentityFixture.terminatedWorkers);
        await overlay.getByRole('combobox', { name: 'Phage B', exact: true }).selectOption('');
        await expect(overlay.getByRole('combobox', { name: 'Phage B', exact: true })).toHaveValue('');
        await expect(overlay.getByText('Select two phages to compare.', { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.terminatedWorkers)).toBeGreaterThan(terminated);
        await page.evaluate(() => window.comparisonIdentityFixture.releaseReply());
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.snapshot())).toEqual({ loading: false, hasResult: false, gcA: null });
        await overlay.getByRole('combobox', { name: 'Phage B', exact: true }).selectOption('1');
        await expectGC(overlay, '100.00', '98.33');

        await page.evaluate(() => {
          window.comparisonIdentityFixture.replyPending = false;
          window.comparisonIdentityFixture.holdReply = true;
          window.comparisonIdentityFixture.select('b');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.replyPending)).toBe(true);
        await page.evaluate(() => window.comparisonIdentityFixture.select('none'));
        await expect(overlay.getByText('Database is still loading.', { exact: true })).toBeVisible();
        await page.evaluate(() => window.comparisonIdentityFixture.releaseReply());
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.snapshot())).toEqual({ loading: false, hasResult: false, gcA: null });
        await page.evaluate(() => window.comparisonIdentityFixture.select('a'));
        await expectGC(overlay, '0.00', '0.00');

        await page.evaluate(() => {
          window.comparisonIdentityFixture.replyPending = false;
          window.comparisonIdentityFixture.holdReply = true;
          window.comparisonIdentityFixture.select('c');
        });
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.replyPending)).toBe(true);
        await page.keyboard.press('Escape'); // provider-only close, component remains mounted
        await expect(overlay).toHaveCount(0);
        await page.evaluate(() => window.comparisonIdentityFixture.releaseReply());
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.snapshot())).toEqual({ loading: false, hasResult: false, gcA: null });
        await page.evaluate(() => window.comparisonIdentityFixture.reopen());
        await expectGC(overlay, '100.00', '98.33');

        await page.evaluate(() => window.comparisonIdentityFixture.select('truncated'));
        await expect(overlay.getByText('A complete sequence could not be loaded for both genomes.', { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.comparisonIdentityFixture.snapshot().hasResult)).toBe(false);
        await page.evaluate(() => window.comparisonIdentityFixture.select('a'));
        await expectGC(overlay, '0.00', '0.00');
        await overlay.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(overlay).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); await server.close(); }
  }
);
