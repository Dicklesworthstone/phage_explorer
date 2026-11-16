import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';

declare global {
  interface Window {
    logoIdentityFixture: {
      select: (name: string) => void;
      holdRead: (name: string) => void;
      releaseRead: () => void;
      readPending: boolean;
      readReleased: boolean;
      close: () => void;
      reopen: () => void;
    };
    analysisIdentityFixture: {
      select: (name: string) => void;
      reads: Record<string, number>;
      holdRead: (name: string) => void;
      releaseRead: () => void;
      readPending: boolean;
      readReleased: boolean;
      holdReply: boolean;
      replyPending: boolean;
      replyReleased: boolean;
      releaseReply: () => void;
    };
  }
}

const overlays = ['cgr', 'hilbert', 'anomaly', 'phasePortrait', 'hgt'] as const;
type AnalysisOverlay = typeof overlays[number];
let fixtureConfig: UserConfig | undefined;

async function plotPixels(overlay: Locator): Promise<string> {
  return overlay.locator('canvas').evaluateAll(canvases => canvases.map(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (const pixel of pixels ?? []) hash = Math.imul(hash ^ pixel, 16777619);
    return `${canvas.width}x${canvas.height}:${hash >>> 0}`;
  }).join('|'));
}

async function expectReady(overlay: Locator, id: AnalysisOverlay, input: 'a' | 'b'): Promise<void> {
  if (id === 'cgr') {
    await expect(overlay.getByText('GC content', { exact: true }).locator('..')).toContainText(input === 'a' ? '0.00%' : '50.00%');
    await expect(overlay.getByText('Computing Chaos Game Representation...')).toHaveCount(0);
  } else if (id === 'hilbert') {
    await expect(overlay.getByText('Curve order', { exact: true }).locator('..')).not.toContainText('—');
    await expect(overlay.getByText('Computing Hilbert curve...')).toHaveCount(0);
  } else if (id === 'anomaly') {
    await expect(overlay.getByText('Genome-wide anomaly score (highlighted when ≥ threshold)', { exact: true })).toBeVisible();
  } else if (id === 'phasePortrait') {
    await expect(overlay.getByText(/\d+ windows \|/)).toContainText(input === 'a' ? '391 windows' : '591 windows');
  } else {
    await expect(overlay.getByText(/Genome GC: .*island/)).toContainText(input === 'a' ? 'Genome GC: 0.0%' : 'Genome GC: 50.0%');
    await expect(overlay.getByText(/Donor panel: \d+ catalogue/)).toContainText(input === 'a' ? 'Donor panel: 1 catalogue' : 'Donor panel: 2 catalogue');
  }
}

async function expectPendingPlot(overlay: Locator, id: AnalysisOverlay): Promise<void> {
  if (id === 'cgr' || id === 'hilbert') {
    // These canvases remain mounted while loading. Old pixels must be cleared,
    // not merely accompanied by a spinner for a different genome.
    await expect.poll(() => overlay.locator('canvas').evaluateAll(canvases => canvases.every(element => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.every((value, index) => index % 4 !== 3 || value === 0);
    }))).toBe(true);
  } else if (id === 'anomaly') {
    await expect(overlay.getByText('Genome-wide anomaly score (highlighted when ≥ threshold)', { exact: true })).toHaveCount(0);
  } else if (id === 'phasePortrait') {
    await expect(overlay.getByText(/\d+ windows \|/)).toHaveCount(0);
  } else {
    await expect(overlay.getByText(/Genome GC: .*island/)).toHaveCount(0);
  }
}

