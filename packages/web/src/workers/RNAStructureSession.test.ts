import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { RNAStructureSession, executeRNAStructureRequest, parseRNAInterval, mapRNAInterval,
  parseRNAStructureRecord, replayRNAStructureRecord, exportRNAStructureTsv, readRNAExperimentFile,
  type RNAStructureRequest, type RNAStructureMessage, type RNAStructureWorker } from './RNAStructureSession';

const fixture = (): RNAStructureRequest => ({
  sequence: 'GGGAAACCC',
  source: { name: 'Local interval', accession: 'private', source: 'local', coordinateSystem: 'genome-forward',
    sourceLength: 300, start: 100, end: 109, strand: '+', gene: null },
  options: { windowSize: 9, stepSize: 9, includeSynonymousStress: false },
});
class ControlledWorker implements RNAStructureWorker {
  onmessage: RNAStructureWorker['onmessage'] = null;
  onerror: RNAStructureWorker['onerror'] = null;
  onmessageerror: RNAStructureWorker['onmessageerror'] = null;
  sent: RNAStructureRequest[] = [];
  terminated = 0;
  postMessage(request: RNAStructureRequest): void { this.sent.push(request); }
  terminate(): void { this.terminated++; }
  reply(message: RNAStructureMessage): void { this.onmessage?.({ data: message } as MessageEvent<RNAStructureMessage>); }
}
const setup = () => {
  const workers: ControlledWorker[] = [];
  const session = new RNAStructureSession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
  session.activate();
  return { workers, session };
};

describe('RNA interval coordinates and accepted evidence', () => {
  it('maps inclusive controls and both strands without truncating or inventing a CDS frame', () => {
    assert.deepEqual(parseRNAInterval('101', '109', 300), { start: 100, end: 109 });
    assert.deepEqual(parseRNAInterval('4', '15', 90, true), { start: 3, end: 15 });
    assert.throws(() => parseRNAInterval('2', '15', 90, true), /codon boundary/);
    for (const [start, end] of [['0', '10'], ['1.5', '10'], ['1', '301'], ['10', '9'], ['1', '9007199254740992']]) {
      assert.throws(() => parseRNAInterval(start, end, 300));
    }
    assert.throws(() => parseRNAInterval('1', '6001', 7000), /No sequence was truncated/);
    const source = fixture().source;
    assert.deepEqual(mapRNAInterval(source, 1, 4), { start: 101, end: 104 });
    assert.deepEqual(mapRNAInterval({ ...source, strand: '-' }, 1, 4), { start: 105, end: 108 });
    assert.throws(() => mapRNAInterval(source, 0, 10), /outside/);
  });

  it('exports the exact source interval, resolved assumptions and literal three-pair oracle', async () => {
    const request = fixture(), result = await executeRNAStructureRequest(request);
    assert.equal(result.analysis.windows[0].pairCount, 3);
    assert.equal(result.analysis.windows[0].structure, '(((...)))');
    assert.deepEqual(result.analysis.windows[0].pairs, [[0, 8], [1, 7], [2, 6]]);
    assert.deepEqual(result.analysis.codonStress, []);
    const record = await parseAnalysisRecord(serializeAnalysisRecord(result.record));
    assert.deepEqual(record.inputs[0].data, { sequence: request.sequence, source: request.source });
    assert.deepEqual(record.fields.analysis.coverage, { available: 9, total: 300, unit: 'bases' });
    assert.equal(record.parameters.includeSynonymousStress, false);
    assert.equal(record.parameters.minLoopSize, 3);
    assert.equal(record.fields.analysis.kind, 'sequence-score');
    assert.deepEqual(record.fields.analysis.value, result.analysis);
  });

  it('folds the reverse complement but preserves forward input and coordinate identity in the export', async () => {
    const request = fixture(); request.sequence = 'GGGTTTCCC'; request.source.strand = '-';
    const result = await executeRNAStructureRequest(request);
    assert.equal(result.analysis.windows[0].sequence, 'GGGAAACCC');
    assert.equal(result.analysis.windows[0].pairCount, 3);
    assert.deepEqual(result.record.inputs[0].data, { sequence: 'GGGTTTCCC', source: request.source });
  });

  it('requires coding evidence for synonymous analysis and rejects invalid source ranges', async () => {
    const noncoding = fixture(); noncoding.options.includeSynonymousStress = true;
    await assert.rejects(executeRNAStructureRequest(noncoding), /coding sequence/);
    const wrongLength = fixture(); wrongLength.source.end++;
    await assert.rejects(executeRNAStructureRequest(wrongLength), /declared length/);
    const nullStart = fixture(); (nullStart.source as unknown as { start: null }).start = null;
    await assert.rejects(executeRNAStructureRequest(nullStart), /integers/);
    const stringStart = fixture(); (stringStart.source as unknown as { start: string }).start = '100';
    await assert.rejects(executeRNAStructureRequest(stringStart), /integers/);
    const coding = fixture(); coding.source.coordinateSystem = 'cds-transcript'; coding.source.gene = 'CDS1';
    await assert.rejects(executeRNAStructureRequest(coding), /codon boundary/);
    coding.source.start = 99; coding.source.end = 108; coding.options.includeSynonymousStress = true;
    const result = await executeRNAStructureRequest(coding);
    assert.equal(result.analysis.codonStress.length, 3);
    assert.deepEqual(result.analysis.codonStress.map(row => row.nucleotideStart), [0, 3, 6]);
    coding.source.strand = '-';
    await assert.rejects(executeRNAStructureRequest(coding), /transcript-order/);
  });
});

