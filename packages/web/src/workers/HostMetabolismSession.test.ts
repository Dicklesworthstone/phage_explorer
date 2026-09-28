import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { type HostModelInput } from '../../../core/src/analysis/host-metabolism';
import { executeHostMetabolismRequest, HostMetabolismSession, type HostMetabolismRequest, type HostMetabolismWorker, type HostMetabolismMessage } from './HostMetabolismSession';

// Two independent routes through a conserved pool. Maximum throughput is seven;
// restricting the only outlet to two changes that maximum to two, not five or nine.
export const input: HostModelInput = { format: 'phage-explorer-host-model', version: 1,
  source: { kind: 'local', name: 'User-supplied test network', version: '1', organism: 'Synthetic', strain: 'not biological', accession: 'test',
    reference: 'Analytical conservation fixture', license: 'CC0', fluxUnits: 'test units', objectiveUnits: 'test units' },
  medium: { name: 'seven', reference: 'explicit seven-unit supply', bounds: [] },
  cobra: { id: 'test', metabolites: [{ id: 'pool', compartment: 'c' }], reactions: [
    { id: 'supply', metabolites: { pool: 1 }, lower_bound: 0, upper_bound: 7 },
    { id: 'out', metabolites: { pool: -1 }, lower_bound: 0, upper_bound: 10, objective_coefficient: 1 },
  ] } };
const load: HostMetabolismRequest = { kind: 'import', content: JSON.stringify(input) };
const settings = { changes: [{ reactionId: 'out', lowerBound: 0, upperBound: 2,
  evidence: { kind: 'assumption' as const, reference: 'fixture', description: 'cap outlet', gene: null } }], variability: ['out'], objectiveLoss: 0 };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (v: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
class FakeWorker implements HostMetabolismWorker {
  onmessage: HostMetabolismWorker['onmessage'] = null; onerror: HostMetabolismWorker['onerror'] = null; onmessageerror: HostMetabolismWorker['onmessageerror'] = null;
  terminated = false; request: HostMetabolismRequest | null = null;
  postMessage(request: HostMetabolismRequest) { this.request = request; }
  terminate() { this.terminated = true; }
  send(message: HostMetabolismMessage) { this.onmessage?.({ data: message } as MessageEvent<HostMetabolismMessage>); }
}
function fixture() { const workers: FakeWorker[] = []; const session = new HostMetabolismSession(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }); session.activate(); return { session, workers }; }
async function accept(f: ReturnType<typeof fixture>, request = load) {
  const running = f.session.run(request); await flush(); const value = await executeHostMetabolismRequest(request);
  f.workers.at(-1)!.send({ kind: 'result', value }); await running; return value;
}

describe('host-model worker requests', () => {
  it('loads canonical and raw COBRA inputs without computing or replacing them with a demo', async () => {
    const loaded = await executeHostMetabolismRequest(load);
    assert.equal(loaded.result, null); assert.equal(loaded.record, null); assert.equal(loaded.input.source.kind, 'local');
    const prepared = await executeHostMetabolismRequest({ kind: 'prepare', content: JSON.stringify(input.cobra), source: input.source, medium: input.medium });
    assert.deepEqual(prepared.input, loaded.input);
    await assert.rejects(executeHostMetabolismRequest({ kind: 'import', content: '{}' }), /format/);
    await assert.rejects(executeHostMetabolismRequest({ kind: 'demo' } as never), /Unsupported/);
  });
  it('executes model scenarios and ranges then reproduces the complete saved record', async () => {
    const result = await executeHostMetabolismRequest({ kind: 'analyze', input, options: settings });
    assert.equal(result.result!.baseline.objective, 7); assert.equal(result.result!.perturbed!.objective, 2);
    assert.equal(result.result!.objectiveDelta, -5); assert.equal(result.result!.rangeChanges[0].interpretation, 'decreased');
    const restored = await executeHostMetabolismRequest({ kind: 'import', content: '\uFEFF' + serializeAnalysisRecord(result.record!) });
    assert.equal(restored.verified, true); assert.deepEqual(restored.result, result.result); assert.equal(restored.record!.resultId, result.record!.resultId);
  });
  it('rejects internally rehashed false output before returning accepted evidence', async () => {
    const result = await executeHostMetabolismRequest({ kind: 'analyze', input, options: settings });
    const forged = await parseAnalysisRecord(serializeAnalysisRecord(result.record!));
    (forged.fields.comparison.value as Record<string, unknown>).objectiveDelta = 500;
    const signed = await createAnalysisRecord({ ...forged, inputs: forged.inputs.map(({ sha256: _sha, ...row }) => row) });
    await assert.rejects(executeHostMetabolismRequest({ kind: 'import', content: serializeAnalysisRecord(signed) }), /Fresh host-model results differ/);
  });
  it('bounds input sizes and rejects unsupported mappings without a partial analysis', async () => {
    await assert.rejects(executeHostMetabolismRequest({ ...load, content: ' '.repeat(10 * 1024 * 1024 + 1) }), /size limit/);
    await assert.rejects(executeHostMetabolismRequest({ kind: 'prepare', content: ' '.repeat(2 * 1024 * 1024 + 1), source: input.source, medium: input.medium }), /size limit/);
    await assert.rejects(executeHostMetabolismRequest({ kind: 'analyze', input, options: { variability: ['absent'] } }), /absent/);
  });
});

