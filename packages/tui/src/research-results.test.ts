import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { analysisJson, createAnalysisRecord } from '../../core/src/analysis-result';
import { serializeCommandPlan, parseCommandTape, serializeCommandTape, COMMAND_LIMITS } from '../../core/src/command-session';
import { parseWorkflowResults, workflowAnalysisAt, workflowResultIndex, WORKFLOW_RESULTS_LIMITS } from '../../core/src/workflow-results';
import { recordResearchPlan } from './research-replay';
import { executeTerminalResearchRequest, validateTerminalResearchRequest, type TerminalResearchMessage,
  type TerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type WorkflowRuntime, type TerminalWorker } from '../../../scripts/research-workflow';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function fixture() {
  const { genomes } = await importLocalGenomes({ name: 'literal.fa', text: '>row\nAACC\n>column\nCCAATT\n>circle [topology=circular]\nGAATTCAA\n' });
  const [row, column, circle] = genomes.map(g => g.phage.localGenome!.contentId);
  const planJson = serializeCommandPlan({ format: 'phage-explorer-command-plan', version: 1,
    name: 'Synthetic comparison and digest', context: { bundle: exportLocalGenomeBundle(genomes) },
    commands: [
      { actionId: 'overlay.dotPlot', parameters: { contentId: row, comparisonContentId: null, bins: 2, window: 2 } },
      { actionId: 'overlay.dotPlot', parameters: { contentId: row, comparisonContentId: column, bins: 3, window: 2 } },
      { actionId: 'overlay.gel', parameters: { contentId: circle, enzymes: ['EcoRI'], topology: 'circular' } },
      { actionId: 'nav.goto', parameters: { contentId: row, geneId: null, viewMode: 'dna', readingFrame: 0, scrollPosition: 1 } },
    ] });
  const recorded = await recordResearchPlan(planJson, { captureResults: true });
  return { planJson, tapeJson: recorded.tapeJson, archiveJson: recorded.allResultsJson! };
}
async function invoke(args: string[], runtime: WorkflowRuntime = {}) {
  let stdout = '', stderr = '';
  const code = await researchWorkflowMain(args, text => { stdout += text; }, text => { stderr += text; }, runtime);
  return { code, stdout, stderr };
}
class ReplyWorker extends EventEmitter {
  terminated = 0;
  constructor(private readonly respond: (request: TerminalResearchRequest, send: (message: TerminalResearchMessage) => void) => Promise<void>) { super(); }
  postMessage(request: TerminalResearchRequest) {
    void this.respond(request, value => this.emit('message', value)).then(() => this.emit('exit', 0), cause => this.emit('error', cause));
  }
  async terminate() { this.terminated++; return 0; }
}

