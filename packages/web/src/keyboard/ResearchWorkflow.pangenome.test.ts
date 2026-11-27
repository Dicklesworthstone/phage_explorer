import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { mergeLocalGenomes } from '../../../db-runtime/src/local-genomes';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape, serializeCommandPlan } from '../../../core/src/command-session';
import { replayAlignmentPangenome } from '../../../core/src/analysis/alignment-pangenome';
import { createPangenomePhylogenyExperiment, replayAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { parseWorkflowResults, workflowAnalysisAt } from '../../../core/src/workflow-results';
import { executePangenomeRequest, pangenomeRequestFromLocalGenomes } from '../workers/PangenomeSession';
import { ResearchWorkflow, researchPangenomeParameters, researchPhylogenyParameters, validateResearchPangenome,
  type ResearchView, type ResearchEnvironment, type ResearchPhylogenyParameters } from './ResearchWorkflow';
import { ActionIds } from './actionRegistry';
import { runTerminalResearchWorker } from '../../../../scripts/research-workflow';

const ids = { view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation', pangenome: 'overlay.pangenomeGraph' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  // Same accession, different bases and content identities. Manually known CDS:
  // ATG AAA TAA -> MK*; ATG AAG TAA -> MK*: one synonymous substitution at base 5.
  const reference = (await importLocalGenomes({ name: 'reference.gb', text: 'LOCUS       SAME 9 bp DNA linear\nACCESSION   SAME\nFEATURES             Location/Qualifiers\n     CDS             1..9\n                     /gene="known"\nORIGIN\n        1 ATGAAATAA\n//\n' })).genomes[0];
  const query = (await importLocalGenomes({ name: 'query.fa', text: '>SAME\nATGAAGTAA\n' })).genomes[0];
  const loaded = [reference, query], contentIds = loaded.map(g => g.phage.localGenome!.contentId);
  let view: ResearchView | null = null, calculations = 0;
  const env: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => exportLocalGenomeBundle(loaded),
    parseBundle: (content) => importLocalGenomes({ name: 'bundle.json', text: content }),
    currentView: () => view, applyView: async next => { view = structuredClone(next); },
    repeats: async () => { throw new Error('No repeat command submitted by this fixture'); },
    codons: async () => { throw new Error('No illustrative codon command submitted by this fixture'); },
    pangenome: async request => { calculations++; return (await executePangenomeRequest(request)).record!; },
  };
  const workflow = new ResearchWorkflow(ids, env); workflow.start('Private graph experiment');
  const parameters = researchPangenomeParameters(contentIds,
    { referenceId: `local-${contentIds[0]}`, alignment: 'affine', terminalGaps: 'alleles' },
    { contentId: contentIds[0], geneIds: [1] });
  return { workflow, env, loaded, contentIds, parameters, calculations: () => calculations, view: () => view };
}
const run = (f: Awaited<ReturnType<typeof fixture>>) => f.workflow.commands.dispatch(ids.pangenome, analysisJson(f.parameters));

async function phylogenyFixture() {
  const f = await fixture(); f.workflow.commands.stop();
  // A common nonrepetitive flank supplies the existing normalizer's required
  // independent 15-mer anchors. Only the nine-base CDS varies: one transition
  // in each comparison to the reference and two between query and reverse.
  const flank = 'GCTACGATCGTACCGATGCTAGCTGACCTGATCGTAGCTAGGCTAACCGTAGGCTATCGACGCTAGCATGACCTAGGCATCGTACGATCGTGCAGATC';
  const sequence = 'ATGAAATAA' + flank;
  const complement: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
  const reverse = Array.from('ATGAAATAG' + flank).reverse().map(base => complement[base]).join('');
  const annotated = await importLocalGenomes({ name: 'reference.gb', text: `LOCUS       SAME ${sequence.length} bp DNA linear\nACCESSION   SAME\nFEATURES             Location/Qualifiers\n     CDS             1..9\n                     /gene="known"\nORIGIN\n        1 ${sequence}\n//\n` });
  const extra = await importLocalGenomes({ name: 'other-taxa.fa', text: `>QUERY\nATGAAGTAA${flank}\n>REVERSED\n${reverse}\n>FOURTH\nATGAAGTAG${flank}\n` });
  f.loaded.splice(0, f.loaded.length, ...annotated.genomes, ...extra.genomes);
  const contentIds = f.loaded.map(genome => genome.phage.localGenome!.contentId);
  const pangenome = researchPangenomeParameters(contentIds, { referenceId: `local-${contentIds[0]}`,
    alignment: 'affine', terminalGaps: 'alleles', normalization: 'strand',
    affinePenalties: { mismatch: 3, gapOpen: 5, gapExtend: 1 } }, { contentId: contentIds[0], geneIds: [1] });
  const parameters = researchPhylogenyParameters(pangenome, 'Captured coding-locus tree',
    'Synthetic coding-locus homology control; reverse taxon orientation explicitly normalized', { bootstrap: 20, seed: 17 });
  const environment: ResearchEnvironment = { ...f.env,
    phylogeny: async (source, options, signal) => (await createPangenomePhylogenyExperiment(source, options, signal)).record };
  const workflow = new ResearchWorkflow({ ...ids, phylogeny: ActionIds.OverlayPhylodynamics }, environment);
  workflow.start('Linked pangenome and phylogeny');
  return { ...f, contentIds, pangenome, parameters, environment, workflow };
}

