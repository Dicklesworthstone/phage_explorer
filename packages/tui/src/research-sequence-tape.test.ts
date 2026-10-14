import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle, type LocalGenome } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape } from '../../core/src/command-session';
import { createDotPlotExperiment, createPairwiseDotPlotExperiment } from '../../core/src/analysis/dot-plot';
import { ResearchWorkflow, validateResearchDotPlot, validateResearchDigest, researchDigestParameters,
  type ResearchEnvironment, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { executeResearchRequest, type ResearchWorkerRequest } from '../../web/src/workers/research-workflow.worker';
import { inspectResearchTape, replayResearchTape } from './research-replay';
import { researchWorkflowMain } from '../../../scripts/research-workflow';

const ids = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats, codons: ActionIds.OverlayCodonAdaptation,
  dotPlot: ActionIds.OverlayDotPlot, digest: ActionIds.OverlayGel, gcSkew: ActionIds.OverlayGCSkew };
const source = '>row\nAACC\n>column\nCCAATT\n>circle [topology=circular]\nGAATTCAA\n';
async function analysis(request: ResearchWorkerRequest): Promise<AnalysisRecord> {
  const result = await executeResearchRequest(request);
  assert.equal(result.type, 'analysis');
  if (result.type !== 'analysis') throw new Error('Expected computed evidence');
  return result.record;
}
async function fixture(overrides: Partial<ResearchEnvironment> = {}) {
  const { genomes } = await importLocalGenomes({ name: 'original.fa', text: source });
  let loaded = structuredClone(genomes), view: ResearchView | null = null;
  const input = (genome: LocalGenome) => genome.phage.localGenome!.contentId;
  const row = input(genomes[0]), column = input(genomes[1]), circle = input(genomes[2]);
  const environment: ResearchEnvironment = {
    genomes: () => loaded, bundle: () => exportLocalGenomeBundle(loaded),
    parseBundle: (text) => importLocalGenomes({ name: 'workflow.json', text }), currentView: () => view,
    applyView: async (next, signal) => { assert.equal(signal.aborted, false); view = structuredClone(next); },
    repeats: async () => { throw new Error('Legacy transport must not run'); },
    codons: async () => { throw new Error('Codon analysis is not part of this fixture'); },
    exactRepeats: (genome, options) => analysis({ type: 'exact-repeats', genome, options }),
    gcSkew: (genome, options) => analysis({ type: 'gc-skew', genome, options }),
    dotPlot: (genome, comparison, options) => analysis({ type: 'dot-plot', genome, comparison, options }),
    digest: (genome, options) => analysis({ type: 'restriction-digest', sequence: genome.sequence, options,
      context: { accession: genome.phage.accession, source: 'local' } }),
    ...overrides,
  };
  const workflow = new ResearchWorkflow(ids, environment);
  const navigation: ResearchView = { contentId: row, geneId: null, viewMode: 'dna', readingFrame: 0, scrollPosition: 0 };
  const self = { contentId: row, comparisonContentId: null, bins: 2, window: 2 };
  const pair = { contentId: row, comparisonContentId: column, bins: 3, window: 2 };
  const digest = researchDigestParameters(circle, { enzymes: ['EcoRI'], topology: 'circular' });
  return { genomes, row, column, circle, environment, workflow, navigation, self, pair, digest,
    replace: (next: LocalGenome[]) => { loaded = next; } };
}
async function recording() {
  const f = await fixture(); f.workflow.start('Composition, comparison and digestion');
  await f.workflow.commands.dispatch(ids.view, analysisJson(f.navigation));
  await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.self));
  const self = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
  const pair = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.digest, analysisJson(f.digest));
  const digest = f.workflow.getSnapshot().result!;
  await f.workflow.commands.dispatch(ids.view, analysisJson({ ...f.navigation, scrollPosition: 1 }));
  f.workflow.commands.stop();
  return { ...f, records: { self, pair, digest }, content: f.workflow.commands.export() };
}
async function resign(record: AnalysisRecord, change: (record: AnalysisRecord) => void) {
  const copy = structuredClone(record); change(copy);
  return createAnalysisRecord({ method: copy.method, inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input),
    parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields });
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('canonical dot-plot and digest command tapes', () => {
  it('records navigation, self/pairwise plots and a circular digest with independent numerical expectations', async () => {
    const f = await recording(), tape = parseCommandTape(f.content);
    assert.deepEqual(tape.commands.map(command => command.actionId), [ids.view, ids.dotPlot, ids.dotPlot, ids.digest, ids.view]);
    assert.deepEqual(f.records.self.fields.direct.value, [1, 0, 0, 1]);
    assert.deepEqual(f.records.pair.fields.direct.value, [0, 1, 0, 0.5, 0.5, 0, 1, 0, 0]);
    assert.deepEqual(f.records.pair.fields.inverted.value, [0, 0, 1, 0, 0, 0.5, 0, 0, 0]);
    assert.deepEqual(f.records.digest.fields.cutSites.value, [1]);
    assert.deepEqual(f.records.digest.fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
    assert.equal(f.workflow.getSnapshot().result, null);
    assert.equal(f.workflow.getSnapshot().lastAnalysis!.resultId, f.records.digest.resultId);
    const next = await fixture(); next.workflow.load(f.content); await next.workflow.commands.replay(2);
    assert.equal(next.workflow.commands.getSnapshot().completed, 10);
    assert.deepEqual(next.workflow.getSnapshot().lastAnalysis, f.records.digest);
    assert.equal(next.workflow.getSnapshot().view!.scrollPosition, 1);
  });

  it('replays the same tape in the native host, retaining the last analysis execution across navigation and repetitions', async () => {
    const f = await recording(), inspection = await inspectResearchTape(f.content);
    assert.equal(inspection.canReplay, true); assert(inspection.steps.every(step => step.supported));
    const native = await replayResearchTape(f.content, { repetitions: 2 });
    assert.equal(native.report.completed, 10); assert.equal(native.report.lastAnalysisExecution, 9);
    assert.deepEqual(native.lastAnalysis, f.records.digest);
    assert.deepEqual(native.report.steps[2].analysis, { method: f.records.pair.method, cacheKey: f.records.pair.cacheKey, resultId: f.records.pair.resultId });
    assert.deepEqual(native.report.finalView, { ...f.navigation, scrollPosition: 1 });
    assert.equal(f.content, f.workflow.commands.export());
  });

  it('exports the exact retained analysis through the real worker/CLI without overwriting its input', async () => {
    const f = await recording(), directory = await mkdtemp(join(tmpdir(), 'phage-sequence-tape-'));
    const input = join(directory, 'workflow.json'), output = join(directory, 'verified.json');
    await writeFile(input, f.content, { flag: 'wx', mode: 0o600 });
    let stdout = '', stderr = '';
    const code = await researchWorkflowMain(['replay', '--input', input, '--output', output, '--repetitions', '2', '--progress'],
      text => { stdout += text; }, text => { stderr += text; });
    assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).completed, 10);
    assert.equal(JSON.parse(stdout).lastAnalysisExecution, 9);
    assert.equal(await readFile(output, 'utf8'), serializeAnalysisRecord(f.records.digest));
    assert.equal(await readFile(input, 'utf8'), f.content);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert(!stdout.includes('GAATTCAA')); assert(!stderr.includes('GAATTCAA'));
    assert.equal(await researchWorkflowMain(['replay', '--input', input, '--output', input], () => assert.fail('No success output'), () => {}), 1);
    assert.equal(await readFile(input, 'utf8'), f.content);
  });

  it('uses explicit portable parameters and rejects ambiguous, extra or out-of-range command fields', async () => {
    const f = await fixture();
    validateResearchDotPlot(analysisJson(f.pair)); validateResearchDigest(analysisJson(f.digest));
    for (const change of [{ comparisonContentId: undefined }, { comparisonContentId: '' }, { bins: 201 }, { bins: 0 },
      { window: null }, { window: 0 }, { window: 5000001 }, { ambiguity: 'literal' }, { contentId: 1 }]) {
      assert.throws(() => validateResearchDotPlot(analysisJson({ ...f.pair, ...change })));
    }
    for (const change of [{ enzymes: ['EcoRI', 'EcoRI'] }, { enzymes: ['ecori'] }, { topology: null },
      { enzymes: ['EcoRI', 'BamHI'] }, { sourcePath: '/never/open' }]) {
      assert.throws(() => validateResearchDigest(analysisJson({ ...f.digest, ...change })));
    }
    assert.deepEqual(researchDigestParameters(f.circle, { enzymes: ['EcoRI', 'BamHI'], topology: 'circular' }).enzymes, ['BamHI', 'EcoRI']);
  });

  it('validates every later command before any earlier computation or input parsing', async () => {
    const f = await recording(), tape = parseCommandTape(f.content);
    (tape.commands[3].parameters as { topology: string }).topology = 'unknown';
    let calls = 0;
    const next = await fixture({ parseBundle: async () => { calls++; throw new Error('Should not parse'); },
      dotPlot: async () => { calls++; throw new Error('Should not compute'); } });
    assert.throws(() => next.workflow.load(serializeCommandTape(tape)), /Step 4/);
    await assert.rejects(replayResearchTape(serializeCommandTape(tape), { onProgress: () => { calls++; } }), /Step 4/);
    assert.equal(calls, 0);
  });

  it('rejects out-of-bounds windows before invoking a provider and does not append a failed command', async () => {
    let calls = 0;
    const f = await fixture({ dotPlot: async () => { calls++; throw new Error('Should not compute'); } }); f.workflow.start('Bounds');
    await assert.rejects(f.workflow.commands.dispatch(ids.dotPlot, analysisJson({ ...f.pair, window: 5 })), /fit every axis/);
    assert.equal(calls, 0); assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  });

  it('rejects known digest topology conflicts but preserves explicit unknown-topology assumptions and uncut controls', async () => {
    const f = await fixture(); f.workflow.start('Topology');
    await assert.rejects(f.workflow.commands.dispatch(ids.digest, analysisJson({ ...f.digest, topology: 'linear' })), /topology conflicts/);
    await f.workflow.commands.dispatch(ids.digest, analysisJson(researchDigestParameters(f.row, { enzymes: [], topology: 'circular' })));
    const record = f.workflow.getSnapshot().result!;
    assert.deepEqual(record.fields.cutSites.value, []); assert.equal(record.parameters.topology, 'circular');
    assert.equal((record.fields.summary.value as { uncutCircular: boolean }).uncutCircular, true);
    f.workflow.commands.stop(); assert.equal((await replayResearchTape(f.workflow.commands.export())).lastAnalysis!.resultId, record.resultId);
  });

  it('distinguishes explicit pairwise self-controls from self plots and does not sort swapped axes', async () => {
    const f = await fixture(); f.workflow.start('Ordered inputs');
    await f.workflow.commands.dispatch(ids.dotPlot, analysisJson({ ...f.pair, comparisonContentId: f.row }));
    assert.equal(f.workflow.getSnapshot().result!.method.id, 'sequence-pairwise-dot-plot');
    assert.equal(f.workflow.getSnapshot().result!.inputs.length, 2);
    await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair)); const forward = f.workflow.getSnapshot().result!;
    await f.workflow.commands.dispatch(ids.dotPlot, analysisJson({ ...f.pair, contentId: f.column, comparisonContentId: f.row }));
    const reversed = f.workflow.getSnapshot().result!;
    assert.notEqual(forward.resultId, reversed.resultId);
    assert.deepEqual(reversed.inputs.map(input => input.data), ['CCAATT', 'AACC']);
    const a = forward.fields.direct.value as number[], b = reversed.fields.direct.value as number[];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.equal(a[i * 3 + j], b[j * 3 + i]);
  });

  it('requires a paired action/executor registration and rejects colliding canonical IDs', async () => {
    const f = await fixture();
    assert.throws(() => new ResearchWorkflow({ ...ids, dotPlot: undefined }, f.environment), /supplied together/);
    assert.throws(() => new ResearchWorkflow(ids, { ...f.environment, digest: undefined }), /supplied together/);
    assert.throws(() => new ResearchWorkflow({ ...ids, digest: ids.dotPlot }, f.environment), /distinct canonical/);
    const legacy = new ResearchWorkflow({ view: ids.view, repeats: ids.repeats, codons: ids.codons },
      { ...f.environment, gcSkew: undefined, dotPlot: undefined, digest: undefined });
    const recorded = await recording(); assert.throws(() => legacy.load(recorded.content), /Step 2.*unsupported action/);
  });

  it('rejects wrong provider inputs, axes, method, settings and checksums before publishing or recording', async () => {
    for (const mode of ['row', 'column', 'swap', 'method', 'source', 'settings', 'hash']) {
      const f = await fixture({ dotPlot: async (genome, comparison, options) => {
        const a = { sequence: mode === 'row' ? 'TTTT' : genome.sequence, accession: genome.phage.accession, source: 'local' as const };
        const b = { sequence: mode === 'column' ? 'AAAAAA' : comparison!.sequence, accession: comparison!.phage.accession, source: 'local' as const };
        if (mode === 'method') return (await createDotPlotExperiment(a, options)).record;
        const record = (await createPairwiseDotPlotExperiment(mode === 'swap' ? b : a, mode === 'swap' ? a : b,
          mode === 'settings' ? { ...options, bins: 2 } : options)).record;
        if (mode === 'hash') record.resultId = '0'.repeat(64);
        return mode === 'source' ? resign(record, r => { r.inputs[1].source = 'catalog'; }) : record;
      } });
      f.workflow.start('Provider integrity');
      await assert.rejects(f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair)));
      assert.equal(f.workflow.getSnapshot().lastAnalysis, null);
      assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
    }
  });

  it('rejects rehashed but changed digest reference definitions before recording', async () => {
    const f = await fixture({ digest: async (genome, options) => resign(await analysis({ type: 'restriction-digest', sequence: genome.sequence,
      options, context: { accession: genome.phage.accession, source: 'local' } }), record => {
      (record.inputs[1].data as { cutOffset: number }[])[0].cutOffset = 2;
    }) });
    f.workflow.start('Definitions');
    await assert.rejects(f.workflow.commands.dispatch(ids.digest, analysisJson(f.digest)), /unchanged catalog/);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 0);
  });

  it('stops at the exact replay step for a forged output or swapped recorded axes', async () => {
    const f = await recording();
    for (const mode of ['output', 'axes']) {
      const tape = parseCommandTape(f.content);
      if (mode === 'output') (tape.commands[2].expected as { resultId: string }).resultId = '0'.repeat(64);
      else { const p = tape.commands[2].parameters as { contentId: string; comparisonContentId: string }; [p.contentId, p.comparisonContentId] = [p.comparisonContentId, p.contentId]; }
      const completed: number[] = [];
      await assert.rejects(replayResearchTape(serializeCommandTape(tape), { onProgress: p => { completed.push(p.completed); } }), /Step 3.*differs/);
      assert.equal(Math.max(...completed), 2);
    }
  });

  it('cannot substitute changed source bases or annotations under a retained content ID', async () => {
    for (const field of ['sequence', 'annotations', 'original']) {
      const f = await recording(), changed = structuredClone(f.genomes);
      if (field === 'sequence') changed[1].sequence = 'AAAAAA';
      else if (field === 'annotations') changed[1].phage.genes.push({ id: 1, name: null, locusTag: null, type: 'CDS', startPos: 0, endPos: 3, strand: '+', product: null });
      else changed[1].original.text += '\n';
      f.replace(changed);
      await assert.rejects(f.workflow.commands.replay(), /changed sequence or annotations/);
      assert.equal(f.workflow.getSnapshot().lastAnalysis!.resultId, f.records.digest.resultId);
    }
  });

  it('rejects a source replaced while the provider is computing, retaining earlier accepted evidence', async () => {
    const started = latch(), release = latch();
    const f = await fixture({ dotPlot: async (genome, comparison, options) => {
      const record = await analysis({ type: 'dot-plot', genome, comparison, options });
      if (comparison) { started.release(); await release.promise; }
      return record;
    } });
    f.workflow.start('Stale source'); await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.self));
    const accepted = f.workflow.getSnapshot().result!;
    const pending = f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
    await started.promise;
    const changed = structuredClone(f.genomes); changed[1].sequence = 'AAAAAA'; f.replace(changed); release.release();
    await assert.rejects(pending, /changed sequence or annotations/);
    assert.equal(f.workflow.getSnapshot().result!.resultId, accepted.resultId);
    assert.equal(f.workflow.commands.getSnapshot().tape.commands.length, 1);
  });

  it('cancels a slow provider promptly and never lets its late result replace a subsequent digest', async () => {
    const started = latch(), release = latch();
    const f = await fixture({ dotPlot: async (genome, comparison, options) => {
      const record = await analysis({ type: 'dot-plot', genome, comparison, options }); started.release(); await release.promise; return record;
    } });
    f.workflow.start('Cancellation');
    const pending = f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise; f.workflow.commands.cancel(); await rejected;
    await f.workflow.commands.dispatch(ids.digest, analysisJson(f.digest));
    const accepted = f.workflow.getSnapshot().lastAnalysis!; release.release();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.deepEqual(f.workflow.getSnapshot().lastAnalysis, accepted);
    assert.deepEqual(f.workflow.commands.getSnapshot().tape.commands.map(command => command.actionId), [ids.digest]);
  });

  it('composes new commands with retained GC-skew and exact-repeat adapters in one native tape', async () => {
    const f = await fixture(); f.workflow.start('Existing and new methods');
    await f.workflow.commands.dispatch(ids.gcSkew, analysisJson({ contentId: f.row, windowSize: 2, stepSize: 2 }));
    await f.workflow.commands.dispatch(ids.repeats, analysisJson({ contentId: f.circle, method: 'exact-pairs', armLength: 4, maxGap: 0, maxPairs: 10 }));
    await f.workflow.commands.dispatch(ids.dotPlot, analysisJson(f.pair));
    await f.workflow.commands.dispatch(ids.digest, analysisJson(f.digest)); f.workflow.commands.stop();
    const native = await replayResearchTape(f.workflow.commands.export());
    assert.deepEqual(native.report.steps.map(step => step.analysis!.method.id), ['sequence-gc-skew', 'exact-repeat-pairs', 'sequence-pairwise-dot-plot', 'restriction-digest']);
    assert.equal(native.report.completed, 4);
    assert.deepEqual(await parseAnalysisRecord(serializeAnalysisRecord(native.lastAnalysis!)), f.workflow.getSnapshot().lastAnalysis);
  });
});
