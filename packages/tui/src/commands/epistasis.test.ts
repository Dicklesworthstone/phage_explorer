import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import {
  parseEpistasisCommand, parseEpistasisCommandInput, runEpistasisCommand, readEpistasisInput, type EpistasisCommandIO,
} from './epistasis';
import { executeEpistasisEvidenceRequest } from '../../../web/src/workers/EpistasisEvidenceSession';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { validateEpistasisAssayDataset, type EpistasisAssayDataset, type EpistasisAssayResult } from '../../../core/src/analysis/epistasis-evidence';

const fixture = (): EpistasisAssayDataset => ({
  format: 'phage-explorer-epistasis-assay', version: 1, name: 'PRIVATE_ASSAY_NATIVE',
  source: { kind: 'local', description: 'Artificial hand-computed unit-test measurements.', reference: null, license: 'CC0' },
  protein: { id: 'PRIVATE_PROTEIN_NATIVE', accession: null, sequence: 'ACDE' },
  assay: { name: 'Response fixture', units: 'response units', conditions: 'Three independent measurement units per genotype.',
    scale: 'identity', replicateDesign: 'independent' },
  observations: [
    ...[10, 12, 14].map((value, i) => ({ variant: 'WT', replicateId: 'r' + i, value })),
    ...[8, 9, 10].map((value, i) => ({ variant: 'A1G', replicateId: 'r' + i, value })),
    ...[11, 13, 15].map((value, i) => ({ variant: 'C2T', replicateId: 'r' + i, value })),
    ...[10, 14, 18].map((value, i) => ({ variant: 'A1G:C2T', replicateId: 'r' + i, value })),
    { variant: 'A1G:D3E', replicateId: 'only-double', value: 5 },
  ],
});
const directory = () => mkdtemp(join(tmpdir(), 'phage-epistasis-'));
const missing = async (path: string) => assert.equal(await lstat(path).then(() => false, cause => cause.code === 'ENOENT'), true);
function capture() {
  let result = '';
  const stream = new Writable({ write(chunk, _encoding, done) { result += chunk.toString(); done(); } });
  return { stream, text: () => result };
}
function io(text = JSON.stringify(fixture()), factory?: EpistasisCommandIO['factory']) {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(text)]), stdout: out.stream, stderr: err.stream,
    output: out.text, errors: err.text, factory };
}
const entry = fileURLToPath(new URL('../index.tsx', import.meta.url));
async function run(args: string[], cwd: string, input = '') {
  const child = Bun.spawn([process.execPath, entry, 'epistasis', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    child.stdin.write(input); child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

describe('native measured epistasis command', () => {
  it('requires explicit inputs and rejects ambiguous replay, table and numeric overrides', () => {
    assert.equal(parseEpistasisCommand([]), null); assert.equal(parseEpistasisCommand(['--help']), null);
    assert.deepEqual(parseEpistasisCommand(['analyze', '-', '--bootstrap-samples', '0', '--seed', '0', '--output', '-']),
      { operation: 'analyze', input: '-', format: 'json', section: 'pairs', options: { bootstrapSamples: 0, seed: 0 }, timeoutMs: 300000 });
    const replay = parseEpistasisCommand(['replay', 'record.json', '--format', 'tsv', '--section', 'observations']);
    assert.equal(replay!.options, null); assert.equal(replay!.section, 'observations');
    for (const args of [
      ['unknown', 'x'], ['analyze'], ['analyze', 'x', 'extra'], ['analyze', 'x', '--seed', ''],
      ['analyze', 'x', '--seed', '-1'], ['analyze', 'x', '--seed', '4294967296'],
      ['analyze', 'x', '--bootstrap-samples', '1e3'], ['analyze', 'x', '--bootstrap-samples', '199'],
      ['analyze', 'x', '--bootstrap-samples', '2001'], ['inspect', 'x', '--seed', '1'], ['replay', 'x', '--seed', '1'],
      ['replay', 'x', '--metadata', 'm.json'], ['inspect', 'x', '--metadata', '-'],
      ['analyze', 'x', '--section', 'observations'], ['analyze', 'x', '--format', 'csv'],
      ['inspect', 'x', '--format', 'tsv'], ['analyze', 'x', '--format', 'tsv', '--section', 'partial'],
      ['analyze', 'x', '--timeout-ms', '0'], ['analyze', 'x', '--timeout-ms', '3600001'],
      ['analyze', 'x', '--output', 'a', '--output', 'b'], ['inspect', 'x', '--output', 'bad\npath'],
    ]) assert.throws(() => parseEpistasisCommand(args), args.join(' '));
  });

  it('inspects complete canonical observations without accepting an analysis record as raw data', async () => {
    const streams = io();
    assert.equal(await runEpistasisCommand(['inspect', '-'], streams), 0, streams.errors());
    assert.deepEqual(JSON.parse(streams.output()), validateEpistasisAssayDataset(fixture()));
    const analysis = await executeEpistasisEvidenceRequest({ kind: 'analyze', dataset: fixture(), options: { bootstrapSamples: 0, seed: 0 } });
    const wrong = io(serializeAnalysisRecord(analysis.record!));
    assert.equal(await runEpistasisCommand(['inspect', '-'], wrong), 1); assert.equal(wrong.output(), '');
  });

  it('matches browser evidence exactly and freshly replays it through native workers', async () => {
    const streams = io();
    assert.equal(await runEpistasisCommand(['analyze', '-', '--bootstrap-samples', '0', '--seed', '0'], streams), 0, streams.errors());
    const record = await parseAnalysisRecord(streams.output()), result = record.fields.result.value as unknown as EpistasisAssayResult;
    assert.equal(result.pairs[0].contrast, 4);
    assert.ok(Math.abs(result.pairs[0].standardError! - Math.sqrt(25 / 3)) < 1e-12);
    assert.equal(result.pairs[1].contrast, null); assert.deepEqual(result.pairs[1].missingVariants, ['D3E']);
    const browser = await executeEpistasisEvidenceRequest({ kind: 'analyze', dataset: fixture(), options: { bootstrapSamples: 0, seed: 0 } });
    assert.equal(serializeAnalysisRecord(record), serializeAnalysisRecord(browser.record!));
    assert(!streams.errors().includes('PRIVATE_'));
    const replay = io(streams.output());
    assert.equal(await runEpistasisCommand(['replay', '-'], replay), 0, replay.errors());
    assert.equal(replay.output(), streams.output());
  });

  it('converts CSV only with explicit metadata and preserves every observation in both complete exports', async () => {
    const dataset = fixture(), { observations, ...metadata } = dataset;
    const csv = 'variant,replicate_id,value\n' + observations.map(row => [row.variant, row.replicateId, row.value].join(',')).join('\n') + '\n';
    assert.deepEqual(parseEpistasisCommandInput(csv, JSON.stringify(metadata)), validateEpistasisAssayDataset(dataset));
    assert.throws(() => parseEpistasisCommandInput(csv));
    assert.throws(() => parseEpistasisCommandInput(csv, JSON.stringify(dataset)), /without an observations field/);
    const incomplete = structuredClone(metadata) as unknown as Record<string, unknown>; delete incomplete.assay;
    assert.throws(() => parseEpistasisCommandInput(csv, JSON.stringify(incomplete)));
    const dir = await directory(), metadataPath = join(dir, 'metadata.json'); await writeFile(metadataPath, JSON.stringify(metadata));
    const pairs = io(csv);
    assert.equal(await runEpistasisCommand(['analyze', '-', '--metadata', metadataPath, '--bootstrap-samples', '0', '--format', 'tsv'], pairs), 0, pairs.errors());
    const pairRows = pairs.output().trimEnd().split('\n').filter(row => !row.startsWith('#'));
    assert.equal(pairRows.length, 3);
    assert.deepEqual(pairRows[1].split('\t').slice(5, 9), ['estimated', '14', '10', '4']);
    const all = io(csv);
    assert.equal(await runEpistasisCommand(['analyze', '-', '--metadata', metadataPath, '--bootstrap-samples', '0',
      '--format', 'tsv', '--section', 'observations'], all), 0, all.errors());
    assert.equal(all.output().trimEnd().split('\n').filter(row => !row.startsWith('#')).length, observations.length + 1);
    assert(all.output().includes('only-double'));
  });

  it('refuses rehashed invented evidence before publishing any output file', async () => {
    const first = await executeEpistasisEvidenceRequest({ kind: 'analyze', dataset: fixture(), options: { bootstrapSamples: 0, seed: 0 } });
    const forged = structuredClone(first.record!);
    (forged.fields.result.value as unknown as EpistasisAssayResult).pairs[0].contrast = 999;
    const changed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...input }) => input) });
    const output = join(await directory(), 'never-published.json'), streams = io(serializeAnalysisRecord(changed));
    assert.equal(await runEpistasisCommand(['replay', '-', '--output', output], streams), 1);
    assert.match(streams.errors(), /differs/); assert.equal(streams.output(), ''); await missing(output);
  });

  it('preserves existing files and rejects devices, directories and malformed UTF-8', async () => {
    const dir = await directory(), existing = join(dir, 'existing.json'); await writeFile(existing, 'KEEP');
    assert.equal(await runEpistasisCommand(['analyze', '-', '--output', existing], io()), 1);
    assert.equal(await readFile(existing, 'utf8'), 'KEEP');
    if (process.platform !== 'win32') {
      const link = join(dir, 'existing-link'); await symlink(existing, link);
      assert.equal(await runEpistasisCommand(['analyze', '-', '--output', link], io()), 1);
      const fifo = join(dir, 'fifo'); execFileSync('mkfifo', [fifo]);
      await assert.rejects(readEpistasisInput(fifo, new AbortController().signal), /regular UTF-8/);
    }
    await assert.rejects(readEpistasisInput(dir, new AbortController().signal), /regular UTF-8/);
    const invalid = join(dir, 'invalid-utf8.json'); await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readEpistasisInput(invalid, new AbortController().signal));
    const streams = io(), output = join(dir, 'private-evidence.json');
    assert.equal(await runEpistasisCommand(['analyze', '-', '--bootstrap-samples', '0', '--output', output], streams), 0, streams.errors());
    assert.equal(streams.output(), '');
    if (process.platform !== 'win32') assert.equal((await lstat(output)).mode & 0o777, 0o600);
    await parseAnalysisRecord(await readFile(output, 'utf8'));
  });

  it('cancels stalled stdin and times out owned workers before any publication', async () => {
    const input = new PassThrough(), controller = new AbortController(); let started = 0;
    const streams = io(undefined, () => { started++; throw new Error('Must not start'); });
    const pending = runEpistasisCommand(['analyze', '-'], { ...streams, stdin: input, signal: controller.signal });
    input.write('{'); controller.abort();
    assert.equal(await pending, 130); assert.equal(started, 0); assert.equal(streams.output(), '');
    assert.equal(input.listenerCount('data'), 0);
    let terminated = false;
    const stalled = io(undefined, () => ({ onmessage: null, onerror: null, onmessageerror: null,
      postMessage() {}, terminate() { terminated = true; } }));
    const output = join(await directory(), 'timeout.json');
    assert.equal(await runEpistasisCommand(['analyze', '-', '--timeout-ms', '100', '--output', output], stalled), 124);
    assert(terminated); assert.equal(stalled.output(), ''); await missing(output);
  });

  it('routes the executable entry before catalog, UI and raw terminal initialization', async () => {
    const cwd = await directory();
    const first = await run(['analyze', '-', '--bootstrap-samples', '0', '--seed', '0'], cwd, JSON.stringify(fixture()));
    assert.equal(first.code, 0, first.stderr); await parseAnalysisRecord(first.stdout);
    const replay = await run(['replay', '-'], cwd, first.stdout);
    assert.equal(replay.code, 0, replay.stderr); assert.equal(replay.stdout, first.stdout);
    const invalid = await run(['replay', '-', '--seed', '1'], cwd);
    assert.equal(invalid.code, 2); assert.equal(invalid.stdout, '');
    assert(!invalid.stderr.includes('database not found')); assert(!invalid.stderr.includes('raw mode'));
  });
});
