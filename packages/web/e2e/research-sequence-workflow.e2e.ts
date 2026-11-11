import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowResults, workflowAnalysisAt } from '../../core/src/workflow-results';
import type { SpacerLibrary, ReferenceSpacerHit } from '../../core/src/analysis/spacer-reference';

// Independent coordinate oracle: [4,24) forward then AGG; [34,54)
// reverse-complement target preceded by CCT, which is guide-oriented AGG.
const SPACER_DNA = 'TTTTACGATTCGGTACCTAGTGCAAGGNNNNCCTTGCACTAGGTACCGAATCGTAAAA';
const SPACER_LIBRARY: SpacerLibrary = {
  format: 'phage-explorer-spacer-library', version: 1, name: 'Private workflow reference α',
  source: { kind: 'local', version: 'fixture-1', reference: 'Hand-constructed coordinate fixture', license: 'CC0', scope: 'Artificial strains; no empirical immunity claim' },
  hosts: [{ id: 'one', name: '<b>literal host</b>', strain: 'α strain', accession: 'synthetic:one' },
    { id: 'two', name: 'Host without records', strain: 'no records', accession: 'synthetic:two' }],
  spacers: [{ id: 'oriented', hostId: 'one', arrayAccession: 'synthetic:array', sequence: 'ACGATTCGGTACCTAGTGCA',
    system: null, target: 'DNA', orientation: 'guide-equivalent',
    pam: { side: '3prime', motif: 'NGG', reference: 'Synthetic oriented rule' },
    seed: { start: 0, end: 4, maxMismatches: 0, reference: 'Synthetic interval' } },
  { id: 'unsupported-rna', hostId: 'one', arrayAccession: 'synthetic:rna-array', sequence: 'ACGATTCGGTACCTAGTGCA',
    system: 'VI', target: 'RNA', orientation: 'guide-equivalent', pam: null, seed: null }],
};

interface WorkflowFixture extends Window {
  workflowIds: string[];
  holdWorkflowReply: boolean;
  workflowReplyHeld: boolean;
  releaseWorkflowReply(): void;
  removeWorkflowComparison(): void;
}
let fixtureConfig: UserConfig | undefined;

