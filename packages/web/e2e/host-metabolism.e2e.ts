import { test, expect, type Page } from '@playwright/test';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';

// Independent algebra: -EX=A+B=BIO. Baseline objective=10, routes can each
// carry anything in [0,10]. Simultaneous capacities A<=2,B<=3 reduce it to 5.
const COBRA = { id: 'parallel', compartments: { c: 'cytosol' },
  metabolites: [{ id: 'a', compartment: 'c' }, { id: 'b', compartment: 'c' }], reactions: [
    { id: 'EX', metabolites: { a: -1 }, lower_bound: -10, upper_bound: 0 },
    { id: 'A', name: '<b>literal route</b>', metabolites: { a: -1, b: 1 }, lower_bound: 0, upper_bound: 10 },
    { id: 'B', metabolites: { a: -1, b: 1 }, lower_bound: 0, upper_bound: 10 },
    { id: 'BIO', metabolites: { b: -1 }, lower_bound: 0, upper_bound: 100, objective_coefficient: 1 },
  ] };
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action(); const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Export was not available'); const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8');
}

test('private COBRA models reach actual workers, simultaneous scenario ranges and verified replay', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [], privateRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const details = `${request.url()} ${request.postData() ?? ''}`;
    if (details.includes('private-host-fixture') || details.includes('field-medium-evidence')) privateRequests.push(details);
  });
  let release: (() => void) | undefined;
  try {
    await page.goto('/?workspace=host-metabolism');
    const panel = page.getByRole('region', { name: 'Sourced host metabolism', exact: true });
    await expect(panel).toBeVisible(); await expect(panel.getByTestId('host-model-result')).toHaveCount(0);
    await panel.getByLabel('COBRA model JSON', { exact: true }).fill(JSON.stringify(COBRA));
    for (const [label, value] of Object.entries({
      'Host model name': 'private-host-fixture', 'Host model version': '1', 'Host organism': 'Synthetic test', 'Host strain': 'Not biological',
      'Host model accession': 'analytical-reference', 'Host model source reference': 'independent conservation law', 'Host model license or permissions': 'CC0',
      'Host reaction flux units': 'arbitrary units', 'Host objective units': 'arbitrary units', 'Host medium name': 'Ten units', 'Host medium reference and assumptions': 'field-medium-evidence',
    })) await panel.getByLabel(label, { exact: true }).fill(value);
    await panel.getByLabel('Host model provenance category', { exact: true }).selectOption('demo');
    await panel.getByRole('button', { name: 'Load and validate host model', exact: true }).click();
    await expect(panel.getByTestId('host-model-status')).toContainText('Host model loaded');
    await expect(panel.getByTestId('host-model-result')).toHaveCount(0);
    await panel.getByLabel('Flux-range reactions (up to 12)', { exact: true }).selectOption(['A', 'B', 'BIO']);
    const add = async (reaction: string, lower: string, upper: string) => {
      await panel.getByLabel('Mapped model reaction', { exact: true }).selectOption(reaction);
      await panel.getByLabel('Scenario lower bound', { exact: true }).fill(lower);
      await panel.getByLabel('Scenario upper bound', { exact: true }).fill(upper);
      await panel.getByLabel('Reaction-change reference', { exact: true }).fill('analytical capacity constraint');
      await panel.getByLabel('Capacity-change explanation', { exact: true }).fill('User-selected signed absolute bound; not biological activity');
      await panel.getByRole('button', { name: 'Add reaction change', exact: true }).click();
    };
    await add('A', '0', '2'); await add('B', '0', '3');
    await panel.getByRole('button', { name: 'Run host-model scenarios', exact: true }).click();
    const result = panel.getByTestId('host-model-result'); await expect(result).toBeVisible();
    const exported = () => download(page, () => panel.getByRole('button', { name: 'Export accepted host experiment', exact: true }).click());
    const content = await exported(), record = await parseAnalysisRecord(content);
    const baseline = record.fields.baseline.value as { objective: number; ranges: Array<{reactionId: string; minimum: {value: number}; maximum: {value: number}}> };
    const scenario = record.fields.perturbed.value as typeof baseline;
    expect(baseline.objective).toBe(10); expect(scenario.objective).toBe(5);
    expect((record.fields.comparison.value as {objectiveDelta: number}).objectiveDelta).toBe(-5);
    const a = baseline.ranges.find(row => row.reactionId === 'A')!;
    expect(a.minimum.value).toBeCloseTo(0, 6); expect(a.maximum.value).toBeCloseTo(10, 6);
    expect(scenario.ranges.find(row => row.reactionId === 'A')!.minimum.value).toBeCloseTo(2, 5);
    expect(record.fields.baseline.kind).toBe('demo');
    await expect(panel.getByRole('table', { name: 'Host fluxes and alternative-optimum ranges', exact: true })).toContainText('<b>literal route</b>');
    await expect(panel.locator('b').filter({ hasText: 'literal route' })).toHaveCount(0);
    await panel.getByLabel('Allowed absolute objective loss', { exact: true }).fill('1');
    expect((await parseAnalysisRecord(await exported())).resultId).toBe(record.resultId);
    await page.reload(); await expect(panel).toBeVisible();
    const load = (text: string) => panel.getByLabel('Import host-model dataset or saved experiment JSON', { exact: true })
      .setInputFiles({ name: 'private-host-fixture.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await load(content); await expect(panel.getByTestId('host-model-status')).toContainText('Verified host-model replay');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    expect((await parseAnalysisRecord(await exported())).resultId).toBe(record.resultId);
    const forged = await parseAnalysisRecord(content); (forged.fields.baseline.value as Record<string, unknown>).objective = 500;
    const signed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    await load(serializeAnalysisRecord(signed)); await expect(panel.getByRole('alert')).toContainText('Fresh host-model results differ');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    // Stall the actual worker module load, not a mocked computed response.
    let requested = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(/host-metabolism\.worker[^/]*\.(?:ts|js)/, async route => { requested = true; await gate; await route.continue().catch(() => {}); });
    await load(content); await expect.poll(() => requested).toBe(true);
    await panel.getByRole('button', { name: 'Cancel host-model work', exact: true }).click(); release?.();
    await expect(panel.getByTestId('host-model-status')).toContainText('Host-model work cancelled');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    await page.unroute(/host-metabolism\.worker[^/]*\.(?:ts|js)/);
    await load('{}'); await expect(panel.getByRole('alert')).toContainText('Unsupported host-model');
    await expect(result).toHaveAttribute('data-result-id', record.resultId);
    await add('EX', '0', '0');
    await panel.getByRole('button', { name: 'Remove A', exact: true }).click(); await add('A', '1', '2');
    await panel.getByRole('button', { name: 'Run host-model scenarios', exact: true }).click();
    await expect(panel.getByTestId('host-model-status')).toContainText('computed');
    await expect(panel.getByTestId('host-model-objectives')).toContainText('infeasible');
    const failure = await parseAnalysisRecord(await exported());
    expect((failure.fields.comparison.value as {objectiveDelta: number | null}).objectiveDelta).toBeNull();
    expect(privateRequests).toEqual([]); expect(errors).toEqual([]);
  } finally { release?.(); }
});
