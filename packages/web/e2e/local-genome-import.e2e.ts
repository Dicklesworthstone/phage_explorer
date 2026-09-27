import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { parseAnalysisRecord } from '../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
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
    await expect(page.getByTestId('overlay-gcSkew')).toContainText('Two complete 500 bp windows at 125 bp spacing require at least 625 bp.');
    await page.keyboard.press('Escape');
    const requestsBeforeReference = requests.length;
    await page.keyboard.press('Control+Shift+y');
    await expect(page.getByTestId('overlay-phylodynamics')).toContainText('Reference data unavailable for this local genome');
    expect(requests.slice(requestsBeforeReference).some(request => /ncbi|serratus/.test(request.url))).toBe(false);
    await page.keyboard.press('Escape');
    await page.keyboard.press('v');
    await page.getByRole('button', { name: 'Export local data: genome bundle' }).click();
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
    await page.getByRole('button', { name: 'Export local data: genome bundle' }).click();
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
    await page.getByRole('button', { name: 'Export local data: genome bundle' }).click();
    const bundle = JSON.parse(await downloadText(page, () => overlay.getByRole('button', { name: 'Export local genome bundle' }).click()));
    expect(bundle.inputs).toEqual([{ name: 'large.fa', text: input }]);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});


// Independently checked CDS: RC(CCATGA)+RC(ACGTTT), offset one base,
// is CAT GGA AAC GT: three sense codons, with the last two bases incomplete.
const WORKFLOW_INPUT = `LOCUS       WORKFLOW_ALPHA            18 bp    DNA     linear
DEFINITION  Workflow alpha.
ACCESSION   WORKFLOW_ALPHA
FEATURES             Location/Qualifiers
     CDS             complement(join(1..6,13..18))
                     /locus_tag="joined"
                     /codon_start=2
     CDS             1..6
                     /locus_tag="other"
ORIGIN
        1 acgtttggggggccatga
//
`;
const WORKFLOW_INPUTS = WORKFLOW_INPUT + WORKFLOW_INPUT.replaceAll('WORKFLOW_ALPHA', 'WORKFLOW_BETA')
  .replace('Workflow alpha.', 'Workflow beta.').replace('acgtttggggggccatga', 'ggccccttttttatgcca');

