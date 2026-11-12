import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ResearchWorkflow, researchDigestParameters, researchSpacerParameters, readWorkflowResultsFile, type ResearchEnvironment, type ResearchView } from './ResearchWorkflow';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../../core/src/command-session';
import { WORKFLOW_RESULTS_LIMITS, WorkflowResultCollector, parseWorkflowResults, serializeWorkflowResults, workflowAnalysisAt, workflowResultIndex } from '../../../core/src/workflow-results';
import { createDotPlotExperiment, createPairwiseDotPlotExperiment } from '../../../core/src/analysis/dot-plot';
import { createRestrictionDigestRecord } from '../../../core/src/analysis/restriction-digest';
import type { ReferenceSpacerHit, SpacerLibrary } from '../../../core/src/analysis/spacer-reference';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { fileURLToPath } from 'node:url';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation', dotPlot: 'overlay.dotPlot', digest: 'overlay.gel' };
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

describe('captured catalog research workflows', () => {
  it('replays captured catalog sequence and CDS analysis in real browser workers and native hosts after the catalog closes', async () => {
    const { createBrowserResearchWorkflow, runResearchWorker } = await import('../components/overlays/ResearchWorkflowPanel');
    const { prepareCatalogGenomeSnapshot, useLocalGenomes } = await import('../db/local-genomes');
    const { ActionIds } = await import('./actionRegistry');
    const { replayResearchTape } = await import('../../../tui/src/research-replay');
    const before = useLocalGenomes.getState();
    const repo = new BunSqliteRepository(fileURLToPath(new URL('../../public/phage.db', import.meta.url)), { readonly: true });
    const { phage, captured } = await (async () => {
      try {
        const phage = await repo.getPhageBySlug('lambda');
        if (!phage) throw new Error('Expected the curated Lambda genome');
        const captured = await prepareCatalogGenomeSnapshot(repo, phage, {
          signal: new AbortController().signal, isCurrent: () => true,
          parse: async (input, signal) => {
            const result = await runResearchWorker({ type: 'parse', input }, signal);
            if (result.type !== 'parsed') throw new Error('Expected parsed catalog snapshot');
            return result.result;
          },
        });
        return { phage, captured };
      } finally { await repo.close(); }
    })();
    const genes = [...phage.genes].sort((a, b) => a.id - b.id);
    const genome = captured.genomes[0], contentId = genome.phage.localGenome!.contentId;
    const gene = genome.phage.genes.find(g => g.type === 'CDS' && g.locusTag === 'lambdap01');
    if (!gene) throw new Error('Expected Lambda terminase small subunit CDS');
    assert.equal(gene.id, 2);
    useLocalGenomes.setState({ genomes: captured.genomes, requestedId: null });
    const binding = createBrowserResearchWorkflow(async () => { throw new Error('No navigation requested'); });
    try {
      binding.workflow.start('Captured catalog GC and coding sequence');
      await binding.workflow.commands.dispatch(ActionIds.OverlayGCSkew, { contentId, windowSize: 500, stepSize: 500 });
      const window = (binding.workflow.getSnapshot().lastAnalysis!.fields.windows.value as Array<{ g: number; c: number }>)[0];
      assert.equal(window.g, genome.sequence.slice(0, 500).split('G').length - 1);
      assert.equal(window.c, genome.sequence.slice(0, 500).split('C').length - 1);
      await binding.workflow.commands.dispatch(ActionIds.OverlayCodonAdaptation, { contentId, geneId: gene.id });
      const codons = binding.workflow.getSnapshot().lastAnalysis!;
      assert.equal((codons.fields.codingSequences.value as Array<{ geneId: number }>)[0].geneId, gene.id);
      assert.equal(codons.fields.hostRankings.kind, 'demo');
      binding.workflow.commands.stop();
      const tapeJson = binding.workflow.commands.export();
      const archiveJson = await binding.workflow.replayWithResults(2);
      const native = await replayResearchTape(tapeJson, { repetitions: 2, captureResults: true });
      assert.equal(native.report.completed, 4);
      assert.equal(native.allResultsJson, archiveJson);
      const archive = await parseWorkflowResults(archiveJson);
      assert.equal(archive.records.length, 2);
      const context = parseCommandTape(archive.tapeJson).context as { bundle: string };
      const restored = await importLocalGenomes({ name: 'detached-catalog-workflow.json', text: context.bundle });
      assert.deepEqual(restored.genomes[0].phage.genes, genes);
      assert.deepEqual(JSON.parse(restored.genomes[0].original.text).genome.genes, genes);
      assert.equal(restored.genomes[0].phage.localGenome!.contentId, contentId);
      assert.equal(restored.genomes[0].sequence, genome.sequence);
    } finally { binding.dispose(); useLocalGenomes.setState(before); }
  });
});

