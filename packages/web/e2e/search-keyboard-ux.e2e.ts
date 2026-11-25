import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

declare global {
  interface Window {
    searchIdentityFixture: {
      select: (name: 'a' | 'b') => void;
      holdRead: boolean;
      readPending: boolean;
      releaseRead: () => void;
      holdReply: boolean;
      replyPending: boolean;
      replyReleased: boolean;
      releaseReply: () => void;
      position: () => number;
      reopenInFrame: (frame: 0 | 1 | 2 | -1 | -2 | -3) => void;
      viewMode: () => string;
    };
  }
}

test.describe('SearchOverlay Keyboard UX', () => {
  test('should autofocus input and support keyboard navigation', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await test.step('Load app', async () => {
      await page.goto('/');
      await expect(page.locator('header.app-header')).toBeVisible();
      await page.waitForTimeout(500); // Wait for hydration
    });

    await test.step('Open Search overlay with /', async () => {
      await page.keyboard.press('/');
      const searchOverlay = page.locator('.overlay-search');
      await expect(searchOverlay).toBeVisible();
    });

    await test.step('Input should be autofocused', async () => {
      // The input should be focused automatically
      const input = page.locator('.overlay-search input[type="text"]');
      await expect(input).toBeFocused();
    });

    await test.step('Escape with empty query should close overlay', async () => {
      await page.keyboard.press('Escape');
      await expect(page.locator('.overlay-search')).toBeHidden();
    });

    await test.step('Reopen and test Escape clears query first', async () => {
      await page.keyboard.press('/');
      await expect(page.locator('.overlay-search')).toBeVisible();

      const input = page.locator('.overlay-search input[type="text"]');
      await input.fill('test query');
      await expect(input).toHaveValue('test query');

      // First Escape should clear the query, not close
      await page.keyboard.press('Escape');
      await expect(page.locator('.overlay-search')).toBeVisible();
      await expect(input).toHaveValue('');

      // Second Escape closes
      await page.keyboard.press('Escape');
      await expect(page.locator('.overlay-search')).toBeHidden();
    });

    await finalize();
  });

  test('results list structure should support keyboard navigation', async ({ page }, testInfo) => {
    const { finalize } = setupTestHarness(page, testInfo);

    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();

    await test.step('Open Search overlay', async () => {
      await page.keyboard.press('/');
      await expect(page.locator('.overlay-search')).toBeVisible();
    });

    await test.step('Verify overlay structure is correct', async () => {
      // The search overlay should be present with the input
      const input = page.locator('.overlay-search input[type="text"]');
      await expect(input).toBeVisible();

      // Arrow keys should not cause errors when there are no results
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');

      // Overlay should still be open (no errors occurred)
      await expect(page.locator('.overlay-search')).toBeVisible();
    });

    await finalize();
  });
});

