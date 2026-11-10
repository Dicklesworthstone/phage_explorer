import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { parseEnvironmentalCommand, runEnvironmentalCommand, runEnvironmentalRequest, readEnvironmentalInput,
  type EnvironmentalCommandIO } from './environmental';
import { executeEnvironmentalRequest, type EnvironmentalRequest } from '../../../web/src/workers/environmental-runtime';
import type { EnvironmentalWorker } from '../../../web/src/workers/EnvironmentalSession';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisJson } from '../../../core/src/analysis-result';
import { serializeEnvironmentalDataset, type EnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';
import { parseAbundanceDataset, importAbundanceMetadata, createAbundanceAnalysisRecord, analyzeAbundanceDataset } from '../../../core/src/analysis/abundance';

const fixture = (): EnvironmentalDataset => ({ format: 'phage-explorer-environmental', version: 1,
  name: 'Independent arithmetic fixture', query: { id: 'query', label: 'Supplied query', accession: null },
  source: { kind: 'local', study: 'Synthetic arithmetic control', reference: null, version: '1', license: 'CC0' },
  measurement: { type: 'counts', method: 'Declared count assay', normalization: 'Equal-volume samples' },
  samples: [
    { id: 'detected', accession: null, biome: 'freshwater', country: null,
      location: { latitude: 0, longitude: 0, uncertaintyKm: 20 }, collectionDate: '2024-02', occurrence: 'detected', abundance: 8 },
    { id: 'zero', accession: null, biome: 'freshwater', country: 'Country without coordinates',
      location: null, collectionDate: '2024', occurrence: 'not-detected', abundance: 0 },
    { id: 'missing', accession: null, biome: 'soil', country: null,
      location: null, collectionDate: null, occurrence: 'not-assayed', abundance: null },
    { id: 'present', accession: null, biome: 'freshwater', country: null,
      location: null, collectionDate: null, occurrence: 'detected', abundance: null },
  ] });
const directory = () => mkdtemp(join(tmpdir(), 'phage-environment-'));
const missing = async (path: string) => assert.equal(await lstat(path).then(() => false, cause => cause.code === 'ENOENT'), true);
function capture() {
  let result = '';
  const stream = new Writable({ write(chunk, _encoding, done) { result += chunk.toString(); done(); } });
  return { stream, text: () => result };
}
function io(text = serializeEnvironmentalDataset(fixture()), factory?: EnvironmentalCommandIO['factory']) {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(text)]), stdout: out.stream, stderr: err.stream,
    output: out.text, errors: err.text, factory };
}
const entry = fileURLToPath(new URL('../index.tsx', import.meta.url));
async function run(args: string[], cwd: string, input = '') {
  const child = Bun.spawn([process.execPath, entry, 'environment', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(input); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('environmental native command and browser evidence parity', () => {
  it('accepts explicit source, analysis and exact-taxon commands without ambiguous overrides', () => {
    assert.equal(parseEnvironmentalCommand([]), null);
    assert.equal(parseEnvironmentalCommand(['--help']), null);
    assert.deepEqual(parseEnvironmentalCommand(['from-abundance', '-', '--taxon', ' Exact ID ', '--output', '-']),
      { operation: 'from-abundance', input: '-', taxon: ' Exact ID ', format: 'json', timeoutMs: 300000 });
    for (const args of [['unknown', 'x'], ['analyze'], ['analyze', 'x', 'y'], ['analyze', 'x', '--format', 'csv'],
      ['inspect', 'x', '--format', 'tsv'], ['replay', 'x', '--taxon', 'q'], ['from-abundance', 'x'],
      ['analyze', 'x', '--output', 'a', '--output', 'b'], ['analyze', 'x', '--timeout-ms', '0'],
      ['analyze', 'x', '--timeout-ms', '1e3'], ['analyze', 'x', '--timeout-ms', '3600001'],
      ['replay', 'x', '--params', 'p'], ['inspect', 'x', '--output', 'bad\npath']]) {
      assert.throws(() => parseEnvironmentalCommand(args));
    }
  });
  it('inspects a dataset without silently accepting or computing an analysis record', async () => {
    const streams = io(); assert.equal(await runEnvironmentalCommand(['inspect', '-'], streams), 0, streams.errors());
    assert.deepEqual(JSON.parse(streams.output()), fixture());
    const record = await executeEnvironmentalRequest({ kind: 'analyze', dataset: fixture() });
    const wrong = io(serializeAnalysisRecord(record.record!));
    assert.equal(await runEnvironmentalCommand(['inspect', '-'], wrong), 1);
    assert.equal(wrong.output(), '');
  });
  it('computes exact independent denominators and matches the browser producer identity', async () => {
    const streams = io(); assert.equal(await runEnvironmentalCommand(['analyze', '-'], streams), 0, streams.errors());
    const record = await parseAnalysisRecord(streams.output());
    const analysis = record.fields.environment.value as { totals: Record<string, number>; biomes: Array<Record<string, unknown>> };
    assert.deepEqual(analysis.totals, { samples: 4, assayed: 3, detected: 2, notDetected: 1, notAssayed: 1, located: 1, dated: 2 });
    assert.equal(analysis.biomes[0].detectionFraction, 2 / 3);
    assert.equal(analysis.biomes[0].meanAbundance, 4); // (8 + 0) / 2 measured counts, not 8 / 4.
    assert.equal(analysis.biomes[1].meanAbundance, null);
    const browser = await executeEnvironmentalRequest({ kind: 'analyze', dataset: fixture() });
    assert.equal(serializeAnalysisRecord(record), serializeAnalysisRecord(browser.record!));
    assert(!streams.errors().includes('Country without coordinates'));
    const replay = io(streams.output());
    assert.equal(await runEnvironmentalCommand(['replay', '-'], replay), 0, replay.errors());
    assert.equal(replay.output(), streams.output());
  });
  it('exports all sample rows with zero, missingness, partial dates and zero coordinates intact', async () => {
    const streams = io(); assert.equal(await runEnvironmentalCommand(['analyze', '-', '--format', 'tsv'], streams), 0, streams.errors());
    const rows = streams.output().split('\n').filter(line => line && !line.startsWith('#'));
    assert.equal(rows.length, 5);
    assert.match(rows[1], /^detected\t\tfreshwater\t\t0\t0\t20\t2024-02\tdetected\t8\tcounts$/);
    assert.match(rows[2], /^zero\t\tfreshwater\tCountry without coordinates\t\t\t\t2024\tnot-detected\t0\tcounts$/);
    assert.match(rows[3], /^missing\t\tsoil\t\t\t\t\t\tnot-assayed\t\tcounts$/);
  });
  it('rejects a correctly rehashed invented result before publishing any file', async () => {
    const { record } = await executeEnvironmentalRequest({ kind: 'analyze', dataset: fixture() });
    const fields = structuredClone(record!.fields);
    const result = fields.environment.value as Record<string, AnalysisJson>;
    (result.totals as Record<string, AnalysisJson>).detected = 999;
    const forged = await createAnalysisRecord({ ...record!, inputs: record!.inputs.map(({ sha256: _hash, ...input }) => input), fields });
    const output = join(await directory(), 'never-written.json'), streams = io(serializeAnalysisRecord(forged));
    assert.equal(await runEnvironmentalCommand(['replay', '-', '--output', output], streams), 1);
    assert.match(streams.errors(), /Recomputed environmental evidence differs/);
    assert.equal(streams.output(), ''); await missing(output);
  });
  it('derives an explicit abundance taxon with keyed metadata and verifies abundance records first', async () => {
    const abundance = importAbundanceMetadata('sampleId,habitat,latitude,longitude,collectionDate\ns3,soil,0,0,2024-03\ns1,marine,,,2024\n',
      parseAbundanceDataset('taxon,s1,s2,s3\nq,2,0,6\nother,6,2,2\n'));
    const streams = io(JSON.stringify(abundance));
    assert.equal(await runEnvironmentalCommand(['from-abundance', '-', '--taxon', 'q'], streams), 0, streams.errors());
    const dataset = JSON.parse(streams.output()) as EnvironmentalDataset;
    assert.equal(dataset.query.id, 'q');
    assert.deepEqual(dataset.samples.map(sample => sample.biome), ['marine', 'unknown', 'soil']);
    assert.deepEqual(dataset.samples.map(sample => sample.abundance), [2, 0, 6]);
    assert.equal(dataset.samples[2].location?.latitude, 0);
    const record = await createAbundanceAnalysisRecord(abundance, analyzeAbundanceDataset(abundance, { permutations: 19, numNiches: 1 }));
    const replay = io(serializeAnalysisRecord(record));
    assert.equal(await runEnvironmentalCommand(['from-abundance', '-', '--taxon', 'q'], replay), 0, replay.errors());
    assert.equal(replay.output(), streams.output());
    const absent = io(JSON.stringify(abundance));
    assert.equal(await runEnvironmentalCommand(['from-abundance', '-', '--taxon', 'Q'], absent), 1);
    assert.equal(absent.output(), '');
  });
  it('preserves existing files and rejects nonregular and malformed UTF-8 inputs', async () => {
    const dir = await directory(), existing = join(dir, 'existing.json'); await writeFile(existing, 'DO NOT REPLACE');
    const streams = io(); assert.equal(await runEnvironmentalCommand(['analyze', '-', '--output', existing], streams), 1);
    assert.equal(await readFile(existing, 'utf8'), 'DO NOT REPLACE');
    if (process.platform !== 'win32') {
      const link = join(dir, 'existing-link'); await symlink(existing, link);
      assert.equal(await runEnvironmentalCommand(['analyze', '-', '--output', link], io()), 1);
      const pipe = join(dir, 'fifo'); execFileSync('mkfifo', [pipe]);
      await assert.rejects(readEnvironmentalInput(pipe, new AbortController().signal), /regular UTF-8/);
    }
    await assert.rejects(readEnvironmentalInput(dir, new AbortController().signal), /regular UTF-8/);
    const invalid = join(dir, 'invalid-utf8.json'); await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readEnvironmentalInput(invalid, new AbortController().signal));
  });
  it('terminates an owned stalled worker on timeout and ignores a late response', async () => {
    let terminated = false; let native: EnvironmentalWorker | undefined;
    const streams = io(undefined, () => native = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage() {}, terminate() { terminated = true; },
    });
    const output = join(await directory(), 'timeout.json');
    assert.equal(await runEnvironmentalCommand(['analyze', '-', '--timeout-ms', '20', '--output', output], streams), 124);
    assert(terminated); assert.equal(native?.onmessage, null); assert.equal(streams.output(), ''); await missing(output);
  });
  it('cancels a stalled stdin read before starting any computation or publication', async () => {
    const input = new PassThrough(), controller = new AbortController(); let started = 0;
    const streams = io(undefined, () => { started++; throw new Error('Must not start'); });
    const pending = runEnvironmentalCommand(['analyze', '-'], { ...streams, stdin: input, signal: controller.signal });
    input.write('{'); controller.abort();
    assert.equal(await pending, 130); assert.equal(started, 0); assert.equal(streams.output(), '');
    assert.equal(input.listenerCount('data'), 0);
  });
  it('rejects a worker response bound to different samples', async () => {
    const altered = fixture(); altered.samples[0].abundance = 100;
    const result = await executeEnvironmentalRequest({ kind: 'analyze', dataset: altered });
    const factory = (): EnvironmentalWorker => {
      const worker: EnvironmentalWorker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {},
        postMessage(_request: EnvironmentalRequest) { queueMicrotask(() => worker.onmessage?.({ data: { kind: 'result', result } } as MessageEvent)); } };
      return worker;
    };
    await assert.rejects(runEnvironmentalRequest({ kind: 'analyze', dataset: fixture() }, new AbortController().signal, undefined, factory), /submitted dataset/);
  });
  it('routes the actual executable entry before catalog or terminal initialization', async () => {
    const dir = await directory();
    const analyzed = await run(['analyze', '-'], dir, serializeEnvironmentalDataset(fixture()));
    assert.equal(analyzed.code, 0, analyzed.stderr);
    const replay = await run(['replay', '-'], dir, analyzed.stdout);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.stdout, analyzed.stdout);
    const invalid = await run(['from-abundance', '-'], dir, 'taxon,s1\nq,2\n');
    assert.equal(invalid.code, 2); assert.equal(invalid.stdout, '');
    assert(!invalid.stderr.includes('database not found')); assert(!invalid.stderr.includes('raw mode'));
  });
});
