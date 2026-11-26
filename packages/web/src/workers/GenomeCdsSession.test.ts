import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { importLocalGenomes } from '../../../core/src/genome-import';
import {
  GenomeCdsSession, executeGenomeCdsRequest, type GenomeCdsSelection, type GenomeCdsRequest,
  type GenomeCdsWorker, type GenomeCdsMessage, type GenomeCdsWorkResult,
} from './GenomeCdsSession';

const input = { name: 'private.gb', text: `LOCUS       PRIVATE 18 bp DNA circular
ACCESSION   PRIVATE
FEATURES             Location/Qualifiers
     CDS             1..9
                     /locus_tag="duplicate"
     CDS             complement(10..18)
                     /locus_tag="duplicate"
                     /pseudo
ORIGIN
        1 atgaaataattatttcat
//
` };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeWorker implements GenomeCdsWorker {
  onmessage: GenomeCdsWorker['onmessage'] = null;
  onerror: GenomeCdsWorker['onerror'] = null;
  onmessageerror: GenomeCdsWorker['onmessageerror'] = null;
  request: GenomeCdsRequest | null = null;
  terminated = false;
  postMessage(request: GenomeCdsRequest): void { this.request = request; }
  terminate(): void { this.terminated = true; }
  send(message: GenomeCdsMessage): void { this.onmessage?.({ data: message } as MessageEvent<GenomeCdsMessage>); }
}
async function selection(source = input): Promise<GenomeCdsSelection> {
  return { contentId: (await importLocalGenomes(source)).genomes[0].phage.localGenome!.contentId, input: { ...source } };
}
function fixture(scope: GenomeCdsSelection) {
  const workers: FakeWorker[] = [], waiting: Array<ReturnType<typeof deferred<FakeWorker>>> = [];
  let delivered = 0;
  const session = new GenomeCdsSession(() => {
    const worker = new FakeWorker(); workers.push(worker); waiting.shift()?.resolve(worker); return worker;
  });
  session.activate(); session.setScope(scope);
  const next = () => {
    const worker = workers[delivered++];
    if (worker) return Promise.resolve(worker);
    const pending = deferred<FakeWorker>(); waiting.push(pending); return pending.promise;
  };
  return { session, scope, workers, next };
}
const request = (scope: GenomeCdsSelection): GenomeCdsRequest => ({ kind: 'analyze', input: { ...scope.input }, options: { record: scope.contentId, geneIds: null } });
async function accept(f: ReturnType<typeof fixture>, req = request(f.scope)): Promise<GenomeCdsWorkResult> {
  const task = f.session.run(f.scope, req), worker = await f.next();
  const value = await executeGenomeCdsRequest(worker.request!);
  worker.send({ kind: 'result', value }); assert.equal(await task, true); return value;
}

