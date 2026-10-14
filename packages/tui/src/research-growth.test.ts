import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createPlaqueGrowthRecord, parsePlaqueGrowthInput, replayPlaqueGrowthRecord, exportPlaqueGrowthTsv,
  type PlaqueGrowthInput, type PlaqueGrowthFit } from '../../core/src/analysis/plaque-growth';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { executeTerminalResearchRequest, validateTerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';
const signal = () => new AbortController().signal;
async function cli(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; }, runtime);
  return { code, output, error };
}
async function fixture() {
  const template = await cli(['growth-template']); assert.equal(template.code, 0, template.error);
  const input = parsePlaqueGrowthInput(template.output);
  const dir = await mkdtemp(join(tmpdir(), 'phage-growth-'));
  const file = join(dir, 'source.json'), output = join(dir, 'fit.json');
  await writeFile(file, template.output, { flag: 'wx', mode: 0o600 });
  return { input, content: template.output, dir, file, output };
}
async function absent(path: string) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function resign(record: AnalysisRecord, change: (record: AnalysisRecord) => void) {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: copy.method, inputs: copy.inputs.map(({ sha256: _hash, ...i }) => i),
    parameters: copy.parameters, seed: copy.seed, fields: copy.fields, references: copy.references }));
}
describe('native measured plaque-count workflow', () => {
  it('exposes a usable explicitly synthetic input template without implying a measured denominator', async () => {
    const f = await fixture(); assert.equal(f.input.provenance.kind, 'synthetic');
    assert.equal(f.input.options.infectedCentersPerMl, null);
    assert.equal(f.input.measurement, 'extracellular-plaque-counts');
    const output = await executeTerminalResearchRequest({ type: 'fit-growth', content: f.content });
    assert.equal(output.type, 'growth-fitted');
    if (output.type !== 'growth-fitted') throw new Error('Expected growth fit');
    const record = await parseAnalysisRecord(output.recordJson);
    assert.equal(record.fields.fit.kind, 'demo');
    const fit = record.fields.fit.value as unknown as PlaqueGrowthFit;
    assert.equal(fit.infectiousYieldPerInfectedCenter, null);
    assert(Math.abs(fit.increasePFUPerMl - 100) < 1e-7); assert.equal(fit.riseStartMin, 3);
  });
  it('parses method-specific options without accepting genome flags, ambiguous formats or duplicate options', () => {
    assert.deepEqual(parseWorkflowCommand(['fit-growth', '--input', 'x']), { type: 'fit-growth', input: 'x', timeoutMs: 300000, outputFormat: 'json' });
    assert.deepEqual(parseWorkflowCommand(['fit-growth', '--input', 'x', '--output', 'out', '--format', 'tsv', '--timeout-ms', '5000']),
      { type: 'fit-growth', input: 'x', output: 'out', timeoutMs: 5000, outputFormat: 'tsv' });
    for (const rest of [['--format', 'tsv'], ['--record', 'a'.repeat(64)], ['--method', 'gc-skew'], ['--progress'],
      ['--repetitions', '2'], ['--input', 'other'], ['--timeout-ms', '0'], ['--output', 'a', '--format', 'csv']]) {
      assert.throws(() => parseWorkflowCommand(['fit-growth', '--input', 'x', ...rest]));
    }
    assert.throws(() => parseWorkflowCommand(['growth-template', '--input', 'x']));
    assert.equal(parseWorkflowCommand(['analyze-experiment', '--input', 'x', '--method', 'gc-skew']).type, 'analyze-experiment');
  });
  it('fits in an actual worker, exclusively saves the exact record and emits a source-bound summary', async () => {
    const f = await fixture(), result = await cli(['fit-growth', '--input', f.file, '--output', f.output]);
    assert.equal(result.code, 0, result.error); assert.equal(result.error, '');
    const report = JSON.parse(result.output), record = await parseAnalysisRecord(await readFile(f.output, 'utf8'));
    assert.equal(report.format, 'phage-explorer-growth-fit'); assert.equal(report.headless, true);
    assert.equal(report.verified, undefined); assert.equal(report.provenance, 'synthetic');
    assert.equal(report.inputFileSha256, createHash('sha256').update(f.content).digest('hex'));
    assert.equal(report.resultId, record.resultId); assert.equal(report.summary.fitted, undefined);
    assert(!result.output.includes(f.input.csv));
    assert.deepEqual(record, await createPlaqueGrowthRecord(f.content));
    assert.equal(record.inputs[0].data, f.content);
    if (process.platform !== 'win32') assert.equal((await lstat(f.output)).mode & 0o777, 0o600);
  });
  it('replays the same analysis and exports identical plate residuals through the existing replay command', async () => {
    const f = await fixture(); assert.equal((await cli(['fit-growth', '--input', f.file, '--output', f.output])).code, 0);
    const content = await readFile(f.output, 'utf8'), record = await replayPlaqueGrowthRecord(content);
    const tsv = join(f.dir, 'replayed.tsv'), replay = await cli(['replay-experiment', '--input', f.output, '--output', tsv, '--format', 'tsv']);
    assert.equal(replay.code, 0, replay.error); assert.equal(JSON.parse(replay.output).verified, true);
    assert.equal(await readFile(tsv, 'utf8'), exportPlaqueGrowthTsv(record));
    const direct = join(f.dir, 'direct.tsv');
    assert.equal((await cli(['fit-growth', '--input', f.file, '--output', direct, '--format', 'tsv'])).code, 0);
    assert.equal(await readFile(direct, 'utf8'), await readFile(tsv, 'utf8'));
  });
  it('keeps user-supplied measurements distinct from synthetic data and preserves unresolved timing', async () => {
    const f = await fixture();
    const input: PlaqueGrowthInput = { ...f.input, provenance: { kind: 'user-supplied', source: 'Test of attribution, not an actual experiment' },
      csv: f.input.csv.replaceAll(',60,', ',10,').replaceAll(',110,', ',10,') };
    await writeFile(join(f.dir, 'flat.json'), JSON.stringify(input), { flag: 'wx' });
    const result = await cli(['fit-growth', '--input', join(f.dir, 'flat.json')]);
    assert.equal(result.code, 0, result.error);
    const report = JSON.parse(result.output); assert.equal(report.provenance, 'user-supplied');
    assert.equal(report.summary.timingStatus, 'unresolved'); assert.equal(report.summary.riseStartMin, null);
    assert(report.summary.increaseSupport[0][1] > 0); assert.equal(report.summary.yieldSupport, null);
  });
  it('rejects fake numerical support even when its AnalysisRecord hashes are valid', async () => {
    const f = await fixture(), record = await createPlaqueGrowthRecord(f.content);
    const forged = await resign(record, r => { (r.fields.fit.value as unknown as PlaqueGrowthFit).increaseSupport = [[100, 100]]; });
    await parseAnalysisRecord(forged);
    const file = join(f.dir, 'forged.json'); await writeFile(file, forged, { flag: 'wx' });
    const result = await cli(['replay-experiment', '--input', file, '--output', f.output]);
    assert.equal(result.code, 1); assert.equal(result.output, ''); assert.match(result.error, /Recomputed/); await absent(f.output);
  });
  it('rejects the wrong assay, malformed or oversized input without publishing a file or success', async () => {
    const f = await fixture();
    const invalid = [JSON.stringify({ ...f.input, measurement: 'total-infective-centers' }), '{', Buffer.from([255, 254]),
      JSON.stringify({ ...f.input, csv: f.input.csv.replace('0,10', '0,TNTC') }), ' '.repeat(1_000_001)];
    for (let i = 0; i < invalid.length; i++) {
      const file = join(f.dir, `bad-${i}`); await writeFile(file, invalid[i], { flag: 'wx' });
      const result = await cli(['fit-growth', '--input', file, '--output', f.output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert(result.error); await absent(f.output);
    }
    assert.equal((await cli(['fit-growth', '--input', f.dir])).code, 1);
  });
  it('does not overwrite existing data, the input itself or dangling output symlinks', async () => {
    const f = await fixture(); await writeFile(f.output, 'keep existing', { flag: 'wx' });
    for (const output of [f.output, f.file]) {
      const before = await readFile(output, 'utf8'), result = await cli(['fit-growth', '--input', f.file, '--output', output]);
      assert.equal(result.code, 1); assert.equal(result.output, ''); assert.equal(await readFile(output, 'utf8'), before);
    }
    if (process.platform !== 'win32') {
      const link = join(f.dir, 'link'), target = join(f.dir, 'target'); await symlink(target, link);
      assert.equal((await cli(['fit-growth', '--input', f.file, '--output', link])).code, 1);
      assert((await lstat(link)).isSymbolicLink()); await absent(target);
    }
  });
  it('terminates busy workers on timeout and abort without creating output, then permits a clean fit', async () => {
    const f = await fixture();
    for (const cancel of [false, true]) {
      const controller = new AbortController(); let exit: Promise<number> | undefined;
      const result = await cli(['fit-growth', '--input', f.file, '--output', f.output, '--timeout-ms', cancel ? '30000' : '1000'], {
        signal: controller.signal, createWorker() {
          const worker = new Worker('for (;;) {}', { eval: true }); exit = new Promise(resolve => worker.once('exit', resolve));
          if (cancel) worker.once('online', () => controller.abort(new DOMException('Stop', 'AbortError')));
          return worker;
        },
      });
      assert.equal(result.code, cancel ? 130 : 124, result.error); assert.equal(result.output, ''); await absent(f.output);
      assert(exit); await exit;
    }
    assert.equal((await cli(['fit-growth', '--input', f.file, '--output', f.output])).code, 0);
  });
  it('rejects extra worker fields and cancellation before allocating a thread', async () => {
    const f = await fixture();
    validateTerminalResearchRequest({ type: 'fit-growth', content: f.content });
    assert.throws(() => validateTerminalResearchRequest({ type: 'fit-growth', content: f.content, filename: '/never/read' }));
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await assert.rejects(runTerminalResearchWorker({ type: 'fit-growth', content: f.content }, controller.signal, undefined,
      () => { calls++; throw new Error('Must not start'); }), { name: 'AbortError' });
    assert.equal(calls, 0);
  });
  it('checks both the response file digest and embedded source before any disk publication', async () => {
    const f = await fixture(), other = JSON.stringify({ ...f.input, title: 'Other source' });
    for (const wrongHash of [true, false]) {
      const record = await createPlaqueGrowthRecord(wrongHash ? f.content : other);
      const response = { type: 'growth-fitted', inputFileSha256: wrongHash ? '0'.repeat(64) : createHash('sha256').update(f.content).digest('hex'),
        recordJson: serializeAnalysisRecord(record) };
      const result = await cli(['fit-growth', '--input', f.file, '--output', f.output], { createWorker: () => new Worker(
        `require('node:worker_threads').parentPort.once('message',()=>require('node:worker_threads').parentPort.postMessage(${JSON.stringify(response)}))`, { eval: true }) });
      assert.equal(result.code, 1); assert.equal(result.output, ''); await absent(f.output);
    }
  });
});
