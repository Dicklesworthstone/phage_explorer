/** Native browser journey: source-count and CAI expectations are independently hand-derived. */
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
  const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing reference export.');
  const chunks: Buffer[] = []; for await (const part of stream) chunks.push(Buffer.from(part));
  return Buffer.concat(chunks).toString('utf8');
}
const gb = (id: string, sequence: string) => `LOCUS       ${id} ${sequence.length} bp DNA linear\nDEFINITION  ${id}\nACCESSION   ${id}\nFEATURES             Location/Qualifiers\n     CDS             1..${sequence.length}\nORIGIN\n        1 ${sequence}\n//\n`;

test('source-backed reference counts, query scores and complete source replay survive a fresh browser session', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info); let leaked = false;
  page.on('request', request => { if (`${request.url()} ${request.postData() ?? ''}`.includes('PRIVATE_CORPUS_FIXTURE')) leaked = true; });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await localPanel(page);
    await panel.getByLabel('Choose genome file').setInputFiles({ name: 'corpus.gb', mimeType: 'text/plain', buffer: Buffer.from(
      gb('PRIVATE_CORPUS_FIXTURE', 'ATGAAAAAAAAAAAGTAA') + gb('PRIVATE_QUERY_FIXTURE', 'ATGAAAAAGTAA')) });
    await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(panel).toContainText('2 local records ready');
    await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(panel).not.toBeVisible(); panel = await localPanel(page);
    let view = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
    await view.getByText('Build reference counts from imported GenBank', { exact: true }).click();
    const selector = view.getByLabel('Corpus source genome');
    const sourceId = await selector.locator('option').filter({ hasText: 'PRIVATE_CORPUS_FIXTURE' }).getAttribute('value');
    await selector.selectOption(sourceId!);
    await view.getByLabel('Corpus name', { exact: true }).fill('Test reference');
    await view.getByLabel('Corpus organism (your assertion)').fill('Synthetic fixture');
    await view.getByLabel('Corpus citation and selection rationale').fill('One hand-enumerated CDS; not expression evidence');
    await view.getByLabel('Corpus source version').fill('fixture-1');
    await view.getByLabel('Corpus genetic code').selectOption('1');
    await view.getByRole('button', { name: 'Build and use source-backed reference', exact: true }).click();
    await expect(view.getByRole('region', { name: 'Accepted reference corpus audit' })).toContainText('Counted CDS: 1/1');
    const countText = await download(page, () => view.getByRole('button', { name: 'Export count-only reference JSON', exact: true }).click());
    expect(JSON.parse(countText).counts.AAA).toBe(3); expect(JSON.parse(countText).counts.AAG).toBe(1);
    expect(Object.keys(JSON.parse(countText).counts)).toHaveLength(64);
    await view.getByLabel('Corpus name', { exact: true }).fill('Draft not yet submitted');
    expect(JSON.parse(await download(page, () => view.getByRole('button', { name: 'Export count-only reference JSON', exact: true }).click())).name).toBe('Test reference');
    const query = view.getByLabel('Reference-analysis genome');
    await query.selectOption((await query.locator('option').filter({ hasText: 'PRIVATE_QUERY_FIXTURE' }).getAttribute('value'))!);
    await view.getByRole('button', { name: 'Analyze against reference', exact: true }).click();
    await expect(view).toContainText('0.577350');
    const saved = await download(page, () => view.getByRole('button', { name: 'Export reference experiment', exact: true }).click());
    expect(JSON.parse(saved).method.version).toBe('2');
    const embedded = JSON.parse(JSON.parse(saved).inputs.find((i: { id: string }) => i.id === 'reference').data);
    expect(embedded.method.id).toBe('genbank-codon-reference');
    expect(embedded.inputs[0].data.text).toContain('PRIVATE_CORPUS_FIXTURE');
    await page.reload(); await expectExplorerIdentity(page, info); panel = await localPanel(page);
    view = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
    await view.getByLabel('Reopen and verify reference experiment').setInputFiles({ name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect(view).toContainText('Saved experiment recomputed'); await expect(view).toContainText('0.577350');
    expect(JSON.parse(await download(page, () => view.getByRole('button', { name: 'Export reference experiment', exact: true }).click()))).toEqual(JSON.parse(saved));
    expect(pageErrors).toEqual([]); expect(leaked).toBe(false);
  } finally { await finalize(); }
});

