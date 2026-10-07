import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

declare global {
  interface Window {
    geneAnalysisIdentityFixture: {
      select: (name: string) => void;
      hold: (name: string, stage: 'length' | 'genes') => void;
      release: () => void;
      pending: boolean;
      released: boolean;
      sequenceReads: Record<string, number>;
      geneReads: Record<string, number>;
    };
  }
}

async function openFixture(page: Page, info: TestInfo, overlayId: 'modules' | 'rnaStructure') {
  const root = process.cwd();
  const fixtureId = resolve(root, 'src/gene-analysis-identity-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load gene-analysis fixture configuration');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'gene-analysis-identity-fixture',
      resolveId(id) { if (id === '/src/gene-analysis-identity-fixture.tsx' || id === fixtureId) return fixtureId; },
      load(id) {
        if (id !== fixtureId) return;
        return `
          import React, { useEffect, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { importLocalGenomes } from '@phage-explorer/core';
          import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
          import { ModuleOverlay } from './components/overlays/ModuleOverlay';
          import { RNAStructureOverlay } from './components/overlays/RNAStructureOverlay';
          import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';
          import { ToastProvider } from './components/ui/Toast';
          import { ScrollProvider } from './providers';
          import './styles/index.css';
          let select = () => {};
          let heldName = null, heldStage = null, gate = null, release = () => {};
          window.geneAnalysisIdentityFixture = {
            select: name => flushSync(() => select(name)),
            pending: false, released: false, sequenceReads: {}, geneReads: {},
            hold(name, stage) {
              heldName = name; heldStage = stage;
              this.pending = false; this.released = false;
              gate = new Promise(resolve => { release = resolve; });
            },
            release() { heldName = null; release(); },
          };
          async function waitForRead(name, stage) {
            if (heldName !== name || heldStage !== stage) return;
            const pendingGate = gate;
            window.geneAnalysisIdentityFixture.pending = true;
            await pendingGate;
            window.geneAnalysisIdentityFixture.released = true;
          }
          function cds(location, name, locus, product, extra = '') {
            return '     CDS             ' + location + '\\n' +
              '                     /gene="' + name + '"\\n' +
              '                     /locus_tag="' + locus + '"\\n' +
              '                     /product="' + product + '"\\n' + extra;
          }
          async function makeRepository(name, sequence, features) {
            const imported = await importLocalGenomes({ name: name + '.gb', text:
              'LOCUS       ' + name + ' ' + sequence.length + ' bp DNA linear\\n' +
              'ACCESSION   ' + name + '\\nFEATURES             Location/Qualifiers\\n' +
              features + 'ORIGIN\\n        1 ' + sequence.toLowerCase() + '\\n//\\n',
            });
            const genome = imported.genomes[0];
            genome.phage = { ...genome.phage, id: -101, name: 'Shared genome' };
            const repository = createLocalGenomeRepository(null, [genome]);
            const readLength = repository.getFullGenomeLength.bind(repository);
            const readSequence = repository.getSequenceWindow.bind(repository);
            const readGenes = repository.getGenes.bind(repository);
            window.geneAnalysisIdentityFixture.sequenceReads[name] = 0;
            window.geneAnalysisIdentityFixture.geneReads[name] = 0;
            repository.getFullGenomeLength = async id => {
              await waitForRead(name, 'length');
              return readLength(id);
            };
            repository.getSequenceWindow = (...args) => {
              window.geneAnalysisIdentityFixture.sequenceReads[name]++;
              return readSequence(...args);
            };
            repository.getGenes = async id => {
              window.geneAnalysisIdentityFixture.geneReads[name]++;
              const genes = await readGenes(id);
              await waitForRead(name, 'genes');
              return genes;
            };
            return { repository, phage: genome.phage };
          }
          const bSequence = 'G'.repeat(160) + 'AGGAGG' + 'G'.repeat(734);
          const repositories = {
            a: await makeRepository('a', 'T'.repeat(900), cds('121..420', 'A capsid', 'shared-1', 'major capsid protein')),
            b: await makeRepository('b', bSequence,
              cds('181..540', 'B capsid', 'shared-1', 'major capsid protein') +
              cds('complement(601..780)', 'B portal', 'shared-2', 'portal protein')),
            c: await makeRepository('c', bSequence, cds('31..150', 'C capsid', 'shared-1', 'major capsid protein')),
            delayedLength: await makeRepository('delayedLength', 'AC'.repeat(450), cds('121..420', 'Delayed capsid', 'shared-1', 'major capsid protein')),
            delayedGenes: await makeRepository('delayedGenes', 'ATG'.repeat(300), cds('91..330', 'Late capsid', 'shared-1', 'major capsid protein')),
            empty: await makeRepository('empty', bSequence, ''),
            joined: await makeRepository('joined', 'G'.repeat(31) + 'A'.repeat(89) + 'G'.repeat(32) + 'T'.repeat(148),
              cds('complement(join(1..31,121..153))', 'Joined reverse', 'shared-1', 'major capsid protein', '                     /codon_start=2\\n')),
          };
          function Fixture() {
            const [name, setName] = useState('a');
            const { open } = useOverlay();
            useEffect(() => { select = setName; open('${overlayId}'); }, []);
            const Component = ${overlayId === 'modules' ? 'ModuleOverlay' : 'RNAStructureOverlay'};
            // Same identifier AND the same selected object throughout. Canonical
            // sequence and annotations must come from the active repository.
            return <Component currentPhage={repositories.a.phage} repository={repositories[name].repository} />;
          }
          createRoot(document.getElementById('root')).render(
            <ScrollProvider><ToastProvider><OverlayProvider><Fixture /></OverlayProvider></ToastProvider></ScrollProvider>
          );
        `;
      },
      configureServer(vite) {
        vite.middlewares.use('/gene-analysis-identity-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/gene-analysis-identity-fixture', '<div id="root"></div><script type="module" src="/src/gene-analysis-identity-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Gene-analysis fixture did not start');
    await page.goto(`${url}gene-analysis-identity-fixture`);
    return { server, errors, overlay: page.getByTestId(`overlay-${overlayId}`) };
  } catch (error) {
    await server.close();
    throw error;
  }
}

