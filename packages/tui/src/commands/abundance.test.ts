import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { parseAbundanceCommand, executeAbundanceJob, runAbundanceJob, readAbundanceFile,
  readAbundanceStdin, runAbundanceCommand, type AbundanceJob, type AbundanceCommandIO } from './abundance';
import { parseAbundanceDataset, analyzeAbundanceDataset, createAbundanceAnalysisRecord,
  replayAbundanceAnalysis } from '../../../core/src/analysis/abundance';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../../../core/src/analysis-result';

const text = 'taxon,S1,S2,S3\nA,1,4,16\nB,16,4,1\n';
const options = { pseudocount: 0, numNiches: 1, permutations: 19, seed: 0, qvalueThreshold: 1 };
const job: AbundanceJob = { operation: 'analyze', input: { name: 'private.csv', text }, parameters: JSON.stringify(options) };
function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { stream, text: () => text };
}
function io(input = text, execute?: AbundanceCommandIO['execute']) {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(input)]), stdout: out.stream, stderr: err.stream, execute,
    output: out.text, errors: err.text };
}
// Retain test files under the OS temporary directory: never overwrite user files.
const directory = () => mkdtemp(join(tmpdir(), 'phage-abundance-'));
const missing = async (path: string) => assert.equal(await lstat(path).then(() => false, e => e.code === 'ENOENT'), true);

 describe('abundance command contracts', () => {
  it('accepts each explicit operation and one stdin input', () => {
    assert.equal(parseAbundanceCommand([]), null);
    assert.equal(parseAbundanceCommand(['--help']), null);
    assert.deepEqual(parseAbundanceCommand(['analyze', '-', '--metadata', 'metadata.csv', '--params', 'p.json', '--output', '-']),
      { operation: 'analyze', input: '-', metadata: 'metadata.csv', parameters: 'p.json', output: undefined });
    assert.equal(parseAbundanceCommand(['inspect', 'input.csv'])?.operation, 'inspect');
    assert.equal(parseAbundanceCommand(['replay', 'saved.json'])?.operation, 'replay');
  });
  it('rejects unknown commands/options, missing inputs and ambiguous stdin use', () => {
    for (const args of [['run', 'input'], ['analyze'], ['analyze', ' '], ['analyze', 'a', 'b'],
      ['analyze', 'input', '--execute', 'code'], ['analyze', '-', '--metadata', '-'],
      ['inspect', 'input', '--params', 'p.json'], ['replay', 'input', '--metadata', 'm.csv'],
      ['replay', 'input', '--params', 'p.json'], ['analyze', 'input', '--output', '']]) {
      assert.throws(() => parseAbundanceCommand(args));
    }
  });
  it('inspect preserves the actual counts and keyed metadata without running inference', async () => {
    const result = await executeAbundanceJob({ ...job, operation: 'inspect', parameters: undefined,
      metadata: 'sampleId,habitat\nS3,soil\nS1,gut\n' });
    const dataset = JSON.parse(result.content);
    assert.deepEqual(dataset.table.counts, [[1, 4, 16], [16, 4, 1]]);
    assert.deepEqual(dataset.metadata, [{ sampleId: 'S3', habitat: 'soil' }, { sampleId: 'S1', habitat: 'gut' }]);
    assert.equal(result.identity, null);
    assert.equal(result.verified, false);
    assert.equal(dataset.source.kind, 'local');
  });
  it('computes the independently derived perfect anticorrelation and exact 2/6 pairing probability', async () => {
    const result = await executeAbundanceJob(job);
    const record = await parseAnalysisRecord(result.content);
    const [association] = record.fields.associations.value as Array<Record<string, number>>;
    // CLR trajectories are +/- log(4) * [-1,0,1]; two of six pairings have |r|=1.
    assert.ok(Math.abs(association.correlation + 1) < 1e-12);
    assert.equal(association.pvalue, 1 / 3);
    assert.equal(association.qvalue, 1 / 3);
    assert.equal(record.seed, 0);
    assert.equal(record.inputs[0].source, 'local');
    assert.equal(record.fields.associations.kind, 'fitted-estimate');
  });
  it('is byte-identical to the core producer used by the browser and replay works in both directions', async () => {
    const dataset = parseAbundanceDataset(text, 'private.csv');
    const browser = await createAbundanceAnalysisRecord(dataset, analyzeAbundanceDataset(dataset, options));
    const terminal = await executeAbundanceJob(job);
    assert.equal(terminal.content, serializeAnalysisRecord(browser));
    const replay = await executeAbundanceJob({ operation: 'replay', input: { name: 'browser.json', text: serializeAnalysisRecord(browser) } });
    assert.equal(replay.verified, true);
    assert.equal(replay.identity, browser.resultId);
    assert.equal((await replayAbundanceAnalysis(terminal.content)).record.resultId, browser.resultId);
  });
  it('preserves real habitat means rather than assigning the same habitats to every taxon', async () => {
    const result = await executeAbundanceJob({ ...job, metadata: 'sampleId,habitat\nS3,soil\nS1,gut\n' });
    const record = await parseAnalysisRecord(result.content);
    const { profiles } = record.fields.factors.value as unknown as { profiles: Array<{ habitats: Array<{ habitat: string; meanRelativeAbundance: number }> }> };
    assert.equal(profiles[0].habitats[0].habitat, 'soil');
    assert.equal(profiles[1].habitats[0].habitat, 'gut');
    assert.equal(profiles[0].habitats[0].meanRelativeAbundance, 16 / 17);
  });
  it('rejects invalid metadata, unsupported parameters and malformed parameter JSON before publication', async () => {
    for (const parameters of ['null', '[]', '{', '{"unknown":true}', '{"seed":-1}', '{"numNiches":8}']) {
      await assert.rejects(executeAbundanceJob({ ...job, parameters }));
    }
    await assert.rejects(executeAbundanceJob({ ...job, metadata: 'sampleId,habitat\nmissing,soil\n' }), /sampleId/);
    await assert.rejects(executeAbundanceJob({ ...job, input: { name: 'empty.csv', text: 'taxon,S1\nA,0\n' } }), /nonempty/);
  });
  it('rejects tampered hashes and forged numeric outputs with valid hashes', async () => {
    const original = await executeAbundanceJob(job);
    const bad = JSON.parse(original.content);
    bad.seed = 17;
    await assert.rejects(executeAbundanceJob({ operation: 'replay', input: { name: 'tampered.json', text: JSON.stringify(bad) } }), /identity differs/);
    const record = await parseAnalysisRecord(original.content);
    (record.fields.associations.value as Array<Record<string, AnalysisJson>>)[0].correlation = 0.5;
    const forged = await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...input }) => input) });
    await assert.rejects(executeAbundanceJob({ operation: 'replay', input: { name: 'forged.json', text: serializeAnalysisRecord(forged) } }), /Recomputed abundance result differs/);
  });
});

