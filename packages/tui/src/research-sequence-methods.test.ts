import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { importLocalGenomes } from '../../core/src/genome-import';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { GC_SKEW_METHOD, createGCSkewRecord, exportGCSkewTsv, type GCSkewWindow } from '../../core/src/analysis/gc-skew';
import { createExactRepeatRecord, exportExactRepeatPairsTsv, type ExactRepeatPair } from '../../core/src/analysis/exact-repeat-pairs';
import { executeTerminalResearchRequest, validateTerminalResearchRequest, terminalAnalysisRequestSha256,
  type TerminalAnalysis, type TerminalResearchRequest, type TerminalAnalysisReport } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker } from '../../../scripts/research-workflow';

const gc: TerminalAnalysis = { method: 'gc-skew', windowSize: 4, stepSize: 4 };
const repeat = (topology: 'linear' | 'circular' = 'linear', maxPairs = 2000): TerminalAnalysis =>
  ({ method: 'exact-repeats', armLength: 4, maxGap: 20, maxPairs, topology });
const request = (sequence: string, analysis: TerminalAnalysis): Extract<TerminalResearchRequest, { type: 'analyze-experiment' }> =>
  ({ type: 'analyze-experiment', content: `>private\n${sequence}`, contentId: null, analysis, outputFormat: 'json' });
const run = (r: TerminalResearchRequest) => runTerminalResearchWorker(r, new AbortController().signal);
async function cli(args: string[]) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; });
  return { code, output, error };
}
async function resigned(record: AnalysisRecord, change: (r: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: copy.method, parameters: copy.parameters,
    seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _hash, ...input }) => input) }));
}
/** Brute-force all unordered arm-start pairs; no production index or coordinate helper. */
function repeatOracle(sequence: string, circular: boolean): ExactRepeatPair[] {
  const n = sequence.length, length = 4, pairs: ExactRepeatPair[] = [];
  const bases = (start: number) => Array.from({ length }, (_, i) => sequence[(start + i) % n]).join('');
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  for (let a = 0; a <= (circular ? n - 1 : n - length); a++) for (let b = a + 1; b <= (circular ? n - 1 : n - length); b++) {
    let left = a, right = b, distance = b - a;
    if (circular) {
      if (distance < length || n - distance < length) continue;
      if (n - distance < distance) { left = b; right = a; distance = n - distance; }
    }
    if (distance < length || distance - length > 20) continue;
    const first = bases(left), second = bases(right);
    if (!/^[ACGT]+$/.test(first + second)) continue;
    for (const type of ['direct', 'inverted'] as const) {
      const target = type === 'direct' ? second : Array.from(second).reverse().map(base => complement[base]).join('');
      if (first === target) pairs.push({ type, leftStart: left, leftEnd: left + length,
        rightStart: right, rightEnd: right + length, gap: distance - length });
    }
  }
  return pairs.sort((a, b) => a.rightStart - b.rightStart || (a.type === b.type ? b.gap - a.gap : a.type === 'direct' ? -1 : 1));
}

