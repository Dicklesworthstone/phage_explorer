import { test, expect, type Page, type Locator } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../../core/src/analysis-result';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const FASTA = '>ref private_reference\nACGT--ACGT\n>q1 private_insertion_deletion\nACGTGGAC-T\n>q2 private_substitution\nATGT--ACGT\n';
async function download(page: Page, button: Locator): Promise<string> {
  const waiting = page.waitForEvent('download');
  await button.click();
  const stream = await (await waiting).createReadStream();
  if (!stream) throw new Error('Download content unavailable');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
async function openGraph(page: Page, info: Parameters<typeof expectExplorerIdentity>[1]) {
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, info);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.keyboard.press('Shift+p');
  return page.getByTestId('overlay-pangenomeGraph');
}
const upload = (panel: Locator, content: string, name = 'private-comparison.fasta') => panel.getByLabel('Import pangenome FASTA, dataset JSON or saved analysis', { exact: true })
  .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
  });
});

test('real sequence graph supports exact paths, independent GFA export, reference edits and verified replay after reload', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  try {
    const panel = await openGraph(page, info);
    const result = panel.getByTestId('pangenome-result');
    const button = (name: string) => panel.getByRole('button', { name, exact: true });
    await expect(panel.getByTestId('pangenome-source')).toHaveText('No sequence input');
    await expect(result).toHaveCount(0);
    await upload(panel, FASTA);
    await expect(panel).toContainText('Input loaded locally');
    await expect(result).toHaveCount(0);
    await panel.getByLabel('Pangenome reference sequence', { exact: true }).selectOption('ref');
    await button('Build sequence graph').click();
    await expect(result).toBeVisible();
    await expect(panel.getByTestId('pangenome-summary')).toContainText('3 reference-relative variants');
    await expect(panel.getByRole('img', { name: 'Alignment-derived sequence graph' })).toBeVisible();
    const rows = panel.getByTestId('pangenome-variant');
    await expect(rows).toHaveCount(3);
    expect(await rows.locator('td').allTextContents()).toEqual([
      'v1', 'snv', '[1, 2)', 'C', 'T', 'q2',
      'v2', 'insertion', '[4, 4)', '∅', 'GG', 'q1',
      'v3', 'deletion', '[6, 7)', 'G', '∅', 'q1',
    ]);
    await panel.getByLabel('Inspect sequence node', { exact: true }).selectOption('s1');
    await expect(panel.getByRole('complementary', { name: 'Sequence node details' })).toContainText('Traversed by:');
    const saved = await download(page, button('Export pangenome analysis'));
    const record = await parseAnalysisRecord(saved);
    expect(record.fields.graph.kind).toBe('sequence-score');
    expect(record.inputs[0].source).toBe('local');
    expect(record.parameters.referenceId).toBe('ref');
    expect(record.fields.variants.value).toHaveLength(3);
    const gfa = await download(page, button('Export sequence graph GFA'));
    const segments = new Map<string, string>(), labels = new Map<string, string>(), links = new Set<string>(), paths: string[][] = [];
    for (const line of gfa.trim().split('\n')) {
      const cells = line.split('\t');
      if (cells[0] === '# path-label') labels.set(cells[1], JSON.parse(cells[2]).id);
      if (cells[0] === 'S') segments.set(cells[1], cells[2]);
      if (cells[0] === 'L') { expect(cells[5]).toBe('0M'); links.add(`${cells[1]}:${cells[3]}`); }
      if (cells[0] === 'P') paths.push(cells);
    }
    const expected: Record<string, string> = { ref: 'ACGTACGT', q1: 'ACGTGGACT', q2: 'ATGTACGT' };
    expect(paths).toHaveLength(3);
    for (const cells of paths) {
      const ids = cells[2].split(',').map(value => { expect(value.endsWith('+')).toBe(true); return value.slice(0, -1); });
      expect(ids.map(id => segments.get(id)).join('')).toBe(expected[labels.get(cells[1])!]);
      for (let i = 1; i < ids.length; i++) expect(links.has(`${ids[i - 1]}:${ids[i]}`)).toBe(true);
    }
    const aligned = await download(page, button('Export graph alignment FASTA'));
    expect(aligned).toContain('>ref private_reference\nACGT--ACGT\n');
    expect(aligned).toContain('>q1 private_insertion_deletion\nACGTGGAC-T\n');
    await panel.getByLabel('Pangenome reference sequence', { exact: true }).selectOption('q1');
    await expect(panel).toContainText('Edited settings are not applied');
    expect((await parseAnalysisRecord(await download(page, button('Export pangenome analysis')))).resultId).toBe(record.resultId);
    await button('Build sequence graph').click();
    await expect(result).not.toHaveAttribute('data-result-id', record.resultId);
    await expect(panel.getByTestId('pangenome-reference-used')).toContainText('q1 (9 bases)');
    const changed = await result.getAttribute('data-result-id');
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await page.keyboard.press('Shift+p');
    await expect(result).toHaveAttribute('data-result-id', changed!);
    await expect(panel.getByTestId('pangenome-source')).toHaveText('Local sequence input');
    await page.reload();
    await expectExplorerIdentity(page, info);
    await page.keyboard.press('Shift+p');
    await expect(result).toHaveCount(0);
    await upload(panel, saved, 'saved-pangenome.json');
    await expect(panel).toContainText('Verified pangenome replay');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    const forged = await parseAnalysisRecord(saved);
    (forged.fields.variants.value as Array<Record<string, AnalysisJson>>)[0].alternate = 'A';
    const signed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    await upload(panel, serializeAnalysisRecord(signed), 'forged.json');
    await expect(panel.getByRole('alert')).toContainText('Recomputed pangenome graph or variants differ');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    await upload(panel, '>duplicate\nACGT\n>duplicate\nACGT');
    await expect(panel.getByRole('alert')).toContainText('Duplicate sequence identifiers');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    expect(requests.some(request => request.includes('private_reference') || request.includes('ACGTGGAC-T'))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('global locus alignment, local errors and actual worker cancellation remain recoverable', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let release: (() => void) | undefined;
  try {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      let created = 0, terminated = 0;
      window.Worker = class extends NativeWorker {
        private tracked: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options); this.tracked = String(url).includes('pangenome.worker');
          if (this.tracked) created++;
        }
        terminate() { if (this.tracked) { terminated++; this.tracked = false; } super.terminate(); }
      };
      (window as unknown as { pangenomeWorkerCounts: () => { created: number; terminated: number } }).pangenomeWorkerCounts = () => ({ created, terminated });
    });
    const panel = await openGraph(page, info);
    const result = panel.getByTestId('pangenome-result');
    await upload(panel, '>ref\nACGT\n>query\nAGT');
    await expect(panel).toContainText('Input loaded locally');
    await panel.getByLabel('Pangenome reference sequence', { exact: true }).selectOption('ref');
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('equal column counts');
    await expect(result).toHaveCount(0);
    await panel.getByLabel('Pangenome alignment mode', { exact: true }).selectOption('global');
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect(panel.getByTestId('pangenome-variant')).toContainText('deletion');
    await expect(panel.getByTestId('pangenome-variant')).toContainText('[1, 2)');
    const accepted = await result.getAttribute('data-result-id');
    let requested = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.route(/pangenome\.worker-.*\.js/, async route => {
      requested = true; await blocked; await route.continue().catch(() => {});
    });
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await panel.getByRole('button', { name: 'Cancel pangenome work', exact: true }).click();
    await expect(panel).toContainText('Pangenome work cancelled');
    await expect(result).toHaveAttribute('data-result-id', accepted!);
    await expect.poll(() => page.evaluate(() => {
      const { created, terminated } = (window as unknown as { pangenomeWorkerCounts: () => { created: number; terminated: number } }).pangenomeWorkerCounts();
      return created - terminated;
    })).toBe(0);
    release();
    await page.unroute(/pangenome\.worker-.*\.js/);
    await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
    await expect(panel).toContainText('Sequence graph computed');
    await expect(result).toHaveAttribute('data-result-id', accepted!);
    expect(pageErrors).toEqual([]);
  } finally { release?.(); await finalize(); }
});
