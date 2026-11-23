import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createCompatibilityExperiment, exportCompatibilityPairsTsv, replayCompatibilityExperiment, type CompatibilityInput,
  type CompatibilityResult } from '../../../core/src/analysis/alignment-compatibility';
import { executeCompatibilityJob, parseCompatibilityCommand, runCompatibilityCommand, runCompatibilityJob,
  type CompatibilityJob } from './alignment-compatibility';
import { executableBuildOptions, executableCompileArgs } from '../../../../scripts/build';

// Original columns: mono, missing, eligible, eligible, singleton, multiallelic.
// Eligible columns contain AA, AG, GA, GG once each, independently of exclusions.
const fasta = '>taxon_d\r\naaggat\r\n>taxon_b\r\naaagac\r\n>taxon_a\r\nanaaca\r\n>taxon_c\r\naagaag\r\n';
const metadata = { name: 'Exact four-taxon fixture',
  source: { kind: 'demo' as const, reference: 'Hand-counted synthetic alignment · α', version: 'fixture-1', license: 'CC0' },
  alignment: { homologous: true as const, method: 'Constructed columns', reference: 'Explicit four-gamete control' } };
const input: CompatibilityInput = { format: 'phage-explorer-alignment-compatibility', version: 1, ...metadata,
  alignment: { ...metadata.alignment, fasta } };
const inputText = JSON.stringify(input);
const prepareOptions = ['--name', metadata.name, '--source-kind', 'demo', '--source-reference', metadata.source.reference,
  '--source-version', metadata.source.version, '--license', metadata.source.license, '--alignment-method', metadata.alignment.method,
  '--alignment-reference', metadata.alignment.reference, '--homologous'];
