import { test, expect, type Page, type Locator } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { replayCompatibilityExperiment } from '../../core/src/analysis/alignment-compatibility';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

test.use({ serviceWorkers: 'block' });
const MARKER = 'PRIVATE_COMPATIBILITY_ALIGNMENT';
const fasta = '\uFEFF>' + MARKER + '_a\nCAA\n>' + MARKER + '_b\nCAG\n>' + MARKER + '_c\nCGA\n>' + MARKER + '_d\nCGG\n';
async function open(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill('Mosaic radar');
  await palette.getByRole('option').filter({ hasText: 'Mosaic radar' }).first().click();
  const panel = page.getByRole('region', { name: 'Aligned DNA site compatibility', exact: true });
  await expect(panel).toBeVisible(); return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('No compatibility download stream.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
test('exact alignment evidence exports, saves, freshly replays and rejects rehashed false haplotypes', async ({ page }, info) => {
  test.setTimeout(180_000);
  const { pageErrors, finalize } = setupTestHarness(page, info); let leaked = false;
  page.on('request', request => { if (request.url().includes(MARKER) || request.postData()?.includes(MARKER)) leaked = true; });
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  try {
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await open(page);
    await expect(panel.getByTestId('compatibility-result')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use selected genome and repository panel', exact: true })).toBeVisible();
    await panel.getByLabel('Alignment experiment name', { exact: true }).fill('Private exact alignment');
    await panel.getByLabel('Source reference or provenance', { exact: true }).fill('Hand-constructed browser fixture, not experimental evidence');
    await panel.getByLabel('Source version', { exact: true }).fill('fixture-1');
    await panel.getByLabel('Alignment method', { exact: true }).fill('Exact synthetic columns');
    await panel.getByLabel('Alignment evidence or explicit hypothesis', { exact: true }).fill('Supplied three-column hypothesis');
    await panel.getByLabel('Aligned FASTA file', { exact: true }).setInputFiles({ name: 'private.fa', mimeType: 'text/plain', buffer: Buffer.from(fasta) });
    await panel.getByLabel('I declare that these supplied columns are intended to be homologous. The app does not align or validate homology.', { exact: true }).check();
    await panel.getByRole('button', { name: 'Calculate aligned-site compatibility', exact: true }).click();
    const result = panel.getByTestId('compatibility-result');
    await expect(result).toBeVisible();
    await expect(panel.getByTestId('compatibility-summary')).toContainText('1 incompatible pairs / 1 compared pairs');
    await expect(panel.getByTestId('compatibility-summary')).toContainText('2 eligible columns / 3 selected columns');
    const witnesses = panel.getByRole('region', { name: 'Selected pair haplotypes', exact: true });
    await expect(witnesses).toContainText('Original alignment columns 2 and 3');
    for (const suffix of ['_a', '_b', '_c', '_d']) await expect(witnesses).toContainText(MARKER + suffix);
    const exported = await download(page, () => panel.getByRole('button', { name: 'Export complete compatibility experiment', exact: true }).click());
    const record = await parseAnalysisRecord(exported), replay = await replayCompatibilityExperiment(exported);
    expect(replay.input.alignment.fasta).toBe(fasta);
    expect(replay.result.sites.map(site => site.column)).toEqual([1, 2]);
    expect(replay.result.pairs).toEqual([[0, 1, 1, 1, 1, 1]]);
    expect(await download(page, () => panel.getByRole('button', { name: 'Export all selected sites TSV', exact: true }).click())).toContain('1\tmonomorphic\t0\t4\t0\t0\t0');
    await panel.getByLabel('Show only incompatible pairs', { exact: true }).check();
    expect(await download(page, () => panel.getByRole('button', { name: 'Export all compared pairs TSV', exact: true }).click())).toContain('2\t3\tA\tG\tA\tG\t1\t1\t1\t1\tyes');

    await panel.getByLabel('Alignment experiment name', { exact: true }).fill('Unaccepted draft name');
    await panel.getByLabel('Aligned DNA FASTA', { exact: true }).fill('>bad\nAAAA');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    await expect(result).toContainText('Private exact alignment');
    const saved = panel.locator('details[aria-label="Saved aligned-site compatibility experiments"]');
    await saved.locator('summary').click();
    await saved.getByLabel('Snapshot name', { exact: true }).fill('Private four-gamete evidence');
    await saved.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Saved an immutable');

    await page.reload(); await expectExplorerIdentity(page, info); panel = await open(page);
    await expect(panel.getByTestId('compatibility-result')).toHaveCount(0);
    const restored = panel.locator('details[aria-label="Saved aligned-site compatibility experiments"]');
    await restored.locator('summary').click();
    await expect(restored.getByLabel('Saved snapshot', { exact: true }).locator('option')).toHaveCount(2);
    await restored.getByLabel('Saved snapshot', { exact: true }).selectOption({ index: 1 });
    await restored.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
    await expect(restored.getByRole('status')).toContainText('recomputed and verified');
    await expect(panel.getByTestId('compatibility-result')).toHaveAttribute('data-result-id', record.resultId);
    await expect(panel.getByTestId('compatibility-result')).toContainText('Verified replay');
    expect(await download(page, () => restored.getByRole('button', { name: 'Export saved JSON', exact: true }).click())).toBe(exported);

    const edited = structuredClone(record);
    (edited.fields.compatibility.value as unknown as { pairs: number[][] }).pairs[0][2] = 9;
    const rehashed = serializeAnalysisRecord(await createAnalysisRecord(edited));
    await panel.getByLabel('Reopen and verify compatibility experiment JSON', { exact: true }).setInputFiles({ name: 'rehashed-false-result.json', mimeType: 'application/json', buffer: Buffer.from(rehashed) });
    await expect(panel.getByRole('alert')).toContainText('Fresh aligned-site calculation differs');
    await expect(panel.getByTestId('compatibility-result')).toHaveAttribute('data-result-id', record.resultId);
    expect(leaked).toBe(false); expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
