/** Full application/Worker/download path. These assertions need a native browser run. */
import { test, expect, type Page } from '@playwright/test';
import { setupTestHarness, expectExplorerIdentity } from './e2e-harness';

async function downloaded(page: Page, click: () => Promise<void>): Promise<string> {
  const next = page.waitForEvent('download'); await click();
  const stream = await (await next).createReadStream();
  if (!stream) throw new Error('Missing VCF download stream');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('haploid VCF and matching reference retain accepted settings through draft edits and saved replay', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('overlay-commandPalette');
    await palette.getByRole('combobox').fill('Pangenome');
    await palette.getByRole('option').filter({ hasText: 'Pangenome' }).first().click();
    const panel = page.getByTestId('overlay-pangenomeGraph');
    await panel.getByText('Paste sequences or inspect supported input', { exact: true }).click();
    await panel.getByLabel('Paste pangenome FASTA').fill('>ref\nACGT\n>a\nATGT\n>b\nAGGT\n>unknown\nANGT');
    await panel.getByRole('button', { name: 'Load pasted sequences', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Export haploid variants VCF', exact: true })).toBeDisabled();
    await panel.getByLabel('Pangenome reference sequence').selectOption('ref');
    await panel.getByLabel('Pangenome alignment mode').selectOption('provided');
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect(panel.getByTestId('pangenome-result')).toBeVisible();
    const id = await panel.getByTestId('pangenome-result').getAttribute('data-result-id');
    const vcf = await downloaded(page, () => panel.getByRole('button', { name: 'Export haploid variants VCF', exact: true }).click());
    expect(vcf).toContain(`##phage_explorer_result=${id}`);
    expect(vcf.split('\n').filter(line => line && !line.startsWith('#'))).toEqual([
      'reference\t2\t.\tC\tG,T\t.\t.\tAC=1,1;AN=2\tGT\t2\t1\t.',
    ]);
    const fasta = await downloaded(page, () => panel.getByRole('button', { name: 'Export VCF reference FASTA', exact: true }).click());
    expect(fasta).toBe('>reference original_id_uri=ref\nACGT\n');
    // Another reference is a draft only. Downloads must still match each other.
    await panel.getByLabel('Pangenome reference sequence').selectOption('a');
    await expect(panel).toContainText('Edited settings are not applied');
    expect(await downloaded(page, () => panel.getByRole('button', { name: 'Export haploid variants VCF', exact: true }).click())).toBe(vcf);
    const saved = await downloaded(page, () => panel.getByRole('button', { name: 'Export pangenome analysis', exact: true }).click());
    await panel.getByLabel('Import pangenome FASTA, dataset JSON or saved analysis').setInputFiles({ name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect(panel).toContainText('Verified pangenome replay');
    expect(await downloaded(page, () => panel.getByRole('button', { name: 'Export haploid variants VCF', exact: true }).click())).toBe(vcf);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
