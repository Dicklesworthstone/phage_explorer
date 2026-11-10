import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import type { EnvironmentalAnalysis, EnvironmentalDataset } from '../../core/src/analysis/environmental-evidence';
import type { AbundanceDataset } from '../../core/src/analysis/abundance';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

// Keep explicit public requests and disposable worker loads under route control.
test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'default' });

// Artificial regression observations, supplied as local input. The fixture
// deliberately distinguishes a positive assay, measured zero, and missing assays.
const DATASET: EnvironmentalDataset = {
  format: 'phage-explorer-environmental', version: 1, name: 'ENV_PRIVATE_OBSERVATIONS',
  query: { id: 'ENV_PRIVATE_TAXON', label: '<b>literal environmental query</b>', accession: null },
  source: { kind: 'local', study: 'Hand-constructed browser fixture; no empirical environmental claim', reference: null, version: 'test-1', license: 'CC0' },
  measurement: { type: 'counts', method: 'Artificial declared assay counts', normalization: 'none' },
  samples: [
    { id: 'ENV_PRIVATE_DETECTED', accession: 'fixture:1', biome: 'freshwater', country: 'Test',
      location: { latitude: 42, longitude: -70, uncertaintyKm: 12 }, collectionDate: '2024', occurrence: 'detected', abundance: 6 },
    { id: 'ENV_PRIVATE_ZERO', accession: null, biome: 'freshwater', country: 'USA', location: null,
      collectionDate: '2024-02', occurrence: 'not-detected', abundance: 0 },
    ...Array.from({ length: 55 }, (_, index) => ({ id: `ENV_PRIVATE_MISSING_${index}`, accession: null,
      biome: 'wastewater' as const, country: 'Germany', location: null, collectionDate: null,
      occurrence: 'not-assayed' as const, abundance: null })),
  ],
};
const ABUNDANCE: AbundanceDataset = {
  format: 'phage-explorer-abundance', version: 1, name: 'ENV_PRIVATE_ABUNDANCE', units: 'counts',
  source: { kind: 'local', description: 'Hand-constructed row and metadata join fixture', reference: null },
  table: { taxa: ['ENV_PRIVATE_TAXON', 'different-taxon'], samples: ['s1', 's2', 's3'], counts: [[8, 0, 2], [1, 9, 3]] },
  // Deliberately out of order. s2 has no metadata; its zero remains an assay.
  metadata: [{ sampleId: 's3', habitat: 'wastewater', country: 'Test third', collectionDate: '2023-08' },
    { sampleId: 's1', habitat: 'freshwater', latitude: 40, longitude: -70, uncertaintyKm: 5, collectionDate: '2023' }],
};
const CONTEXT_URL = /api\.serratus\.io|eutils\.ncbi\.nlm\.nih\.gov/;