describe('recorded pangenome-backed phylogenies', () => {
  it('records all three distance models through production browser workers and deterministically replays both directions through the native worker', async () => {
    const f = await phylogenyFixture();
    const { createBrowserResearchWorkflow } = await import('../components/overlays/ResearchWorkflowPanel');
    const { useLocalGenomes } = await import('../db/local-genomes');
    const before = useLocalGenomes.getState();
    useLocalGenomes.setState({ genomes: f.loaded, requestedId: null });
    const binding = createBrowserResearchWorkflow(async () => { throw new Error('A tree command must not navigate'); });
    binding.activate();
    try {
      const browser = binding.workflow; browser.start('Browser and terminal linked trees');
      const records: AnalysisRecord[] = [];
      for (const distance of ['p-distance', 'jc69', 'k80'] as const) {
        const parameters = researchPhylogenyParameters(f.pangenome, f.parameters.name, f.parameters.reference,
          { distance, deletion: 'complete', bootstrap: 20, seed: 17 });
        await browser.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(parameters));
        const record = browser.getSnapshot().lastAnalysis!;
        records.push(record);
        const tree = await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(record));
        assert.deepEqual(tree.options, parameters.options);
        assert.equal(tree.pangenome!.source.reference, f.parameters.reference);
        const parent = await replayAlignmentPangenome(tree.pangenome!.source.experiment);
        assert.equal(tree.pangenome!.parentResultId, parent.record.resultId);
        assert.deepEqual(parent.graph.options, f.pangenome.options);
        assert.deepEqual(parent.record.inputs.find(input => input.id === 'genbank')!.data, analysisJson(f.loaded[0].original));
        assert.equal(parent.graph.diagnostics.normalization!.sequences.find(row => row.sequenceId === `local-${f.contentIds[2]}`)!.transform.strand, '-');
        assert.equal(tree.result.usedSites, f.loaded[0].sequence.length);
        assert.equal(tree.result.taxa.length, 4);
        assert.equal(record.seed, 17);
        if (distance === 'p-distance') {
          const indexes = f.contentIds.map(id => tree.result.taxa.indexOf(`local-${id}`));
          assert.equal(tree.result.distances[indexes[0]][indexes[1]], 1 / tree.result.usedSites);
          assert.equal(tree.result.distances[indexes[0]][indexes[2]], 1 / tree.result.usedSites);
          assert.equal(tree.result.distances[indexes[1]][indexes[2]], 2 / tree.result.usedSites);
          assert.equal(tree.result.bootstrap.completed, 20);
        }
      }
      browser.commands.stop();
      const content = browser.commands.export(), archive = await browser.replayWithResults(2);
      const native = await runTerminalResearchWorker({ type: 'replay', content, repetitions: 2,
        exportAnalysis: false, captureResults: true }, new AbortController().signal);
      assert.equal(native.type, 'replayed');
      if (native.type !== 'replayed') throw new Error('Expected native replay');
      assert.equal(native.report.completed, 6);
      assert.equal(native.allResultsJson, archive);
      assert.equal(native.analysisJson, null, 'complete capture uses the archive rather than a separate last-analysis export');
      const results = await parseWorkflowResults(archive);
      records.forEach((record, index) => {
        assert.deepEqual(workflowAnalysisAt(results, index + 1), record);
        assert.deepEqual(workflowAnalysisAt(results, index + 4), record);
      });

      // Author new expected values natively from a declarative plan. The browser
      // must freshly reconstruct those values, not merely accept their hashes.
      const tape = parseCommandTape(content), plan = serializeCommandPlan({ ...tape, format: 'phage-explorer-command-plan',
        commands: tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })) });
      const recorded = await runTerminalResearchWorker({ type: 'record', content: plan, captureResults: true }, new AbortController().signal);
      assert.equal(recorded.type, 'recorded');
      if (recorded.type !== 'recorded') throw new Error('Expected native recording');
      assert.equal(recorded.tapeJson, content);
      await browser.loadResultsAndReview(recorded.allResultsJson!, new AbortController().signal);
      assert.equal(await browser.verifyCompleteResults(recorded.allResultsJson!), recorded.allResultsJson);
      assert.deepEqual(browser.getSnapshot().lastAnalysis, records[2]);
    } finally { binding.dispose(); useLocalGenomes.setState(before); }
  }, 30000);

  it('validates the whole tree command before navigation and refuses changes to provenance, parent settings or seed under old expectations', async () => {
    const f = await phylogenyFixture();
    await f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(f.parameters));
    f.workflow.commands.stop();
    const content = f.workflow.commands.export(), prior = f.workflow.getSnapshot().lastAnalysis;
    for (const mutate of [
      (value: ResearchPhylogenyParameters) => { value.reference = ' '; },
      (value: ResearchPhylogenyParameters) => { value.options.bootstrap = 1; },
      (value: ResearchPhylogenyParameters) => { value.options.seed = -1; },
      (value: ResearchPhylogenyParameters) => { delete (value.options as Partial<typeof value.options>).seed; },
      (value: ResearchPhylogenyParameters) => { value.pangenome.contentIds = f.contentIds.slice(0, 2); },
    ]) {
      const tape = parseCommandTape(content); mutate(tape.commands[0].parameters as unknown as ResearchPhylogenyParameters);
      tape.commands.unshift({ actionId: ids.view, parameters: analysisJson({ contentId: f.contentIds[0], geneId: 1,
        viewMode: 'dna', readingFrame: 0, scrollPosition: 0 }), expected: null });
      assert.throws(() => f.workflow.load(serializeCommandTape(tape)), /Step 2/);
      assert.equal(f.workflow.commands.export(), content);
      assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, prior);
      assert.equal(f.view(), null);
    }
    for (const mutate of [
      (value: ResearchPhylogenyParameters) => { value.reference += ' Changed assessment'; },
      (value: ResearchPhylogenyParameters) => { value.options.seed++; },
      (value: ResearchPhylogenyParameters) => { value.pangenome.options.affinePenalties!.mismatch++; },
    ]) {
      const tape = parseCommandTape(content); mutate(tape.commands[0].parameters as unknown as ResearchPhylogenyParameters);
      f.workflow.load(serializeCommandTape(tape));
      await assert.rejects(f.workflow.commands.replay(), /differs/);
      assert.equal(f.workflow.getSnapshot().result, null);
    }
  });

  it('binds producer output to the exact parent, provenance, settings, seed and result units', async () => {
    const f = await phylogenyFixture();
    const produce = f.environment.phylogeny!;
    await f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(f.parameters));
    const prior = f.workflow.getSnapshot().lastAnalysis;
    for (const alteration of ['provenance', 'parent', 'seed', 'units'] as const) {
      f.environment.phylogeny = async (source, options, signal) => {
        if (alteration === 'provenance') source.reference += ' Different evidence';
        if (alteration === 'parent') {
          const input = pangenomeRequestFromLocalGenomes(f.loaded, f.contentIds).input;
          const changed = await executePangenomeRequest({ kind: 'analyze', input, options: f.pangenome.options });
          source.experiment = serializeAnalysisRecord(changed.record!);
        }
        if (alteration === 'seed') options.seed++;
        const record = await produce(source, options, signal);
        if (alteration !== 'units') return record;
        record.fields.phylogeny.units = 'base-pairs';
        return createAnalysisRecord(record);
      };
      await assert.rejects(f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(f.parameters)), /does not match/);
      assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, prior);
    }
    f.environment.phylogeny = produce;
  });

  it('rejects changed captured input after inference and cancels either producer without accepting late evidence', async () => {
    for (const phase of ['parent', 'tree', 'stale'] as const) {
      const f = await phylogenyFixture();
      await f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(f.parameters));
      const prior = f.workflow.getSnapshot().lastAnalysis;
      const ready = deferred<void>(), release = deferred<void>();
      const parent = f.environment.pangenome!, tree = f.environment.phylogeny!;
      if (phase === 'parent') f.environment.pangenome = async (request, signal) => {
        const result = await parent(request, signal); ready.resolve(); await release.promise; return result;
      };
      else f.environment.phylogeny = async (source, options, signal) => {
        const result = await tree(source, options, signal); ready.resolve(); await release.promise; return result;
      };
      const pending = f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(f.parameters));
      await ready.promise;
      if (phase === 'stale') {
        f.loaded[2].original.text += '\nchanged during inference';
        release.resolve(); await assert.rejects(pending, /changed original source/);
      } else {
        f.workflow.commands.cancel(); await assert.rejects(pending, /cancel/i);
        f.environment.pangenome = parent; f.environment.phylogeny = tree;
        const current = { ...f.parameters, name: 'New accepted tree after cancellation' };
        await f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(current));
        const accepted = f.workflow.getSnapshot().lastAnalysis;
        release.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
        assert.notEqual(accepted!.resultId, prior!.resultId);
      }
      if (phase === 'stale') assert.strictEqual(f.workflow.getSnapshot().lastAnalysis, prior);
    }
  });
});