describe('local host-model session lifecycle', () => {
  it('does not create a worker while inactive and terminates successful work', async () => {
    let count = 0; const inactive = new HostMetabolismSession(() => { count++; return new FakeWorker(); }); await inactive.run(load); assert.equal(count, 0);
    const f = fixture(); await accept(f); assert.equal(f.workers[0].terminated, true); assert.equal(f.session.getSnapshot().busy, false);
  });
  it('captures submitted source and settings before any asynchronous wait', async () => {
    const f = fixture(); const request: HostMetabolismRequest = { kind: 'analyze', input: structuredClone(input), options: structuredClone(settings) };
    const task = f.session.run(request); request.input.source.name = 'Edited'; request.options.objectiveLoss = 77; await flush();
    const sent = f.workers[0].request as Extract<HostMetabolismRequest, { kind: 'analyze' }>;
    assert.equal(sent.input.source.name, input.source.name); assert.equal(sent.options.objectiveLoss, 0); f.session.cancel(); await task;
  });
  it('cancels unresolved reads immediately without creating a worker', async () => {
    const f = fixture(), pending = deferred<HostMetabolismRequest>(); const task = f.session.run(pending.promise); f.session.cancel(); await task;
    pending.resolve(load); await flush(); assert.equal(f.workers.length, 0); assert.equal(f.session.getSnapshot().busy, false);
  });
  it('late rejected reads cannot clear a newer busy state or install an error', async () => {
    const f = fixture(), pending = deferred<HostMetabolismRequest>(); const old = f.session.run(pending.promise);
    const fresh = f.session.run(load); await old; await flush(); pending.reject(new Error('obsolete read')); await flush();
    assert.equal(f.session.getSnapshot().busy, true); assert.equal(f.session.getSnapshot().error, null);
    f.workers[0].send({ kind: 'result', value: await executeHostMetabolismRequest(load) }); await fresh;
  });
  it('cancels computation, ignores late progress/results and preserves the accepted run', async () => {
    const f = fixture(); await accept(f); const before = f.session.getSnapshot().accepted;
    const task = f.session.run({ kind: 'analyze', input, options: settings }); await flush(); f.session.cancel(); await task;
    const worker = f.workers[1]; worker.send({ kind: 'progress', phase: 'obsolete' }); worker.send({ kind: 'result', value: { ...before!, verified: true } });
    assert.equal(worker.terminated, true); assert.strictEqual(f.session.getSnapshot().accepted, before); assert.equal(f.session.getSnapshot().phase, '');
  });
  it('settles worker failures and malformed responses without destroying accepted evidence', async () => {
    const f = fixture(); await accept(f); const before = f.session.getSnapshot().accepted;
    for (const failure of ['error', 'decode', 'reported', 'invalid']) {
      const task = f.session.run(load); await flush(); const worker = f.workers.at(-1)!;
      if (failure === 'error') worker.onerror?.({} as ErrorEvent); else if (failure === 'decode') worker.onmessageerror?.({} as MessageEvent);
      else if (failure === 'reported') worker.send({ kind: 'error', message: 'bad model' }); else worker.send({ kind: 'result', value: {} } as never);
      await task; assert.equal(worker.terminated, true); assert.equal(f.session.getSnapshot().busy, false); assert.ok(f.session.getSnapshot().error); assert.strictEqual(f.session.getSnapshot().accepted, before);
    }
  });
  it('handles worker construction and postMessage failures', async () => {
    const failed = new HostMetabolismSession(() => { throw new Error('No worker'); }); failed.activate(); await failed.run(load);
    assert.equal(failed.getSnapshot().busy, false); assert.match(failed.getSnapshot().error!, /No worker/);
    const worker = new FakeWorker(); worker.postMessage = () => { throw new Error('Cannot clone'); };
    const session = new HostMetabolismSession(() => worker); session.activate(); await session.run(load); assert.equal(worker.terminated, true); assert.match(session.getSnapshot().error!, /clone/);
  });
  it('deactivation and reactivation cannot accept an old completion', async () => {
    const f = fixture(), old = f.session.run(load); await flush(); f.session.deactivate(); await old; f.session.activate();
    const fresh = f.session.run(load); await flush(); const value = await executeHostMetabolismRequest(load);
    f.workers[0].send({ kind: 'result', value }); assert.equal(f.session.getSnapshot().accepted, null);
    f.workers[1].send({ kind: 'result', value }); await fresh; assert.ok(f.session.getSnapshot().accepted);
  });
  it('clears obsolete results only after a replacement dataset is accepted', async () => {
    const f = fixture(); await accept(f, { kind: 'analyze', input, options: settings }); assert.ok(f.session.getSnapshot().accepted!.record);
    const before = f.session.getSnapshot().accepted, failed = f.session.run(load); await flush(); f.workers.at(-1)!.send({ kind: 'error', message: 'invalid input' }); await failed;
    assert.strictEqual(f.session.getSnapshot().accepted, before); await accept(f); assert.equal(f.session.getSnapshot().accepted!.record, null);
  });
  it('supports synchronous replies and reentrant cancellation during progress', async () => {
    const value = await executeHostMetabolismRequest(load), worker = new FakeWorker(); worker.postMessage = () => worker.send({ kind: 'result', value });
    const session = new HostMetabolismSession(() => worker); session.activate(); await session.run(load); assert.strictEqual(session.getSnapshot().accepted, value);
    const f = fixture(); f.session.subscribe(() => { if (f.session.getSnapshot().phase === 'stop') f.session.cancel(); });
    const task = f.session.run(load); await flush(); f.workers[0].send({ kind: 'progress', phase: 'stop' }); await task; assert.equal(f.workers[0].terminated, true);
  });
});