describe('owned RNA computation lifecycle', () => {
  it('accepts only its input-bound complete result and releases the worker', async () => {
    const { session, workers } = setup(), request = fixture();
    const pending = session.run(request);
    assert.equal(session.getSnapshot().busy, true);
    workers[0].reply({ kind: 'result', result: await executeRNAStructureRequest(workers[0].sent[0]) });
    assert.equal(await pending, true);
    assert.equal(session.getSnapshot().input, request);
    assert.notEqual(session.getSnapshot().request, request);
    assert.equal(session.getSnapshot().accepted?.analysis.windows[0].pairCount, 3);
    assert.equal(workers[0].terminated, 1);
    assert.equal(workers[0].onmessage, null);
    session.deactivate();
  });

  it('terminates cancelled work, ignores held late replies and allows explicit reruns', async () => {
    const { session, workers } = setup(), request = fixture();
    const pending = session.run(request), held = workers[0].onmessage!;
    session.cancel();
    assert.equal(await pending, false);
    assert.equal(workers[0].terminated, 1);
    held({ data: { kind: 'result', result: await executeRNAStructureRequest(request) } } as MessageEvent<RNAStructureMessage>);
    assert.equal(session.getSnapshot().accepted, null);
    assert.equal(session.getSnapshot().cancelled, true);
    const retry = session.run(request);
    workers[1].reply({ kind: 'result', result: await executeRNAStructureRequest(workers[1].sent[0]) });
    assert.equal(await retry, true);
    assert.equal(session.getSnapshot().cancelled, false);
  });

  it('keeps a replacement source safe from an abandoned response and snapshots submitted data', async () => {
    const { session, workers } = setup(), first = fixture(), second = fixture();
    const old = session.run(first), held = workers[0].onmessage!;
    second.sequence = 'AAAAAAAAA';
    const fresh = session.run(second);
    assert.equal(await old, false);
    held({ data: { kind: 'result', result: await executeRNAStructureRequest(first) } } as MessageEvent<RNAStructureMessage>);
    // Changing the caller's object cannot alter the worker's captured source.
    second.sequence = 'CCCCCCCCC';
    second.source.start = 101; second.source.end = 110;
    workers[1].reply({ kind: 'result', result: await executeRNAStructureRequest(workers[1].sent[0]) });
    assert.equal(await fresh, true);
    assert.equal(session.getSnapshot().accepted?.analysis.windows[0].pairCount, 0);
    assert.equal((session.getSnapshot().accepted?.record.inputs[0].data as { sequence: string }).sequence, 'AAAAAAAAA');
    assert.equal(session.getSnapshot().request?.source.start, 100);
    assert.equal(session.getSnapshot().request?.source.end, 109);
  });

  it('rejects a valid record for different bases and mismatched output values', async () => {
    for (const mismatch of ['input', 'output'] as const) {
      const { session, workers } = setup(), request = fixture();
      const pending = session.run(request);
      const foreign = fixture();
      if (mismatch === 'input') foreign.sequence = 'AAAAAAAAA';
      const result = await executeRNAStructureRequest(foreign);
      if (mismatch === 'output') result.analysis.windows[0].pairCount = 999;
      workers[0].reply({ kind: 'result', result });
      assert.equal(await pending, false);
      assert.match(session.getSnapshot().error!, /does not match/);
      assert.equal(session.getSnapshot().accepted, null);
      assert.equal(workers[0].terminated, 1);
    }
  });

  it('settles constructor, clone, decode and malformed-message failures without leaving work active', async () => {
    const broken = new RNAStructureSession(() => { throw new Error('cannot start worker'); }); broken.activate();
    assert.equal(await broken.run(fixture()), false);
    assert.match(broken.getSnapshot().error!, /cannot start/);
    for (const failure of ['post', 'decode', 'protocol', 'model'] as const) {
      const worker = new ControlledWorker();
      if (failure === 'post') worker.postMessage = () => { throw new Error('clone failure'); };
      const session = new RNAStructureSession(() => worker); session.activate();
      const pending = session.run(fixture());
      if (failure === 'decode') worker.onmessageerror!({} as MessageEvent);
      if (failure === 'protocol') worker.reply({ kind: 'unknown' } as unknown as RNAStructureMessage);
      if (failure === 'model') worker.reply({ kind: 'error', message: 'budget exhausted' });
      assert.equal(await pending, false);
      assert.equal(session.getSnapshot().busy, false);
      assert.equal(worker.terminated, 1);
    }
  });

  it('cancels on deactivation and keeps independent workspaces independent', async () => {
    const first = setup(), second = setup(), request = fixture();
    const a = first.session.run(request), b = second.session.run(request);
    first.session.deactivate();
    assert.equal(await a, false);
    assert.equal(await first.session.run(request), false);
    assert.equal(first.workers.length, 1);
    assert.equal(second.workers[0].terminated, 0);
    second.workers[0].reply({ kind: 'result', result: await executeRNAStructureRequest(request) });
    assert.equal(await b, true);
  });

  it('does not start a worker after a snapshot subscriber cancels the submitted operation', async () => {
    const { session, workers } = setup();
    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().busy) session.cancel();
    });
    assert.equal(await session.run(fixture()), false);
    assert.equal(workers.length, 0);
    assert.equal(session.getSnapshot().busy, false);
    assert.equal(session.getSnapshot().cancelled, true);
    unsubscribe();
  });

  it('releases the worker if construction cancels its own operation', async () => {
    const worker = new ControlledWorker();
    const session = new RNAStructureSession(() => { session.cancel(); return worker; }); session.activate();
    assert.equal(await session.run(fixture()), false);
    assert.equal(worker.terminated, 1);
    assert.equal(worker.sent.length, 0);
  });

  it('executes the actual module worker and accepts its portable interval evidence', async () => {
    const session = new RNAStructureSession(() => new Worker(new URL('./rna-structure.worker.ts', import.meta.url), { type: 'module' }));
    session.activate();
    try {
      assert.equal(await session.run(fixture()), true, session.getSnapshot().error ?? undefined);
      assert.equal(session.getSnapshot().accepted?.analysis.windows[0].pairCount, 3);
      await parseAnalysisRecord(serializeAnalysisRecord(session.getSnapshot().accepted!.record));
    } finally { session.deactivate(); }
  });
});