async function start(page: Page, info: TestInfo): Promise<Locator> {
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, info);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  return open(page);
}
async function open(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+Shift+e');
  const panel = page.getByRole('region', { name: 'Environmental evidence workspace', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
async function load(panel: Locator, content: string): Promise<void> {
  await panel.getByLabel('Import environmental dataset or saved evidence JSON', { exact: true }).setInputFiles({
    name: 'private-environment.json', mimeType: 'application/json', buffer: Buffer.from(content),
  });
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download');
  await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('No environmental download stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('local environmental observations survive full export, verified replay, rejection and cancellation without uploads', async ({ page }, info) => {
  test.setTimeout(180000);
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  let release: (() => void) | undefined;
  try {
    let panel = await start(page, info);
    const firstRequest = requests.length;
    await expect(panel.getByTestId('environmental-source')).toHaveText('NO ENVIRONMENTAL DATA LOADED');
    await expect(panel.getByTestId('environmental-result')).toHaveCount(0);
    await load(panel, JSON.stringify(DATASET));
    await expect(panel.getByTestId('environmental-notice')).toContainText('Dataset loaded');
    await expect(panel.getByTestId('environmental-dataset-name')).toHaveText(DATASET.name);
    await expect(panel.getByTestId('environmental-result')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Export environmental evidence', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Analyze environmental observations', exact: true }).click();
    await expect(panel.getByTestId('environmental-result')).toBeVisible();
    await expect(panel.getByTestId('environmental-source')).toContainText('LOCAL INPUT');
    await expect(panel.locator('b').filter({ hasText: 'literal environmental query' })).toHaveCount(0);
    const exportRecord = () => download(page, () => panel.getByRole('button', { name: 'Export environmental evidence', exact: true }).click());
    const evidence = await exportRecord(), record = await parseAnalysisRecord(evidence);
    const result = record.fields.environment.value as unknown as EnvironmentalAnalysis;
    expect(result.totals).toEqual({ samples: 57, assayed: 2, detected: 1, notDetected: 1, notAssayed: 55, located: 1, dated: 2 });
    expect(record.inputs[0].data).toEqual(DATASET);
    expect(record.fields.environment.kind).toBe('observation');
    expect(record.fields.environment.coverage).toEqual({ available: 2, total: 57, unit: 'records' });
    await panel.getByRole('button', { name: 'Biomes', exact: true }).click();
    await expect(panel.getByRole('table', { name: 'Environmental biome summaries', exact: true })).toContainText('50.0%');
    await expect(panel.getByRole('table', { name: 'Environmental biome summaries', exact: true })).toContainText('Unavailable — no assays');
    await panel.getByRole('button', { name: 'Geography', exact: true }).click();
    const map = panel.getByRole('img', { name: 'Reported environmental sample coordinates', exact: true });
    await expect(map.locator('[data-sample-id]')).toHaveCount(1);
    await expect(map.locator('[data-sample-id]')).toHaveAttribute('data-sample-id', 'ENV_PRIVATE_DETECTED');
    await panel.getByRole('button', { name: 'All observations', exact: true }).click();
    await expect(panel.getByTestId('environmental-observation')).toHaveCount(50);
    await expect(panel.getByTestId('environmental-observation').nth(0)).toContainText('2024 (year only)');
    await expect(panel.getByTestId('environmental-observation').nth(0)).toContainText('12 km stated uncertainty');
    await expect(panel.getByTestId('environmental-observation').nth(1)).toContainText('2024-02 (month precision)');
    await expect(panel.getByTestId('environmental-observation').nth(1)).toContainText('Not detected in this assay');
    await expect(panel.getByTestId('environmental-observation').nth(2)).toContainText('Not measured');
    await panel.getByRole('button', { name: 'Next observations', exact: true }).click();
    await expect(panel.getByTestId('environmental-observation')).toHaveCount(7);
    await expect(panel.getByTestId('environmental-observation').last()).toContainText('ENV_PRIVATE_MISSING_54');
    const input = await download(page, () => panel.getByRole('button', { name: 'Export environmental dataset', exact: true }).click());
    expect(JSON.parse(input)).toEqual(DATASET);
    const tsv = await download(page, () => panel.getByRole('button', { name: 'Export all observations TSV', exact: true }).click());
    const rows = tsv.trimEnd().split('\n').filter(row => !row.startsWith('#')).map(row => row.split('\t'));
    expect(rows).toHaveLength(58);
    expect(rows[2].slice(4, 10)).toEqual(['', '', '', '2024-02', 'not-detected', '0']);
    expect(rows.at(-1)?.slice(7, 10)).toEqual(['', 'not-assayed', '']);
    expect(tsv).toContain('ENV_PRIVATE_MISSING_54');
    expect(tsv).toContain('not ecological prevalence');

    await page.reload(); await expectExplorerIdentity(page, info); panel = await open(page);
    await expect(panel.getByTestId('environmental-result')).toHaveCount(0);
    await load(panel, evidence);
    await expect(panel.getByTestId('environmental-notice')).toContainText('Verified replay');
    await expect(panel.getByTestId('environmental-result')).toHaveAttribute('data-result-id', record.resultId);
    expect((await parseAnalysisRecord(await exportRecord())).resultId).toBe(record.resultId);
    const forged = await parseAnalysisRecord(evidence);
    (forged.fields.environment.value as unknown as EnvironmentalAnalysis).totals.detected = 56;
    const resigned = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...item }) => item) });
    await load(panel, serializeAnalysisRecord(resigned));
    await expect(panel.getByRole('alert')).toContainText('Recomputed environmental evidence differs');
    await expect(panel.getByTestId('environmental-result')).toHaveAttribute('data-result-id', record.resultId);
    await load(panel, '{"format":"wrong"}');
    await expect(panel.getByRole('alert')).toContainText('Environmental dataset');
    await expect(panel.getByTestId('environmental-result')).toHaveAttribute('data-result-id', record.resultId);
    let requested = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workerUrl = /environmental\.worker[^/]*\.(?:js|ts)/;
    await page.route(workerUrl, async route => { requested = true; await gate; await route.continue().catch(() => {}); });
    await load(panel, evidence);
    await expect.poll(() => requested).toBe(true);
    await panel.getByRole('button', { name: 'Cancel environmental work', exact: true }).click();
    release?.();
    await expect(panel.getByTestId('environmental-notice')).toContainText('Cancelled');
    await expect(panel.getByTestId('environmental-result')).toHaveAttribute('data-result-id', record.resultId);
    await page.unroute(workerUrl);
    expect(requests.slice(firstRequest).filter(value => CONTEXT_URL.test(value))).toEqual([]);
    expect(requests.some(value => /ENV_PRIVATE_|private-environment|literal environmental query/.test(value))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally { release?.(); await finalize(); }
});

