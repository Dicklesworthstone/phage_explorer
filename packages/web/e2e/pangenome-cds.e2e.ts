/** Annotation input -> real worker -> coding inspection/exports -> verified saved replay.
 * Browser execution is required for acceptance; auxiliary callback tests do not replace this.
 */
import { test, expect, type Page } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const REFERENCE = 'ATGAAATAATTATTCCAT';
const INPUT = `>ref\n${REFERENCE}\n>query\nATGAAGTAATTATTTCAT\n>unknown\nATGNNNTAATTATTCCAT\n`;
const GENBANK = `LOCUS       REF 18 bp DNA linear
ACCESSION   REF
FEATURES             Location/Qualifiers
     CDS             1..9
                     /gene="direct"
     CDS             complement(10..18)
                     /gene="reverse"
ORIGIN
        1 ${REFERENCE}
//
`;
async function palette(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  const panel = page.getByTestId('overlay-commandPalette');
  await panel.getByRole('combobox').fill(title);
  await panel.getByRole('option').filter({ hasText: title }).first().click();
}
async function pangenome(page: Page) {
  await palette(page, 'Pangenome');
  const panel = page.getByTestId('overlay-pangenomeGraph');
  await expect(panel).toBeVisible();
  await panel.getByText('Paste sequences or inspect supported input', { exact: true }).click();
  await panel.getByLabel('Paste pangenome FASTA').fill(INPUT);
  await panel.getByRole('button', { name: 'Load pasted sequences', exact: true }).click();
  await panel.getByLabel('Pangenome reference sequence').selectOption('ref');
  return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Missing exported content');
  const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
});
for (const mode of ['imported', 'file'] as const) {
  test(`pangenome ${mode} GenBank produces exact coding evidence and exports`, async ({ page }, info) => {
    const { pageErrors, finalize } = setupTestHarness(page, info);
    let leaked = false;
    page.on('request', request => {
      if (`${request.url()} ${request.postData() ?? ''}`.includes(REFERENCE)) leaked = true;
    });
    try {
      await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      if (mode === 'imported') {
        await palette(page, 'Local genomes: import or export');
        const panel = page.getByTestId('overlay-genomeImport');
        await panel.getByLabel('Choose genome file').setInputFiles({ name: 'reference.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK) });
        await expect(panel.getByRole('button', { name: 'Parse records', exact: true })).toBeEnabled();
        await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
        await expect(panel).toContainText('18 bases, 2 mapped features');
        await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
      }
      const panel = await pangenome(page);
      const cds = panel.getByRole('region', { name: 'Pangenome coding consequences', exact: true });
      if (mode === 'imported') {
        await cds.getByLabel('Matching imported GenBank').selectOption({ index: 1 });
        await cds.getByRole('button', { name: 'Build with imported CDS annotation', exact: true }).click();
      } else {
        // A wrong annotation cannot replace a successful unannotated experiment.
        await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
        const before = await panel.getByTestId('pangenome-result').getAttribute('data-result-id');
        await cds.getByLabel('Build with GenBank annotation file').setInputFiles({ name: 'wrong.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK.replace(REFERENCE, 'ATGCAATAATTATTCCAT')) });
        await expect(panel.getByRole('alert')).toContainText('exactly one GenBank');
        await expect(panel.getByTestId('pangenome-result')).toHaveAttribute('data-result-id', before!);
        await expect(cds.getByTestId('pangenome-cds-result')).toHaveCount(0);
        await cds.getByLabel('Build with GenBank annotation file').setInputFiles({ name: 'reference.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK) });
      }
      await expect(cds.getByTestId('pangenome-cds-result')).toContainText('3 available, 2 changed, 1 unavailable');
      await cds.getByLabel('Filter coding consequences').selectOption('amino-acid-change');
      const rows = cds.getByRole('table', { name: 'Projected coding consequences' }).locator('tbody tr');
      await expect(rows).toHaveCount(1);
      await rows.getByRole('button', { name: 'reverse · 2', exact: true }).click();
      const detail = cds.getByRole('complementary', { name: 'Coding transcript details' });
      await expect(detail).toContainText('Reference translation: ME*');
      await expect(detail).toContainText('Query translation: MK*');
      const proteins = await download(page, () => cds.getByRole('button', { name: 'Export conceptual proteins FASTA', exact: true }).click());
      expect(proteins.trim().split(/\n(?=>)/).map(block => block.split('\n').slice(1).join(''))).toEqual(['MK*', 'ME*', 'MK*', 'MK*', 'ME*']);
      const table = await download(page, () => cds.getByRole('button', { name: 'Export CDS consequences TSV', exact: true }).click());
      expect(table.trimEnd().split('\n')).toHaveLength(5); expect(table).toContain('unavailable');
      const original = await download(page, () => panel.getByRole('button', { name: 'Export pangenome analysis', exact: true }).click());
      const record = JSON.parse(original); expect(record.method.version).toBe('5');
      await page.reload(); await expectExplorerIdentity(page, info); await palette(page, 'Pangenome');
      const reopened = page.getByTestId('overlay-pangenomeGraph');
      await reopened.getByLabel('Import pangenome FASTA, dataset JSON or saved analysis').setInputFiles({ name: 'coding.json', mimeType: 'application/json', buffer: Buffer.from(original) });
      await expect(reopened.getByTestId('pangenome-cds-result')).toHaveAttribute('data-result-id', record.resultId);
      await expect(reopened).toContainText('Verified pangenome replay');
      expect(await download(page, () => reopened.getByRole('button', { name: 'Export conceptual proteins FASTA', exact: true }).click())).toBe(proteins);
      expect(leaked).toBe(false); expect(pageErrors).toEqual([]);
    } finally { await finalize(); }
  });
}
