import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const GENBANK = `LOCUS       PRIVATE1                  24 bp    DNA     circular
DEFINITION  Private α genome.
ACCESSION   PRIVATE1
VERSION     PRIVATE1.1
FEATURES             Location/Qualifiers
     CDS             complement(join(1..6,19..24))
                     /gene="reverse_join"
                     /product="tail fiber protein"
                     /translation="MKLP"
     CDS             7..18
                     /gene="forward"
ORIGIN
        1 atgaaacccgggtttaaaccctag
//
`;

async function palette(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  const overlay = page.getByTestId('overlay-commandPalette');
  await overlay.getByRole('combobox').fill(title);
  await overlay.getByRole('option').filter({ hasText: title }).first().click();
}
async function importPanel(page: Page) {
  await palette(page, 'Local genomes: import or export');
  const overlay = page.getByTestId('overlay-genomeImport');
  await expect(overlay).toBeVisible();
  return overlay;
}
async function downloadText(page: Page, action: () => Promise<void>): Promise<string> {
  const downloading = page.waitForEvent('download');
  await action();
  const stream = await (await downloading).createReadStream();
  if (!stream) throw new Error('No downloaded content');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function parseInput(overlay: Locator, content: string) {
  await overlay.getByRole('textbox', { name: 'Paste genome data' }).fill(content);
  await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'Add records to explorer' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    // Exercise the browser download fallback, not an OS picker inaccessible to automation.
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
  });
});

