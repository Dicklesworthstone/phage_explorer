import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { setupTestHarness } from './e2e-harness';
import { parseAnalysisRecord } from '../../core/src/analysis-result';

// An isolated component journey deliberately changes repository props without
// reloading the page. It uses the real local repository, component and worker;
// only input selection and a delayed read are controlled by the fixture.
for (const backend of ['wasm', 'javascript'] as const) test(`repeat repository identity survives replacement and late reads under ${backend}`, async ({ page }, info) => {
  const webRoot = process.cwd();
  const fixtureId = resolve(webRoot, 'src/repeat-repository-fixture.tsx');
  const server = await createViteServer({
    root: webRoot,
    cacheDir: info.outputPath('vite-cache'),
    configFile: resolve(webRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'repeat-repository-fixture',
      resolveId(id) { if (id === '/src/repeat-repository-fixture.tsx') return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { RepeatsOverlay } from './components/overlays/RepeatsOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          async function entry(sequence) {
            const genome = (await importLocalGenomes({ name: 'input.fasta', text: '>input\\n' + sequence })).genomes[0];
            genome.phage = { ...genome.phage, id: 1 };
            return { phage: genome.phage, repository: createLocalGenomeRepository(null, [genome]) };
          }
          const a = await entry('ACGTANNNTACGT');
          const b = await entry('NNNNNNNNNNNN');
          const delayed = await entry('ACGAACGAACGA');
          const read = delayed.repository.getSequenceWindow.bind(delayed.repository);
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          delayed.repository.getSequenceWindow = async (...args) => {
            window.repeatReadPending = true;
            await gate;
            const value = await read(...args);
            window.repeatReadReleased = true;
            return value;
          };
          const broken = await entry('ACGAACGA');
          broken.repository.getSequenceWindow = async () => { throw new Error('Controlled read failure'); };
          function Fixture() {
            const [selected, select] = useState(a);
            const { open, close } = useOverlay();
            useEffect(() => {
              open('repeats');
              window.selectRepeatInput = name => select({ a, b, delayed, broken, missing: { phage: null, repository: null } }[name]);
              window.releaseRepeatRead = release;
              window.setRepeatOpen = value => value ? open('repeats') : close('repeats');
            }, []);
            return <RepeatsOverlay currentPhage={selected.phage} repository={selected.repository} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/repeat-repository-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/repeat-repository-fixture', '<div id="root"></div><script type="module" src="/src/repeat-repository-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (backend === 'javascript') await page.route('**/analysis.worker.ts?*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `WebAssembly.instantiate = async () => { throw new Error('Controlled WASM failure'); };\n${await response.text()}` });
  });
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}repeat-repository-fixture`);
    const overlay = page.getByTestId('overlay-repeats');
    const table = overlay.getByRole('table', { name: 'Repeat matches' });
    const select = (name: string) => page.evaluate(name => (window as any).selectRepeatInput(name), name);
    const exported = async () => {
      const downloading = page.waitForEvent('download');
      await overlay.getByRole('button', { name: 'Export repeat experiment', exact: true }).click();
      return parseAnalysisRecord(await readFile((await (await downloading).path())!, 'utf8'));
    };
    await expect(table).toContainText('Arms: 5 bp; spacer: 3 bp');
    const first = await exported();
    expect(first.inputs[0].data).toBe('ACGTANNNTACGT');
    await select('b');
    await expect(table).toContainText('No repeats found within these search limits');
    const second = await exported();
    expect(second.inputs[0].data).toBe('NNNNNNNNNNNN');
    expect(second.inputs[0].sha256).not.toBe(first.inputs[0].sha256);
    expect(second.method.implementation).toMatch(backend === 'javascript' ? /js detailed/ : /wasm-(baseline|simd) detailed/);
    await select('delayed');
    await expect.poll(() => page.evaluate(() => (window as any).repeatReadPending)).toBe(true);
    await expect(overlay.getByRole('button', { name: 'Export repeat experiment' })).toHaveCount(0);
    await select('b');
    await expect(table).toContainText('No repeats found within these search limits');
    await page.evaluate(() => (window as any).releaseRepeatRead());
    await expect.poll(() => page.evaluate(() => (window as any).repeatReadReleased)).toBe(true);
    expect((await exported()).resultId).toBe(second.resultId);
    await select('broken');
    await expect(overlay).toContainText('Repeat analysis unavailable');
    await expect(overlay.getByRole('button', { name: 'Export repeat experiment' })).toHaveCount(0);
    await select('missing');
    await expect(overlay).toContainText('No sequence data available');
    await select('a');
    await expect(table).toContainText('Arms: 5 bp; spacer: 3 bp');
    expect((await exported()).resultId).toBe(first.resultId);
    await page.evaluate(() => (window as any).setRepeatOpen(false));
    await expect(overlay).toHaveCount(0);
    await select('b');
    await page.evaluate(() => (window as any).setRepeatOpen(true));
    await expect(table).toContainText('No repeats found within these search limits');
    expect((await exported()).resultId).toBe(second.resultId);
    expect(errors).toEqual([]);
    await info.attach('repository-identities', { body: JSON.stringify({ backend, first, second }), contentType: 'application/json' });
  } finally { await server.close(); }
});

test('restriction gel honors imported circular topology, overlapping sites and combined cuts', async ({ page, baseURL }, info) => {
  const { pageErrors, consoleErrors, finalize } = setupTestHarness(page, info);
  const inputs = [
    { name: 'Origin digest', sequence: 'AATTCAAAAG', topology: 'circular' },
    { name: 'Overlap digest', sequence: 'GCGGCCGCGGCCGC', topology: 'linear' },
    { name: 'Combined digest', sequence: 'GAATTCGATCGATC', topology: 'linear' },
    { name: 'Ambiguous digest', sequence: 'GGACCTTTTGGTCCAAAA', topology: 'linear' },
  ];
  try {
    await catalog(page, baseURL!);
    for (const input of inputs) {
      await page.keyboard.press('Control+k');
      const palette = page.getByTestId('overlay-commandPalette');
      await palette.getByRole('combobox').fill('Local genomes: import or export');
      await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
      const importer = page.getByTestId('overlay-genomeImport');
      await importer.getByLabel('Paste genome data').fill(`>${input.name} [topology=${input.topology}]\n${input.sequence}\n`);
      await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
      await importer.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
      await expect(page.getByTestId('phage-list-item-selected')).toContainText(input.name);
      await page.keyboard.press('Alt+g');
      const gel = page.getByTestId('overlay-gel');
      await expect(gel.getByLabel('Molecule topology:')).toHaveValue(input.topology);
      // Explicitly select each experiment; enzyme selections persist between genomes.
      for (const button of await gel.getByRole('button', { pressed: true }).all()) await button.click();
      const sizes = gel.getByRole('region', { name: 'Digest fragment sizes' });
      if (input.name === 'Origin digest') { // ubs:ignore — public experiment name, not a cryptographic digest or secret.
        await gel.getByRole('button', { name: 'EcoRI (1)', exact: true }).click();
        await expect(gel).toContainText('1 cut → 1 fragment');
        await expect(sizes).toContainText('10 bp');
        await gel.getByLabel('Molecule topology:').selectOption('linear');
        await expect(gel.getByRole('button', { name: 'EcoRI (0)', exact: true })).toBeVisible();
        await expect(gel).toContainText('0 cuts → 1 fragment');
        await gel.getByLabel('Molecule topology:').selectOption('circular');
        await expect(gel).toContainText('1 cut → 1 fragment');
      } else if (input.name === 'Overlap digest') { // ubs:ignore — public experiment name, not a cryptographic digest or secret.
        await gel.getByRole('button', { name: 'NotI (2)', exact: true }).click();
        await expect(gel).toContainText('2 cuts → 3 fragments');
        await expect(sizes.locator('span')).toHaveText(['6 bp', '6 bp', '2 bp']);
      } else if (input.name === 'Combined digest') { // ubs:ignore — public experiment name, not a cryptographic digest or secret.
        await gel.getByRole('button', { name: 'EcoRI (1)', exact: true }).click();
        await gel.getByRole('button', { name: 'MboI (2)', exact: true }).click();
        await expect(gel).toContainText('3 cuts → 4 fragments');
        await expect(sizes.locator('span')).toHaveText(['5 bp', '4 bp', '4 bp', '1 bp']);
      } else {
        await gel.getByRole('button', { name: 'AvaII (2)', exact: true }).click();
        await expect(sizes.locator('span')).toHaveText(['9 bp', '8 bp', '1 bp']);
      }
      await expect(gel.getByRole('img', { name: 'Virtual gel electrophoresis visualization' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await info.attach('restriction-inputs', { body: JSON.stringify(inputs.map(input => ({ ...input, sha256: createHash('sha256').update(input.sequence).digest('hex') }))), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally { await finalize(); }
});

for (const backend of ['wasm', 'javascript'] as const) test(`repeat coordinates and coverage survive the ${backend} backend`, async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let workerUrl = '';
  page.on('request', request => {
    if (/\/assets\/analysis\.worker-[^/]+\.js$/.test(request.url())) workerUrl = request.url();
  });
  if (backend === 'javascript') await page.route(/\/assets\/analysis\.worker-[^/]+\.js$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `WebAssembly.instantiate = async () => { throw new Error('Controlled WASM failure'); };\n${await response.text()}` });
  });
  const inputs = [
    { name: 'Odd spacer', sequence: 'ACGTANNNTACGT' },
    { name: 'Tandem copies', sequence: 'ACGAACGAACGA' },
    { name: 'Unresolved control', sequence: 'NNNNNNNNNNNN' },
  ];
  try {
    await catalog(page, baseURL!);
    for (const input of inputs) {
      await page.keyboard.press('Control+k');
      const palette = page.getByTestId('overlay-commandPalette');
      await palette.getByRole('combobox').fill('Local genomes: import or export');
      await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
      const importer = page.getByTestId('overlay-genomeImport');
      await importer.getByLabel('Paste genome data').fill(`>${input.name}\n${input.sequence}\n`);
      await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
      await importer.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
      await expect(page.getByTestId('phage-list-item-selected')).toContainText(input.name);
      await page.keyboard.press('r');
      const overlay = page.getByTestId('overlay-repeats');
      const table = overlay.getByRole('table', { name: 'Repeat matches' });
      await expect(table).toBeVisible();
      await expect(overlay).toContainText('1-based arm starts');
      if (input.name === 'Odd spacer') { // ubs:ignore — public experiment label, not an authentication comparison.
        const row = table.getByRole('row').filter({ hasText: 'Arms: 5 bp; spacer: 3 bp' });
        await expect(row).toContainText('Inverted');
        await expect(row.getByRole('cell').nth(1)).toHaveText('1 ↔ 9');
        await expect(row.getByRole('cell').nth(2)).toContainText(input.sequence);
        await expect(row.getByRole('cell').nth(3)).toHaveText('13 bp');
      } else if (input.name === 'Tandem copies') { // ubs:ignore — public experiment label, not an authentication comparison.
        const row = table.getByRole('row').filter({ hasText: '3 copies of 4 bp' });
        await expect(row).toContainText('Tandem');
        await expect(row.getByRole('cell').nth(1)).toHaveText('1 ↔ 5');
        await expect(row.getByRole('cell').nth(3)).toHaveText('12 bp');
      } else {
        await expect(table).toContainText('No repeats found within these search limits');
      }
      const downloading = page.waitForEvent('download');
      await overlay.getByRole('button', { name: 'Export repeat experiment', exact: true }).click();
      const download = await downloading;
      const record = await parseAnalysisRecord(await readFile((await download.path())!, 'utf8'));
      expect(record.method).toMatchObject({ id: 'sequence-repeats', version: '2' });
      expect(record.method.implementation).toMatch(backend === 'javascript' ? /JS pair scan; js detailed/ : /JS pair scan; wasm-(baseline|simd) detailed/);
      expect(record.inputs[0].data).toBe(input.sequence);
      expect(record.inputs[0].source).toBe('local');
      expect(record.fields.search.value).toMatchObject({ step: 1, minLength: 8, maxGap: 5000, palindromeMaxGap: 50, maxPerDetail: 10 });
      if (input.name === 'Odd spacer') { // ubs:ignore — public experiment label, not an authentication comparison.
        expect(record.fields.repeats.value).toContainEqual({ type: 'inverted', position1: 0, position2: 8, sequence: input.sequence, length: 13, armLength: 5, gap: 3 });
      }
      await page.keyboard.press('Escape');
    }
    expect(workerUrl).not.toBe('');
    const observed = await page.evaluate(async url => {
      const worker = new Worker(url, { type: 'module' });
      let serial = 0;
      const call = (request: unknown) => new Promise<any>((resolve, reject) => {
        const id = `repeat-oracle-${serial++}`;
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = event => {
          if (event.data.id !== id) return;
          if (event.data.type !== 'RAW') reject(new Error(JSON.stringify(event.data)));
          else resolve(event.data.value);
        };
        worker.postMessage({ id, type: 'APPLY', path: ['runAnalysis'], argumentList: [{ type: 'RAW', value: request }] });
      });
      try {
        const adjacent = await call({ type: 'repeats', sequence: 'ACGAACGA', options: { minLength: 4, maxGap: 0 } });
        const lastPartner = await call({ type: 'repeats', sequence: 'ACGACACGA', options: { minLength: 4, maxGap: 1 } });
        const invalid = [];
        for (const minLength of [0, -1, 1.5]) {
          try { await call({ type: 'repeats', sequence: 'ACGT', options: { minLength } }); invalid.push('accepted'); }
          catch (error) { invalid.push(String(error)); }
        }
        return { adjacent, lastPartner, invalid };
      } finally { worker.terminate(); }
    }, workerUrl);
    expect(observed.adjacent.engine).toMatch(backend === 'javascript' ? /^js$/ : /^wasm-(simd|baseline)$/);
    expect(observed.adjacent.search).toMatchObject({ step: 1, maxGap: 0, palindromeMaxGap: 0, detailedScan: true, maxResults: 50 });
    expect(observed.adjacent.repeats.filter((hit: any) => hit.type === 'direct')).toEqual([{ type: 'direct', position1: 0, position2: 4, sequence: 'ACGA', length: 4 }]);
    expect(observed.lastPartner.repeats.filter((hit: any) => hit.type === 'direct')).toEqual([{ type: 'direct', position1: 0, position2: 5, sequence: 'ACGA', length: 4 }]);
    expect(observed.invalid.every((error: string) => error !== 'accepted')).toBe(true);
    await info.attach('repeat-oracles', { body: JSON.stringify({ inputs, backend, observed }), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

for (const backend of ['wasm', 'javascript'] as const) test(`sequence workers preserve ambiguity boundaries under ${backend}`, async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let workerUrl = '';
  page.on('request', request => {
    if (/\/assets\/analysis\.worker-[^/]+\.js$/.test(request.url())) workerUrl = request.url();
  });
  if (backend === 'javascript') await page.route(/\/assets\/analysis\.worker-[^/]+\.js$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `WebAssembly.instantiate = async () => { throw new Error('Controlled WASM failure'); }; Object.defineProperty(navigator, 'gpu', { value: undefined });\n${await response.text()}` });
  });
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('g');
    await expect(page.getByRole('button', { name: 'Export GC skew experiment' })).toBeVisible();
    expect(workerUrl).not.toBe('');
    const observed = await page.evaluate(async url => {
      const worker = new Worker(url, { type: 'module' });
      let serial = 0;
      const call = (path: string, request: unknown) => new Promise<any>((resolve, reject) => {
        const id = `sequence-oracle-${serial++}`;
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = event => {
          if (event.data.id !== id) return;
          if (event.data.type !== 'RAW') reject(new Error(JSON.stringify(event.data)));
          else resolve(event.data.value);
        };
        worker.postMessage({ id, type: 'APPLY', path: [path], argumentList: [{ type: 'RAW', value: request }] });
      });
      const cases = [
        { type: 'kmer-spectrum', sequence: 'AANNAA', options: { kmerSize: 2 } },
        { type: 'kmer-spectrum', sequence: 'acnta', options: { kmerSize: 2 } },
        { type: 'kmer-spectrum', sequence: 'AAAAAA', options: {} },
        { type: 'kmer-spectrum', sequence: '', options: { kmerSize: 2 } },
        { type: 'kmer-spectrum', sequence: 'A', options: { kmerSize: 2 } },
        { type: 'kmer-spectrum', sequence: 'NNNN', options: { kmerSize: 2 } },
        { type: 'kmer-spectrum', sequence: 'A'.repeat(13) + 'N' + 'A'.repeat(13), options: { kmerSize: 13 } },
        { type: 'codon-usage', sequence: 'atgnccaaa', options: {} },
        { type: 'codon-usage', sequence: 'ATGNNNAAAGGG', options: {} },
        { type: 'codon-usage', sequence: 'NNNN', options: {} },
        { type: 'codon-usage', sequence: 'AT', options: {} },
        { type: 'complexity', sequence: 'ACGUACGU', options: { windowSize: 4 } },
      ];
      try {
        const probe = await call('runAnalysis', { type: 'gc-skew', sequence: 'GGGGCCCC', options: { windowSize: 4 } });
        const transports = ['string', 'ascii', 'acgt05'];
        if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) transports.push('shared-ascii');
        const results = [];
        for (const transport of transports) {
          for (const [index, fixture] of cases.entries()) {
            let request: any = fixture;
            if (transport !== 'string') {
              const encoded = transport === 'acgt05'
                ? Uint8Array.from(fixture.sequence.toUpperCase(), base => ({ A: 0, C: 1, G: 2, T: 3, U: 3 }[base] ?? 4))
                : new TextEncoder().encode(fixture.sequence);
              // Padding detects callers that accidentally ignore the view bounds.
              const buffer = transport === 'shared-ascii' ? new SharedArrayBuffer(encoded.length + 4) : new ArrayBuffer(encoded.length + 4);
              new Uint8Array(buffer).fill(65);
              new Uint8Array(buffer, 2, encoded.length).set(encoded);
              request = { type: fixture.type, options: fixture.options, sequenceRef: {
                buffer, byteOffset: 2, byteLength: encoded.length, length: encoded.length,
                encoding: transport === 'acgt05' ? 'acgt05' : 'ascii', isShared: transport === 'shared-ascii', phageId: -1,
              } };
            }
            results.push({ transport, index, result: await call(transport === 'string' ? 'runAnalysis' : 'runAnalysisShared', request) });
          }
        }
        const invalid = [];
        for (const kmerSize of [0, -1, 1.5]) {
          try { await call('runAnalysis', { type: 'kmer-spectrum', sequence: 'ACGT', options: { kmerSize } }); invalid.push('accepted'); }
          catch (error) { invalid.push(String(error)); }
        }
        return { probe, results, invalid, transports };
      } finally { worker.terminate(); }
    }, workerUrl);
    expect(observed.probe.engine).toMatch(backend === 'javascript' ? /^js$/ : /^wasm-(simd|baseline)$/);
    for (const { index, result } of observed.results) {
      if (index <= 6) {
        const expected = [
          { kmerSize: 2, totalKmers: 2, uniqueKmers: 1, counts: { AA: 2 } },
          { kmerSize: 2, totalKmers: 2, uniqueKmers: 2, counts: { AC: 1, TA: 1 } },
          { kmerSize: 6, totalKmers: 1, uniqueKmers: 1, counts: { AAAAAA: 1 } },
          { kmerSize: 2, totalKmers: 0, uniqueKmers: 0, counts: {} },
          { kmerSize: 2, totalKmers: 0, uniqueKmers: 0, counts: {} },
          { kmerSize: 2, totalKmers: 0, uniqueKmers: 0, counts: {} },
          { kmerSize: 13, totalKmers: 2, uniqueKmers: 1, counts: { AAAAAAAAAAAAA: 2 } },
        ][index];
        expect(result).toMatchObject({ kmerSize: expected.kmerSize, totalKmers: expected.totalKmers, uniqueKmers: expected.uniqueKmers });
        expect(Object.fromEntries(result.spectrum.map((row: any) => [row.kmer, row.count]))).toEqual(expected.counts);
        for (const row of result.spectrum) expect(row.frequency).toBe(row.count / expected.totalKmers);
      } else if (index <= 10) {
        expect(result.usage).toEqual([{ ATG: 1, AAA: 1 }, { ATG: 1, AAA: 1, GGG: 1 }, {}, {}][index - 7]);
        if (index >= 9) expect(Object.values(result.rscu).every(value => value === 0)).toBe(true);
      } else {
        expect(result.entropy).toEqual([1, 1]);
      }
    }
    for (const error of observed.invalid) expect(error).toContain('positive integer');
    await info.attach(`sequence-worker-oracles-${backend}`, { body: JSON.stringify(observed), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('codon lens consumes joined private CDS and replaces exports when the genome changes', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const externalRequests: string[] = [];
  try {
    await catalog(page, baseURL!);
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) externalRequests.push(request.url());
    });
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('overlay-commandPalette');
    await palette.getByRole('combobox').fill('Local genomes: import or export');
    await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
    const importer = page.getByTestId('overlay-genomeImport');
    const sequence = 'ATGAAACCCCCCGGGTTT';
    const genbank = (name: string, dna: string, features: boolean) => `LOCUS       ${name} 18 bp DNA circular\nFEATURES             Location/Qualifiers\n${features ? '     CDS             join(1..6,13..18)\n                     /gene="forward"\n     CDS             complement(join(1..6,13..18))\n                     /gene="reverse"\n     CDS             join(1..6,13..18)\n                     /gene="offset"\n                     /codon_start=2\n' : ''}ORIGIN\n        1 ${dna.toLowerCase()}\n//\n`;
    await importer.getByRole('textbox', { name: 'Paste genome data' }).fill(genbank('JOINED_ORACLE', sequence, true) + genbank('CHANGED_ORACLE', 'CTG'.repeat(6), true) + genbank('NO_CDS_ORACLE', sequence, false));
    await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
    await importer.getByRole('button', { name: 'Add records to explorer' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('JOINED_ORACLE');
    await page.keyboard.press('Alt+t');
    const overlay = page.getByTestId('overlay-codonAdaptation');
    await overlay.getByRole('button', { name: 'Codon-Pair Adaptation Lens' }).click();
    const download = async () => {
      const pending = page.waitForEvent('download');
      await overlay.getByRole('button', { name: 'Export codon adaptation experiment' }).click();
      const stream = await (await pending).createReadStream();
      if (!stream) throw new Error('No codon experiment download');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return parseAnalysisRecord(Buffer.concat(chunks).toString());
    };
    const original = await download();
    expect(original.inputs[0]).toMatchObject({ source: 'local', data: sequence, accession: 'JOINED_ORACLE' });
    expect(original.fields.codingSequences.value).toEqual([
      expect.objectContaining({ sequence: 'ATGAAAGGGTTT', codonCount: 4 }),
      expect.objectContaining({ sequence: 'AAACCCTTTCAT', codonCount: 4 }),
      expect.objectContaining({ sequence: 'TGAAAGGGTTT', codonCount: 2 }),
    ]);
    expect(original.fields.geneScores.kind).toBe('demo');
    expect(original.inputs[2].source).toBe('demo');
    await expect(overlay.getByRole('note')).toContainText('illustrative host model');
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: 'CHANGED_ORACLE' }).click();
    await page.keyboard.press('Alt+t');
    await overlay.getByRole('button', { name: 'Codon-Pair Adaptation Lens' }).click();
    const changed = await download();
    expect(changed.inputs[0].accession).toBe('CHANGED_ORACLE');
    expect(changed.inputs[0].data).toBe('CTG'.repeat(6));
    expect(changed.cacheKey).not.toBe(original.cacheKey);
    expect(changed.fields.geneScores.value).not.toEqual(original.fields.geneScores.value);
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: 'NO_CDS_ORACLE' }).click();
    await page.keyboard.press('Alt+t');
    await overlay.getByRole('button', { name: 'Codon-Pair Adaptation Lens' }).click();
    const missing = await download();
    expect(missing.inputs[0].accession).toBe('NO_CDS_ORACLE');
    expect(missing.fields.hostRankings).toMatchObject({ kind: 'unavailable', value: null });
    expect(missing.fields.codingSequences.value).toEqual([]);
    await expect(overlay).toContainText('No host scores were inferred.');
    await info.attach('codon-experiments', { body: JSON.stringify({ original, changed, missing }), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally { await finalize(); }
});

for (const backend of ['wasm', 'javascript'] as const) test(`GC skew experiment preserves actual worker counts and source under ${backend}`, async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let disabledWasmWorkers = 0;
  let workerUrl = '';
  page.on('request', request => {
    if (/\/assets\/analysis\.worker-[^/]+\.js$/.test(request.url())) workerUrl = request.url();
  });
  if (backend === 'javascript') {
    await page.route(/\/assets\/analysis\.worker-[^/]+\.js$/, async route => {
      const response = await route.fetch();
      const body = await response.text();
      disabledWasmWorkers++;
      await route.fulfill({ response, body: `WebAssembly.instantiate = async () => { throw new Error('Controlled worker WASM initialization failure'); };\n${body}` });
    });
  }
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('overlay-commandPalette');
    await palette.getByRole('combobox').fill('Local genomes: import or export');
    await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
    const importer = page.getByTestId('overlay-genomeImport');
    const sequence = 'G'.repeat(500) + 'C'.repeat(500) + 'ATN'.repeat(100);
    await importer.getByRole('textbox', { name: 'Paste genome data' }).fill(`>GC_PREFIX_ORACLE\n${sequence}\n>NO_GC_ORACLE\n${'ATN'.repeat(300)}\n`);
    await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
    await importer.getByRole('button', { name: 'Add records to explorer' }).click();
    await page.keyboard.press('Escape');
    // Import selects the first record; it already has the selected test ID.
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('GC_PREFIX_ORACLE');
    await page.keyboard.press('g');
    const overlay = page.getByTestId('overlay-gcSkew');
    const download = async () => {
      const pending = page.waitForEvent('download');
      await overlay.getByRole('button', { name: 'Export GC skew experiment' }).click();
      const stream = await (await pending).createReadStream();
      if (!stream) throw new Error('No GC experiment download');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return parseAnalysisRecord(Buffer.concat(chunks).toString('utf8'));
    };
    const record = await download();
    expect(record.inputs[0].source).toBe('local');
    expect(record.inputs[0].accession).toBe('GC_PREFIX_ORACLE');
    expect(record.inputs[0].data).toBe(sequence);
    expect(record.inputs[0].sha256).toBe(createHash('sha256').update(JSON.stringify(sequence)).digest('hex'));
    expect(record.parameters).toMatchObject({ windowSize: 500, stepSize: 125 });
    // Independent hand-derived prefixes at 0,125,...,750 (inclusive).
    // First 500 bases add G; the next 500 subtract C.
    expect(record.fields.cumulative.value).toEqual([1, 126, 251, 376, 499, 374, 249]);
    expect(record.fields.skew.value).toEqual([1, 0.5, 0, -0.5, -1, -1, -1]);
    expect(record.fields.cumulative.units).toBe('count');
    expect(record.fields.originPosition.value).toBe(0);
    expect(record.fields.terminusPosition.value).toBe(500);
    // The maximum prefix is 499 at 500 bp, so its marker belongs at the
    // top of the plotted curve (10 CSS px), not a stretched sample index.
    const marker = await overlay.getByRole('img', { name: 'GC skew graph showing cumulative nucleotide bias across genome position' }).evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const dpr = canvas.width / canvas.clientWidth;
      const actual = Array.from(canvas.getContext('2d')!.getImageData(Math.round(canvas.clientWidth * 500 / 1300 * dpr), Math.round(10 * dpr), 1, 1).data);
      const colorProbe = document.createElement('canvas');
      const context = colorProbe.getContext('2d')!;
      context.fillStyle = getComputedStyle(canvas).getPropertyValue('--color-success').trim();
      context.fillRect(0, 0, 1, 1);
      return { actual, expected: Array.from(context.getImageData(0, 0, 1, 1).data) };
    });
    expect(marker.actual).toEqual(marker.expected);
    expect(record.method.implementation).toMatch(backend === 'javascript' ? /^js$/ : /^wasm-(simd|baseline)$/);
    if (backend === 'javascript') expect(disabledWasmWorkers).toBeGreaterThan(0);
    // Exercise the other production entry point too. This is Comlink 4's
    // wire shape read from the installed runtime, not a test solver.
    expect(workerUrl).not.toBe('');
    const direct = await page.evaluate(async ({ url, sequence }) => {
      const worker = new Worker(url, { type: 'module' });
      try {
        return await new Promise<any>((resolve, reject) => {
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessage = event => {
            if (event.data.id !== 'gc-string-oracle') return;
            if (event.data.type !== 'RAW') reject(new Error(JSON.stringify(event.data)));
            else resolve(event.data.value);
          };
          worker.postMessage({ id: 'gc-string-oracle', type: 'APPLY', path: ['runAnalysis'], argumentList: [{ type: 'RAW', value: {
            type: 'gc-skew', sequence: sequence.toLowerCase(), options: { windowSize: 500 },
            evidenceContext: { accession: 'GC_PREFIX_ORACLE', source: 'local' },
          } }] });
        });
      } finally { worker.terminate(); }
    }, { url: workerUrl, sequence });
    const stringRecord = await parseAnalysisRecord(JSON.stringify(direct.evidenceRecord));
    expect(stringRecord.inputs[0].data).toBe(sequence.toLowerCase());
    expect(stringRecord.parameters.route).toBe('string');
    expect(stringRecord.fields).toEqual(record.fields);
    expect(stringRecord.method.implementation).toBe(record.method.implementation);
    await overlay.getByText('Experiment inputs and evidence', { exact: true }).click();
    await expect(overlay.getByLabel('Analysis evidence and inputs')).toContainText(record.cacheKey);
    await info.attach(`gc-prefix-${backend}`, { body: JSON.stringify(record), contentType: 'application/json' });

    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: 'NO_GC_ORACLE' }).click();
    await page.keyboard.press('g');
    await expect(overlay).toContainText('GC skew is undefined');
    const missing = await download();
    expect(missing.inputs[0].accession).toBe('NO_GC_ORACLE');
    expect(missing.cacheKey).not.toBe(record.cacheKey);
    expect(missing.fields.originPosition).toMatchObject({ kind: 'unavailable', value: null });
    expect(missing.fields.skew).toMatchObject({ kind: 'unavailable', value: null });
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test.use({ userAgent: 'OpenAI File Downloader, XaiImageApiFetch/1.0' });

