import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { validateEpistasisAssayDataset, type EpistasisAssayDataset, type EpistasisAssayResult } from '../../core/src/analysis/epistasis-evidence';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

test.use({ serviceWorkers: 'block' });

// Artificial, hand-computed observations. The unmatched WT blocks must not
// influence the paired contrast; the second double has no D3E control at all.
const DATASET: EpistasisAssayDataset = {
  format: 'phage-explorer-epistasis-assay', version: 1, name: 'EPI_PRIVATE_ASSAY',
  source: { kind: 'local', description: 'Artificial browser regression fixture, not experimental data.', reference: null, license: 'CC0' },
  protein: { id: '<b>EPI_PRIVATE_PROTEIN</b>', accession: 'FIXTURE.1', sequence: 'ACDE' },
  assay: { name: 'Declared fixture response', units: 'response units', conditions: 'Three independent matched blocks; missing groups and extra WT blocks are deliberate.',
    scale: 'identity', replicateDesign: 'paired' },
  observations: [
    ...[10, 12, 14].map((value, i) => ({ variant: 'WT', replicateId: 'block-' + i, value })),
    ...[8, 9, 10].map((value, i) => ({ variant: 'A1G', replicateId: 'block-' + i, value })),
    ...[11, 13, 15].map((value, i) => ({ variant: 'C2T', replicateId: 'block-' + i, value })),
    ...[10, 14, 18].map((value, i) => ({ variant: 'A1G:C2T', replicateId: 'block-' + i, value })),
    { variant: 'A1G:D3E', replicateId: 'block-0', value: 5 },
    ...Array.from({ length: 43 }, (_, i) => ({ variant: 'WT', replicateId: 'EPI_PRIVATE_UNMATCHED_' + i, value: 100 + i })),
  ],
};
async function open(page: Page): Promise<Locator> {
  await page.keyboard.press('Alt+Shift+e');
  const panel = page.getByRole('region', { name: 'Measured epistasis workspace', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
async function start(page: Page, info: TestInfo): Promise<Locator> {
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, info);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  return open(page);
}
async function load(panel: Locator, content: string): Promise<void> {
  await panel.getByLabel('Import epistasis assay or saved evidence JSON', { exact: true }).setInputFiles({
    name: 'epi-private-assay.json', mimeType: 'application/json', buffer: Buffer.from(content),
  });
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('No epistasis download stream.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('local measured assays retain their exact source, incomplete controls and all observations through export and fresh replay', async ({ page }, info) => {
  test.setTimeout(180000);
  const { pageErrors, finalize } = setupTestHarness(page, info), requests: string[] = [];
  page.on('request', request => requests.push(request.url() + ' ' + (request.postData() ?? '')));
  let release: (() => void) | undefined;
  try {
    let panel = await start(page, info);
    await expect(panel.getByTestId('epistasis-source')).toHaveText('NO ASSAY DATA LOADED');
    await expect(panel.getByTestId('epistasis-result')).toHaveCount(0);
    // The legacy sequence illustration is opt-in and cannot label local assays.
    await expect(page.getByText('Optional BLOSUM62 sequence illustration', { exact: true })).toBeVisible();
    await expect(page.getByText('Epistasis Heatmap (position × position)', { exact: true })).toHaveCount(0);
    await load(panel, JSON.stringify(DATASET));
    await expect(panel.getByTestId('epistasis-notice')).toContainText('Dataset loaded');
    await expect(panel.getByTestId('epistasis-dataset-name')).toHaveText(DATASET.name);
    await expect(panel.getByTestId('epistasis-result')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Export epistasis evidence', exact: true })).toBeDisabled();
    await panel.getByLabel('Bootstrap samples (0 or 200–2000)', { exact: true }).fill('200');
    await panel.getByLabel('Bootstrap seed', { exact: true }).fill('42');
    await panel.getByRole('button', { name: 'Analyze accepted assay', exact: true }).click();
    await expect(panel.getByTestId('epistasis-result')).toBeVisible();
    await expect(panel.getByTestId('epistasis-source')).toContainText('LOCAL ASSAY INPUT');
    await expect(panel.locator('b').filter({ hasText: 'EPI_PRIVATE_PROTEIN' })).toHaveCount(0);
    await expect(panel.getByTestId('epistasis-summary')).toContainText('56 observations');
    await expect(panel.getByTestId('epistasis-summary')).toContainText('1 estimated / 2');
    const exportRecord = () => download(page, () => panel.getByRole('button', { name: 'Export epistasis evidence', exact: true }).click());
    const evidence = await exportRecord(), record = await parseAnalysisRecord(evidence);
    const result = record.fields.result.value as unknown as EpistasisAssayResult;
    expect(record.inputs[0].data).toEqual(validateEpistasisAssayDataset(DATASET));
    expect(record.fields.result.kind).toBe('fitted-estimate');
    expect(record.fields.observations.kind).toBe('observation');
    expect(result.options).toEqual({ bootstrapSamples: 200, seed: 42 });
    expect(result.coverage).toEqual({ observations: 56, variants: 5, doubleVariants: 2, estimatedPairs: 1, unavailablePairs: 1 });
    const pair = result.pairs.find(item => item.variant === 'A1G:C2T')!;
    expect(pair.contrast).toBe(4); // Three block contrasts 1,4,7.
    expect(pair.standardError).toBeCloseTo(Math.sqrt(3), 12);
    expect(pair.completeBlocks).toEqual(['block-0', 'block-1', 'block-2']);
    expect(pair.incompleteBlocks).toHaveLength(43);
    expect(pair.interval95).not.toBeNull();
    const missing = result.pairs.find(item => item.variant === 'A1G:D3E')!;
    expect(missing.contrast).toBeNull(); expect(missing.missingVariants).toEqual(['D3E']);
    await panel.getByRole('button', { name: 'A1G:C2T', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Selected epistasis contrast' })).toContainText('43 excluded incomplete blocks');
    await panel.getByRole('button', { name: 'A1G:D3E', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Selected epistasis contrast' })).toContainText('Missing genotype groups: D3E');

    await panel.getByRole('button', { name: 'All assay observations', exact: true }).click();
    await expect(panel.getByTestId('epistasis-observation')).toHaveCount(50);
    await panel.getByRole('button', { name: 'Next assay rows', exact: true }).click();
    await expect(panel.getByTestId('epistasis-observation')).toHaveCount(6);
    const observationTsv = await download(page, () => panel.getByRole('button', { name: 'Export all assay observations TSV', exact: true }).click());
    const observationRows = observationTsv.trimEnd().split('\n').filter(row => !row.startsWith('#'));
    expect(observationRows).toHaveLength(57);
    expect(observationTsv).toContain('EPI_PRIVATE_UNMATCHED_42');
    const pairTsv = await download(page, () => panel.getByRole('button', { name: 'Export all contrasts TSV', exact: true }).click());
    const pairRows = pairTsv.trimEnd().split('\n').filter(row => !row.startsWith('#'));
    expect(pairRows).toHaveLength(3);
    expect(pairRows[1].split('\t').slice(5, 9)).toEqual(['estimated', '14', '10', '4']);
    expect(pairRows[2].split('\t').slice(5, 9)).toEqual(['unavailable', 'NA', 'NA', 'NA']);
    expect(pairTsv).toContain('D3E');

    await panel.getByText('Paste or edit an assay dataset', { exact: true }).click();
    const changed = { ...DATASET, name: 'EPI_PRIVATE_UNACCEPTED_EDIT' };
    await panel.getByLabel('Epistasis assay JSON draft', { exact: true }).fill(JSON.stringify(changed));
    await panel.getByLabel('Bootstrap samples (0 or 200–2000)', { exact: true }).fill('0');
    await expect(panel.getByTestId('epistasis-result')).toHaveAttribute('data-result-id', record.resultId);
    expect(await exportRecord()).toBe(evidence);
    const acceptedDataset = JSON.parse(await download(page,
      () => panel.getByRole('button', { name: 'Export accepted assay', exact: true }).click()));
    expect(acceptedDataset).toEqual(validateEpistasisAssayDataset(DATASET));

    await page.reload(); await expectExplorerIdentity(page, info); panel = await open(page);
    await expect(panel.getByTestId('epistasis-result')).toHaveCount(0);
    await load(panel, evidence);
    await expect(panel.getByTestId('epistasis-notice')).toContainText('Verified replay');
    await expect(panel.getByTestId('epistasis-result')).toHaveAttribute('data-result-id', record.resultId);
    expect(await exportRecord()).toBe(evidence);
    await expect(panel.getByLabel('Bootstrap samples (0 or 200–2000)', { exact: true })).toHaveValue('200');
    const forged = await parseAnalysisRecord(evidence);
    (forged.fields.result.value as unknown as EpistasisAssayResult).pairs[0].contrast = 88;
    const rehashed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    await load(panel, serializeAnalysisRecord(rehashed));
    await expect(panel.getByRole('alert')).toContainText('differs');
    await expect(panel.getByTestId('epistasis-result')).toHaveAttribute('data-result-id', record.resultId);
    await load(panel, '{"format":"wrong"}');
    await expect(panel.getByRole('alert')).toContainText('Unsupported epistasis assay');
    await expect(panel.getByTestId('epistasis-result')).toHaveAttribute('data-result-id', record.resultId);

    // Hold an actual new worker at its script request so cancellation is deterministic.
    let requested = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workerUrl = /epistasis-evidence\.worker[^/]*\.(?:js|ts)/;
    await page.route(workerUrl, async route => { requested = true; await gate; await route.continue().catch(() => {}); });
    await load(panel, evidence); await expect.poll(() => requested).toBe(true);
    await panel.getByRole('button', { name: 'Cancel epistasis operation', exact: true }).click();
    release?.();
    await expect(panel.getByTestId('epistasis-notice')).toContainText('Cancelled');
    await expect(panel.getByTestId('epistasis-result')).toHaveAttribute('data-result-id', record.resultId);
    await page.unroute(workerUrl);
    expect(requests.some(request => /EPI_PRIVATE_|epi-private-assay/.test(request))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally { release?.(); await finalize(); }
});

test('demo assays require an explicit choice and remain labeled through the real worker and downloads', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    const panel = await start(page, info);
    await expect(panel.getByTestId('epistasis-result')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Load synthetic assay example', exact: true }).click();
    await expect(panel.getByTestId('epistasis-source')).toContainText('SYNTHETIC ASSAY EXAMPLE');
    await expect(panel.getByTestId('epistasis-result')).toHaveCount(0);
    await panel.getByLabel('Bootstrap samples (0 or 200–2000)', { exact: true }).fill('0');
    await panel.getByRole('button', { name: 'Analyze accepted assay', exact: true }).click();
    await expect(panel.getByTestId('epistasis-result')).toBeVisible();
    const record = await parseAnalysisRecord(await download(page,
      () => panel.getByRole('button', { name: 'Export epistasis evidence', exact: true }).click()));
    expect(record.inputs[0].source).toBe('demo');
    expect(record.fields.result.kind).toBe('demo');
    expect(record.fields.observations.kind).toBe('demo');
    expect((record.fields.result.value as unknown as EpistasisAssayResult).pairs[0].contrast).toBe(3);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
