import { test, expect, type Page } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import type { CodonSelectionResult } from '../../core/src/analysis/codon-selection';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';
const FASTA = '>left_α\n' + 'GCT'.repeat(10) + '\n><b>literal</b>\nGCCGAT' + 'GCT'.repeat(8);
async function openPanel(page: Page) {
  await page.keyboard.press('Alt+Shift+s');
  const panel = page.getByRole('region', { name: 'Private aligned codon comparison', exact: true });
  await expect(panel).toBeVisible(); return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const waiting = page.waitForEvent('download'); await action();
  const stream = await (await waiting).createReadStream(); if (!stream) throw new Error('No result download');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8');
}
test('explicit aligned CDS input reaches real workers and survives export, reload and verified replay', async ({ page }, info) => {
  test.setTimeout(180000); const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: string[] = []; page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  try {
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await openPanel(page);
    await expect(panel.getByTestId('codon-result')).toHaveCount(0);
    await expect(panel).toContainText('The selected raw genome and diff reference are not used as an alignment.');
    await panel.getByLabel('Aligned coding FASTA', { exact: true }).fill(FASTA);
    for (const [label, value] of Object.entries({
      'Codon dataset name': 'Private homologous CDS α', 'Coding source description': 'Synthetic numerical reference supplied locally',
      'Coding source reference': 'Ten alanine codons with one synonymous and one nonsynonymous difference',
      'Coding license or permissions': 'CC0 test fixture', 'Codon alignment method and version': 'Hand aligned v1',
      'Homologous CDS provenance': 'Constructed matching codon columns; no empirical homology claim',
    })) await panel.getByLabel(label, { exact: true }).fill(value);
    await panel.getByRole('checkbox', { name: 'I declare homologous codon columns, coding 5′→3′ orientation and frame-zero boundaries.', exact: true }).check();
    await panel.getByRole('button', { name: 'Load and validate coding alignment', exact: true }).click();
    await expect(panel.getByTestId('codon-status')).toContainText('Codon alignment loaded');
    await expect(panel.getByTestId('codon-result')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Run aligned codon comparison', exact: true }).click();
    await expect(panel.getByTestId('codon-status')).toContainText('Aligned codon comparison complete');
    await expect(panel.getByRole('table', { name: 'Pooled codon comparisons', exact: true }).locator('tbody tr')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'left_α versus <b>literal</b>', exact: true })).toBeVisible();
    expect(await panel.locator('b').filter({ hasText: 'literal' }).count()).toBe(0);
    await expect(panel.getByRole('img', { name: 'Windowed synonymous and nonsynonymous distances', exact: true })).toBeVisible();
    const exported = () => download(page, () => panel.getByRole('button', { name: 'Export accepted codon comparison', exact: true }).click());
    const content = await exported(), record = await parseAnalysisRecord(content);
    const evidence = record.fields.comparisons.value as unknown as CodonSelectionResult, fit = evidence.pairs[0].overall;
    // Independent counts: S=(10+9+1/3)/2=29/3, N=30-S=61/3; differences=1 each.
    const jc = (p: number) => -.75 * Math.log(1 - 4 * p / 3);
    expect(fit.synonymousSites).toBeCloseTo(29 / 3, 12); expect(fit.nonsynonymousSites).toBeCloseTo(61 / 3, 12);
    expect(fit.dS.value).toBeCloseTo(jc(3 / 29), 12); expect(fit.dN.value).toBeCloseTo(jc(3 / 61), 12);
    expect(fit.omega).toBeCloseTo(jc(3 / 61) / jc(3 / 29), 12);
    expect(record.inputs[0].source).toBe('local'); expect(record.fields.comparisons.kind).toBe('fitted-estimate');
    await panel.getByLabel('Window size in codons', { exact: true }).fill('1');
    expect((await parseAnalysisRecord(await exported())).resultId).toBe(record.resultId);
    await panel.getByRole('button', { name: 'Run aligned codon comparison', exact: true }).click();
    await expect(panel.getByRole('table', { name: 'Codon window counts and distances', exact: true }).locator('tbody tr')).toHaveCount(10);
    await expect(panel).toContainText('saturated'); await expect(panel).toContainText('dN/dS is undefined, not 1 or an arbitrary large number');
    const windowed = await exported(), windowRecord = await parseAnalysisRecord(windowed);
    await page.reload(); await expectExplorerIdentity(page, info); panel = await openPanel(page);
    const restore = (text: string, name = 'coding.json') => panel.getByLabel('Import codon dataset or saved comparison JSON', { exact: true })
      .setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
    await restore(windowed); await expect(panel.getByTestId('codon-status')).toContainText('Verified codon replay');
    await expect(panel.getByTestId('codon-result')).toHaveAttribute('data-result-id', windowRecord.resultId);
    expect((await parseAnalysisRecord(await exported())).resultId).toBe(windowRecord.resultId);
    const forged = await parseAnalysisRecord(windowed);
    (forged.fields.comparisons.value as unknown as CodonSelectionResult).pairs[0].overall.omega = 10;
    const rehashed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    await restore(serializeAnalysisRecord(rehashed)); await expect(panel.getByRole('alert')).toContainText('Fresh codon comparison differs');
    await expect(panel.getByTestId('codon-result')).toHaveAttribute('data-result-id', windowRecord.resultId);
    // Hold an actual completed File.text read; cancellation must prevent late launch/publication.
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        const reading = original.call(this);
        return this.name === 'held-codon.json' ? reading.then(text => new Promise<string>(resolve => { (window as any).releaseCodonRead = () => resolve(text); })) : reading;
      };
    });
    await restore(content, 'held-codon.json');
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseCodonRead)).toBe('function');
    await panel.getByRole('button', { name: 'Cancel codon work', exact: true }).click();
    await page.evaluate(() => (window as any).releaseCodonRead());
    await expect(panel.getByTestId('codon-status')).toContainText('Codon work cancelled');
    await expect(panel.getByTestId('codon-result')).toHaveAttribute('data-result-id', windowRecord.resultId);
    const invalid = structuredClone(record.inputs[0].data) as any; invalid.alignment.homologousCodons = false;
    await restore(JSON.stringify(invalid)); await expect(panel.getByRole('alert')).toContainText('Declare homologous codons');
    await expect(panel.getByTestId('codon-result')).toHaveAttribute('data-result-id', windowRecord.resultId);
    const replacement = structuredClone(record.inputs[0].data) as any;
    replacement.alignment.fasta = '>one\n---GCNTAAATG\n>two\nGCTGCTGCTATG';
    await restore(JSON.stringify(replacement)); await expect(panel.getByTestId('codon-result')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Run aligned codon comparison', exact: true }).click();
    await expect(panel.getByTestId('codon-exclusions')).toContainText('gap: 1; ambiguous: 1; stop: 1');
    await expect(panel).toContainText('Synonymous distance is no-sites');
    expect(requests.filter(request => request.includes(encodeURIComponent('Private homologous CDS')) || request.includes('GCCGATGCT') || request.includes('Ten alanine codons'))).toEqual([]);
    expect(pageErrors).toEqual([]);
    await info.attach('coding-evidence-identities', { body: JSON.stringify({ original: record.resultId, windowed: windowRecord.resultId, counts: { S: fit.synonymousSites, N: fit.nonsynonymousSites, Sd: 1, Nd: 1 } }), contentType: 'application/json' });
  } finally { await finalize(); }
});
