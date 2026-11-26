import { test, expect, type Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig } from 'vite';

declare global {
  interface Window {
    regionComparisonFixture: {
      clearSources: () => void;
      selectedCount: () => number;
      holdReply: boolean;
      replyPending: boolean;
      releaseReply: () => void;
      wholeReplyPending: boolean;
      releaseWholeReply: () => void;
      terminatedWholeWorkers: number;
      wholeResultAccepted: () => boolean;
    };
  }
}
const fixtureSource = [
  "import React, { useEffect, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  "import { importLocalGenomes } from '@phage-explorer/core';",
  "import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';",
  "import { usePhageStore } from '@phage-explorer/state';",
  "import { useLocalGenomes } from './db/local-genomes';",
  "import { ComparisonOverlay } from './components/overlays/ComparisonOverlay';",
  "import { OverlayProvider, useOverlay } from './components/overlays/OverlayProvider';",
  "import { ToastProvider } from './components/ui/Toast';",
  "import { ScrollProvider } from './providers';",
  "import './styles/index.css';",
  "const inputA = { name: 'two-records.fasta', text: '>unselected\\nAAAAAAAAAAAA\\n>chosen_a\\nTTTACGTAACCC\\n' };",
  "const inputB = { name: 'query.fasta', text: '>chosen_b\\nGGGTTACGTAAA\\n' };",
  "const a = (await importLocalGenomes(inputA)).genomes[1], b = (await importLocalGenomes(inputB)).genomes[0];",
  "const genomes = [a, b];",
  "const catalog = { ...structuredClone(a.phage), id: 17, slug: 'catalog-source', name: 'Catalog source', accession: 'CATALOG_A', localGenome: undefined };",
  "const base = { listPhages: async () => [catalog], getPhageById: async id => id === 17 ? catalog : null,",
  "  getSequenceWindow: async (id, start, end) => id === 17 ? a.sequence.slice(start, end) : '',",
  "  getFullGenomeLength: async id => id === 17 ? a.sequence.length : 0,",
  "  getOfflineDataset: () => ({ describe: () => ({ contentVersion: 'a'.repeat(64) }) }) };",
  "const repository = createLocalGenomeRepository(base, genomes);",
  "const phages = [a.phage, b.phage, catalog];",
  "const fixture = window.regionComparisonFixture = { clearSources: () => {}, selectedCount: () => usePhageStore.getState().phages.length,",
  "  holdReply: false, replyPending: false, releaseReply: () => {}, holdWholeReply: true, wholeReplyPending: false,",
  "  releaseWholeReply: () => {}, terminatedWholeWorkers: 0, wholeResultAccepted: () => usePhageStore.getState().comparisonResult !== null };",
  "const NativeWorker = window.Worker;",
  "window.Worker = class extends NativeWorker { constructor(url, options) { super(url, options); this.heldWhole = false; this.addEventListener('message', event => {",
  "  if (fixture.holdWholeReply && event.data?.ok === true && event.data.experiment?.record.method.id === 'genome-comparison') {",
  "    fixture.holdWholeReply = false; fixture.wholeReplyPending = true; this.heldWhole = true; event.stopImmediatePropagation(); const data = event.data;",
  "    fixture.releaseWholeReply = () => { fixture.wholeReplyPending = false; this.dispatchEvent(new MessageEvent('message', { data })); }; return; }",
  "  if (!fixture.holdReply || event.data?.kind !== 'result' || event.data.value?.experiment.record.method.id !== 'genome-region-comparison') return;",
  "  fixture.holdReply = false; fixture.replyPending = true; event.stopImmediatePropagation(); const data = event.data;",
  "  fixture.releaseReply = () => { fixture.replyPending = false; this.dispatchEvent(new MessageEvent('message', { data })); };",
  "}); } terminate() { if (this.heldWhole) fixture.terminatedWholeWorkers++; super.terminate(); } };",
  "function Fixture() { const [available, setAvailable] = useState(true); const { open } = useOverlay();",
  "  useEffect(() => { useLocalGenomes.setState({ genomes });",
  "    usePhageStore.setState({ phages, comparisonPhageAIndex: 0, comparisonPhageBIndex: 1, comparisonTab: 'diff', comparisonResult: null, comparisonLoading: false, overlays: [] });",
  "    fixture.clearSources = () => flushSync(() => { useLocalGenomes.setState({ genomes: [] });",
  "      usePhageStore.setState({ phages: [], comparisonPhageAIndex: null, comparisonPhageBIndex: null }); setAvailable(false); });",
  "    open('comparison'); }, []);",
  "  return React.createElement(ComparisonOverlay, { repository: available ? repository : null }); }",
  "createRoot(document.getElementById('root')).render(React.createElement(ScrollProvider, null,",
  "  React.createElement(ToastProvider, null, React.createElement(OverlayProvider, null, React.createElement(Fixture)))));",
].join('\n');