describe('native portable GC-skew and exact-repeat workflows', () => {
  it('resolves core defaults and accepts zero gaps without widening unrelated command grammars', () => {
    const base = ['analyze-experiment', '--input', 'input.fa'];
    const a = parseWorkflowCommand([...base, '--method', 'gc-skew', '--window', '12']);
    assert(a.type === 'analyze-experiment'); assert.deepEqual(a.analysis, { method: 'gc-skew', windowSize: 12, stepSize: 3 });
    const b = parseWorkflowCommand([...base, '--method', 'exact-repeats', '--topology', 'circular', '--max-gap', '0']);
    assert(b.type === 'analyze-experiment');
    assert.deepEqual(b.analysis, { method: 'exact-repeats', armLength: 8, maxGap: 0, maxPairs: 2000, topology: 'circular' });
    for (const [method, suffix] of [
      ['gc-skew', ['--bins', '2']], ['gc-skew', ['--topology', 'linear']], ['gc-skew', ['--step', '0']],
      ['gc-skew', ['--window', '1000001']], ['gc-skew', ['--step', '5000001']],
      ['exact-repeats', []], ['exact-repeats', ['--topology', 'linear', '--arm-length', '3']],
      ['exact-repeats', ['--topology', 'linear', '--max-gap', '-1']], ['exact-repeats', ['--topology', 'linear', '--max-gap', '1.5']],
      ['exact-repeats', ['--topology', 'linear', '--max-pairs', '20001']], ['exact-repeats', ['--topology', 'linear', '--window', '4']],
      ['dot-plot', ['--step', '4']], ['restriction-digest', ['--arm-length', '4']],
    ] as Array<[string, string[]]>) assert.throws(() => parseWorkflowCommand([...base, '--method', method, ...suffix]));
    assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', '--step', '4']));
  });

  it('rejects missing, null, string and unknown worker settings before execution', () => {
    for (const analysis of [
      { ...gc, windowSize: null }, { ...gc, stepSize: '4' }, { method: 'gc-skew', windowSize: 4 }, { ...gc, circular: true },
      { ...repeat(), maxGap: null }, { ...repeat(), maxPairs: NaN }, { ...repeat(), topology: undefined },
      { ...repeat(), comparisonBudget: 0 }, { ...repeat(), armLength: '4' },
    ]) assert.throws(() => validateTerminalResearchRequest({ ...request('ACGT', gc), analysis }));
  });

  it('computes literal GC counts and unavailable ratios in a real worker using the portable v2 method', async () => {
    const sequence = 'NNNNGGCCGGGG', result = await run(request(sequence, gc)); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!);
    assert.deepEqual(record.method, GC_SKEW_METHOD);
    assert.deepEqual(record.fields.windows.value, [
      { start: 0, end: 4, g: 0, c: 0, resolvedBases: 0, skew: null, cumulative: 0 },
      { start: 4, end: 8, g: 2, c: 2, resolvedBases: 4, skew: 0, cumulative: 1 },
      { start: 8, end: 12, g: 4, c: 0, resolvedBases: 4, skew: 1, cumulative: 1 },
    ]);
    assert.deepEqual(result.report.summary, { kind: 'gc-skew', sampledWindows: 3, definedSkewWindows: 2 });
    assert.equal(record.fields.originPosition.value, 0); assert.equal(record.fields.terminusPosition.value, 4);
    assert.deepEqual(record, await createGCSkewRecord(sequence, { windowSize: 4, stepSize: 4 }, { accession: 'private', source: 'local' }));
    assert(!('verified' in result.report)); assert(!JSON.stringify(result.report).includes(sequence));
  });

  it('counts overlapping and separated windows against an independent string oracle', async () => {
    const sequence = 'GCNATGGCCNTTAGGCCN';
    for (const stepSize of [1, 3, 7]) {
      const result = await run(request(sequence, { method: 'gc-skew', windowSize: 4, stepSize })); assert(result.type === 'experiment-analyzed');
      const expected: GCSkewWindow[] = [];
      for (let start = 0; start + 4 <= sequence.length; start += stepSize) {
        const s = sequence.slice(start, start + 4), g = Array.from(s).filter(b => b === 'G').length, c = Array.from(s).filter(b => b === 'C').length;
        expected.push({ start, end: start + 4, g, c, resolvedBases: Array.from(s).filter(b => 'ACGT'.includes(b)).length,
          skew: g + c === 0 ? null : (g - c) / (g + c), cumulative: Array.from(sequence.slice(0, start + 1)).reduce((n, b) => n + (b === 'G' ? 1 : b === 'C' ? -1 : 0), 0) });
      }
      assert.deepEqual((await parseAnalysisRecord(result.exportText!)).fields.windows.value, expected);
    }
  });

  it('retains no-GC and no-complete-window states instead of inventing measurements', async () => {
    for (const sequence of ['NNNNAAAA', 'GC']) {
      const result = await run(request(sequence, gc)); assert(result.type === 'experiment-analyzed');
      const record = await parseAnalysisRecord(result.exportText!);
      assert.deepEqual(result.report.summary, { kind: 'gc-skew', sampledWindows: sequence.length < 4 ? 0 : 2, definedSkewWindows: 0 });
      assert.equal(record.fields.originPosition.kind, 'unavailable'); assert.equal(record.fields.terminusPosition.kind, 'unavailable');
      if (sequence.length < 4) assert.deepEqual(record.fields.windows.value, []);
      else assert((record.fields.windows.value as unknown as GCSkewWindow[]).every(w => w.skew === null));
      const replay = await run({ type: 'replay-experiment', content: result.exportText!, outputFormat: 'tsv' }); assert(replay.type === 'experiment-replayed');
      assert.equal(replay.exportText, exportGCSkewTsv(record));
      if (sequence.length >= 4) assert(replay.exportText!.includes('0\t4\t0\t0\t0\t\t0\n'));
    }
  });

  it('enumerates linear fixed-arm direct and inverted pairs with an independent all-pairs oracle', async () => {
    const sequence = 'ACGTNACGTAAAATTTT', result = await run(request(sequence, repeat())); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!), pairs = repeatOracle(sequence, false);
    assert(pairs.some(p => p.type === 'direct')); assert(pairs.some(p => p.type === 'inverted'));
    assert.deepEqual(record.fields.pairs.value, pairs);
    assert.deepEqual(result.report.summary, { kind: 'exact-repeats', pairCount: pairs.length, complete: true, stoppedAtRightStart: null });
    assert.equal(record.method.version, '1'); assert(!('topology' in record.parameters));
    assert.deepEqual(record, await createExactRepeatRecord(sequence, { armLength: 4, maxGap: 20, maxPairs: 2000, topology: 'linear' }, { accession: 'private', source: 'local' }));
  });

  it('preserves origin-wrapping circular arms and canonical pair orientation through the native method', async () => {
    const sequence = 'ACGTACGTACGT', result = await run(request(sequence, repeat('circular'))); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!), pairs = repeatOracle(sequence, true);
    assert(pairs.some(p => p.leftEnd > sequence.length || p.rightEnd > sequence.length));
    assert.deepEqual(record.fields.pairs.value, pairs); assert.equal(record.method.version, '2');
    assert.equal(record.parameters.topology, 'circular');
    const replay = await run({ type: 'replay-experiment', content: result.exportText!, outputFormat: 'tsv' }); assert(replay.type === 'experiment-replayed');
    assert.equal(replay.exportText, exportExactRepeatPairsTsv(record)); assert.match(replay.exportText!, /\[\d+,12\);\[0,\d+\)/);
  });

  it('distinguishes a truncated prefix from a complete search exactly at the requested limit', async () => {
    for (const [sequence, complete] of [['AAAANAAAA', true], ['AAAAAAAAAAAA', false]] as const) {
      const result = await run(request(sequence, repeat('linear', 1))); assert(result.type === 'experiment-analyzed');
      assert.equal(result.report.summary?.kind, 'exact-repeats');
      assert.deepEqual(result.report.summary, { kind: 'exact-repeats', pairCount: 1, complete, stoppedAtRightStart: complete ? null : 5 });
      assert.match(result.report.interpretation, complete ? /Search completed/ : /truncated ordered prefix/);
      const replay = await run({ type: 'replay-experiment', content: result.exportText!, outputFormat: 'tsv' }); assert(replay.type === 'experiment-replayed');
      assert(replay.exportText!.includes(`complete=${complete}`));
    }
  });

  it('requires an explicit repeat topology, rejects source conflicts, and reports assumptions for unknown metadata', async () => {
    const r = request('ACGTACGT', repeat('circular'));
    const result = await run(r); assert(result.type === 'experiment-analyzed'); assert.match(result.report.interpretation, /unknown.*assumption/);
    await assert.rejects(run({ ...r, content: r.content.replace('>private', '>private [topology=linear]') }), /repeat topology conflicts/);
    const linearGc = await run({ ...request('NNNNGGCC', gc), content: '>private [topology=circular]\nNNNNGGCC' });
    assert(linearGc.type === 'experiment-analyzed'); assert.match(linearGc.report.interpretation, /Complete linear windows/);
  });

  it('preserves explicit content-based selection with same-accession records and changed-source rejection', async () => {
    const content = '>same\nAAAANAAAA\n>same\nNNNNGGCCGGGG';
    const { genomes } = await importLocalGenomes({ name: 'source.fa', text: content });
    await assert.rejects(run({ ...request('', gc), content }), /Select exactly one/);
    const r = { ...request('', gc), content, contentId: genomes[1].phage.localGenome!.contentId };
    const result = await run(r); assert(result.type === 'experiment-analyzed');
    assert.equal(result.report.genome.contentId, r.contentId); assert.equal((await parseAnalysisRecord(result.exportText!)).inputs[0].data, 'NNNNGGCCGGGG');
    await assert.rejects(run({ ...r, content: content.replace('GGGG', 'CCCC') }), /Select exactly one/);
  });

  it('writes portable JSON, replays it and produces identical direct/replayed TSV without overwriting files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-sequence-methods-'));
    for (const [name, sequence, options] of [
      ['gc', 'NNNNGGCCGGGG', ['--method', 'gc-skew', '--window', '4', '--step', '4']],
      ['linear', 'AAAANAAAA', ['--method', 'exact-repeats', '--arm-length', '4', '--max-gap', '20', '--topology', 'linear']],
      ['circular', 'ACGTACGTACGT', ['--method', 'exact-repeats', '--arm-length', '4', '--max-gap', '20', '--topology', 'circular']],
    ] as Array<[string, string, string[]]>) {
      const input = join(directory, `${name}.fa`), output = join(directory, `${name}.json`), table = join(directory, `${name}.tsv`), direct = join(directory, `${name}-direct.tsv`);
      await writeFile(input, `>private\n${sequence}`, { flag: 'wx' });
      const made = await cli(['analyze-experiment', '--input', input, ...options, '--output', output]); assert.equal(made.code, 0, made.error);
      const checked = await cli(['replay-experiment', '--input', output, '--output', table, '--format', 'tsv']); assert.equal(checked.code, 0, checked.error);
      assert.equal(JSON.parse(checked.output).resultId, JSON.parse(made.output).resultId);
      const tabulated = await cli(['analyze-experiment', '--input', input, ...options, '--output', direct, '--format', 'tsv']); assert.equal(tabulated.code, 0, tabulated.error);
      assert.equal(await readFile(direct, 'utf8'), await readFile(table, 'utf8'));
      const before = await readFile(output, 'utf8');
      const failed = await cli(['analyze-experiment', '--input', input, ...options, '--output', output]);
      assert.equal(failed.code, 1); assert.equal(failed.output, ''); assert.equal(await readFile(output, 'utf8'), before);
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
  });

  it('rejects validly rehashed false counts, repeat pairs, completeness and incompatible method versions', async () => {
    const counts = await createGCSkewRecord('NNNNGGCCGGGG', { windowSize: 4, stepSize: 4 });
    const pairs = await createExactRepeatRecord('AAAAAAAAAAAA', { armLength: 4, maxPairs: 1 }, { accession: 'catalog.1', source: 'catalog' });
    for (const [record, change] of [
      [counts, (r: AnalysisRecord) => { (r.fields.windows.value as unknown as GCSkewWindow[])[0].skew = 0; }],
      [counts, (r: AnalysisRecord) => { r.method.version = '1'; }],
      [pairs, (r: AnalysisRecord) => { r.fields.pairs.value = []; }],
      [pairs, (r: AnalysisRecord) => { (r.fields.search.value as { complete: boolean }).complete = true; }],
      [pairs, (r: AnalysisRecord) => { r.method.version = '999'; }],
    ] as Array<[AnalysisRecord, (r: AnalysisRecord) => void]>) {
      const content = await resigned(record, change); await parseAnalysisRecord(content);
      await assert.rejects(run({ type: 'replay-experiment', content, outputFormat: 'json' }));
    }
    const success = await run({ type: 'replay-experiment', content: serializeAnalysisRecord(pairs), outputFormat: 'json' });
    assert(success.type === 'experiment-replayed'); assert.equal(success.report.inputs[0].source, 'catalog');
    assert.equal(success.exportText, serializeAnalysisRecord(pairs));
  });

  it('rejects wrong method settings and missing or contradictory coverage reports at the parent boundary', async () => {
    for (const r of [request('NNNNGGCCGGGG', gc), request('AAAAAAAAAAAA', repeat('linear', 1))]) {
      const valid = await executeTerminalResearchRequest(r); assert(valid.type === 'experiment-analyzed');
      for (const change of [
        (report: TerminalAnalysisReport) => { report.summary = undefined; },
        (report: TerminalAnalysisReport) => { report.method.version = '999'; },
        (report: TerminalAnalysisReport) => { report.parameters.extra = 1; },
        (report: TerminalAnalysisReport) => {
          if (report.summary?.kind === 'gc-skew') report.summary.definedSkewWindows = 999;
          else if (report.summary?.kind === 'exact-repeats') report.summary.complete = true;
        },
      ]) {
        const fake = structuredClone(valid); change(fake.report);
        await assert.rejects(runTerminalResearchWorker(r, new AbortController().signal, undefined,
          () => new Worker(`require('node:worker_threads').parentPort.once('message',()=>require('node:worker_threads').parentPort.postMessage(${JSON.stringify(fake)}))`, { eval: true })), /Unexpected/);
      }
    }
  });

  it('binds every numerical option to the request identity and rejects excessive GC output before creating a file', async () => {
    const r = request('ACGTACGT', gc);
    const first = terminalAnalysisRequestSha256(r);
    assert.notEqual(first, terminalAnalysisRequestSha256({ ...r, analysis: { method: 'gc-skew', windowSize: 4, stepSize: 2 } }));
    const repeats = request('ACGTACGT', repeat());
    const hash = terminalAnalysisRequestSha256(repeats);
    assert.notEqual(hash, terminalAnalysisRequestSha256({ ...repeats, analysis: repeat('circular') }));
    assert.notEqual(hash, terminalAnalysisRequestSha256({ ...repeats, analysis: repeat('linear', 1) }));
    const directory = await mkdtemp(join(tmpdir(), 'phage-gc-limit-')), input = join(directory, 'source.fa'), output = join(directory, 'not-created.json');
    await writeFile(input, '>large\n' + 'G'.repeat(20001));
    const failed = await cli(['analyze-experiment', '--input', input, '--method', 'gc-skew', '--window', '1', '--step', '1', '--output', output]);
    assert.equal(failed.code, 1); assert.equal(failed.output, ''); assert.match(failed.error, /20,000 windows/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });

  it('reconciles claimed completeness with exported JSON before creating an output file', async () => {
    const r = request('AAAAAAAAAAAA', repeat('linear', 1));
    const result = await executeTerminalResearchRequest(r); assert(result.type === 'experiment-analyzed');
    // The summary alone is shape-valid, but contradicts the real saved search.
    result.report.summary = { kind: 'exact-repeats', complete: true, pairCount: 1, stoppedAtRightStart: null };
    const directory = await mkdtemp(join(tmpdir(), 'phage-false-completeness-'));
    const input = join(directory, 'source.fa'), output = join(directory, 'not-written.json');
    await writeFile(input, r.content);
    let out = '', error = '';
    const code = await researchWorkflowMain(['analyze-experiment', '--input', input, '--method', 'exact-repeats',
      '--topology', 'linear', '--arm-length', '4', '--max-gap', '20', '--max-pairs', '1', '--output', output],
    text => { out += text; }, text => { error += text; }, {
      createWorker: () => new Worker(`require('node:worker_threads').parentPort.once('message',()=>require('node:worker_threads').parentPort.postMessage(${JSON.stringify(result)}))`, { eval: true }),
    });
    assert.equal(code, 1); assert.equal(out, ''); assert.match(error, /selected source or reported experiment/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });
});
