import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setupTestHarness } from './e2e-harness';

test.use({ userAgent: 'OpenAI File Downloader, XaiImageApiFetch/1.0' });

async function catalog(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
  });
  await page.goto('/?phage=lambda&model=0');
  expect(new URL(page.url()).origin).toBe(new URL(baseURL).origin);
  const manifest = JSON.parse(await readFile(new URL('../public/phage.db.manifest.json', import.meta.url), 'utf8'));
  expect(await (await page.request.get('/phage.db.manifest.json')).json()).toMatchObject({ contentVersion: manifest.contentVersion, sha256: manifest.sha256 });
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Enterobacteria phage lambda');
  await expect(page.locator('[data-testid^="phage-list-item"]')).toHaveCount(24);
  const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
  if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
}

async function exportSequence(page: Page, overlay: Locator) {
  const downloading = page.waitForEvent('download');
  await overlay.getByRole('button', { name: 'Export sequence analysis' }).click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('real deposited protein survives precomputed tropism, demo opt-in, export and cached reload', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('0');
    const overlay = page.getByTestId('overlay-tropism');
    await overlay.getByRole('button', { name: /Sequence descriptors/ }).click();
    await expect(overlay.getByRole('region', { name: 'Real protein sequence descriptors' })).toContainText('MTNALAGKQPKNATLTALAGLSTAKNKLPYFA');
    const real = await exportSequence(page, overlay);
    expect(real.phageId).toBe(1);
    expect(real.source).toBe('precomputed');
    expect(real.sequenceSource).toBe('deposited_translation');
    expect(real.sequenceAnalysis.geneId).toBe(54);
    expect(real.sequenceAnalysis.sequence).toHaveLength(314);
    // Independently extracted from the shipped GenBank translation NP_040604.1.
    expect(createHash('sha256').update(real.sequenceAnalysis.sequence).digest('hex')).toBe('49762dfae5f67b7dc8d063930fb6632559d0e61eb829598dfa258dfb4a274479');
    expect(real.structuralAnalysis).toBeNull();
    expect(JSON.stringify(real)).not.toMatch(/ddgAlaScan|affinityScore|chimeraSuggestions/);
    await expect(overlay.getByRole('columnheader', { name: 'Affinity Score', exact: true })).toHaveCount(0);
    await info.attach('real-protein-export', { body: JSON.stringify(real), contentType: 'application/json' });
    await info.attach('real-protein-panel', { body: await overlay.screenshot(), contentType: 'image/png' });

    await overlay.getByRole('checkbox', { name: 'Show illustrative structural model' }).check();
    await expect(overlay.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('synthetic model outputs');
    const demo = await exportSequence(page, overlay);
    expect(demo.mode).toBe('demonstration');
    expect(demo.structuralAnalysis.source).toBe('demonstration');
    expect(demo.structuralAnalysis.assumptions).toContain('not predictions');
    expect(demo.sequenceAnalysis.sequence).toBe(real.sequenceAnalysis.sequence);
    await info.attach('explicit-demonstration-export', { body: JSON.stringify(demo), contentType: 'application/json' });
    await overlay.getByRole('checkbox', { name: 'Show illustrative structural model' }).uncheck();
    expect((await exportSequence(page, overlay)).structuralAnalysis).toBeNull();
    await page.reload();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('lambda');
    await page.keyboard.press('0');
    await expect(overlay.getByRole('checkbox', { name: 'Show illustrative structural model' })).not.toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('0');
    await expect(overlay.getByRole('checkbox', { name: 'Show illustrative structural model' })).not.toBeChecked();
    await overlay.getByRole('button', { name: /Sequence descriptors/ }).click();
    await expect(overlay.getByRole('button', { name: 'Export sequence analysis' })).toBeVisible();
    const switched = await exportSequence(page, overlay);
    expect(switched.phageName).toContain('T7');
    expect(switched.phageId).not.toBe(real.phageId);
    expect(switched.structuralAnalysis).toBeNull();
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('pangenome and host panels require opt-in and reset it on a phage change', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('Shift+p');
    const graph = page.getByTestId('overlay-pangenomeGraph');
    await expect(graph).toContainText('Comparative sequence evidence has not been supplied');
    await expect(graph.getByText("Heaps' Law Openness (α)", { exact: true })).toHaveCount(0);
    await graph.getByRole('button', { name: 'Show illustrative pangenome' }).click();
    await expect(graph.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('invented companion variations');
    await expect(graph).toContainText('DEMONSTRATION');
    await graph.getByRole('button', { name: 'Return to available data' }).click();
    await expect(graph.getByText("Heaps' Law Openness (α)", { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Alt+i');
    const host = page.getByTestId('overlay-hostInteractions');
    await expect(host).toContainText('cannot establish these quantities');
    await host.getByRole('button', { name: 'Show illustrative interaction model' }).click();
    await expect(host.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('deterministic pseudo-vectors');
    await expect(host).toContainText('DEMONSTRATION');
    await page.keyboard.press('Escape');
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('Alt+i');
    await expect(host.getByRole('button', { name: 'Show illustrative interaction model' })).toBeVisible();
    await expect(host.getByRole('note', { name: 'Demonstration assumptions' })).toHaveCount(0);
    await info.attach('ordinary-host-panel-after-switch', { body: await host.screenshot(), contentType: 'image/png' });
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('growth-curve illustration is explicit and never labels invented bands as uncertainty', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    await page.keyboard.press('Shift+s');
    await page.getByTestId('overlay-simulationHub').getByText('Burst Kinetics Simulator', { exact: true }).click();
    const simulation = page.getByTestId('overlay-simulationView');
    await expect(simulation.getByRole('img', { name: 'Infection kinetics chart', exact: true })).toBeVisible();
    await expect(simulation.getByRole('note', { name: 'Demonstration assumptions' })).toHaveCount(0);
    await simulation.getByRole('button', { name: 'Show illustrative growth-curve fitting' }).click();
    await expect(simulation.getByRole('note', { name: 'Demonstration assumptions' })).toContainText('Hand-entered example growth curves');
    await expect(simulation.getByRole('img', { name: 'Demonstration growth curve and sigmoid fit' })).toBeVisible();
    await expect(simulation).toContainText('Not identifiable from these observations');
    await expect(simulation).not.toContainText('95% CI');
    await expect(simulation).not.toContainText('Fitted DDE');
    await info.attach('explicit-growth-curve-illustration', { body: await simulation.screenshot(), contentType: 'image/png' });
    await simulation.getByRole('button', { name: 'Forward Infection Dynamics (SIR)' }).click();
    await expect(simulation.getByRole('img', { name: 'Infection kinetics chart', exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('failed dated-sequence retrieval does not silently become a synthetic phage result', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  try {
    await catalog(page, baseURL!);
    let abortedRequests = 0;
    await page.route(url => url.hostname === 'ncbi.nlm.nih.gov' || url.hostname.endsWith('.ncbi.nlm.nih.gov'), route => {
      abortedRequests += 1;
      return route.abort();
    });
    await page.keyboard.press('Control+Shift+y');
    const overlay = page.getByTestId('overlay-phylodynamics');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    expect(abortedRequests).toBeGreaterThan(0);
    await info.attach('failed-real-retrieval', { body: await overlay.screenshot(), contentType: 'image/png' });
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    await overlay.getByRole('button', { name: 'Show synthetic phylodynamics illustration' }).click();
    await expect(overlay).toContainText('15 synthetic 300-base sequences');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toBeVisible();
    await expect(overlay).toContainText('Equal-length raw genomes are insufficient');
    await overlay.getByRole('button', { name: 'Search real dated sequences' }).click();
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally { await finalize(); }
});

test('closing a pending real search prevents its late failure from replacing a new phage illustration', async ({ page, baseURL }, info) => {
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let releaseFirst: (() => void) | undefined;
  const released = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstRequestSeen = false;
  let firstRequestFinished = false;
  let firstRequestUrl = '';
  try {
    await catalog(page, baseURL!);
    await page.route(url => url.hostname === 'ncbi.nlm.nih.gov' || url.hostname.endsWith('.ncbi.nlm.nih.gov'), async route => {
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        firstRequestUrl = route.request().url();
        await released;
        await route.abort();
        firstRequestFinished = true;
      } else {
        await route.abort();
      }
    });
    await page.keyboard.press('Control+Shift+y');
    const overlay = page.getByTestId('overlay-phylodynamics');
    await expect.poll(() => firstRequestSeen).toBe(true);
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await page.getByTestId('phage-list-item').filter({ hasText: /Enterobacteria phage T7/ }).click();
    await expect(page.getByTestId('phage-list-item-selected')).toContainText('T7');
    await page.keyboard.press('Control+Shift+y');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await overlay.getByRole('button', { name: 'Show synthetic phylodynamics illustration' }).click();
    await expect(overlay).toContainText('These are not samples of Enterobacteria phage T7');
    const lateFailure = page.waitForEvent('requestfailed', request => request.url() === firstRequestUrl);
    releaseFirst?.();
    await lateFailure;
    await expect.poll(() => firstRequestFinished).toBe(true);
    // Exercise the current result after the old request actually failed.
    await overlay.getByRole('button', { name: /Clock/ }).click();
    await overlay.getByRole('button', { name: /Tree/ }).click();
    await expect(overlay).toContainText('15 synthetic 300-base sequences');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toBeVisible();
    await expect(overlay).not.toContainText('DATA UNAVAILABLE');
    await info.attach('new-phage-after-cancelled-response', { body: await overlay.screenshot(), contentType: 'image/png' });
    // Overlay closure unmounts its state: reopening must require fresh opt-in.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+y');
    await expect(overlay).toContainText('DATA UNAVAILABLE');
    await expect(overlay.getByRole('img', { name: /UPGMA phylogenetic tree/ })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseFirst?.();
    await finalize();
  }
});
