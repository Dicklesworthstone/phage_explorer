import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';
import type { AnalysisRecord, SignatureNeighbor } from '@phage-explorer/core';

declare global {
  interface Window {
    pcaIdentityFixture: {
      select: (name: string) => void;
      holdLength: (name: string) => void;
      releaseLength: () => void;
      lengthPending: boolean;
      lengthReleased: boolean;
      sequenceReads: Record<string, number>;
      holdNextPca: () => void;
      releasePca: () => void;
      pcaPending: boolean;
      pcaReleased: boolean;
      heldPcaAborted: () => boolean;
      submittedVectors: number;
      gcFractions: (sequences: string[]) => Promise<number[]>;
    };
  }
}

// Real repositories, React component and analysis workers; only read/result
// completion is delayed so replacement races are deterministic.
for (const backend of ['wasm', 'javascript'] as const) test(`PCA binds vectors, metadata and pending work to the selected repository (${backend})`, async ({ page }, info) => {
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/pca-identity-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load PCA fixture configuration');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'pca-identity-fixture',
      resolveId(id) { if (id === '/src/pca-identity-fixture.tsx' || id === fixtureId) return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { GenomicSignaturePCAOverlay } from './components/overlays/GenomicSignaturePCAOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import { getOrchestrator } from './workers/ComputeOrchestrator';
          import './styles/index.css';
          let select = () => {};
          let heldRepository = null, lengthGate = null, releaseLength = () => {};
          let nextPcaGate = null, releasePca = () => {}, heldPcaSignal = null;
          window.pcaIdentityFixture = {
            select: name => select(name),
            lengthPending: false, lengthReleased: false, sequenceReads: {},
            pcaPending: false, pcaReleased: false, submittedVectors: 0,
            holdLength(name) {
              heldRepository = name;
              this.lengthPending = false;
              this.lengthReleased = false;
              lengthGate = new Promise(resolve => { releaseLength = resolve; });
            },
            releaseLength() { heldRepository = null; releaseLength(); },
            holdNextPca() {
              this.pcaPending = false;
              this.pcaReleased = false;
              nextPcaGate = new Promise(resolve => { releasePca = resolve; });
            },
            releasePca: () => releasePca(),
            heldPcaAborted: () => heldPcaSignal?.aborted === true,
          };
          async function makeRepository(name, sequences) {
            const imported = await importLocalGenomes({
              name: name + '.fasta',
              text: sequences.map((sequence, i) => '>' + name + '-' + (i + 1) + '\\n' + sequence).join('\\n'),
            });
            const genomes = imported.genomes.map((genome, i) => ({
              ...genome, phage: { ...genome.phage, id: -101 - i, name: 'Genome ' + (i + 1) },
            }));
            const repository = createLocalGenomeRepository(null, genomes);
            const readLength = repository.getFullGenomeLength.bind(repository);
            const readSequence = repository.getSequenceWindow.bind(repository);
            window.pcaIdentityFixture.sequenceReads[name] = 0;
            repository.getFullGenomeLength = async id => {
              if (heldRepository === name && id === -101) {
                const gate = lengthGate;
                window.pcaIdentityFixture.lengthPending = true;
                await gate;
                window.pcaIdentityFixture.lengthReleased = true;
              }
              return readLength(id);
            };
            repository.getSequenceWindow = (...args) => {
              window.pcaIdentityFixture.sequenceReads[name]++;
              return readSequence(...args);
            };
            return { repository, phage: genomes[0].phage };
          }
          const repositories = {
            a: await makeRepository('a', ['A'.repeat(160), 'C'.repeat(160), 'ACGT'.repeat(40)]),
            b: await makeRepository('b', ['G'.repeat(160), 'T'.repeat(160), 'ACGG'.repeat(40)]),
            c: await makeRepository('c', ['ATGC'.repeat(40), 'AC'.repeat(80), 'ACTG'.repeat(40)]),
            delayed: await makeRepository('delayed', ['AT'.repeat(80), 'CG'.repeat(80), 'ATCG'.repeat(40)]),
            missing: await makeRepository('missing', ['N'.repeat(160), 'A'.repeat(160), 'C'.repeat(160)]),
          };
          const orchestrator = getOrchestrator({ maxWorkers: 1 });
          window.pcaIdentityFixture.gcFractions = async sequences => {
            const fractions = [];
            for (const sequence of sequences) {
              const vector = await orchestrator.computeKmerVectorWithSharedBuffer(-501, 'GC oracle', sequence, { k: 3 });
              fractions.push(vector.gcContent);
            }
            return fractions;
          };
          const computeVector = orchestrator.computeKmerVectorWithSharedBuffer.bind(orchestrator);
          orchestrator.computeKmerVectorWithSharedBuffer = (...args) => {
            window.pcaIdentityFixture.submittedVectors++;
            return computeVector(...args);
          };
          const computePca = orchestrator.computeGenomicSignaturePca.bind(orchestrator);
          orchestrator.computeGenomicSignaturePca = async (...args) => {
            const gate = nextPcaGate;
            nextPcaGate = null;
            if (gate) heldPcaSignal = args[2];
            const result = await computePca(...args);
            if (gate) {
              window.pcaIdentityFixture.pcaPending = true;
              await gate;
              window.pcaIdentityFixture.pcaReleased = true;
            }
            return result;
          };
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => { select = setName; open('genomicSignaturePCA'); }, []);
            // Deliberately retain the same currentPhage object across databases.
            return <GenomicSignaturePCAOverlay currentPhage={repositories.a.phage} repository={repositories[name].repository} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/pca-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/pca-identity-fixture', '<div id="root"></div><script type="module" src="/src/pca-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Both cases use identical uncached worker loading. The second deliberately
  // fails WASM initialization and must preserve the same public result units.
  await page.route(/\/analysis\.worker\.ts\?/, async route => {
    if (backend === 'wasm') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, body: `WebAssembly.instantiate = async () => { throw new Error('Controlled WASM failure'); };\n${await response.text()}` });
  });
  try {
    await server.listen();
    await page.goto(`${server.resolvedUrls!.local[0]}pca-identity-fixture`);
    const overlay = page.getByTestId('overlay-genomicSignaturePCA');
    await expect(overlay).toContainText('GC: 0.0%');
    await expect(overlay).toContainText('Accession: a-1');
    expect(await page.evaluate(() => window.pcaIdentityFixture.sequenceReads.a)).toBe(3);
    const exportNeighbors = async (filename: string): Promise<AnalysisRecord> => {
      const nextDownload = page.waitForEvent('download');
      await overlay.getByRole('button', { name: 'Export signature neighbors JSON' }).click();
      const download = await nextDownload;
      expect(download.suggestedFilename()).toBe('genomic-signature-neighbors.json');
      const output = info.outputPath(filename);
      await download.saveAs(output);
      return JSON.parse(await readFile(output, 'utf8')) as AnalysisRecord;
    };
    const originalNeighbors = await exportNeighbors('neighbors-a.json');
    expect(originalNeighbors.parameters).toMatchObject({ k: 4, normalize: true, includeReverseComplement: true,
      selectedPhageId: -101, rankingSpace: 'full-kmer-frequencies', metric: 'euclidean' });
    const originalInput = originalNeighbors.inputs.find(input => input.id === '-101')!;
    expect(originalInput.accession).toBe('a-1');
    expect(originalInput.source).toBe('local');
    expect(originalInput.data).toMatchObject({ sequenceSha256: createHash('sha256').update('A'.repeat(160)).digest('hex') });
    const rows = originalNeighbors.inputs.map(input => input.data as { phageId: number; name: string; frequencies: number[] });
    const selected = rows.find(row => row.phageId === -101)!;
    // Independent direct arithmetic over the actual worker-produced full matrix.
    const expected = rows.filter(row => row.phageId !== -101).map(row => ({ phageId: row.phageId, name: row.name,
      distance: Math.sqrt(row.frequencies.reduce((sum, value, d) => sum + (value - selected.frequencies[d]) ** 2, 0)) }))
      .sort((a, b) => a.distance - b.distance || a.phageId - b.phageId);
    const neighbors = originalNeighbors.fields.neighbors.value as unknown as SignatureNeighbor[];
    expect(neighbors.map(n => n.phageId)).toEqual(expected.map(n => n.phageId));
    for (let i = 0; i < expected.length; i++) {
      expect(neighbors[i].featureDistance).toBeCloseTo(expected[i].distance, 12);
      await expect(overlay.getByRole('button', { name: /^Select neighbor / }).nth(i)).toHaveAttribute('aria-label', `Select neighbor ${expected[i].name}`);
      await expect(overlay.getByRole('button', { name: /^Select neighbor / }).nth(i)).toContainText(`full=${expected[i].distance.toFixed(4)}`);
    }
    await expect(overlay).toContainText('Nearest signatures (full 256 dimensions)');
    // Independently counted fractions, not comparison against another adapter.
    // DNA signatures exclude U and ambiguous characters from the denominator.
    expect(await page.evaluate(() => window.pcaIdentityFixture.gcFractions([
      'GGCC', 'AaTt', 'gCaTNNRY', 'GcUuRY', 'UUuu', 'nNrY', '',
    ]))).toEqual([1, 0, 0.5, 1, 0, 0, 0]);

    await page.evaluate(() => window.pcaIdentityFixture.select('b'));
    await expect(overlay).toContainText('Accession: b-1');
    await expect(overlay).toContainText('GC: 100.0%');
    expect(await page.evaluate(() => window.pcaIdentityFixture.sequenceReads.b)).toBe(3);
    // Analysis settings survive dataset changes, and fresh dimensionality is used.
    await overlay.getByRole('combobox', { name: 'k:', exact: true }).selectOption('3');
    await expect(overlay).toContainText('PC1 Top Loadings');
    await expect(overlay.getByRole('combobox', { name: 'k:', exact: true })).toHaveValue('3');
    const replacementNeighbors = await exportNeighbors('neighbors-b.json');
    expect(replacementNeighbors.parameters.k).toBe(3);
    const replacementInput = replacementNeighbors.inputs.find(input => input.id === '-101')!;
    expect(replacementInput.accession).toBe('b-1');
    expect(replacementInput.data).toMatchObject({ sequenceSha256: createHash('sha256').update('G'.repeat(160)).digest('hex') });
    expect(replacementInput.sha256).not.toBe(originalInput.sha256);
    expect(replacementNeighbors.resultId).not.toBe(originalNeighbors.resultId);

    const beforeAbandonedRead = await page.evaluate(() => window.pcaIdentityFixture.submittedVectors);
    await page.evaluate(() => {
      window.pcaIdentityFixture.holdLength('delayed');
      window.pcaIdentityFixture.select('delayed');
    });
    await expect.poll(() => page.evaluate(() => window.pcaIdentityFixture.lengthPending)).toBe(true);
    await expect(overlay).not.toContainText('GC: 100.0%');
    await page.evaluate(() => window.pcaIdentityFixture.select('b'));
    await expect(overlay).toContainText('GC: 100.0%');
    await expect(overlay.getByRole('combobox', { name: 'k:', exact: true })).toHaveValue('3');
    const afterReplacement = await page.evaluate(() => window.pcaIdentityFixture.submittedVectors);
    expect(afterReplacement).toBeGreaterThanOrEqual(beforeAbandonedRead);
    await page.evaluate(() => window.pcaIdentityFixture.releaseLength());
    await expect.poll(() => page.evaluate(() => window.pcaIdentityFixture.lengthReleased)).toBe(true);
    expect(await page.evaluate(() => window.pcaIdentityFixture.sequenceReads.delayed)).toBe(0);
    expect(await page.evaluate(() => window.pcaIdentityFixture.submittedVectors)).toBe(afterReplacement);

    await page.evaluate(() => {
      window.pcaIdentityFixture.holdNextPca();
      window.pcaIdentityFixture.select('c');
    });
    await expect.poll(() => page.evaluate(() => window.pcaIdentityFixture.pcaPending)).toBe(true);
    await page.evaluate(() => {
      window.pcaIdentityFixture.holdLength('b');
      window.pcaIdentityFixture.select('b');
    });
    await expect.poll(() => page.evaluate(() => window.pcaIdentityFixture.lengthPending)).toBe(true);
    expect(await page.evaluate(() => window.pcaIdentityFixture.heldPcaAborted())).toBe(true);
    await page.evaluate(() => window.pcaIdentityFixture.releasePca());
    await expect.poll(() => page.evaluate(() => window.pcaIdentityFixture.pcaReleased)).toBe(true);
    await expect(overlay).not.toContainText('GC: 50.0%');
    await expect(overlay).not.toContainText('Accession: c-1');
    await page.evaluate(() => window.pcaIdentityFixture.releaseLength());
    await expect(overlay).toContainText('GC: 100.0%');
    await expect(overlay).toContainText('Accession: b-1');
    await page.evaluate(() => window.pcaIdentityFixture.select('missing'));
    await expect(overlay).toContainText('Accession: missing-1');
    await expect(overlay).toContainText('The selected genome has no counted k-mers for these settings.');
    await expect(overlay.getByRole('button', { name: /^Select neighbor / })).toHaveCount(0);
    const missingNeighbors = await exportNeighbors('neighbors-missing.json');
    expect(missingNeighbors.fields.neighbors.kind).toBe('unavailable');
    expect(missingNeighbors.fields.neighbors.value).toBeNull();
    expect(missingNeighbors.fields.exclusions.value).toEqual([-101]);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