test('private GenBank reaches sequence, gene map, analysis and a portable reimported view', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: { url: string; body: string | null }[] = [];
  page.on('request', request => requests.push({ url: request.url(), body: request.postData() }));
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let overlay = await importPanel(page);
    await overlay.getByLabel('Choose genome file').setInputFiles({ name: 'private.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK) });
    await expect(overlay.getByRole('status')).toContainText('File loaded locally');
    await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(overlay).toContainText('24 bases, 2 mapped features, circular');
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('Private α genome.');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(25);
    await expect(page.getByRole('figure', { name: 'Gene map visualization for Private α genome.' })).toBeVisible();
    const readSegmentColors = () => page.getByRole('figure', { name: 'Gene map visualization for Private α genome.' }).locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Gene map canvas unavailable');
      const pixel = (fraction: number) => Array.from(ctx.getImageData(Math.floor(canvas.width * fraction), Math.floor(canvas.height * 32 / canvas.getBoundingClientRect().height), 1, 1).data);
      return { first: pixel(0.125), intron: pixel(0.5), last: pixel(0.875) };
    });
    // Visibility precedes the canvas's requestAnimationFrame paint. Wait for
    // opaque gene pixels before checking the actual joined-feature geometry.
    await expect.poll(async () => (await readSegmentColors()).first[3]).toBe(255);
    const segmentColors = await readSegmentColors();
    expect(segmentColors.first).toEqual(segmentColors.last);
    expect(segmentColors.intron).not.toEqual(segmentColors.first);
    await expect(page.getByRole('link', { name: /Open PRIVATE1.*NCBI/ })).toHaveCount(0);

    const fasta = await downloadText(page, () => palette(page, 'Export as FASTA'));
    expect(fasta.replace(/^>.*\n/, '').replace(/\s/g, '')).toBe('ATGAAACCCGGGTTTAAACCCTAG');
    await palette(page, 'GC skew analysis');
    await expect(page.getByTestId('overlay-gcSkew')).toContainText(/GC skew/i);
    await expect(page.getByTestId('overlay-gcSkew')).toContainText('Sequence too short for GC skew analysis');
    await page.keyboard.press('Escape');
    const requestsBeforeReference = requests.length;
    await page.keyboard.press('Control+Shift+y');
    await expect(page.getByTestId('overlay-phylodynamics')).toContainText('Reference data unavailable for this local genome');
    expect(requests.slice(requestsBeforeReference).some(request => /ncbi|serratus/.test(request.url))).toBe(false);
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');
    await page.getByRole('button', { name: 'Export local genome data' }).click();
    overlay = page.getByTestId('overlay-genomeImport');
    const exported = await downloadText(page, () => overlay.getByRole('button', { name: 'Export local genome bundle' }).click());
    const bundle = JSON.parse(exported);
    expect(bundle.format).toBe('phage-explorer-local-genomes');
    expect(bundle.version).toBe(1);
    expect(bundle.inputs).toEqual([{ name: 'private.gb', text: GENBANK }]);
    expect(bundle.view.viewMode).toBe('aa');
    expect(bundle.view.contentId).toMatch(/^[a-f0-9]{64}$/);
    await info.attach('local-source-digest', { body: JSON.stringify({ sourceSha256: createHash('sha256').update(GENBANK).digest('hex'), contentId: bundle.view.contentId }), contentType: 'application/json' });

    await page.reload();
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
    overlay = await importPanel(page);
    await parseInput(overlay, exported);
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('Private α genome.');
    await page.getByRole('button', { name: 'Export local genome data' }).click();
    const second = JSON.parse(await downloadText(page, () => page.getByTestId('overlay-genomeImport').getByRole('button', { name: 'Export local genome bundle' }).click()));
    expect(second).toEqual(bundle);
    expect(requests.some(request => `${request.url} ${request.body ?? ''}`.includes('ATGAAACCCGGGTTTAAACCCTAG'))).toBe(false);
    expect(requests.some(request => `${request.url} ${request.body ?? ''}`.includes('Private α genome'))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('palette selection and FASTA export follow the selected local genome with a different diff reference', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const overlay = await importPanel(page);
    await parseInput(overlay, `>PRIVATE_ALPHA\n${'ACGT'.repeat(300)}\n>PRIVATE_BETA\n${'GGCC'.repeat(300)}`);
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('PRIVATE_ALPHA');
    // Enable diff while Alpha is selected, then choose a different record.
    await page.keyboard.press('d');
    await palette(page, 'PRIVATE_BETA');
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('PRIVATE_BETA');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('PRIVATE_BETA');
    const fasta = await downloadText(page, () => palette(page, 'Export as FASTA'));
    expect(fasta.replace(/^>.*\n/, '').replace(/\s/g, '')).toBe('GGCC'.repeat(300));
    await palette(page, 'Copy sequence');
    // Paste into the actual import field, exercising the user's clipboard workflow
    // without a Chromium-only permission override or synthetic clipboard contents.
    const pastePanel = await importPanel(page);
    const pasteField = pastePanel.getByRole('textbox', { name: 'Paste genome data' });
    await pasteField.focus();
    await page.keyboard.press('Control+v');
    await expect(pasteField).toHaveValue(/^>PRIVATE_BETA \| PRIVATE_BETA\n/);
    expect((await pasteField.inputValue()).replace(/^>.*\n/, '').replace(/\s/g, '')).toBe('GGCC'.repeat(300));
    await page.keyboard.press('Escape');
    await palette(page, 'GC skew analysis');
    await expect(page.getByTestId('overlay-gcSkew').getByRole('img', { name: 'GC skew graph showing cumulative nucleotide bias across genome position' })).toBeVisible();
    await page.keyboard.press('Escape');
    await palette(page, 'Compare genomes');
    const comparison = page.getByTestId('overlay-comparison');
    await comparison.getByRole('combobox').nth(0).selectOption({ label: 'A: PRIVATE_ALPHA' });
    await comparison.getByRole('combobox').nth(1).selectOption({ label: 'B: PRIVATE_BETA' });
    await comparison.getByRole('button', { name: 'Biological', exact: true }).click();
    await expect(comparison).toContainText('50.00% / 100.00%');
    await expect(comparison).toContainText('1,200 / 1,200');
    // A real worker module failure must clear loading and allow a new computation.
    await page.route(/comparison\.worker-.*\.js/, route => route.abort('failed'));
    await comparison.getByRole('button', { name: 'Run', exact: true }).first().click();
    await expect(comparison).toContainText('The comparison worker failed. Select Run to retry.');
    await page.unroute(/comparison\.worker-.*\.js/);
    await comparison.getByRole('button', { name: 'Run', exact: true }).first().click();
    await expect(comparison).toContainText('50.00% / 100.00%');
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('multi-record accession collisions require a decision and malformed input preserves the catalog', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const overlay = await importPanel(page);
    await parseInput(overlay, '>NC_001416.1 changed local input\nGGCC\n>literal_<script>alert(1)</script> β\nACGTRYN');
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(overlay.getByRole('alert')).toContainText('already exists');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
    await overlay.getByRole('checkbox', { name: /Keep different records separately/ }).check();
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(26);
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('changed local input');
    await page.getByTestId('phage-list-item').filter({ hasText: 'Enterobacteria phage lambda' }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('48,502');
    await importPanel(page);
    await overlay.getByRole('textbox', { name: 'Paste genome data' }).fill('>invalid\nACGU');
    await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(overlay.getByRole('alert')).toContainText('IUPAC DNA');
    await expect(overlay.getByRole('button', { name: 'Add records to explorer' })).toHaveCount(0);
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(26);
    expect(await page.locator('script').filter({ hasText: 'alert(1)' }).count()).toBe(0);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('cancel a large input while its actual parser worker is pending', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    const overlay = await importPanel(page);
    let workerRequested = false;
    await page.route(/genome-import\.worker-.*\.js/, async route => {
      workerRequested = true;
      // Controlled module-load delay makes cancellation deterministic; no parser result is mocked.
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.continue().catch(() => {});
    });
    const input = `>large\n${'ACGT'.repeat(1_000_000)}`;
    await overlay.getByLabel('Choose genome file').setInputFiles({ name: 'large.fa', mimeType: 'text/plain', buffer: Buffer.from(input) });
    await expect(overlay.getByRole('status')).toContainText('File loaded locally');
    expect((await overlay.getByRole('region', { name: 'Genome file preview' }).textContent())?.length).toBe(2000);
    await expect(overlay).toContainText('Parsing and export use the complete file');
    await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect.poll(() => workerRequested).toBe(true);
    await overlay.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await expect(overlay.getByRole('status')).toContainText('Import cancelled');
    await expect(overlay.getByRole('button', { name: 'Add records to explorer' })).toHaveCount(0);
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
    // The bounded preview must not truncate what a retry parses or exports.
    await overlay.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(overlay).toContainText('4,000,000 bases');
    await overlay.getByRole('button', { name: 'Add records to explorer' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('large');
    await page.getByRole('button', { name: 'Export local genome data' }).click();
    const bundle = JSON.parse(await downloadText(page, () => overlay.getByRole('button', { name: 'Export local genome bundle' }).click()));
    expect(bundle.inputs).toEqual([{ name: 'large.fa', text: input }]);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