describe('complete workflow results in the terminal', () => {
  it('makes complete capture explicit and never changes legacy defaults or saved repetitions', () => {
    assert.deepEqual(parseWorkflowCommand(['record', '--input', 'plan', '--output', 'out']),
      { type: 'record', input: 'plan', output: 'out', timeoutMs: 300000, progress: false });
    assert.equal((parseWorkflowCommand(['replay', '--input', 'tape', '--results', '--output', 'out']) as { allResults: boolean }).allResults, true);
    assert.equal(parseWorkflowCommand(['replay-results', '--input', 'archive', '--progress']).type, 'replay-results');
    for (const args of [ ['replay', '--input', 'tape', '--results'], ['record', '--input', 'plan', '--output', 'out', '--results', '--results'],
      ['replay-results', '--input', 'archive', '--repetitions', '2'], ['replay-results', '--input', 'archive', '--format', 'tsv'],
      ['inspect', '--input', 'tape', '--results'] ]) assert.throws(() => parseWorkflowCommand(args));
    assert.throws(() => validateTerminalResearchRequest({ type: 'record', content: '{}', captureResults: 'yes' }));
    assert.throws(() => validateTerminalResearchRequest({ type: 'replay', content: '{}', repetitions: 1, exportAnalysis: true, captureResults: true }));
    assert.throws(() => validateTerminalResearchRequest({ type: 'replay-results', content: '{}', repetitions: 2 }));
  });

  it('captures all literal matrices and circular fragments, then verifies the exact saved tape', async () => {
    const f = await fixture();
    const result = await executeTerminalResearchRequest({ type: 'record', content: f.planJson, captureResults: true });
    assert.equal(result.type, 'recorded'); if (result.type !== 'recorded') throw new Error('No recording');
    const archive = await parseWorkflowResults(result.allResultsJson!);
    assert.equal(archive.tapeJson, f.tapeJson); assert.equal(archive.records.length, 3);
    assert.deepEqual(workflowAnalysisAt(archive, 1).fields.direct.value, [1, 0, 0, 1]);
    assert.deepEqual(workflowAnalysisAt(archive, 2).fields.direct.value, [0, 1, 0, .5, .5, 0, 1, 0, 0]);
    assert.deepEqual(workflowAnalysisAt(archive, 3).fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
    assert.throws(() => workflowAnalysisAt(archive, 4), /navigation/);
    const replay = await executeTerminalResearchRequest({ type: 'replay-results', content: result.allResultsJson! });
    assert.equal(replay.type, 'results-replayed'); if (replay.type !== 'results-replayed') throw new Error('No replay');
    assert.equal(replay.archiveJson, result.allResultsJson); assert.equal(replay.inputArchiveSha256, hash(result.allResultsJson!));
    assert.equal(replay.report.lastAnalysisExecution, 3);
  });

  it('round-trips native archives through the real browser workflow adapter and back through a native worker', async () => {
    const f = await fixture(), bundle = JSON.parse(f.planJson).context.bundle;
    const parsed = await importLocalGenomes({ name: 'reviewed-bundle.json', text: bundle });
    const { ResearchWorkflow } = await import('../../web/src/keyboard/ResearchWorkflow');
    const { executeResearchRequest } = await import('../../web/src/workers/research-workflow.worker');
    const computed = async (request: Parameters<typeof executeResearchRequest>[0]) => {
      const result = await executeResearchRequest(request);
      if (result.type !== 'analysis') throw new Error('Expected browser worker evidence');
      return result.record;
    };
    let view: import('../../web/src/keyboard/ResearchWorkflow').ResearchView | null = null;
    const browser = new ResearchWorkflow({ view: 'nav.goto', repeats: 'overlay.repeats', codons: 'overlay.codonAdaptation',
      dotPlot: 'overlay.dotPlot', digest: 'overlay.gel' }, {
      genomes: () => parsed.genomes, bundle: () => bundle,
      parseBundle: text => importLocalGenomes({ name: 'browser-review.json', text }), currentView: () => view,
      applyView: async next => { view = structuredClone(next); },
      repeats: async () => { throw new Error('Unrequested method'); }, codons: async () => { throw new Error('Unrequested method'); },
      dotPlot: (genome, comparison, options) => computed({ type: 'dot-plot', genome, comparison, options }),
      digest: (genome, options) => computed({ type: 'restriction-digest', sequence: genome.sequence, options,
        context: { accession: genome.phage.accession, source: 'local' } }),
    });
    await browser.loadResultsAndReview(f.archiveJson, new AbortController().signal);
    const restored = await browser.verifyCompleteResults(f.archiveJson);
    assert.equal(restored, f.archiveJson);
    const native = await runTerminalResearchWorker({ type: 'replay-results', content: restored }, new AbortController().signal);
    assert.equal(native.type, 'results-replayed'); if (native.type !== 'results-replayed') throw new Error('No replay');
    assert.equal(native.archiveJson, browser.exportCompleteResults());
  });

  it('records and replays complete private outputs through real OS workers and exclusive files', async () => {
    const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'phage-all-results-'));
    const plan = join(dir, 'plan.json'), output = join(dir, 'complete.json'), verified = join(dir, 'verified.json');
    await writeFile(plan, f.planJson);
    const recording = await invoke(['record', '--input', plan, '--output', output, '--results', '--progress']);
    assert.equal(recording.code, 0, recording.stderr); assert(!('verified' in JSON.parse(recording.stdout)));
    assert.equal(JSON.parse(recording.stdout).outputKind, 'complete-workflow-results');
    const text = await readFile(output, 'utf8'); assert.equal(text, f.archiveJson);
    const replay = await invoke(['replay-results', '--input', output, '--output', verified, '--progress']);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).verified, true);
    assert.equal(await readFile(verified, 'utf8'), text); assert.equal(await readFile(plan, 'utf8'), f.planJson);
    assert(!replay.stdout.includes('GAATTCAA')); assert(!replay.stderr.includes('GAATTCAA'));
    assert(replay.stderr.includes('"completed":4'));
    if (process.platform !== 'win32') assert.equal((await stat(verified)).mode & 0o777, 0o600);
    assert.equal((await invoke(['replay-results', '--input', output, '--output', output])).code, 1);
    const link = join(dir, 'existing-link'); await symlink(output, link);
    assert.equal((await invoke(['replay-results', '--input', output, '--output', link])).code, 1);
    assert.equal(await readFile(output, 'utf8'), text);
  });

  it('captures repeated executions once per result without changing default last-analysis replay', async () => {
    const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'phage-repeat-results-'));
    const input = join(dir, 'tape.json'), output = join(dir, 'all.json'), last = join(dir, 'last.json'); await writeFile(input, f.tapeJson);
    const run = await invoke(['replay', '--input', input, '--repetitions', '2', '--results', '--output', output]);
    assert.equal(run.code, 0, run.stderr); const archive = await parseWorkflowResults(await readFile(output, 'utf8'));
    assert.equal(archive.records.length, 3); assert.equal(archive.repetitions, 2);
    assert.deepEqual(workflowResultIndex(archive.tapeJson, 2).map(e => [e.execution, e.step, e.analysis !== null]),
      [[1,1,true],[2,2,true],[3,3,true],[4,4,false],[5,1,true],[6,2,true],[7,3,true],[8,4,false]]);
    const replay = await invoke(['replay-results', '--input', output]);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).completed, 8);
    assert.equal(JSON.parse(replay.stdout).lastAnalysisExecution, 7);
    assert.equal((await invoke(['replay', '--input', input, '--output', last])).code, 0);
    assert.equal(JSON.parse(await readFile(last, 'utf8')).resultId, archive.records[2].resultId);
  });

  it('allows navigation-only complete archives without inventing a last analysis', async () => {
    const f = await fixture(), plan = JSON.parse(f.planJson); plan.commands = [plan.commands[3]];
    const record = await executeTerminalResearchRequest({ type: 'record', content: JSON.stringify(plan), captureResults: true });
    assert.equal(record.type, 'recorded'); if (record.type !== 'recorded') throw new Error('No recording');
    assert.deepEqual((await parseWorkflowResults(record.allResultsJson!)).records, []);
    const result = await runTerminalResearchWorker({ type: 'replay-results', content: record.allResultsJson! }, new AbortController().signal);
    assert.equal(result.type, 'results-replayed'); if (result.type !== 'results-replayed') throw new Error('No replay');
    assert.equal(result.report.lastAnalysisExecution, null); assert.equal(result.report.completed, 1);
    await assert.rejects(executeTerminalResearchRequest({ type: 'replay', content: record.tapeJson, repetitions: 1, exportAnalysis: true }), /no analysis/);
  });

  it('rejects an earlier false numerical result even when archive and tape hashes agree', async () => {
    const f = await fixture(), archive = await parseWorkflowResults(f.archiveJson), old = archive.records[0];
    const fields = structuredClone(old.fields); fields.direct.value = [0, 0, 0, 0];
    const forged = await createAnalysisRecord({ ...old, fields, inputs: old.inputs });
    archive.records[0] = forged;
    const tape = parseCommandTape(archive.tapeJson); tape.commands[0].expected = analysisJson({ method: forged.method, cacheKey: forged.cacheKey, resultId: forged.resultId });
    archive.tapeJson = serializeCommandTape(tape); const content = JSON.stringify(archive);
    await parseWorkflowResults(content); // Integrity is deliberately self-consistent; numerical replay must still fail.
    const dir = await mkdtemp(join(tmpdir(), 'phage-forged-results-')), input = join(dir, 'false.json'), output = join(dir, 'absent.json');
    await writeFile(input, content);
    const result = await invoke(['replay-results', '--input', input, '--output', output]);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /Step 1.*differs/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });

  it('rejects missing records and archive schema changes before allocating a worker', async () => {
    const f = await fixture(); let workers = 0;
    for (const change of [{ records: [] }, { repetitions: 11 }, { verified: true }]) {
      const content = JSON.stringify({ ...JSON.parse(f.archiveJson), ...change });
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-results', content }, new AbortController().signal,
        () => {}, () => { workers++; throw new Error('Must not allocate'); }));
    }
    assert.equal(workers, 0);
  });

  it('checks all returned records, tape bindings and reported execution identities', async () => {
    const f = await fixture();
    for (const mode of ['missing', 'wrong-tape', 'report', 'last', 'hash', 'good']) {
      let worker!: ReplyWorker;
      const create = () => (worker = new ReplyWorker(async (request, send) => {
        const result = await executeTerminalResearchRequest(request, progress => send({ type: 'progress', progress }));
        if (result.type !== 'replayed') throw new Error('Expected replay');
        const archive = JSON.parse(result.allResultsJson!);
        if (mode === 'missing') archive.records.pop();
        if (mode === 'wrong-tape') archive.tapeJson += '\n';
        if (mode === 'report') result.report.steps[0].analysis = result.report.steps[1].analysis;
        if (mode === 'last') result.report.lastAnalysisExecution = 4;
        if (mode === 'hash') archive.records[0].fields.direct.value[0] = 0;
        result.allResultsJson = JSON.stringify(archive); send(result);
      })) as unknown as TerminalWorker;
      const pending = runTerminalResearchWorker({ type: 'replay', content: f.tapeJson, repetitions: 1, exportAnalysis: false, captureResults: true }, new AbortController().signal, () => {}, create);
      if (mode === 'good') assert.equal((await pending).type, 'replayed'); else await assert.rejects(pending);
      assert.equal(worker.terminated, 1);
    }
  });

  it('uses the separate 32 MiB archive envelope without increasing tape input limits', async () => {
    const f = await fixture(), content = f.archiveJson + ' '.repeat(COMMAND_LIMITS.bytes);
    validateTerminalResearchRequest({ type: 'replay-results', content });
    assert.throws(() => validateTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' }), /10 MiB/);
    assert.throws(() => validateTerminalResearchRequest({ type: 'replay-results', content: 'é'.repeat(WORKFLOW_RESULTS_LIMITS.bytes / 2 + 1) }), /32 MiB/);
    const dir = await mkdtemp(join(tmpdir(), 'phage-large-archive-')), input = join(dir, 'large.json'); await writeFile(input, content);
    const run = await invoke(['replay-results', '--input', input]); assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).inputArchiveSha256, hash(content));
  });

  it('rejects invalid UTF-8 and oversized regular files before starting computation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-invalid-archive-')); let workers = 0;
    const createWorker = () => { workers++; throw new Error('Must not allocate'); };
    const invalid = join(dir, 'utf8.json'); await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    assert.equal((await invoke(['replay-results', '--input', invalid], { createWorker })).code, 1);
    const huge = join(dir, 'huge.json'); await writeFile(huge, ' '.repeat(WORKFLOW_RESULTS_LIMITS.bytes + 1));
    const result = await invoke(['replay-results', '--input', huge], { createWorker });
    assert.equal(result.code, 1); assert.match(result.stderr, /32 MiB/); assert.equal(workers, 0);
  });

  it('cancels an in-progress archive replay without success output, then permits a clean retry', async () => {
    const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'phage-cancel-archive-')), input = join(dir, 'input.json'), output = join(dir, 'output.json');
    await writeFile(input, f.archiveJson); const controller = new AbortController();
    const interrupted = await invoke(['replay-results', '--input', input, '--output', output], { signal: controller.signal,
      onProgress: p => { if (p.completed === 1) controller.abort(); } });
    assert.equal(interrupted.code, 130); assert.equal(interrupted.stdout, ''); await assert.rejects(stat(output), { code: 'ENOENT' });
    const retry = await invoke(['replay-results', '--input', input, '--output', output]); assert.equal(retry.code, 0, retry.stderr);
  });

  it('hard-terminates stuck archive workers on timeout and preserves timeout classification in preflight', async () => {
    const f = await fixture(), dir = await mkdtemp(join(tmpdir(), 'phage-archive-timeout-')), input = join(dir, 'input.json'), output = join(dir, 'output.json');
    await writeFile(input, f.archiveJson); let worker!: Worker;
    const result = await invoke(['replay-results', '--input', input, '--output', output, '--timeout-ms', '100'], {
      createWorker: () => { worker = new Worker(new URL('data:text/javascript,while(true){}')); return worker; },
    });
    assert.equal(result.code, 124, result.stderr); assert.equal(result.stdout, ''); await assert.rejects(stat(output), { code: 'ENOENT' });
    if (worker.threadId !== -1) await new Promise(resolve => worker.once('exit', resolve));
    assert.equal(worker.threadId, -1);
    const controller = new AbortController();
    const pending = runTerminalResearchWorker({ type: 'replay-results', content: f.archiveJson }, controller.signal,
      () => {}, () => { throw new Error('Must not allocate after timeout'); });
    controller.abort(new DOMException('Preflight timed out.', 'TimeoutError'));
    await assert.rejects(pending, { name: 'TimeoutError' });
  });
});

