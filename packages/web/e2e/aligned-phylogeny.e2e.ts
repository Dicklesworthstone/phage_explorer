import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { createAlignedPhylogenyExperiment, type AlignedPhylogenyResult } from '../../core/src/analysis/aligned-phylogeny';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const launcher = fileURLToPath(new URL('../../tui/src/index.tsx', import.meta.url));
const synthetic = { name: 'Private alignment test', kind: 'demo' as const, reference: 'Synthetic test oracle, not experimental data.',
  fasta: '>A\nAAAAAAAAAAAA\n>B\nAAAAAAAATAAA\n>C\nGGGGAAAAAAAA\n>D\nGGGGAAAAATAA\n' };
async function open(page: Page) {
  await page.goto('/?phage=lambda&model=0');
  await expect(page.getByTestId('phage-list-item-selected')).toBeVisible();
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.keyboard.press('Control+Shift+y');
  await page.getByRole('button', { name: 'Infer an unrooted tree from aligned DNA', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Aligned DNA · unrooted phylogeny', exact: true });
  await expect(panel).toBeVisible(); return panel;
}
async function downloaded(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Download has no stream');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('aligned DNA reaches the real worker, browser exports and actual database-free terminal launcher', async ({ page }, info) => {
  test.setTimeout(180000); const { pageErrors, finalize } = setupTestHarness(page, info);
  let privateLeak = false;
  const marker = 'private-alignment-source-27f912';
  page.on('request', request => { if (request.url().includes(marker) || request.postData()?.includes(marker)) privateLeak = true; });
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  try {
    let panel = await open(page); await expectExplorerIdentity(page, info);
    const accepted = () => panel.getByRole('region', { name: 'Accepted aligned phylogeny', exact: true });
    const exportButton = () => panel.getByRole('button', { name: 'Export phylogeny experiment JSON', exact: true });
    await expect(exportButton()).toBeDisabled();
    await panel.getByRole('button', { name: 'Load synthetic quartet', exact: true }).click();
    await panel.getByLabel('Alignment source and homology provenance', { exact: true }).fill(marker);
    await panel.getByRole('button', { name: 'Infer unrooted tree', exact: true }).click();
    await expect(accepted()).toContainText('4 taxa; 12/12 columns retained');
    await expect(accepted()).toContainText('SYNTHETIC — NOT EXPERIMENTAL EVIDENCE');
    await expect(accepted().getByRole('img')).toBeVisible();
    await expect(accepted().getByRole('table', { name: 'Positive-length unrooted splits' }).locator('tbody tr')).toHaveCount(1);
    const saved = await downloaded(page, () => exportButton().click());
    const record = await parseAnalysisRecord(saved);
    const result = record.fields.phylogeny.value as unknown as AlignedPhylogenyResult;
    expect(result.distances[0]).toEqual([0,1/12,4/12,5/12]); expect(result.splits[0].side).toEqual(['A','B']); expect(record.seed).toBe(0);
    const tree = await downloaded(page, () => panel.getByRole('button', { name: 'Export unrooted Newick', exact: true }).click());
    expect(tree).toBe(result.newick + '\n');
    const path = info.outputPath('browser-experiment.json'); await writeFile(path, saved, { flag: 'wx' });
    const replay = JSON.parse(execFileSync('bun', [launcher, 'phylogeny', 'replay', '--experiment', path], { cwd: dirname(path), encoding: 'utf8' }));
    expect(replay.resultId).toBe(record.resultId); expect(replay.verified).toBe(true);
    const terminalPath = info.outputPath('terminal-verified.json');
    execFileSync('bun', [launcher, 'phylogeny', 'replay', '--experiment', path, '--output', terminalPath], { cwd: dirname(path) });
    expect(await readFile(terminalPath, 'utf8')).toBe(saved);
    await panel.getByLabel('Phylogeny seed (0–4294967295)', { exact: true }).fill('17');
    await expect(accepted()).toHaveCount(0); await expect(exportButton()).toBeDisabled();
    panel = await open(page);
    const load = (text: string) => panel.getByLabel('Restore verified phylogeny experiment JSON (up to 10 MiB)', { exact: true })
      .setInputFiles({ name: 'experiment.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await load(await readFile(terminalPath, 'utf8'));
    await expect(panel.getByTestId('aligned-phylogeny-status')).toContainText('Replay verified');
    await expect(accepted()).toHaveAttribute('data-result-id', record.resultId);
    const fields = structuredClone(record.fields); fields.phylogeny.value = { forged: true };
    const forged = await createAnalysisRecord({ ...record, fields });
    await load(serializeAnalysisRecord(forged)); await expect(panel.getByRole('alert')).toContainText('Recomputed phylogeny differs');
    await expect(accepted()).toHaveCount(0); await expect(exportButton()).toBeDisabled();
    expect(privateLeak).toBe(false); expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('edits supersede delayed file reads, and Cancel terminates the actual tree worker before acceptance', async ({ page }, info) => {
  test.setTimeout(180000); const { pageErrors, finalize } = setupTestHarness(page, info);
  const experiment = await createAlignedPhylogenyExperiment(synthetic, { bootstrap: 20, seed: 0 });
  let release: (() => void) | undefined;
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  try {
    const panel = await open(page); await expectExplorerIdentity(page, info);
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () {
        if (this.name === 'delayed.json') await new Promise<void>(resolve => {
          (window as Window & { releasePhylogenyRead?: () => void }).releasePhylogenyRead = resolve;
        });
        const bytes = await original.call(this);
        (window as Window & { phylogenyReadFinished?: boolean }).phylogenyReadFinished = true;
        return bytes;
      };
    });
    await panel.getByLabel('Restore verified phylogeny experiment JSON (up to 10 MiB)', { exact: true }).setInputFiles({
      name: 'delayed.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(experiment.record)),
    });
    await expect(panel.getByRole('button', { name: 'Cancel tree computation' })).toBeEnabled();
    await panel.getByLabel('Alignment name', { exact: true }).fill('Newer draft');
    await page.evaluate(() => (window as Window & { releasePhylogenyRead?: () => void }).releasePhylogenyRead?.());
    await page.waitForFunction(() => (window as Window & { phylogenyReadFinished?: boolean }).phylogenyReadFinished);
    await expect(panel.getByLabel('Alignment name', { exact: true })).toHaveValue('Newer draft');
    await expect(panel.getByRole('region', { name: 'Accepted aligned phylogeny' })).toHaveCount(0);
    const workerUrl = /aligned-phylogeny\.worker[^/]*\.(?:js|ts)/;
    let requested = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(workerUrl, async route => { requested = true; await gate; await route.continue().catch(() => {}); });
    await panel.getByRole('button', { name: 'Load synthetic quartet', exact: true }).click();
    await panel.getByRole('button', { name: 'Infer unrooted tree', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await panel.getByRole('button', { name: 'Cancel tree computation', exact: true }).click(); release?.();
    await expect(panel.getByTestId('aligned-phylogeny-status')).toContainText('Cancelled');
    await expect(panel.getByRole('button', { name: 'Export phylogeny experiment JSON' })).toBeDisabled();
    await page.unroute(workerUrl);
    await panel.getByRole('button', { name: 'Infer unrooted tree', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Accepted aligned phylogeny' })).toBeVisible();
    const before = await panel.getByRole('region', { name: 'Accepted aligned phylogeny' }).getAttribute('data-result-id');
    await panel.getByLabel('Already aligned DNA FASTA', { exact: true }).fill('>A\nAAA\n>B\nAA\n>C\nAAA');
    await expect(panel.getByRole('checkbox', { name: /I confirm these are homologous/ })).not.toBeChecked();
    await panel.getByRole('checkbox', { name: /I confirm these are homologous/ }).check();
    await panel.getByRole('button', { name: 'Infer unrooted tree', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('same nonzero number');
    await expect(panel.locator(`[data-result-id="${before}"]`)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { release?.(); await finalize(); }
});

test('explicit browser roots retain original evidence, survive CLI replay, and invalidate edited root exports', async ({ page }, info) => {
  test.setTimeout(180000); const { pageErrors, finalize } = setupTestHarness(page, info);
  const original = await createAlignedPhylogenyExperiment({ ...synthetic, name: 'Private rootable quartet',
    fasta: '>A\nAAAAAAAA\n>B\nAAAAAAAA\n>C\nCCCCAAAA\n>D\nCCCCAAAA' }, { bootstrap: 20, seed: 0 });
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  let privateLeak = false;
  const evidence = 'private-root-rationale-f792: synthetic AB split and a quarter-edge choice without dates';
  page.on('request', request => { if (request.url().includes('private-root-rationale-f792') || request.postData()?.includes('private-root-rationale-f792')) privateLeak = true; });
  try {
    const panel = await open(page); await expectExplorerIdentity(page, info);
    const load = (content: string) => panel.getByLabel('Restore verified phylogeny experiment JSON (up to 10 MiB)', { exact: true })
      .setInputFiles({ name: 'root-experiment.json', mimeType: 'application/json', buffer: Buffer.from(content) });
    await load(serializeAnalysisRecord(original.record));
    const originalResult = () => panel.getByRole('region', { name: 'Accepted aligned phylogeny', exact: true });
    const rootControls = () => panel.getByRole('region', { name: 'Explicit outgroup rooting', exact: true });
    const rootResult = () => panel.getByRole('region', { name: 'Accepted root hypothesis', exact: true });
    const rootExport = () => panel.getByRole('button', { name: 'Export rooted experiment JSON', exact: true });
    await expect(originalResult()).toHaveAttribute('data-result-id', original.record.resultId);
    await expect(rootControls().getByLabel('Root fraction from the outgroup-side endpoint', { exact: true })).toHaveValue('');
    await expect(rootExport()).toBeDisabled();
    await rootControls().getByLabel('Outgroup taxa (explicit selection)', { exact: true }).selectOption(['A', 'B']);
    await rootControls().getByLabel('Root fraction from the outgroup-side endpoint', { exact: true }).fill('0.25');
    await rootControls().getByLabel('Outgroup and branch-placement evidence', { exact: true }).fill(evidence);
    await rootControls().getByRole('checkbox', { name: 'I confirm that neither the outgroup choice nor root placement used collection dates.', exact: true }).check();
    await rootControls().getByRole('button', { name: 'Create rooted hypothesis', exact: true }).click();
    await expect(rootResult()).toContainText('6 pairwise paths checked; maximum absolute difference 0');
    await expect(rootResult().getByRole('img', { name: 'Explicit outgroup root hypothesis, not to branch-length scale', exact: true })).toBeVisible();
    const content = await downloaded(page, () => rootExport().click()), rooted = await parseAnalysisRecord(content);
    expect(rooted.method.id).toBe('explicit-outgroup-rooted-nj'); expect(rooted.inputs[0].source).toBe('demo');
    expect((rooted.fields.rooting.value as { sourceResultId: string }).sourceResultId).toBe(original.record.resultId);
    const tree = await downloaded(page, () => panel.getByRole('button', { name: 'Export explicit-root Newick', exact: true }).click());
    expect(tree).toBe("(('A':0,'B':0):0.125,('C':0,'D':0):0.375);\n");
    const unrooted = await downloaded(page, () => panel.getByRole('button', { name: 'Export phylogeny experiment JSON', exact: true }).click());
    expect((await parseAnalysisRecord(unrooted)).resultId).toBe(original.record.resultId);
    const path = info.outputPath('browser-rooted.json'); await writeFile(path, content, { flag: 'wx' });
    const replay = JSON.parse(execFileSync('bun', [launcher, 'phylogeny', 'replay', '--experiment', path], { cwd: dirname(path), encoding: 'utf8' }));
    expect(replay.resultId).toBe(rooted.resultId); expect(replay.verified).toBe(true);
    await rootControls().getByLabel('Root fraction from the outgroup-side endpoint', { exact: true }).fill('0.75');
    await expect(rootResult()).toHaveCount(0); await expect(rootExport()).toBeDisabled();
    await expect(originalResult()).toHaveAttribute('data-result-id', original.record.resultId);
    await rootControls().getByRole('button', { name: 'Create rooted hypothesis', exact: true }).click();
    await expect(rootResult()).toBeVisible(); await expect(rootResult()).not.toHaveAttribute('data-root-result-id', rooted.resultId);
    await rootControls().getByLabel('Outgroup taxa (explicit selection)', { exact: true }).selectOption(['A', 'C']);
    await rootControls().getByRole('button', { name: 'Create rooted hypothesis', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('one tree edge');
    await expect(originalResult()).toHaveAttribute('data-result-id', original.record.resultId); await expect(rootExport()).toBeDisabled();
    await load(content); await expect(rootResult()).toHaveAttribute('data-root-result-id', rooted.resultId);
    await expect(rootControls().getByLabel('Root fraction from the outgroup-side endpoint', { exact: true })).toHaveValue('0.25');
    await expect(rootControls().getByLabel('Outgroup and branch-placement evidence', { exact: true })).toHaveValue(evidence);
    const fields = structuredClone(rooted.fields); fields.rooting.value = { invented: true };
    await load(serializeAnalysisRecord(await createAnalysisRecord({ ...rooted, fields })));
    await expect(panel.getByRole('alert')).toContainText('Recomputed rooted phylogeny differs');
    await expect(originalResult()).toHaveCount(0); await expect(rootExport()).toHaveCount(0);
    expect(privateLeak).toBe(false); expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
