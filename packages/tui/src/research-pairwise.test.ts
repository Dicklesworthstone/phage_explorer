import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { createPairwiseDotPlotExperiment, exportPairwiseDotPlotExperimentTsv, replayPairwiseDotPlotExperiment } from '../../core/src/analysis/dot-plot';
import { importLocalGenomes, exportLocalGenomeBundle } from '../../core/src/genome-import';
import { executeTerminalResearchRequest, validateTerminalResearchRequest, terminalAnalysisRequestSha256,
  type TerminalResearchRequest, type TerminalAnalysisReport } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type WorkflowRuntime } from '../../../scripts/research-workflow';

const row = { sequence: 'ACAA', accession: 'ROW.1', source: 'local' as const };
const column = { sequence: 'GTAANN', accession: 'COLUMN.1', source: 'catalog' as const };
const signal = () => new AbortController().signal;
async function fixture() { return (await createPairwiseDotPlotExperiment(row, column, { bins: 2, window: 2 })).record; }
async function resign(record: AnalysisRecord, change: (copy: AnalysisRecord) => void): Promise<string> {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({
    method: copy.method, parameters: copy.parameters, seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _hash, ...input }) => input),
  }));
}
async function cli(args: string[], runtime: WorkflowRuntime = {}) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; }, runtime);
  return { code, output, error };
}

