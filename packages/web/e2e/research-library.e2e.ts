/** Full application journeys, separate from the native storage-contract tests.
 * Every saved item must reopen through its existing importer or numerical verifier.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type { ResearchSnapshot } from '../src/db/research-storage';
import { expectExplorerIdentity, setupTestHarness } from './e2e-harness';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../core/src/analysis-result';
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, type PangenomeInput } from '../../core/src/analysis/alignment-pangenome';
import { createPangenomePhylogenyExperiment } from '../../core/src/analysis/aligned-phylogeny';
import { createRootedAncestralExperiment, rootAlignedPhylogenyExperiment } from '../../core/src/analysis/phylogeny-rooting';
import { createRootedDatingExperiment, createRootedTemporalExperiment } from '../../core/src/analysis/phylogeny-temporal';

const GENBANK = `LOCUS       SAVED_CDS                 12 bp    DNA     linear
DEFINITION  Saved private CDS.
ACCESSION   SAVED_CDS
FEATURES             Location/Qualifiers
     CDS             1..12
                     /gene="saved_cds"
                     /codon_start=1
ORIGIN
        1 atgaaaaagtaa
//
`;
const REFERENCE = JSON.stringify({ format: 'phage-explorer-codon-reference', version: 1,
  name: 'Arithmetic test reference', organism: 'Synthetic test corpus', geneticCode: 11,
  source: { citation: 'Hand-counted test fixture, not a biological reference', version: 'test-1' }, counts: { AAA: 8, AAG: 2 } });
async function palette(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('overlay-commandPalette');
  await palette.getByRole('combobox').fill(title);
  await palette.getByRole('option').filter({ hasText: title }).first().click();
}

for (const journey of ['phylogeny', 'temporal', 'strict-clock', 'ancestral'] as const) {
  test(`saved ${journey} preserves its full parent chain through reload, verified reopen and rejected replacement`, async ({ page }, info) => {
    test.setTimeout(180000);
    const { pageErrors, finalize } = setupTestHarness(page, info);
    const marker = 'private-saved-phylogeny-source-e24c';
    const input: PangenomeInput = { format: 'phage-explorer-pangenome', version: 1, name: marker, source: 'demo',
      sequences: ['A', 'B', 'C', 'D'].map((id, i) => ({ id, description: 'Synthetic sequence',
        sequence: 'A'.repeat(i * 5) + 'G'.repeat(i + 1) + 'A'.repeat(99 - i * 6) })) };
    const graph = await createAlignmentPangenomeRecord(input, buildAlignmentPangenome(input, { referenceId: 'A', alignment: 'provided' }));
    const originalParent = '\ufeff' + serializeAnalysisRecord(graph).replace(/\n/g, '\r\n');
    const inferred = await createPangenomePhylogenyExperiment({ name: marker, reference: 'Explicit synthetic aligned columns', experiment: originalParent },
      { distance: 'jc69', bootstrap: 0, seed: 0 });
    const root = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(inferred.record), {
      outgroup: ['A'], fractionFromOutgroup: .25, dateIndependent: true, evidence: 'Synthetic outgroup and root placement without dates',
    });
    const rootText = serializeAnalysisRecord(root.record);
    const diagnostic = await createRootedTemporalExperiment(rootText, { name: marker, kind: 'demo', description: 'Synthetic collection metadata',
      reference: null, license: 'CC0 synthetic fixture', dateIndependent: true,
      sampleTable: 'sampleId,collectionDate,dateSource\nD,2003.0,fixture\nA,2000.0,fixture\nC,2002.0,fixture\nB,2001.0,fixture\n',
    }, { permutations: 24, seed: 0 });
    const record = journey === 'phylogeny' ? root.record : journey === 'temporal' ? diagnostic.record
      : journey === 'strict-clock' ? (await createRootedDatingExperiment(serializeAnalysisRecord(diagnostic.record), {})).datingRecord
      : (await createRootedAncestralExperiment(rootText, 'CC0 synthetic fixture', { endColumn: 6, minPosterior: .7 })).record;
    const content = serializeAnalysisRecord(record);
    let leaked = false;
    page.on('request', request => { if (request.url().includes(marker) || request.postData()?.includes(marker)) leaked = true; });
    const title = journey === 'phylogeny' ? 'phylogeny experiments' : journey === 'temporal' ? 'temporal diagnostic experiments'
      : journey === 'strict-clock' ? 'strict-clock experiments' : 'ancestral experiments';
    const openWorkspace = async () => {
      await page.keyboard.press('Control+Shift+y');
      if (journey === 'phylogeny') {
        await page.getByRole('button', { name: 'Infer an unrooted tree from aligned DNA', exact: true }).click();
        return page.getByRole('region', { name: 'Aligned DNA · unrooted phylogeny', exact: true });
      }
      if (journey === 'ancestral') {
        await page.getByRole('button', { name: 'Open ancestral nucleotide reconstruction', exact: true }).click();
        return page.getByRole('region', { name: 'Ancestral nucleotide reconstruction', exact: true });
      }
      return page.getByRole('region', { name: 'Private dated-tree diagnostics', exact: true });
    };
    const importLabel = journey === 'phylogeny' ? 'Restore verified phylogeny experiment JSON (up to 10 MiB)'
      : journey === 'ancestral' ? 'Import ancestral dataset or saved evidence JSON' : 'Import dated-tree dataset or saved diagnostics JSON';
    const evidence = (panel: Locator) => journey === 'phylogeny' ? panel.getByRole('region', { name: 'Accepted root hypothesis', exact: true })
      : panel.getByTestId(journey === 'ancestral' ? 'ancestral-result' : journey === 'temporal' ? 'temporal-result' : 'strict-clock-result');
    const attribute = journey === 'phylogeny' ? 'data-root-result-id' : 'data-result-id';
    try {
      await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      let panel = await openWorkspace();
      await panel.getByLabel(importLabel, { exact: true }).setInputFiles({ name: 'complete-chain.json', mimeType: 'application/json', buffer: Buffer.from(content) });
      await expect(evidence(panel)).toHaveAttribute(attribute, record.resultId);
      let saved = await library(panel, title); await save(saved, `${journey} complete lineage`);
      expect(await download(page, () => saved.getByRole('button', { name: 'Export saved JSON', exact: true }).click())).toBe(content);
      await page.reload(); await expectExplorerIdentity(page, info); panel = await openWorkspace();
      await expect(evidence(panel)).toHaveCount(0); // Explicit reopening, never automatic private-data restoration.
      saved = await library(panel, title); await openFirst(saved);
      await expect(saved.getByRole('status')).toContainText('recomputed and verified');
      await expect(evidence(panel)).toHaveAttribute(attribute, record.resultId);
      const replay = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON', exact: true }).click());
      expect(replay).toBe(content);
      if (journey === 'phylogeny') {
        expect(await download(page, () => panel.getByRole('button', { name: 'Export original pangenome experiment', exact: true }).click())).toBe(originalParent);
      }
      if (journey === 'strict-clock') await expect(panel.getByTestId('temporal-result')).toHaveAttribute('data-result-id', diagnostic.record.resultId);
      if (journey === 'ancestral') await expect(panel.getByTestId('ancestral-lineage')).toContainText(root.record.resultId);
      const fields = structuredClone(record.fields); fields[Object.keys(fields)[0]].value = { forged: true };
      const forged = await createAnalysisRecord({ ...record, fields });
      await panel.getByLabel(importLabel, { exact: true }).setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(serializeAnalysisRecord(forged)) });
      await expect(panel.getByRole('alert').first()).toContainText(/differs|mismatch/i);
      await expect(evidence(panel)).toHaveAttribute(attribute, record.resultId);
      expect(leaked).toBe(false); expect(pageErrors).toEqual([]);
    } finally { await finalize(); }
  });
}
async function localPanel(page: Page) {
  await palette(page, 'Local genomes: import or export');
  const panel = page.getByTestId('overlay-genomeImport'); await expect(panel).toBeVisible(); return panel;
}
async function importGenome(page: Page) {
  const panel = await localPanel(page);
  await panel.getByLabel('Choose genome file').setInputFiles({ name: 'saved.gb', mimeType: 'text/plain', buffer: Buffer.from(GENBANK) });
  await expect(panel.getByRole('button', { name: 'Parse records', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Parse records', exact: true }).click();
  await expect(panel).toContainText('12 bases, 1 mapped features');
  await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
  await expect(page.getByTestId('phage-list-item-selected')).toContainText('Saved private CDS.');
}
async function library(scope: Locator, title: string) {
  const panel = scope.locator(`details[aria-label="Saved ${title}"]`);
  await panel.locator('summary').click(); return panel;
}
async function save(panel: Locator, name: string) {
  await panel.getByLabel('Snapshot name').fill(name);
  await panel.getByRole('button', { name: 'Save snapshot locally', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Saved an immutable');
  await expect(panel.getByLabel('Saved snapshot').locator('option')).toHaveCount(2);
}
async function openFirst(panel: Locator) {
  await expect(panel.getByLabel('Saved snapshot').locator('option')).toHaveCount(2);
  await panel.getByLabel('Saved snapshot').selectOption({ index: 1 });
  await panel.getByRole('button', { name: 'Open saved snapshot', exact: true }).click();
}
async function download(page: Page, action: () => Promise<void>) {
  const pending = page.waitForEvent('download'); await action();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Missing exported JSON');
  const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
});

for (const journey of ['genomes', 'workflow', 'codon-reference', 'pangenome'] as const) {
  test(`saved ${journey} reopens after reload without bypassing review or verification`, async ({ page }, info) => {
    const { pageErrors, finalize } = setupTestHarness(page, info);
    // Do not retain private bodies in test logs. The boolean is sufficient to assert no upload.
    let leaked = false;
    page.on('request', request => {
      const text = `${request.url()} ${request.postData() ?? ''}`;
      if (text.includes('SAVED_CDS') || text.includes('atgaaaaagtaa') || text.includes('Arithmetic test reference')) leaked = true;
    });
    try {
      await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
      const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
      if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
      if (journey !== 'pangenome') await importGenome(page);
      if (journey === 'genomes') {
        let panel = await localPanel(page), saved = await library(panel, 'local genome workspaces');
        await save(saved, 'Private input and view');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        expect(JSON.parse(original).inputs).toEqual([{ name: 'saved.gb', text: GENBANK }]);
        await page.reload(); await expectExplorerIdentity(page, info);
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        panel = await localPanel(page); saved = await library(panel, 'local genome workspaces');
        await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('Review and explicitly add');
        // Loading a saved workspace may not silently add or select private data.
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        await panel.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
        await expect(page.getByTestId('phage-list-item-selected')).toContainText('Saved private CDS.');
        panel = await localPanel(page);
        const reopened = await download(page, () => panel.getByRole('button', { name: 'Export local genome bundle', exact: true }).click());
        expect(JSON.parse(reopened)).toEqual(JSON.parse(original));
      } else if (journey === 'workflow') {
        let panel = await localPanel(page), workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
        await workflow.getByRole('button', { name: 'Start workflow recording', exact: true }).click();
        await workflow.getByRole('button', { name: 'Apply and record view', exact: true }).click();
        await expect(workflow.getByTestId('workflow-status')).toContainText('1 recorded commands');
        await workflow.getByRole('button', { name: 'Stop workflow recording', exact: true }).click();
        let saved = await library(workflow, 'command workflows'); await save(saved, 'Stopped workflow');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        await page.reload(); await expectExplorerIdentity(page, info);
        panel = await localPanel(page); workflow = panel.getByRole('region', { name: 'Saved research workflows', exact: true });
        saved = await library(workflow, 'command workflows'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('No recorded commands were run');
        await expect(workflow.getByTestId('workflow-status')).toContainText('idle · 1 recorded commands · 0/');
        await expect(workflow.getByTestId('workflow-result')).toHaveCount(0);
        expect(await page.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
        expect(await download(page, () => workflow.getByRole('button', { name: 'Export research workflow', exact: true }).click())).toBe(original);
      } else if (journey === 'codon-reference') {
        let panel = await localPanel(page), reference = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
        await reference.getByLabel('Paste codon reference JSON').fill(REFERENCE);
        await reference.getByRole('button', { name: 'Analyze against reference', exact: true }).click();
        // AAA/AAG have weights 1 and 1/4: the geometric mean is 1/2.
        await expect(reference).toContainText('Pooled CAI: 0.500000');
        let saved = await library(reference, 'reference experiments'); await save(saved, 'Known arithmetic experiment');
        const original = await download(page, () => saved.getByRole('button', { name: 'Export saved JSON' }).click());
        await page.reload(); await expectExplorerIdentity(page, info);
        panel = await localPanel(page); reference = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
        saved = await library(reference, 'reference experiments'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('recomputed and verified');
        await expect(reference).toContainText('Pooled CAI: 0.500000');
        expect(await download(page, () => reference.getByRole('button', { name: 'Export reference experiment', exact: true }).click())).toBe(original);
      } else {
        // Use the registered shortcut, not a second test-only route into the analysis code.
        await palette(page, 'Pangenome');
        let panel = page.getByTestId('overlay-pangenomeGraph'); await expect(panel).toBeVisible();
        await panel.getByText('Paste sequences or inspect supported input', { exact: true }).click();
        await panel.getByLabel('Paste pangenome FASTA').fill('>ref\nACGTACGT\n>query\nATGTACGT');
        await panel.getByRole('button', { name: 'Load pasted sequences', exact: true }).click();
        await panel.getByLabel('Pangenome reference sequence').selectOption('ref');
        await panel.getByRole('button', { name: 'Build sequence graph', exact: true }).click();
        await expect(panel.getByTestId('pangenome-summary')).toContainText('1 reference-relative variants');
        const originalId = await panel.getByTestId('pangenome-result').getAttribute('data-result-id');
        let saved = await library(panel, 'pangenome experiments'); await save(saved, 'Single SNV graph');
        await page.reload(); await expectExplorerIdentity(page, info); await palette(page, 'Pangenome');
        panel = page.getByTestId('overlay-pangenomeGraph');
        await expect(panel.getByTestId('pangenome-result')).toHaveCount(0);
        saved = await library(panel, 'pangenome experiments'); await openFirst(saved);
        await expect(saved.getByRole('status')).toContainText('recomputed and verified');
        await expect(panel.getByTestId('pangenome-result')).toHaveAttribute('data-result-id', originalId!);
        await expect(panel.getByTestId('pangenome-variant')).toContainText('[1, 2)');
      }
      expect(leaked).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally { await finalize(); }
  });
}


/** The manifest deliberately binds saved metadata; per-snapshot hashes retain the
 * exact original export text. A fresh valid manifest cannot bypass ID conflicts.
 */