test('an explicitly selected abundance row joins metadata by sample identifier and keeps supplied units', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const requests: string[] = [];
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  try {
    const panel = await start(page, info);
    await panel.getByText('Use a taxon from an abundance dataset', { exact: true }).click();
    await panel.getByLabel('Abundance dataset JSON', { exact: true }).setInputFiles({
      name: 'private-abundance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ABUNDANCE)),
    });
    await panel.getByLabel('Exact abundance taxon identifier', { exact: true }).fill('unknown-taxon');
    await panel.getByRole('button', { name: 'Load selected abundance taxon', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Select an exact taxon identifier');
    await expect(panel.getByTestId('environmental-result')).toHaveCount(0);
    await panel.getByLabel('Exact abundance taxon identifier', { exact: true }).fill('ENV_PRIVATE_TAXON');
    await panel.getByRole('button', { name: 'Load selected abundance taxon', exact: true }).click();
    await expect(panel.getByTestId('environmental-notice')).toContainText('Dataset loaded');
    await panel.getByRole('button', { name: 'Analyze environmental observations', exact: true }).click();
    await expect(panel.getByTestId('environmental-result')).toBeVisible();
    const dataset: EnvironmentalDataset = JSON.parse(await download(page, () => panel.getByRole('button', { name: 'Export environmental dataset', exact: true }).click()));
    expect(dataset.query.id).toBe('ENV_PRIVATE_TAXON');
    expect(dataset.measurement.type).toBe('counts');
    expect(dataset.samples.map(sample => [sample.id, sample.biome, sample.occurrence, sample.abundance, sample.collectionDate])).toEqual([
      ['s1', 'freshwater', 'detected', 8, '2023'], ['s2', 'unknown', 'not-detected', 0, null], ['s3', 'wastewater', 'detected', 2, '2023-08'],
    ]);
    expect(dataset.samples[0].location).toEqual({ latitude: 40, longitude: -70, uncertaintyKm: 5 });
    expect(dataset.samples[2].location).toBeNull();
    expect(requests.some(value => /ENV_PRIVATE_|private-abundance/.test(value) || CONTEXT_URL.test(value))).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('a failed explicit public lookup preserves accepted observations and never silently substitutes a demo', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  const lookupRequests: string[] = [];
  await page.route(CONTEXT_URL, async route => {
    lookupRequests.push(`${route.request().url()} ${route.request().postData() ?? ''}`);
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"deliberate test outage"}' });
  });
  try {
    const panel = await start(page, info);
    expect(lookupRequests).toEqual([]);
    await load(panel, JSON.stringify(DATASET));
    await expect(panel.getByTestId('environmental-notice')).toContainText('Dataset loaded');
    await panel.getByRole('button', { name: 'Analyze environmental observations', exact: true }).click();
    await expect(panel.getByTestId('environmental-result')).toBeVisible();
    const resultId = await panel.getByTestId('environmental-result').getAttribute('data-result-id');
    await panel.getByText('Optional public reference context', { exact: true }).click();
    await panel.getByRole('button', { name: 'Fetch public phage-family context', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Public family lookup failed');
    await expect(panel.getByTestId('environmental-result')).toHaveAttribute('data-result-id', resultId!);
    await expect(panel.getByTestId('environmental-source')).toContainText('LOCAL INPUT');
    expect(lookupRequests.length).toBeGreaterThan(0);
    expect(lookupRequests.some(value => /ENV_PRIVATE_|literal environmental query|lambda/i.test(value))).toBe(false);
    await panel.getByRole('button', { name: 'Load synthetic environmental example', exact: true }).click();
    await expect(panel.getByTestId('environmental-source')).toContainText('SYNTHETIC EXAMPLE');
    await expect(panel.getByTestId('environmental-result')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Analyze environmental observations', exact: true }).click();
    await panel.getByRole('button', { name: 'Geography', exact: true }).click();
    await expect(panel.getByRole('img', { name: 'Reported environmental sample coordinates', exact: true })).toContainText('DEMO DATA — synthetic sample set');
    const record = await parseAnalysisRecord(await download(page, () => panel.getByRole('button', { name: 'Export environmental evidence', exact: true }).click()));
    expect(record.inputs[0].source).toBe('demo');
    expect(record.fields.environment.kind).toBe('demo');
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