describe('native ordered pairwise experiments', () => {
  it('replays unequal mixed-source axes in a real worker with independent numerical and coverage oracles', async () => {
    const record = await fixture(), content = serializeAnalysisRecord(record);
    const result = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal());
    assert(result.type === 'experiment-replayed');
    assert.deepEqual(await parseAnalysisRecord(result.exportText!), record);
    assert.equal(result.report.inputRecordSha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(result.report.resultId, record.resultId);
    assert.deepEqual(result.report.inputs.map(i => [i.id, i.accession, i.source]), [
      ['rowSequence', 'ROW.1', 'local'], ['columnSequence', 'COLUMN.1', 'catalog'],
    ]);
    // Y windows AC,AA; X windows GT,NN. RC(AC)=GT, RC(AA)=TT.
    assert.deepEqual(record.fields.direct.value, [0, 0, 0, 0]);
    assert.deepEqual(record.fields.inverted.value, [1, 0, 0.5, 0]);
    assert.deepEqual(record.fields.rowResolvedPerWindow.value, [2, 2]);
    assert.deepEqual(record.fields.columnResolvedPerWindow.value, [2, 0]);
    assert.deepEqual(record.fields.columnWindows.value, [{ start: 0, end: 2 }, { start: 4, end: 6 }]);
    assert(!JSON.stringify(result.report).includes(row.sequence));
    assert(!JSON.stringify(result.report).includes(column.sequence));
  });

  it('exports the browser producer TSV and performs verification without unrequested output', async () => {
    const record = await fixture(), content = serializeAnalysisRecord(record);
    const result = await runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'tsv' }, signal());
    assert(result.type === 'experiment-replayed');
    assert.equal(result.exportText, exportPairwiseDotPlotExperimentTsv(record));
    assert.match(result.exportText!, /1\t0\t2\t4\t0\t2\t2\t2\t0\t0.5\n/);
    const noOutput = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
    assert(noOutput.type === 'experiment-replayed'); assert.equal(noOutput.exportText, null);
  });

  it('rejects recomputed checksums around false matrices, coordinates, coverage or swapped unequal sequences', async () => {
    const record = await fixture();
    const changes: Array<(r: AnalysisRecord) => void> = [
      r => { r.fields.inverted.value = [1, 0.5, 0.5, 0]; },
      r => { r.fields.columnResolvedPerWindow.value = [2, 2]; },
      r => { r.fields.columnWindows.value = [{ start: 0, end: 2 }, { start: 2, end: 4 }]; },
      r => { [r.inputs[0].data, r.inputs[1].data] = [r.inputs[1].data, r.inputs[0].data]; },
    ];
    for (const change of changes) {
      const content = await resign(record, change);
      await parseAnalysisRecord(content); // Hash-valid is deliberately insufficient.
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'json' }, signal()), /Recomputed/);
    }
  });

  it('rejects unsupported axis envelopes and versions instead of relabeling them as single-genome experiments', async () => {
    const record = await fixture();
    for (const change of [
      (r: AnalysisRecord) => { r.inputs.reverse(); },
      (r: AnalysisRecord) => { r.inputs.pop(); },
      (r: AnalysisRecord) => { r.inputs[1].source = 'demo'; },
      (r: AnalysisRecord) => { r.inputs[1].data = 7; },
      (r: AnalysisRecord) => { r.method.version = 'future'; },
      (r: AnalysisRecord) => { r.references[0].version = 'future'; },
    ]) {
      await assert.rejects(executeTerminalResearchRequest({ type: 'replay-experiment', content: await resign(record, change), outputFormat: 'none' }));
    }
  });

  it('creates pairwise JSON/TSV on disk without replacing existing inputs or outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-pairwise-replay-'));
    const record = await fixture(), content = serializeAnalysisRecord(record);
    const input = join(dir, 'pair.json'), output = join(dir, 'verified.json'), table = join(dir, 'verified.tsv');
    await writeFile(input, content, { flag: 'wx' });
    const created = await cli(['replay-experiment', '--input', input, '--output', output]);
    assert.equal(created.code, 0, created.error); assert.equal(JSON.parse(created.output).resultId, record.resultId);
    assert.equal(await readFile(output, 'utf8'), content);
    const exported = await cli(['replay-experiment', '--input', input, '--output', table, '--format', 'tsv']);
    assert.equal(exported.code, 0, exported.error);
    assert.equal(await readFile(table, 'utf8'), exportPairwiseDotPlotExperimentTsv(record));
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    for (const destination of [input, output, table]) {
      const before = await readFile(destination, 'utf8');
      const failed = await cli(['replay-experiment', '--input', input, '--output', destination]);
      assert.equal(failed.code, 1); assert.equal(failed.output, '');
      assert.equal(await readFile(destination, 'utf8'), before);
    }
    const invalid = join(dir, 'invalid.json'), forbidden = join(dir, 'not-written.json');
    await writeFile(invalid, await resign(record, r => { r.fields.direct.value = [1, 1, 1, 1]; }));
    const failed = await cli(['replay-experiment', '--input', invalid, '--output', forbidden]);
    assert.equal(failed.code, 1); assert.equal(failed.output, ''); assert.match(failed.error, /Recomputed/);
    await assert.rejects(stat(forbidden), { code: 'ENOENT' });
  });

  it('rejects a response for a different column and terminates that worker', async () => {
    const content = serializeAnalysisRecord(await fixture());
    const result = await executeTerminalResearchRequest({ type: 'replay-experiment', content, outputFormat: 'none' });
    assert(result.type === 'experiment-replayed'); result.report.inputs[1].sha256 = '0'.repeat(64);
    let worker: Worker | undefined;
    try {
      await assert.rejects(runTerminalResearchWorker({ type: 'replay-experiment', content, outputFormat: 'none' }, signal(), undefined,
        () => worker = new Worker(`require('node:worker_threads').parentPort.once('message', () => require('node:worker_threads').parentPort.postMessage(${JSON.stringify(result)}))`, { eval: true })), /Unexpected/);
    } finally { await worker?.terminate(); }
  });
});