describe('recorded real pangenome and CDS commands', () => {
  it('records affine defaults, exact content IDs and a real synonymous CDS result; exports a independently replayable experiment', async () => {
    const f = await fixture(); await run(f); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export());
    assert.equal(tape.commands.length, 1);
    assert.deepEqual(tape.commands[0].parameters, analysisJson(f.parameters));
    assert.deepEqual(f.parameters.options.affinePenalties, { mismatch: 4, gapOpen: 6, gapExtend: 1 });
    assert.notEqual(f.contentIds[0], f.contentIds[1]);
    const result = f.workflow.getSnapshot().result!;
    assert.equal(result.method.version, '5');
    const fresh = await replayAlignmentPangenome(serializeAnalysisRecord(result));
    assert.deepEqual(fresh.graph.variants.map(v => [v.referenceStart, v.reference, v.alternate]), [[5, 'A', 'G']]);
    assert.deepEqual(fresh.cds!.consequences[0].effects, ['synonymous']);
    assert.equal(fresh.cds!.consequences[0].queryProtein, 'MK*');
    assert.equal(fresh.graph.diagnostics.affine!.pairs[0].score, 4);
    assert.equal(f.calculations(), 1);
    assert.equal(Object.hasOwn(tape.commands[0].parameters as object, 'sequences'), false, 'commands reference the single source bundle, not copied sequences');
    assert.equal(f.view(), null, 'analysis does not navigate or publish into another workspace');
  });
  it('reopens without computing, explicitly adds bundled genomes, then verifies two complete repetitions', async () => {
    const f = await fixture();
    await f.workflow.commands.dispatch(ids.view, analysisJson({ contentId: f.contentIds[0], geneId: 1, viewMode: 'aa', readingFrame: 0, scrollPosition: 1 }));
    await run(f); f.workflow.commands.stop();
    const tape = f.workflow.commands.export(), result = f.workflow.getSnapshot().result!;
    f.loaded.length = 0;
    const reviewed = await f.workflow.loadAndReview(tape, new AbortController().signal);
    assert.equal(f.calculations(), 1); assert.equal(f.loaded.length, 0); assert.equal(f.workflow.getSnapshot().result, null);
    await assert.rejects(f.workflow.commands.replay(), /Missing local genome/);
    f.loaded.push(...reviewed.genomes.reverse());
    await f.workflow.commands.replay(2);
    assert.equal(f.calculations(), 3); assert.equal(f.workflow.commands.getSnapshot().completed, 4);
    assert.deepEqual(f.workflow.getSnapshot().result, result);
    assert.notStrictEqual(f.workflow.getSnapshot().result, result, 'newly computed record replaces neither input nor a replayed stored number');
    assert.equal(f.view()!.scrollPosition, 1);
  });
  it('replays transport-equivalent GenBank input using the exact recorded annotation source', async () => {
    const f = await fixture(); await run(f); f.workflow.commands.stop();
    const tape = f.workflow.commands.export(), record = f.workflow.getSnapshot().result!;
    const captured = structuredClone(f.loaded[0].original);
    const alternate = await importLocalGenomes({ name: 'renamed-annotation.gb', text: captured.text.replace(/\n/g, '\r\n') });
    assert.deepEqual(alternate.genomes[0].phage, f.loaded[0].phage);
    const reviewed = await f.workflow.loadAndReview(tape, new AbortController().signal);
    const admitted = mergeLocalGenomes([alternate.genomes[0], f.loaded[1]], reviewed, [], true);
    f.loaded.splice(0, f.loaded.length, ...admitted);
    const sources = f.loaded.map(genome => structuredClone(genome.original));
    const produce = f.env.pangenome!;
    f.env.pangenome = async (request, signal) => {
      assert.equal(request.kind, 'annotate');
      if (request.kind !== 'annotate') throw new Error('Expected the recorded CDS annotation command');
      assert.deepEqual(request.annotation, captured);
      return produce(request, signal);
    };
    await f.workflow.commands.replay(2);
    assert.equal(f.calculations(), 3);
    assert.equal(serializeAnalysisRecord(f.workflow.getSnapshot().result!), serializeAnalysisRecord(record));
    assert.equal(f.workflow.commands.export(), tape);
    assert.deepEqual(f.loaded.map(genome => genome.original), sources);
    assert.deepEqual((await replayAlignmentPangenome(serializeAnalysisRecord(record))).cds!.consequences[0].effects, ['synonymous']);

    // Cached parsed annotations/content IDs cannot legitimize different source
    // bytes. Reparse the current original before another operation can use it.
    f.loaded[0].original.text = f.loaded[0].original.text.replace('/gene="known"', '/gene="changed"');
    await assert.rejects(f.workflow.commands.replay(), /changed original source/);
    assert.equal(f.calculations(), 3);
    assert.equal(serializeAnalysisRecord(f.workflow.getSnapshot().result!), serializeAnalysisRecord(record));
    f.loaded[0].original = sources[0];
    await f.workflow.commands.replay();
    assert.equal(f.calculations(), 4);
    assert.equal(serializeAnalysisRecord(f.workflow.getSnapshot().result!), serializeAnalysisRecord(record));
  });
  it('replays every unannotated alignment model and exact reverse/circular representations', async () => {
    for (const alignment of ['provided', 'global', 'wavefront', 'affine'] as const) {
      const f = await fixture();
      f.parameters = researchPangenomeParameters(f.contentIds, { referenceId: `local-${f.contentIds[0]}`, alignment, terminalGaps: 'missing' });
      await run(f); f.workflow.commands.stop(); await f.workflow.commands.replay();
      assert.equal(f.workflow.getSnapshot().result!.method.id, 'alignment-pangenome');
      assert.equal(f.workflow.getSnapshot().result!.inputs.length, 1);
    }
    const f = await fixture();
    const rotated = (await importLocalGenomes({ name: 'reverse.fa', text: '>REVERSE\nTTATTTCAT\n' })).genomes[0];
    f.loaded[1] = rotated; f.contentIds[1] = rotated.phage.localGenome!.contentId;
    f.workflow.commands.stop(); f.workflow.start('Reoriented circles');
    f.parameters = researchPangenomeParameters(f.contentIds, { referenceId: `local-${f.contentIds[0]}`, alignment: 'affine', normalization: 'circular', terminalGaps: 'alleles' });
    await run(f); f.workflow.commands.stop(); await f.workflow.commands.replay();
    const record = f.workflow.getSnapshot().result!;
    assert.deepEqual(record.fields.variants.value, []);
    assert.equal((await replayAlignmentPangenome(serializeAnalysisRecord(record))).graph.diagnostics.normalization!.sequences.find(s => s.sequenceId === `local-${f.contentIds[1]}`)!.transform.strand, '-');
  });
  it('rejects whole-tape invalid model settings before navigation and preserves accepted tape/results', async () => {
    const f = await fixture(); await run(f); f.workflow.commands.stop();
    const saved = f.workflow.commands.export(), record = f.workflow.getSnapshot().result;
    for (const edit of [
      (p: typeof f.parameters) => { p.options.affinePenalties!.mismatch = 0; },
      (p: typeof f.parameters) => { p.options.referenceId = 'absent'; },
      (p: typeof f.parameters) => { p.contentIds = [f.contentIds[0], f.contentIds[0]]; },
      (p: typeof f.parameters) => { p.options.normalization = 'circular'; p.options.terminalGaps = 'missing'; },
      (p: typeof f.parameters) => { p.annotation!.geneIds = [0]; },
      (p: typeof f.parameters) => { delete p.options.affinePenalties; },
    ]) {
      const tape = parseCommandTape(saved); edit(tape.commands[0].parameters as unknown as typeof f.parameters);
      tape.commands.unshift({ actionId: ids.view, parameters: analysisJson({ contentId: f.contentIds[0], geneId: null, viewMode: 'dna', readingFrame: 0, scrollPosition: 0 }), expected: null });
      assert.throws(() => f.workflow.load(serializeCommandTape(tape)), /Step 2/);
      assert.equal(f.workflow.commands.export(), saved); assert.strictEqual(f.workflow.getSnapshot().result, record); assert.equal(f.view(), null);
    }
  });
  it('stops at the changed scoring step without accepting the recomputed result under old expectations', async () => {
    const f = await fixture(); await run(f); f.workflow.commands.stop();
    const tape = parseCommandTape(f.workflow.commands.export());
    (tape.commands[0].parameters as unknown as typeof f.parameters).options.affinePenalties!.mismatch = 5;
    f.workflow.load(serializeCommandTape(tape));
    await assert.rejects(f.workflow.commands.replay(), /differs/);
    assert.match(f.workflow.commands.getSnapshot().error!, /Step 1.*pangenomeGraph/);
    assert.equal(f.workflow.getSnapshot().result, null);
  });
  it('checks every query, annotation and original source again before publication', async () => {
    for (const change of ['sequence', 'source', 'missing', 'duplicate'] as const) {
      const f = await fixture(); await run(f); const prior = f.workflow.getSnapshot().result;
      const computed = deferred<AnalysisRecord>(), release = deferred<void>();
      f.env.pangenome = async request => { const record = (await executePangenomeRequest(request)).record!; computed.resolve(record); await release.promise; return record; };
      const pending = run(f); await computed.promise;
      if (change === 'sequence') f.loaded[1].sequence = 'CCCCCCCCC';
      if (change === 'source') f.loaded[0].original.text += '\nchanged source';
      if (change === 'missing') f.loaded.pop();
      if (change === 'duplicate') f.loaded.push(structuredClone(f.loaded[1]));
      release.resolve(); await assert.rejects(pending, /changed|Missing|Duplicate/);
      assert.strictEqual(f.workflow.getSnapshot().result, prior); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
    }
  });
  it('isolates worker requests and rejects a genuine result computed with substituted inputs', async () => {
    const f = await fixture(), before = structuredClone(f.loaded);
    f.env.pangenome = async request => {
      request.input.sequences.find(row => row.id !== request.options.referenceId)!.sequence = 'ATGCCCTAA';
      return (await executePangenomeRequest(request)).record!;
    };
    await assert.rejects(run(f), /does not match/);
    assert.deepEqual(f.loaded, before); assert.equal(f.workflow.getSnapshot().result, null);
  });
  it('cancels promptly even if an executor ignores abort; late results cannot displace newer evidence', async () => {
    const f = await fixture(); await run(f); const previous = f.workflow.getSnapshot().result;
    const started = deferred<void>(), late = deferred<AnalysisRecord>();
    f.env.pangenome = async () => { started.resolve(); return late.promise; };
    const pending = run(f); await started.promise;
    f.workflow.commands.cancel(); await assert.rejects(pending, { name: 'AbortError' });
    f.env.pangenome = async request => (await executePangenomeRequest(request)).record!;
    await run(f); const newer = f.workflow.getSnapshot().result;
    late.resolve(previous!); await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(f.workflow.getSnapshot().result, newer);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 2);
  });
  it('pauses between complete real graph commands and resumes without replaying the prior step', async () => {
    const f = await fixture(); await run(f); await run(f); f.workflow.commands.stop();
    const paused = deferred<void>();
    const unsubscribe = f.workflow.commands.subscribe(() => {
      const state = f.workflow.commands.getSnapshot();
      if (state.mode === 'replaying' && state.completed === 1) { f.workflow.commands.pause(); paused.resolve(); }
    });
    const pending = f.workflow.commands.replay(); await paused.promise;
    assert.equal(f.calculations(), 3); assert.equal(f.workflow.commands.getSnapshot().mode, 'paused');
    unsubscribe(); f.workflow.commands.resume(); await pending;
    assert.equal(f.calculations(), 4); assert.equal(f.workflow.commands.getSnapshot().completed, 2);
  });
  it('refuses missing annotation, wrong CDS, unbundled queries and colliding canonical action IDs', async () => {
    const f = await fixture();
    for (const annotation of [{ contentId: f.contentIds[1], geneIds: null }, { contentId: f.contentIds[0], geneIds: [999] }]) {
      f.parameters.annotation = annotation; await assert.rejects(run(f), /GenBank|CDS/);
    }
    f.parameters.annotation = null; f.parameters.contentIds = f.parameters.contentIds.map(id => id === f.contentIds[1] ? 'f'.repeat(64) : id);
    await assert.rejects(run(f), /outside/);
    assert.equal(f.calculations(), 0);
    assert.throws(() => new ResearchWorkflow({ ...ids, pangenome: ids.codons }, f.env), /distinct/);
    assert.throws(() => new ResearchWorkflow(ids, { ...f.env, pangenome: undefined }), /together/);
    assert.throws(() => validateResearchPangenome({ contentIds: [], options: {}, annotation: null }), /2–24/);
  });
});