async function catalog(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
  });
  await page.goto('/?phage=lambda&model=0');
  expect(new URL(page.url()).origin).toBe(new URL(baseURL).origin);
  const manifest = JSON.parse(await readFile(new URL('../public/phage.db.manifest.json', import.meta.url), 'utf8'));
  expect(await (await page.request.get('/phage.db.manifest.json')).json()).toMatchObject({ contentVersion: manifest.contentVersion, sha256: manifest.sha256 });
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
  await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
}

async function exportSequence(page: Page, overlay: Locator) {
  const downloading = page.waitForEvent('download');
  await overlay.getByRole('button', { name: 'Export sequence analysis' }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('real deposited protein survives precomputed tropism, demo opt-in, export and cached reload', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('0');
    const overlay = page.getByTestId('overlay-tropism');
    await overlay.getByRole('button', { name: /Sequence descriptors/ }).click();
    await expect(overlay.getByRole('region', { name: 'Real protein sequence descriptors' })).toContainText('MTNALAGKQPKNATLTALAGLSTAKNKLPYFA');
    const real = await exportSequence(page, overlay);
    expect(real.phageId).toBe(1);
    expect(real.source).toBe('precomputed');
    expect(real.sequenceSource).toBe('deposited_translation');
    expect(real.sequenceAnalysis.geneId).toBe(54);
    expect(real.sequenceAnalysis.sequence).toHaveLength(314);
    // Independently extracted from the shipped GenBank translation NP_040604.1.
    expect(createHash('sha256').update(real.sequenceAnalysis.sequence).digest('hex')).toBe('49762dfae5f67b7dc8d063930fb6632559d0e61eb829598dfa258dfb4a274479');
    expect(real.structuralAnalysis).toBeNull();
    expect(JSON.stringify(real)).not.toMatch(/ddgAlaScan|affinityScore|chimeraSuggestions/);
    await expect(overlay.getByRole('columnheader', { name: 'Affinity Score', exact: true })).toHaveCount(0);
    await info.attach('real-protein-export', { body: JSON.stringify(real), contentType: 'application/json' });
    await info.attach('real-protein-panel', { body: await overlay.screenshot(), contentType: 'image/png' });

    await overlay.getByRole('checkbox', { name: 'Show illustrative structural model' }).check();
    await expect(overlay.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('synthetic model outputs');
    const demo = await exportSequence(page, overlay);
    expect(demo.mode).toBe('demonstration');
    expect(demo.structuralAnalysis.source).toBe('demonstration');
    expect(demo.structuralAnalysis.assumptions).toContain('not predictions');
    expect(demo.sequenceAnalysis.sequence).toBe(real.sequenceAnalysis.sequence);
    await info.attach('explicit-demonstration-export', { body: JSON.stringify(demo), contentType: 'application/json' });
    await overlay.getByRole('checkbox', { name: 'Show illustrative structural model' }).uncheck();
    expect((await exportSequence(page, overlay)).structuralAnalysis).toBeNull();
    await page.reload();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('lambda');
    await page.keyboard.press('0');
    await expect(overlay.getByRole('checkbox', { name: 'Show illustrative structural model' })).not.toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('0');
    await expect(overlay.getByRole('checkbox', { name: 'Show illustrative structural model' })).not.toBeChecked();
    await overlay.getByRole('button', { name: /Sequence descriptors/ }).click();
    await expect(overlay.getByRole('button', { name: 'Export sequence analysis' })).toBeVisible();
    const switched = await exportSequence(page, overlay);
    expect(switched.phageName).toContain('T7');
    expect(switched.phageId).not.toBe(real.phageId);
    expect(switched.structuralAnalysis).toBeNull();
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('pangenome and host panels require opt-in and reset it on a phage change', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('Shift+p');
    const graph = page.getByTestId('overlay-pangenomeGraph');
    await expect(graph).toContainText('Comparative sequence evidence has not been supplied');
    await expect(graph.getByText("Heaps' Law Openness (α)", { exact: true })).toHaveCount(0);
    await graph.getByRole('button', { name: 'Show illustrative pangenome' }).click();
    await expect(graph.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('invented companion variations');
    await expect(graph).toContainText('DEMONSTRATION');
    await graph.getByRole('button', { name: 'Return to available data' }).click();
    await expect(graph.getByText("Heaps' Law Openness (α)", { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Alt+i');
    const host = page.getByTestId('overlay-hostInteractions');
    await expect(host).toContainText('cannot establish these quantities');
    await host.getByRole('button', { name: 'Show illustrative interaction model' }).click();
    await expect(host.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('deterministic pseudo-vectors');
    await expect(host).toContainText('DEMONSTRATION');
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('Alt+i');
    await expect(host.getByRole('button', { name: 'Show illustrative interaction model' })).toBeVisible();
    await expect(host.getByRole('note', { name: 'Demonstration assumptions' })).toHaveCount(0);
    await info.attach('ordinary-host-panel-after-switch', { body: await host.screenshot(), contentType: 'image/png' });
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('growth-curve illustration is explicit and never labels invented bands as uncertainty', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('Shift+s');
    await page.getByTestId('overlay-simulationHub').getByText('Burst Kinetics Simulator', { exact: true }).click();
    const simulation = page.getByTestId('overlay-simulationView');
    await expect(simulation.getByRole('img', { name: 'Infection kinetics chart', exact: true })).toBeVisible();
    await expect(simulation.getByRole('note', { name: 'Demonstration assumptions' })).toHaveCount(0);
    await simulation.getByRole('button', { name: 'Show illustrative growth-curve fitting' }).click();
    await expect(simulation.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('Hand-entered example growth curves');
    await expect(simulation.getByRole('img', { name: 'Demonstration growth curve and sigmoid fit' })).toBeVisible();
    await expect(simulation).toContainText('Not identifiable from these observations');
    await expect(simulation).not.toContainText('95% CI');
    await expect(simulation).not.toContainText('Fitted DDE');
    await info.attach('explicit-growth-curve-illustration', { body: await simulation.screenshot(), contentType: 'image/png' });
    await simulation.getByRole('button', { name: 'Forward Infection Dynamics (SIR)' }).click();
    await expect(simulation.getByRole('img', { name: 'Infection kinetics chart', exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('failed dated-sequence retrieval does not silently become a synthetic phage result', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    let abortedRequests = 0;
    await page.route(url => url.hostname === 'ncbi.nlm.nih.gov' || url.hostname.endsWith('.ncbi.nlm.nih.gov'), route => {
      abortedRequests += 1;
      return route.abort();
    });
    await page.keyboard.press('Control+Shift+y');
    const overlay = page.getByTestId('overlay-phylodynamics');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    expect(abortedRequests).toBeGreaterThan(0);
    await info.attach('failed-real-retrieval', { body: await overlay.screenshot(), contentType: 'image/png' });
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    await overlay.getByRole('button', { name: 'Show synthetic phylodynamics illustration' }).click();
    await expect(overlay).toContainText('15 synthetic 300-base sequences');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toBeVisible();
    await expect(overlay).toContainText('Equal-length raw genomes are insufficient');
    await overlay.getByRole('button', { name: 'Search real dated sequences' }).click();
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('closing a pending real search prevents its late failure from replacing a new phage illustration', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let releaseFirst: (() => void) | undefined;
  const released = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstRequestSeen = false;
  let firstRequestFinished = false;
  let firstRequestUrl = '';
  try {
    await catalog(page, baseURL!);
    await page.route(url => url.hostname === 'ncbi.nlm.nih.gov' || url.hostname.endsWith('.ncbi.nlm.nih.gov'), async route => {
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        firstRequestUrl = route.request().url();
        await released;
        await route.abort();
        firstRequestFinished = true;
      } else {
        await route.abort();
      }
    });
    await page.keyboard.press('Control+Shift+y');
    const overlay = page.getByTestId('overlay-phylodynamics');
    await expect.poll(() => firstRequestSeen).toBe(true);
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('Control+Shift+y');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await overlay.getByRole('button', { name: 'Show synthetic phylodynamics illustration' }).click();
    await expect(overlay).toContainText('These are not samples of Enterobacteria phage T7');
    const lateFailure = page.waitForEvent('requestfailed', request => request.url() === firstRequestUrl);
    releaseFirst?.();
    await lateFailure;
    await expect.poll(() => firstRequestFinished).toBe(true);
    // Exercise the current result after the old request actually failed.
    await overlay.getByRole('button', { name: /Clock/ }).click();
    await overlay.getByRole('button', { name: /Tree/ }).click();
    await expect(overlay).toContainText('15 synthetic 300-base sequences');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toBeVisible();
    await expect(overlay).not.toContainText('DATA UNAVAILABLE');
    await info.attach('new-phage-after-cancelled-response', { body: await overlay.screenshot(), contentType: 'image/png' });
    // Overlay closure unmounts its state: reopening must require fresh opt-in.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+y');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseFirst?.();
    await finalize();
  }
});