function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { stream, text: () => text };
}
function io(content = '') {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(content)]), stdout: out.stream, stderr: err.stream, output: out.text, errors: err.text };
}
async function processRun(args: string[], cwd: string, content = '') {
  const entry = fileURLToPath(new URL('../index.tsx', import.meta.url));
  const child = Bun.spawn([process.execPath, entry, 'alignment-compatibility', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(content); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('native exact aligned-DNA compatibility', () => {
  it('requires source declarations, unambiguous original intervals and immutable replay parameters', () => {
    assert.equal(parseCompatibilityCommand([]), null);
    const prepare = parseCompatibilityCommand(['prepare', '-', ...prepareOptions]);
    assert.equal(prepare?.operation, 'prepare');
    if (prepare?.operation !== 'prepare') throw new Error('Expected prepare');
    assert.deepEqual(prepare.metadata, metadata);
    assert.deepEqual(parseCompatibilityCommand(['analyze', 'input.json', '--start', '2', '--end', '4', '--format', 'pairs']),
      { operation: 'analyze', input: 'input.json', output: undefined, options: { start: 2, end: 4 }, format: 'pairs' });
    assert.throws(() => parseCompatibilityCommand(['prepare', '-', ...prepareOptions.filter(option => option !== '--homologous')]), /homologous/);
    assert.throws(() => parseCompatibilityCommand(['prepare', '-']), /requires/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--start', '1']), /both/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--start', '1e0', '--end', '4']), /integer/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--start', '4', '--end', '4']), /nonempty/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--end', '4', '--end', '5']), /duplicate/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--format', 'csv']), /format/);
    assert.throws(() => parseCompatibilityCommand(['inspect', '-', '--format', 'sites']), /Unsupported/);
    assert.throws(() => parseCompatibilityCommand(['replay', '-', '--start', '2', '--end', '4']), /override/);
    assert.throws(() => parseCompatibilityCommand(['replay', '-', '--source-kind', 'demo']), /override/);
    assert.throws(() => parseCompatibilityCommand(['analyze', '-', '--output', ' ']), /empty/);
  });

  it('prepares exact UTF-8 source text and inspects dimensions without pair analysis or raw sequences', async () => {
    const prepared = await runCompatibilityJob({ operation: 'prepare', content: fasta, metadata });
    assert.deepEqual(JSON.parse(prepared.content), input);
    assert.equal(prepared.recordJson, null); assert.equal(prepared.verified, false);
    const inspected = await runCompatibilityJob({ operation: 'inspect', content: prepared.content });
    const summary = JSON.parse(inspected.content);
    assert.deepEqual(summary.taxa, ['taxon_a', 'taxon_b', 'taxon_c', 'taxon_d']);
    assert.equal(summary.columns, 6); assert.equal(summary.analysisPerformed, false);
    assert.equal(summary.source.reference, metadata.source.reference);
    assert.match(summary.inputSha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.alignment.fasta, undefined);
    assert.equal(summary.pairs, undefined);
    assert(!inspected.content.includes('anaaca'));
    const excessive = { ...input, alignment: { ...input.alignment,
      fasta: ['A', 'A', 'G', 'G'].map((base, index) => `>t${index}\n${base.repeat(257)}`).join('\n') } };
    assert.equal(JSON.parse((await runCompatibilityJob({ operation: 'inspect', content: JSON.stringify(excessive) })).content).columns, 257);
    await assert.rejects(runCompatibilityJob({ operation: 'analyze', content: JSON.stringify(excessive), format: 'json' }), /256 eligible/);
    await assert.rejects(runCompatibilityJob({ operation: 'prepare', content: '>a\nAA\n>b\nAG\n>c\nGG\n', metadata }), /four aligned taxa/);
  });

  it('normalizes only the UTF-8 encoding marker before preserving prepared sequence text', async () => {
    const streams = io('\uFEFF' + fasta);
    assert.equal(await runCompatibilityCommand(['prepare', '-', ...prepareOptions], { ...streams, execute: executeCompatibilityJob }), 0, streams.errors());
    assert.equal(JSON.parse(streams.output()).alignment.fasta, fasta);
  });

  it('uses the actual native worker and browser producer with hand-counted exclusions and original-coordinate exports', async () => {
    const native = await runCompatibilityJob({ operation: 'analyze', content: inputText, format: 'json' });
    const defaultInterval = await executeCompatibilityJob({ operation: 'analyze', content: inputText, options: undefined, format: 'json' });
    assert.equal(defaultInterval.content, native.content);
    assert.equal(defaultInterval.requestSha256, native.requestSha256);
    const browser = await createCompatibilityExperiment(input);
    assert.equal(native.content.trimEnd(), serializeAnalysisRecord(browser.record));
    const result = browser.result;
    assert.deepEqual(result.excluded, { missing: [1], monomorphic: [0], multiallelic: [5], singleton: [4] });
    assert.deepEqual(result.sites.map(site => site.column), [2, 3]);
    assert.deepEqual(result.pairs, [[0, 1, 1, 1, 1, 1]]);
    assert.equal(result.coverage.incompatiblePairs, 1);
    assert.equal((await replayCompatibilityExperiment(native.content)).record.resultId, browser.record.resultId);
    const replay = await runCompatibilityJob({ operation: 'replay', content: native.content, format: 'json' });
    assert.equal(replay.content, native.content); assert.equal(replay.verified, true);
    const sites = io(inputText);
    assert.equal(await runCompatibilityCommand(['analyze', '-', '--start', '2', '--end', '4', '--format', 'sites'], sites), 0, sites.errors());
    assert.match(sites.output(), /3\teligible\t2\t0\t2\t0\t0\n4\teligible\t2\t0\t2\t0\t0\n$/);
    const pairs = io(inputText);
    assert.equal(await runCompatibilityCommand(['analyze', '-', '--start', '2', '--end', '4', '--format', 'pairs'], pairs), 0, pairs.errors());
    assert.match(pairs.output(), /3\t4\tA\tG\tA\tG\t1\t1\t1\t1\tyes\n$/);
    assert.equal(pairs.output().split('\n').filter(line => /^\d/.test(line)).length, 1);
  });

  it('recomputes hash-valid false numerical evidence and publishes no file on failure', async () => {
    const experiment = await createCompatibilityExperiment(input), original = experiment.record;
    const fields = structuredClone(original.fields), result = fields.compatibility.value as unknown as CompatibilityResult;
    result.pairs[0] = [0, 1, 2, 0, 0, 2];
    result.coverage.incompatiblePairs = 0; result.status = 'no-incompatibility-observed';
    const forged = await createAnalysisRecord({ method: original.method,
      inputs: original.inputs.map(({ id, accession, source, description, data }) => ({ id, accession, source, description, data })),
      parameters: original.parameters, seed: original.seed, references: original.references, fields });
    const content = serializeAnalysisRecord(forged);
    await parseAnalysisRecord(content); // Valid hashes alone cannot verify a calculation.
    const directory = await mkdtemp(join(tmpdir(), 'phage-compatibility-forgery-')), destination = join(directory, 'rejected.json');
    const streams = io(content);
    assert.equal(await runCompatibilityCommand(['replay', '-', '--output', destination], streams), 1);
    assert.match(streams.errors(), /Fresh aligned-site calculation differs/); assert.equal(streams.output(), '');
    await assert.rejects(stat(destination), /ENOENT/);
  });

  it('rejects output from another request and table bytes detached from accepted evidence', async () => {
    const other = await executeCompatibilityJob({ operation: 'analyze', content: inputText, options: { start: 2, end: 3 }, format: 'json' });
    const streams = io(inputText);
    assert.equal(await runCompatibilityCommand(['analyze', '-'], { ...streams, execute: async () => other }), 1);
    assert.match(streams.errors(), /Unbound/); assert.equal(streams.output(), '');
    const table = io(inputText);
    assert.equal(await runCompatibilityCommand(['analyze', '-', '--format', 'pairs'], { ...table,
      execute: async job => ({ ...await executeCompatibilityJob(job), content: 'invented table\n' }) }), 1);
    assert.match(table.errors(), /export differs/); assert.equal(table.output(), '');
    await assert.rejects(executeCompatibilityJob({ operation: 'replay', content: '{}', format: 'json', options: { start: 0, end: 1 } } as unknown as CompatibilityJob), /cannot override/);
  });

  it('rejects hash-valid malformed worker evidence before publishing JSON or pair tables', async () => {
    const original = await createCompatibilityExperiment(input);
    const corruptions: Array<[string, (result: CompatibilityResult) => void]> = [
      ['negative haplotype counts', result => { result.pairs[0] = [0, 1, -1, 1, 1, 3]; }],
      ['conserved total but wrong site marginals', result => { result.pairs[0] = [0, 1, 3, 1, 0, 0]; }],
      ['different taxa', result => { result.taxa[0] = 'not_in_the_alignment'; }],
      ['assignments detached from source bases', result => { result.sites[0].assignments = '0101'; }],
      ['inconsistent coverage', result => { result.coverage.incompatiblePairs = 0; }],
      ['inconsistent status', result => { result.status = 'no-incompatibility-observed'; }],
      ['reversed pair indexes', result => { result.pairs[0][0] = 1; result.pairs[0][1] = 0; }],
      ['duplicate excluded coordinate', result => { result.excluded.missing.push(4); }],
      ['informative sites falsely excluded as monomorphic', result => {
        result.sites = []; result.pairs = []; result.excluded.monomorphic = [0, 2, 3];
        result.coverage.eligibleColumns = 0; result.coverage.comparedPairs = 0; result.coverage.incompatiblePairs = 0;
        result.status = 'insufficient-sites';
      }],
    ];
    for (const format of ['json', 'pairs'] as const) {
      const valid = await executeCompatibilityJob({ operation: 'analyze', content: inputText, format });
      for (const [label, corrupt] of corruptions) {
        const fields = structuredClone(original.record.fields), result = fields.compatibility.value as unknown as CompatibilityResult;
        corrupt(result);
        const record = await createAnalysisRecord({ method: original.record.method,
          inputs: original.record.inputs.map(({ id, accession, source, description, data }) => ({ id, accession, source, description, data })),
          parameters: original.record.parameters, seed: original.record.seed, references: original.record.references, fields });
        const recordJson = serializeAnalysisRecord(record);
        await parseAnalysisRecord(recordJson); // Rehashed transport remains structurally valid generic evidence.
        const content = format === 'json' ? recordJson + '\n' : exportCompatibilityPairsTsv({ ...original, result, record });
        const streams = io(inputText);
        assert.equal(await runCompatibilityCommand(['analyze', '-', '--format', format], { ...streams,
          execute: async () => ({ ...valid, content, recordJson }) }), 1, label);
        assert.equal(streams.output(), '', label);
        assert.match(streams.errors(), /haplotypes|taxa|assignments|summary|coordinate|classification/i, label);
      }
    }
  });

  it('runs the real launcher without a catalog and preserves existing files and private output mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-compatibility-cli-'));
    const source = join(directory, 'aligned.fa'), preparedPath = join(directory, 'input.json'), resultPath = join(directory, 'result.json');
    await writeFile(source, fasta);
    const prepared = await processRun(['prepare', source, ...prepareOptions, '--output', preparedPath], directory);
    assert.equal(prepared.code, 0, prepared.stderr); assert.equal(prepared.stdout, '');
    const contents = await readFile(preparedPath, 'utf8'); assert.deepEqual(JSON.parse(contents), input);
    const inspected = await processRun(['inspect', '-'], directory, contents);
    assert.equal(inspected.code, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).columns, 6);
    const analyzed = await processRun(['analyze', preparedPath, '--start', '2', '--end', '4', '--output', resultPath], directory);
    assert.equal(analyzed.code, 0, analyzed.stderr); assert.equal(analyzed.stdout, '');
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    const record = await readFile(resultPath, 'utf8');
    assert.deepEqual((await replayCompatibilityExperiment(record)).options, { start: 2, end: 4 });
    const replay = await processRun(['replay', '-', '--format', 'pairs'], directory, record);
    assert.equal(replay.code, 0, replay.stderr); assert.match(replay.stdout, /3\t4\tA\tG\tA\tG\t1\t1\t1\t1\tyes/);
    const overwrite = await processRun(['analyze', preparedPath, '--output', resultPath], directory);
    assert.equal(overwrite.code, 1); assert.match(overwrite.stderr, /already exists/);
    assert.equal(await readFile(resultPath, 'utf8'), record);
    const bad = await processRun(['replay', resultPath, '--end', '4'], directory);
    assert.equal(bad.code, 2); assert.equal(bad.stdout, '');
  }, 15000);

  it('rejects malformed/oversized UTF-8 inputs without executing the worker', async () => {
    let executions = 0;
    const streams = io(), invalid = Readable.from([Buffer.from([0xc3, 0x28])]);
    assert.equal(await runCompatibilityCommand(['inspect', '-'], { ...streams, stdin: invalid,
      execute: async job => { executions++; return executeCompatibilityJob(job); } }), 1);
    assert.equal(executions, 0); assert.equal(streams.output(), '');
    const large = io(' '.repeat(2 * 1024 * 1024 + 1));
    assert.equal(await runCompatibilityCommand(['inspect', '-'], { ...large,
      execute: async job => { executions++; return executeCompatibilityJob(job); } }), 1);
    assert.equal(executions, 0); assert.match(large.errors(), /limit/);
  });

  it('cancels active native computation and stalled stdin before output publication', async () => {
    const controller = new AbortController();
    const pending = runCompatibilityJob({ operation: 'analyze', content: inputText, format: 'json' }, controller.signal);
    controller.abort(); await assert.rejects(pending, /cancelled/);
    const directory = await mkdtemp(join(tmpdir(), 'phage-compatibility-cancel-')), destination = join(directory, 'not-written.json');
    const streams = io(), blocked = new PassThrough(), stopped = new AbortController();
    const command = runCompatibilityCommand(['analyze', '-', '--output', destination], { ...streams, stdin: blocked, signal: stopped.signal });
    const timer = setTimeout(() => stopped.abort(), 10);
    try { assert.equal(await command, 130); } finally { clearTimeout(timer); blocked.end(); }
    assert.equal(streams.output(), ''); await assert.rejects(stat(destination), /ENOENT/);
  });

  for (const phase of ['stdout', 'stderr', 'help'] as const) {
    it(`cancels a blocked ${phase} write without waiting for its callback`, async () => {
      const streams = io(inputText), controller = new AbortController();
      let release: ((cause?: Error | null) => void) | undefined;
      let started!: () => void;
      const writing = new Promise<void>(resolve => { started = resolve; });
      const blocked = new Writable({ write(_chunk, _encoding, done) { release = done; started(); } });
      const command = runCompatibilityCommand(phase === 'help' ? ['--help'] : ['analyze', '-'], {
        ...streams, signal: controller.signal, execute: executeCompatibilityJob,
        stdout: phase === 'stderr' ? streams.stdout : blocked, stderr: phase === 'stderr' ? blocked : streams.stderr,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await writing; controller.abort();
        const code = await Promise.race([command, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Cancellation waited for a blocked write.')), 1000);
        })]);
        assert.equal(code, 130); release?.(); release = undefined;
        assert.equal(await command, 130); assert.equal(blocked.listenerCount('error'), 0);
      } finally { clearTimeout(timer); release?.(); blocked.end(); }
    });
  }

  (process.env.PHAGE_INTEGRATION === '1' ? it : it.skip)('compiled standalone executable analyzes and replays using its embedded worker without a catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-compatibility-executable-'));
    const bundles = join(directory, 'bundles'), isolated = join(directory, 'isolated'), empty = join(directory, 'empty');
    await mkdir(isolated); await mkdir(empty);
    const build = await Bun.build(executableBuildOptions(bundles));
    assert.equal(build.success, true, build.logs.map(log => String(log)).join('\n'));
    const executable = join(isolated, 'phage-explorer');
    const compile = executableCompileArgs(bundles, executable); compile[0] = process.execPath;
    const compilation = Bun.spawn(compile, { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
    const [compileCode, buildOutput, buildError] = await Promise.all([compilation.exited,
      new Response(compilation.stdout).text(), new Response(compilation.stderr).text()]);
    assert.equal(compileCode, 0, buildOutput + buildError);
    const run = async (args: string[], content: string) => {
      const child = Bun.spawn([executable, 'alignment-compatibility', ...args], { cwd: empty, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      child.stdin.write(content); child.stdin.end();
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const fresh = await run(['analyze', '-', '--start', '2', '--end', '4'], inputText);
    assert.equal(fresh.code, 0, fresh.stderr);
    const expected = await createCompatibilityExperiment(input, { start: 2, end: 4 });
    assert.equal(fresh.stdout.trimEnd(), serializeAnalysisRecord(expected.record));
    const replay = await run(['replay', '-', '--format', 'pairs'], fresh.stdout);
    assert.equal(replay.code, 0, replay.stderr);
    assert.match(replay.stdout, /3\t4\tA\tG\tA\tG\t1\t1\t1\t1\tyes\n$/);
    const inspect = await run(['inspect', '-'], inputText);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).analysisPerformed, false);
    // Neither the worker bundle nor the catalog is adjacent to the executable.
    await assert.rejects(stat(join(isolated, 'alignment-compatibility-worker.js')), /ENOENT/);
    await assert.rejects(stat(join(empty, 'phage.db')), /ENOENT/);
  }, 300000);
});
