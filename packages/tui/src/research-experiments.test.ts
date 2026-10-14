import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { createDotPlotExperiment, exportDotPlotExperimentTsv } from '../../core/src/analysis/dot-plot';
import { createRestrictionDigestRecord, exportRestrictionDigestTsv } from '../../core/src/analysis/restriction-digest';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker,
  type TerminalWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';
import { executeTerminalResearchRequest, validateTerminalResearchRequest,
  type TerminalResearchRequest, type TerminalResearchResult } from './research-replay.worker';

const signal = () => new AbortController().signal;
async function fixtures() {
  const dot = (await createDotPlotExperiment({ sequence: 'anNt', accession: 'PRIVATE.1', source: 'local' }, { bins: 2, window: 2 })).record;
  // One circular EcoRI cut wraps the full-length molecule: [1,8) then [0,1).
  const digest = await createRestrictionDigestRecord('GAATTCAA', { enzymes: ['EcoRI'], topology: 'circular' }, { accession: 'CIRCLE.1', source: 'local' });
  return [dot, digest];
}
async function resign(record: AnalysisRecord, change: (copy: AnalysisRecord) => void) {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({
    method: copy.method, parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input),
  }));
}
async function invoke(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, value => { output += value; }, value => { error += value; }, runtime, 'phage-explorer workflow');
  return { code, output, error };
}
async function workspace() { return mkdtemp(join(tmpdir(), 'phage-experiment-test-')); }
async function absent(path: string) {
  await assert.rejects(lstat(path), (cause: NodeJS.ErrnoException) => cause.code === 'ENOENT');
}

/** Lifecycle-only transport fixture. Numerical tests below use the real worker. */
class ReplyWorker extends EventEmitter {
  terminations = 0;
  constructor(private readonly reply: (request: TerminalResearchRequest) => unknown) { super(); }
  postMessage(request: TerminalResearchRequest) {
    queueMicrotask(() => this.emit('message', this.reply(request)));
  }
  terminate() { this.terminations++; return Promise.resolve(0); }
}

