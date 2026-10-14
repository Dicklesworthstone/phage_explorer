import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Worker as NativeWorker, isMainThread, parentPort } from 'node:worker_threads';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { createPlaqueGrowthRecord, type PlaqueGrowthInput, type PlaqueGrowthFit } from '../../../core/src/analysis/plaque-growth';
import { PlaqueGrowthSession, type PlaqueGrowthWorker } from './PlaqueGrowthSession';
import { executePlaqueGrowthRequest, validatePlaqueGrowthRequest, type PlaqueGrowthRequest } from './plaque-growth.worker';

const input: PlaqueGrowthInput = {
  format: 'phage-explorer-plaque-growth-input', version: 1, measurement: 'extracellular-plaque-counts',
  title: 'Synthetic exposure test', provenance: { kind: 'synthetic', source: 'Hand-derived count fixture; not an empirical assay.' },
  csv: 'time_min,plaque_count,dilution_fraction,volume_ml\n' + Array.from({ length: 9 }, (_, time) =>
    `${time},${10 + 100 * Math.max(0, Math.min(1, (time - 3) / 2))},1,1`).join('\n') + '\n',
  options: { infectedCentersPerMl: 10, supportDeviance: 3.84 },
};
const content = () => JSON.stringify(input, null, 2);
const immediate = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Endpoint implements PlaqueGrowthWorker {
  onmessage: PlaqueGrowthWorker['onmessage'] = null;
  onerror: PlaqueGrowthWorker['onerror'] = null;
  onmessageerror: PlaqueGrowthWorker['onmessageerror'] = null;
  terminations = 0;
  constructor(private readonly reply: (request: PlaqueGrowthRequest) => Promise<unknown> = async r => ({ type: 'result', record: await executePlaqueGrowthRequest(r) })) {}
  postMessage(value: unknown): void {
    const receiver = this.onmessage; // Deliberately can deliver a queued late callback after termination.
    void this.reply(structuredClone(value) as PlaqueGrowthRequest).then(data => receiver?.call(this as unknown as Worker, { data } as MessageEvent))
      .catch(cause => receiver?.call(this as unknown as Worker, { data: { type: 'error', message: cause.message } } as MessageEvent));
  }
  terminate(): void { this.terminations++; }
}
function session(factory = () => new Endpoint()) {
  const workers: Endpoint[] = [];
  const state = new PlaqueGrowthSession(() => { const worker = factory(); workers.push(worker); return worker; });
  state.activate(); return { state, workers };
}
async function resign(record: AnalysisRecord, change: (r: AnalysisRecord) => void) {
  const r = structuredClone(record); change(r);
  return createAnalysisRecord({ method: r.method, parameters: r.parameters, fields: r.fields, references: r.references, seed: r.seed,
    inputs: r.inputs.map(({ sha256: _sha, ...row }) => row) });
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.once('message', (request: PlaqueGrowthRequest) => {
    void executePlaqueGrowthRequest(request).then(record => port.postMessage({ type: 'result', record }))
      .catch(cause => port.postMessage({ type: 'error', message: cause.message }));
  });
}