describe('production browser spacer workflow adapter', () => {
  it('uses real workers to preserve exact spacer inputs, all results and terminal-compatible replay', async () => {
    const { createBrowserResearchWorkflow } = await import('../components/overlays/ResearchWorkflowPanel');
    const { useLocalGenomes } = await import('../db/local-genomes');
    const { ActionIds } = await import('./actionRegistry');
    const { replayResearchTape } = await import('../../../tui/src/research-replay');
    const before = useLocalGenomes.getState();
    const dna = 'TTTTACGATTCGGTACCTAGTGCAAGGNNNNCCTTGCACTAGGTACCGAATCGTAAAA';
    const parsed = await importLocalGenomes({ name: 'spacer.fa', text: `>private [topology=linear]\n${dna}\n` });
    const library: SpacerLibrary = { format: 'phage-explorer-spacer-library', version: 1, name: 'Synthetic coordinate controls',
      source: { kind: 'local', reference: 'Hand-constructed sequence fixture', version: 'test-1', license: 'CC0', scope: 'Two artificial strains' },
      hosts: [{ id: 'one', name: 'Shared label', strain: 'with records', accession: 'synthetic:one' },
        { id: 'two', name: 'Shared label', strain: 'no records', accession: 'synthetic:two' }],
      spacers: [{ id: 'guide', hostId: 'one', arrayAccession: 'synthetic:array', sequence: 'ACGATTCGGTACCTAGTGCA', system: null,
        target: 'DNA', orientation: 'guide-equivalent', pam: { side: '3prime', motif: 'NGG', reference: 'Oriented test rule' }, seed: null }] };
    useLocalGenomes.setState({ genomes: parsed.genomes, requestedId: null });
    const bindings = [createBrowserResearchWorkflow(async () => { throw new Error('No navigation requested'); })];
    try {
      const first = bindings[0].workflow, id = parsed.genomes[0].phage.localGenome!.contentId;
      const text = JSON.stringify(library, null, 2), parameters = researchSpacerParameters(id, text, 'linear', { hostId: 'one', maxMismatches: 0 });
      first.start('Sourced spacer sequence and no-data control');
      await first.commands.dispatch(ActionIds.OverlayCRISPR, analysisJson(parameters));
      const record = first.getSnapshot().lastAnalysis!;
      assert.deepEqual((record.fields.matches.value as unknown as ReferenceSpacerHit[]).map(hit => [hit.start, hit.end, hit.strand, hit.pam.sequence, hit.pam.status]),
        [[4, 24, '+', 'AGG', 'matched'], [34, 54, '-', 'AGG', 'matched']]);
      assert.deepEqual(record.inputs[1].data, library);
      assert.deepEqual(record.parameters, { hostId: 'one', maxMismatches: 0 });
      await first.commands.dispatch(ActionIds.OverlayCRISPR, analysisJson({ ...parameters, hostId: 'two' }));
      assert.equal((first.getSnapshot().lastAnalysis!.fields.coverage.value as { status: string }).status, 'no-spacer-data');
      assert.deepEqual(first.getSnapshot().lastAnalysis!.fields.matches.coverage, { available: 0, total: 0, unit: 'records' });
      first.commands.stop();
      const tapeJson = first.commands.export(), archiveJson = await first.replayWithResults(2);
      const archive = await parseWorkflowResults(archiveJson);
      assert.equal(archive.records.length, 2); assert.equal(archive.repetitions, 2);
      assert.equal((parseCommandTape(tapeJson).commands[0].parameters as { libraryText: string }).libraryText, text);
      assert.equal(archive.records[0].resultId, record.resultId);
      const terminal = await replayResearchTape(tapeJson, { captureResults: true, repetitions: 2 });
      assert.equal(terminal.report.completed, 4); assert.equal(terminal.allResultsJson, archiveJson);

      const next = createBrowserResearchWorkflow(async () => { throw new Error('No navigation requested'); }); bindings.push(next);
      const review = await next.workflow.loadResultsAndReview(archiveJson, new AbortController().signal);
      assert.equal(review.inputs.genomes[0].sequence, dna);
      assert.equal(next.workflow.getSnapshot().lastAnalysis, null);
      assert.equal(await next.workflow.verifyCompleteResults(archiveJson), archiveJson);
      const forged = await parseWorkflowResults(archiveJson), fields = structuredClone(forged.records[0].fields);
      (fields.matches.value as unknown as ReferenceSpacerHit[])[0].start = 123;
      forged.records[0] = await createAnalysisRecord({ ...forged.records[0], fields });
      const tape = parseCommandTape(forged.tapeJson), changed = forged.records[0];
      tape.commands[0].expected = analysisJson({ method: changed.method, cacheKey: changed.cacheKey, resultId: changed.resultId });
      forged.tapeJson = serializeCommandTape(tape);
      const forgedJson = serializeWorkflowResults(forged);
      await next.workflow.loadResultsAndReview(forgedJson, new AbortController().signal);
      await assert.rejects(next.workflow.verifyCompleteResults(forgedJson), /differs/);
      assert.equal(next.workflow.exportCompleteResults(), archiveJson);
    } finally {
      for (const binding of bindings) binding.dispose();
      useLocalGenomes.setState(before);
    }
  });
});

