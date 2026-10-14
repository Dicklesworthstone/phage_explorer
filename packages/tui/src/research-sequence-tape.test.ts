import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { importLocalGenomes, exportLocalGenomeBundle, type LocalGenome } from '../../core/src/genome-import';
import { parseCommandTape, serializeCommandTape, parseCommandPlan, validateCommandPlan, serializeCommandPlan,
  COMMAND_LIMITS, type CommandPlan } from '../../core/src/command-session';
import { createDotPlotExperiment, createPairwiseDotPlotExperiment } from '../../core/src/analysis/dot-plot';
import { ResearchWorkflow, validateResearchDotPlot, validateResearchDigest, researchDigestParameters,
  type ResearchEnvironment, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { executeResearchRequest, type ResearchWorkerRequest } from '../../web/src/workers/research-workflow.worker';
import { inspectResearchTape, replayResearchTape, recordResearchPlan } from './research-replay';
import { executeTerminalResearchRequest, validateTerminalResearchRequest, type TerminalResearchResult } from './research-replay.worker';
import { researchWorkflowMain, parseWorkflowCommand, runTerminalResearchWorker, type TerminalWorker } from '../../../scripts/research-workflow';
import { createHash } from 'node:crypto';

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

  it('cancels a mixed native replay between analyses without a success report or partial output', async () => {
    const f = await recording(), directory = await mkdtemp(join(tmpdir(), 'mixed-sequence-cancel-'));
    const input = join(directory, 'workflow.json'), output = join(directory, 'analysis.json');
    await writeFile(input, f.content, { flag: 'wx' });
    const controller = new AbortController(), completed: number[] = [];
    let stdout = '', stderr = '';
    const code = await researchWorkflowMain(['replay', '--input', input, '--output', output], text => { stdout += text; }, text => { stderr += text; }, {
      signal: controller.signal,
      onProgress: progress => {
        completed.push(progress.completed);
        if (progress.completed === 2) controller.abort(new DOMException('Cancel after the self plot', 'AbortError'));
      },
    });
    assert.equal(code, 130, stderr); assert.equal(stdout, '');
    assert.equal(completed.at(-1), 2); await assert.rejects(stat(output), { code: 'ENOENT' });
    const fresh = await replayResearchTape(f.content); assert.equal(fresh.report.completed, 5);
  });

  it('pauses mixed replay at a verified step and resumes without duplicating that command', async () => {
    const f = await recording();
    f.workflow.load(f.content);
    const paused = new Promise<void>(resolve => {
      const unsubscribe = f.workflow.commands.subscribe(() => {
        if (f.workflow.commands.getSnapshot().completed !== 2) return;
        unsubscribe(); f.workflow.commands.pause(); resolve();
      });
    });
    const task = f.workflow.commands.replay();
    await paused;
    assert.equal(f.workflow.commands.getSnapshot().mode, 'paused');
    assert.equal(f.workflow.getSnapshot().result!.resultId, f.records.self.resultId);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.workflow.commands.getSnapshot().completed, 2);
    f.workflow.commands.resume(); await task;
    assert.equal(f.workflow.commands.getSnapshot().completed, 5);
    assert.equal(f.workflow.getSnapshot().lastAnalysis!.resultId, f.records.digest.resultId);
    assert.equal(f.workflow.commands.export(), f.content);
  });
});

async function plannedFixture() {
  const f = await fixture();
  const plan: CommandPlan = { format: 'phage-explorer-command-plan', version: 1, name: 'Native mixed experiment',
    context: { bundle: exportLocalGenomeBundle(f.genomes) }, commands: [
      { actionId: ids.view, parameters: analysisJson(f.navigation) },
      { actionId: ids.gcSkew, parameters: { contentId: f.row, windowSize: 2, stepSize: 2 } },
      { actionId: ids.dotPlot, parameters: analysisJson(f.pair) },
      { actionId: ids.digest, parameters: analysisJson(f.digest) },
      { actionId: ids.view, parameters: analysisJson({ ...f.navigation, scrollPosition: 1 }) },
    ] };
  return { ...f, plan, content: serializeCommandPlan(plan) };
}
const textSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Transport-only negative fixture; the positive path below uses OS threads. */
class PlanReplyWorker extends EventEmitter {
  terminations = 0;
  constructor(private readonly reply: TerminalResearchResult, private readonly total: number, private readonly sendProgress = true) { super(); }
  postMessage() {
    queueMicrotask(() => {
      if (this.sendProgress) for (let completed = 0; completed <= this.total; completed++) {
        this.emit('message', { type: 'progress', progress: { phase: 'commands', completed, total: this.total, actionId: null } });
      }
      this.emit('message', this.reply);
    });
  }
  terminate() { this.terminations++; return Promise.resolve(0); }
}

