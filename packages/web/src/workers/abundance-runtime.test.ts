import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { executeAbundanceRequest, type AbundanceWorkerMessage, type AbundanceRequest } from './abundance-runtime';
import { AbundanceSession } from './AbundanceSession';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';

const csv = 'taxon,S1,S2,S3,S4,S5\nA,1,2,4,8,16\nB,1,2,4,8,16\nC,256,64,16,4,1';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Endpoint {
  onmessage: ((event: MessageEvent<AbundanceWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  stopped = false;
  submitted: AbundanceRequest | null = null;
  constructor(private automatic = false) {}
  terminate() { this.stopped = true; }
  postMessage(request: AbundanceRequest) {
    this.submitted = request;
    if (this.automatic) void executeAbundanceRequest(request).then(result => this.emit({ kind: 'result', result }),
      cause => this.emit({ kind: 'error', message: cause.message }));
  }
  emit(message: AbundanceWorkerMessage) { this.onmessage?.({ data: structuredClone(message) } as MessageEvent<AbundanceWorkerMessage>); }
}
const createEndpoint = (endpoint: Endpoint) => endpoint as unknown as Worker;

describe('worker-backed local abundance workflow', () => {
  it('loads data without computing or changing input provenance', async () => {
    const loaded = await executeAbundanceRequest({ kind: 'import', content: csv, filename: 'Counts.csv' });
    assert.equal(loaded.analysis, null); assert.equal(loaded.record, null);
    assert.equal(loaded.dataset.source.kind, 'local'); assert.equal(loaded.dataset.table.counts[2][0], 256);
    assert.equal(loaded.dataset.name, 'Counts.csv');
  });
  it('attaches metadata by ID, leaves missing optional cells absent, and clears stale results', async () => {
    const loaded = await executeAbundanceRequest({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const updated = await executeAbundanceRequest({ kind: 'metadata', dataset: loaded.dataset, options: { pseudocount: 0, numNiches: 1 },
      content: 'sample_id,habitat,host\nS5,soil,\nS1,water,test-host\nS3,soil,' });
    assert.deepEqual(updated.dataset.metadata, [{ sampleId: 'S5', habitat: 'soil' }, { sampleId: 'S1', habitat: 'water', host: 'test-host' }, { sampleId: 'S3', habitat: 'soil' }]);
    assert.deepEqual(updated.dataset.table, loaded.dataset.table);
    assert.equal(updated.analysis, null);
    const result = await executeAbundanceRequest({ kind: 'analyze', dataset: updated.dataset, options: updated.options });
    assert.equal(result.analysis!.diagnostics.metadataSamples, 3);
    const soilA = result.analysis!.profiles[0].habitats.find(x => x.habitat === 'soil')!;
    assert.ok(Math.abs(soilA.meanRelativeAbundance - (4 / 24 + 16 / 33) / 2) < 1e-12);
    assert.ok(Math.abs(result.analysis!.associations[0].pvalue - 1 / 60) < 1e-12);
  });
  it('rejects unknown, duplicate, ragged or missing-ID metadata without inventing sample matches', async () => {
    const { dataset } = await executeAbundanceRequest({ kind: 'import', content: csv, filename: 'Counts.csv' });
    for (const content of ['sampleId,habitat\nmissing,soil', 'sampleId,habitat\nS1,soil\nS1,water',
      'sampleId,habitat\nS1,soil,other', 'sampleId,habitat\n,soil', '[{"sampleId":"missing"}]']) {
      await assert.rejects(executeAbundanceRequest({ kind: 'metadata', dataset, content, options: {} }));
    }
    assert.deepEqual(dataset.metadata, []);
  });
  it('loads JSON sample metadata and validates its identifiers', async () => {
    const { dataset } = await executeAbundanceRequest({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const result = await executeAbundanceRequest({ kind: 'metadata', dataset, options: {}, content: '[{"sampleId":"S3","habitat":"α","depth":12}]' });
    assert.deepEqual(result.dataset.metadata, [{ sampleId: 'S3', habitat: 'α', depth: 12 }]);
  });
  it('performs explicit computation and verifies a saved analysis using the real core', async () => {
    const loaded = await executeAbundanceRequest({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const calculated = await executeAbundanceRequest({ kind: 'analyze', dataset: loaded.dataset, options: { pseudocount: 0, numNiches: 1, seed: 0 } });
    const restored = await executeAbundanceRequest({ kind: 'import', content: serializeAnalysisRecord(calculated.record!), filename: 'Saved.json' });
    assert.equal(restored.verified, true); assert.deepEqual(restored.analysis, calculated.analysis);
    assert.equal(restored.record!.resultId, calculated.record!.resultId);
  });
  it('generates synthetic data only for an explicit demo command', async () => {
    const a = await executeAbundanceRequest({ kind: 'demo', seed: 0 });
    const b = await executeAbundanceRequest({ kind: 'demo', seed: 0 });
    assert.deepEqual(a, b); assert.equal(a.dataset.source.kind, 'demo'); assert.equal(a.analysis, null);
    const computed = await executeAbundanceRequest({ kind: 'analyze', dataset: a.dataset, options: a.options });
    assert.equal(computed.record!.fields.associations.kind, 'demo');
    await assert.rejects(executeAbundanceRequest({ kind: 'import', content: 'bad input', filename: 'Counts.csv' }));
  });
});

describe('abundance selection and cancellation lifecycle', () => {
  it('runs the actual parse/analyze/replay path and retains the submitted parameter snapshot', async () => {
    const endpoints: Endpoint[] = [];
    const session = new AbundanceSession(() => { const e = new Endpoint(true); endpoints.push(e); return createEndpoint(e); });
    session.activate();
    await session.run({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const dataset = session.getSnapshot().accepted!.dataset;
    const options = { seed: 0, pseudocount: 0, numNiches: 1 };
    const running = session.run({ kind: 'analyze', dataset, options });
    options.seed = 999;
    await running;
    const first = session.getSnapshot().accepted!;
    assert.equal(first.options.seed, 0); assert.equal(session.getSnapshot().loading, false);
    assert.ok(endpoints.every(endpoint => endpoint.stopped));
    await session.run({ kind: 'import', content: serializeAnalysisRecord(first.record!), filename: 'Replay.json' });
    assert.equal(session.getSnapshot().accepted!.record!.resultId, first.record!.resultId);
    assert.match(session.getSnapshot().notice!, /Verified replay/);
    session.deactivate();
  });
  it('preserves a completed result when replacement input fails without starting a demo', async () => {
    const session = new AbundanceSession(() => createEndpoint(new Endpoint(true)));
    session.activate(); await session.run({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const accepted = session.getSnapshot().accepted;
    await session.run({ kind: 'import', content: 'taxon,a,b,c\nT,NA,1,2', filename: 'Invalid.csv' });
    assert.strictEqual(session.getSnapshot().accepted, accepted);
    assert.match(session.getSnapshot().error!, /not a nonnegative number/);
    assert.equal(session.getSnapshot().loading, false);
    session.deactivate();
  });
  it('cancels a pending file read before any worker is created', async () => {
    let workers = 0;
    const session = new AbundanceSession(() => { workers++; return createEndpoint(new Endpoint()); });
    session.activate();
    const file = deferred<AbundanceRequest>();
    const reading = session.run(file.promise);
    assert.equal(session.getSnapshot().loading, true);
    session.cancel(); assert.equal(session.getSnapshot().loading, false);
    file.resolve({ kind: 'import', content: csv, filename: 'Late.csv' }); await reading;
    assert.equal(workers, 0); assert.equal(session.getSnapshot().accepted, null);
    session.deactivate();
  });
  it('terminates old work and ignores its late success without unlocking its replacement', async () => {
    const endpoints: Endpoint[] = [];
    const session = new AbundanceSession(() => { const e = new Endpoint(); endpoints.push(e); return createEndpoint(e); });
    session.activate();
    const first = session.run({ kind: 'import', content: csv, filename: 'Old.csv' });
    const obsolete = endpoints[0].onmessage!;
    const second = session.run({ kind: 'import', content: csv, filename: 'New.csv' });
    assert.equal(endpoints[0].stopped, true); await first;
    const oldResult = await executeAbundanceRequest(endpoints[0].submitted!);
    obsolete({ data: { kind: 'result', result: oldResult } } as MessageEvent<AbundanceWorkerMessage>);
    assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().loading, true);
    const fresh = await executeAbundanceRequest(endpoints[1].submitted!);
    endpoints[1].emit({ kind: 'result', result: fresh }); await second;
    assert.equal(session.getSnapshot().accepted!.dataset.name, 'New.csv');
    session.deactivate();
  });
  it('does not allow a cancelled old file rejection to replace a new result', async () => {
    const session = new AbundanceSession(() => createEndpoint(new Endpoint(true)));
    session.activate(); const file = deferred<AbundanceRequest>(); const reading = session.run(file.promise);
    await session.run({ kind: 'import', content: csv, filename: 'New.csv' });
    file.reject(new Error('old disk read failed')); await reading;
    assert.equal(session.getSnapshot().error, null); assert.equal(session.getSnapshot().accepted!.dataset.name, 'New.csv');
    session.deactivate();
  });
  it('stops work on close, settles the pending call and rejects late replies', async () => {
    const endpoint = new Endpoint(); const session = new AbundanceSession(() => createEndpoint(endpoint));
    session.activate(); const working = session.run({ kind: 'import', content: csv, filename: 'Counts.csv' });
    const callback = endpoint.onmessage!;
    session.deactivate(); await working;
    callback({ data: { kind: 'result', result: await executeAbundanceRequest(endpoint.submitted!) } } as MessageEvent<AbundanceWorkerMessage>);
    assert.equal(endpoint.stopped, true); assert.equal(session.getSnapshot().accepted, null); assert.equal(session.getSnapshot().loading, false);
  });
  it('settles worker startup and deserialization failures with a recoverable error', async () => {
    const broken = new AbundanceSession(() => { throw new Error('Worker construction failed'); });
    broken.activate(); await broken.run({ kind: 'import', content: csv, filename: 'Counts.csv' });
    assert.match(broken.getSnapshot().error!, /construction failed/); assert.equal(broken.getSnapshot().loading, false);
    broken.deactivate();
    const endpoint = new Endpoint(); const session = new AbundanceSession(() => createEndpoint(endpoint));
    session.activate(); const working = session.run({ kind: 'import', content: csv, filename: 'Counts.csv' });
    endpoint.onmessageerror!(); await working;
    assert.match(session.getSnapshot().error!, /deserialize/); assert.equal(endpoint.stopped, true);
    session.deactivate();
  });
});
