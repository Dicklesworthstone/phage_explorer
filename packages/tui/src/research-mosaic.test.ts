import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { MOSAIC_METHOD, createMosaicExperiment, serializeMosaicDataset, resolveMosaicRadarConfig,
  type MosaicDataset, type MosaicSequenceInput, type MosaicRadarResult } from '../../core/src/analysis/recombination-radar';
import { validateTerminalResearchRequest, type TerminalResearchRequest } from './research-replay.worker';
import { parseWorkflowCommand, researchWorkflowMain, runTerminalResearchWorker, type TerminalWorker } from '../../../scripts/research-workflow';

const source = (id: string, sequence: string): MosaicSequenceInput => ({ id, label: id, accession: id,
  sequence, source: 'local', sourceDescription: 'Independent small-sequence test fixture.',
  sourceReference: null, sourceLicense: null, sourceStart: 0, sourceLength: sequence.length });
const dataset = (): MosaicDataset => ({ format: 'phage-explorer-mosaic-dataset', version: 1, name: 'Exact set fixture',
  query: { ...source('query', 'AAAC'), sourceStart: 10, sourceLength: 20 }, references: [source('reference', 'AAGT')], excludedReferences: [] });
const options = resolveMosaicRadarConfig({ k: 2, window: 200, step: 100, minSimilarity: 0 });
const request = (): Extract<TerminalResearchRequest, { type: 'analyze-mosaic' }> => ({ type: 'analyze-mosaic', content: serializeMosaicDataset(dataset()), options });
const run = (job: TerminalResearchRequest) => runTerminalResearchWorker(job, new AbortController().signal);
async function cli(args: string[], signal?: AbortSignal) {
  let output = '', error = '';
  const code = await researchWorkflowMain(args, text => { output += text; }, text => { error += text; }, { signal });
  return { code, output, error };
}
async function rehash(record: AnalysisRecord, change: (copy: AnalysisRecord) => void) {
  const copy = structuredClone(record); change(copy);
  return serializeAnalysisRecord(await createAnalysisRecord({ method: copy.method, parameters: copy.parameters,
    seed: copy.seed, references: copy.references, fields: copy.fields,
    inputs: copy.inputs.map(({ sha256: _sha, ...input }) => input) }));
}