test('search owns its input, annotations, circular topology and late worker replies across repository replacement', async ({ page }, info) => {
  const root = process.cwd(), fixtureId = resolve(root, 'src/search-identity-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load search fixture configuration');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'search-identity-fixture',
      resolveId(source) { if (source === '/src/search-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) {
        if (source !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { usePhageStore } from '@phage-explorer/state';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { SearchOverlay } from './components/overlays/SearchOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {};
          const fixture = window.searchIdentityFixture = {
            select: name => select(name), holdRead: false, readPending: false, releaseRead: () => {},
            holdReply: false, replyPending: false, replyReleased: false, releaseReply: () => {},
            position: () => usePhageStore.getState().scrollPosition,
            viewMode: () => usePhageStore.getState().viewMode,
            reopenInFrame: () => {},
          };
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(url, options) {
              super(url, options);
              this.addEventListener('message', event => {
                if (!fixture.holdReply || event.data?.type !== 'RAW' || !Array.isArray(event.data.value?.hits)) return;
                fixture.holdReply = false; event.stopImmediatePropagation();
                const data = event.data; fixture.replyPending = true;
                fixture.releaseReply = () => {
                  fixture.replyReleased = true;
                  this.dispatchEvent(new MessageEvent('message', { data }));
                };
              });
            }
          };
          async function entry(name, sequence, geneName, topology = 'unknown') {
            const imported = await importLocalGenomes({ name: name + '.fasta',
              text: '>input' + (topology === 'unknown' ? '' : ' [topology=' + topology + ']') + '\\n' + sequence });
            const genome = imported.genomes[0];
            genome.phage = { ...genome.phage, id: -1, genes: [{ id: 1, startPos: 0, endPos: 3,
              name: geneName, locusTag: null, product: 'Example', type: 'CDS', strand: '+' }] };
            const repository = createLocalGenomeRepository(null, [genome]);
            const read = repository.getSequenceWindow.bind(repository);
            repository.getSequenceWindow = async (...args) => {
              if (name === 'b' && fixture.holdRead) {
                fixture.readPending = true;
                await new Promise(resolve => { fixture.releaseRead = () => { fixture.holdRead = false; resolve(); }; });
              }
              return read(...args);
            };
            return { repository, phage: genome.phage };
          }
          const entries = {
            a: await entry('a', 'AAAAACCC', 'AlphaBridgeCore'),
            b: await entry('b', 'CCCCCAAA', 'alphabridgecore', 'circular'),
          };
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => {
              select = next => flushSync(() => setName(next));
              fixture.reopenInFrame = frame => {
                usePhageStore.getState().setViewMode('aa');
                usePhageStore.getState().setReadingFrame(frame);
                open('search');
              };
              open('search');
            }, []);
            // Deliberately retain the previous PhageFull while its repository
            // changes. Annotations must be read beside bases from that repository.
            return <SearchOverlay repository={entries[name].repository} currentPhage={entries.a.phage} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/search-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/search-identity-fixture', '<div id="root"></div><script type="module" src="/src/search-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}search-identity-fixture`);
    const overlay = page.getByTestId('overlay-search'), query = overlay.getByLabel('Query', { exact: true });
    const hits = overlay.locator('[data-result-index]');
    await overlay.getByRole('button', { name: 'Motif / IUPAC', exact: true }).click();
    await overlay.getByLabel('Strand:').selectOption('+');
    await query.fill('AAA');
    const box = overlay.getByRole('combobox', { name: 'Query', exact: true });
    const results = overlay.getByRole('listbox', { name: 'Search results' });
    const options = results.getByRole('option');
    await expect(options).toHaveCount(3);
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(box).toHaveAttribute('aria-controls', await results.getAttribute('id') as string);
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await box.press('ArrowDown');
    await expect(box).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id') as string);
    await expect(overlay.getByRole('status').filter({ hasText: '3/500 results' })).toBeVisible();
    await expect(overlay.getByRole('button', { name: 'Motif / IUPAC' })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => { window.searchIdentityFixture.holdReply = true; });
    await query.fill('AA');
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await expect(box).not.toHaveAttribute('aria-activedescendant', /.+/);
    await expect.poll(() => page.evaluate(() => window.searchIdentityFixture.replyPending)).toBe(true);
    await page.evaluate(() => { window.searchIdentityFixture.holdRead = true; window.searchIdentityFixture.select('b'); });
    await expect.poll(() => page.evaluate(() => window.searchIdentityFixture.readPending)).toBe(true);
    await expect(hits).toHaveCount(0);
    await page.evaluate(() => window.searchIdentityFixture.releaseReply());
    await expect.poll(() => page.evaluate(() => window.searchIdentityFixture.replyReleased)).toBe(true);
    await expect(overlay.getByText('Loading genome sequence…', { exact: true })).toBeVisible();
    await expect(hits).toHaveCount(0);
    await page.evaluate(() => window.searchIdentityFixture.releaseRead());
    await expect(hits).toHaveCount(2);
    await expect(hits.first()).toContainText('5-7 (+)');
    await query.fill('GGG');
    await expect(hits).toHaveCount(0);
    await expect(overlay.getByText('No matches found.', { exact: true })).toBeVisible();
    await overlay.getByRole('button', { name: 'Gene', exact: true }).click();
    await overlay.getByLabel('Case sensitive').check();
    await query.fill('ABC');
    await expect(overlay.getByText('No matches found.', { exact: true })).toBeVisible();
    await expect(hits).toHaveCount(0);
    await overlay.getByLabel('Case sensitive').uncheck();
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('alphabridgecore');

    // Topology belongs to the repository alongside its sequence/annotations,
    // even though this fixture deliberately keeps the previous PhageFull prop.
    await overlay.getByRole('button', { name: 'Sequence', exact: true }).click();
    const topology = overlay.getByLabel('Sequence topology:');
    await expect(topology).toHaveValue('annotation');
    await expect(topology.locator('option:checked')).toHaveText('Annotated circular');
    await query.fill('AAC');
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('6-8 + 0-1 (+) · crosses origin');
    await expect(hits.first()).toContainText(' | ');
    await topology.selectOption('linear');
    await expect(hits).toHaveCount(0);
    await expect(overlay.getByText('No matches found.', { exact: true })).toBeVisible();
    await topology.selectOption('circular');
    await expect(hits).toHaveCount(1);
    await query.fill('CCA');
    await expect(hits).toHaveCount(1);
    await page.evaluate(() => window.searchIdentityFixture.select('a'));
    await expect(topology).toHaveValue('annotation');
    await expect(topology.locator('option:checked')).toHaveText('Unknown · linear interval');
    await expect(hits).toHaveCount(0);
    await expect(overlay.getByText('No matches found.', { exact: true })).toBeVisible();
    await topology.selectOption('circular');
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('6-8 + 0-1 (+) · crosses origin');
    await query.press('Enter');
    await expect(overlay).toBeHidden();
    expect(await page.evaluate(() => window.searchIdentityFixture.position())).toBe(6);
    // At eight bases in frame -1 the first two bases are untranslated.
    await page.evaluate(() => window.searchIdentityFixture.reopenInFrame(-1));
    await overlay.getByRole('button', { name: 'Position', exact: true }).click();
    await query.fill('4');
    await expect(options).toHaveCount(1);
    await options.first().click();
    await expect(overlay).toBeHidden();
    expect(await page.evaluate(() => [window.searchIdentityFixture.viewMode(), window.searchIdentityFixture.position()])).toEqual(['aa', 0]);

    await page.evaluate(() => window.searchIdentityFixture.reopenInFrame(1));
    await query.fill('7');
    await expect(options.first()).toContainText('7-8');
    await query.press('Enter');
    await expect(overlay).toBeHidden();
    expect(await page.evaluate(() => [window.searchIdentityFixture.viewMode(), window.searchIdentityFixture.position()])).toEqual(['dna', 7]);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
