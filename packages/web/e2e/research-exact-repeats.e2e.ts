/** Native UI/worker journey. Expected coordinates are hand-enumerated, not imported from the scanner. */
import { test, expect, type Page } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

async function localPanel(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill('Local genomes: import or export');
  await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
  const panel = page.getByTestId('overlay-genomeImport'); await expect(panel).toBeVisible(); return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Missing exported repeat data.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('exact repeat pairs expose truncation, export coordinates and replay original inputs after reload', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let leaked = false;
  page.on('request', request => {
    if (`${request.url()} ${request.postData() ?? ''}`.includes('ACGTNNACGTACGT')) leaked = true;
  });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await localPanel(page);
    await panel.getByLabel('Choose genome file').setInputFiles({ name: 'repeat.fa', mimeType: 'text/plain', buffer: Buffer.from('>REPEAT_FIXTURE\nACGTNNACGTACGT\n') });
    await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(panel).toContainText('1 local records ready');
    await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(panel).not.toBeVisible(); panel = await localPanel(page);
    let workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
    await workflow.getByLabel('Workflow minimum repeat arm').fill('4');
    await workflow.getByLabel('Workflow maximum repeat gap').fill('20');
    await workflow.getByLabel('Workflow exact pair limit').fill('1');
    await workflow.getByRole('button', { name: 'Run and record exact repeat pairs', exact: true }).click();
    await expect(workflow.getByRole('region', { name: 'Exact repeat-pair results' })).toContainText('Incomplete ordered prefix');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export exact repeat pairs TSV', exact: true }).click())).toContain('complete=false');
    await workflow.getByLabel('Workflow exact pair limit').fill('2000');
    await workflow.getByRole('button', { name: 'Run and record exact repeat pairs', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('recording · 2 recorded commands');
    const initial = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(initial.fields.search.value.complete).toBe(true);
    expect(initial.fields.pairs.value.map((p: { type: string; leftStart: number; rightStart: number }) => [p.type, p.leftStart, p.rightStart])).toEqual([
      ['direct', 0, 6], ['inverted', 0, 6], ['direct', 0, 10], ['direct', 6, 10], ['inverted', 0, 10], ['inverted', 6, 10],
    ]);
    await workflow.getByLabel('Workflow minimum repeat arm').fill('5');
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export exact repeat pairs TSV', exact: true }).click())).toContain('armLength=4');
    await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
    const tape = await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click());
    await page.reload(); await expectExplorerIdentity(page, info);
    panel = await localPanel(page); workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByLabel('Load research workflow JSON').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(tape) });
    await expect(workflow).toContainText('1 bundled genomes validated');
    await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
    await workflow.getByRole('button', { name: 'Add workflow genomes', exact: true }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('REPEAT_FIXTURE');
    await workflow.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('Verified 2 commands');
    expect(JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()))).toEqual(initial);
    expect(pageErrors).toEqual([]); expect(leaked).toBe(false);
  } finally { await finalize(); }
});

test('complete-circle repeat assertion, wrapped TSV and mixed-topology recording survive reload without changing draft defaults', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const sequence = 'GA' + 'N'.repeat(4) + 'ACGA' + 'N'.repeat(8) + 'AC';
  let leaked = false;
  page.on('request', request => { if (`${request.url()} ${request.postData() ?? ''}`.includes(sequence)) leaked = true; });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await localPanel(page);
    await panel.getByLabel('Choose genome file').setInputFiles({ name: 'circle.fa', mimeType: 'text/plain', buffer: Buffer.from(`>CIRCLE_FIXTURE\n${sequence}\n`) });
    await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(panel).toContainText('1 local records ready');
    await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(panel).not.toBeVisible(); panel = await localPanel(page);
    let workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
    await workflow.getByLabel('Workflow minimum repeat arm').fill('4');
    await workflow.getByLabel('Workflow maximum repeat gap').fill('4');
    await expect(workflow.getByLabel('Exact repeat input topology')).toHaveValue('linear');
    await workflow.getByRole('button', { name: 'Run and record exact repeat pairs', exact: true }).click();
    await expect(workflow.getByRole('region', { name: 'Exact repeat-pair results' })).toContainText('0 pairs retained');
    await workflow.getByLabel('Exact repeat input topology').selectOption('circular');
    await workflow.getByRole('button', { name: 'Run and record exact repeat pairs', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('recording · 2 recorded commands');
    const table = workflow.getByRole('table', { name: 'Exact repeat-pair coordinates' });
    await expect(table).toContainText('[18, 20) → [0, 2)'); await expect(table).toContainText('[6, 10)');
    const initial = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(initial.method.version).toBe('2'); expect(initial.parameters.topology).toBe('circular');
    expect(initial.fields.pairs.value).toEqual([{ type: 'direct', leftStart: 18, leftEnd: 22, rightStart: 6, rightEnd: 10, gap: 4 }]);
    await workflow.getByLabel('Exact repeat input topology').selectOption('linear');
    const tsv = await download(page, () => workflow.getByRole('button', { name: 'Export exact repeat pairs TSV', exact: true }).click());
    expect(tsv).toContain('topology=circular'); expect(tsv).toContain('direct\t18\t22\t6\t10\t4\t[18,20);[0,2)\t[6,10)');
    await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
    const tape = await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click());
    expect(JSON.parse(tape).commands.map((command: { parameters: { topology?: string } }) => command.parameters.topology ?? 'linear')).toEqual(['linear', 'circular']);
    await page.reload(); await expectExplorerIdentity(page, info);
    panel = await localPanel(page); workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByLabel('Load research workflow JSON').setInputFiles({ name: 'circular-workflow.json', mimeType: 'application/json', buffer: Buffer.from(tape) });
    await expect(workflow).toContainText('1 bundled genomes validated');
    await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
    await workflow.getByRole('button', { name: 'Add workflow genomes', exact: true }).click();
    await workflow.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('Verified 2 commands');
    await expect(workflow.getByLabel('Exact repeat input topology')).toHaveValue('linear');
    await expect(workflow.getByRole('region', { name: 'Exact repeat-pair results' })).toContainText('Submitted topology: complete circular molecule');
    expect(JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()))).toEqual(initial);
    expect(pageErrors).toEqual([]); expect(leaked).toBe(false);
  } finally { await finalize(); }
});