function collectionFile(snapshots: ResearchSnapshot[]): string {
  const manifest = { format: 'phage-explorer-research-collection', version: 1,
    snapshots: snapshots.map(({ id, version, kind, name, createdAt, bytes, sha256 }) =>
      ({ id, version, kind, name, createdAt, bytes, sha256 })) };
  return JSON.stringify({ ...manifest, snapshots,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') });
}
async function collectionPanel(saved: Locator) {
  const collection = saved.getByRole('region', { name: 'Portable saved research collection', exact: true });
  const toggle = collection.getByRole('button', { name: 'Back up or transfer all saved research', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return collection;
}
async function reviewCollection(collection: Locator, content: string) {
  await collection.getByLabel('Choose research collection JSON').setInputFiles({
    name: 'private-research-collection.json', mimeType: 'application/json', buffer: Buffer.from(content),
  });
  await collection.getByRole('button', { name: 'Review collection file', exact: true }).click();
}
test('portable research collection transfers private sources and verified results into a clean browser profile through reload', async ({ page, browser }, info) => {
  test.setTimeout(180000);
  const { pageErrors, finalize } = setupTestHarness(page, info);
  let leaked = false;
  const inspectRequest = (request: { url(): string; postData(): string | null }) => {
    const text = request.url() + ' ' + (request.postData() ?? '');
    if (text.includes('SAVED_CDS') || text.includes('atgaaaaagtaa') || text.includes('Arithmetic test reference')) leaked = true;
  };
  page.on('request', inspectRequest);
  const receiverContext = await browser.newContext();
  receiverContext.on('request', inspectRequest);
  const receiverErrors: string[] = [];
  try {
    await page.goto('/?phage=lambda&model=0'); await expectExplorerIdentity(page, info);
    const welcome = page.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await welcome.isVisible()) await welcome.getByRole('button', { name: 'Skip', exact: true }).click();
    await importGenome(page);
    const panel = await localPanel(page), genomeSaved = await library(panel, 'local genome workspaces');
    await save(genomeSaved, 'Original private genome workspace');
    const reference = panel.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
    await reference.getByLabel('Paste codon reference JSON').fill(REFERENCE);
    await reference.getByRole('button', { name: 'Analyze against reference', exact: true }).click();
    await expect(reference).toContainText('Pooled CAI: 0.500000');
    const referenceSaved = await library(reference, 'reference experiments');
    await save(referenceSaved, 'Original codon experiment');
    const collection = await collectionPanel(genomeSaved);
    const exported = await download(page, () => collection.getByRole('button', { name: 'Export all saved research', exact: true }).click());
    const original = JSON.parse(exported) as { snapshots: ResearchSnapshot[] };
    expect(original.snapshots.map(row => row.kind).sort()).toEqual(['codon-reference', 'genomes']);
    const source = original.snapshots.find(row => row.kind === 'genomes')!;
    const experiment = original.snapshots.find(row => row.kind === 'codon-reference')!;
    expect(JSON.parse(source.content).inputs).toEqual([{ name: 'saved.gb', text: GENBANK }]);
    const receiverUrl = new URL('/?phage=lambda&model=0', page.url()).href;
    // The transfer no longer needs the source renderer or its database workers.
    await page.close();

    await receiverContext.addInitScript(() => {
      // Context initializers also run in the initial opaque about:blank document.
      if (!['http:', 'https:'].includes(location.protocol)) return;
      localStorage.setItem('phage-explorer-main-prefs', JSON.stringify({ experienceLevel: 'power' }));
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    });
    const receiver = await receiverContext.newPage();
    receiver.on('pageerror', error => receiverErrors.push(error.message));
    await receiver.goto(receiverUrl);
    // A separate profile starts with an empty database cache; wait for real catalog readiness.
    await expect(receiver.getByRole('heading', { level: 1 }), 'Fresh profile finishes catalog startup')
      .toContainText('Enterobacteria phage lambda', { timeout: 60000 });
    await expectExplorerIdentity(receiver, info);
    const greeting = receiver.getByRole('dialog', { name: 'Welcome to Phage Explorer' });
    if (await greeting.isVisible()) await greeting.getByRole('button', { name: 'Skip', exact: true }).click();
    let target = await localPanel(receiver), saved = await library(target, 'local genome workspaces');
    let incoming = await collectionPanel(saved);
    await expect(saved.getByLabel('Saved snapshot').locator('option')).toHaveCount(1);
    await reviewCollection(incoming, exported);
    const review = incoming.getByRole('region', { name: 'Research collection import review', exact: true });
    await expect(review).toContainText('2 new');
    await expect(review).toContainText('Original private genome workspace');
    await expect(review).toContainText('Original codon experiment');
    await expect(review).toContainText('do not authenticate source claims or recompute scientific results');
    await expect(saved.getByLabel('Saved snapshot').locator('option')).toHaveCount(1);
    await review.getByRole('button', { name: 'Import reviewed collection', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Imported 2 snapshots');
    expect(await receiver.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');

    await receiver.reload(); await expectExplorerIdentity(receiver, info);
    target = await localPanel(receiver); saved = await library(target, 'local genome workspaces');
    await openFirst(saved);
    await expect(saved.getByRole('status')).toContainText('Review and explicitly add');
    expect(await receiver.getByTestId('phage-list-item-selected').textContent()).not.toContain('Saved private CDS.');
    expect(await download(receiver, () => saved.getByRole('button', { name: 'Export saved JSON', exact: true }).click())).toBe(source.content);
    await target.getByRole('button', { name: 'Add records to explorer', exact: true }).click();
    await expect(receiver.getByTestId('phage-list-item-selected')).toContainText('Saved private CDS.');
    target = await localPanel(receiver);
    const restoredReference = target.getByRole('region', { name: 'Reference-backed codon adaptation', exact: true });
    const restoredSaved = await library(restoredReference, 'reference experiments');
    await openFirst(restoredSaved);
    await expect(restoredSaved.getByRole('status')).toContainText('recomputed and verified');
    await expect(restoredReference).toContainText('Pooled CAI: 0.500000');
    expect(await download(receiver, () => restoredReference.getByRole('button', { name: 'Export reference experiment', exact: true }).click())).toBe(experiment.content);

    saved = await library(target, 'local genome workspaces'); incoming = await collectionPanel(saved);
    await reviewCollection(incoming, exported);
    await expect(incoming.getByRole('region', { name: 'Research collection import review', exact: true })).toContainText('0 new');
    await expect(incoming).toContainText('2 exact duplicates already saved');
    await incoming.getByRole('button', { name: 'Import reviewed collection', exact: true }).click();
    await expect(saved.getByRole('status')).toContainText('Imported 0 snapshots');
    const readBack = () => download(receiver, () => incoming.getByRole('button', { name: 'Export all saved research', exact: true }).click());
    expect(await readBack()).toBe(exported);

    const tampered = JSON.parse(exported); tampered.snapshots[0].name = 'Unverified changed label';
    await reviewCollection(incoming, JSON.stringify(tampered));
    await expect(saved.getByRole('alert')).toContainText('manifest checksum mismatch');
    await expect(incoming.getByRole('region', { name: 'Research collection import review', exact: true })).toHaveCount(0);
    expect(await readBack()).toBe(exported);
    const conflicting = structuredClone(original.snapshots);
    conflicting.push({ ...conflicting[0], id: randomUUID(), name: 'Must not be partially imported' });
    conflicting[0].name = 'A valid checksum cannot replace an immutable saved ID';
    await reviewCollection(incoming, collectionFile(conflicting));
    await expect(saved.getByRole('alert')).toContainText('identifier conflicts');
    expect(await readBack()).toBe(exported);
    expect(leaked).toBe(false); expect(pageErrors).toEqual([]); expect(receiverErrors).toEqual([]);
  } finally { await receiverContext.close(); await finalize(); }
});
