import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
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
            mixed: await makeRepository('mixed', 'T'.repeat(90) + 'G'.repeat(120) + 'A'.repeat(90),
              cds('1..300', 'Noncoding gene annotation', 'shared-1', 'gene').replace('     CDS             ', '     gene            ') +
              cds('211..240', 'Transfer RNA annotation', 'shared-1', 'tRNA').replace('     CDS             ', '     tRNA            ') +
              cds('1..90', 'Twin first CDS', 'shared-1', 'hypothetical protein') +
              cds('91..210', 'Twin second CDS', 'shared-1', 'hypothetical protein') +
              cds('211..300', 'Pseudo CDS', 'pseudo', 'hypothetical protein', '                     /pseudo\\n')),
            code4: await makeRepository('code4', 'TGA'.repeat(90),
              cds('1..270', 'Alternative code CDS', 'shared-1', 'hypothetical protein', '                     /transl_table=4\\n')),
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
    await expect(codonCount).toHaveText('Total CodonsNot computed');
    const acceptedInterval = overlay.getByTestId('rna-accepted-interval');
    const start = overlay.getByRole('textbox', { name: 'RNA interval start', exact: true });
    const end = overlay.getByRole('textbox', { name: 'RNA interval end', exact: true });
    await expect(acceptedInterval).toContainText('Analyzed 1–600 of 900 genomic bases.');
    await start.fill('101'); await end.fill('220');
    // Draft coordinates cannot relabel the result or exported exact input.
    await expect(acceptedInterval).toContainText('Analyzed 1–600 of 900 genomic bases.');
    await overlay.getByRole('button', { name: 'Analyze interval', exact: true }).click();
    await expect(acceptedInterval).toContainText('Analyzed 101–220 of 900 genomic bases.');
    await start.fill('201'); await end.fill('320');
    const downloading = page.waitForEvent('download');
    await overlay.getByRole('button', { name: 'Export RNA analysis', exact: true }).click();
    const download = await downloading, downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const exported = JSON.parse(await readFile(downloadPath!, 'utf8'));
    expect(exported.method.id).toBe('rna-maximum-pairing');
    expect(exported.inputs[0].data.sequence).toBe('T'.repeat(120));
    expect(exported.inputs[0].data.source).toMatchObject({ start: 100, end: 220, sourceLength: 900, coordinateSystem: 'genome-forward' });
    expect(exported.parameters.includeSynonymousStress).toBe(false);
    expect(exported.fields.analysis.coverage).toEqual({ available: 120, total: 900, unit: 'bases' });
    expect(exported.fields.analysis.value.windows[0].structure).toBe('.'.repeat(120));
    expect(exported.resultId).toMatch(/^[a-f0-9]{64}$/);
    await view.selectOption('gene');
    await gene.selectOption({ label: 'A capsid (120-420)' });
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
    await gene.selectOption({ label: 'B capsid (180-540)' });
    await expect(codonCount).toHaveText('Total Codons120');
    await view.hover();
    await firstCodon.hover();
    await expect(overlay.getByText('GGG', { exact: true })).toBeVisible();
    await gene.selectOption({ label: 'B portal (600-780)' });
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
    await gene.selectOption({ label: 'C capsid (30-150)' });
    await expect(codonCount).toHaveText('Total Codons40');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('joined'));
    await expect(gene).toContainText('Joined reverse');
    await expect(gene).toHaveValue('');
    await gene.selectOption({ label: 'Joined reverse (0-153)' });
    // complement(join(...)) produces A + 63 Cs; codon_start=2 removes
    // the initial A. Neither the 89-base gap nor that offset is a codon.
    await expect(codonCount).toHaveText('Total Codons21');
    await view.hover();
    await firstCodon.hover();
    await expect(overlay.getByText('CCC', { exact: true })).toBeVisible();
    await expect(overlay.getByText('ACC', { exact: true })).not.toBeVisible();
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('code4'));
    await expect(gene).toContainText('Alternative code CDS');
    await gene.selectOption({ label: 'Alternative code CDS (0-270)' });
    await expect(codonCount).toHaveText('Total CodonsNot computed');
    await expect(overlay).toContainText('Synonymous scores are unavailable for this CDS genetic code or exceptional/pseudogene annotation.');
    await expect(overlay.getByTestId('rna-accepted-interval')).toContainText('Analyzed 1–270 of 270 coding-transcript bases.');
    await page.evaluate(() => window.geneAnalysisIdentityFixture.select('mixed'));
    await expect(gene).toContainText('Twin first CDS');
    await expect(gene).not.toContainText('Noncoding gene annotation');
    await expect(gene).not.toContainText('Transfer RNA annotation');
    // Both CDS annotations deliberately reuse the same locus tag; unique IDs must keep selection distinct.
    await gene.selectOption({ label: 'Twin first CDS (0-90)' });
    await expect(codonCount).toHaveText('Total Codons30');
    await view.hover(); await firstCodon.hover();
    await expect(overlay.getByText('TTT', { exact: true })).toBeVisible();
    await gene.selectOption({ label: 'Twin second CDS (90-210)' });
    await expect(codonCount).toHaveText('Total Codons40');
    await view.hover(); await firstCodon.hover();
    await expect(overlay.getByText('GGG', { exact: true })).toBeVisible();
    await gene.selectOption({ label: 'Pseudo CDS (210-300)' });
    await expect(codonCount).toHaveText('Total CodonsNot computed');
    await expect(overlay).toContainText('Synonymous scores are unavailable for this CDS genetic code or exceptional/pseudogene annotation.');
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
