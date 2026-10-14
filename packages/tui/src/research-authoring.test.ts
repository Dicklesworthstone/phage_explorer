import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { parseAnalysisRecord } from '../../core/src/analysis-result';
import { createDotPlotExperiment, replayDotPlotExperiment } from '../../core/src/analysis/dot-plot';
import { executeTerminalResearchRequest, validateTerminalResearchRequest, type TerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker } from '../../../scripts/research-workflow';

const fasta = '>private [topology=circular]\r\naNNt\r\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const request = (content = fasta): Extract<TerminalResearchRequest, { type: 'analyze-experiment' }> => ({
  type: 'analyze-experiment', content, contentId: null, analysis: { method: 'dot-plot', bins: 2, window: 2 }, outputFormat: 'json',
});
const genbank = `LOCUS       PRIVATE                    12 bp    DNA     circular
ACCESSION   PRIVATE
VERSION     PRIVATE.1
FEATURES             Location/Qualifiers
     CDS             complement(join(1..3,10..12))
                     /gene="joined"
     misc_feature    <4..9
ORIGIN
        1 atgaaaccctag
//
`;
async function diskInput(content = fasta) {
  const directory = await mkdtemp(join(tmpdir(), 'phage-authoring-'));
  const input = join(directory, 'private input.fa');
  await writeFile(input, content, { flag: 'wx', mode: 0o600 });
  return { input, directory, output: join(directory, 'new analysis.json') };
}
async function cli(args: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await researchWorkflowMain(args, text => { out.push(text); }, text => { err.push(text); });
  return { code, out, err };
}