describe('local genome CDS browser session', () => {
  it('runs real source-bound production and replay, rejecting rehashed false sequences', async () => {
    const scope = await selection(), value = await executeGenomeCdsRequest(request(scope));
    assert.deepEqual(value.experiment.result.rows.map(row => row.cds), ['ATGAAATAA', 'ATGAAATAA']);
    assert.deepEqual(value.experiment.result.rows.map(row => row.protein), ['MK*', null]);
    assert.deepEqual(value.experiment.input, input);
    const saved = serializeAnalysisRecord(value.experiment.record);
    const replay = await executeGenomeCdsRequest({ kind: 'replay', content: '\uFEFF' + saved });
    assert.equal(replay.verified, true); assert.deepEqual(replay.experiment, value.experiment);
    const changed = structuredClone(value.experiment.record);
    (changed.fields.cds.value as unknown as typeof value.experiment.result).rows[0].protein = 'FALSE';
    const forged = await createAnalysisRecord({ ...changed, inputs: changed.inputs.map(({ sha256: _sha, ...source }) => source) });
    await assert.rejects(executeGenomeCdsRequest({ kind: 'replay', content: serializeAnalysisRecord(forged) }), /Recomputed/);
    await assert.rejects(executeGenomeCdsRequest({ kind: 'unknown' } as never), /Unsupported/);
  });

  it('offers JSON, complete TSV, DNA and proteins only for the accepted exact selection', async () => {
    const f = fixture(await selection()); await accept(f);
    const saved = f.session.export(f.scope, 'json')!;
    assert.equal((await parseAnalysisRecord(saved.content)).parameters.record, f.scope.contentId);
    assert.match(f.session.export(f.scope, 'tsv')!.content, /Unsupported \/pseudo qualifier/);
    assert.equal(f.session.export(f.scope, 'cds')!.content.split('\n').filter(line => line === 'ATGAAATAA').length, 2);
    assert.match(f.session.export(f.scope, 'protein')!.content, /\nMK\*\n$/);
    assert.match(saved.filename, /^phage-cds-[a-f0-9]{12}-[a-f0-9]{12}\.json$/);
    assert.equal(f.session.export({ ...f.scope }, 'json'), null);
    const replay = await accept(f, { kind: 'replay', content: saved.content });
    assert.equal(f.session.getAccepted(f.scope)!.verified, true);
    assert.equal(replay.experiment.record.resultId, (await parseAnalysisRecord(saved.content)).resultId);
  });

  it('failed and cancelled replacements preserve accepted evidence and terminate their workers', async () => {
    const f = fixture(await selection()); await accept(f); const before = f.session.getAccepted(f.scope);
    const failed = f.session.run(f.scope, request(f.scope)), worker = await f.next();
    assert.equal(f.session.export(f.scope, 'json'), null);
    worker.send({ kind: 'error', message: 'Source rejected' }); assert.equal(await failed, false);
    assert.strictEqual(f.session.getAccepted(f.scope), before); assert.equal(worker.terminated, true);
    assert.match(f.session.getSnapshot().error!, /Source rejected/);
    const task = f.session.run(f.scope, request(f.scope)), cancelled = await f.next();
    const late = cancelled.onmessage; f.session.cancel(); assert.equal(await task, false);
    late?.({ data: { kind: 'result', value: before! } } as MessageEvent<GenomeCdsMessage>);
    assert.strictEqual(f.session.getAccepted(f.scope), before); assert.equal(cancelled.terminated, true);
    assert.match(f.session.getSnapshot().notice!, /preserved/);
    assert.ok(f.session.export(f.scope, 'json'));
  });

  it('source changes retire old downloads immediately and cannot relabel a late reply', async () => {
    const f = fixture(await selection()); const before = await accept(f);
    const task = f.session.run(f.scope, request(f.scope)), worker = await f.next(), late = worker.onmessage;
    const other = await selection({ ...input, text: input.text.replace('atgaaa', 'atgccc') });
    f.session.setScope(other); assert.equal(await task, false);
    assert.equal(f.session.export(f.scope, 'json'), null); assert.equal(f.session.getAccepted(other), null);
    assert.equal(worker.terminated, true);
    late?.({ data: { kind: 'result', value: before } } as MessageEvent<GenomeCdsMessage>);
    assert.equal(f.session.getAccepted(other), null);
    assert.equal(await f.session.run(other, { kind: 'replay', content: serializeAnalysisRecord(before.experiment.record) }), false);
    assert.match(f.session.getSnapshot().error!, /different genome/);
    assert.equal(f.workers.length, 2, 'different-source replay is rejected before worker allocation');
  });

  it('captures submitted data before listener mutation and cancels unresolved file reads promptly', async () => {
    const f = fixture(await selection()), req = request(f.scope) as Extract<GenomeCdsRequest, { kind: 'analyze' }>;
    const unsubscribe = f.session.subscribe(() => {
      if (f.session.getSnapshot().busy) { req.input.text = '>changed\nAAAA'; req.options.geneIds = [999]; }
    });
    const task = f.session.run(f.scope, req), worker = await f.next();
    assert.deepEqual((worker.request as typeof req).input, input);
    assert.equal((worker.request as typeof req).options.geneIds, null);
    f.session.cancel(); assert.equal(await task, false); unsubscribe();
    const file = deferred<GenomeCdsRequest>(), read = f.session.run(f.scope, () => file.promise);
    f.session.cancel(); assert.equal(await read, false);
    file.resolve(request(f.scope)); await Promise.resolve();
    assert.equal(f.workers.length, 1);
  });

  it('rejects detached results, wrong source binding and worker failures without replacing accepted results', async () => {
    const f = fixture(await selection()); const baseline = await accept(f), accepted = f.session.getAccepted(f.scope);
    for (const mode of ['detached', 'source', 'verified', 'decode', 'error', 'protocol']) {
      const task = f.session.run(f.scope, request(f.scope)), worker = await f.next(), response = structuredClone(baseline);
      if (mode === 'decode') worker.onmessageerror?.({} as MessageEvent);
      else if (mode === 'error') worker.onerror?.({} as ErrorEvent);
      else if (mode === 'protocol') worker.send({ kind: 'result', value: {} as GenomeCdsWorkResult });
      else {
        if (mode === 'detached') response.experiment.result.rows[0].protein = 'FALSE';
        if (mode === 'source') response.experiment.input.name = 'relabeled.gb';
        if (mode === 'verified') response.verified = true;
        worker.send({ kind: 'result', value: response });
      }
      assert.equal(await task, false, mode); assert.equal(worker.terminated, true);
      assert.strictEqual(f.session.getAccepted(f.scope), accepted); assert.ok(f.session.getSnapshot().error);
    }
  });

  it('construction/clone failures and deactivation settle ownership; synchronous replies remain supported', async () => {
    const scope = await selection();
    for (const factory of [() => { throw new Error('construction failed'); }, () => {
      const worker = new FakeWorker(); worker.postMessage = () => { throw new Error('clone failed'); }; return worker;
    }]) {
      const session = new GenomeCdsSession(factory); session.activate(); session.setScope(scope);
      assert.equal(await session.run(scope, request(scope)), false);
      assert.equal(session.getSnapshot().busy, false); assert.match(session.getSnapshot().error!, /failed/);
    }
    const value = await executeGenomeCdsRequest(request(scope)), worker = new FakeWorker();
    worker.postMessage = () => worker.send({ kind: 'result', value });
    const synchronous = new GenomeCdsSession(() => worker); synchronous.activate(); synchronous.setScope(scope);
    assert.equal(await synchronous.run(scope, request(scope)), true); assert.equal(worker.terminated, true);
    const f = fixture(scope), pending = f.session.run(scope, request(scope)), old = await f.next();
    f.session.deactivate(); assert.equal(await pending, false); f.session.activate();
    assert.equal(old.terminated, true); assert.equal(f.session.getAccepted(scope), null);
    assert.equal(await f.session.run({ ...scope }, request(scope)), false);
    assert.equal(f.workers.length, 1);
  });
});