test('module coherence pairs current repository annotations with its actual upstream bases', async ({ page }, info) => {
  const { server, errors, overlay } = await openFixture(page, info, 'modules');
  try {
    await expect(overlay).toContainText('1 genes');
    await overlay.getByText('Capsid', { exact: true }).click();
    await expect(overlay.getByTitle('Role: mcp, RBS: 0%', { exact: true })).toContainText('A capsid');

    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('b'));
    await expect(overlay).toContainText('2 genes');
    await overlay.getByText('Capsid', { exact: true }).click();
    // Independently specified perfect AGGAGG motif at the new gene's -20 bp.
    await expect(overlay.getByTitle('Role: mcp, RBS: 100%', { exact: true })).toContainText('B capsid');
    expect(await page.evaluate(() => window.geneAnalysisIdentityFixture.geneReads.b)).toBe(1);
    await overlay.getByRole('button', { name: 'stoichiometry', exact: true }).click();
    await expect(overlay).toContainText('MCP:Portal ratio');

    await page.evaluate(() => {
      window.geneAnalysisIdentityFixture.hold('delayedLength', 'length');
      window.geneAnalysisIdentityFixture.select('delayedLength');
    });
    await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.pending)).toBe(true);
    await expect(overlay.getByRole('status', { name: 'Analyzing module coherence...', exact: true })).toBeVisible();
    await expect(overlay).not.toContainText('Gene Pair Ratios');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('b'));
    await expect(overlay).toContainText('Gene Pair Ratios');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.release());
    await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.released)).toBe(true);
    expect(await page.evaluate(() => window.geneAnalysisIdentityFixture.sequenceReads.delayedLength)).toBe(0);

    await page.evaluate(() => {
      window.geneAnalysisIdentityFixture.hold('delayedGenes', 'genes');
      window.geneAnalysisIdentityFixture.select('delayedGenes');
    });
    await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.pending)).toBe(true);
    await expect(overlay).not.toContainText('2 genes');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('b'));
    await expect(overlay).toContainText('2 genes');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.release());
    await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.released)).toBe(true);
    await expect(overlay).toContainText('MCP:Portal ratio');
    await expect(overlay).not.toContainText('Late capsid');

    // Identical bases do not make repositories' annotation sets interchangeable.
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('c'));
    await expect(overlay).toContainText('1 genes');
    await expect(overlay).toContainText('Gene Pair Ratios');
    await overlay.getByRole('button', { name: 'overview', exact: true }).click();
    await overlay.getByText('Capsid', { exact: true }).click();
    await expect(overlay).toContainText('C capsid');
    await expect(overlay).not.toContainText('A capsid');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('empty'));
    await expect(overlay).toContainText('No genes available for analysis');
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test('RNA analysis scopes selected genes and codon details to repository and CDS identity', async ({ page }, info) => {
  const { server, errors, overlay } = await openFixture(page, info, 'rnaStructure');
  try {
    const view = overlay.getByRole('combobox', { name: 'View:', exact: true });
    const gene = overlay.getByRole('combobox', { name: 'Gene:', exact: true });
    const codonCount = overlay.getByText('Total Codons', { exact: true }).locator('..');
    const firstCodon = overlay.locator('svg[width="560"] rect').first();
    await expect(codonCount).toHaveText('Total Codons300');
    await view.selectOption('gene');
    await gene.selectOption('shared-1');
    await expect(codonCount).toHaveText('Total Codons100');
    await view.hover();
    await firstCodon.hover();
    await expect(overlay.getByText('TTT', { exact: true })).toBeVisible();

    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('b'));
    await expect(gene).toContainText('B capsid (180-540)');
    await expect(view).toHaveValue('gene');
    await expect(gene).toHaveValue('');
    await expect(overlay).toContainText('Select a gene to analyze');
    await expect(overlay.getByText('TTT', { exact: true })).not.toBeVisible();
    await gene.selectOption('shared-1');
    await expect(codonCount).toHaveText('Total Codons120');
    await view.hover();
    await firstCodon.hover();
    await expect(overlay.getByText('GGG', { exact: true })).toBeVisible();
    await gene.selectOption('shared-2');
    await expect(codonCount).toHaveText('Total Codons60');
    await expect(overlay.getByText('GGG', { exact: true })).not.toBeVisible();
    await view.hover();
    await firstCodon.hover();
    // The deposited minus-strand gene is 180 genomic Gs: 60 CCC codons.
    await expect(overlay.getByText('CCC', { exact: true })).toBeVisible();

    for (const [name, stage] of [['delayedLength', 'length'], ['delayedGenes', 'genes']] as const) {
      await page.evaluate(([name, stage]) => {
        window.geneAnalysisIdentityFixture.hold(name, stage);
        window.geneAnalysisIdentityFixture.select(name);
      }, [name, stage] as const);
      await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.pending)).toBe(true);
      await expect(overlay.getByRole('status', { name: 'Analyzing RNA structure...', exact: true })).toBeVisible();
      await expect(gene).not.toContainText('B capsid');
      await page.evaluate(() => window.geneAnalysisIdentityFixture.select('b'));
      await expect(gene).toContainText('B capsid (180-540)');
      await expect(view).toHaveValue('gene');
      await expect(gene).toHaveValue('');
      await page.evaluate(() => window.geneAnalysisIdentityFixture.release());
      await expect.poll(() => page.evaluate(() => window.geneAnalysisIdentityFixture.released)).toBe(true);
      await expect(gene).toContainText('B capsid (180-540)');
      await expect(gene).not.toContainText('Late capsid');
    }
    expect(await page.evaluate(() => window.geneAnalysisIdentityFixture.sequenceReads.delayedLength)).toBe(0);

    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('c'));
    await expect(gene).toContainText('C capsid (30-150)');
    await gene.selectOption('shared-1');
    await expect(codonCount).toHaveText('Total Codons40');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('joined'));
    await expect(gene).toContainText('Joined reverse');
    await expect(gene).toHaveValue('');
    await gene.selectOption('shared-1');
    // complement(join(...)) produces A + 63 Cs; codon_start=2 removes
    // the initial A. Neither the 89-base gap nor that offset is a codon.
    await expect(codonCount).toHaveText('Total Codons21');
    await view.hover();
    await firstCodon.hover();
    await expect(overlay.getByText('CCC', { exact: true })).toBeVisible();
    await expect(overlay.getByText('ACC', { exact: true })).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