async function fixture(overrides: Partial<ResearchEnvironment> = {}) {
  const { genomes } = await importLocalGenomes({ name: 'literal.fa', text: '>row\nAACC\n>column\nCCAATT\n>circle [topology=circular]\nGAATTCAA\n' });
  let view: ResearchView | null = null, calls = 0;
  const environment: ResearchEnvironment = {
    genomes: () => genomes, bundle: () => exportLocalGenomeBundle(genomes),
    parseBundle: text => importLocalGenomes({ name: 'bundle.json', text }), currentView: () => view,
    applyView: async (next, signal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); view = structuredClone(next); },
    repeats: async () => { throw new Error('Legacy repeats not used'); }, codons: async () => { throw new Error('Codons not used'); },
    dotPlot: async (row, column, options) => {
      calls++;
      const a = { sequence: row.sequence, accession: row.phage.accession, source: 'local' as const };
      return column === null ? (await createDotPlotExperiment(a, options)).record : (await createPairwiseDotPlotExperiment(a,
        { sequence: column.sequence, accession: column.phage.accession, source: 'local' }, options)).record;
    },
    digest: async (genome, options) => { calls++; return createRestrictionDigestRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' }); },
    ...overrides,
  };
  const workflow = new ResearchWorkflow(ids, environment);
  const row = genomes[0].phage.localGenome!.contentId, column = genomes[1].phage.localGenome!.contentId;
  const navigation = { contentId: row, geneId: null, scrollPosition: 1, viewMode: 'dna', readingFrame: 0 };
  const pair = { contentId: row, comparisonContentId: column, bins: 3, window: 2 };
  const self = { contentId: row, comparisonContentId: null, bins: 2, window: 2 };
  const digest = researchDigestParameters(genomes[2].phage.localGenome!.contentId, { enzymes: ['EcoRI'], topology: 'circular' });
  return { workflow, environment, genomes, pair, self, digest, navigation, calls: () => calls };
}
async function recorded() {
  const f = await fixture(); f.workflow.start('Ordered comparisons and digest');
  await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.self));
  await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
  await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
  await f.workflow.commands.dispatch(ids.digest, analysisJson(f.digest));
  await f.workflow.commands.dispatch(ids.view, analysisJson(f.navigation));
  f.workflow.commands.stop(); return f;
}
async function altered(record: AnalysisRecord) {
  const fields = structuredClone(record.fields); (fields.direct.value as number[])[0] = 0.75;
  return createAnalysisRecord({ method: record.method, inputs: record.inputs, parameters: record.parameters, references: record.references, seed: record.seed, fields });
}