describe('bounded local inputs and safe outputs', () => {
  it('reads UTF-8 files at the exact byte boundary and rejects invalid, oversized, linked and non-file inputs', async () => {
    const dir = await directory(), path = join(dir, 'input');
    await writeFile(path, 'λA');
    assert.equal(await readAbundanceFile(path, 3), 'λA');
    await assert.rejects(readAbundanceFile(path, 2), /limit/);
    await assert.rejects(readAbundanceFile(dir, 100), /regular files/);
    const invalid = join(dir, 'invalid');
    await writeFile(invalid, Buffer.from([0xff]));
    await assert.rejects(readAbundanceFile(invalid, 10), /encoded data|encoding/i);
    if (process.platform !== 'win32') {
      const link = join(dir, 'link'); await symlink(path, link);
      await assert.rejects(readAbundanceFile(link, 100), /regular files/);
    }
  });
  it('decodes split UTF-8 stdin chunks and bounds streamed bytes, not character count', async () => {
    assert.equal(await readAbundanceStdin(Readable.from([Buffer.from([0xce]), Buffer.from([0xbb, 0x41])]), 3), 'λA');
    await assert.rejects(readAbundanceStdin(Readable.from(['λA']), 2), /limit/);
    await assert.rejects(readAbundanceStdin(Readable.from([Buffer.from([0xff])]), 10), /encoded data|encoding/i);
  });
  it('cancellation settles a stalled stdin read and removes listeners', async () => {
    const stream = new PassThrough(), controller = new AbortController();
    const reading = readAbundanceStdin(stream, 100, controller.signal);
    stream.write('partial'); controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    for (const event of ['data', 'end', 'error', 'close']) assert.equal(stream.listenerCount(event), 0);
    stream.end();
  });
  it('outputs only parseable JSON to stdout and bounded structured phases to stderr', async () => {
    const streams = io(text, async (request, _signal, progress) => executeAbundanceJob(request, progress));
    assert.equal(await runAbundanceCommand(['analyze', '-'], streams), 0);
    const record = await parseAnalysisRecord(streams.output());
    assert.equal(record.method.id, 'abundance-clr-nmf');
    const phases = streams.errors().trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(phases.map(p => p.phase), ['reading-inputs', 'validating-inputs', 'computing', 'binding-result', 'publishing']);
    for (const phase of phases) assert.deepEqual(Object.keys(phase).sort(), ['operation', 'phase']);
  });
  it('preflights an existing destination without reading or starting a worker', async () => {
    const dir = await directory(), output = join(dir, 'saved.json');
    await writeFile(output, 'do not touch');
    let calls = 0;
    const streams = io('', async () => { calls++; throw new Error('must not run'); });
    assert.equal(await runAbundanceCommand(['analyze', join(dir, 'missing'), '--output', output], streams), 1);
    assert.equal(calls, 0); assert.equal(await readFile(output, 'utf8'), 'do not touch');
    assert.equal(streams.output(), ''); assert.match(streams.errors(), /already exists/);
  });
  it('exclusive creation also rejects a destination created during computation', async () => {
    const dir = await directory(), output = join(dir, 'racing.json');
    const streams = io(text, async (request) => {
      const result = await executeAbundanceJob(request);
      await writeFile(output, 'concurrent result', { flag: 'wx' });
      return result;
    });
    assert.equal(await runAbundanceCommand(['analyze', '-', '--output', output], streams), 1);
    assert.equal(await readFile(output, 'utf8'), 'concurrent result');
    assert.equal(streams.output(), '');
  });
  it('writes a new result once, then refuses to overwrite it or the input', async () => {
    const dir = await directory(), input = join(dir, 'private.csv'), output = join(dir, 'result.json');
    await writeFile(input, text);
    const run = async (target: string) => runAbundanceCommand(['analyze', input, '--output', target],
      io('', async (request) => executeAbundanceJob(request)));
    assert.equal(await run(output), 0);
    const before = await readFile(output, 'utf8'); await parseAnalysisRecord(before);
    assert.equal(await run(output), 1); assert.equal(await readFile(output, 'utf8'), before);
    assert.equal(await run(input), 1); assert.equal(await readFile(input, 'utf8'), text);
  });
  it('bad input and cancellation never publish an output file', async () => {
    const dir = await directory(), output = join(dir, 'must-not-exist');
    const streams = io('bad', async (request) => executeAbundanceJob(request));
    assert.equal(await runAbundanceCommand(['analyze', '-', '--output', output], streams), 1);
    await missing(output); assert.equal(streams.output(), '');
    const controller = new AbortController(); controller.abort();
    assert.equal(await runAbundanceCommand(['analyze', '-', '--output', output], { ...io(), signal: controller.signal }), 130);
    await missing(output);
  });
  it('reports a broken stdout pipe without an unhandled error or success exit', async () => {
    const streams = io(text, async (request) => executeAbundanceJob(request));
    streams.stdout = new Writable({ write(_chunk, _encoding, done) { done(new Error('broken pipe')); } });
    assert.equal(await runAbundanceCommand(['inspect', '-'], streams), 1);
    assert.match(streams.errors(), /broken pipe/);
    await new Promise(resolve => setImmediate(resolve));
  });
  it('rejects command errors with status 2 and escapes terminal-control sequences in diagnostics', async () => {
    const streams = io('', async () => { throw new Error('\x1b[31munsafe\x1b[0m\x07'); });
    assert.equal(await runAbundanceCommand(['invalid'], streams), 2);
    const broken = io(text, streams.execute);
    assert.equal(await runAbundanceCommand(['inspect', '-'], broken), 1);
    assert.ok(!/[\x1b\x07]/.test(broken.errors()));
  });
});

