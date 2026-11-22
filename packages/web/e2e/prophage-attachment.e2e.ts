import { test, expect, type Page, type Locator } from '@playwright/test';
import { parseAnalysisRecord } from '../../core/src/analysis-result';
import { replayAttachmentExperiment } from '../../core/src/analysis/prophage-excision';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

test.use({ serviceWorkers: 'block' });
const MARKER = 'ATTACHMENT_PRIVATE_PHAGE';
async function palette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k');
  const panel = page.getByTestId('overlay-commandPalette');
  await panel.getByRole('combobox').fill(title);
  await panel.getByRole('option').filter({ hasText: title }).first().click();
}
async function open(page: Page): Promise<Locator> {
  await palette(page, 'Prophage excision');
  const panel = page.getByRole('region', { name: 'Supplied attachment reconstruction', exact: true });
  await expect(panel).toBeVisible(); return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('No attachment download stream.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
async function setSite(panel: Locator, name: string): Promise<void> {
  const site = panel.getByRole('group', { name: name + ' shared crossover core', exact: true });
  await site.getByLabel('Start base (1-based inclusive)', { exact: true }).fill('3');
  await site.getByLabel('End base (1-based inclusive)', { exact: true }).fill('4');
  await site.getByLabel('Evidence or explicit hypothesis', { exact: true }).fill('Synthetic AC core declaration, not biological evidence.');
}
const fastaBases = (content: string) => content.split('\n').filter(line => !line.startsWith('>')).join('');

test('supplied attachment products retain exact sources through edits, downloads, catalog navigation and saved replay', async ({ page }, info) => {
  test.setTimeout(180000);
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let leaked = false;
  page.on('request', request => { if (request.url().includes(MARKER) || request.postData()?.includes(MARKER)) leaked = true; });
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  try {
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await palette(page, 'Local genomes: import or export');
    const importer = page.getByTestId('overlay-genomeImport');
    await importer.getByLabel('Paste genome data', { exact: true }).fill('>' + MARKER + '\nCCACAA\n');
    await importer.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(importer.getByRole('button', { name: 'Add records to explorer', exact: true })).toBeVisible();
    await importer.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(importer).toBeHidden();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText(MARKER);

    let panel = await open(page);
    await expect(panel.getByTestId('attachment-result')).toHaveCount(0);
    await panel.getByLabel('Host locus name', { exact: true }).fill('SYNTHETIC_HOST_LOCUS');
    await panel.getByLabel('Host sequence · one FASTA record or raw A/C/G/T', { exact: true }).fill('>synthetic-host\nTTACGG\n');
    await panel.getByLabel('Host source reference or provenance', { exact: true }).fill('Hand-constructed browser fixture; not experimental data.');
    await panel.getByLabel('Host source version', { exact: true }).fill('fixture-1');
    await panel.getByLabel('Host license or permissions (optional)', { exact: true }).fill('CC0');
    await setSite(panel, 'attB · host'); await setSite(panel, 'attP · phage');
    await panel.getByLabel('Phage circularization declaration', { exact: true }).selectOption('assumed-circularized');
    await panel.getByLabel('Junction flank bases (0–1000)', { exact: true }).fill('2');
    await panel.getByRole('button', { name: 'Reconstruct declared attachment sites', exact: true }).click();
    const result = panel.getByTestId('attachment-result');
    await expect(result).toBeVisible();
    await expect(result.getByRole('region', { name: 'Accepted Phage source', exact: true })).toContainText(MARKER);
    const exported = await download(page, () => panel.getByRole('button', { name: 'Export complete attachment experiment', exact: true }).click());
    const record = await parseAnalysisRecord(exported), replay = await replayAttachmentExperiment(exported);
    expect(replay.input.host.sequence).toBe('TTACGG'); expect(replay.input.phage.sequence).toBe('CCACAA');
    expect(replay.input.phage.name).toBe(MARKER);
    expect(replay.input.attB).toMatchObject({ start: 2, end: 4, strand: '+' });
    expect(replay.input.attP).toMatchObject({ start: 2, end: 4, strand: '+' });
    expect(replay.input.circularization).toBe('assumed-circularized');
    expect(replay.result.integratedSequence).toBe('TTACAACCACGG');
    expect(replay.result.attL.sequence).toBe('TTACAA'); expect(replay.result.attR.sequence).toBe('CCACGG');
    expect(fastaBases(await download(page, () => panel.getByRole('button', { name: 'Export integrated sequence FASTA', exact: true }).click()))).toBe('TTACAACCACGG');

    // Editing a draft cannot relabel or replace an accepted product.
    await panel.getByLabel('Host locus name', { exact: true }).fill('UNACCEPTED_HOST_EDIT');
    await panel.getByLabel('Host sequence · one FASTA record or raw A/C/G/T', { exact: true }).fill('AAAAAA');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    expect((await parseAnalysisRecord(await download(page,
      () => panel.getByRole('button', { name: 'Export complete attachment experiment', exact: true }).click()))).resultId).toBe(record.resultId);
    const saved = panel.locator('details[aria-label="Saved attachment experiments"]');
    await saved.locator('summary').click();
    await saved.getByLabel('Snapshot name', { exact: true }).fill('Synthetic attachment proof');
    await saved.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Saved an immutable');

    // Catalog navigation invalidates unfinished source work, while accepted evidence keeps its own identities.
    await palette(page, 'Enterobacteria phage lambda');
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
    await expect(panel.getByTestId('attachment-selected-phage')).toContainText('Enterobacteria phage lambda');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    await expect(result.getByRole('region', { name: 'Accepted Phage source', exact: true })).toContainText(MARKER);
    await expect(result.getByRole('region', { name: 'Accepted Host source', exact: true })).toContainText('SYNTHETIC_HOST_LOCUS');

    await page.reload(); await expectExplorerIdentity(page, info);
    panel = await open(page);
    await expect(panel.getByTestId('attachment-result')).toHaveCount(0);
    const restored = panel.locator('details[aria-label="Saved attachment experiments"]');
    await restored.locator('summary').click();
    await expect(restored.getByLabel('Saved snapshot', { exact: true }).locator('option')).toHaveCount(2);
    await restored.getByLabel('Saved snapshot', { exact: true }).selectOption({ index: 1 });
    await restored.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
    await expect(restored.getByRole('status')).toContainText('recomputed and verified');
    await expect(panel.getByTestId('attachment-result')).toHaveAttribute('data-result-id', record.resultId);
    await expect(panel.getByTestId('attachment-result')).toContainText(MARKER);
    await expect(panel.getByTestId('attachment-result')).toContainText('Verified replay');
    expect(await download(page, () => restored.getByRole('button', { name: 'Export saved JSON', exact: true }).click())).toBe(exported);
    const tampered = JSON.parse(exported); tampered.resultId = '0'.repeat(64);
    await panel.getByLabel('Reopen and verify attachment experiment JSON', { exact: true }).setInputFiles({
      name: 'damaged-attachment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)),
    });
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByTestId('attachment-result')).toHaveAttribute('data-result-id', record.resultId);
    expect(leaked).toBe(false); expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