describe('source genome inspection and dot-plot authoring', () => {
  it('parses explicit creation options without changing existing tape/replay grammar', () => {
    assert.deepEqual(parseWorkflowCommand(['analyze-experiment', '--input', 'x.fa', '--method', 'dot-plot']), {
      type: 'analyze-experiment', input: 'x.fa', timeoutMs: 300000, contentId: null,
      analysis: { method: 'dot-plot', bins: 120, window: null }, outputFormat: 'json',
    });
    assert.deepEqual(parseWorkflowCommand(['inspect-genomes', '--input', 'x.gb']), { type: 'inspect-genomes', input: 'x.gb', timeoutMs: 300000 });
    assert.deepEqual(parseWorkflowCommand(['replay', '--input', 'tape.json']), {
      type: 'replay', input: 'tape.json', timeoutMs: 300000, repetitions: 1, progress: false,
    });
    const parsed = parseWorkflowCommand(['analyze-experiment', '--input', 'x', '--method', 'dot-plot', '--bins', '5', '--window', '3',
      '--record', 'a'.repeat(64), '--format', 'tsv', '--output', 'x.tsv']);
    assert(parsed.type === 'analyze-experiment'); assert.equal(parsed.contentId, 'a'.repeat(64));
    assert.deepEqual(parsed.analysis, { method: 'dot-plot', bins: 5, window: 3 }); assert.equal(parsed.outputFormat, 'tsv');
  });

  it('rejects missing methods, inapplicable flags, partial IDs and unsafe dimensions', () => {
    const base = ['analyze-experiment', '--input', 'x', '--method', 'dot-plot'];
    for (const suffix of [['--bins', '0'], ['--bins', '201'], ['--bins', '2.5'], ['--window', '0'], ['--window', '5000001'],
      ['--record', 'private'], ['--record', 'a'.repeat(12)], ['--format', 'json'], ['--repetitions', '2'], ['--progress'],
      ['--method', 'dot-plot'], ['--bins', '2', '--bins', '3'], ['--force'], ['--window', 'NaN']]) {
      assert.throws(() => parseWorkflowCommand([...base, ...suffix]));
    }
    assert.throws(() => parseWorkflowCommand(['analyze-experiment', '--input', 'x']));
    assert.throws(() => parseWorkflowCommand(['inspect-genomes', '--input', 'x', '--output', 'y']));
    assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', '--method', 'dot-plot']));
  });

  it('validates unknown messages and settings before starting a worker', async () => {
    let allocations = 0;
    const bad = [
      { ...request(), analysis: { method: 'dot-plot', bins: 2, window: 2, sequence: 'ACGT' } },
      { ...request(), contentId: 1 }, { ...request(), contentId: undefined }, { ...request(), outputFormat: 'csv' },
      { ...request(), analysis: { method: 'dot-plot', bins: NaN, window: null } },
      { ...request(), analysis: { method: 'dot-plot', bins: 2, window: undefined } },
      { ...request(), path: '/private/never-open' }, { ...request(), content: 'x'.repeat(10 * 1024 * 1024 + 1) },
    ];
    for (const value of bad) {
      assert.throws(() => validateTerminalResearchRequest(value));
      await assert.rejects(runTerminalResearchWorker(value as TerminalResearchRequest, new AbortController().signal, undefined,
        () => { allocations++; throw new Error('must not allocate'); }));
    }
    assert.equal(allocations, 0);
  });

  it('inspects normalized records with independent hashes and no sequence payload', async () => {
    const result = await executeTerminalResearchRequest({ type: 'inspect-genomes', content: fasta });
    assert(result.type === 'genomes-inspected');
    assert.equal(result.report.inputFileSha256, sha(fasta)); assert.equal(result.report.genomes.length, 1);
    const row = result.report.genomes[0];
    assert.equal(row.sequenceSha256, sha('ANNT')); assert.equal(row.bases, 4); assert.equal(row.resolvedBases, 2);
    assert.equal(row.topology, 'circular'); assert.equal(row.mappedFeatures, 0); assert.equal(row.warningCount, 2);
    assert(!JSON.stringify(result).includes('ANNT')); assert(!JSON.stringify(result).includes('sequence":'));
    assert.equal(row.contentId, (await importLocalGenomes({ name: 'browser.fa', text: fasta })).genomes[0].phage.localGenome!.contentId);
  });

  it('uses actual GenBank annotation parsing and retains unsupported-annotation warnings as counts', async () => {
    const inspection = await executeTerminalResearchRequest({ type: 'inspect-genomes', content: genbank });
    assert(inspection.type === 'genomes-inspected');
    const row = inspection.report.genomes[0];
    assert.equal(row.format, 'genbank'); assert.equal(row.topology, 'circular'); assert.equal(row.accession, 'PRIVATE.1');
    assert.equal(row.mappedFeatures, 1); assert.equal(row.warningCount, 1);
    assert.equal(row.sequenceSha256, sha('ATGAAACCCTAG'));
    const result = await executeTerminalResearchRequest(request(genbank)); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!);
    assert.equal(record.inputs[0].data, 'ATGAAACCCTAG'); assert.equal(record.inputs[0].accession, 'PRIVATE.1');
  });

  it('requires exact selection for multiple genomes even when a bundle has a saved view', async () => {
    const content = '>same\nACGT\n>same\nANNT\n';
    const parsed = await importLocalGenomes({ name: 'multi.fa', text: content });
    const contentId = parsed.genomes[1].phage.localGenome!.contentId;
    const bundle = exportLocalGenomeBundle(parsed.genomes, { contentId, viewMode: 'dna', readingFrame: 0, scrollPosition: 0 });
    for (const input of [content, bundle]) {
      await assert.rejects(executeTerminalResearchRequest(request(input)), /exactly one/);
      const selected = await executeTerminalResearchRequest({ ...request(input), contentId }); assert(selected.type === 'experiment-analyzed');
      assert.equal((await parseAnalysisRecord(selected.exportText!)).inputs[0].data, 'ANNT');
      await assert.rejects(executeTerminalResearchRequest({ ...request(input), contentId: '0'.repeat(64) }), /exactly one/);
    }
    const reordered = await executeTerminalResearchRequest({ ...request('>same\nANNT\n>same\nACGT\n'), contentId });
    assert(reordered.type === 'experiment-analyzed'); assert.equal(reordered.report.genome.contentId, contentId);
  });

  it('matches the independent small matrix and browser producer without a second numerical implementation', async () => {
    const result = await executeTerminalResearchRequest(request()); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!);
    assert.deepEqual(record.fields.direct.value, [0.5, 0, 0, 0.5]);
    assert.deepEqual(record.fields.inverted.value, [0, 0.5, 0.5, 0]);
    assert.deepEqual(record.fields.windows.value, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    const browser = await createDotPlotExperiment({ sequence: 'ANNT', accession: 'private', source: 'local' }, { bins: 2, window: 2 });
    assert.deepEqual(record, browser.record); assert.equal(result.report.resultId, browser.record.resultId);
    const replayed = await replayDotPlotExperiment(result.exportText!, { sequence: 'ANNT', accession: 'private', source: 'local' });
    assert.equal(replayed.exactRecord, true);
    assert(!('verified' in result.report), 'fresh computation is not mislabeled as replay verification');
  });

  it('resolves automatic windows via the core method and refuses explicitly oversized windows', async () => {
    const r = request('>short\nACGT\n'); r.analysis = { method: 'dot-plot', bins: 3, window: null };
    const result = await executeTerminalResearchRequest(r); assert(result.type === 'experiment-analyzed');
    assert.deepEqual(result.report.parameters, { ambiguity: 'exclude', bins: 3, window: 4 });
    r.analysis.window = 5;
    await assert.rejects(executeTerminalResearchRequest(r), /in-bounds/);
  });

  it('normalization changes raw-file identity but not the exact normalized experiment', async () => {
    const a = await executeTerminalResearchRequest(request(fasta));
    const b = await executeTerminalResearchRequest(request(fasta.replaceAll('\r\n', '\n').replace('aNNt', 'ANNT')));
    assert(a.type === 'experiment-analyzed' && b.type === 'experiment-analyzed');
    assert.notEqual(a.report.inputFileSha256, b.report.inputFileSha256);
    assert.equal(a.report.genome.contentId, b.report.genome.contentId); assert.equal(a.exportText, b.exportText);
  });

  it('inspects unknown-only DNA without inventing dot-plot evidence and refuses invalid complete input', async () => {
    const unknown = await executeTerminalResearchRequest({ type: 'inspect-genomes', content: '>x\nNNNN' });
    assert(unknown.type === 'genomes-inspected'); assert.equal(unknown.report.genomes[0].resolvedBases, 0);
    await assert.rejects(executeTerminalResearchRequest(request('>x\nNNNN')), /No resolved/);
    for (const content of ['', '>x\nACGU', '>x\nACGT\n>y\n----', genbank.replace('12 bp', '13 bp'), genbank.replace('//', '')]) {
      await assert.rejects(executeTerminalResearchRequest({ type: 'inspect-genomes', content }));
      await assert.rejects(executeTerminalResearchRequest(request(content)));
    }
  });

  it('runs the file-to-analysis-to-replay path in real isolated threads and preserves the source', async () => {
    const f = await diskInput();
    const made = await cli(['analyze-experiment', '--input', f.input, '--method', 'dot-plot', '--bins', '2', '--window', '2', '--output', f.output]);
    assert.equal(made.code, 0, made.err.join('')); assert.equal(made.out.length, 1);
    const report = JSON.parse(made.out[0]); assert.equal(report.format, 'phage-explorer-experiment-analysis');
    const exported = await readFile(f.output, 'utf8'); assert.equal((await parseAnalysisRecord(exported)).resultId, report.resultId);
    const replay = await cli(['replay-experiment', '--input', f.output]);
    assert.equal(replay.code, 0, replay.err.join('')); assert.equal(JSON.parse(replay.out[0]).resultId, report.resultId);
    assert.equal(await readFile(f.input, 'utf8'), fasta); assert(!made.out[0].includes('ANNT'));
    if (process.platform !== 'win32') assert.equal((await stat(f.output)).mode & 0o777, 0o600);
    const inspect = await cli(['inspect-genomes', '--input', f.input]); assert.equal(inspect.code, 0, inspect.err.join(''));
    assert.equal(JSON.parse(inspect.out[0]).genomes[0].contentId, report.genome.contentId);
  });

  it('exports coordinate TSV, supports metadata-only creation, and never overwrites a file or symlink', async () => {
    const f = await diskInput(), output = join(f.directory, 'result.tsv');
    const args = ['analyze-experiment', '--input', f.input, '--method', 'dot-plot', '--bins', '2', '--window', '2'];
    const plain = await cli(args); assert.equal(plain.code, 0, plain.err.join(''));
    const made = await cli([...args, '--format', 'tsv', '--output', output]); assert.equal(made.code, 0, made.err.join(''));
    const text = await readFile(output, 'utf8');
    assert(text.includes('0\t1\t0\t2\t2\t4\t0\t0.5\n')); assert(!text.includes('ANNT'));
    const paths = [f.input, output];
    if (process.platform !== 'win32') { const link = join(f.directory, 'source-link'); await symlink(f.input, link); paths.push(link); }
    for (const path of paths) {
      const fail = await cli([...args, '--output', path]); assert.equal(fail.code, 1); assert.equal(fail.out.length, 0);
    }
    assert.equal(await readFile(output, 'utf8'), text); assert.equal(await readFile(f.input, 'utf8'), fasta);
  });

  it('creates no output on parse, selection or computation failure', async () => {
    const f = await diskInput('>x\nAAAA\n>y\nTTTT');
    for (const suffix of [[], ['--record', '0'.repeat(64)]]) {
      const failed = await cli(['analyze-experiment', '--input', f.input, '--method', 'dot-plot', '--output', f.output, ...suffix]);
      assert.equal(failed.code, 1); assert.equal(failed.out.length, 0); await assert.rejects(stat(f.output), { code: 'ENOENT' });
    }
    const invalid = join(f.directory, 'invalid'); await writeFile(invalid, new Uint8Array([255]), { flag: 'wx' });
    for (const input of [invalid, f.directory]) {
      const failed = await cli(['analyze-experiment', '--input', input, '--method', 'dot-plot', '--output', f.output]);
      assert.equal(failed.code, 1); assert.equal(failed.out.length, 0); await assert.rejects(stat(f.output), { code: 'ENOENT' });
    }
  });

  it('aborts an actual source-analysis thread while a concurrent analysis remains independent', async () => {
    const controller = new AbortController(); let worker: Worker | null = null;
    const cancelled = runTerminalResearchWorker(request(), controller.signal, undefined, () => {
      worker = new Worker(new URL('./research-replay.worker.ts', import.meta.url));
      worker.once('online', () => controller.abort()); return worker;
    });
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    const fresh = await runTerminalResearchWorker(request(), new AbortController().signal);
    await rejection; assert(worker); assert.equal(fresh.type, 'experiment-analyzed');
    const next = await runTerminalResearchWorker(request(), new AbortController().signal); assert.equal(next.type, fresh.type);
  });

  it('terminates timed-out authoring and emits no success or output', async () => {
    const f = await diskInput(), errors: string[] = [];
    const code = await researchWorkflowMain(['analyze-experiment', '--input', f.input, '--method', 'dot-plot', '--output', f.output, '--timeout-ms', '20'],
      () => { assert.fail('No success report'); }, text => { errors.push(text); }, { createWorker: () => new Worker('for (;;) {}', { eval: true }) });
    assert.equal(code, 124); assert.match(errors.join(''), /timed out/); await assert.rejects(stat(f.output), { code: 'ENOENT' });
  });

  it('binds successful worker responses to the exact file, selection and requested settings', async () => {
    const valid = await executeTerminalResearchRequest(request()); assert(valid.type === 'experiment-analyzed');
    for (const change of [{ inputFileSha256: '0'.repeat(64) }, { requestSha256: '0'.repeat(64) },
      { parameters: { ...valid.report.parameters, bins: 3 } }, { genome: { ...valid.report.genome, resolvedBases: 5 } }]) {
      const fake = { ...valid, report: { ...valid.report, ...change } };
      await assert.rejects(runTerminalResearchWorker(request(), new AbortController().signal, undefined,
        () => new Worker(`require('node:worker_threads').parentPort.once('message', () => require('node:worker_threads').parentPort.postMessage(${JSON.stringify(fake)}))`, { eval: true })), /Unexpected/);
    }
  });
});