describe('complete browser research runs', () => {
  it('retains literal numeric results and all execution identities without duplicating repeated evidence', async () => {
    const f = await recorded(), text = await f.workflow.replayWithResults(2), archive = await parseWorkflowResults(text);
    assert.equal(archive.records.length, 3); assert.equal(archive.repetitions, 2);
    assert.equal(f.workflow.commands.getSnapshot().completed, 10);
    assert.deepEqual(archive.records[0].fields.direct.value, [1, 0, 0, 1]);
    assert.deepEqual(archive.records[1].fields.direct.value, [0, 1, 0, .5, .5, 0, 1, 0, 0]);
    assert.deepEqual(archive.records[2].fields.cutSites.value, [1]);
    assert.deepEqual(archive.records[2].fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
    assert.deepEqual(workflowResultIndex(archive.tapeJson, 2).map(row => [row.execution, row.iteration, row.step, row.analysis?.method.id ?? null]),
      [1, 2].flatMap(iteration => ['sequence-dot-plot', 'sequence-pairwise-dot-plot', 'sequence-pairwise-dot-plot', 'restriction-digest', null]
        .map((method, i) => [(iteration - 1) * 5 + i + 1, iteration, i + 1, method])));
    assert.equal(workflowAnalysisAt(archive, 2).resultId, workflowAnalysisAt(archive, 8).resultId);
    assert.throws(() => workflowAnalysisAt(archive, 10), /navigation/);
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.equal(f.workflow.exportCompleteResults(), text);
  });
  it('leaves ordinary last-analysis replay unchanged and retention opt-in', async () => {
    const f = await recorded(); await f.workflow.commands.replay();
    assert.equal(f.workflow.getSnapshot().completeResults, null);
    assert.equal(f.workflow.getSnapshot().lastAnalysis!.method.id, 'restriction-digest');
    assert.throws(f.workflow.exportCompleteResults, /No complete/);
  });
  it('reviews original inputs without executing, then verifies all saved evidence and repetitions', async () => {
    const f = await recorded(), text = await f.workflow.replayWithResults(2), next = await fixture();
    const review = await next.workflow.loadResultsAndReview(text, new AbortController().signal);
    assert.equal(review.inputs.genomes.length, 3); assert.equal(review.repetitions, 2); assert.equal(review.records, 3);
    assert.equal(next.calls(), 0); assert.equal(next.workflow.getSnapshot().completeResults, null);
    assert.equal(await next.workflow.verifyCompleteResults(text), text);
    assert.equal(next.calls(), 8);
    assert.equal(next.workflow.getSnapshot().view!.scrollPosition, 1);
  });
  it('refuses a different active tape before invoking any numerical provider', async () => {
    const f = await recorded(), text = await f.workflow.replayWithResults(), next = await fixture();
    await assert.rejects(next.workflow.verifyCompleteResults(text), /Load and review/); assert.equal(next.calls(), 0);
  });
  it('rejects false earlier evidence even when both the archive and its tape carry valid new hashes', async () => {
    const f = await recorded(), original = await f.workflow.replayWithResults(), saved = await parseWorkflowResults(original);
    saved.records[0] = await altered(saved.records[0]);
    const tape = parseCommandTape(saved.tapeJson), changed = saved.records[0];
    tape.commands[0].expected = analysisJson({ method: changed.method, cacheKey: changed.cacheKey, resultId: changed.resultId });
    saved.tapeJson = serializeCommandTape(tape); const forged = serializeWorkflowResults(saved);
    await parseWorkflowResults(forged); // Internally consistent, but not numerical truth.
    await f.workflow.loadResultsAndReview(forged, new AbortController().signal);
    await assert.rejects(f.workflow.verifyCompleteResults(forged), /differs/);
    assert.match(f.workflow.commands.getSnapshot().error!, /Step 1.*differs/);
    assert.equal(f.workflow.commands.getSnapshot().completed, 0);
    assert.equal(f.workflow.exportCompleteResults(), original);
  });
  it('keeps the preceding complete archive after a later command fails; no partial replacement is exported', async () => {
    const f = await recorded(), original = await f.workflow.replayWithResults();
    const provider = f.environment.digest; f.environment.digest = async () => { throw new Error('Digest unavailable'); };
    await assert.rejects(f.workflow.replayWithResults(), /Digest unavailable/);
    assert.match(f.workflow.commands.getSnapshot().error!, /Step 4.*Digest unavailable/);
    assert.equal(f.workflow.commands.getSnapshot().completed, 3);
    assert.equal(f.workflow.exportCompleteResults(), original);
    f.environment.digest = provider; assert.equal(await f.workflow.replayWithResults(), original);
  });
  it('cancels an abort-ignoring provider and rejects its late result without corrupting subsequent captures', async () => {
    const f = await recorded(), original = await f.workflow.replayWithResults(), started = latch(), release = latch();
    const provider = f.environment.dotPlot!;
    f.environment.dotPlot = async (...args) => { started.release(); await release.promise; return provider(...args); };
    const controller = new AbortController(), task = f.workflow.replayWithResults(2, controller.signal);
    const rejected = assert.rejects(task, { name: 'AbortError' }); await started.promise; controller.abort(); await rejected;
    assert.equal(f.workflow.exportCompleteResults(), original);
    f.environment.dotPlot = provider; const fresh = await f.workflow.replayWithResults();
    release.release(); await flush(); assert.equal(f.workflow.exportCompleteResults(), fresh);
  });
  it('never publishes a complete archive after cancellation in the final progress callback', async () => {
    const f = await recorded(), original = await f.workflow.replayWithResults();
    const unsub = f.workflow.commands.subscribe(() => {
      const s = f.workflow.commands.getSnapshot(); if (s.mode === 'replaying' && s.completed === s.total) f.workflow.commands.cancel();
    });
    await assert.rejects(f.workflow.replayWithResults(2), { name: 'AbortError' }); unsub();
    assert.equal(f.workflow.exportCompleteResults(), original);
  });
  it('pause/resume retains one execution per completed command across repetitions', async () => {
    const f = await recorded(), paused = latch(); let once = false;
    const unsub = f.workflow.commands.subscribe(() => {
      const s = f.workflow.commands.getSnapshot();
      if (!once && s.mode === 'replaying' && s.completed === 2) { once = true; f.workflow.commands.pause(); paused.release(); }
    });
    const task = f.workflow.replayWithResults(2); await paused.promise; await flush();
    assert.equal(f.workflow.commands.getSnapshot().completed, 2); assert.equal(f.workflow.getSnapshot().completeResults, null);
    f.workflow.commands.resume(); const archive = await parseWorkflowResults(await task); unsub();
    assert.equal(archive.records.length, 3); assert.equal(workflowResultIndex(archive.tapeJson, 2).length, 10);
  });
  it('cannot publish stale results after a new command arrives during final archive hashing', async () => {
    const f = await recorded(), original = await f.workflow.replayWithResults(), started = latch(), release = latch();
    const finish = WorkflowResultCollector.prototype.finish;
    WorkflowResultCollector.prototype.finish = async function (...args) { started.release(); await release.promise; return finish.apply(this, args); };
    try {
      const task = f.workflow.replayWithResults(2), rejected = assert.rejects(task, { name: 'AbortError' });
      await started.promise; await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
      release.release(); await rejected;
      assert.equal(f.workflow.exportCompleteResults(), original);
      assert.equal(f.workflow.getSnapshot().lastAnalysis!.method.id, 'sequence-pairwise-dot-plot');
    } finally { WorkflowResultCollector.prototype.finish = finish; release.release(); }
  });
  it('preserves accepted archives through new recordings and refuses malformed or incomplete imports', async () => {
    const f = await recorded(), text = await f.workflow.replayWithResults();
    f.workflow.start('Different work'); f.workflow.commands.stop();
    assert.equal(f.workflow.exportCompleteResults(), text);
    const tapeBefore = f.workflow.commands.export();
    const missing = JSON.parse(text); missing.records.pop();
    for (const content of ['bad', JSON.stringify(missing)]) await assert.rejects(f.workflow.loadResultsAndReview(content, new AbortController().signal));
    assert.equal(f.workflow.commands.export(), tapeBefore); assert.equal(f.workflow.exportCompleteResults(), text);
  });
  it('supports navigation-only archives without fabricating an analysis', async () => {
    const f = await fixture(); f.workflow.start('View only');
    await f.workflow.commands.dispatch(ids.view, analysisJson(f.navigation)); f.workflow.commands.stop();
    const archive = await parseWorkflowResults(await f.workflow.replayWithResults(3));
    assert.deepEqual(archive.records, []); assert.equal(workflowResultIndex(archive.tapeJson, 3).length, 3);
    assert.throws(() => workflowAnalysisAt(archive, 1), /navigation/);
  });
  it('does not replace a newer accepted command after a delayed input review finishes', async () => {
    const f = await recorded(), content = await f.workflow.replayWithResults(), started = latch(), release = latch();
    const parse = f.environment.parseBundle;
    f.environment.parseBundle = async (...args) => { started.release(); await release.promise; return parse(...args); };
    const task = f.workflow.loadResultsAndReview(content, new AbortController().signal), rejected = assert.rejects(task, { name: 'AbortError' });
    await started.promise; await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
    const latest = f.workflow.getSnapshot().lastAnalysis!.resultId; release.release(); await rejected;
    assert.equal(f.workflow.getSnapshot().lastAnalysis!.resultId, latest);
    assert.equal(f.workflow.exportCompleteResults(), content);
  });
  it('rejects pre-cancelled, empty, out-of-range and actively recording captures before computation', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.workflow.replayWithResults(1, controller.signal), { name: 'AbortError' });
    await assert.rejects(f.workflow.replayWithResults()); assert.equal(f.calls(), 0);
    f.workflow.start('Active'); await assert.rejects(f.workflow.replayWithResults(), /Stop recording/); assert.equal(f.calls(), 0);
    await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair)); f.workflow.commands.stop(); const before = f.calls();
    for (const count of [0, 1.5, 11, NaN]) await assert.rejects(f.workflow.replayWithResults(count));
    assert.equal(f.calls(), before);
  });
  it('retains the original archive tape text instead of silently reserializing an imported source', async () => {
    const f = await recorded(), saved = await parseWorkflowResults(await f.workflow.replayWithResults());
    saved.tapeJson = JSON.stringify(parseCommandTape(saved.tapeJson)); const compact = serializeWorkflowResults(saved);
    await f.workflow.loadResultsAndReview(compact, new AbortController().signal);
    const replayed = await parseWorkflowResults(await f.workflow.verifyCompleteResults(compact));
    assert.equal(replayed.tapeJson, saved.tapeJson);
    assert.deepEqual(replayed.records.map(serializeAnalysisRecord), saved.records.map(serializeAnalysisRecord));
  });
});

