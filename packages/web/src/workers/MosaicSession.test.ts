import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createMosaicExperiment, serializeMosaicDataset, type MosaicDataset, type MosaicSequenceInput } from '../../../core/src/analysis/recombination-radar';
import type { PhageSummary } from '../../../core/src/types';
import { MosaicSession, executeMosaicRequest, readMosaicFile, readMosaicSequence, readRepositoryMosaicDataset,
  type MosaicMessage, type MosaicRequest, type MosaicWorker, type MosaicRepository } from './MosaicSession';

const source = (id: string, sequence: string): MosaicSequenceInput => ({ id, label: id, accession: null, sequence,
  source: 'local', sourceDescription: 'Deterministic software fixture', sourceReference: null, sourceLicense: null,
  sourceLength: sequence.length, sourceStart: 0 });
const dataset = (): MosaicDataset => ({ format: 'phage-explorer-mosaic-dataset', version: 1, name: 'Private query and references',
  query: source('query', 'A'.repeat(600) + 'C'.repeat(600)), references: [source('a', 'A'.repeat(600)), source('c', 'C'.repeat(600))], excludedReferences: [] });
const request = (): MosaicRequest => ({ kind: 'analyze', dataset: dataset(), options: { k: 5, window: 400, step: 200 } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
class WorkerProbe implements MosaicWorker {
  onmessage: MosaicWorker['onmessage'] = null; onerror: MosaicWorker['onerror'] = null; onmessageerror: MosaicWorker['onmessageerror'] = null;
  requests: MosaicRequest[] = []; terminated = 0;
  postMessage(value: MosaicRequest) { this.requests.push(value); }
  terminate() { this.terminated++; }
  emit(message: MosaicMessage) { this.onmessage?.({ data: message } as MessageEvent<MosaicMessage>); }
}
function workspace() {
  const workers: WorkerProbe[] = [], scope = {};
  const session = new MosaicSession(() => { const worker = new WorkerProbe(); workers.push(worker); return worker; });
  session.activate(); session.setScope(scope); return { workers, session, scope };
}
const phage = (id: number): PhageSummary => ({ id, slug: null, name: `Genome ${id}`, accession: `LOCAL${id}`,
  family: null, host: null, genomeLength: null, gcContent: null, morphology: null, lifecycle: null,
  localGenome: { contentId: `${id}`, sequenceSha256: `${id}`, format: 'fasta', topology: 'unknown' } });
function repository(sequences: Record<number, string>): MosaicRepository {
  return { listPhages: async () => Object.keys(sequences).map(id => phage(Number(id))),
    getFullGenomeLength: async id => sequences[id].length,
    getSequenceWindow: async (id, start, end) => sequences[id].slice(start, end) };
}

describe('mosaic experiment worker operations', () => {
  it('computes actual private references and verifies portable replay identities', async () => {
    const input = dataset(); input.query.sourceStart = 100; input.query.sourceLength += 500;
    const experiment = await executeMosaicRequest({ kind: 'import', content: serializeMosaicDataset(input), options: { window: 400, step: 200 } });
    assert.equal(experiment.result.windows[0].donor, 'a');
    assert.equal(experiment.result.windows.at(-1)!.donor, 'c');
    const replay = await executeMosaicRequest({ kind: 'replay', content: serializeAnalysisRecord(experiment.record) });
    assert.equal(replay.record.resultId, experiment.record.resultId);
    assert.equal(replay.dataset.query.sourceStart, 100); assert.equal(replay.dataset.query.sourceLength, 1700);
  });
  it('reads complete private FASTA references without the catalogue prefix truncation', async () => {
    const query = source('selected-query', 'A'.repeat(800));
    const experiment = await executeMosaicRequest({ kind: 'panel', name: 'private.fa', content: '>long\n' + 'A'.repeat(160001), query, options: {} });
    assert.equal(experiment.dataset.query.label, 'selected-query');
    assert.equal(experiment.dataset.references[0].sequence.length, 160001);
    assert.equal(experiment.dataset.references[0].sourceLength, 160001);
    assert.equal(experiment.dataset.references[0].source, 'local');
  });
  it('rejects rehashed fabricated saved results in the actual replay operation', async () => {
    const original = await createMosaicExperiment(dataset());
    const changed = structuredClone(original.record);
    changed.fields.mosaic.value = { invented: true };
    const forged = await createAnalysisRecord(changed);
    await assert.rejects(executeMosaicRequest({ kind: 'replay', content: serializeAnalysisRecord(forged) }), /recomput|differ|identity/i);
  });
  it('rejects malformed encodings and oversized files before parsing', async () => {
    await assert.rejects(readMosaicFile({ size: 11 * 1024 * 1024, arrayBuffer: async () => { throw new Error('must not read'); } }), /10 MiB/);
    await assert.rejects(readMosaicFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }));
  });
});