/** Re-sign an adversarial record so replay must check computation, not merely a
 * deliberately invalid checksum. This does not bless the altered evidence.
 */
async function resignRNA(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method,
    inputs: record.inputs.map(({ id, accession, source, description, data }) => ({ id, accession, source, description, data })),
    parameters: record.parameters, seed: record.seed, references: record.references, fields: record.fields });
}

describe('reopening complete RNA experiments', () => {
  it('recomputes the literal three-pair structure and preserves reverse-strand source ranges in JSON and TSV', async () => {
    const request = fixture(); request.sequence = 'GGGTTTCCC'; request.source.strand = '-';
    const original = await executeRNAStructureRequest(request), content = serializeAnalysisRecord(original.record);
    const parsed = await parseRNAStructureRecord(content);
    assert.deepEqual(parsed.request.source, request.source);
    assert.equal(parsed.request.sequence, 'GGGTTTCCC');
    const replayed = await replayRNAStructureRecord(content);
    assert.equal(serializeAnalysisRecord(replayed.record), content);
    assert.deepEqual(replayed.analysis.windows[0].pairs, [[0, 8], [1, 7], [2, 6]]);
    const rows = exportRNAStructureTsv(replayed.record).trimEnd().split('\n').map(row => row.split('\t'));
    assert.deepEqual(rows[1].slice(1), ['genome-forward', '-', '0', '9', '100', '109',
      '3', '-3', '(((...)))', 'GGGAAACCC', '[[0,8],[1,7],[2,6]]']);
    assert.equal(rows[1][0], original.record.resultId);
  });

  it('rejects checksum-valid fabricated results, missing settings and rewritten evidence instead of regenerating them', async () => {
    const original = (await executeRNAStructureRequest(fixture())).record;
    for (const change of ['pairs', 'label', 'coverage'] as const) {
      const altered = structuredClone(original);
      if (change === 'pairs') (altered.fields.analysis.value as { windows: Array<{ pairCount: number }> }).windows[0].pairCount = 999;
      if (change === 'label') altered.fields.analysis.label = 'An invented physical measurement';
      if (change === 'coverage') altered.fields.analysis.coverage.available = 8;
      const signed = await resignRNA(altered);
      await parseAnalysisRecord(serializeAnalysisRecord(signed));
      await assert.rejects(replayRNAStructureRecord(serializeAnalysisRecord(signed)), /differ from the saved/);
    }
    const defaults = structuredClone(original); delete defaults.parameters.allowWobble;
    await assert.rejects(parseRNAStructureRecord(serializeAnalysisRecord(await resignRNA(defaults))), /source identity or resolved parameters/);
    const metadata = structuredClone(original); metadata.inputs[0].description = 'Unrelated genome name';
    await assert.rejects(parseRNAStructureRecord(serializeAnalysisRecord(await resignRNA(metadata))), /source identity or resolved parameters/);
    const version = structuredClone(original); version.method.version = '999';
    await assert.rejects(parseRNAStructureRecord(serializeAnalysisRecord(await resignRNA(version))), /method\/version/);
  });

  it('rejects unsigned extra claims rather than silently normalizing them away', async () => {
    const original = (await executeRNAStructureRequest(fixture())).record;
    const content = JSON.stringify({ ...original, unsupportedClaim: 'An unverified extra result' });
    // Generic checksums cover the defined evidence, so strict replay must compare the complete record.
    await parseAnalysisRecord(content);
    await assert.rejects(replayRNAStructureRecord(content), /differ from the saved/);
  });

  it('keeps unpaired scores unavailable and exports all windows with mapped source coordinates', async () => {
    const request = fixture(); request.sequence = 'AAAAAAAAA'; request.options = { windowSize: 4, stepSize: 2, includeSynonymousStress: false };
    const result = await replayRNAStructureRecord(serializeAnalysisRecord((await executeRNAStructureRequest(request)).record));
    const rows = exportRNAStructureTsv(result.record).trimEnd().split('\n').slice(1).map(row => row.split('\t'));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.slice(3, 9)), [
      ['0', '4', '100', '104', '0', ''], ['2', '6', '102', '106', '0', ''], ['4', '8', '104', '108', '0', ''],
    ]);
  });

  it('snapshots expected evidence before starting a worker and refuses a saved output mismatch', async () => {
    const original = (await executeRNAStructureRequest(fixture())).record;
    const { session, workers } = setup();
    const expected = structuredClone(original), pending = session.run(fixture(), expected);
    expected.fields.analysis.label = 'Caller mutation after submission';
    workers[0].reply({ kind: 'result', result: await executeRNAStructureRequest(workers[0].sent[0]) });
    assert.equal(await pending, true);
    assert.equal(session.getSnapshot().accepted?.record.resultId, original.resultId);

    const wrong = structuredClone(original);
    (wrong.fields.analysis.value as { windows: Array<{ pairCount: number }> }).windows[0].pairCount = 999;
    const rejected = session.run(fixture(), await resignRNA(wrong));
    workers[1].reply({ kind: 'result', result: await executeRNAStructureRequest(workers[1].sent[0]) });
    assert.equal(await rejected, false);
    assert.equal(session.getSnapshot().accepted, null);
    assert.match(session.getSnapshot().error!, /differ from the saved/);
    session.deactivate();
  });

  it('runs actual module-worker replay and rejects a checksum-valid forged structure', async () => {
    const session = new RNAStructureSession(() => new Worker(new URL('./rna-structure.worker.ts', import.meta.url), { type: 'module' }));
    session.activate();
    try {
      const original = await executeRNAStructureRequest(fixture());
      const parsed = await parseRNAStructureRecord(serializeAnalysisRecord(original.record));
      assert.equal(await session.run(parsed.request, parsed.record), true);
      const forged = structuredClone(original.record);
      (forged.fields.analysis.value as { windows: Array<{ structure: string }> }).windows[0].structure = '.........';
      assert.equal(await session.run(parsed.request, await resignRNA(forged)), false);
      assert.equal(session.getSnapshot().accepted, null);
    } finally { session.deactivate(); }
  });
});

describe('bounded cancellable RNA experiment file reads', () => {
  it('rejects oversized metadata before reading and invalid UTF-8 before parsing', async () => {
    let calls = 0;
    await assert.rejects(readRNAExperimentFile({ size: 10 * 1024 * 1024 + 1,
      arrayBuffer: async () => { calls++; return new ArrayBuffer(0); } }, new AbortController().signal), /10 MiB/);
    assert.equal(calls, 0);
    await assert.rejects(readRNAExperimentFile({ size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer },
      new AbortController().signal));
    await assert.rejects(readRNAExperimentFile({ size: 1, arrayBuffer: async () => new ArrayBuffer(10 * 1024 * 1024 + 1) },
      new AbortController().signal), /10 MiB/);
  });

  it('settles cancellation promptly and never returns a late private file', async () => {
    let release!: (buffer: ArrayBuffer) => void;
    const controller = new AbortController();
    const pending = readRNAExperimentFile({ size: 2, arrayBuffer: () => new Promise(resolve => { release = resolve; }) }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    release(new TextEncoder().encode('{}').buffer);
    await Promise.resolve();
    const content = await readRNAExperimentFile({ size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }, new AbortController().signal);
    assert.equal(content, '{}');
  });
});
