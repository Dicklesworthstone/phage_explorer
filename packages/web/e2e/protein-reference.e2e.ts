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
    expect(exported.format).toBe('phage-explorer-protein-reference');
    expect(exported.cds.genomeAccession).toBe('NC_001416.1');
    expect(exported).toEqual(source);
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

test('actual mapped CDS computes residue evidence, exports every row and replays independently of the current phage', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  await page.goto('/?phage=lambda&model=0');
  await expectExplorerIdentity(page, testInfo);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
  let overlay = await openReferences(page);
  let workbench = overlay.getByRole('region', { name: 'Protein evidence workbench', exact: true });
  await expect(workbench).toContainText('P03749, CDS 42');
  await expect(workbench.getByRole('button', { name: 'Analyze mapped protein CDS', exact: true })).toBeDisabled();
  await workbench.getByRole('button', { name: 'Select mapped protein CDS', exact: true }).click();
  await workbench.getByRole('button', { name: 'Analyze mapped protein CDS', exact: true }).click();
  let result = workbench.getByRole('region', { name: 'Protein evidence results', exact: true });
  await expect(result).toBeVisible();
  await expect(result).toContainText('Verified against the loaded genome NC_001416.1, CDS 42');
  await expect(result).toContainText('1096 / 1132');
  await expect(result).toContainText('420 / 1132');
  await expect(result).toContainText('958');
  await result.getByLabel('First protein residue', { exact: true }).fill('713');
  await expect(result).toContainText('Showing protein positions 713–737');

  const save = async (name: string, output: string) => {
    const pending = page.waitForEvent('download');
    await result.getByRole('button', { name, exact: true }).click();
    const downloaded = await pending;
    expect(await downloaded.failure()).toBeNull();
    const path = testInfo.outputPath(output); await downloaded.saveAs(path); return path;
  };
  const experimentPath = await save('Export protein experiment JSON', 'actual-protein-experiment.json');
  const record = JSON.parse(await readFile(experimentPath, 'utf8'));
  expect(record.method.id).toBe('mapped-protein-reference-evidence');
  expect(record.parameters.chainLabelAsymId).toBe('D');
  expect(record.fields.structure.value.residues).toHaveLength(1132);
  const residuesPath = await save('Export residue TSV', 'actual-residue-evidence.tsv');
  const rows = (await readFile(residuesPath, 'utf8')).trim().split('\n').filter(line => !line.startsWith('#'));
  expect(rows).toHaveLength(1133);
  const header = rows[0].split('\t');
  expect(rows[34].split('\t')[header.indexOf('entropy_bits')]).toBe('');
  expect(rows[713].split('\t')[header.indexOf('label_seq_id')]).toBe('1');
  const contactsPath = await save('Export contact TSV', 'actual-contact-evidence.tsv');
  const contacts = (await readFile(contactsPath, 'utf8')).trim().split('\n').filter(line => !line.startsWith('#'));
  expect(contacts).toHaveLength(959);
  for (const path of [experimentPath, residuesPath, contactsPath]) await testInfo.attach('protein-evidence-export', { path });

  await selectPhage(page, 'T4'); overlay = await openReferences(page);
  workbench = overlay.getByRole('region', { name: 'Protein evidence workbench', exact: true });
  await expect(workbench.getByRole('region', { name: 'Protein evidence results', exact: true })).toHaveCount(0);
  await workbench.getByLabel('Replay protein experiment JSON', { exact: true }).setInputFiles(experimentPath);
  result = workbench.getByRole('region', { name: 'Protein evidence results', exact: true });
  await expect(result).toContainText('Fresh replay verified');
  await expect(result).toContainText('P03749: reference-derived residue evidence');
  await expect(result).toContainText('no current genome or selected CDS was verified');
  await expect(result).not.toContainText('Verified against the loaded genome');
  const replayPath = await save('Export protein experiment JSON', 'replayed-protein-experiment.json');
  expect(JSON.parse(await readFile(replayPath, 'utf8'))).toEqual(record);

  await workbench.getByLabel('Mapped protein chain', { exact: true }).selectOption('none');
  await expect(result).toHaveCount(0);
  await workbench.getByRole('button', { name: 'Analyze loaded protein reference', exact: true }).click();
  await expect(result).toContainText('No chain selected: geometry is unavailable');
  await expect(result).toContainText('1096 / 1132');
  await expect(result).toContainText('0 / 1132');
  await finalize();
});

test('closing and changing phage while the real protein worker is loading cannot accept stale evidence', async ({ page }, testInfo) => {
  const { finalize } = setupTestHarness(page, testInfo);
  await page.addInitScript(() => localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' })));
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { reached = resolve; });
  await page.route(/protein-evidence\.worker[^/]*\.(?:js|ts)(?:\?.*)?$/, async route => {
    reached(); await held; await route.continue();
  });
  try {
    await page.goto('/?phage=lambda&model=0');
    await expectExplorerIdentity(page, testInfo);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let overlay = await openReferences(page);
    const workbench = overlay.getByRole('region', { name: 'Protein evidence workbench', exact: true });
    await workbench.getByRole('button', { name: 'Select mapped protein CDS', exact: true }).click();
    await workbench.getByRole('button', { name: 'Analyze mapped protein CDS', exact: true }).click();
    await requested;
    await expect(workbench.getByRole('button', { name: 'Cancel protein analysis', exact: true })).toBeVisible();
    await selectPhage(page, 'T4'); overlay = await openReferences(page); release();
    await expect(overlay.getByRole('status')).toContainText('No versioned protein reference');
    await expect(overlay.getByRole('region', { name: 'Protein evidence results', exact: true })).toHaveCount(0);
    await expect(overlay.getByRole('button', { name: 'Analyze mapped protein CDS', exact: true })).toBeDisabled();
    await finalize();
  } finally { release(); }
});
