import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { hostGeneWorkflowFixture } from '../../core/src/analysis/host-gene-knockout.fixture';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import type { HostGeneResult } from '../../core/src/analysis/host-gene-knockout';

test('private model-gene workflow computes joint and single deletions, reloads and verifies actual worker results', async ({ page }) => {
  test.setTimeout(180000);
  const pageErrors: string[] = [], outgoingInputs: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.postData()?.includes('Independent two-route') || request.postData()?.includes('Gene workflow browser fixture')) outgoingInputs.push(request.url());
  });
  await page.goto('/?workspace=host-metabolism');
  const importer = page.getByLabel('Import host-model dataset or saved experiment JSON', { exact: true });
  const load = (content: string, name = 'host-model.json') => importer.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
  const result = page.getByTestId('host-gene-result');
  const outcomes = page.getByRole('table', { name: 'Gene-deletion scenario outcomes', exact: true }).locator('tbody tr');
  const exportResult = async () => {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export accepted host experiment', exact: true }).click();
    const download = await downloading;
    return readFile((await download.path())!, 'utf8');
  };
  const model = hostGeneWorkflowFixture();
  model.source.reference = 'Gene workflow browser fixture <script>window.fixtureExecuted=true</script>';
  await load(JSON.stringify(model));
  await expect(page.getByTestId('host-model-status')).toContainText('Host model loaded');
  await page.getByLabel('Knockout model gene IDs (up to 32)', { exact: true }).selectOption(['c', 'd']);
  await page.getByLabel('Gene-deletion source or what-if assumption', { exact: true }).fill('Joint redundant-alternative deletion, explicitly synthetic.');
  await page.getByLabel('Knockout flux-range reactions', { exact: true }).selectOption(['complex', 'alternative']);
  await page.getByRole('button', { name: 'Run gene knockout experiments', exact: true }).click();
  await expect(page.getByTestId('host-gene-baseline')).toContainText('optimal / 9.000000');
  await expect(outcomes).toHaveCount(1);
  await expect(outcomes.nth(0).locator('td').nth(3)).toHaveText('6.000000');
  await expect(outcomes.nth(0).locator('td').nth(1)).toHaveText('1');
  const jointText = await exportResult(), jointRecord = await parseAnalysisRecord(jointText);
  const joint = jointRecord.fields.experiment.value as unknown as HostGeneResult;
  expect(jointRecord.method.id).toBe('host-gene-knockout');
  expect(joint.options.genes).toEqual(['c', 'd']);
  expect(joint.runs[0].disabled.map(row => row.reactionId)).toEqual(['alternative']);
  expect(joint.runs[0].scenario.objective).toBeCloseTo(6, 8);
  expect(joint.runs[0].scenario.ranges[1].maximum.value).toBeCloseTo(0, 8);

  // Unsubmitted controls cannot change the displayed evidence or its exported identity.
  await page.getByLabel('Gene-deletion mode', { exact: true }).selectOption('single');
  await expect(page.getByText('Gene-deletion draft changes are not applied. Exports retain the accepted experiment.', { exact: true })).toBeVisible();
  expect((await parseAnalysisRecord(await exportResult())).resultId).toBe(jointRecord.resultId);
  await page.getByRole('button', { name: 'Run gene knockout experiments', exact: true }).click();
  await expect(outcomes).toHaveCount(2);
  await expect(outcomes.nth(0).locator('td').nth(3)).toHaveText('9.000000');
  await expect(outcomes.nth(1).locator('td').nth(3)).toHaveText('9.000000');
  const singleText = await exportResult(), singleRecord = await parseAnalysisRecord(singleText);
  expect(singleRecord.resultId).not.toBe(jointRecord.resultId);

  await page.reload();
  await expect(page.getByTestId('host-model-status')).toContainText('No host model loaded');
  await load(jointText, 'saved-joint.json');
  await expect(page.getByTestId('host-model-status')).toContainText('Verified host-model replay');
  await expect(result).toHaveAttribute('data-result-id', jointRecord.resultId);
  expect((await parseAnalysisRecord(await exportResult())).resultId).toBe(jointRecord.resultId);

  // Internally consistent hashes are not permission to install forged numerical evidence.
  const forged = await parseAnalysisRecord(jointText);
  (forged.fields.experiment.value as unknown as HostGeneResult).runs[0].scenario.objective = 999;
  const resigned = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
  await load(serializeAnalysisRecord(resigned), 'forged-result.json');
  await expect(page.getByRole('alert')).toContainText('Fresh gene-knockout results or evidence differ');
  await expect(result).toHaveAttribute('data-result-id', jointRecord.resultId);

  // Hold only the file read, not the worker or numeric result; cancellation must stop
  // that late file from scheduling a new worker or overwriting the accepted run.
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name !== 'delayed-model.json') return original.call(this);
      return new Promise<string>((resolve, reject) => {
        (window as unknown as { releaseGeneInput: () => void }).releaseGeneInput = () => { void original.call(this).then(resolve, reject); };
      });
    };
  });
  await load(JSON.stringify(model), 'delayed-model.json');
  await expect(page.getByRole('button', { name: 'Cancel host-model work', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel host-model work', exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseGeneInput: () => void }).releaseGeneInput());
  await expect(page.getByTestId('host-model-status')).toContainText('cancelled');
  await expect(result).toHaveAttribute('data-result-id', jointRecord.resultId);
  expect((await parseAnalysisRecord(await exportResult())).resultId).toBe(jointRecord.resultId);

  // Failed input cannot replace the accepted model. A successfully loaded new input can.
  const invalid = hostGeneWorkflowFixture();
  (invalid.cobra as { reactions: Array<{ gene_reaction_rule?: string }> }).reactions[1].gene_reaction_rule = 'a and missing';
  await load(JSON.stringify(invalid));
  await expect(page.getByTestId('host-model-status')).toContainText('Host model loaded');
  await expect(result).toHaveCount(0);
  await expect(page.getByText(/Gene-rule analysis unavailable:/)).toContainText('undeclared gene');
  await expect(page.getByRole('button', { name: 'Run host-model scenarios', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { fixtureExecuted?: boolean }).fixtureExecuted)).toBeUndefined();
  expect(outgoingInputs).toEqual([]);
  expect(pageErrors).toEqual([]);
});