async function setRegions(panel: Locator, reverseB = true): Promise<void> {
  await panel.getByLabel('Region A start (inclusive)', { exact: true }).fill('4');
  await panel.getByLabel('Region A end (inclusive)', { exact: true }).fill('9');
  await panel.getByLabel('Region B start (inclusive)', { exact: true }).fill('4');
  await panel.getByLabel('Region B end (inclusive)', { exact: true }).fill('9');
  // The native select has this accessible name; its wrapping label's raw text
  // also includes the option labels, so exact getByLabel text is not the control name.
  const strandA = panel.getByRole('combobox', { name: 'Region A strand', exact: true });
  const strandB = panel.getByRole('combobox', { name: 'Region B strand', exact: true });
  await strandA.selectOption('+');
  await strandB.selectOption(reverseB ? '-' : '+');
  await expect(strandA).toHaveValue('+');
  await expect(strandB).toHaveValue(reverseB ? '-' : '+');
}
test('source regions compare explicit strands, export complete evidence and reopen without any selected genome', async ({ page }, info) => {
  const root = process.cwd(), fixtureId = resolve(root, 'src/region-comparison-fixture.tsx');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
  if (!loaded) throw new Error('Could not load region comparison fixture configuration.');
  const server = await createServer(mergeConfig(loaded.config, {
    root, configFile: false, cacheDir: info.outputPath('vite-cache'),
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{
      name: 'region-comparison-fixture',
      resolveId(source) { if (source === '/src/region-comparison-fixture.tsx' || source === fixtureId) return fixtureId; },
      load(source) { if (source === fixtureId) return fixtureSource; },
      configureServer(vite) {
        vite.middlewares.use('/region-comparison-fixture', (_request, response, next) => {
          void vite.transformIndexHtml('/region-comparison-fixture',
            '<div id="root"></div><script type="module" src="/src/region-comparison-fixture.tsx"></script>')
            .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
        });
      },
    }],
  } satisfies InlineConfig));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await server.listen();
    await page.goto(server.resolvedUrls!.local[0] + 'region-comparison-fixture');
    const overlay = page.getByTestId('overlay-comparison'), panel = overlay.locator('details[aria-label="Source region comparison"]');
    await panel.locator(':scope > summary').click();
    const run = panel.getByRole('button', { name: 'Compare source regions', exact: true });
    // A real whole-genome result is held in transit: region work must remain
    // available and revoke that worker before starting its own computation.
    await expect.poll(() => page.evaluate(() => window.regionComparisonFixture.wholeReplyPending)).toBe(true);
    await expect(overlay.getByRole('button', { name: 'Cancel comparison', exact: true })).toBeVisible();
    await expect(run).toBeEnabled();
    await setRegions(panel);
    await run.click();
    await expect.poll(() => page.evaluate(() => window.regionComparisonFixture.terminatedWholeWorkers)).toBe(1);
    await page.evaluate(() => window.regionComparisonFixture.releaseWholeReply());
    const accepted = panel.getByTestId('region-comparison-result');
    await expect(accepted).toContainText('Edit distance: 0.');
    expect(await page.evaluate(() => window.regionComparisonFixture.wholeResultAccepted())).toBe(false);
    await expect(accepted).toContainText('reverse complement (−)');
    await expect(accepted.getByRole('table', { name: 'Source region alignment coordinates' })).toContainText('4–9');
    const resultId = await accepted.getAttribute('data-result-id');

    const exportText = async (name: string): Promise<string> => {
      const pending = page.waitForEvent('download');
      await panel.getByRole('button', { name, exact: true }).click();
      const file = await (await pending).path();
      if (!file) throw new Error('Region download path unavailable.');
      return readFile(file, 'utf8');
    };
    const saved = await exportText('Export region analysis JSON'), record = JSON.parse(saved);
    expect(record.method.id).toBe('genome-region-comparison');
    expect(record.inputs[0].data).toEqual({
      name: 'two-records.fasta', text: '>unselected\nAAAAAAAAAAAA\n>chosen_a\nTTTACGTAACCC\n',
    });
    expect(record.inputs[1].data).toEqual({ name: 'query.fasta', text: '>chosen_b\nGGGTTACGTAAA\n' });
    expect(record.fields.comparison.value.sourceA.accession).toBe('chosen_a');
    expect(record.parameters.regionB).toEqual({ start: 3, end: 9, strand: '-' });
    const fasta = await exportText('Export aligned region FASTA');
    expect(fasta.split('\n').filter(row => row === 'ACGTAA')).toHaveLength(2);
    expect((await exportText('Export region edit TSV')).split('\n').length).toBeGreaterThan(record.fields.comparison.value.runs.length);

    // Draft edits cannot change the accepted record or its exported settings.
    await panel.getByLabel('Region A end (inclusive)', { exact: true }).fill('8');
    expect(JSON.parse(await exportText('Export region analysis JSON')).resultId).toBe(resultId);
    await panel.getByLabel('Region A start (inclusive)', { exact: true }).fill('0');
    await run.click();
    await expect(panel.getByRole('alert')).toContainText('one-based inclusive');
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);
    await setRegions(panel, false);

    // Hold a real, different worker result, cancel it, then deliver its queued reply.
    await page.evaluate(() => { window.regionComparisonFixture.holdReply = true; });
    await run.click();
    await expect.poll(() => page.evaluate(() => window.regionComparisonFixture.replyPending)).toBe(true);
    await panel.getByRole('button', { name: 'Cancel region comparison', exact: true }).click();
    await expect(panel.getByTestId('region-comparison-status')).toContainText('preserved');
    await page.evaluate(() => window.regionComparisonFixture.releaseReply());
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);

    // The same source can supply two regions; changing a source retires old output.
    await overlay.getByLabel('Phage B', { exact: true }).selectOption('0');
    await expect(accepted).toHaveCount(0);
    await expect(run).toBeEnabled();
    await setRegions(panel, false); await run.click();
    await expect(accepted).toContainText('Edit distance: 0.');
    const intragenome = JSON.parse(await exportText('Export region analysis JSON'));
    expect(intragenome.parameters.recordA).toBe(intragenome.parameters.recordB);

    // Catalog sources are captured in full, explicitly labelled, then sliced.
    await overlay.getByLabel('Phage A', { exact: true }).selectOption('2');
    await overlay.getByLabel('Phage B', { exact: true }).selectOption('1');
    await expect(run).toBeEnabled(); await setRegions(panel); await run.click();
    await expect(accepted).toContainText('Edit distance: 0.');
    await expect(accepted).toContainText('Catalog source');
    await expect(accepted).toContainText('catalog-snapshot');
    const catalog = JSON.parse(await exportText('Export region analysis JSON'));
    expect(JSON.parse(catalog.inputs[0].data.text).genome.sequence).toBe('TTTACGTAACCC');
    expect(JSON.parse(catalog.inputs[0].data.text).provenance.contentVersion).toBe('a'.repeat(64));

    // File replay needs neither a selected source nor any repository.
    await page.evaluate(() => window.regionComparisonFixture.clearSources());
    await expect(accepted).toHaveCount(0);
    const reopen = panel.getByLabel('Reopen source region comparison JSON', { exact: true });
    await expect(reopen).toBeEnabled();
    await reopen.setInputFiles({ name: 'saved-regions.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);
    await expect(accepted).toContainText('Verified saved region comparison');
    await expect(accepted).toContainText('chosen_a');
    await expect(accepted).not.toContainText('Catalog source');
    expect(await page.evaluate(() => window.regionComparisonFixture.selectedCount())).toBe(0);
    await reopen.setInputFiles({ name: 'broken-utf8.json', mimeType: 'application/json', buffer: Buffer.from([0xff]) });
    await expect(panel.getByRole('alert')).toContainText('invalid UTF-8');
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);
    const forged = JSON.parse(saved); forged.fields.comparison.value.stats.distance++;
    await reopen.setInputFiles({ name: 'changed-result.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(forged)) });
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);

    // The dedicated local shelf accepts region records and reopens through this pipeline.
    const shelf = panel.locator('details[aria-label="Saved genomic region comparisons"]');
    await shelf.locator(':scope > summary').click();
    await shelf.getByLabel('Snapshot name', { exact: true }).fill('Reverse strand source regions');
    await shelf.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
    await expect(shelf).toContainText('Saved an immutable');
    await shelf.getByLabel('Saved snapshot', { exact: true }).selectOption({ index: 1 });
    await shelf.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
    await expect(shelf).toContainText('Saved experiment recomputed and verified');
    await expect(accepted).toHaveAttribute('data-result-id', resultId!);
    expect(await page.evaluate(() => window.regionComparisonFixture.selectedCount())).toBe(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
