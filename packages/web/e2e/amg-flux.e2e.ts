import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';
import { parseAnalysisRecord } from '../../core/src/analysis-result';

test.use({ userAgent: 'OpenAI File Downloader, XaiImageApiFetch/1.0' });

test('flux sandbox changes assumptions, imports real LP inputs, exports raw fluxes and exposes infeasibility', async ({ page }, testInfo) => {
  const { pageErrors, finalize } = setupTestHarness(page, testInfo);
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    });
    await page.goto('/?phage=lambda&model=0');
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.keyboard.press('Alt+a');
    const dialog = page.getByRole('dialog', { name: /AUXILIARY METABOLIC GENES/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Flux Potential/ }).click();
    await expect(dialog.getByText('Illustrative precursor network', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('does not predict');
    const exportResult = async () => {
      const downloading = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Export model and flux results' }).click();
      const stream = await (await downloading).createReadStream();
      const chunks = [];
      for await (const chunk of stream!) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    const before = await exportResult();
    await dialog.getByRole('slider', { name: /Assumed capacity multiplier/ }).fill('10');
    const after = await exportResult();
    expect(after.parameters.boostFactor).toBe(10);
    expect(before.parameters.boostFactor).toBe(5);
    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(after.fields.baselineObjective.kind).toBe('demo');
    expect(after.fields.baselineObjective.units).toBe('arbitrary-flux');
    const teachingModel = after.inputs.find((input: { id: string }) => input.id === 'metabolic-model').data;
    expect(after.fields.baselineFluxes.value[teachingModel.objectiveReaction]).toBeCloseTo(after.fields.baselineObjective.value, 8);
    expect(await parseAnalysisRecord(JSON.stringify(after))).toEqual(after);

    // Explicit synthetic LP input: source=sink, 2<=source<=5, 1<=sink<=10.
    const model = { id: 'bounded-example', name: 'Known five-unit optimum', description: 'Analytic test input', metabolites: ['a'], objectiveReaction: 'sink', reactions: [
      { id: 'source', name: 'Source', subsystem: 'Exchange', stoichiometry: { a: 1 }, lowerBound: 2, upperBound: 5, reversible: false, koIds: [] },
      { id: 'sink', name: 'Sink', subsystem: 'Exchange', stoichiometry: { a: -1 }, lowerBound: 1, upperBound: 10, reversible: false, koIds: [] },
    ] };
    await dialog.getByLabel('Import model JSON').setInputFiles({ name: 'model.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(model)) });
    await expect(dialog.getByText(model.name, { exact: true })).toBeVisible();
    const imported = await exportResult();
    expect(imported.parameters.modelSource).toBe('imported');
    expect(imported.inputs.find((input: { id: string }) => input.id === 'metabolic-model').data).toEqual(model);
    expect(imported.fields.baselineObjective).toMatchObject({ kind: 'simulation', units: 'model-flux' });
    expect(imported.fields.baselineObjective.value).toBeCloseTo(5, 8);
    expect(imported.fields.baselineFluxes.value.source).toBeCloseTo(5, 8);
    expect(imported.fields.baselineFluxes.value.sink).toBeCloseTo(5, 8);
    expect(imported.inputs.find((input: { id: string }) => input.id === 'annotations').accession).toBe('NC_001416.1');
    await dialog.getByText('Experiment inputs and evidence', { exact: true }).click();
    await expect(dialog.getByLabel('Analysis evidence and inputs')).toContainText(imported.cacheKey);
    await expect(dialog.getByLabel('Analysis evidence and inputs')).toContainText('not calibrated probabilities');
    await dialog.getByRole('button', { name: 'Use teaching model', exact: true }).click();
    await dialog.getByRole('slider', { name: /Assumed capacity multiplier/ }).fill('5');
    await dialog.getByLabel('Restore experiment JSON').setInputFiles({ name: 'experiment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(dialog.getByRole('status')).toContainText('Experiment inputs restored');
    expect(await exportResult()).toEqual(imported);
    await dialog.getByRole('button', { name: 'Copy experiment JSON', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Experiment JSON copied');
    await page.evaluate(() => {
      const probe = document.createElement('textarea');
      probe.setAttribute('data-testid', 'experiment-clipboard-probe');
      document.body.appendChild(probe);
      probe.focus();
    });
    await page.keyboard.press('ControlOrMeta+V');
    const clipboard = page.getByTestId('experiment-clipboard-probe');
    await expect(clipboard).not.toHaveValue('');
    expect(JSON.parse(await clipboard.inputValue())).toEqual(imported);
    await clipboard.evaluate(element => element.remove());

    const damaged = structuredClone(imported);
    damaged.inputs.find((input: { id: string }) => input.id === 'metabolic-model').data.reactions[0].upperBound = 4;
    await dialog.getByLabel('Restore experiment JSON').setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) });
    await expect(dialog.getByRole('alert')).toContainText('checksum mismatch');
    expect(await exportResult()).toEqual(imported);

    model.reactions[0].lowerBound = 6;
    await dialog.getByLabel('Import model JSON').setInputFiles({ name: 'impossible.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(model)) });
    await expect(dialog.getByRole('alert')).toContainText('infeasible');
    const impossible = await exportResult();
    expect(impossible.fields.baselineObjective).toMatchObject({ kind: 'unavailable', value: null, units: null });
    expect(impossible.fields.objectiveChanges).toMatchObject({ kind: 'unavailable', value: null });
    await expect(dialog.getByText('Max Objective Gain', { exact: true })).toHaveCount(0);
    await testInfo.attach('portable-amg-experiment', { body: JSON.stringify(imported), contentType: 'application/json' });
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('Alt+a');
    await dialog.getByRole('button', { name: /Flux Potential/ }).click();
    const t7 = await exportResult();
    expect(t7.inputs.find((input: { id: string }) => input.id === 'annotations').accession).not.toBe('NC_001416.1');
    expect(t7.cacheKey).not.toBe(impossible.cacheKey);
    await dialog.getByLabel('Restore experiment JSON').setInputFiles({ name: 'lambda-experiment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(dialog.getByRole('alert').filter({ hasText: 'different gene annotations' })).toBeVisible();
    expect(await exportResult()).toEqual(t7);
    // Delay the completion of a real file read, close the panel, then release
    // it. No fabricated solver result or successful import is supplied here.
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = async function () {
        const content = await original.call(this);
        if (this.name === 'pending-model.json') {
          await new Promise<void>(resolve => { (window as any).__releaseAmgRead = () => { File.prototype.text = original; resolve(); }; });
        }
        return content;
      };
    });
    await dialog.getByLabel('Import model JSON').setInputFiles({ name: 'pending-model.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...model, name: 'Cancelled late model' })) });
    await page.waitForFunction(() => typeof (window as any).__releaseAmgRead === 'function');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.evaluate(() => (window as any).__releaseAmgRead());
    await page.keyboard.press('Alt+a');
    await dialog.getByRole('button', { name: /Flux Potential/ }).click();
    expect(await exportResult()).toEqual(t7);
    await expect(dialog.getByText('Cancelled late model', { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await finalize();
  }
});