describe('real abundance worker transport', () => {
  it('runs source worker computation and verified replay with the actual shared algorithms', async () => {
    const result = await runAbundanceJob(job);
    const replay = await runAbundanceJob({ operation: 'replay', input: { name: 'record.json', text: result.content } });
    assert.equal(replay.verified, true); assert.equal(replay.identity, result.identity);
    assert.equal(replay.content, result.content);
  });
  it('reports worker validation failure and the next independent job still succeeds', async () => {
    await assert.rejects(runAbundanceJob({ ...job, parameters: '{"seed":-1}' }), /seed/);
    assert.ok((await runAbundanceJob(job)).identity);
  });
  it('aborts during numerical work rather than blocking the parent event loop', async () => {
    const taxa = 80, samples = 100;
    const large = ['taxon,' + Array.from({ length: samples }, (_, i) => `s${i}`).join(',')];
    for (let t = 0; t < taxa; t++) large.push(`t${t},` + Array.from({ length: samples }, (_, i) => 1 + (t * 17 + i * 7 + t * i) % 127).join(','));
    const controller = new AbortController(); let computing = false;
    const pending = runAbundanceJob({ operation: 'analyze', input: { name: 'large.csv', text: large.join('\n') },
      parameters: '{"permutations":99}' }, controller.signal, phase => {
      if (phase === 'computing') { computing = true; controller.abort(); }
    });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(computing, true);
    assert.ok((await runAbundanceJob(job)).identity, 'another run must not inherit the cancelled state');
  });
  it('cancellation after an input read but before publication cannot leak a completed result', async () => {
    const controller = new AbortController();
    const streams = io(text, async request => { const result = await executeAbundanceJob(request); controller.abort(); return result; });
    assert.equal(await runAbundanceCommand(['analyze', '-'], { ...streams, signal: controller.signal }), 130);
    assert.equal(streams.output(), '');
  });
});