for (const id of overlays) test(`${id} owns its repository, pending reads and rendered result`, async ({ page }, info) => {
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/analysis-identity-fixture.tsx');
  if (!fixtureConfig) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load analysis fixture configuration');
    fixtureConfig = loaded.config;
  }
  const server = await createServer(mergeConfig(fixtureConfig, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'analysis-identity-fixture',
      resolveId(source) { if (source === '/src/analysis-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) {
        if (source !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { usePhageStore } from '@phage-explorer/state';
          import { CGROverlay } from './components/overlays/CGROverlay';
          import { HilbertOverlay } from './components/overlays/HilbertOverlay';
          import { AnomalyOverlay } from './components/overlays/AnomalyOverlay';
          import { PhasePortraitOverlay } from './components/overlays/PhasePortraitOverlay';
          import { HGTOverlay } from './components/overlays/HGTOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {}, heldName = null, gate = null, release = () => {};
          const fixture = window.analysisIdentityFixture = {
            select: name => select(name), reads: {}, readPending: false, readReleased: false,
            holdReply: false, replyPending: false, replyReleased: false, releaseReply: () => {},
            holdRead(name) {
              heldName = name; this.readPending = false; this.readReleased = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            releaseRead() { heldName = null; release(); },
          };
          // Delay a real Comlink result after the worker computed it. No worker
          // is mocked and neither the DNA nor the returned analysis is edited.
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            constructor(url, options) {
              super(url, options);
              this.addEventListener('message', event => {
                if (!fixture.holdReply || event.data?.type !== 'RAW' || !event.data.value || typeof event.data.value !== 'object') return;
                fixture.holdReply = false;
                event.stopImmediatePropagation();
                const data = event.data;
                fixture.replyPending = true;
                fixture.releaseReply = () => {
                  fixture.replyReleased = true;
                  this.dispatchEvent(new MessageEvent('message', { data }));
                };
              });
            }
          };
          async function entry(name, sequence, donors = 1) {
            const input = '${id}' === 'phasePortrait' && name !== 'unannotated'
              ? { name: name + '.gb', text: 'LOCUS       ' + name + ' ' + sequence.length + ' bp DNA linear\\nFEATURES             Location/Qualifiers\\n' +
                  '     CDS             1..' + sequence.length + '\\n                     /locus_tag="full"\\n' +
                  '     CDS             complement(join(1..30,61..90))\\n                     /locus_tag="short"\\n' +
                  '     CDS             1..90\\n                     /locus_tag="unsupported"\\n                     /transl_table=2\\n' +
                  'ORIGIN\\n        1 ' + sequence.toLowerCase() + '\\n//\\n' }
              : { name: name + '.fasta', text: '>input\\n' + sequence };
            const imported = await importLocalGenomes(input);
            const genome = imported.genomes[0];
            genome.phage = { ...genome.phage, id: -1 };
            const genomes = [genome, ...Array.from({ length: donors }, (_, i) => ({
              ...genome, phage: { ...genome.phage, id: -2 - i, name: name + ' donor ' + i },
            }))];
            const repository = createLocalGenomeRepository(null, genomes);
            const read = repository.getSequenceWindow.bind(repository);
            fixture.reads[name] = 0;
            repository.getSequenceWindow = async (...args) => {
              if (args[0] === -1) {
                fixture.reads[name]++;
                if (heldName === name) {
                  const pending = gate;
                  fixture.readPending = true;
                  await pending;
                  fixture.readReleased = true;
                }
              }
              return read(...args);
            };
            return { repository, phage: genome.phage, phages: genomes.map(item => item.phage) };
          }
          const entries = {
            a: await entry('a', 'AT'.repeat(3000)),
            b: await entry('b', 'GC'.repeat(2250) + 'A'.repeat(4500), 2),
            c: await entry('c', 'CAG'.repeat(2200)),
            delayed: await entry('delayed', 'AGTC'.repeat(2100)),
            unannotated: await entry('unannotated', 'ATG'.repeat(100)),
          };
          const components = { cgr: CGROverlay, hilbert: HilbertOverlay, anomaly: AnomalyOverlay, phasePortrait: PhasePortraitOverlay, hgt: HGTOverlay };
          const Component = components['${id}'];
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => {
              select = next => flushSync(() => { usePhageStore.setState({ phages: entries[next].phages }); setName(next); });
              usePhageStore.setState({ phages: entries.a.phages });
              open('${id}');
            }, []);
            return <Component repository={entries[name].repository} currentPhage={entries[name].phage} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/analysis-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/analysis-identity-fixture', '<div id="root"></div><script type="module" src="/src/analysis-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}analysis-identity-fixture`);
    const overlay = page.getByTestId(`overlay-${id}`);
    await expect(overlay).toBeVisible();
    if (id === 'phasePortrait') await overlay.getByRole('combobox', { name: 'Window:', exact: true }).selectOption('50');
    else if (id === 'hgt') await overlay.getByLabel('Window:', { exact: true }).selectOption('1000');
    else if (id === 'cgr') await overlay.locator('select').selectOption('6');
    else if (id === 'hilbert') await overlay.locator('select').selectOption('gc-bias');
    else await overlay.getByRole('slider').fill('91');
    await expectReady(overlay, id, 'a');
    const originalPixels = await plotPixels(overlay);

    await page.evaluate(() => window.analysisIdentityFixture.select('b'));
    await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.reads.b)).toBeGreaterThan(0);
    await expectReady(overlay, id, 'b');
    await expect.poll(() => plotPixels(overlay)).not.toBe(originalPixels);
    if (id === 'phasePortrait') await expect(overlay.getByRole('combobox', { name: 'Window:', exact: true })).toHaveValue('50');
    else if (id === 'hgt') await expect(overlay.getByLabel('Window:', { exact: true })).toHaveValue('1000');
    else if (id === 'cgr') await expect(overlay.locator('select')).toHaveValue('6');
    else if (id === 'hilbert') await expect(overlay.locator('select')).toHaveValue('gc-bias');
    else await expect(overlay.getByRole('slider')).toHaveValue('91');

    // A superseded repository may finish reading later; it cannot repopulate
    // the new repository's cache or replace its visible analysis.
    await page.evaluate(() => { window.analysisIdentityFixture.holdRead('delayed'); window.analysisIdentityFixture.select('delayed'); });
    await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.readPending)).toBe(true);
    await expectPendingPlot(overlay, id);
    await page.evaluate(() => window.analysisIdentityFixture.select('a'));
    await expectReady(overlay, id, 'a');
    await page.evaluate(() => window.analysisIdentityFixture.releaseRead());
    await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.readReleased)).toBe(true);
    await expectReady(overlay, id, 'a');

    if (id !== 'hgt') {
      await page.evaluate(() => { window.analysisIdentityFixture.holdReply = true; window.analysisIdentityFixture.select('c'); });
      await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.replyPending)).toBe(true);
      await page.evaluate(() => { window.analysisIdentityFixture.holdRead('delayed'); window.analysisIdentityFixture.select('delayed'); });
      await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.readPending)).toBe(true);
      await page.evaluate(() => window.analysisIdentityFixture.releaseReply());
      await expect.poll(() => page.evaluate(() => window.analysisIdentityFixture.replyReleased)).toBe(true);
      await expectPendingPlot(overlay, id);
      await page.evaluate(() => { window.analysisIdentityFixture.select('b'); window.analysisIdentityFixture.releaseRead(); });
      await expectReady(overlay, id, 'b');
    }
    if (id === 'phasePortrait') {
      const cds = overlay.getByRole('combobox', { name: 'Annotated CDS:', exact: true });
      const chooseCds = async (label: string) => {
        const value = await cds.locator('option').filter({ hasText: label }).getAttribute('value');
        expect(value).not.toBeNull();
        await cds.selectOption(value!);
      };
      await expect(overlay.getByTestId('phase-portrait-cds')).toContainText('3000 protein residues');
      await chooseCds('short');
      await expect(overlay.getByTestId('phase-portrait-cds')).toContainText('20 protein residues');
      await expect(overlay).toContainText('Protein is shorter than the selected window');
      await overlay.getByRole('combobox', { name: 'Window:', exact: true }).selectOption('15');
      await expect(overlay.getByText(/\d+ windows \|/)).toContainText('2 windows');
      await chooseCds('unsupported');
      await expect(overlay).toContainText('Selected CDS is unavailable');
      await expect(overlay).toContainText('Unsupported translation table.');
      await expect(overlay.getByText(/\d+ windows \|/)).toHaveCount(0);
      await page.evaluate(() => window.analysisIdentityFixture.select('unannotated'));
      await expect(overlay).toContainText('No annotated CDS available');
      await expect(overlay.getByText(/\d+ windows \|/)).toHaveCount(0);
      await page.evaluate(() => window.analysisIdentityFixture.select('b'));
      await chooseCds('full');
      await overlay.getByRole('combobox', { name: 'Window:', exact: true }).selectOption('50');
      await expectReady(overlay, id, 'b');
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
});

