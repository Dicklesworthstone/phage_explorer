/** Native browser coverage for scoring controls, real worker output and saved v6 replay.
 * Must run in the full application; isolated callback tests are not a substitute.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness, expectExplorerIdentity } from './e2e-harness';

async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Missing exported analysis');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
test('affine settings bind numerical results, exports and reopened experiments', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('overlay-commandPalette');
    await palette.getByRole('combobox').fill('Pangenome');
    await palette.getByRole('option').filter({ hasText: 'Pangenome' }).first().click();
    const panel = page.getByTestId('overlay-pangenomeGraph');
    await panel.getByText('Paste sequences or inspect supported input', { exact: true }).click();
    await panel.getByLabel('Paste pangenome FASTA').fill('>r\nACGT\n>q\nAGGT\n');
    await panel.getByRole('button', { name: 'Load pasted sequences', exact: true }).click();
    await panel.getByLabel('Pangenome reference sequence').selectOption('r');
    await panel.getByLabel('Pangenome alignment mode').selectOption('affine');
    await panel.getByLabel('Mismatch cost', { exact: true }).fill('9');
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    const row = panel.getByRole('table', { name: 'Affine alignment costs' }).getByRole('row').nth(1);
    await expect(row.getByRole('cell').nth(1)).toHaveText('9');
    const id = await panel.getByTestId('pangenome-result').getAttribute('data-result-id');
    await panel.getByLabel('Mismatch cost', { exact: true }).fill('2');
    await expect(panel).toContainText('Edited settings are not applied');
    await expect(row.getByRole('cell').nth(1)).toHaveText('9');
    const content = await download(page, () => panel.getByRole('button', { name: 'Export pangenome analysis', exact: true }).click());
    const saved = JSON.parse(content);
    expect(saved.method.version).toBe('6'); expect(saved.parameters.affinePenalties.mismatch).toBe(9);
    expect(saved.resultId).toBe(id);
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect(row.getByRole('cell').nth(1)).toHaveText('2');
    await panel.getByLabel('Mismatch cost', { exact: true }).fill('0');
    await expect(panel.getByRole('button', { name: 'Build sequence graph', exact: true })).toBeDisabled();
    await expect(panel.getByRole('alert')).toContainText('Affine penalties');
    await panel.getByLabel('Import pangenome FASTA, dataset JSON or saved analysis').setInputFiles({ name: 'affine.json', mimeType: 'application/json', buffer: Buffer.from(content) });
    await expect(panel).toContainText('Verified pangenome replay');
    await expect(panel.getByTestId('pangenome-result')).toHaveAttribute('data-result-id', id!);
    await expect(panel.getByLabel('Mismatch cost', { exact: true })).toHaveValue('9');
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