describe('inspect and extract stored workflow analyses', () => {
  it('requires an explicit execution and a new output path rather than guessing a last result', () => {
    assert.deepEqual(parseWorkflowCommand(['extract-result', '--input', 'archive', '--execution', '2', '--output', 'result']),
      { type: 'extract-result', input: 'archive', execution: 2, output: 'result', timeoutMs: 300000 });
    assert.equal(parseWorkflowCommand(['inspect-results', '--input', 'archive']).type, 'inspect-results');
    for (const args of [ ['extract-result', '--input', 'archive', '--output', 'result'],
      ['extract-result', '--input', 'archive', '--execution', '2'], ['extract-result', '--input', 'archive', '--execution', '0', '--output', 'result'],
      ['extract-result', '--input', 'archive', '--execution', '257', '--output', 'result'],
      ['inspect-results', '--input', 'archive', '--progress'], ['inspect-results', '--input', 'archive', '--output', 'result'],
      ['extract-result', '--input', 'archive', '--execution', '1.5', '--output', 'result'] ]) assert.throws(() => parseWorkflowCommand(args));
    for (const execution of [0, -1, 257, 1.5, NaN]) assert.throws(() => validateTerminalResearchRequest({ type: 'extract-result', content: '{}', execution }));
  });

  it('lists each repeated execution without exposing source bases or claiming numerical verification', async () => {
    const f = await fixture(), value = JSON.parse(f.archiveJson); value.repetitions = 2;
    const result = await executeTerminalResearchRequest({ type: 'inspect-results', content: JSON.stringify(value) }, () => assert.fail('Inspection does not compute commands'));
    assert.equal(result.type, 'results-inspected'); if (result.type !== 'results-inspected') throw new Error('No inspection');
    const r = result.report;
    assert.equal(r.executions, 8); assert.equal(r.distinctAnalyses, 3); assert.equal(r.repetitions, 2);
    assert.equal(r.integrityChecked, true); assert.equal(r.numericallyReplayed, false); assert(!('verified' in r));
    assert.equal(r.index[3].analysis, null); assert.equal(r.index[7].analysis, null);
    assert.equal(r.index[1].analysis!.resultId, r.index[5].analysis!.resultId);
    assert.equal(r.index[5].iteration, 2); assert.equal(r.index[5].step, 2);
    assert(!JSON.stringify(r).includes('GAATTCAA')); assert(!JSON.stringify(r).includes('CCAATT'));
  });

  it('extracts an earlier pairwise result via real workers and replays it independently', async () => {
    const f = await fixture(), value = JSON.parse(f.archiveJson); value.repetitions = 2;
    const dir = await mkdtemp(join(tmpdir(), 'phage-extract-result-')), input = join(dir, 'complete.json'), output = join(dir, 'pair.json'), table = join(dir, 'pair.tsv');
    const content = JSON.stringify(value, null, 4); await writeFile(input, content);
    const inspect = await invoke(['inspect-results', '--input', input]); assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).inputArchiveSha256, hash(content));
    const extracted = await invoke(['extract-result', '--input', input, '--execution', '6', '--output', output]);
    assert.equal(extracted.code, 0, extracted.stderr);
    const report = JSON.parse(extracted.stdout), record = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.entry.execution, 6); assert.equal(report.entry.step, 2); assert.equal(report.numericallyReplayed, false);
    assert.deepEqual(record.fields.direct.value, [0, 1, 0, .5, .5, 0, 1, 0, 0]);
    assert.deepEqual(record.inputs.map((i: { data: string }) => i.data), ['AACC', 'CCAATT']);
    assert.equal(record.resultId, value.records[1].resultId);
    const replay = await invoke(['replay-experiment', '--input', output, '--output', table, '--format', 'tsv']);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).verified, true);
    assert.equal(JSON.parse(replay.stdout).resultId, record.resultId); assert((await readFile(table, 'utf8')).length > 100);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await invoke(['extract-result', '--input', input, '--execution', '1', '--output', output])).code, 1);
    assert.equal((await invoke(['extract-result', '--input', input, '--execution', '1', '--output', input])).code, 1);
    assert.equal(await readFile(input, 'utf8'), content);
  });

  it('rejects navigation or nonexistent executions before allocating an extraction worker', async () => {
    const f = await fixture(); let allocations = 0;
    for (const execution of [4, 5]) {
      await assert.rejects(runTerminalResearchWorker({ type: 'extract-result', content: f.archiveJson, execution }, new AbortController().signal,
        () => {}, () => { allocations++; throw new Error('No worker'); }), /navigation|existing/);
    }
    assert.equal(allocations, 0);
  });

  it('validates even unselected evidence and refuses a false verification claim or wrong extracted record', async () => {
    const f = await fixture(), invalid = JSON.parse(f.archiveJson); invalid.records[2].fields.cutSites.value = [7];
    await assert.rejects(runTerminalResearchWorker({ type: 'extract-result', content: JSON.stringify(invalid), execution: 1 }, new AbortController().signal,
      () => {}, () => { throw new Error('Should not allocate after invalid integrity'); }));
    for (const mode of ['claim', 'step', 'record', 'source']) {
      const create = () => new ReplyWorker(async (request, send) => {
        const result = await executeTerminalResearchRequest(request);
        if (result.type !== 'result-extracted') throw new Error('Expected extraction');
        if (mode === 'claim') (result.report as unknown as { numericallyReplayed: boolean }).numericallyReplayed = true;
        if (mode === 'step') result.report.entry.execution = 3;
        if (mode === 'record') result.recordJson = JSON.stringify(JSON.parse(f.archiveJson).records[2]);
        if (mode === 'source') result.report.inputArchiveSha256 = '0'.repeat(64);
        send(result);
      }) as unknown as TerminalWorker;
      await assert.rejects(runTerminalResearchWorker({ type: 'extract-result', content: f.archiveJson, execution: 1 }, new AbortController().signal,
        () => {}, create), /Unexpected terminal/);
    }
  });

  it('can inspect and extract a self-consistent but numerically false record without mislabeling it as replayed', async () => {
    const f = await fixture(), archive = await parseWorkflowResults(f.archiveJson), old = archive.records[0];
    const fields = structuredClone(old.fields); fields.direct.value = [0, 0, 0, 0];
    const forged = await createAnalysisRecord({ ...old, fields, inputs: old.inputs }); archive.records[0] = forged;
    const tape = parseCommandTape(archive.tapeJson); tape.commands[0].expected = analysisJson({ method: forged.method, cacheKey: forged.cacheKey, resultId: forged.resultId });
    archive.tapeJson = serializeCommandTape(tape); const content = JSON.stringify(archive);
    for (const type of ['inspect-results', 'extract-result'] as const) {
      const result = await executeTerminalResearchRequest(type === 'inspect-results' ? { type, content } : { type, content, execution: 1 });
      if (result.type !== 'results-inspected' && result.type !== 'result-extracted') throw new Error('Unexpected inspection');
      assert.equal(result.report.integrityChecked, true); assert.equal(result.report.numericallyReplayed, false);
      if (result.type === 'result-extracted') assert.deepEqual(JSON.parse(result.recordJson).fields.direct.value, [0, 0, 0, 0]);
    }
    await assert.rejects(executeTerminalResearchRequest({ type: 'replay-results', content }), /Step 1.*differs/);
  });

  it('inspects records from unavailable methods without importing an executor or claiming they can replay', async () => {
    const { WorkflowResultCollector } = await import('../../core/src/workflow-results');
    const record = await createAnalysisRecord({ method: { id: 'external-length', version: '1', implementation: 'Independent length example' },
      inputs: [{ id: 'sequence', accession: null, source: 'local', description: 'Synthetic private input', data: 'AGCT' }],
      parameters: {}, seed: null, references: [], fields: { length: { label: 'Length', kind: 'sequence-score', units: 'count', value: 4,
        coverage: { available: 4, total: 4, unit: 'bases' }, limitations: ['Not a functional annotation.'] } } });
    const tape = serializeCommandTape({ format: 'phage-explorer-commands', version: 1, name: 'Other implementation', context: null,
      commands: [{ actionId: 'analysis.external', parameters: {}, expected: analysisJson({ method: record.method, cacheKey: record.cacheKey, resultId: record.resultId }) }] });
    const collector = new WorkflowResultCollector(); collector.add(record); const content = await collector.finish(tape, 1);
    const result = await executeTerminalResearchRequest({ type: 'inspect-results', content }, () => assert.fail('No computation'));
    assert.equal(result.type, 'results-inspected'); if (result.type !== 'results-inspected') throw new Error('No inspection');
    assert.equal(result.report.index[0].analysis!.method.id, 'external-length'); assert(!('canReplay' in result.report));
    const extraction = await runTerminalResearchWorker({ type: 'extract-result', content, execution: 1 }, new AbortController().signal);
    assert.equal(extraction.type, 'result-extracted'); if (extraction.type !== 'result-extracted') throw new Error('No extraction');
    assert.equal(JSON.parse(extraction.recordJson).fields.length.value, 4);
  });

  it('settles cancellation during inspection preflight without starting a worker', async () => {
    const f = await fixture(), controller = new AbortController(); let workers = 0;
    const pending = runTerminalResearchWorker({ type: 'inspect-results', content: f.archiveJson }, controller.signal,
      () => {}, () => { workers++; throw new Error('No allocation after cancellation'); });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(workers, 0);
  });
});