if (isMainThread) describe('browser plaque-count execution and ownership', () => {
  it('requires bounded explicit values rather than following a filename or accepting extra commands', () => {
    validatePlaqueGrowthRequest({ type: 'fit', content: content() });
    for (const value of [null, { type: 'fit', content: content(), url: '/private' }, { type: 'unknown', content: '{}' },
      { type: 'fit', content: 1 }, { type: 'fit', content: 'α'.repeat(500001) }, { type: 'replay', content: 'x'.repeat(10485761) }]) {
      assert.throws(() => validatePlaqueGrowthRequest(value));
    }
  });
  it('fits the exact raw input using the production endpoint and retains independently specified rates and provenance', async () => {
    const { state, workers } = session();
    assert.equal(await state.run('fit', content()), true);
    const accepted = state.getSnapshot().accepted!;
    const fit = accepted.record.fields.fit.value as unknown as PlaqueGrowthFit;
    assert.equal(accepted.inputText, content()); assert.equal(accepted.record.inputs[0].data, content());
    assert.equal(accepted.verifiedReplay, false); assert.equal(accepted.record.fields.fit.kind, 'demo');
    assert(Math.abs(fit.backgroundPFUPerMl - 10) < 1e-7); assert(Math.abs(fit.increasePFUPerMl - 100) < 1e-7);
    assert.equal(fit.riseStartMin, 3); assert.equal(fit.riseEndMin, 5);
    assert.deepEqual(await parseAnalysisRecord(accepted.json), accepted.record);
    assert(accepted.tsv.includes('deviance_residual')); assert.equal(workers[0].terminations, 1);
    assert.equal(state.getSnapshot().busy, false);
  });
  it('verifies replay through fresh numerical computation with the same complete identity', async () => {
    const { state } = session(); await state.run('fit', content()); const first = state.getSnapshot().accepted!;
    assert.equal(await state.run('replay', first.json), true);
    const next = state.getSnapshot().accepted!;
    assert.equal(next.verifiedReplay, true); assert.equal(next.json, first.json); assert.equal(next.tsv, first.tsv);
    assert.equal(next.inputText, content()); assert.notEqual(next.record, first.record);
  });
  it('keeps the prior accepted result after invalid input, wrong method or rehashed false numerical support', async () => {
    const { state } = session(); await state.run('fit', content()); const accepted = state.getSnapshot().accepted!;
    const falseRecord = await resign(accepted.record, r => { (r.fields.fit.value as unknown as PlaqueGrowthFit).increaseSupport = [[0, 0]]; });
    await parseAnalysisRecord(serializeAnalysisRecord(falseRecord)); // Prove the checksum alone passes.
    for (const [type, text] of [['fit', '{'], ['replay', serializeAnalysisRecord(falseRecord)],
      ['replay', serializeAnalysisRecord(await resign(accepted.record, r => { r.method.id = 'other'; }))]] as const) {
      assert.equal(await state.run(type, text), false);
      assert.equal(state.getSnapshot().accepted, accepted); assert(state.getSnapshot().error); assert.equal(state.getSnapshot().busy, false);
    }
  });
  it('rejects a valid worker record for a different source, including only changed source formatting', async () => {
    const { state } = session(() => new Endpoint(async () => ({ type: 'result', record: await createPlaqueGrowthRecord(JSON.stringify(input)) })));
    assert.equal(await state.run('fit', content()), false); assert.equal(state.getSnapshot().accepted, null);
    assert.match(state.getSnapshot().error!, /differs/);
  });
  it('cancels an ignored-abort file read promptly without allocating a worker or accepting the late value', async () => {
    const { state, workers } = session(); const file = latch<string>();
    const pending = state.run('fit', () => file.promise); await immediate(); state.cancel();
    assert.equal(await pending, false); assert.equal(workers.length, 0);
    file.resolve(content()); await immediate(); assert.equal(workers.length, 0); assert.equal(state.getSnapshot().accepted, null);
  });
  it('new work supersedes delayed file reads and a late reply from an obsolete worker cannot win', async () => {
    const delayed = latch<unknown>(), started = latch<void>(); let calls = 0;
    const { state } = session(() => new Endpoint(async request => {
      if (++calls === 1) { started.resolve(); return delayed.promise; }
      return { type: 'result', record: await executePlaqueGrowthRequest(request) };
    }));
    const old = state.run('fit', content()); await started.promise;
    const nextText = JSON.stringify({ ...input, title: 'Second accepted input' });
    assert.equal(await state.run('fit', nextText), true); assert.equal(await old, false);
    const accepted = state.getSnapshot().accepted;
    delayed.resolve({ type: 'result', record: await createPlaqueGrowthRecord(content()) }); await immediate();
    assert.equal(state.getSnapshot().accepted, accepted); assert.equal(accepted!.input.title, 'Second accepted input');
    assert.equal(state.getSnapshot().error, null);
  });
  it('deactivation terminates pending work and reactivation works under repeated effect setup/cleanup', async () => {
    const started = latch<void>(), finish = latch<unknown>();
    let allocations = 0;
    const { state, workers } = session(() => ++allocations === 1
      ? new Endpoint(async () => { started.resolve(); return finish.promise; }) : new Endpoint());
    const old = state.run('fit', content()); await started.promise; state.deactivate();
    assert.equal(await old, false); assert.equal(workers[0].terminations, 1);
    assert.equal(await state.run('fit', content()), false); assert.equal(workers.length, 1);
    state.activate(); assert.equal(await state.run('fit', content()), true);
    const accepted = state.getSnapshot().accepted; state.deactivate();
    finish.resolve({ type: 'error', message: 'late' }); await immediate();
    assert.equal(state.getSnapshot().error, null); assert.equal(state.getSnapshot().accepted, accepted);
  });
  it('handles worker construction, decoding, execution and message-shape failures without hanging', async () => {
    const creation = new PlaqueGrowthSession(() => { throw new Error('Worker unavailable'); }); creation.activate();
    assert.equal(await creation.run('fit', content()), false); assert.match(creation.getSnapshot().error!, /unavailable/);
    for (const failure of ['message', 'error', 'decode']) {
      const worker = new Endpoint();
      worker.postMessage = () => queueMicrotask(() => {
        if (failure === 'message') worker.onmessage?.call(worker as unknown as Worker, { data: {} } as MessageEvent);
        else if (failure === 'error') worker.onerror?.call(worker as unknown as AbstractWorker, { preventDefault() {} } as ErrorEvent);
        else worker.onmessageerror?.call(worker as unknown as Worker, {} as MessageEvent);
      });
      const s = new PlaqueGrowthSession(() => worker); s.activate(); assert.equal(await s.run('fit', content()), false);
      assert.equal(worker.terminations, 1); assert.equal(s.getSnapshot().busy, false); assert(s.getSnapshot().error);
    }
  });
  it('does not start work cancelled in a synchronous loading notification', async () => {
    const { state, workers } = session(); const unsubscribe = state.subscribe(() => { if (state.getSnapshot().busy) state.cancel(); });
    assert.equal(await state.run('fit', content()), false); assert.equal(workers.length, 0); unsubscribe();
  });
  it('preserves unavailable timing and yield on all-zero user-supplied counts', async () => {
    const zero = { ...input, provenance: { kind: 'user-supplied', source: 'Explicit zero-count fixture' },
      csv: input.csv.replace(/^(\d+),\d+,/gm, '$1,0,'), options: { ...input.options, infectedCentersPerMl: null } };
    const { state } = session(); assert.equal(await state.run('fit', JSON.stringify(zero)), true);
    const accepted = state.getSnapshot().accepted!, fit = accepted.record.fields.fit.value as unknown as PlaqueGrowthFit;
    assert.equal(accepted.record.fields.plates.kind, 'observation'); assert.equal(fit.riseStartMin, null);
    assert.equal(fit.infectiousYieldPerInfectedCenter, null); assert.equal(fit.timingStatus, 'unresolved');
    assert(fit.increaseSupport[0][1] > 0); assert.equal(fit.fitted.length, 9);
  });
  it('fits through an actual OS worker and hard-terminates a busy computation on cancellation', async () => {
    let native: NativeWorker | null = null, exited: Promise<number> | null = null;
    const make = (busy: boolean): PlaqueGrowthWorker => {
      const worker = busy ? new NativeWorker('for (;;) {}', { eval: true }) : new NativeWorker(new URL(import.meta.url));
      native = worker; exited = new Promise(resolve => worker.once('exit', resolve));
      const adapter: PlaqueGrowthWorker = { onmessage: null, onerror: null, onmessageerror: null,
        postMessage: value => worker.postMessage(value), terminate: () => { void worker.terminate(); } };
      worker.on('message', data => adapter.onmessage?.call(adapter as unknown as Worker, { data } as MessageEvent));
      worker.on('error', error => adapter.onerror?.call(adapter as unknown as AbstractWorker, { message: error instanceof Error ? error.message : String(error), preventDefault() {} } as ErrorEvent));
      return adapter;
    };
    const fit = new PlaqueGrowthSession(() => make(false)); fit.activate();
    assert.equal(await fit.run('fit', content()), true, fit.getSnapshot().error ?? 'Expected accepted fit'); assert(fit.getSnapshot().accepted); await exited;
    const busy = new PlaqueGrowthSession(() => make(true)); busy.activate(); const pending = busy.run('fit', content());
    assert(native); busy.cancel(); assert.equal(await pending, false); await exited; assert.equal(busy.getSnapshot().accepted, null);
  });
});