test('recorded private-genome workflow reopens, navigates, recomputes and rejects changed evidence with real workers', async ({ page }, info) => {
  test.setTimeout(180000);
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let created = 0, terminated = 0;
    window.Worker = class extends NativeWorker {
      private tracked: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.tracked = String(url).includes('research-workflow.worker');
        if (this.tracked) created++;
      }
      terminate() { if (this.tracked) { terminated++; this.tracked = false; } super.terminate(); }
    };
    (window as unknown as { researchWorkerStats: () => { created: number; terminated: number } }).researchWorkerStats = () => ({ created, terminated });
  });
  let releaseWorker: (() => void) | undefined;
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let overlay = await importPanel(page);
    await parseInput(overlay, WORKFLOW_INPUTS);
    await overlay.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow alpha.');
    overlay = await importPanel(page);
    const panel = page.getByRole('region', { name: 'Saved research workflows', exact: true });
    const button = (name: string) => panel.getByRole('button', { name, exact: true });
    const status = panel.getByTestId('workflow-status');
    const activate = async (name: string) => { await button(name).focus(); await button(name).press('Enter'); };
    await panel.getByLabel('Workflow name', { exact: true }).fill('jkafv — private CDS workflow');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow alpha.');
    await activate('Start workflow recording');
    await panel.getByLabel('Workflow CDS', { exact: true }).selectOption('1');
    await panel.getByLabel('Workflow view mode', { exact: true }).selectOption('dual');
    await panel.getByLabel('Workflow reading frame', { exact: true }).selectOption('-2');
    await panel.getByLabel('Workflow position (0-based view coordinate)', { exact: true }).fill('0');
    await activate('Apply and record view');
    await expect(status).toContainText('1 recorded commands');
    await activate('Run and record CDS analysis');
    await expect(status).toContainText('2 recorded commands');
    const firstCds = await parseAnalysisRecord(await downloadText(page, () => button('Export workflow analysis').click()));
    expect(firstCds.fields.codingSequences.value).toEqual([{ geneId: 1, codonCount: 3, sequence: 'CATGGAAACGT' }]);
    expect(firstCds.fields.codingSequences.kind).toBe('sequence-score');
    expect(firstCds.fields.hostRankings.kind).toBe('demo');
    expect(firstCds.inputs.find(input => input.id === 'sequence')?.data).toBe('ACGTTTGGGGGGCCATGA');
    await panel.getByLabel('Workflow minimum repeat arm', { exact: true }).fill('4');
    await panel.getByLabel('Workflow maximum repeat gap', { exact: true }).fill('18');
    await activate('Run and record repeats');
    await expect(status).toContainText('3 recorded commands');
    await expect(panel.getByTestId('workflow-result')).not.toHaveAttribute('data-result-id', firstCds.resultId);

    // These must use the actual application loader, not simply change an index.
    const genomeSelect = panel.getByLabel('Workflow genome', { exact: true });
    await genomeSelect.selectOption({ label: 'Workflow beta.' });
    await activate('Apply and record view');
    await expect(status).toContainText('4 recorded commands');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow beta.');
    await genomeSelect.selectOption({ label: 'Workflow alpha.' });
    await panel.getByLabel('Workflow CDS', { exact: true }).selectOption('1');
    await activate('Apply and record view');
    await expect(status).toContainText('5 recorded commands');
    await activate('Undo workflow view');
    await expect(status).toContainText('6 recorded commands');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow beta.');
    await activate('Redo workflow view');
    await expect(status).toContainText('7 recorded commands');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow alpha.');
    await activate('Run and record CDS analysis');
    await expect(status).toContainText('8 recorded commands');
    await expect(panel.getByTestId('workflow-result')).toHaveAttribute('data-result-id', firstCds.resultId);
    await activate('Stop workflow recording');
    const saved = await downloadText(page, () => button('Export research workflow').click());
    const tape = parseCommandTape(saved);
    expect(tape.commands.map(command => command.actionId)).toEqual(['nav.goto', 'overlay.codonAdaptation', 'overlay.repeats', 'nav.goto', 'nav.goto', 'nav.goto', 'nav.goto', 'overlay.codonAdaptation']);
    expect(tape.commands[0].parameters).toMatchObject({ viewMode: 'dual', readingFrame: -2, geneId: 1, scrollPosition: 0 });
    expect(tape.commands[2].parameters).toMatchObject({ minLength: 4, maxGap: 18 });
    expect(JSON.parse((tape.context as { bundle: string }).bundle).inputs).toEqual([{ name: 'pasted-genomes.txt', text: WORKFLOW_INPUTS }]);
    const viewBundle = JSON.parse(await downloadText(page, () => overlay.getByRole('button', { name: 'Export local genome bundle', exact: true }).click()));
    expect(viewBundle.view).toMatchObject({ viewMode: 'dual', readingFrame: -2, scrollPosition: 0 });

    await page.reload();
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
    overlay = await importPanel(page);
    const loadTape = (content: string) => panel.getByLabel('Load research workflow JSON', { exact: true })
      .setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(content) });
    await loadTape(saved);
    await expect(panel).toContainText('2 bundled genomes validated');
    await expect(panel.getByTestId('workflow-result')).toHaveCount(0);
    await button('Replay research workflow').click();
    await expect(panel.getByRole('alert')).toContainText('Step 1');
    await expect(panel.getByRole('alert')).toContainText('Missing local genome');
    await button('Add workflow genomes').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflow alpha.');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(26);
    await button('Replay research workflow').click();
    await expect(status).toContainText('Verified 8 commands');
    await expect(panel.getByTestId('workflow-view')).toContainText('dual · frame -2 · position 0 · CDS 1');
    const fresh = await parseAnalysisRecord(await downloadText(page, () => button('Export workflow analysis').click()));
    expect(fresh.resultId).toBe(firstCds.resultId);
    expect(fresh.fields.codingSequences.value).toEqual(firstCds.fields.codingSequences.value);

    const forged = parseCommandTape(saved);
    (forged.commands[7].expected as { resultId: string }).resultId = '0'.repeat(64);
    await loadTape(serializeCommandTape(forged));
    await expect(button('Replay research workflow')).toBeEnabled();
    await button('Replay research workflow').click();
    await expect(panel.getByRole('alert')).toContainText('Step 8 (overlay.codonAdaptation)');
    await expect(panel.getByRole('alert')).toContainText('differs');
    await expect(panel.getByTestId('workflow-result')).toHaveCount(0);
    const changed = parseCommandTape(saved);
    const changedBundle = JSON.parse((changed.context as { bundle: string }).bundle) as { inputs: Array<{ name: string; text: string }> };
    changedBundle.inputs[0].text = changedBundle.inputs[0].text.replace('acgtttggggggccatga', 'tcgtttggggggccatga');
    changed.context = { bundle: JSON.stringify(changedBundle) };
    await loadTape(serializeCommandTape(changed));
    await expect(button('Replay research workflow')).toBeEnabled();
    await button('Replay research workflow').click();
    await expect(panel.getByRole('alert')).toContainText('Missing local genome');
    await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(26);

    await loadTape(saved);
    await expect(button('Replay research workflow')).toBeEnabled();
    await button('Replay research workflow').click();
    await expect(status).toContainText('Verified 8 commands');
    const workerUrl = /research-workflow\.worker(?:-[^/]+\.js|\.ts)/;
    let workerRequested = false;
    const holdWorker = async () => {
      workerRequested = false;
      const gate = new Promise<void>(resolve => { releaseWorker = resolve; });
      await page.route(workerUrl, async route => { workerRequested = true; await gate; await route.continue().catch(() => {}); });
    };
    await holdWorker();
    await button('Replay research workflow').click();
    await expect.poll(() => workerRequested).toBe(true);
    await button('Pause workflow').click();
    releaseWorker!();
    await expect(status).toContainText('paused');
    await expect(status).toContainText('2/8 replay commands complete');
    await page.unroute(workerUrl);
    await button('Resume workflow').click();
    await expect(status).toContainText('Verified 8 commands');

    const before = await page.evaluate(() => (window as unknown as { researchWorkerStats: () => { created: number; terminated: number } }).researchWorkerStats());
    await holdWorker();
    await button('Replay research workflow').click();
    await expect.poll(() => workerRequested).toBe(true);
    await button('Cancel workflow').click();
    await expect(status).toContainText('Cancelled');
    releaseWorker!();
    await page.unroute(workerUrl);
    await expect(button('Replay research workflow')).toBeEnabled();
    await expect(status).toContainText('1/8 replay commands complete');
    await expect(panel.getByTestId('workflow-result')).toHaveCount(0);
    const after = await page.evaluate(() => (window as unknown as { researchWorkerStats: () => { created: number; terminated: number } }).researchWorkerStats());
    expect(after.created).toBeGreaterThan(before.created);
    expect(after.terminated).toBeGreaterThan(before.terminated);
    expect(requests.some(request => request.includes('ACGTTTGGGGGGCCATGA') || request.includes('acgtttggggggccatga') || request.includes('Workflow alpha'))).toBe(false);
    expect(pageErrors).toEqual([]);
    await info.attach('workflow-verification-identities', { body: JSON.stringify({ commands: tape.commands.map(c => c.actionId), resultId: fresh.resultId, acceptedCdsCount: 1 }), contentType: 'application/json' });
  } finally { releaseWorker?.(); await finalize(); }
});