test('recorded source-backed and count-only codon commands retain exact references and replay after reload', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info); let leaked = false;
  page.on('request', request => { if (`${request.url()} ${request.postData() ?? ''}`.includes('PRIVATE_RECORDED_CODON')) leaked = true; });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await localPanel(page);
    await panel.getByLabel('Choose genome file').setInputFiles({ name: 'recorded.gb', mimeType: 'text/plain', buffer: Buffer.from(
      gb('PRIVATE_RECORDED_CODON_REFERENCE', 'ATG' + 'AAA'.repeat(4) + 'AAGTAA') + gb('PRIVATE_RECORDED_CODON_QUERY', 'ATGAAAAAGTAA')) });
    await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(panel).toContainText('2 local records ready');
    await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(panel).not.toBeVisible(); panel = await localPanel(page);
    const builder = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
    await builder.getByText('Build reference counts from imported GenBank', { exact: true }).click();
    const sourceSelect = builder.getByLabel('Corpus source genome');
    await sourceSelect.selectOption((await sourceSelect.locator('option').filter({ hasText: 'PRIVATE_RECORDED_CODON_REFERENCE' }).getAttribute('value'))!);
    await builder.getByLabel('Corpus name', { exact: true }).fill('Recorded reference');
    await builder.getByLabel('Corpus organism (your assertion)').fill('Synthetic fixture');
    await builder.getByLabel('Corpus citation and selection rationale').fill('Hand-counted synthetic triplets; no expression claim');
    await builder.getByLabel('Corpus source version').fill('fixture-1');
    await builder.getByLabel('Corpus genetic code').selectOption('1');
    await builder.getByRole('button', { name: 'Build and use source-backed reference', exact: true }).click();
    await expect(builder.getByRole('region', { name: 'Accepted reference corpus audit' })).toContainText('Counted CDS: 1/1');
    const source = await download(page, () => builder.getByRole('button', { name: 'Export source corpus experiment', exact: true }).click());
    const counts = JSON.parse(await download(page, () => builder.getByRole('button', { name: 'Export count-only reference JSON', exact: true }).click()));
    expect(counts.counts.AAA).toBe(4); expect(counts.counts.AAG).toBe(1);
    let workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
    const query = workflow.getByLabel('Workflow genome', { exact: true });
    await query.selectOption((await query.locator('option').filter({ hasText: 'PRIVATE_RECORDED_CODON_QUERY' }).getAttribute('value'))!);
    await workflow.getByLabel('Workflow codon reference JSON').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(source) });
    await expect(workflow.getByTestId('workflow-reference-draft')).toContainText('source.json');
    await expect(workflow.getByTestId('workflow-status')).toContainText('0 recorded commands');
    await workflow.getByRole('button', { name: 'Run and record reference-backed CDS', exact: true }).click();
    await expect(workflow.getByRole('region', { name: 'Recorded reference-codon results' })).toContainText('0.500000');
    const first = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(first.method.version).toBe('2');
    counts.counts.AAG = 0; const zeroCounts = JSON.stringify(counts);
    await workflow.getByLabel('Workflow codon reference JSON').setInputFiles({ name: 'zero.json', mimeType: 'application/json', buffer: Buffer.from(zeroCounts) });
    await expect(workflow.getByTestId('workflow-reference-draft')).toContainText('zero.json');
    await workflow.getByLabel('Workflow reference zero-count replacement').selectOption('0');
    // Draft edits do not relabel or replace the first accepted experiment.
    await expect(workflow.getByRole('region', { name: 'Recorded reference-codon results' })).toContainText('0.500000');
    await workflow.getByRole('button', { name: 'Run and record reference-backed CDS', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('2 recorded commands');
    const last = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(last.method.version).toBe('1'); expect(last.fields.pooledCai.value).toBe(0);
    await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
    const tape = await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click());
    expect(JSON.parse(tape).commands.map((command: { parameters: { referenceText: string } }) => command.parameters.referenceText)).toEqual([source, zeroCounts]);
    await expect(workflow.getByRole('list', { name: 'Recorded workflow commands' })).not.toContainText('ORIGIN');
    await page.reload(); await expectExplorerIdentity(page, info); panel = await localPanel(page);
    workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByLabel('Load research workflow JSON').setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(tape) });
    await expect(workflow).toContainText('2 bundled genomes validated');
    await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
    await workflow.getByRole('button', { name: 'Add workflow genomes', exact: true }).click();
    await workflow.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('Verified 2 commands');
    expect(JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()))).toEqual(last);
    expect(pageErrors).toEqual([]); expect(leaked).toBe(false);
  } finally { await finalize(); }
});