// The real component, importer, stores, IndexedDB and web worker are used. The
// fixture controls delivery timing only; it never supplies numerical results.
const test = base.extend<{ workflowFixture: void }>({
  workflowFixture: [async ({ page }, use, info) => {
    const root = process.cwd(), fixtureId = resolve(root, 'src/research-sequence-workflow-fixture.tsx');
    if (!fixtureConfig) {
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(root, 'vite.config.ts'));
      if (!loaded) throw new Error('The production web configuration is unavailable.');
      fixtureConfig = loaded.config;
    }
    const server = await createServer(mergeConfig(fixtureConfig, {
      root, configFile: false, cacheDir: info.outputPath('vite-cache'),
      server: { host: '127.0.0.1', port: 0, open: false },
      plugins: [{
        name: 'research-sequence-workflow-fixture',
        resolveId(id) { if (id === '/src/research-sequence-workflow-fixture.tsx') return fixtureId; },
        load(id) {
          if (id !== fixtureId) return;
          return `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { importLocalGenomes } from '@phage-explorer/core';
            import { useLocalGenomes } from './db/local-genomes';
            import { ResearchWorkflowPanel } from './components/overlays/ResearchWorkflowPanel';
            import './styles/index.css';
            const parsed = await importLocalGenomes({ name: 'workflow.fa',
              text: '>row [topology=circular]\\nGAATTCAA\\n>column\\nCCAATTAA\\n>spacer-query [topology=linear]\\n${SPACER_DNA}\\n' });
            useLocalGenomes.getState().add(parsed, false, []);
            useLocalGenomes.getState().acknowledgeSelection(parsed.genomes[0].phage.id);
            window.workflowIds = parsed.genomes.map(g => g.phage.localGenome.contentId);
            window.removeWorkflowComparison = () => useLocalGenomes.setState({ genomes: [parsed.genomes[0]] });
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                super(url, options);
                this.addEventListener('message', event => {
                  if (!window.holdWorkflowReply || event.data?.result?.type !== 'analysis') return;
                  window.holdWorkflowReply = false;
                  window.workflowReplyHeld = true;
                  const data = event.data;
                  event.stopImmediatePropagation();
                  window.releaseWorkflowReply = () => this.dispatchEvent(new MessageEvent('message', { data }));
                });
              }
            };
            createRoot(document.getElementById('root')).render(<ResearchWorkflowPanel />);
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/workflow-fixture', (_request, response, next) => {
            void vite.transformIndexHtml('/workflow-fixture', '<div id="root"></div><script type="module" src="/src/research-sequence-workflow-fixture.tsx"></script>')
              .then(html => { response.setHeader('Content-Type', 'text/html'); response.end(html); }).catch(next);
          });
        },
      }],
    } satisfies InlineConfig));
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await server.listen();
      const address = server.resolvedUrls?.local[0];
      if (!address) throw new Error('Fixture server did not publish a local address.');
      await page.goto(`${address}workflow-fixture`);
      await expect(page.getByRole('button', { name: 'Start workflow recording', exact: true })).toBeEnabled();
      await use();
      expect(pageErrors).toEqual([]);
    } finally { await server.close(); }
  }, { auto: true }],
});

async function start(page: Page) {
  await page.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
  await page.getByLabel('Workflow dot-plot bins', { exact: true }).fill('2');
  await page.getByLabel('Workflow dot-plot window (bp)', { exact: true }).fill('2');
}
async function recorded(page: Page, count: number) {
  await expect(page.getByTestId('workflow-status')).toContainText(`recording · ${count} recorded commands`);
}
async function download(page: Page, button: string): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const path = await (await pending).path();
  if (!path) throw new Error('Download did not produce readable bytes.');
  return readFile(path, 'utf8');
}
async function captureMixed(page: Page) {
  await start(page);
  await page.getByRole('button', { name: 'Run and record dot plot', exact: true }).click();
  await recorded(page, 1);
  const selfId = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  await page.getByLabel('Workflow digest topology', { exact: true }).selectOption('circular');
  await page.getByRole('button', { name: 'Run and record restriction digest', exact: true }).click();
  await recorded(page, 2);
  await expect(page.getByRole('region', { name: 'Recorded restriction-digest results' })).toContainText('1 distinct cut boundaries; 1 fragments; 8 bp');
  const fragment = page.getByRole('table', { name: 'Recorded restriction fragments' }).locator('tbody tr').first();
  await expect(fragment.locator('td')).toHaveText(['1', '1', '8', 'Yes']);
  const column = await page.evaluate(() => (window as WorkflowFixture).workflowIds[1]);
  await page.getByLabel('Workflow dot-plot comparison', { exact: true }).selectOption(column);
  await page.getByRole('button', { name: 'Run and record dot plot', exact: true }).click();
  await recorded(page, 3);
  const pairId = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  await page.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
  return { selfId, pairId, tape: await download(page, 'Export research workflow') };
}

async function configureMosaic(page: Page) {
  await page.getByRole('checkbox', { name: /Workflow mosaic reference column / }).check();
  await page.getByLabel('Workflow mosaic k-mer length', { exact: true }).fill('2');
  await page.getByLabel('Workflow mosaic window (bp)', { exact: true }).fill('200');
  await page.getByLabel('Workflow mosaic step (bp)', { exact: true }).fill('100');
  await page.getByLabel('Workflow mosaic minimum similarity', { exact: true }).fill('0');
  await page.getByLabel('Workflow mosaic maximum references', { exact: true }).fill('1');
  await page.getByLabel('Workflow mosaic retained candidates per window', { exact: true }).fill('1');
}

async function configureSpacers(page: Page) {
  await start(page);
  const id = await page.evaluate(() => (window as WorkflowFixture).workflowIds[2]);
  await page.getByLabel('Workflow genome', { exact: true }).selectOption(id);
  await expect(page.getByLabel('Workflow spacer genome topology', { exact: true })).toHaveValue('linear');
  await expect(page.getByRole('button', { name: 'Run and record spacer comparison', exact: true })).toBeDisabled();
  const text = JSON.stringify(SPACER_LIBRARY, null, 2);
  await page.getByLabel('Workflow spacer reference library JSON', { exact: true }).setInputFiles({
    name: 'private-workflow-spacers.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('workflow-spacer-draft')).toContainText(SPACER_LIBRARY.name);
  await recorded(page, 0);
  await page.getByLabel('Workflow spacer host scope', { exact: true }).selectOption('one');
  return { id, text };
}

test('records sourced spacer evidence and missing host coverage, then verifies the complete archive after reload', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  const fixture = await configureSpacers(page);
  const run = page.getByRole('button', { name: 'Run and record spacer comparison', exact: true });
  await page.getByLabel('Workflow spacer maximum substitutions', { exact: true }).fill('');
  await expect(run).toBeDisabled();
  await page.getByLabel('Workflow spacer maximum substitutions', { exact: true }).fill('0');
  await run.click(); await recorded(page, 1);
  const result = page.getByRole('region', { name: 'Recorded spacer results', exact: true });
  const rows = page.getByRole('table', { name: 'Recorded spacer matches', exact: true }).locator('tbody tr');
  await expect(page.getByTestId('workflow-spacer-outcome')).toContainText('Sequence matches found');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('td').nth(2)).toHaveText('[4,24) +');
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('[34,54) -');
  await expect(rows.nth(1).locator('td').nth(4)).toContainText('matched: AGG');
  await expect(result).toContainText('1/2 reference records searched');
  await expect(result.locator('b')).toHaveCount(0);
  const original = await parseAnalysisRecord(await download(page, 'Export workflow analysis'));
  expect(original.fields.matches.coverage).toEqual({ available: 1, total: 2, unit: 'records' });
  expect((original.fields.matches.value as unknown as ReferenceSpacerHit[]).map(hit => [hit.start, hit.end, hit.strand, hit.pam.status])).toEqual([
    [4, 24, '+', 'matched'], [34, 54, '-', 'matched'],
  ]);
  expect(original.inputs[0].data).toMatchObject({ sequence: SPACER_DNA, topology: 'linear', source: 'local' });
  expect(original.inputs[1].data).toEqual(SPACER_LIBRARY);

  await page.getByLabel('Workflow spacer host scope', { exact: true }).selectOption('two');
  await expect(result).toContainText('host scope: synthetic:one');
  expect((await parseAnalysisRecord(await download(page, 'Export workflow analysis'))).resultId).toBe(original.resultId);
  await run.click(); await recorded(page, 2);
  await expect(page.getByTestId('workflow-spacer-outcome')).toContainText('Nothing was searched');
  await expect(rows).toHaveCount(0); await expect(result).toContainText('0/0 reference records searched');
  const missing = await parseAnalysisRecord(await download(page, 'Export workflow analysis'));
  await page.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
  const tapeText = await download(page, 'Export research workflow'), tape = parseCommandTape(tapeText);
  expect(tape.commands.map(command => command.actionId)).toEqual(['overlay.crispr', 'overlay.crispr']);
  expect(tape.commands[0].parameters).toEqual({ contentId: fixture.id, libraryText: fixture.text, topology: 'linear', hostId: 'one', maxMismatches: 0 });
  expect(await page.getByRole('list', { name: 'Recorded workflow commands', exact: true }).textContent()).not.toContain('synthetic:array');

  await page.getByLabel('Workflow replay repetitions', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect(page.getByTestId('workflow-complete-results')).toContainText('4 executions · 2 distinct analyses');
  const archiveText = await download(page, 'Export complete workflow results JSON'), archive = await parseWorkflowResults(archiveText);
  expect(archive.records.map(record => record.resultId)).toEqual([original.resultId, missing.resultId]);
  await page.getByLabel('Inspect workflow execution', { exact: true }).selectOption('1');
  await expect(rows).toHaveCount(2); expect((await parseAnalysisRecord(await download(page, 'Export workflow analysis'))).resultId).toBe(original.resultId);
  await page.reload();
  await page.getByLabel('Load complete workflow results JSON (up to 32 MiB)', { exact: true }).setInputFiles({
    name: 'spacer-results.json', mimeType: 'application/json', buffer: Buffer.from(archiveText),
  });
  await expect(page.getByTestId('workflow-results-review')).toContainText('2 distinct analyses and 2 repetitions');
  await expect(page.getByTestId('workflow-result')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay and verify loaded complete results', exact: true }).click();
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(archiveText);

  // Valid hashes are insufficient: change a retained output and its matching
  // tape expectation, then require the browser worker to reject the invention.
  const changed = await parseWorkflowResults(archiveText), fields = structuredClone(changed.records[0].fields);
  (fields.matches.value as unknown as ReferenceSpacerHit[])[0].start = 123;
  changed.records[0] = await createAnalysisRecord({ ...changed.records[0], fields });
  const forgedTape = parseCommandTape(changed.tapeJson), forged = changed.records[0];
  forgedTape.commands[0].expected = analysisJson({ method: forged.method, cacheKey: forged.cacheKey, resultId: forged.resultId });
  changed.tapeJson = serializeCommandTape(forgedTape);
  await page.getByLabel('Load complete workflow results JSON (up to 32 MiB)', { exact: true }).setInputFiles({
    name: 'forged-spacer-results.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)),
  });
  await expect(page.getByTestId('workflow-results-review')).toContainText('2 distinct analyses and 2 repetitions');
  await page.getByRole('button', { name: 'Replay and verify loaded complete results', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Step 1 (overlay.crispr)');
  await expect(page.getByRole('alert')).toContainText('differs');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(archiveText);
  expect(requests.some(request => request.includes(SPACER_DNA) || request.includes('private-workflow-spacers') || request.includes('literal host'))).toBe(false);
});

test('bounds spacer drafts and never records cancelled or stale genome worker results', async ({ page }) => {
  await configureSpacers(page);
  const run = page.getByRole('button', { name: 'Run and record spacer comparison', exact: true });
  await run.click(); await recorded(page, 1);
  const accepted = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  await page.getByLabel('Workflow spacer genome topology', { exact: true }).selectOption('circular');
  await expect(run).toBeDisabled(); await expect(page.getByTestId('workflow-spacer-draft-error')).toContainText('conflicts with the source annotation');
  await page.getByLabel('Workflow spacer genome topology', { exact: true }).selectOption('linear');
  await page.getByLabel('Workflow spacer reference library JSON', { exact: true }).setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"wrong"}'),
  });
  await expect(page.getByRole('alert')).toContainText('Unsupported spacer library');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  await page.getByLabel('Workflow spacer reference library JSON', { exact: true }).setInputFiles({
    name: 'oversize.json', mimeType: 'application/json', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, ' '),
  });
  await expect(page.getByRole('alert')).toContainText('2 MiB limit');
  await recorded(page, 1);
  await page.getByLabel('Workflow spacer maximum substitutions', { exact: true }).fill('1');
  await page.evaluate(() => { (window as WorkflowFixture).holdWorkflowReply = true; });
  await run.click();
  await expect.poll(() => page.evaluate(() => (window as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel workflow', exact: true }).click();
  await page.evaluate(() => (window as WorkflowFixture).releaseWorkflowReply());
  await recorded(page, 1); await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  await page.evaluate(() => { (window as WorkflowFixture).holdWorkflowReply = true; (window as WorkflowFixture).workflowReplyHeld = false; });
  await run.click();
  await expect.poll(() => page.evaluate(() => (window as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.evaluate(() => { (window as WorkflowFixture).removeWorkflowComparison(); (window as WorkflowFixture).releaseWorkflowReply(); });
  await expect(page.getByRole('alert')).toContainText('Missing local genome');
  await recorded(page, 1); await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
});

test('records actual mosaic evidence, preserves accepted source labels through draft edits and round-trips all executions', async ({ page }) => {
  await start(page); await configureMosaic(page);
  await page.getByRole('button', { name: 'Run and record mosaic similarity', exact: true }).click();
  await recorded(page, 1);
  const accepted = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  const result = page.getByRole('region', { name: 'Recorded mosaic results', exact: true });
  const row = page.getByRole('table', { name: 'Recorded mosaic window evidence', exact: true }).locator('tbody tr').first();
  // Independent canonical sets: GAATTCAA={GA,AA,AT,CA}; CCAATTAA={CC,CA,AA,AT,TA}.
  // Their intersection has three words and their union has six.
  await expect(row.locator('td').nth(0)).toHaveText('[0, 8)');
  await expect(row.locator('td').nth(1)).toHaveText('matched');
  await expect(row.locator('td').nth(2)).toContainText('column');
  await expect(row.locator('td').nth(3)).toHaveText('0.500000');
  const contentIds = await page.evaluate(() => (window as unknown as WorkflowFixture).workflowIds);
  await page.getByLabel('Workflow genome', { exact: true }).selectOption(contentIds[1]);
  await expect(result).toContainText('Analyzed query: row');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  await page.getByLabel('Workflow genome', { exact: true }).selectOption(contentIds[0]);
  await configureMosaic(page);
  await page.getByLabel('Workflow mosaic minimum similarity', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Run and record mosaic similarity', exact: true }).click();
  await recorded(page, 2); await expect(row.locator('td').nth(1)).toHaveText('below-threshold');
  await page.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
  const tapeText = await download(page, 'Export research workflow'), tape = parseCommandTape(tapeText);
  expect(tape.commands.map(command => command.actionId)).toEqual(['overlay.mosaicRadar', 'overlay.mosaicRadar']);
  expect(tape.commands[0].parameters).toEqual({ queryContentId: contentIds[0], referenceContentIds: [contentIds[1]],
    options: { k: 2, window: 200, step: 100, minSimilarity: 0, maxReferences: 1, topN: 1 } });
  await page.getByLabel('Workflow replay repetitions', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect(page.getByTestId('workflow-complete-results')).toContainText('4 executions · 2 distinct analyses');
  const archiveText = await download(page, 'Export complete workflow results JSON');
  const archive = await parseWorkflowResults(archiveText);
  await page.getByLabel('Inspect workflow execution', { exact: true }).selectOption('3');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  expect(await parseAnalysisRecord(await download(page, 'Export workflow analysis'))).toEqual(workflowAnalysisAt(archive, 1));
  const tsv = await download(page, 'Export workflow mosaic windows TSV');
  expect(tsv).toContain(accepted!); expect(tsv).toContain('\tmatched\t0.5\t');
  expect(tsv).not.toContain('GAATTCAA'); expect(tsv).not.toContain('CCAATTAA');
  for (const section of ['segments', 'switches']) expect(await download(page, `Export workflow mosaic ${section} TSV`)).toContain(accepted!);
  await page.reload();
  await page.getByLabel('Load complete workflow results JSON (up to 32 MiB)', { exact: true }).setInputFiles({ name: 'mosaic-results.json', mimeType: 'application/json', buffer: Buffer.from(archiveText) });
  await expect(page.getByTestId('workflow-results-review')).toContainText('2 distinct analyses and 2 repetitions');
  await expect(page.getByTestId('workflow-result')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay and verify loaded complete results', exact: true }).click();
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(archiveText);
});

test('never records a cancelled mosaic calculation or accepts a reference removed while its worker reply is pending', async ({ page }) => {
  await start(page); await configureMosaic(page);
  await page.getByRole('button', { name: 'Run and record mosaic similarity', exact: true }).click();
  await recorded(page, 1);
  const accepted = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  await page.getByLabel('Workflow mosaic minimum similarity', { exact: true }).fill('1');
  await page.evaluate(() => { (window as unknown as WorkflowFixture).holdWorkflowReply = true; });
  await page.getByRole('button', { name: 'Run and record mosaic similarity', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel workflow', exact: true }).click();
  await page.evaluate(() => (window as unknown as WorkflowFixture).releaseWorkflowReply());
  await recorded(page, 1); await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  await page.evaluate(() => { (window as unknown as WorkflowFixture).holdWorkflowReply = true; (window as unknown as WorkflowFixture).workflowReplyHeld = false; });
  await page.getByRole('button', { name: 'Run and record mosaic similarity', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.evaluate(() => { (window as unknown as WorkflowFixture).removeWorkflowComparison(); (window as unknown as WorkflowFixture).releaseWorkflowReply(); });
  await expect(page.getByRole('alert')).toContainText('Missing local genome');
  await recorded(page, 1); await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
});

test('records self plot, circular digest and ordered comparison, then reloads and replays the actual browser tape', async ({ page }) => {
  const saved = await captureMixed(page), tape = parseCommandTape(saved.tape);
  expect(tape.commands.map(command => command.actionId)).toEqual(['overlay.dotPlot', 'overlay.gel', 'overlay.dotPlot']);
  expect(tape.commands[0].parameters).toMatchObject({ comparisonContentId: null, bins: 2, window: 2 });
  expect(tape.commands[1].parameters).toMatchObject({ enzymes: ['EcoRI'], topology: 'circular' });
  await page.reload();
  await page.getByLabel('Load research workflow JSON', { exact: true }).setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(saved.tape) });
  await expect(page.getByTestId('workflow-status')).toContainText('3 recorded commands');
  await page.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
  await expect(page.getByTestId('workflow-status')).toContainText('idle · 3 recorded commands · 3/3 replay commands complete');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', saved.pairId!);
  const record = await parseAnalysisRecord(await download(page, 'Export workflow analysis'));
  expect(record.fields.direct.value).toEqual([0, 0.5, 0, 1]);
  expect(record.fields.inverted.value).toEqual([0.5, 0, 0, 0]);
  expect(record.inputs.map(input => input.id)).toEqual(['rowSequence', 'columnSequence']);
  const tsv = await download(page, 'Export workflow dot-plot TSV');
  expect(tsv).not.toContain('GAATTCAA'); expect(tsv).not.toContain('CCAATTAA');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('stops at a forged later digest result without applying the remaining comparison', async ({ page }) => {
  const saved = await captureMixed(page), tape = parseCommandTape(saved.tape);
  (tape.commands[1].expected as { resultId: string }).resultId = '0'.repeat(64);
  await page.getByLabel('Load research workflow JSON', { exact: true }).setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(serializeCommandTape(tape)) });
  await expect(page.getByTestId('workflow-status')).toContainText('0/3');
  await page.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Step 2 (overlay.gel)');
  await expect(page.getByTestId('workflow-status')).toContainText('1/3 replay commands complete');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', saved.selfId!);
});

test('does not record a late real result after cancellation or substitute self comparison for a removed reference', async ({ page }) => {
  await start(page);
  await page.getByLabel('Workflow digest topology', { exact: true }).selectOption('circular');
  await page.getByRole('button', { name: 'Run and record restriction digest', exact: true }).click();
  await recorded(page, 1);
  const accepted = await page.getByTestId('workflow-result').getAttribute('data-result-id');
  const column = await page.evaluate(() => (window as WorkflowFixture).workflowIds[1]);
  await page.getByLabel('Workflow dot-plot comparison', { exact: true }).selectOption(column);
  await page.evaluate(() => { (window as WorkflowFixture).holdWorkflowReply = true; });
  await page.getByRole('button', { name: 'Run and record dot plot', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel workflow', exact: true }).click();
  await page.evaluate(() => (window as WorkflowFixture).releaseWorkflowReply());
  await recorded(page, 1);
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
  await page.evaluate(() => (window as WorkflowFixture).removeWorkflowComparison());
  await expect(page.getByLabel('Workflow dot-plot comparison', { exact: true })).toHaveValue(column);
  await expect(page.getByRole('button', { name: 'Run and record dot plot', exact: true })).toBeDisabled();
  await expect(page.getByText('A missing comparison is never replaced by a self plot.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', accepted!);
});

test('retains every browser analysis, selects earlier executions and exports their original records', async ({ page }) => {
  const saved = await captureMixed(page);
  await page.getByLabel('Workflow replay repetitions', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect(page.getByTestId('workflow-complete-results')).toContainText('6 executions · 3 distinct analyses');
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  const content = await download(page, 'Export complete workflow results JSON'), archive = await parseWorkflowResults(content);
  expect(archive.repetitions).toBe(2); expect(archive.records).toHaveLength(3);
  await page.getByLabel('Inspect workflow execution', { exact: true }).selectOption('1');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', saved.selfId!);
  const exported = await parseAnalysisRecord(await download(page, 'Export workflow analysis'));
  expect(exported).toEqual(workflowAnalysisAt(archive, 1));
  await page.getByLabel('Inspect workflow execution', { exact: true }).selectOption('5');
  const digest = await parseAnalysisRecord(await download(page, 'Export workflow analysis'));
  expect(digest.fields.cutSites.value).toEqual([1]);
  expect(digest.fields.fragments.value).toEqual([{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
  await page.getByLabel('Inspect workflow execution', { exact: true }).selectOption('6');
  await expect(page.getByTestId('workflow-result')).toHaveAttribute('data-result-id', saved.pairId!);
  expect(await download(page, 'Export complete workflow results JSON')).toBe(content);
});

test('reviews an exported complete run without executing, then verifies all its original repetitions', async ({ page }) => {
  await captureMixed(page);
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  const content = await download(page, 'Export complete workflow results JSON');
  await page.reload();
  await page.getByLabel('Load complete workflow results JSON (up to 32 MiB)', { exact: true }).setInputFiles({ name: 'results.json', mimeType: 'application/json', buffer: Buffer.from(content) });
  await expect(page.getByTestId('workflow-results-review')).toContainText('3 distinct analyses and 1 repetitions');
  await expect(page.getByTestId('workflow-complete-results')).toHaveCount(0);
  await expect(page.getByTestId('workflow-result')).toHaveCount(0);
  await expect(page.getByTestId('workflow-status')).toContainText('0/3');
  await page.getByRole('button', { name: 'Replay and verify loaded complete results', exact: true }).click();
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(content);
});

test('cancelled replacement and invalid import preserve the accepted complete run', async ({ page }) => {
  await captureMixed(page);
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect(page.getByTestId('workflow-results-status')).toContainText('Every command completed');
  const content = await download(page, 'Export complete workflow results JSON');
  await page.evaluate(() => { (window as WorkflowFixture).holdWorkflowReply = true; });
  await page.getByRole('button', { name: 'Replay and retain all results', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as WorkflowFixture).workflowReplyHeld)).toBe(true);
  await page.getByRole('button', { name: 'Cancel workflow', exact: true }).click();
  await page.evaluate(() => (window as WorkflowFixture).releaseWorkflowReply());
  await expect(page.getByTestId('workflow-results-status')).toContainText('Previously accepted complete results are unchanged');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(content);
  const changed = JSON.parse(content); changed.records.pop();
  await page.getByLabel('Load complete workflow results JSON (up to 32 MiB)', { exact: true }).setInputFiles({ name: 'incomplete.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
  await expect(page.getByRole('alert')).toContainText('missing analyses');
  expect(await download(page, 'Export complete workflow results JSON')).toBe(content);
});