describe('terminal mosaic research workflow', () => {
  it('resolves all effective settings and keeps command grammars separate', () => {
    const command = parseWorkflowCommand(['analyze-mosaic', '--input', 'panel.json', '--k', '2', '--window', '200',
      '--step', '100', '--min-similarity', '0', '--format', 'tsv', '--section', 'segments', '--output', 'new.tsv']);
    assert(command.type === 'analyze-mosaic'); assert.deepEqual(command.options, options); assert.equal(command.section, 'segments');
    assert.deepEqual(parseWorkflowCommand(['inspect-mosaic', '--input', 'panel.json']), { type: 'inspect-mosaic', input: 'panel.json', timeoutMs: 300000 });
    for (const flags of [['--k', '17'], ['--window', '0'], ['--step', '500', '--window', '200'], ['--top-n', '31'],
      ['--max-references', '0'], ['--min-similarity', 'NaN'], ['--min-similarity', '1.1'], ['--bins', '2'],
      ['--format', 'tsv'], ['--section', 'segments', '--output', 'x'], ['--format', 'tsv', '--section', 'bogus', '--output', 'x']]) {
      assert.throws(() => parseWorkflowCommand(['analyze-mosaic', '--input', 'x', ...flags]));
    }
    assert.throws(() => parseWorkflowCommand(['inspect-mosaic', '--input', 'x', '--k', '2']));
    assert.throws(() => parseWorkflowCommand(['replay-experiment', '--input', 'x', '--k', '2']));
  });

  it('requires a complete validated worker settings snapshot', () => {
    for (const bad of [null, {}, { ...options, window: '200' }, { ...options, step: undefined }, { ...options, approximate: true }]) {
      assert.throws(() => validateTerminalResearchRequest({ ...request(), options: bad }));
    }
    assert.doesNotThrow(() => validateTerminalResearchRequest(request()));
  });

  it('inspects source ranges without computing or emitting private sequences', async () => {
    const reply = await run({ type: 'inspect-mosaic', content: request().content });
    assert(reply.type === 'mosaic-inspected');
    assert.deepEqual(reply.report.query, { id: 'query', accession: 'query', bases: 4, sourceStart: 10, sourceLength: 20 });
    assert.equal(reply.report.references.length, 1);
    assert(!JSON.stringify(reply).includes('AAAC')); assert(!JSON.stringify(reply).includes('AAGT'));
    assert(!('verified' in reply.report));
  });

  it('runs a real worker and verifies the independent canonical-set oracle through replay and TSV', async () => {
    const reply = await run(request()); assert(reply.type === 'mosaic-analyzed');
    const record = await parseAnalysisRecord(reply.recordJson);
    assert.deepEqual(record.method, MOSAIC_METHOD);
    // Literal sets: query {AA, AC}; reference {AA, AG, AC}; intersection=2, union=3.
    const result = record.fields.mosaic.value as unknown as MosaicRadarResult;
    assert.equal(result.windows[0].score, 2 / 3);
    assert.equal(result.windows[0].donor, 'reference');
    assert.deepEqual(result.coverage, { matched: 4, ambiguous: 0, 'below-threshold': 0, 'no-evidence': 0 });
    assert.deepEqual(record, (await createMosaicExperiment(dataset(), options)).record);
    const replay = await run({ type: 'replay-experiment', content: reply.recordJson, outputFormat: 'tsv' });
    assert(replay.type === 'experiment-replayed'); assert.equal(replay.report.resultId, record.resultId);
    assert.equal(replay.report.verified, true);
    assert(replay.exportText!.includes('0\t4\t10\t14\treference\tmatched\t0.6666666666666666\t3'));
    assert(!replay.exportText!.includes('AAAC')); assert(!replay.exportText!.includes('AAGT'));
  });

  it('rejects correctly rehashed fabricated output rather than checking only envelope integrity', async () => {
    const created = await createMosaicExperiment(dataset(), options);
    const fabricated = await rehash(created.record, copy => {
      (copy.fields.mosaic.value as unknown as MosaicRadarResult).windows[0].score = 1;
    });
    await parseAnalysisRecord(fabricated);
    await assert.rejects(run({ type: 'replay-experiment', content: fabricated, outputFormat: 'json' }), /differs/);
  });

  it('refuses replies bound to another reference panel, despite valid record hashes', async () => {
    const altered = dataset(); altered.references[0].sequence = 'GGGG';
    const foreign = await createMosaicExperiment(altered, options);
    class WrongPanelWorker extends EventEmitter {
      terminated = 0;
      postMessage(job: Extract<TerminalResearchRequest, { type: 'analyze-mosaic' }>) {
        void import('./research-replay.worker').then(({ terminalMosaicRequestSha256 }) => {
          import('node:crypto').then(({ createHash }) => {
            this.emit('message', { type: 'mosaic-analyzed', inputFileSha256: createHash('sha256').update(job.content).digest('hex'),
              requestSha256: terminalMosaicRequestSha256(job), recordJson: serializeAnalysisRecord(foreign.record) });
          });
        });
      }
      terminate() { this.terminated++; return Promise.resolve(0); }
    }
    const worker = new WrongPanelWorker();
    await assert.rejects(runTerminalResearchWorker(request(), new AbortController().signal, undefined,
      () => worker as unknown as TerminalWorker), /differs from the submitted/);
    assert.equal(worker.terminated, 1);
  });

  it('creates private outputs exclusively and preserves the analysis identity across CLI replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-mosaic-'));
    const input = join(dir, 'panel.json'), output = join(dir, 'result.json'), tsv = join(dir, 'windows.tsv');
    await writeFile(input, request().content);
    const first = await cli(['analyze-mosaic', '--input', input, '--k', '2', '--window', '200', '--step', '100', '--min-similarity', '0', '--output', output]);
    assert.equal(first.code, 0, first.error); assert(!first.output.includes('AAAC'));
    const stored = await readFile(output, 'utf8'), report = JSON.parse(first.output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(report.resultId, (await parseAnalysisRecord(stored)).resultId);
    const repeat = await cli(['analyze-mosaic', '--input', input, '--output', output]);
    assert.equal(repeat.code, 1); assert.equal(repeat.output, ''); assert.equal(await readFile(output, 'utf8'), stored);
    const replay = await cli(['replay-experiment', '--input', output, '--format', 'tsv', '--output', tsv]);
    assert.equal(replay.code, 0, replay.error); assert.equal(JSON.parse(replay.output).resultId, report.resultId);
    assert((await readFile(tsv, 'utf8')).includes('source_start_0based'));
  });

  it('publishes neither output nor success on cancellation or a worker timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phage-mosaic-cancel-'));
    const input = join(dir, 'panel.json'), output = join(dir, 'never.json');
    await writeFile(input, request().content);
    const controller = new AbortController(); controller.abort(new DOMException('Cancelled', 'AbortError'));
    const cancelled = await cli(['analyze-mosaic', '--input', input, '--output', output], controller.signal);
    assert.equal(cancelled.code, 130); assert.equal(cancelled.output, '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
    const timed = await cli(['analyze-mosaic', '--input', input, '--output', output, '--timeout-ms', '1']);
    assert.equal(timed.code, 124); assert.equal(timed.output, '');
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });

  it('offers an explicitly synthetic portable format example', async () => {
    const template = await cli(['mosaic-template']); assert.equal(template.code, 0);
    const data: MosaicDataset = JSON.parse(template.output);
    assert.equal(data.query.source, 'demo'); assert(data.references.every(reference => reference.source === 'demo'));
    const experiment = await createMosaicExperiment(data, { window: 200, step: 100, k: 3 });
    assert.equal(experiment.record.fields.mosaic.kind, 'demo'); assert.equal(experiment.result.referenceSwitches.length, 1);
  });
});