describe('repository source coverage', () => {
  it('records original lengths, exact prefixes and failed or unselected candidates', async () => {
    const sequences: Record<number, string> = { 0: 'A'.repeat(800), 1: 'C'.repeat(160000) };
    for (let id = 2; id <= 31; id++) sequences[id] = 'G'.repeat(300);
    const repo = repository(sequences), read = repo.getSequenceWindow;
    repo.getSequenceWindow = async (id, start, end) => { if (id === 2) throw new Error('unavailable'); return read(id, start, end); };
    const data = await readRepositoryMosaicDataset(repo, phage(0), new AbortController().signal);
    assert.equal(data.references.length, 29); assert.equal(data.excludedReferences.length, 2);
    assert.equal(data.references[0].sequence.length, 150000); assert.equal(data.references[0].sourceLength, 160000);
    assert.equal(data.references[0].sourceStart, 0); assert.equal(data.references[0].source, 'local');
    assert.match(data.excludedReferences.find(row => row.id === 'repository:2')!.reason, /unavailable/);
    assert.match(data.excludedReferences.find(row => row.id === 'repository:31')!.reason, /first 30/);
  });
  it('refuses an incomplete query and stops immediately after a superseded length read', async () => {
    const incomplete = repository({ 0: 'AAAA' }); incomplete.getSequenceWindow = async () => 'AAA';
    await assert.rejects(readRepositoryMosaicDataset(incomplete, phage(0), new AbortController().signal), /incomplete/);
    const controller = new AbortController(); let reads = 0;
    const old = repository({ 0: 'AAAA' });
    old.getFullGenomeLength = async () => { controller.abort(); return 4; };
    old.getSequenceWindow = async () => { reads++; return 'AAAA'; };
    await assert.rejects(readMosaicSequence(old, phage(0), controller.signal), error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(reads, 0);
  });
});

describe('selection-scoped mosaic sessions', () => {
  it('cancels before a delayed file read can launch a worker', async () => {
    const { session, scope, workers } = workspace();
    let resolve!: (value: MosaicRequest) => void;
    const work = session.run(scope, () => new Promise<MosaicRequest>(done => { resolve = done; }));
    session.cancel(); assert.equal(await work, false);
    resolve(request()); await tick(); assert.equal(workers.length, 0); assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('rejects late results after same-ID repository replacement and after parameter edits', async () => {
    const { session, scope, workers } = workspace();
    const old = session.run(scope, request()); await tick(); const late = workers[0].onmessage!;
    const nextScope = {}; session.setScope(nextScope);
    assert.equal(await old, false); assert.equal(workers[0].terminated, 1);
    const oldResult = await executeMosaicRequest(request());
    late({ data: { kind: 'result', experiment: oldResult, verified: false } } as MessageEvent<MosaicMessage>);
    assert.equal(session.getSnapshot().accepted, null);
    const first = session.run(nextScope, request()); await tick(); const staleParameter = workers[1].onmessage!;
    const edited = request(); if (edited.kind !== 'analyze') throw new Error('fixture'); edited.options.k = 6;
    const second = session.run(nextScope, edited); await tick(); assert.equal(await first, false);
    staleParameter({ data: { kind: 'result', experiment: oldResult, verified: false } } as MessageEvent<MosaicMessage>);
    assert.equal(session.getSnapshot().accepted, null);
    workers[2].emit({ kind: 'result', experiment: await executeMosaicRequest(edited), verified: false });
    assert.equal(await second, true); assert.equal(session.getSnapshot().accepted!.options.k, 6);
    session.deactivate();
  });
  it('captures exact direct inputs before yielding and recovers after worker failures', async () => {
    const { session, scope, workers } = workspace(); const input = request();
    const pending = session.run(scope, input); if (input.kind === 'analyze') input.dataset.query.sequence = 'T';
    await tick(); const sent = workers[0].requests[0];
    assert.equal(sent.kind === 'analyze' && sent.dataset.query.sequence.length, 1200);
    workers[0].onmessageerror?.({} as MessageEvent); assert.equal(await pending, false); assert.equal(session.getSnapshot().busy, false);
    const retry = session.run(scope, request()); await tick();
    workers[1].emit({ kind: 'result', experiment: await executeMosaicRequest(request()), verified: false });
    assert.equal(await retry, true); assert.equal(session.getSnapshot().error, null);
    session.deactivate();
  });
});

describe('native mosaic worker', () => {
  it('computes and freshly replays through a real worker', async () => {
    const scope = {}, session = new MosaicSession(() => new Worker(new URL('./mosaic.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope);
    try {
      assert.equal(await session.run(scope, request()), true, session.getSnapshot().error ?? 'No result');
      const original = session.getSnapshot().accepted!;
      assert.equal(original.result.windows[0].donor, 'a');
      assert.equal(await session.run(scope, { kind: 'replay', content: serializeAnalysisRecord(original.record) }), true, session.getSnapshot().error ?? 'No replay');
      assert.equal(session.getSnapshot().verified, true);
      assert.equal(session.getSnapshot().accepted!.record.resultId, original.record.resultId);
    } finally { session.deactivate(); }
  }, 15000);
  it('terminates a started computation without accepting partial evidence', async () => {
    const scope = {}, session = new MosaicSession(() => new Worker(new URL('./mosaic.worker.ts', import.meta.url), { type: 'module' }));
    session.activate(); session.setScope(scope); let started = false;
    const stop = session.subscribe(() => { if (session.getSnapshot().phase.startsWith('Computing canonical')) { started = true; session.cancel(); } });
    const data = dataset(); data.query = source('query', 'ACGT'.repeat(250000));
    data.references = [source('one', 'ACGT'.repeat(500000)), source('two', 'GCTA'.repeat(500000))];
    try {
      assert.equal(await session.run(scope, { kind: 'analyze', dataset: data, options: {} }), false);
      assert.equal(started, true); assert.equal(session.getSnapshot().busy, false); assert.equal(session.getSnapshot().accepted, null);
    } finally { stop(); session.deactivate(); }
  }, 15000);
});
