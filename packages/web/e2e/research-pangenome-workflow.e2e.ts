/** Real app path: imported originals -> recorded annotated command -> saved tape -> verified replay. */
import { test, expect, type Page } from '@playwright/test';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';

const REF = `LOCUS       WORKFLOW_REF 9 bp DNA linear
DEFINITION  Workflow reference.
ACCESSION   WORKFLOW_REF
FEATURES             Location/Qualifiers
     CDS             1..9
                     /gene="known_cds"
ORIGIN
        1 ATGAAATAA
//
`;
const QUERY = '>WORKFLOW_QUERY\nATGAAGTAA\n';
const BUNDLE = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1,
  inputs: [{ name: 'reference.gb', text: REF }, { name: 'query.fa', text: QUERY }] });
async function localPanel(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill('Local genomes: import or export');
  await palette.getByRole('option').filter({ hasText: 'Local genomes: import or export' }).first().click();
  const panel = page.getByTestId('overlay-genomeImport'); await expect(panel).toBeVisible(); return panel;
}
async function download(page: Page, action: () => Promise<void>): Promise<string> {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('No exported experiment stream.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('records and replays a saved affine/CDS workflow after reload without automatic execution', async ({ page }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let leaked = false;
  page.on('request', request => {
    const body = `${request.url()} ${request.postData() ?? ''}`;
    if (body.includes('WORKFLOW_REF') || body.includes('ATGAAATAA') || body.includes('ATGAAGTAA')) leaked = true;
  });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    let panel = await localPanel(page);
    await panel.getByLabel('Choose genome file').setInputFiles({ name: 'inputs.json', mimeType: 'application/json', buffer: Buffer.from(BUNDLE) });
    await expect(panel.getByRole('button', { name: 'Parse records', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
    await expect(panel).toContainText('2 local records ready');
    await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(panel).not.toBeVisible();
    panel = await localPanel(page);
    let workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
    await workflow.getByRole('checkbox', { name: /^Workflow graph genome Workflow reference\./ }).check();
    await workflow.getByRole('checkbox', { name: /^Workflow graph genome WORKFLOW_QUERY / }).check();
    const referenceId = await workflow.locator('#workflow-graph-reference option').filter({ hasText: 'Workflow reference.' }).getAttribute('value');
    expect(referenceId).toMatch(/^[a-f0-9]{64}$/);
    await workflow.locator('#workflow-graph-reference').selectOption(referenceId!);
    await workflow.locator('#workflow-graph-alignment').selectOption('affine');
    await workflow.locator('#workflow-graph-mismatch').fill('9');
    await workflow.locator('#workflow-graph-annotate').check();
    await workflow.locator('#workflow-graph-genes').fill('1');
    await workflow.getByRole('button', { name: 'Run and record pangenome', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('recording · 1 recorded commands');
    const initial = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(initial.parameters.graph.affinePenalties).toEqual({ mismatch: 9, gapOpen: 6, gapExtend: 1 });
    expect(initial.fields.variants.value).toEqual([expect.objectContaining({ referenceStart: 5, referenceEnd: 6, reference: 'A', alternate: 'G' })]);
    expect(initial.fields.codingConsequences.value[0]).toMatchObject({ effects: ['synonymous'], queryCds: 'ATGAAGTAA', queryProtein: 'MK*' });
    await workflow.locator('#workflow-graph-mismatch').fill('0');
    await expect(workflow.getByRole('button', { name: 'Run and record pangenome', exact: true })).toBeDisabled();
    await expect(workflow.getByTestId('workflow-result')).toHaveAttribute('data-result-id', initial.resultId);
    await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
    let saved = workflow.locator('details[aria-label="Saved command workflows"]');
    await saved.locator('summary').click(); await saved.getByLabel('Snapshot name').fill('Recorded affine coding experiment');
    await saved.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Saved an immutable');
    const tape = await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click());
    expect(JSON.parse(tape).commands[0].parameters.options.affinePenalties.mismatch).toBe(9);
    await page.reload(); await expectExplorerIdentity(page, info);
    panel = await localPanel(page); workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
    saved = workflow.locator('details[aria-label="Saved command workflows"]'); await saved.locator('summary').click();
    await expect(saved.getByLabel('Saved snapshot').locator('option')).toHaveCount(2);
    await saved.getByLabel('Saved snapshot').selectOption({ index: 1 });
    await saved.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('No recorded commands were run');
    await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
    await expect(workflow.getByTestId('workflow-status')).toContainText('idle · 1 recorded commands · 0/');
    await workflow.getByRole('button', { name: 'Add workflow genomes', exact: true }).click();
    await expect(workflow.getByRole('button', { name: 'Add workflow genomes', exact: true })).toHaveCount(0);
    // Adding originals may trigger the explorer's async selection. Wait before playback.
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('Workflow reference.');
    await workflow.getByRole('button', { name: 'Replay research workflow', exact: true }).click();
    await expect(workflow.getByTestId('workflow-status')).toContainText('Verified 1 commands');
    const replayed = JSON.parse(await download(page, () => workflow.getByRole('button', { name: 'Export workflow analysis', exact: true }).click()));
    expect(replayed).toEqual(initial);
    expect(await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click())).toBe(tape);
    expect(leaked).toBe(false); expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});