describe('terminal portable experiment replay', () => {
  it('parses the experiment subcommand without changing tape flags or allowing ambient settings', () => {
    assert.deepEqual(parseWorkflowCommand(['replay-experiment', '--input', 'source.json']), {
      type: 'replay-experiment', input: 'source.json', timeoutMs: 300000, outputFormat: 'json',
    });
    assert.deepEqual(parseWorkflowCommand(['replay-experiment', '--input', 'source.json', '--output', 'matrix.tsv', '--format', 'tsv', '--timeout-ms', '5000']), {
      type: 'replay-experiment', input: 'source.json', output: 'matrix.tsv', outputFormat: 'tsv', timeoutMs: 5000,
    });
    assert.deepEqual(parseWorkflowCommand(['replay', '--input', 'tape.json', '--repetitions', '2', '--progress']), {
      type: 'replay', input: 'tape.json', timeoutMs: 300000, repetitions: 2, progress: true,
    });
    for (const rest of [['--format', 'tsv'], ['--repetitions', '2'], ['--progress'], ['--format', 'csv', '--output', 'x'],
      ['--timeout-ms', '0'], ['--timeout-ms', 'Infinity'], ['--output', 'x', '--output', 'y'], ['--window', '2']]) {
      assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', ...rest]));
    }
    assert.throws(() => parseWorkflowCommand(['inspect', '--input', 'x', '--format', 'tsv']));
    assert.throws(() => parseWorkflowCommand(['replay', '--input', 'x', '--format', 'tsv']));
  });

  it('requires exact request fields, bounded UTF-8 and an explicit supported output format', () => {
    const request = { type: 'replay-experiment', content: '{}', outputFormat: 'none' };
    validateTerminalResearchRequest(request);
    for (const value of [{ ...request, outputFormat: 'csv' }, { ...request, filename: '/private/file' },
      { ...request, content: 0 }, { ...request, content: 'α'.repeat(5 * 1024 * 1024 + 1) },
      { type: 'replay-experiment', content: '{}' }, { ...request, repetitions: 1 }]) {
      assert.throws(() => validateTerminalResearchRequest(value));
    }
    validateTerminalResearchRequest({ type: 'inspect', content: '{}' });
    validateTerminalResearchRequest({ type: 'replay', content: '{}', repetitions: 1, exportAnalysis: false });
  });

  it('recomputes browser-exported dot plot and circular digest through actual native workers', async () => {
    for (const record of await fixtures()) {
      const content = serializeAnalysisRecord(record);
      const result = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal());
      assert.equal(result.type, 'experiment-replayed');
      if (result.type !== 'experiment-replayed') throw new Error('Expected experiment replay');
      assert.equal(result.report.verified, true);
      assert.equal(result.report.headless, true);
      assert.equal(result.report.inputRecordSha256, createHash('sha256').update(content).digest('hex'));
      assert.equal(result.report.resultId, record.resultId);
      assert.equal(result.report.cacheKey, record.cacheKey);
      assert.deepEqual(result.report.method, record.method);
      assert.deepEqual(await parseAnalysisRecord(result.exportText!), record);
      const fresh = JSON.parse(result.exportText!) as AnalysisRecord;
      if (record.method.id === 'sequence-dot-plot') {
        assert.deepEqual(fresh.fields.direct.value, [0.5, 0, 0, 0.5]);
        assert.deepEqual(fresh.fields.inverted.value, [0, 0.5, 0.5, 0]);
      } else {
        assert.deepEqual(fresh.fields.cutSites.value, [1]);
        assert.deepEqual(fresh.fields.fragments.value, [{ start: 1, end: 1, length: 8, wrapsOrigin: true }]);
      }
      assert.equal(JSON.stringify(result.report).includes(String(record.inputs[0].data)), false);
    }
  });

  it('exports the same TSV as the browser and omits unrequested output', async () => {
    for (const record of await fixtures()) {
      const content = serializeAnalysisRecord(record);
      const table = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, signal());
      assert.equal(table.type, 'experiment-replayed');
      if (table.type !== 'experiment-replayed') throw new Error('Expected experiment');
      assert.equal(table.exportText, record.method.id === 'sequence-dot-plot' ? exportDotPlotExperimentTsv(record) : exportRestrictionDigestTsv(record));
      assert.equal(table.exportText!.includes(String(record.inputs[0].data)), false);
      const check = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
      assert.equal(check.type, 'experiment-replayed');
      if (check.type === 'experiment-replayed') assert.equal(check.exportText, null);
    }
  });

  it('refuses rehashed false scores and cut products rather than trusting valid checksums', async () => {
    for (const record of await fixtures()) {
      const content = await resign(record, copy => {
        if (copy.method.id === 'sequence-dot-plot') copy.fields.inverted.value = [0, 0, 0, 0];
        else copy.fields.cutSites.value = [2];
      });
      await parseAnalysisRecord(content); // This deliberately passes the hash boundary.
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal()), /Recomputed/);
    }
  });

  it('refuses unsupported method versions, changed references and changed source identity', async () => {
    const [record] = await fixtures();
    for (const change of [
      (r: AnalysisRecord) => { r.method.id = 'arbitrary-code'; },
      (r: AnalysisRecord) => { r.method.version = '999'; },
      (r: AnalysisRecord) => { r.references[0].version = 'changed'; },
      (r: AnalysisRecord) => { r.inputs[0].data = 'AAAA'; },
    ]) await assert.rejects(executeTerminalResearchRequest({ type: 'replay-experiment', content: await resign(record, change), outputFormat: 'none' }));
  });

  it('creates private JSON/TSV files exclusively, reports metadata, and never overwrites an input or output', async () => {
    const dir = await workspace(), [record] = await fixtures(), content = serializeAnalysisRecord(record);
    const input = join(dir, 'input.json'), output = join(dir, 'fresh.json'), tsv = join(dir, 'fresh.tsv');
    await writeFile(input, content);
    const replay = await invoke(['replay-experiment', '--input', input, '--output', output]);
    assert.equal(replay.code, 0, replay.error);
    assert.equal(replay.error, '');
    assert.equal(JSON.parse(replay.output).resultId, record.resultId);
    assert.deepEqual(await parseAnalysisRecord(await readFile(output, 'utf8')), record);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    const table = await invoke(['replay-experiment', '--input', input, '--output', tsv, '--format', 'tsv']);
    assert.equal(table.code, 0, table.error);
    assert.equal(await readFile(tsv, 'utf8'), exportDotPlotExperimentTsv(record));
    for (const existing of [input, output, tsv]) {
      const before = await readFile(existing, 'utf8');
      const fail = await invoke(['replay-experiment', '--input', input, '--output', existing]);
      assert.equal(fail.code, 1); assert.equal(fail.output, '');
      assert.equal(await readFile(existing, 'utf8'), before);
    }
  });

  // Windows symlink creation requires an OS privilege absent from normal installs.
  if (process.platform !== 'win32') it('does not create a dangling output symlink target', async () => {
    const dir = await workspace(), [record] = await fixtures();
    const input = join(dir, 'input.json'), link = join(dir, 'output.json'), target = join(dir, 'must-not-exist.json');
    await writeFile(input, serializeAnalysisRecord(record));
    await symlink(target, link, 'file');
    const result = await invoke(['replay-experiment', '--input', input, '--output', link]);
    assert.equal(result.code, 1); assert.equal(result.output, '');
    assert.equal((await lstat(link)).isSymbolicLink(), true); await absent(target);
  });

  it('returns failure with no success report or output file on malformed bytes or false numerical evidence', async () => {
    const dir = await workspace(), [record] = await fixtures();
    const invalid = [Buffer.from([0xff, 0xfe]), Buffer.from('{'),
      Buffer.from(await resign(record, copy => { copy.fields.direct.value = [1, 1, 1, 1]; })),
      Buffer.from(' '.repeat(10 * 1024 * 1024 + 1))];
    for (let i = 0; i < invalid.length; i++) {
      const input = join(dir, `bad-${i}.json`), output = join(dir, `output-${i}.json`);
      await writeFile(input, invalid[i]);
      const result = await invoke(['replay-experiment', '--input', input, '--output', output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert(result.error.length > 0); await absent(output);
    }
    assert.equal((await invoke(['replay-experiment', '--input', dir])).code, 1);
  });

  it('rejects responses for a different file, method, source or export contract and terminates the worker', async () => {
    const [record] = await fixtures(), content = serializeAnalysisRecord(record);
    const valid = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
    if (valid.type !== 'experiment-replayed') throw new Error('Expected experiment');
    for (const change of [
      (r: typeof valid) => { r.report.inputRecordSha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.report.resultId = '0'.repeat(64); },
      (r: typeof valid) => { r.report.method.version = 'changed'; },
      (r: typeof valid) => { r.report.inputs[0].sha256 = '0'.repeat(64); },
      (r: typeof valid) => { r.exportText = 'unexpected'; },
    ]) {
      const changed: Extract<TerminalResearchResult, { type: 'experiment-replayed' }> = structuredClone(valid); change(changed);
      const worker: ReplyWorker = new ReplyWorker(() => changed);
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'none' }, signal(), undefined,
        () => worker as unknown as TerminalWorker), /Unexpected/);
      assert.equal(worker.terminations, 1);
    }
  });

  it('kills unresponsive CPU workers on timeout or explicit cancellation without writing output', async () => {
    const dir = await workspace(), [record] = await fixtures(), input = join(dir, 'input.json');
    await writeFile(input, serializeAnalysisRecord(record));
    for (const cancel of [false, true]) {
      const controller = new AbortController(), output = join(dir, cancel ? 'cancelled.json' : 'timed-out.json');
      let exited: Promise<number> | undefined;
      const result = await invoke(['replay-experiment', '--input', input, '--output', output, '--timeout-ms', cancel ? '30000' : '1000'], {
        signal: controller.signal,
        createWorker() {
          // Lifecycle probe: synchronous CPU work cannot process a cancel message.
          const worker = new Worker('for (;;) {}', { eval: true });
          exited = new Promise(resolve => worker.once('exit', resolve));
          if (cancel) worker.once('online', () => controller.abort(new DOMException('Stop', 'AbortError')));
          return worker;
        },
      });
      assert.equal(result.code, cancel ? 130 : 124, result.error);
      assert.equal(result.output, ''); await absent(output);
      assert(exited, 'the worker was actually created'); await exited;
    }
  });

  it('rejects pre-cancelled work before starting any worker', async () => {
    const [record] = await fixtures();
    const controller = new AbortController(); controller.abort(new DOMException('Cancelled', 'AbortError'));
    let created = 0;
    await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content: serializeAnalysisRecord(record), outputFormat: 'none' }, controller.signal,
      undefined, () => { created++; throw new Error('Must not create'); }), { name: 'AbortError' });
    assert.equal(created, 0);
  });

  it('keeps the legacy command-tape inspection response boundary intact', async () => {
    const content = JSON.stringify({ format: 'phage-explorer-commands', version: 1, name: 'Existing tape', context: { bundle: '{}' }, commands: [] });
    const inspection: TerminalResearchResult = { type: 'inspection', inspection: {
      format: 'phage-explorer-workflow-inspection', version: 1, name: 'Existing tape', canReplay: false,
      tapeSha256: createHash('sha256').update(content).digest('hex'), steps: [], genomes: [],
    } };
    const worker = new ReplyWorker(() => inspection);
    assert.deepEqual(await runTerminalResearchWorker({ type: 'inspect', content }, signal(), undefined, () => worker as unknown as TerminalWorker), inspection);
    assert.equal(worker.terminations, 1);
  });

  it('documents the integrated native invocation and embedded-source limitation in help', async () => {
    const help = await invoke(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.output, /phage-explorer workflow replay-experiment/);
    assert.match(help.output, /not source authentication or biological validation/);
    assert.equal(help.error, '');
  });
});
