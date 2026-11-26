import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  analysisJson, createAnalysisRecord, importLocalGenomes, parseAnalysisRecord, serializeAnalysisRecord, type PhageFull,
} from '@phage-explorer/core';
import {
  RegionComparisonSession, executeRegionComparisonRequest, readRegionComparisonPair,
  type RegionComparisonScope, type RegionComparisonRequest, type RegionComparisonWorker, type RegionComparisonMessage,
  type RegionComparisonWorkResult,
} from './RegionComparisonSession';

const inputA = { name: 'two-records.fasta', text: '>unselected\nAAAAAAAAAAAA\n>chosen_a\nTTTACGTAACCC\n' };
const inputB = { name: 'query.fasta', text: '>chosen_b\nGGGTTACGTAAA\n' };
const regions = { regionA: { start: 3, end: 9, strand: '+' as const }, regionB: { start: 3, end: 9, strand: '-' as const } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function selection(): Promise<RegionComparisonScope> {
  const a = (await importLocalGenomes({ ...inputA })).genomes[1], b = (await importLocalGenomes({ ...inputB })).genomes[0];
  // Preserve the importer's complete multi-record source and select its second record.
  return { repository: null, phageA: a.phage, phageB: b.phage, localA: a, localB: b };
}
class FakeWorker implements RegionComparisonWorker {
  onmessage: RegionComparisonWorker['onmessage'] = null;
  onerror: RegionComparisonWorker['onerror'] = null;
  onmessageerror: RegionComparisonWorker['onmessageerror'] = null;
  request: RegionComparisonRequest | null = null;
  terminated = false;
  postMessage(request: RegionComparisonRequest): void { this.request = structuredClone(request); }
  terminate(): void { this.terminated = true; }
  send(message: RegionComparisonMessage): void { this.onmessage?.({ data: message } as MessageEvent<RegionComparisonMessage>); }
}
function fixture(scope: RegionComparisonScope, timeout = 30000) {
  const workers: FakeWorker[] = [], waiting: Array<ReturnType<typeof deferred<FakeWorker>>> = [];
  let delivered = 0;
  const session = new RegionComparisonSession(() => {
    const worker = new FakeWorker(); workers.push(worker); waiting.shift()?.resolve(worker); return worker;
  }, timeout);
  session.activate(); session.setScope(scope);
  const next = () => {
    const worker = workers[delivered++];
    if (worker) return Promise.resolve(worker);
    const pending = deferred<FakeWorker>(); waiting.push(pending); return pending.promise;
  };
  return { session, scope, workers, next };
}
async function finish(task: Promise<boolean>, worker: FakeWorker): Promise<RegionComparisonWorkResult> {
  const value = await executeRegionComparisonRequest(worker.request!);
  worker.send({ kind: 'result', value });
  assert.equal(await task, true); assert.equal(worker.terminated, true);
  return value;
}
async function accept(f: ReturnType<typeof fixture>): Promise<RegionComparisonWorkResult> {
  const task = f.session.analyze(f.scope, regions);
  return finish(task, await f.next());
}

describe('exact source region comparison browser ownership', () => {
  it('keeps complete multi-record originals and explicitly selects the requested records', async () => {
    const scope = await selection(), pair = await readRegionComparisonPair(scope, new AbortController().signal);
    assert.deepEqual(pair.inputA, inputA); assert.deepEqual(pair.inputB, inputB);
    assert.equal(pair.recordA, scope.phageA!.localGenome!.contentId);
    assert.equal(pair.recordB, scope.phageB!.localGenome!.contentId);
    const value = await executeRegionComparisonRequest({ kind: 'analyze', inputA: pair.inputA, inputB: pair.inputB,
      options: { recordA: pair.recordA, recordB: pair.recordB, ...regions } });
    assert.equal(value.experiment.result.sourceA.accession, 'chosen_a');
    assert.equal(value.experiment.result.regionA.sequence, 'ACGTAA');
    assert.equal(value.experiment.result.regionB.sequence, 'ACGTAA');
    assert.equal(value.experiment.result.stats.distance, 0);
    assert.deepEqual(value.experiment.result.runs.map(row => [row.sourceStartA, row.sourceEndA, row.sourceStartB, row.sourceEndB]), [[3, 9, 3, 9]]);
    assert.equal(value.verified, false);
  });

  it('exports accepted inputs and full alignments, then replays with no selected sources or repository', async () => {
    const f = fixture(await selection()), value = await accept(f), saved = f.session.export(f.scope, 'json')!;
    assert.match(saved.filename, /^phage-region-[a-f0-9]{12}\.json$/);
    const parsed = await parseAnalysisRecord(saved.content);
    assert.deepEqual(parsed.inputs[0].data, inputA);
    assert.equal(parsed.parameters.recordA, f.scope.phageA!.localGenome!.contentId);
    const fasta = f.session.export(f.scope, 'fasta')!.content;
    assert.equal(fasta.split('\n').filter(row => row.startsWith('>')).length, 2);
    assert.equal(fasta.split('\n').filter(row => row === 'ACGTAA').length, 2);
    assert.ok(f.session.export(f.scope, 'tsv')!.content.split('\n').length > value.experiment.result.runs.length);
    assert.equal(f.session.export({ ...f.scope }, 'json'), null);
    const empty: RegionComparisonScope = { repository: null, phageA: null, phageB: null, localA: null, localB: null };
    f.session.setScope(empty);
    assert.equal(f.session.getAccepted(empty), null); assert.equal(f.session.export(f.scope, 'json'), null);
    const replay = f.session.replay(empty, '\uFEFF' + saved.content), worker = await f.next();
    const restored = await finish(replay, worker);
    assert.equal(restored.verified, true);
    assert.equal(restored.experiment.record.resultId, parsed.resultId);
    assert.equal(f.session.export(empty, 'json')!.content, saved.content);
  });

  it('allows the same exact source on both sides without changing its original selection', async () => {
    const selected = await selection();
    const scope = { ...selected, phageB: selected.phageA, localB: selected.localA }, f = fixture(scope);
    const task = f.session.analyze(scope, { regionA: regions.regionA, regionB: regions.regionA });
    const value = await finish(task, await f.next());
    assert.equal(value.experiment.options.recordA, value.experiment.options.recordB);
    assert.deepEqual(value.experiment.inputA, value.experiment.inputB);
    assert.equal(value.experiment.result.stats.distance, 0);
  });

  it('failed and cancelled replacements preserve accepted evidence and retire every worker', async () => {
    const f = fixture(await selection()); await accept(f);
    const before = f.session.getAccepted(f.scope), beforeJson = f.session.export(f.scope, 'json')!.content;
    const failed = f.session.analyze(f.scope, regions), worker = await f.next();
    assert.equal(f.session.export(f.scope, 'json'), null);
    worker.send({ kind: 'error', message: 'Exact alignment budget exceeded' });
    assert.equal(await failed, false); assert.equal(worker.terminated, true);
    assert.strictEqual(f.session.getAccepted(f.scope), before);
    const cancelled = f.session.analyze(f.scope, { ...regions, regionB: { ...regions.regionB, strand: '+' } });
    const abandoned = await f.next(), late = abandoned.onmessage;
    const other = await executeRegionComparisonRequest(abandoned.request!);
    f.session.cancel();
    assert.equal(await cancelled, false); assert.equal(abandoned.terminated, true);
    late?.({ data: { kind: 'result', value: other } } as MessageEvent<RegionComparisonMessage>);
    assert.strictEqual(f.session.getAccepted(f.scope), before);
    assert.equal(f.session.export(f.scope, 'json')!.content, beforeJson);
    assert.match(f.session.getSnapshot().notice!, /preserved/);
  });

  it('changing sources retires accepted exports and queued replies even when display names match', async () => {
    const f = fixture(await selection()), before = await accept(f);
    const task = f.session.analyze(f.scope, regions), worker = await f.next(), late = worker.onmessage;
    const replacement = await selection();
    f.session.setScope(replacement);
    assert.equal(await task, false); assert.equal(worker.terminated, true);
    assert.equal(f.session.getAccepted(replacement), null);
    assert.equal(f.session.export(f.scope, 'json'), null);
    late?.({ data: { kind: 'result', value: before } } as MessageEvent<RegionComparisonMessage>);
    assert.equal(f.session.getAccepted(replacement), null);
  });

  it('snapshots interval drafts and detects in-place source mutation before accepting or exporting', async () => {
    const f = fixture(await selection()), draft = structuredClone(regions);
    const task = f.session.analyze(f.scope, draft);
    draft.regionA.start = 0;
    const worker = await f.next();
    assert.deepEqual((worker.request as Extract<RegionComparisonRequest, { kind: 'analyze' }>).options.regionA, regions.regionA);
    await finish(task, worker);
    const originalText = f.scope.localA!.original.text;
    f.scope.localA!.original.text += '\n';
    assert.equal(f.session.export(f.scope, 'json'), null);
    f.scope.localA!.original.text = originalText;
    const pending = f.session.analyze(f.scope, regions), next = await f.next();
    f.scope.localA!.original.text += '\n';
    next.send({ kind: 'result', value: await executeRegionComparisonRequest(next.request!) });
    assert.equal(await pending, false);
    assert.match(f.session.getSnapshot().error!, /selected source changed/);
    assert.equal(next.terminated, true);
  });

  it('rejects valid worker evidence for different submitted intervals and malformed mapped coordinates', async () => {
    const f = fixture(await selection()); await accept(f); const previous = f.session.getAccepted(f.scope);
    const task = f.session.analyze(f.scope, regions), worker = await f.next();
    const different = structuredClone(worker.request!) as Extract<RegionComparisonRequest, { kind: 'analyze' }>;
    different.options.regionB.strand = '+';
    worker.send({ kind: 'result', value: await executeRegionComparisonRequest(different) });
    assert.equal(await task, false); assert.strictEqual(f.session.getAccepted(f.scope), previous);
    const forgedTask = f.session.analyze(f.scope, regions), forgedWorker = await f.next();
    const forged = await executeRegionComparisonRequest(forgedWorker.request!);
    forged.experiment.result.runs[0].sourceEndB--;
    const record = forged.experiment.record;
    const comparison = record.fields.comparison;
    assert.ok(comparison.kind === 'sequence-score');
    forged.experiment.record = await createAnalysisRecord({
      ...record, inputs: record.inputs.map(({ sha256: _sha, ...source }) => source),
      fields: { ...record.fields, comparison: { ...comparison, value: analysisJson(forged.experiment.result) } },
    });
    forgedWorker.send({ kind: 'result', value: forged });
    assert.equal(await forgedTask, false); assert.strictEqual(f.session.getAccepted(f.scope), previous);
    assert.match(f.session.getSnapshot().error!, /inconsistent source or alignment/);
  });

  it('fresh standalone replay rejects rehashed false results and wrong-method records', async () => {
    const f = fixture(await selection()), accepted = await accept(f), record = structuredClone(accepted.experiment.record);
    const changed = record.fields.comparison.value as unknown as typeof accepted.experiment.result;
    changed.stats.distance++;
    const forged = await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...source }) => source) });
    await assert.rejects(executeRegionComparisonRequest({ kind: 'replay', content: serializeAnalysisRecord(forged) }));
    const wrong = await createAnalysisRecord({
      ...record, method: { ...record.method, id: 'genome-comparison' }, inputs: record.inputs.map(({ sha256: _sha, ...source }) => source),
    });
    assert.equal(await f.session.replay(f.scope, serializeAnalysisRecord(wrong)), false);
    assert.equal(f.workers.length, 1, 'wrong methods are rejected before worker allocation');
    assert.equal(f.session.getAccepted(f.scope)!.experiment.record.resultId, accepted.experiment.record.resultId);
  });

  it('cancels unresolved reads immediately and enforces a deadline without accepting partial evidence', async () => {
    const f = fixture(await selection()), held = deferred<string>();
    const pending = f.session.replay(f.scope, () => held.promise);
    f.session.cancel(); assert.equal(await pending, false); assert.equal(f.workers.length, 0);
    held.resolve('not an experiment');
    await Promise.resolve();
    assert.equal(f.session.getAccepted(f.scope), null);
    const timeout = fixture(await selection(), 10);
    assert.equal(await timeout.session.replay(timeout.scope, () => new Promise<string>(() => {})), false);
    assert.match(timeout.session.getSnapshot().error!, /timed out/);
    assert.equal(timeout.session.getSnapshot().busy, false);
    const workerTimeout = fixture(await selection(), 100);
    const task = workerTimeout.session.analyze(workerTimeout.scope, regions), worker = await workerTimeout.next();
    assert.equal(await task, false); assert.equal(worker.terminated, true);
    assert.match(workerTimeout.session.getSnapshot().error!, /timed out/);
  });

  it('refuses a missing local original instead of substituting the current catalog sequence', async () => {
    const scope = await selection(); scope.localA = null;
    await assert.rejects(readRegionComparisonPair(scope, new AbortController().signal), /complete original input/);
  });
});

