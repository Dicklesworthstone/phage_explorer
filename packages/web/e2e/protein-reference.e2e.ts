import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

// Keep the actual database and reference response. Only delay delivery to exercise cancellation.
test.use({ serviceWorkers: 'block' });

async function openReferences(page: Page) {
  await page.getByRole('button', { name: /command palette/i }).first().click();
  const palette = page.getByTestId('overlay-commandPalette');
  await expect(palette).toBeVisible();
  await page.getByTestId('command-palette-input').fill('host interactions');
  await palette.getByRole('option', { name: /host interactions/i }).first().click();
  const overlay = page.getByTestId('overlay-hostInteractions');
  await expect(overlay).toBeVisible();
  return overlay;
}

async function selectPhage(page: Page, name: 'T4' | 'lambda') {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('overlay-hostInteractions')).toBeHidden();
  const picker = page.locator('button.phage-picker-trigger');
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByTestId('phage-picker-sheet').getByRole('button', {
      name: new RegExp(`Open Enterobacteria phage ${name}(?:,|$)`),
    }).click();
  } else {
    await page.locator('[data-testid="phage-list-item"]', { hasText: `Enterobacteria phage ${name}` }).first().click();
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Enterobacteria phage ${name}`);
}

test('actual catalog reference coverage survives delayed loading, exports real inputs, and clears on unsupported selection', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { reached = resolve; });
  await page.route(/lambda-lamb-v1(?:[^/]*\.js|\.json)(?:\?.*)?$/, async route => {
    reached();
    await held;
    await route.continue();
  });

  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, testInfo);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();

    let overlay = await openReferences(page);
    await expect(overlay.getByRole('status')).toContainText('Loading source-backed protein references');
    await requested;
    await selectPhage(page, 'T4');
    overlay = await openReferences(page);
    release();
    await expect(overlay.getByRole('status')).toContainText('No versioned protein reference');
    await expect(overlay.getByRole('heading', { name: 'Source-backed protein inputs available' })).toHaveCount(0);

    await selectPhage(page, 'lambda');
    overlay = await openReferences(page);
    const coverage = overlay.getByRole('region', { name: 'Source-backed protein reference inputs' });
    await expect(coverage).toBeVisible();
    await expect(coverage).toContainText('P03749: complete deposited CDS (1132 residues)');
    await expect(coverage).toContainText('420 observed residues');
    await expect(coverage).toContainText('422 observed residues');
    await expect(coverage).toContainText('713–1132');
    await expect(coverage).toContainText('Q3YUU9, Shigella sonnei (strain Ss046)');
    await expect(coverage).toContainText('Experimental receptor: Shigella sonnei 3070');
    await expect(coverage).toContainText('EL4, EL6, EL9');
    await expect(coverage).not.toContainText(/kcal\/mol|\bKd\b/);

    const downloaded = page.waitForEvent('download');
    await coverage.getByRole('button', { name: 'Export reference inputs', exact: true }).click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    const path = testInfo.outputPath('actual-reference-inputs.json');
    await download.saveAs(path);
    const exported = JSON.parse(await readFile(path, 'utf8'));
    const source = JSON.parse(await readFile(new URL('../../../data/protein-references/lambda-lamb-v1.json', import.meta.url), 'utf8'));
    expect(exported.genomeAccession).toBe('NC_001416.1');
    expect(exported.geneId).toBe(42);
    expect(exported.reference).toEqual(source);
    await testInfo.attach('actual-reference-inputs', { path, contentType: 'application/json' });

    await selectPhage(page, 'T4');
    overlay = await openReferences(page);
    await expect(overlay.getByRole('status')).toContainText('No versioned protein reference');
    await expect(overlay.getByRole('region', { name: 'Source-backed protein reference inputs' })).toHaveCount(0);
    await expect(overlay.getByRole('button', { name: 'Export reference inputs', exact: true })).toHaveCount(0);
    await finalize();
  } finally {
    release();
  }
});
