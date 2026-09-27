import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { PangenomeSession, executePangenomeRequest, type PangenomeWorker, type PangenomeRequest, type PangenomeMessage } from './PangenomeSession';

const content = '>ref\nACGT--ACGT\n>q1\nACGTGGAC-T\n>q2\nATGT--ACGT';
const request: PangenomeRequest = { kind: 'import', content, filename: 'private.fasta' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
class FakeWorker implements PangenomeWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  terminated = 0;
  submitted: PangenomeRequest | null = null;
  constructor(private auto = true) {}
  terminate() { this.terminated++; }
  postMessage(value: PangenomeRequest) { this.submitted = structuredClone(value); if (this.auto) void this.complete(); }
  send(message: PangenomeMessage) { this.onmessage?.call(this as unknown as Worker, { data: message } as MessageEvent); }
  async complete() {
    try { this.send({ kind: 'result', result: await executePangenomeRequest(this.submitted!, phase => this.send({ kind: 'progress', phase })) }); }
    catch (cause) { this.send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
  }
}
function fixture(auto = true) {
  const workers: FakeWorker[] = [];
  const session = new PangenomeSession(() => { const worker = new FakeWorker(auto); workers.push(worker); return worker; });
  session.activate();
  return { session, workers };
}
async function analyzed() {
  const f = fixture();
  await f.session.run(request);
  const accepted = f.session.getSnapshot().accepted!;
  await f.session.run({ kind: 'analyze', input: accepted.input, options: { ...accepted.options, referenceId: 'ref' } });
  return f;
}

describe('private sequence graph workspace', () => {
  it('separates local ingestion from explicit graph computation', async () => {
    const f = fixture(); await f.session.run(request);
    const accepted = f.session.getSnapshot().accepted!;
    assert.equal(accepted.input.source, 'local'); assert.equal(accepted.graph, null); assert.equal(accepted.record, null);
    assert.equal(f.session.getSnapshot().busy, false); assert.equal(f.workers[0].terminated, 1);
    await f.session.run({ kind: 'analyze', input: accepted.input, options: { ...accepted.options, referenceId: 'ref' } });
    assert.deepEqual(f.session.getSnapshot().accepted!.graph!.variants.map(v => [v.type, v.referenceStart, v.alternate]),
      [['snv', 1, 'T'], ['insertion', 4, 'GG'], ['deletion', 6, '']]);
    assert.equal(f.workers[1].terminated, 1); f.session.deactivate();
  });
  it('preserves known shared bases on either side of ambiguous sequence through the worker record', async () => {
    const loaded = await executePangenomeRequest({ kind: 'import', filename: 'ambiguity.fa', content: '>a\nACNNGT\n>b\nACNNGT' });
    const result = await executePangenomeRequest({ kind: 'analyze', input: loaded.input, options: loaded.options });
    assert.equal(result.graph!.diagnostics.sharedUnambiguousBases, 4);
    assert.deepEqual(result.graph!.nodes.map(node => [node.sequence, node.core, node.ambiguous]),
      [['AC', true, false], ['NN', false, true], ['GT', true, false]]);
    assert.equal((result.record!.fields.diagnostics.value as Record<string, unknown>).sharedUnambiguousBases, 4);
  });
  it('does not load demo data unless explicitly requested', async () => {
    const f = fixture(); assert.equal(f.session.getSnapshot().accepted, null);
    await f.session.run({ ...request, content: 'broken' });
    assert.equal(f.session.getSnapshot().accepted, null); assert.ok(f.session.getSnapshot().error);
    await f.session.run({ kind: 'demo' });
    assert.equal(f.session.getSnapshot().accepted!.input.source, 'demo');
    assert.equal(f.session.getSnapshot().accepted!.graph, null); f.session.deactivate();
  });
  it('preserves accepted data and results after malformed replacement or incompatible alignment', async () => {
    const f = await analyzed(), accepted = f.session.getSnapshot().accepted;
    await f.session.run({ ...request, content: '>one\nRNA\n>two\nUUU' });
    assert.strictEqual(f.session.getSnapshot().accepted, accepted); assert.ok(f.session.getSnapshot().error);
    await f.session.run({ kind: 'analyze', input: accepted!.input, options: { ...accepted!.options, alignment: 'global' } });
    assert.strictEqual(f.session.getSnapshot().accepted, accepted); assert.match(f.session.getSnapshot().error!, /ungapped/);
    f.session.deactivate();
  });
  it('captures parameters and input before a caller can mutate a queued request', async () => {
    const f = fixture();
    const pending: PangenomeRequest = { ...request };
    const running = f.session.run(pending); pending.content = '>changed\nA';
    await running;
    assert.equal(f.session.getSnapshot().accepted!.input.sequences.length, 3);
    const accepted = f.session.getSnapshot().accepted!;
    const work: PangenomeRequest = { kind: 'analyze', input: structuredClone(accepted.input), options: { ...accepted.options, referenceId: 'ref' } };
    const task = f.session.run(work); work.options.referenceId = 'q1'; work.input.sequences[0].sequence = 'AAAA';
    await task;
    assert.equal(f.session.getSnapshot().accepted!.graph!.options.referenceId, 'ref');
    assert.equal(f.session.getSnapshot().accepted!.graph!.referenceLength, 8); f.session.deactivate();
  });
  it('settles cancellation immediately without waiting for a file read and starts no worker', async () => {
    const f = fixture(), read = deferred<PangenomeRequest>();
    const pending = f.session.run(read.promise); f.session.cancel(); await pending;
    assert.equal(f.workers.length, 0); assert.equal(f.session.getSnapshot().busy, false);
    read.resolve(request); await flush(); assert.equal(f.workers.length, 0); f.session.deactivate();
  });
  it('ignores errors from a cancelled file after a newer dataset is accepted', async () => {
    const f = fixture(), read = deferred<PangenomeRequest>();
    const pending = f.session.run(read.promise); f.session.cancel();
    await f.session.run(request); const accepted = f.session.getSnapshot().accepted;
    read.reject(new Error('obsolete read error')); await pending; await flush();
    assert.strictEqual(f.session.getSnapshot().accepted, accepted); assert.equal(f.session.getSnapshot().error, null); f.session.deactivate();
  });
  it('terminates an executing worker and prevents its captured late response overwriting a newer result', async () => {
    const f = fixture(false); const old = f.session.run(request); await flush();
    const first = f.workers[0], stale = first.onmessage!;
    f.session.cancel(); await old; assert.equal(first.terminated, 1);
    const fresh = f.session.run({ ...request, filename: 'replacement.fasta' }); await flush();
    stale.call(first as unknown as Worker, { data: { kind: 'result', result: await executePangenomeRequest(request) } } as MessageEvent);
    assert.equal(f.session.getSnapshot().busy, true); assert.equal(f.session.getSnapshot().accepted, null);
    await f.workers[1].complete(); await fresh;
    assert.equal(f.session.getSnapshot().accepted!.input.name, 'replacement.fasta'); f.session.deactivate();
  });
  it('recovers from construction, transport and worker errors without leaving the workspace busy', async () => {
    const broken = new PangenomeSession(() => { throw new Error('construction failed'); }); broken.activate();
    await broken.run(request); assert.equal(broken.getSnapshot().busy, false); assert.match(broken.getSnapshot().error!, /construction failed/);
    broken.deactivate();
    for (const kind of ['error', 'messageerror', 'unexpected'] as const) {
      const f = fixture(false), running = f.session.run(request); await flush();
      const worker = f.workers[0];
      if (kind === 'error') worker.onerror?.call(worker as unknown as Worker, new Event('error') as ErrorEvent);
      else if (kind === 'messageerror') worker.onmessageerror?.call(worker as unknown as Worker, {} as MessageEvent);
      else worker.onmessage?.call(worker as unknown as Worker, { data: { kind: 'unknown' } } as MessageEvent);
      await running; assert.equal(f.session.getSnapshot().busy, false); assert.ok(f.session.getSnapshot().error); assert.equal(worker.terminated, 1);
      const retry = f.session.run(request); await flush(); await f.workers[1].complete(); await retry;
      assert.ok(f.session.getSnapshot().accepted); assert.equal(f.session.getSnapshot().error, null); f.session.deactivate();
    }
  });
  it('retains accepted experiments across close/reopen while cancelling unfinished work', async () => {
    const f = await analyzed(), accepted = f.session.getSnapshot().accepted;
    f.session.deactivate(); assert.strictEqual(f.session.getSnapshot().accepted, accepted);
    await f.session.run(request); assert.strictEqual(f.session.getSnapshot().accepted, accepted);
    f.session.activate(); await f.session.run({ ...request, filename: 'new.fasta' });
    assert.equal(f.session.getSnapshot().accepted!.input.name, 'new.fasta'); f.session.deactivate();
  });
  it('recognizes saved analysis, recomputes it and verifies exact graph identity', async () => {
    const source = await analyzed(), original = source.session.getSnapshot().accepted!;
    const target = fixture();
    await target.session.run({ kind: 'import', filename: 'record.json', content: serializeAnalysisRecord(original.record!) });
    const restored = target.session.getSnapshot().accepted!;
    assert.equal(restored.verified, true); assert.deepEqual(restored.graph, original.graph);
    assert.equal(restored.record!.resultId, original.record!.resultId); assert.match(target.session.getSnapshot().notice!, /Verified/);
    source.session.deactivate(); target.session.deactivate();
  });
  it('does not install a valid-checksum forged graph even when it has compatible inputs and method', async () => {
    const f = await analyzed(), accepted = f.session.getSnapshot().accepted!;
    const record = structuredClone(accepted.record!);
    (record.fields.variants.value as Array<Record<string, unknown>>)[0].referenceStart = 0;
    const forged = await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...value }) => value) });
    await f.session.run({ kind: 'import', content: serializeAnalysisRecord(forged), filename: 'forged.json' });
    assert.strictEqual(f.session.getSnapshot().accepted, accepted); assert.match(f.session.getSnapshot().error!, /Recomputed/);
    f.session.deactivate();
  });
  it('rejects oversized imports without silently truncating or replacing accepted data', async () => {
    const f = await analyzed(), accepted = f.session.getSnapshot().accepted;
    await f.session.run({ ...request, content: 'X'.repeat(10 * 1024 * 1024 + 1) });
    assert.strictEqual(f.session.getSnapshot().accepted, accepted); assert.match(f.session.getSnapshot().error!, /10 MiB/); f.session.deactivate();
  });
});