describe('complete-result file import boundary', () => {
  it('preserves valid UTF-8 input and rejects malformed bytes rather than replacing them', async () => {
    const text = '{"name":"measured α → β"}\n', bytes = new TextEncoder().encode(text).buffer;
    assert.equal(await readWorkflowResultsFile({ size: bytes.byteLength, arrayBuffer: async () => bytes }, new AbortController().signal), text);
    await assert.rejects(readWorkflowResultsFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }, new AbortController().signal));
  });
  it('bounds declared and actual byte size before accepting an import', async () => {
    let reads = 0; const signal = new AbortController().signal;
    for (const size of [-1, NaN, Infinity, 1.5, WORKFLOW_RESULTS_LIMITS.bytes + 1]) {
      await assert.rejects(readWorkflowResultsFile({ size, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, signal), /32 MiB/);
    }
    assert.equal(reads, 0);
    await assert.rejects(readWorkflowResultsFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(WORKFLOW_RESULTS_LIMITS.bytes + 1) }, signal), /32 MiB/);
  });
  it('settles cancellation before a slow file resolves, and handles its late rejection', async () => {
    let rejectRead!: (error: Error) => void; const started = latch(), controller = new AbortController();
    const read = readWorkflowResultsFile({ size: 10, arrayBuffer: () => {
      started.release(); return new Promise((_resolve, reject) => { rejectRead = reject; });
    } }, controller.signal);
    const rejected = assert.rejects(read, { name: 'AbortError' });
    await started.promise; controller.abort(); await rejected;
    rejectRead(new Error('Late disk error')); await flush();
  });
  it('does not launch a read after immediate or prior cancellation', async () => {
    let reads = 0; const file = { size: 0, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } };
    const controller = new AbortController(), pending = readWorkflowResultsFile(file, controller.signal);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(readWorkflowResultsFile(file, controller.signal), { name: 'AbortError' }); assert.equal(reads, 0);
  });
});