test('gene-start logo preserves exact annotated motifs and rejects obsolete source reads', async ({ page }, info) => {
  const root = process.cwd(), fixtureId = resolve(root, 'src/logo-identity-fixture.tsx');
  if (!fixtureConfig) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
    if (!loaded) throw new Error('Could not load logo fixture configuration');
    fixtureConfig = loaded.config;
  }
  const server = await createServer(mergeConfig(fixtureConfig, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'logo-identity-fixture',
      resolveId(source) { if (source === '/src/logo-identity-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) {
        if (source !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { LogoOverlay } from './components/overlays/LogoOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {}, heldName = null, gate = null, release = () => {};
          const fixture = window.logoIdentityFixture = {
            select: name => select(name), readPending: false, readReleased: false,
            close: () => {}, reopen: () => {},
            holdRead(name) {
              heldName = name; this.readPending = false; this.readReleased = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            releaseRead() { heldName = null; release(); },
          };
          async function entry(name, sequence, location = '21..50', topology = 'linear', qualifiers = '') {
            const imported = await importLocalGenomes({ name: name + '.gb', text:
              'LOCUS       input ' + sequence.length + ' bp DNA ' + topology + '\\nFEATURES             Location/Qualifiers\\n' +
              '     CDS             ' + location + '\\n' + qualifiers +
              'ORIGIN\\n        1 ' + sequence.toLowerCase() + '\\n//\\n' });
            const genome = imported.genomes[0];
            genome.phage = { ...genome.phage, id: -1 };
            const repository = createLocalGenomeRepository(null, [genome]);
            const read = repository.getSequenceWindow.bind(repository);
            repository.getSequenceWindow = async (...args) => {
              if (heldName === name) { const pending = gate; fixture.readPending = true; await pending; fixture.readReleased = true; }
              if (name === 'error') throw new Error('fixture: sequence unavailable');
              return read(...args);
            };
            return { repository, phage: genome.phage };
          }
          const a = 'A'.repeat(20) + 'ATG' + 'C'.repeat(37);
          const circular = 'GGGTT' + 'C'.repeat(30) + 'A'.repeat(20) + 'ATGCC';
          const entries = {
            a: await entry('a', a),
            b: await entry('b', 'C'.repeat(20) + 'ATG' + 'A'.repeat(37)),
            delayed: await entry('delayed', 'G'.repeat(20) + 'ATG' + 'T'.repeat(37)),
            circular: await entry('circular', circular, 'join(56..60,1..16)', 'circular'),
            unknown: await entry('unknown', circular, 'join(56..60,1..16)', ''),
            partial: await entry('partial', a, '21..50', 'linear', '                     /codon_start=2\\n'),
            error: await entry('error', a),
            missing: { repository: null, phage: null },
          };
          function Fixture() {
            const [name, setName] = useState('a');
            const { open, close } = useOverlay();
            useEffect(() => {
              select = next => flushSync(() => setName(next));
              fixture.close = () => close('logo'); fixture.reopen = () => open('logo'); open('logo');
            }, []);
            return <LogoOverlay repository={entries[name].repository} currentPhage={entries[name].phage} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/logo-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/logo-identity-fixture', '<div id="root"></div><script type="module" src="/src/logo-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}logo-identity-fixture`);
    const overlay = page.getByTestId('overlay-logo'), coverage = overlay.getByTestId('gene-start-logo-coverage');
    const expectWindow = async (sequence: string, anchor: number) => {
      await expect(coverage).toContainText('1 distinct oriented starts from 1 mapped CDS features.');
      const details = coverage.locator('details');
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
      await expect(details.locator('tbody tr td').nth(1)).toHaveText(String(anchor));
      await expect(details.locator('code')).toHaveText(sequence);
    };
    const original = 'A'.repeat(20) + 'ATG' + 'C'.repeat(7);
    await expectWindow(original, 21);
    await page.evaluate(() => { window.logoIdentityFixture.holdRead('delayed'); window.logoIdentityFixture.select('delayed'); });
    await expect.poll(() => page.evaluate(() => window.logoIdentityFixture.readPending)).toBe(true);
    await expect(coverage).toHaveCount(0);
    await expect(overlay.getByLabel('Position 0', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.logoIdentityFixture.select('missing'));
    await page.evaluate(() => window.logoIdentityFixture.releaseRead());
    await expect.poll(() => page.evaluate(() => window.logoIdentityFixture.readReleased)).toBe(true);
    await expect(coverage).toHaveCount(0);
    await expect(overlay).toContainText('Database not loaded yet.');

    await page.evaluate(() => window.logoIdentityFixture.select('b'));
    await expectWindow('C'.repeat(20) + 'ATG' + 'A'.repeat(7), 21);
    await page.evaluate(() => window.logoIdentityFixture.select('circular'));
    await expectWindow('A'.repeat(20) + 'ATGCCGGGTT', 56);
    await expect(coverage).toContainText('Topology: circular; 1 windows cross the origin.');
    await page.evaluate(() => window.logoIdentityFixture.select('unknown'));
    await expect(coverage).toContainText('0 distinct oriented starts from 1 mapped CDS features.');
    await expect(coverage).toContainText('without assuming circular topology');
    await page.evaluate(() => window.logoIdentityFixture.select('partial'));
    await expect(coverage).toContainText('0 distinct oriented starts from 1 mapped CDS features.');
    await expect(coverage).toContainText('Partial or unsupported codon_start');
    await page.evaluate(() => window.logoIdentityFixture.select('error'));
    await expect(overlay).toContainText('fixture: sequence unavailable');
    await expect(coverage).toHaveCount(0);
    await page.evaluate(() => { window.logoIdentityFixture.select('a'); window.logoIdentityFixture.close(); });
    await expect(overlay).toBeHidden();
    await page.evaluate(() => window.logoIdentityFixture.reopen());
    await expectWindow(original, 21);

    await overlay.getByRole('button', { name: 'Custom MSA', exact: true }).click();
    const alignment = overlay.getByLabel('Alignment', { exact: true });
    const parse = overlay.getByRole('button', { name: 'Parse & Use Alignment', exact: true });
    await alignment.fill('>a\nACRN\n>b\nACRN'); await parse.click();
    await expect(overlay).toContainText('Alphabet: DNA');
    await expect(overlay).toContainText('these IUPAC DNA symbols can also occur in proteins');
    await expect(overlay.getByLabel('Position 3', { exact: true })).toHaveText('');
    await alignment.fill('>a\n' + 'A'.repeat(1001)); await parse.click();
    await expect(overlay).toContainText('limited to 1,000 sequences and 1,000 columns');
    await expect(overlay.getByLabel('Position 1', { exact: true })).toHaveCount(0);
    await overlay.getByLabel('Upload', { exact: true }).setInputFiles({
      name: 'oversized.fa', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 'A'),
    });
    await expect(overlay).toContainText('limited to 2 MiB');
    await alignment.fill('>a\nACGT\n>b\nACGT'); await parse.click();
    await expect(overlay.getByLabel('Position 1', { exact: true })).toHaveText('A');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
});
