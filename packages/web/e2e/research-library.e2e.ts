/** Full application journeys, separate from the native storage-contract tests.
 * Every saved item must reopen through its existing importer or numerical verifier.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const GENBANK = `LOCUS       SAVED_CDS                 12 bp    DNA     linear
DEFINITION  Saved private CDS.
ACCESSION   SAVED_CDS
FEATURES             Location/Qualifiers
     CDS             1..12
                     /gene="saved_cds"
                     /codon_start=1
ORIGIN
        1 atgaaaaagtaa
//
`;
const REFERENCE = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1,
  name: 'Arithmetic test reference', organism: 'Synthetic test corpus', geneticCode: 11,
  source: { citation: 'Hand-counted test fixture, not a biological reference', version: 'test-1' }, counts: { AAA: 8, AAG: 2 } });
async function palette(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill(title);
  await palette.getByRole('option').filter({ hasText: title }).first().click();
}
async function localPanel(page: Page) {
  await palette(page, 'Local genomes: import or export');
  const panel = page.getByTestId('overlay-genomeImport'); await expect(panel).toBeVisible(); return panel;
}
async function importGenome(page: Page) {
  const panel = await localPanel(page);
  await panel.getByLabel('Choose genome file').setInputFiles({ name: 'saved.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK) });
  await expect(panel.getByRole('button', { name: 'Parse records', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
  await expect(panel).toContainText('12 bases, 1 mapped features');
  await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Saved private CDS.');
}
async function library(scope: Locator, title: string) {
  const panel = scope.locator(`details[aria-label="Saved ${title}"]`);
  await panel.locator('summary').click(); return panel;
}
async function save(panel: Locator, name: string) {
  await panel.getByLabel('Snapshot name').fill(name);
  await panel.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Saved an immutable');
  await expect(panel.getByLabel('Saved snapshot').locator('option')).toHaveCount(2);
}
async function openFirst(panel: Locator) {
  await expect(panel.getByLabel('Saved snapshot').locator('option')).toHaveCount(2);
  await panel.getByLabel('Saved snapshot').selectOption({ index: 1 });
  await panel.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
}
async function download(page: Page, action: () => Promise<void>) {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Missing exported JSON');
  const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
});

for (const journey of ['genomes', 'workflow', 'codon-reference', 'pangenome'] as const) {
  test(`saved ${journey} reopens after reload without bypassing review or verification`, async ({ page }, info) => {
    const { pageErrors, finalize } = setupTestHarness(page, info);
    // Do not retain private bodies in test logs. The boolean is sufficient to assert no upload.
    let leaked = false;
    page.on('request', request => {
      const text = `${request.url()} ${request.postData() ?? ''}`;
      if (text.includes('SAVED_CDS') || text.includes('atgaaaaagtaa') || text.includes('Arithmetic test reference')) leaked = true;
    });
    try {
      await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      if (journey !== 'pangenome') await importGenome(page);
      if (journey === 'genomes') {
        let panel = await localPanel(page), saved = await library(panel, 'local genome workspaces');
        await save(saved, 'Private input and view');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        expect(JSON.parse(original).inputs).toEqual([{ name: 'saved.gb', text: GENBANK }]);
        await page.reload(); await expectExplorerIdentity(page, info);
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        panel = await localPanel(page); saved = await library(panel, 'local genome workspaces');
        await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('Review and explicitly add');
        // Loading a saved workspace may not silently add or select private data.
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
        await expect(page.getByTestId('phage-list-item-selected')).toContainText('Saved private CDS.');
        panel = await localPanel(page);
        const reopened = await download(page, () => panel.getByRole('button', { name: 'Export local genome bundle', exact: true }).click());
        expect(JSON.parse(reopened)).toEqual(JSON.parse(original));
      } else if (journey === 'workflow') {
        let panel = await localPanel(page), workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
        await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
        await workflow.getByRole('button', { name: 'Apply and record view', exact: true }).click();
        await expect(workflow.getByTestId('workflow-status')).toContainText('1 recorded commands');
        await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
        let saved = await library(workflow, 'command workflows'); await save(saved, 'Stopped workflow');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        await page.reload(); await expectExplorerIdentity(page, info);
        panel = await localPanel(page); workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
        saved = await library(workflow, 'command workflows'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('No recorded commands were run');
        await expect(workflow.getByTestId('workflow-status')).toContainText('idle · 1 recorded commands · 0/');
        await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        expect(await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click())).toBe(original);
      } else if (journey === 'codon-reference') {
        let panel = await localPanel(page), reference = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
        await reference.getByLabel('Paste codon reference JSON').fill(REFERENCE);
        await reference.getByRole('button', { name: 'Analyze against reference', exact: true }).click();
        // AAA/AAG have weights 1 and 1/4: the geometric mean is 1/2.
        await expect(reference).toContainText('Pooled CAI: 0.500000');
        let saved = await library(reference, 'reference experiments'); await save(saved, 'Known arithmetic experiment');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        await page.reload(); await expectExplorerIdentity(page, info);
        panel = await localPanel(page); reference = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
        saved = await library(reference, 'reference experiments'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('recomputed and verified');
        await expect(reference).toContainText('Pooled CAI: 0.500000');
        expect(await download(page, () => reference.getByRole('button', { name: 'Export reference experiment', exact: true }).click())).toBe(original);
      } else {
        // Use the registered shortcut, not a second test-only route into the analysis code.
        await palette(page, 'Pangenome');
        let panel = page.getByTestId('overlay-pangenomeGraph'); await expect(panel).toBeVisible();
        await panel.getByText('Paste sequences or inspect supported input', { exact: true }).click();
        await panel.getByLabel('Paste pangenome FASTA').fill('>ref\nACGTACGT\n>query\nATGTACGT');
        await panel.getByRole('button', { name: 'Load pasted sequences', exact: true }).click();
        await panel.getByLabel('Pangenome reference sequence').selectOption('ref');
        await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
        await expect(panel.getByTestId('pangenome-summary')).toContainText('1 reference-relative variants');
        const originalId = await panel.getByTestId('pangenome-result').getAttribute('data-result-id');
        let saved = await library(panel, 'pangenome experiments'); await save(saved, 'Single SNV graph');
        await page.reload(); await expectExplorerIdentity(page, info); await palette(page, 'Pangenome');
        panel = page.getByTestId('overlay-pangenomeGraph');
        await expect(panel.getByTestId('pangenome-result')).toHaveCount(0);
        saved = await library(panel, 'pangenome experiments'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('recomputed and verified');
        await expect(panel.getByTestId('pangenome-result')).toHaveAttribute('data-result-id', originalId!);
        await expect(panel.getByTestId('pangenome-variant')).toContainText('[1, 2)');
      }
      expect(leaked).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally { await finalize(); }
  });
}
