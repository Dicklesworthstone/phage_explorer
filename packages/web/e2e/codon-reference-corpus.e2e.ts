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
