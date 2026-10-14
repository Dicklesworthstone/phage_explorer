import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { parseAnalysisRecord } from '../../core/src/analysis-result';

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
              text: '>row [topology=circular]\\nGAATTCAA\\n>column\\nCCAATTAA\\n' });
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
    }) as InlineConfig);
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
