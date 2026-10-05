import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../../core/src/genome-import';
import { analysisJson, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { parseCommandTape, serializeCommandTape } from '../../../core/src/command-session';
import { replayAlignmentPangenome } from '../../../core/src/analysis/alignment-pangenome';
import { executePangenomeRequest } from '../workers/PangenomeSession';
import { ResearchWorkflow, researchPangenomeParameters, validateResearchPangenome,
  type ResearchView, type ResearchEnvironment } from './ResearchWorkflow';

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
