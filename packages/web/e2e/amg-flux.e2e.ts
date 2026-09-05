import { test, expect } from '@playwright/test';
import { setupTestHarness } from './e2e-harness';

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
    expect(after.boostMultiplier).toBe(10);
    expect(before.boostMultiplier).toBe(5);
    expect(after.analysis.baselineFba.status).toBe('optimal');
    expect(after.analysis.baselineFba.fluxes[after.model.objectiveReaction]).toBeCloseTo(after.analysis.baselineFba.objectiveValue, 8);

    // Explicit synthetic LP input: source=sink, 2<=source<=5, 1<=sink<=10.
    const model = { id: 'bounded-example', name: 'Known five-unit optimum', description: 'Analytic test input', metabolites: ['a'], objectiveReaction: 'sink', reactions: [
      { id: 'source', name: 'Source', subsystem: 'Exchange', stoichiometry: { a: 1 }, lowerBound: 2, upperBound: 5, reversible: false, koIds: [] },
      { id: 'sink', name: 'Sink', subsystem: 'Exchange', stoichiometry: { a: -1 }, lowerBound: 1, upperBound: 10, reversible: false, koIds: [] },
    ] };
    await dialog.getByLabel('Import model JSON').setInputFiles({ name: 'model.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(model)) });
    await expect(dialog.getByText(model.name, { exact: true })).toBeVisible();
    const imported = await exportResult();
    expect(imported.modelSource).toBe('imported');
    expect(imported.model).toEqual(model);
    expect(imported.analysis.baselineFba.objectiveValue).toBeCloseTo(5, 8);
    expect(imported.analysis.baselineFba.fluxes.source).toBeCloseTo(5, 8);
    expect(imported.analysis.baselineFba.fluxes.sink).toBeCloseTo(5, 8);

    model.reactions[0].lowerBound = 6;
    await dialog.getByLabel('Import model JSON').setInputFiles({ name: 'impossible.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(model)) });
    await expect(dialog.getByRole('alert')).toContainText('infeasible');
    const impossible = await exportResult();
    expect(impossible.analysis.baselineFba.objectiveValue).toBeNull();
    expect(impossible.analysis.amgResults).toEqual([]);
    await expect(dialog.getByText('Max Objective Gain', { exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await finalize();
  }
});