describe('headless planned research recording', () => {
  it('round-trips bounded plans and snapshots parameters without accepting recorded expectations', async () => {
    const f = await plannedFixture();
    assert.deepEqual(parseCommandPlan(f.content), f.plan);
    const copy = validateCommandPlan(f.plan);
    (f.plan.commands[0].parameters as { scrollPosition: number }).scrollPosition = 3;
    assert.equal((copy.commands[0].parameters as { scrollPosition: number }).scrollPosition, 0);
    assert.equal(serializeCommandPlan(copy), f.content);
    for (const value of [
      { ...copy, format: 'phage-explorer-commands' }, { ...copy, version: 2 }, { ...copy, name: 'invalid\nname' },
      { ...copy, commands: [{ ...copy.commands[0], expected: null }] },
      { ...copy, commands: [{ ...copy.commands[0], run: 'shell' }] },
      { ...copy, commands: [{ actionId: 'not/an/action', parameters: null }] },
      { ...copy, commands: Array.from({ length: 129 }, () => copy.commands[0]) },
      { ...copy, commands: [null] },
    ]) assert.throws(() => validateCommandPlan(value));
    assert.throws(() => parseCommandTape(f.content), /format/);
    let nested: unknown = null; for (let i = 0; i < 50; i++) nested = { nested };
    assert.throws(() => validateCommandPlan({ ...copy, context: nested }), /nesting/);
    assert.throws(() => parseCommandPlan('α'.repeat(COMMAND_LIMITS.bytes / 2 + 1)), /10 MiB/);
  });

  it('authors the exact same tape as explicit browser-style dispatch and replays every computed output', async () => {
    const f = await plannedFixture(), progress: number[] = [];
    const made = await recordResearchPlan(f.content, { onProgress: p => progress.push(p.completed) });
    f.workflow.start(f.plan.name);
    for (const command of f.plan.commands) await f.workflow.commands.dispatch(command.actionId, command.parameters);
    f.workflow.commands.stop();
    assert.equal(made.tapeJson, f.workflow.commands.export());
    assert.deepEqual(progress, [0, 0, 1, 2, 3, 4, 5]);
    assert.equal(made.report.planSha256, textSha(f.content)); assert.equal(made.report.tapeSha256, textSha(made.tapeJson));
    assert.equal(made.report.lastAnalysisExecution, 4); assert.equal(made.report.completed, 5);
    assert(!('verified' in made.report)); assert(!JSON.stringify(made.report).includes('GAATTCAA'));
    const replay = await replayResearchTape(made.tapeJson, { repetitions: 2 });
    assert.equal(replay.report.completed, 10); assert.equal(replay.report.lastAnalysisExecution, 9);
    assert.equal(replay.lastAnalysis!.resultId, made.report.steps[3].analysis!.resultId);
    assert.deepEqual(replay.lastAnalysis!.fields.cutSites.value, [1]);
    assert.deepEqual(replay.lastAnalysis!.fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
    assert.deepEqual(replay.report.finalView, { ...f.navigation, scrollPosition: 1 });
  });

  it('rejects whole recorded tapes rather than regenerating failed expected outputs', async () => {
    const f = await plannedFixture(), made = await recordResearchPlan(f.content), tape = parseCommandTape(made.tapeJson);
    (tape.commands[2].expected as { resultId: string }).resultId = '0'.repeat(64);
    const failed = serializeCommandTape(tape);
    await assert.rejects(recordResearchPlan(failed), /recorded tapes must use replay/);
    await assert.rejects(recordResearchPlan(JSON.stringify({ ...tape, format: 'phage-explorer-command-plan' })), /Unsupported command fields/);
    await assert.rejects(replayResearchTape(failed), /Step 3.*differs/);
    assert.equal(serializeCommandTape(tape), failed);
  });

  it('validates invalid later actions and parameters before parsing any bundle or computing earlier steps', async () => {
    const f = await plannedFixture();
    for (const change of [
      (p: CommandPlan) => { p.commands[3].actionId = 'process.exec'; },
      (p: CommandPlan) => { p.commands[2].parameters = { ...f.pair, bins: 0 }; },
      (p: CommandPlan) => { p.commands[3].parameters = { ...f.digest, topology: 'unknown' }; },
      (p: CommandPlan) => { p.commands.push({ actionId: ids.repeats, parameters: { contentId: f.row, minLength: 8, maxGap: 0 } }); },
    ]) {
      const plan = structuredClone(f.plan); change(plan); plan.context = { bundle: 'not even JSON' };
      let calls = 0;
      await assert.rejects(recordResearchPlan(serializeCommandPlan(plan), { onProgress: () => { calls++; } }), /Step [3456]/);
      assert.equal(calls, 0);
    }
  });

  it('refuses empty plans, implicit paths and inputs whose content identities changed', async () => {
    const f = await plannedFixture();
    await assert.rejects(recordResearchPlan(serializeCommandPlan({ ...f.plan, commands: [] })), /no planned commands/);
    await assert.rejects(recordResearchPlan(serializeCommandPlan({ ...f.plan, context: { path: '/private/never-read.fa' } })), /exactly.*embedded/);
    const changed = structuredClone(f.plan), context = changed.context as { bundle: string }, bundle = JSON.parse(context.bundle);
    bundle.inputs[0].text = bundle.inputs[0].text.replace('AACC', 'TTTT'); context.bundle = JSON.stringify(bundle);
    await assert.rejects(recordResearchPlan(serializeCommandPlan(changed)), /Step 1.*outside/);
  });

  it('reports a runtime failure at the exact planned step and never returns a partial tape', async () => {
    const f = await plannedFixture(); (f.plan.commands[2].parameters as { window: number }).window = 5;
    const completed: number[] = [];
    await assert.rejects(recordResearchPlan(serializeCommandPlan(f.plan), { onProgress: p => completed.push(p.completed) }), /Step 3.*fit every axis/);
    assert.deepEqual(completed, [0, 0, 1, 2]);
  });

  it('supports navigation-only plans with no invented analysis and preserves explicit repeated commands', async () => {
    const f = await plannedFixture(); f.plan.commands = [f.plan.commands[0], f.plan.commands[0], f.plan.commands[4]];
    const made = await recordResearchPlan(serializeCommandPlan(f.plan));
    assert.equal(made.report.completed, 3); assert.equal(made.report.lastAnalysisExecution, null);
    assert(made.report.steps.every(step => step.analysis === null));
    assert.equal(parseCommandTape(made.tapeJson).commands.length, 3);
    assert.equal((await replayResearchTape(made.tapeJson)).lastAnalysis, null);
  });

  it('cancels between recorded steps, rejects pre-aborted work and allows a clean subsequent recording', async () => {
    const f = await plannedFixture(), controller = new AbortController(), completed: number[] = [];
    await assert.rejects(recordResearchPlan(f.content, { signal: controller.signal, onProgress: p => {
      completed.push(p.completed); if (p.completed === 2) controller.abort();
    } }), { name: 'AbortError' });
    assert.deepEqual(completed, [0, 0, 1, 2]);
    await assert.rejects(recordResearchPlan(f.content, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal((await recordResearchPlan(f.content)).report.completed, 5);
  });

  it('parses a distinct CLI authoring operation with required output and no replay or analysis flags', () => {
    assert.deepEqual(parseWorkflowCommand(['record', '--input', 'plan.json', '--output', 'tape.json', '--progress']), {
      type: 'record', input: 'plan.json', output: 'tape.json', timeoutMs: 300000, progress: true,
    });
    for (const args of [[], ['--format', 'json'], ['--repetitions', '2'], ['--method', 'gc-skew'], ['--output', 'x', '--output', 'y'],
      ['--progress', '--progress'], ['--timeout-ms', '0'], ['--force']]) {
      const base = args.length ? ['--output', 'tape.json'] : [];
      assert.throws(() => parseWorkflowCommand(['record', '--input', 'plan.json', ...base, ...args]));
    }
    validateTerminalResearchRequest({ type: 'record', content: '{}' });
    assert.throws(() => validateTerminalResearchRequest({ type: 'record', content: '{}', output: '/must-not-cross-boundary' }));
    assert.throws(() => validateTerminalResearchRequest({ type: 'record', content: '{}', repetitions: 2 }));
  });

  it('records through a real OS worker, creates a private tape, then replays the unchanged tape through the CLI', async () => {
    const f = await plannedFixture(), directory = await mkdtemp(join(tmpdir(), 'phage-plan-cli-'));
    const input = join(directory, 'plan.json'), output = join(directory, 'workflow.json'), analysis = join(directory, 'analysis.json');
    await writeFile(input, f.content, { flag: 'wx' });
    let stdout = '', stderr = '';
    const code = await researchWorkflowMain(['record', '--input', input, '--output', output, '--progress'],
      text => { stdout += text; }, text => { stderr += text; });
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout), tapeJson = await readFile(output, 'utf8');
    assert.equal(report.completed, 5); assert.equal(report.tapeSha256, textSha(tapeJson));
    assert.equal(report.lastAnalysisExecution, 4); assert(!('verified' in report));
    assert.equal(await readFile(input, 'utf8'), f.content);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert(!stdout.includes('GAATTCAA')); assert(!stderr.includes('GAATTCAA'));
    assert.deepEqual(stderr.trim().split('\n').map(line => JSON.parse(line).completed), [0, 0, 1, 2, 3, 4, 5]);
    let replayReport = '';
    assert.equal(await researchWorkflowMain(['replay', '--input', output, '--output', analysis], text => { replayReport += text; }, text => { stderr += text; }), 0, stderr);
    const record = await parseAnalysisRecord(await readFile(analysis, 'utf8'));
    assert.equal(record.resultId, report.steps[3].analysis.resultId);
    assert.equal(JSON.parse(replayReport).verified, true);
    assert.equal(await readFile(output, 'utf8'), tapeJson);
    for (const existing of [input, output]) {
      const before = await readFile(existing, 'utf8');
      assert.equal(await researchWorkflowMain(['record', '--input', input, '--output', existing], () => assert.fail('No success'), () => {}), 1);
      assert.equal(await readFile(existing, 'utf8'), before);
    }
  });

  it('does not create an output or success report on real worker failure or cancellation', async () => {
    const f = await plannedFixture(), directory = await mkdtemp(join(tmpdir(), 'phage-plan-failure-'));
    const input = join(directory, 'plan.json'), output = join(directory, 'workflow.json');
    const bad = structuredClone(f.plan); (bad.commands[2].parameters as { window: number }).window = 5;
    await writeFile(input, serializeCommandPlan(bad), { flag: 'wx' });
    let stderr = '';
    assert.equal(await researchWorkflowMain(['record', '--input', input, '--output', output], () => assert.fail('No success'), text => { stderr += text; }), 1);
    assert.match(stderr, /Step 3/); await assert.rejects(stat(output), { code: 'ENOENT' });
    const good = join(directory, 'good.json'); await writeFile(good, f.content, { flag: 'wx' });
    const controller = new AbortController();
    const code = await researchWorkflowMain(['record', '--input', good, '--output', output], () => assert.fail('No success'), () => {}, {
      signal: controller.signal, onProgress: p => { if (p.completed === 1) controller.abort(new DOMException('Stop after navigation', 'AbortError')); },
    });
    assert.equal(code, 130); await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(await readFile(good, 'utf8'), f.content);
  });

  it('rejects mismatched authored tapes and inconsistent reports before settling the worker boundary', async () => {
    const f = await plannedFixture(), request = { type: 'record' as const, content: f.content };
    const valid = await executeTerminalResearchRequest(request); assert(valid.type === 'recorded');
    for (const change of [
      (r: typeof valid) => { r.report.planSha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.report.tapeSha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.report.lastAnalysisExecution = 5; },
      (r: typeof valid) => { r.report.steps[2].analysis!.resultId = '0'.repeat(64); },
      (r: typeof valid) => { r.report.finalView = null; },
      (r: typeof valid) => { Object.assign(r.report, { verified: true }); },
      (r: typeof valid) => { const tape = parseCommandTape(r.tapeJson); tape.name = 'other'; r.tapeJson = serializeCommandTape(tape); r.report.tapeSha256 = textSha(r.tapeJson); },
      (r: typeof valid) => { const tape = parseCommandTape(r.tapeJson); tape.context = { bundle: '{}' }; r.tapeJson = serializeCommandTape(tape); r.report.tapeSha256 = textSha(r.tapeJson); },
      (r: typeof valid) => { const tape = parseCommandTape(r.tapeJson); (tape.commands[2].parameters as { bins: number }).bins = 2; r.tapeJson = serializeCommandTape(tape); r.report.tapeSha256 = textSha(r.tapeJson); },
    ]) {
      const bad = structuredClone(valid); change(bad);
      const worker = new PlanReplyWorker(bad, 5);
      await assert.rejects(runTerminalResearchWorker(request, new AbortController().signal, undefined, () => worker as unknown as TerminalWorker), /Unexpected/);
      assert.equal(worker.terminations, 1);
    }
    const noProgress = new PlanReplyWorker(valid, 5, false);
    await assert.rejects(runTerminalResearchWorker(request, new AbortController().signal, undefined, () => noProgress as unknown as TerminalWorker), /Unexpected/);
    assert.equal(noProgress.terminations, 1);
  });

  it('keeps planned inputs immutable when progress callbacks fail and documents the distinction from verification', async () => {
    const f = await plannedFixture();
    await assert.rejects(recordResearchPlan(f.content, { onProgress: p => { if (p.completed === 2) throw new Error('Consumer stopped'); } }), /Consumer stopped/);
    assert.equal(serializeCommandPlan(f.plan), f.content);
    let help = '';
    assert.equal(await researchWorkflowMain(['--help'], text => { help += text; }, () => {}), 0);
    assert.match(help, /workflow record --input plan.json/); assert.match(help, /Recorded tapes cannot be used as plans/);
    assert.match(help, /fresh authoring, not replay verification/);
  });

  it('fails instead of publishing an over-limit tape when computed expectations outgrow a valid plan', async () => {
    const f = await plannedFixture();
    f.plan.commands = Array.from({ length: 8 }, () => structuredClone(f.plan.commands[0]));
    const bundle = { format: 'phage-explorer-local-genomes', version: 1, inputs: [{ name: 'original.fa', text: source }] };
    f.plan.context = { bundle: JSON.stringify(bundle) };
    const initialBytes = new TextEncoder().encode(serializeCommandPlan(f.plan)).length;
    // Valid formatting in the retained original source, not additional bases.
    // Leave enough room for envelope validation but not eight computed outputs.
    bundle.inputs[0].text += ' '.repeat(COMMAND_LIMITS.bytes - 1300 - initialBytes);
    f.plan.context = { bundle: JSON.stringify(bundle) };
    const content = serializeCommandPlan(f.plan), completed: number[] = [];
    assert.equal(new TextEncoder().encode(content).length, COMMAND_LIMITS.bytes - 1300);
    await assert.rejects(recordResearchPlan(content, { onProgress: p => completed.push(p.completed) }), /Step .*10 MiB/);
    assert(completed.at(-1)! > 0 && completed.at(-1)! < 8);
  });

  it('terminates an unresponsive recording worker on timeout without creating a tape', async () => {
    const f = await plannedFixture(), directory = await mkdtemp(join(tmpdir(), 'phage-plan-timeout-'));
    const input = join(directory, 'plan.json'), output = join(directory, 'workflow.json');
    await writeFile(input, f.content, { flag: 'wx' });
    let exited: Promise<number> | null = null;
    const code = await researchWorkflowMain(['record', '--input', input, '--output', output, '--timeout-ms', '1000'],
      () => assert.fail('No success report'), () => {}, { createWorker: () => {
        const worker = new Worker('for (;;) {}', { eval: true });
        exited = new Promise(resolve => worker.once('exit', resolve)); return worker;
      } });
    assert.equal(code, 124); assert(exited); await exited;
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(await readFile(input, 'utf8'), f.content);
  });
});