describe('recorded source-column exclusion policy', () => {
  it('retains a canonical mask in captured commands, native replay, and complete evidence', async () => {
    const f = await phylogenyFixture();
    const parameters = researchPhylogenyParameters(f.pangenome, f.parameters.name, f.parameters.reference,
      { bootstrap: 20, seed: 17, excludedRegions: [{ start: 6, end: 8 }, { start: 5, end: 6 }] });
    assert.deepEqual(parameters.options.excludedRegions, [{ start: 5, end: 8 }]);
    await f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(parameters));
    const record = f.workflow.getSnapshot().lastAnalysis!;
    assert.equal(record.method.version, '4.0.0');
    const tree = await replayAlignedPhylogenyExperiment(serializeAnalysisRecord(record));
    assert.equal(tree.result.usedSites, f.loaded[0].sequence.length - 3);
    assert.deepEqual(tree.pangenome?.regionExclusions?.parentColumns, [5, 6, 7]);
    const indexes = f.contentIds.map(id => tree.result.taxa.indexOf(`local-${id}`));
    assert.equal(tree.result.distances[indexes[0]][indexes[1]], 0);
    assert.equal(tree.result.distances[indexes[0]][indexes[2]], 1 / tree.result.usedSites);
    f.workflow.commands.stop();
    const content = f.workflow.commands.export();
    const native = await runTerminalResearchWorker({ type: 'replay', content, repetitions: 1,
      exportAnalysis: false, captureResults: true }, new AbortController().signal);
    assert.equal(native.type, 'replayed');
    if (native.type !== 'replayed') throw new Error('Expected native replay');
    assert.equal(native.analysisJson, null);
    assert.deepEqual(workflowAnalysisAt(await parseWorkflowResults(native.allResultsJson!), 1), record);
    const captured = parseCommandTape(content);
    (captured.commands[0].parameters as unknown as ResearchPhylogenyParameters).options.excludedRegions = [{ start: 6, end: 8 }];
    f.workflow.load(serializeCommandTape(captured));
    await assert.rejects(f.workflow.commands.replay(), /differs/);
  }, 30000);
  it('does not allow a producer to mutate nested region settings to relabel different evidence', async () => {
    const f = await phylogenyFixture(), produce = f.environment.phylogeny!;
    const parameters = researchPhylogenyParameters(f.pangenome, f.parameters.name, f.parameters.reference,
      { excludedRegions: [{ start: 5, end: 8 }] });
    f.environment.phylogeny = (source, options, signal) => {
      options.excludedRegions![0].start = 6;
      return produce(source, options, signal);
    };
    await assert.rejects(f.workflow.commands.dispatch(ActionIds.OverlayPhylodynamics, analysisJson(parameters)), /does not match/);
    assert.deepEqual(parameters.options.excludedRegions, [{ start: 5, end: 8 }]);
    assert.equal(f.workflow.getSnapshot().lastAnalysis, null);
  });
});