describe('complete source capture for catalog region comparison', () => {
  async function catalog() {
    const source = (await selection()).localA!;
    const phage: PhageFull = { ...source.phage, id: 17, slug: 'source', localGenome: undefined, name: 'Catalog source' };
    let version = 'a'.repeat(64), sequenceReads = 0;
    const repository = {
      getPhageById: async () => phage, getFullGenomeLength: async () => source.sequence.length,
      getSequenceWindow: async () => { sequenceReads++; return source.sequence; },
      getOfflineDataset: () => ({ describe: () => ({ contentVersion: version }) }),
    } as unknown as RegionComparisonScope['repository'];
    const scope: RegionComparisonScope = { repository, phageA: phage, phageB: phage, localA: null, localB: null };
    return { source, phage, scope, repository: repository!, reads: () => sequenceReads, changeVersion: () => { version = 'b'.repeat(64); } };
  }

  it('captures full catalog sequence, annotations and version before interval slicing', async () => {
    const c = await catalog(), pair = await readRegionComparisonPair(c.scope, new AbortController().signal);
    const snapshot = JSON.parse(pair.inputA.text);
    assert.equal(snapshot.format, 'phage-explorer-catalog-snapshot');
    assert.equal(snapshot.genome.sequence, c.source.sequence);
    assert.equal(snapshot.provenance.contentVersion, 'a'.repeat(64));
    assert.equal(pair.recordA, null); assert.equal(pair.recordB, null);
    const result = await executeRegionComparisonRequest({ kind: 'analyze', inputA: pair.inputA, inputB: pair.inputB,
      options: { recordA: pair.recordA, recordB: pair.recordB, regionA: regions.regionA, regionB: regions.regionA } });
    assert.equal(result.experiment.result.sourceA.format, 'catalog-snapshot');
    assert.equal(result.experiment.result.stats.distance, 0);
  });

  it('snapshots loaded annotations before a delayed sequence read and rejects dataset replacement', async () => {
    const c = await catalog(), started = deferred<void>(), sequence = deferred<string>();
    c.repository.getSequenceWindow = async () => { started.resolve(); return sequence.promise; };
    const task = readRegionComparisonPair(c.scope, new AbortController().signal);
    await started.promise; c.phage.name = 'Changed after capture'; sequence.resolve(c.source.sequence);
    const captured = await task;
    assert.equal(JSON.parse(captured.inputA.text).genome.name, 'Catalog source');
    const changed = await catalog();
    changed.repository.getSequenceWindow = async () => { changed.changeVersion(); return changed.source.sequence; };
    await assert.rejects(readRegionComparisonPair(changed.scope, new AbortController().signal), /catalog changed/);
  });

  it('rejects wrong or truncated source reads and abandons delayed metadata without starting sequence work', async () => {
    const wrong = await catalog();
    wrong.repository.getPhageById = async () => ({ ...wrong.phage, accession: 'wrong-source' });
    await assert.rejects(readRegionComparisonPair(wrong.scope, new AbortController().signal), /differs from the selected/);
    assert.equal(wrong.reads(), 0);
    const truncated = await catalog();
    truncated.repository.getSequenceWindow = async () => truncated.source.sequence.slice(1);
    await assert.rejects(readRegionComparisonPair(truncated.scope, new AbortController().signal), /complete catalog sequence/);
    const delayed = await catalog(), metadata = deferred<PhageFull>(), controller = new AbortController();
    delayed.repository.getPhageById = async () => metadata.promise;
    const pending = readRegionComparisonPair(delayed.scope, controller.signal);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    metadata.resolve(delayed.phage); await Promise.resolve(); await Promise.resolve();
    assert.equal(delayed.reads(), 0);
  });
});
