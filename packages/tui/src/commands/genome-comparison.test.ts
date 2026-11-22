import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable, Writable } from 'node:stream';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createGenomeComparisonExperiment, replayGenomeComparisonExperiment, type ComparisonGenomeInput } from '@phage-explorer/comparison';
import { parseGenomeComparisonCommand, runGenomeComparisonJob, runGenomeComparisonCommand } from './genome-comparison';

const sequenceA = 'ATGAAACCCCCCGGGTTT', sequenceB = sequenceA + 'A';
const genbank = [
  'LOCUS       compare_source            18 bp    DNA     linear',
  'ACCESSION   COMPAREA.1',
  'FEATURES             Location/Qualifiers',
  '     CDS             complement(join(1..6,13..18))',
  '                     /gene="joined_reverse"',
  '                     /product="comparison fixture"',
  '                     /transl_table=11',
  'ORIGIN', '        1 atgaaaccccccgggttt', '//', '',
].join('\n');
const firstInput = { name: 'alpha.gb', text: genbank };
const secondInput = { name: 'beta.fa', text: '>COMPAREB.1\n' + sequenceB + '\n' };
const options = { kmerSizes: [3, 5], maxEditDistanceLength: 100, editDistanceWindowSize: 10, editDistanceWindowCount: 3 };
function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { stream, text: () => text };
}
function io(input = '') {
  const out = capture(), err = capture();
  return { stdin: Readable.from([Buffer.from(input)]), stdout: out.stream, stderr: err.stream, output: out.text, errors: err.text };
}
async function genome(input: typeof firstInput): Promise<ComparisonGenomeInput> {
  const imported = (await importLocalGenomes(input)).genomes[0];
  const { id, name, accession, genes } = imported.phage;
  return { phage: { id, name, accession }, source: 'local', sequence: imported.sequence, genes, codonUsage: null };
}
async function processRun(args: string[], cwd: string, input = '') {
  const entry = fileURLToPath(new URL('../index.tsx', import.meta.url));
  const child = Bun.spawn([process.execPath, entry, 'comparison', ...args], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(input); child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('portable genome comparison command', () => {

  for (const phase of ['stdout', 'stderr', 'help'] as const) {
    it(`cancels a stalled ${phase} write without waiting for its callback`, async () => {
      const accepted = await createGenomeComparisonExperiment(await genome(firstInput), await genome(secondInput), options);
      const content = serializeAnalysisRecord(accepted.record) + '\n';
      const streams = io(content), controller = new AbortController();
      let release: ((cause?: Error | null) => void) | undefined;
      let writing!: () => void;
      const started = new Promise<void>(resolve => { writing = resolve; });
      const blocked = new Writable({ write(_chunk, _encoding, done) { release = done; writing(); } });
      const command = runGenomeComparisonCommand(phase === 'help' ? ['--help'] : ['replay', '-'], {
        ...streams, signal: controller.signal, execute: async () => content,
        stdout: phase === 'stderr' ? streams.stdout : blocked,
        stderr: phase === 'stderr' ? blocked : streams.stderr,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await started;
        controller.abort();
        const code = await Promise.race([
          command,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Cancellation waited for a blocked output write.')), 1000);
          }),
        ]);
        assert.equal(code, 130);
        const finishWrite = release; release = undefined; finishWrite?.();
        assert.equal(await command, 130, 'a late successful write cannot turn cancellation into success');
        assert.equal(blocked.listenerCount('error'), 0);
      } finally {
        clearTimeout(timer);
        release?.();
        blocked.end();
      }
    });
  }

  it('validates explicit file roles, one stdin stream and immutable replay settings', () => {
    assert.equal(parseGenomeComparisonCommand([]), null);
    assert.deepEqual(parseGenomeComparisonCommand(['run', 'a.gb', '-', '--params', 'parameters.json', '--output', '-']),
      { operation: 'run', inputA: 'a.gb', inputB: '-', parameters: 'parameters.json', output: undefined });
    assert.deepEqual(parseGenomeComparisonCommand(['replay', '-']), { operation: 'replay', input: '-', output: undefined });
    assert.throws(() => parseGenomeComparisonCommand(['run', '-', '-']), /one input/);
    assert.throws(() => parseGenomeComparisonCommand(['run', 'a.fa', '-', '--params', '-']), /one input/);
    assert.throws(() => parseGenomeComparisonCommand(['replay', 'record.json', '--params', 'new.json']), /override/);
    assert.throws(() => parseGenomeComparisonCommand(['run', 'a.fa']), /Expected/);
    assert.throws(() => parseGenomeComparisonCommand(['run', 'a.fa', 'b.fa', '--output', ' ']), /empty/);
  });

  it('real native workers retain exact joined annotations and produce browser-identical complete evidence', async () => {
    const content = await runGenomeComparisonJob({ operation: 'run', genomeA: firstInput, genomeB: secondInput, parameters: JSON.stringify(options) });
    const record = await parseAnalysisRecord(content);
    const browser = await createGenomeComparisonExperiment(await genome(firstInput), await genome(secondInput), options);
    assert.equal(content.trimEnd(), serializeAnalysisRecord(browser.record));
    assert.equal(record.method.id, 'genome-comparison');
    assert.deepEqual(record.parameters, options);
    assert.equal(browser.genomeA.sequence, sequenceA);
    assert.equal(browser.genomeB.sequence, sequenceB);
    assert.equal(browser.genomeA.genes[0].qualifiers?._location, 'complement(join(1..6,13..18))');
    assert.equal(browser.genomeB.genes.length, 0, 'FASTA gains no invented annotations');
    const diff = browser.result.sequenceDiff;
    assert.equal(diff?.status, 'complete');
    if (!diff || diff.status !== 'complete') throw new Error('Expected a complete exact alignment.');
    assert.equal(diff.stats.distance, 1);
    assert.equal(diff.stats.insertions, 1);
    assert.equal(diff.stats.deletions, 0);
    assert.deepEqual(diff.runs.at(-1), { operation: 'insertion', startA: 18, endA: 18, startB: 18, endB: 19 });
    assert.equal(await runGenomeComparisonJob({ operation: 'replay', content }), content);
    assert.equal((await replayGenomeComparisonExperiment(content)).record.resultId, record.resultId);
  });

  it('rejects freshly rehashed false numerical evidence and publishes no output', async () => {
    const accepted = await createGenomeComparisonExperiment(await genome(firstInput), await genome(secondInput), options);
    const fields = structuredClone(accepted.record.fields);
    const comparison = fields.comparison;
    assert.equal(comparison.kind, 'sequence-score');
    const metrics = comparison.value as { biological: { gcContentA: number } };
    metrics.biological.gcContentA = 99;
    const old = accepted.record;
    const forged = await createAnalysisRecord({ method: old.method,
      inputs: old.inputs.map(({ id, accession, source, description, data }) => ({ id, accession, source, description, data })),
      parameters: old.parameters, seed: old.seed, references: old.references, fields });
    const text = serializeAnalysisRecord(forged);
    await parseAnalysisRecord(text); // Hash-valid metadata alone is not scientific verification.
    const directory = await mkdtemp(join(tmpdir(), 'phage-compare-forgery-'));
    const destination = join(directory, 'must-not-exist.json'), streams = io(text);
    assert.equal(await runGenomeComparisonCommand(['replay', '-', '--output', destination], streams), 1);
    assert.equal(streams.output(), ''); assert.match(streams.errors(), /fresh computation|does not match/);
    await assert.rejects(stat(destination), /ENOENT/);
  });

  it('routes the real launcher without a catalog, replays stdin and refuses existing output files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phage-compare-cli-'));
    const alpha = join(directory, 'alpha.gb'), beta = join(directory, 'beta.fa');
    const parameters = join(directory, 'options.json'), destination = join(directory, 'comparison.json');
    await writeFile(alpha, genbank); await writeFile(beta, secondInput.text); await writeFile(parameters, JSON.stringify(options));
    const created = await processRun(['run', alpha, beta, '--params', parameters, '--output', destination], directory);
    assert.equal(created.code, 0, created.stderr); assert.equal(created.stdout, '');
    const original = await readFile(destination, 'utf8');
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    const replayed = await processRun(['replay', '-'], directory, original);
    assert.equal(replayed.code, 0, replayed.stderr); assert.equal(replayed.stdout, original);
    const existing = await processRun(['run', alpha, beta, '--output', destination], directory);
    assert.equal(existing.code, 1); assert.match(existing.stderr, /already exists/);
    assert.equal(await readFile(destination, 'utf8'), original);
    const badArguments = await processRun(['replay', destination, '--params', parameters], directory);
    assert.equal(badArguments.code, 2); assert.equal(badArguments.stdout, '');
  }, 15000);

  it('rejects multi-genome inputs and cancels both an active worker and a stalled input stream', async () => {
    await assert.rejects(runGenomeComparisonJob({ operation: 'run', genomeA: firstInput,
      genomeB: { name: 'two.fa', text: '>one\nATGAAATAA\n>two\nATGCCCTAA\n' } }), /exactly one/);
    const controller = new AbortController();
    const active = runGenomeComparisonJob({ operation: 'run', genomeA: firstInput, genomeB: secondInput }, controller.signal);
    controller.abort(); await assert.rejects(active, /cancelled/);
    const directory = await mkdtemp(join(tmpdir(), 'phage-compare-cancel-'));
    const destination = join(directory, 'must-not-exist.json'), blocked = new PassThrough();
    const stopped = new AbortController(), streams = io();
    const command = runGenomeComparisonCommand(['replay', '-', '--output', destination], { ...streams, stdin: blocked, signal: stopped.signal });
    const timer = setTimeout(() => stopped.abort(), 10);
    try { assert.equal(await command, 130); }
    finally { clearTimeout(timer); blocked.end(); }
    assert.equal(streams.output(), ''); await assert.rejects(stat(destination), /ENOENT/);
  });
});
