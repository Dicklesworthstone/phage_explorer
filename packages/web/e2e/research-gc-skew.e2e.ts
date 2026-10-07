/** Private import -> exact counting -> portable workflow -> fresh replay -> viewer restore. */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

async function panel(page: Page, title: string, id: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill(title);
  await palette.getByRole('option').filter({ hasText: title }).first().click();
  const target = page.getByTestId(`overlay-${id}`); await expect(target).toBeVisible(); return target;
}
async function download(page: Page, action: () => Promise<void>) {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing GC-skew export.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
async function ready(page: Page, info: TestInfo) {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, info);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
}

test('GC-skew workflow preserves unavailable windows, explicit parameters and exact replay across reload and viewer restore', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const sequence = 'NNNNGGCCGGGG'; let leaked = false;
  page.on('request', request => { if (`${request.url()} ${request.postData() ?? ''}`.includes(sequence)) leaked = true; });
  try {
    await ready(page, info);
    let importer = await panel(page, 'Local genomes: import or export', 'genomeImport');
    await importer.getByLabel('Choose genome file').setInputFiles({ name: 'private-gc.fa', mimeType: 'text/plain', buffer: Buffer.from(`>GC_WORKFLOW\n${sequence}\n`) });
    await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(importer).toContainText('1 local records ready');
    await importer.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(importer).not.toBeVisible();
    importer = await panel(page, 'Local genomes: import or export', 'genomeImport');
    let workflow = importer.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
    await workflow.getByLabel('Workflow GC-skew window (bp)', { exact: true }).fill('4');
    await workflow.getByLabel('Workflow GC-skew step (bp)', { exact: true }).fill('4');
    await workflow.getByRole('button', { name: 'Run and record GC skew', exact: true }).click();
    await expect(workflow.getByRole('table', { name: 'Recorded GC-skew window counts' })).toContainText('Unavailable');
    await expect(workflow.getByTestId('workflow-status')).toContainText('recording · 1 recorded commands');
    const originalText = await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click());
    const original = JSON.parse(originalText);
    expect(original.inputs[0].data).toBe(sequence); expect(original.method.version).toBe('2');
    expect(original.parameters).toEqual({ windowSize: 4, stepSize: 4 });
    expect(original.fields.windows.value).toEqual([
      { start: 0, end: 4, g: 0, c: 0, resolvedBases: 0, skew: null, cumulative: 0 },
      { start: 4, end: 8, g: 2, c: 2, resolvedBases: 4, skew: 0, cumulative: 1 },
      { start: 8, end: 12, g: 4, c: 0, resolvedBases: 4, skew: 1, cumulative: 1 },
    ]);
    await workflow.getByLabel('Workflow GC-skew step (bp)', { exact: true }).fill('3');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export GC-skew windows TSV', exact: true }).click())).toContain('0\t4\t0\t0\t0\t\t0');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click())).toBe(originalText);
    await workflow.getByLabel('Workflow position (0-based view coordinate)', { exact: true }).fill('8');
    await workflow.getByRole('button', { name: 'Apply and record view', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('recording · 2 recorded commands');
    await expect(workflow.getByTestId('workflow-view')).toContainText('position 8');
    await expect(workflow.getByTestId('workflow-result')).toContainText('The last accepted analysis remains available with its original inputs and parameters.');
    await expect(workflow.getByTestId('workflow-result')).toContainText('Analysis inputs: GC_WORKFLOW');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click())).toBe(originalText);
    await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
    const tape = await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click());
    await page.reload(); await expectExplorerIdentity(page, info);
    importer = await panel(page, 'Local genomes: import or export', 'genomeImport');
    workflow = importer.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByLabel('Load research workflow JSON').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(tape) });
    await expect(workflow).toContainText('1 bundled genomes validated');
    await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
    await workflow.getByRole('button', { name: 'Add workflow genomes', exact: true }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('GC_WORKFLOW');
    await workflow.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('Verified 2 commands');
    await expect(workflow.getByTestId('workflow-view')).toContainText('position 8');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click())).toBe(originalText);
    await page.keyboard.press('Escape'); await expect(importer).not.toBeVisible();
    const gc = await panel(page, 'GC skew analysis', 'gcSkew');
    await gc.getByLabel('Restore GC-skew experiment (.json)', { exact: true }).setInputFiles({ name: 'gc.json', mimeType: 'application/json', buffer: Buffer.from(originalText) });
    await expect(gc).toContainText('Replay matched: freshly computed GC-skew values and evidence agree.');
    expect(await download(page, () => gc.getByRole('button', { name: 'Export GC skew experiment', exact: true }).click())).toBe(originalText);
    await expect(gc.getByRole('img', { name: 'GC skew graph showing cumulative nucleotide bias across genome position' })).toBeVisible();
    expect(pageErrors).toEqual([]); expect(leaked).toBe(false);
  } finally { await finalize(); }
});

test('accelerated GC-skew export restores explicit spacing and refuses a different selected sequence', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await ready(page, info);
    const importer = await panel(page, 'Local genomes: import or export', 'genomeImport');
    await importer.getByLabel('Choose genome file').setInputFiles({ name: 'gc.fa', mimeType: 'text/plain', buffer: Buffer.from('>GC_VIEWER\nGGCCNATGGCC\n>GC_OTHER\nCCCCCCCCCCC\n') });
    await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(importer).toContainText('2 local records ready');
    await importer.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(importer).not.toBeVisible();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('GC_VIEWER');
    let gc = await panel(page, 'GC skew analysis', 'gcSkew');
    await gc.getByLabel('GC-skew window (bp)', { exact: true }).fill('4');
    await gc.getByLabel('GC-skew step (bp)', { exact: true }).fill('2');
    await gc.getByRole('button', { name: /^(Run|Restart) GC-skew analysis$/ }).click();
    await expect(gc.getByRole('button', { name: 'Export GC skew experiment' })).toBeVisible();
    const text = await download(page, () => gc.getByRole('button', { name: 'Export GC skew experiment' }).click());
    const record = JSON.parse(text);
    expect(record.parameters).toMatchObject({ windowSize: 4, stepSize: 2 });
    expect(record.fields.cumulative.value).toEqual([1, 1, 0, 0]);
    expect(record.fields.skew.value).toEqual([0, -1, 1, 1 / 3]);
    await gc.getByLabel('Restore GC-skew experiment (.json)', { exact: true }).setInputFiles({ name: 'saved-gc.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(gc).toContainText('Replay matched: freshly computed GC-skew values and evidence agree.');
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: 'GC_OTHER' }).click();
    gc = await panel(page, 'GC skew analysis', 'gcSkew');
    await gc.getByLabel('Restore GC-skew experiment (.json)', { exact: true }).setInputFiles({ name: 'wrong-genome.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(gc.getByRole('alert')).toContainText('sequence does not match the selected genome');
    await expect(gc.getByRole('button', { name: 'Export GC skew experiment' })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