const pairFasta = '>row [topology=circular]\nacaa\n>column\ngtaann\n';
async function authorRequest(content = pairFasta): Promise<Extract<TerminalResearchRequest, { type: 'analyze-experiment' }>> {
  const { genomes } = await importLocalGenomes({ name: 'input', text: content });
  assert(genomes.length >= 2);
  return { type: 'analyze-experiment', content, contentId: genomes[0].phage.localGenome!.contentId,
    analysis: { method: 'pairwise-dot-plot', columnContentId: genomes[1].phage.localGenome!.contentId, bins: 2, window: 2 }, outputFormat: 'json' };
}
function authorArgs(input: string, request: Awaited<ReturnType<typeof authorRequest>>): string[] {
  assert(request.analysis.method === 'pairwise-dot-plot');
  return ['analyze-experiment', '--input', input, '--method', 'pairwise-dot-plot', '--record', request.contentId!,
    '--compare-record', request.analysis.columnContentId, '--bins', String(request.analysis.bins),
    ...(request.analysis.window === null ? [] : ['--window', String(request.analysis.window)])];
}

describe('source-bound native pairwise authoring', () => {
  it('requires explicit full ordered IDs and rejects misplaced, duplicate or invalid comparison options', async () => {
    const request = await authorRequest(), args = authorArgs('input.fa', request);
    const command = parseWorkflowCommand(args); assert(command.type === 'analyze-experiment');
    assert.deepEqual(command.analysis, request.analysis); assert.equal(command.contentId, request.contentId);
    for (const bad of [
      ['analyze-experiment', '--input', 'x', '--method', 'pairwise-dot-plot'],
      args.filter((_, i) => i !== 6 && i !== 7),
      [...args, '--compare-record', 'a'.repeat(64)],
      args.map(value => value === request.contentId ? 'row' : value),
      [...args, '--enzymes', 'EcoRI'], [...args, '--topology', 'circular'],
      ['analyze-experiment', '--input', 'x', '--method', 'dot-plot', '--compare-record', 'a'.repeat(64)],
      ['replay-experiment', '--input', 'x', '--compare-record', 'a'.repeat(64)],
    ]) assert.throws(() => parseWorkflowCommand(bad));
    for (const change of [{ contentId: null }, { analysis: { ...request.analysis, columnContentId: null } },
      { analysis: { ...request.analysis, columnContentId: 'partial' } }, { analysis: { ...request.analysis, bins: 201 } },
      { analysis: { ...request.analysis, window: 0 } }, { analysis: { ...request.analysis, referencePath: 'never-open' } }]) {
      assert.throws(() => validateTerminalResearchRequest({ ...request, ...change }));
    }
  });

  it('creates browser-identical pairwise evidence from FASTA in a real worker, with both axis summaries', async () => {
    const request = await authorRequest();
    const result = await runTerminalResearchWorker(request, signal()); assert(result.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(result.exportText!);
    const expected = (await createPairwiseDotPlotExperiment({ sequence: 'ACAA', accession: 'row', source: 'local' },
      { sequence: 'GTAANN', accession: 'column', source: 'local' }, { bins: 2, window: 2 })).record;
    assert.deepEqual(record, expected);
    assert.deepEqual(record.fields.inverted.value, [1, 0, 0.5, 0]);
    assert.deepEqual([result.report.genome.bases, result.report.comparison?.bases], [4, 6]);
    assert.deepEqual([result.report.genome.resolvedBases, result.report.comparison?.resolvedBases], [4, 4]);
    assert.equal(result.report.genome.topology, 'circular'); assert.match(result.report.interpretation, /no origin wrapping/);
    assert.equal(result.report.requestSha256, terminalAnalysisRequestSha256(request));
    assert(!('verified' in result.report), 'fresh computation must not be advertised as independent replay');
    assert(!JSON.stringify(result.report).includes('ACAA')); assert(!JSON.stringify(result.report).includes('GTAANN'));
  });

  it('preserves axis selection across input order and duplicate records, while swapping explicit IDs transposes scores', async () => {
    const request = await authorRequest(); assert(request.analysis.method === 'pairwise-dot-plot');
    const a = await executeTerminalResearchRequest(request); assert(a.type === 'experiment-analyzed');
    const reordered = await executeTerminalResearchRequest({ ...request, content: '>column\nGTAANN\n>row [topology=circular]\nACAA\n>column\nGTAANN\n' });
    assert(reordered.type === 'experiment-analyzed'); assert.equal(reordered.exportText, a.exportText);
    assert.notEqual(reordered.report.requestSha256, a.report.requestSha256, 'raw-file provenance differs');
    const swapped = { ...request, contentId: request.analysis.columnContentId,
      analysis: { ...request.analysis, columnContentId: request.contentId! } };
    assert.notEqual(terminalAnalysisRequestSha256(swapped), terminalAnalysisRequestSha256(request));
    const b = await executeTerminalResearchRequest(swapped); assert(b.type === 'experiment-analyzed');
    const record = await parseAnalysisRecord(b.exportText!);
    assert.deepEqual(record.fields.inverted.value, [1, 0.5, 0, 0]);
    assert.equal(b.report.genome.contentId, request.analysis.columnContentId);
    assert.equal(b.report.comparison!.contentId, request.contentId); assert.notEqual(b.report.resultId, a.report.resultId);
  });

  it('uses the shorter genome for automatic windows and refuses an explicit window outside either axis', async () => {
    const request = await authorRequest(); assert(request.analysis.method === 'pairwise-dot-plot');
    const automatic = await runTerminalResearchWorker({ ...request, analysis: { ...request.analysis, window: null } }, signal());
    assert(automatic.type === 'experiment-analyzed'); assert.equal(automatic.report.parameters.window, 4);
    await assert.rejects(runTerminalResearchWorker({ ...request, analysis: { ...request.analysis, window: 5 } }, signal()), /in-bounds/);
    const swapped = { ...request, contentId: request.analysis.columnContentId, analysis: { ...request.analysis, columnContentId: request.contentId!, window: 5 } };
    await assert.rejects(executeTerminalResearchRequest(swapped), /in-bounds/);
  });

  it('never falls back to the first record or self when either selected genome changes or is missing', async () => {
    const request = await authorRequest(); assert(request.analysis.method === 'pairwise-dot-plot');
    for (const bad of [
      { ...request, contentId: 'f'.repeat(64) },
      { ...request, analysis: { ...request.analysis, columnContentId: 'f'.repeat(64) } },
      { ...request, content: pairFasta.replace('gtaann', 'gtaaaa') },
      { ...request, content: pairFasta.replace('acaa', 'aaaa') },
    ]) await assert.rejects(executeTerminalResearchRequest(bad), /Select exactly one|missing or changed/);
    const unknown = await authorRequest('>row\nACAA\n>column\nNNNN');
    await assert.rejects(executeTerminalResearchRequest(unknown), /No resolved/);
  });

  it('supports an explicitly selected self-control and counts duplicated axes toward the experiment size limit', async () => {
    const request = await authorRequest(); assert(request.analysis.method === 'pairwise-dot-plot');
    const self = await executeTerminalResearchRequest({ ...request, analysis: { ...request.analysis, columnContentId: request.contentId! } });
    assert(self.type === 'experiment-analyzed'); const record = await parseAnalysisRecord(self.exportText!);
    assert.deepEqual(record.fields.direct.value, [1, 0.5, 0.5, 1]);
    assert.equal(self.report.genome.contentId, self.report.comparison!.contentId);
    const content = '>large\n' + 'A'.repeat(2_500_001);
    const inspection = await executeTerminalResearchRequest({ type: 'inspect-genomes', content }); assert(inspection.type === 'genomes-inspected');
    const id = inspection.report.genomes[0].contentId;
    await assert.rejects(executeTerminalResearchRequest({ ...request, content, contentId: id,
      analysis: { ...request.analysis, columnContentId: id, bins: 1, window: 1 } }), /5,000,000 total/);
  });

  it('supports annotated GenBank plus FASTA bundles without letting saved views choose or reorder axes', async () => {
    const genbank = 'LOCUS       SAME                       4 bp    DNA     circular\nVERSION     SAME.1\nFEATURES             Location/Qualifiers\n     CDS             1..3\nORIGIN\n        1 acaa\n//\n';
    const content = JSON.stringify({ format: 'phage-explorer-local-genomes', version: 1,
      inputs: [{ name: 'a.gb', text: genbank }, { name: 'b.fa', text: '>SAME.1\nGTAANN' }] });
    const request = await authorRequest(content), parsed = await importLocalGenomes({ name: 'bundle', text: content });
    const bundle = exportLocalGenomeBundle(parsed.genomes, { contentId: request.contentId!, viewMode: 'dna', readingFrame: 0, scrollPosition: 0 });
    const result = await executeTerminalResearchRequest({ ...request, content: bundle }); assert(result.type === 'experiment-analyzed');
    assert.equal(result.report.genome.format, 'genbank'); assert.equal(result.report.genome.mappedFeatures, 1);
    assert.equal(result.report.comparison!.format, 'fasta');
    assert.notEqual(result.report.genome.contentId, result.report.comparison!.contentId);
    assert.equal(result.report.genome.accession, result.report.comparison!.accession, 'content IDs disambiguate equal accessions');
    await assert.rejects(executeTerminalResearchRequest({ ...request, content: bundle, contentId: null }), /explicit row/);
  });

  it('round-trips source inspection, authoring, native replay, TSV and browser-core restore using real files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-pairwise-author-')), input = join(dir, 'genomes.fa');
    await writeFile(input, pairFasta, { flag: 'wx' });
    const inspection = await cli(['inspect-genomes', '--input', input]); assert.equal(inspection.code, 0, inspection.error);
    const ids = JSON.parse(inspection.output).genomes.map((g: { contentId: string }) => g.contentId);
    const request = await authorRequest(); assert.deepEqual(ids, [request.contentId, request.analysis.method === 'pairwise-dot-plot' && request.analysis.columnContentId]);
    const output = join(dir, 'pair.json'), replayed = join(dir, 'replayed.json'), table = join(dir, 'pair.tsv'), directTable = join(dir, 'direct.tsv');
    const made = await cli([...authorArgs(input, request), '--output', output]); assert.equal(made.code, 0, made.error);
    const checked = await cli(['replay-experiment', '--input', output, '--output', replayed]); assert.equal(checked.code, 0, checked.error);
    assert.equal(await readFile(output, 'utf8'), await readFile(replayed, 'utf8'));
    const record = await parseAnalysisRecord(await readFile(output, 'utf8'));
    const browser = await replayPairwiseDotPlotExperiment(await readFile(output, 'utf8'),
      { sequence: 'ACAA', accession: 'row', source: 'local' }, { sequence: 'GTAANN', accession: 'column', source: 'local' });
    assert.equal(browser.exactRecord, true); assert.deepEqual(browser.record, record);
    for (const args of [
      ['replay-experiment', '--input', output, '--output', table, '--format', 'tsv'],
      [...authorArgs(input, request), '--output', directTable, '--format', 'tsv'],
    ]) { const result = await cli(args); assert.equal(result.code, 0, result.error); }
    assert.equal(await readFile(table, 'utf8'), await readFile(directTable, 'utf8'));
    assert.equal(await readFile(table, 'utf8'), exportPairwiseDotPlotExperimentTsv(record));
    const failed = await cli([...authorArgs(input, request), '--output', output]);
    assert.equal(failed.code, 1); assert.equal(failed.output, ''); assert.equal(await readFile(input, 'utf8'), pairFasta);
    const noOutput = await cli(authorArgs(input, request)); assert.equal(noOutput.code, 0, noOutput.error);
    assert.equal(JSON.parse(noOutput.output).resultId, record.resultId);
  });

  it('rejects incorrect column selection, coverage summaries, effective windows, methods and raw-file binding at the parent boundary', async () => {
    const request = await authorRequest(), valid = await executeTerminalResearchRequest(request); assert(valid.type === 'experiment-analyzed');
    const changes: Array<(r: TerminalAnalysisReport) => void> = [
      r => { r.comparison = undefined; }, r => { r.comparison!.contentId = 'f'.repeat(64); },
      r => { r.comparison!.resolvedBases = 100; }, r => { r.parameters.window = 1; },
      r => { r.method.id = 'sequence-dot-plot'; }, r => { r.method.version = 'future'; },
      r => { r.requestSha256 = 'f'.repeat(64); }, r => { r.inputFileSha256 = 'f'.repeat(64); },
    ];
    for (const change of changes) {
      const fake = structuredClone(valid); change(fake.report);
      await assert.rejects(runTerminalResearchWorker(request, signal(), undefined,
        () => new Worker(`require('node:worker_threads').parentPort.once('message', () => require('node:worker_threads').parentPort.postMessage(${JSON.stringify(fake)}))`, { eval: true })), /Unexpected/);
    }
  });

  it('checks the exported column sequence against its report before creating an output file', async () => {
    const request = await authorRequest(), valid = await executeTerminalResearchRequest(request); assert(valid.type === 'experiment-analyzed');
    // Hash-valid JSON and internally consistent result IDs still cannot replace
    // the reported source axis during the final export boundary.
    const text = await resign(await parseAnalysisRecord(valid.exportText!), r => { r.inputs[1].data = 'AAAAAA'; });
    const forged = await parseAnalysisRecord(text);
    const fake = { ...valid, exportText: text, report: { ...valid.report, cacheKey: forged.cacheKey, resultId: forged.resultId } };
    const dir = await mkdtemp(join(tmpdir(), 'phage-pairwise-invalid-export-')), input = join(dir, 'input.fa'), output = join(dir, 'output.json');
    await writeFile(input, pairFasta);
    const result = await cli([...authorArgs(input, request), '--output', output], {
      createWorker: () => new Worker(`require('node:worker_threads').parentPort.once('message', () => require('node:worker_threads').parentPort.postMessage(${JSON.stringify(fake)}))`, { eval: true }),
    });
    assert.equal(result.code, 1); assert.equal(result.output, ''); assert.match(result.error, /selected source/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });

  it('retains single-genome and digest authoring without inventing a comparison axis', async () => {
    for (const analysis of [
      { method: 'dot-plot' as const, bins: 2, window: 2 },
      { method: 'restriction-digest' as const, enzymes: ['EcoRI'], topology: 'linear' as const },
    ]) {
      const result = await runTerminalResearchWorker({ type: 'analyze-experiment', content: '>single\nGAATTCAA', contentId: null, analysis, outputFormat: 'json' }, signal());
      assert(result.type === 'experiment-analyzed'); assert.equal(result.report.comparison, undefined);
      const record = await parseAnalysisRecord(result.exportText!); assert.equal(record.inputs[0].id, 'sequence');
      const replay = await runTerminalResearchWorker({ type: 'replay-experiment', content: result.exportText!, outputFormat: 'json' }, signal());
      assert(replay.type === 'experiment-replayed'); assert.equal(replay.exportText, result.exportText);
    }
  });

  it('terminates pairwise authoring workers on cancellation and timeout without success output or files', async () => {
    const request = await authorRequest(), dir = await mkdtemp(join(tmpdir(), 'phage-pairwise-cancel-')), input = join(dir, 'input.fa');
    await writeFile(input, pairFasta);
    for (const explicit of [false, true]) {
      const controller = new AbortController(), output = join(dir, `${explicit}.json`);
      let exited: Promise<number> | undefined;
      const result = await cli([...authorArgs(input, request), '--output', output, '--timeout-ms', explicit ? '30000' : '1500'], {
        signal: controller.signal,
        createWorker: () => {
          const worker = new Worker('for (;;) {}', { eval: true });
          exited = new Promise(resolve => worker.once('exit', resolve));
          if (explicit) worker.once('online', () => controller.abort());
          return worker;
        },
      });
      assert.equal(result.code, explicit ? 130 : 124, result.error);
      assert.equal(result.output, ''); await assert.rejects(stat(output), { code: 'ENOENT' });
      assert(exited); await exited;
    }
  });
});
