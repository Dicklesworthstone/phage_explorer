import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Worker as NativeWorker, isMainThread, parentPort } from 'node:worker_threads';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { createPlaqueGrowthRecord, type PlaqueGrowthInput, type PlaqueGrowthFit } from '../../../core/src/analysis/plaque-growth';
import { GrowthExperimentSession, PLAQUE_GROWTH_MODEL, CORRECTED_PFU_GROWTH_MODEL, correctedPfuGrowthDraftContent,
  plaqueGrowthDraftContent, readPlaqueGrowthFile, type PlaqueGrowthDraft, type PlaqueGrowthWorker } from './PlaqueGrowthSession';
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
  const state = new GrowthExperimentSession(() => { const worker = factory(); workers.push(worker); return worker; }, PLAQUE_GROWTH_MODEL);
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
    const creation = new GrowthExperimentSession(() => { throw new Error('Worker unavailable'); }, PLAQUE_GROWTH_MODEL); creation.activate();
    assert.equal(await creation.run('fit', content()), false); assert.match(creation.getSnapshot().error!, /unavailable/);
    for (const failure of ['message', 'error', 'decode']) {
      const worker = new Endpoint();
      worker.postMessage = () => queueMicrotask(() => {
        if (failure === 'message') worker.onmessage?.call(worker as unknown as Worker, { data: {} } as MessageEvent);
        else if (failure === 'error') worker.onerror?.call(worker as unknown as AbstractWorker, { preventDefault() {} } as ErrorEvent);
        else worker.onmessageerror?.call(worker as unknown as Worker, {} as MessageEvent);
      });
      const s = new GrowthExperimentSession(() => worker, PLAQUE_GROWTH_MODEL); s.activate(); assert.equal(await s.run('fit', content()), false);
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
    const fit = new GrowthExperimentSession(() => make(false), PLAQUE_GROWTH_MODEL); fit.activate();
    assert.equal(await fit.run('fit', content()), true, fit.getSnapshot().error ?? 'Expected accepted fit'); assert(fit.getSnapshot().accepted); await exited;
    native = null; exited = null;
    const busy = new GrowthExperimentSession(() => make(true), PLAQUE_GROWTH_MODEL); busy.activate(); const pending = busy.run('fit', content());
    assert(native); busy.cancel(); assert.equal(await pending, false); await exited; assert.equal(busy.getSnapshot().accepted, null);
  });
  it('creates exact-count inputs from drafts and requires an explicit assay and source', () => {
    const draft: PlaqueGrowthDraft = { version: 1, title: input.title, source: input.provenance.source, kind: 'synthetic',
      csv: input.csv, centers: '10', support: '3.84', extracellular: true };
    const made = JSON.parse(plaqueGrowthDraftContent(draft));
    assert.deepEqual(made, input); assert.equal(made.csv, input.csv);
    assert.equal(JSON.parse(plaqueGrowthDraftContent({ ...draft, centers: '' })).options.infectedCentersPerMl, null);
    for (const update of [{ extracellular: false }, { source: '' }, { title: '' }, { support: '' }, { support: 'NaN' },
      { support: 'Infinity' }, { support: '0' }, { support: '101' }, { centers: 'NaN' }, { centers: 'Infinity' },
      { centers: '-1' }, { centers: '0' }, { centers: '0x20' }]) assert.throws(() => plaqueGrowthDraftContent({ ...draft, ...update }));
    assert.equal(JSON.parse(plaqueGrowthDraftContent({ ...draft, centers: '1e3' })).options.infectedCentersPerMl, 1000);
  });
  it('keeps raw count columns distinct from corrected PFU data and preserves every input zero', () => {
    const draft: PlaqueGrowthDraft = { version: 1, title: input.title, source: input.provenance.source, kind: 'synthetic',
      csv: input.csv.replace(/^(\d+),\d+,/gm, '$1,0,'), centers: '', support: '3.84', extracellular: true };
    const made = JSON.parse(plaqueGrowthDraftContent(draft)); assert.equal(made.csv, draft.csv);
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, csv: 'time_min,pfu_per_ml\n0,100\n' }));
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, csv: draft.csv.replace('0,0,1,1', '0,TNTC,1,1') }));
  });
  it('reads exact UTF-8 file bytes and rejects oversized, invalid or cancelled file input', async () => {
    const signal = new AbortController().signal, text = content() + '\n';
    assert.equal(await readPlaqueGrowthFile(new Blob([text]), 1000000, signal), text);
    await assert.rejects(readPlaqueGrowthFile(new Blob([Uint8Array.from([255])]), 1000000, signal));
    await assert.rejects(readPlaqueGrowthFile(new Blob([text]), 1, signal), /limit/);
    // Do not trust a file provider that understates its size.
    await assert.rejects(readPlaqueGrowthFile({ size: 0, arrayBuffer: async () => new ArrayBuffer(2) }, 1, signal), /limit/);
    const controller = new AbortController(); controller.abort(); let reads = 0;
    await assert.rejects(readPlaqueGrowthFile({ size: 0, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }, 1, controller.signal), { name: 'AbortError' });
    assert.equal(reads, 0);
  });
  it('a cancelled asynchronous file read cannot install subsequently returned bytes', async () => {
    const controller = new AbortController(), file = latch<ArrayBuffer>();
    const pending = readPlaqueGrowthFile({ size: 0, arrayBuffer: () => file.promise }, 1000000, controller.signal);
    controller.abort(); file.resolve(new ArrayBuffer(0)); await assert.rejects(pending, { name: 'AbortError' });
  });

});

if (isMainThread) describe('corrected-PFU execution through the shared growth session', () => {
  const draft = { title: 'Synthetic corrected-PFU curve', source: 'Hand-specified observations for a test, not an actual assay', kind: 'synthetic' as const,
    csv: 'time_min,pfu_per_ml\n0,10\n1,10\n2,10\n3,60\n4,110\n5,110\n6,110\n',
    centers: '', seed: '0', bootstrap: '20', extracellular: true };
  const source = () => correctedPfuGrowthDraftContent(draft);
  function corrected(factory = () => new Endpoint()) {
    const workers: Endpoint[] = [];
    const state = new GrowthExperimentSession(() => { const worker = factory(); workers.push(worker); return worker; }, CORRECTED_PFU_GROWTH_MODEL);
    state.activate(); return { state, workers };
  }
  it('uses the explicit corrected-PFU worker operation and keeps complete accepted bootstrap output', async () => {
    const requests: string[] = [];
    const { state, workers } = corrected(() => new Endpoint(async request => {
      requests.push(request.type); return { type: 'result', record: await executePlaqueGrowthRequest(request) };
    }));
    assert.equal(await state.run('fit', source()), true, state.getSnapshot().error ?? 'No accepted fit');
    const accepted = state.getSnapshot().accepted!;
    assert.deepEqual(requests, ['pfu-fit']); assert.equal(accepted.record.seed, 0);
    assert.equal(accepted.input.measurement, 'extracellular-pfu-per-ml'); assert.equal(accepted.inputText, source());
    const fit = accepted.record.fields.fit.value as { baselinePFUPerMl: number; increasePFUPerMl: number; riseStartMin: number; riseEndMin: number; intervals: unknown };
    assert(Math.abs(fit.baselinePFUPerMl - 10) < 1e-9); assert(Math.abs(fit.increasePFUPerMl - 100) < 1e-9);
    assert.deepEqual([fit.riseStartMin, fit.riseEndMin], [2, 4]); assert(fit.intervals);
    assert.match(accepted.tsv, /observed_pfu_per_ml/); assert.equal(workers[0].terminations, 1);
    assert.equal(await state.run('replay', accepted.json), true); assert.deepEqual(requests, ['pfu-fit', 'pfu-replay']);
    assert.equal(state.getSnapshot().accepted!.json, accepted.json); assert.equal(state.getSnapshot().accepted!.tsv, accepted.tsv);
    assert.equal(state.getSnapshot().accepted!.verifiedReplay, true);
  });
  it('cannot cross observation models when fitting input or restoring saved results', async () => {
    const raw = session(), pfu = corrected();
    await raw.state.run('fit', content()); await pfu.state.run('fit', source());
    const beforeRaw = raw.state.getSnapshot().accepted!, beforePfu = pfu.state.getSnapshot().accepted!;
    assert.equal(await raw.state.run('replay', beforePfu.json), false); assert.equal(raw.workers.length, 1);
    assert.equal(await pfu.state.run('replay', beforeRaw.json), false); assert.equal(pfu.workers.length, 1);
    assert.equal(await raw.state.run('fit', source()), false); assert.equal(await pfu.state.run('fit', content()), false);
    assert.equal(raw.state.getSnapshot().accepted, beforeRaw); assert.equal(pfu.state.getSnapshot().accepted, beforePfu);
  });
  it('verifies legacy result-bearing inputs and refuses altered results while preserving accepted evidence', async () => {
    const { state } = corrected(); assert.equal(await state.run('fit', source()), true);
    const accepted = state.getSnapshot().accepted!;
    const original = JSON.stringify({ ...accepted.input, result: accepted.record.fields.fit.value });
    assert.equal(await state.run('fit', original), true);
    const before = state.getSnapshot().accepted!;
    const invalid = JSON.parse(original); invalid.result.intervals.increasePFUPerMl[0] -= 1;
    assert.equal(await state.run('fit', JSON.stringify(invalid)), false); assert.equal(state.getSnapshot().accepted, before);
    assert.match(state.getSnapshot().error!, /legacy saved result/);
  });
  it('rejects rehashed false intervals and wrongly seeded provider results', async () => {
    const { state } = corrected(); await state.run('fit', source()); const accepted = state.getSnapshot().accepted!;
    const forged = await resign(accepted.record, r => { (r.fields.fit.value as { intervals: { increasePFUPerMl: number[] } }).intervals.increasePFUPerMl = [0, 0]; });
    await parseAnalysisRecord(serializeAnalysisRecord(forged));
    assert.equal(await state.run('replay', serializeAnalysisRecord(forged)), false); assert.equal(state.getSnapshot().accepted, accepted);
    const wrong = corrected(() => new Endpoint(async r => ({ type: 'result', record: await resign(await executePlaqueGrowthRequest(r), copy => { copy.seed = 1; }) })));
    assert.equal(await wrong.state.run('fit', source()), false); assert.equal(wrong.state.getSnapshot().accepted, null);
  });
  it('invalidates a delayed read or reply before it can replace a subsequent corrected-PFU result', async () => {
    const file = latch<string>(), reply = latch<unknown>(), started = latch<void>(); let calls = 0;
    const { state, workers } = corrected(() => new Endpoint(async request => {
      if (++calls === 1) { started.resolve(); return reply.promise; }
      return { type: 'result', record: await executePlaqueGrowthRequest(request) };
    }));
    const reading = state.run('fit', () => file.promise); await immediate(); state.cancel(); assert.equal(await reading, false);
    file.resolve(source()); await immediate(); assert.equal(workers.length, 0);
    const fitting = state.run('fit', source()); await started.promise; state.cancel(); assert.equal(await fitting, false);
    const newer = correctedPfuGrowthDraftContent({ ...draft, title: 'Subsequent accepted curve' });
    assert.equal(await state.run('fit', newer), true); const accepted = state.getSnapshot().accepted;
    reply.resolve({ type: 'result', record: await executePlaqueGrowthRequest({ type: 'pfu-fit', content: source() }) }); await immediate();
    assert.equal(state.getSnapshot().accepted, accepted); assert.equal(accepted!.input.title, 'Subsequent accepted curve');
    assert.equal(workers[0].terminations, 1);
  });
  it('rejects malformed numeric drafts before JSON converts NaN or Infinity to valid nulls', () => {
    for (const values of [{ extracellular: false }, { centers: 'Infinity' }, { centers: 'NaN' }, { centers: '0' }, { centers: '-2' },
      { centers: '0x10' }, { seed: '' }, { seed: '-1' }, { seed: '4294967296' }, { bootstrap: '' }, { bootstrap: '1' }, { bootstrap: '20.5' }]) {
      assert.throws(() => correctedPfuGrowthDraftContent({ ...draft, ...values }));
    }
    const zero = JSON.parse(correctedPfuGrowthDraftContent({ ...draft, bootstrap: '0', seed: '0' }));
    assert.deepEqual(zero.options, { bootstrapSamples: 0, infectedCentersPerMl: null, seed: 0 });
  });
});

if (isMainThread) describe('shared session for exact and censored counts', () => {
  const bounded = (): PlaqueGrowthInput => ({ ...input, version: 2,
    csv: input.csv.trimEnd().split('\n').map((line, i) => line + (i === 0 ? ',count_status' : i === 3 ? ',at-most' : i === 6 ? ',at-least' : ',exact')).join('\n') + '\n' });
  it('accepts and replays v2 while preserving bound statuses, unknown totals and unavailable residuals', async () => {
    const f = session(), text = JSON.stringify(bounded());
    assert.equal(await f.state.run('fit', text), true, f.state.getSnapshot().error ?? 'No bounded fit');
    const accepted = f.state.getSnapshot().accepted!, fit = accepted.record.fields.fit.value as {
      totalPlaques: number | null; exactPlaques: number; countCoverage: object;
      fitted: Array<{ countStatus: string; devianceResidual: number | null }> };
    assert.equal(accepted.input.version, 2); assert.equal(accepted.record.method.version, '2');
    assert.equal(accepted.inputText, text); assert.equal(fit.totalPlaques, null);
    assert.deepEqual(fit.countCoverage, { exact: 7, atMost: 1, atLeast: 1 });
    assert(fit.fitted.filter(row => row.countStatus !== 'exact').every(row => row.devianceResidual === null));
    assert.equal(await f.state.run('replay', accepted.json), true);
    assert.equal(f.state.getSnapshot().accepted!.json, accepted.json); assert.equal(f.state.getSnapshot().accepted!.tsv, accepted.tsv);
    const old = content(); assert.equal(await f.state.run('fit', old), true);
    assert.equal(f.state.getSnapshot().accepted!.record.method.version, '1');
    assert.equal(f.state.getSnapshot().accepted!.json, serializeAnalysisRecord(await createPlaqueGrowthRecord(old)));
  });
  it('rejects version-swapped saved evidence before allocating a worker', async () => {
    const f = session(); assert.equal(await f.state.run('fit', content()), true);
    const accepted = f.state.getSnapshot().accepted!, record = await createPlaqueGrowthRecord(JSON.stringify(bounded()));
    const bad = await resign(record, r => { r.method.version = '1'; });
    assert.equal(await f.state.run('replay', serializeAnalysisRecord(bad)), false);
    assert.equal(f.workers.length, 1); assert.equal(f.state.getSnapshot().accepted, accepted);
  });
  it('rejects incorrectly versioned provider replies instead of treating count bounds as exact counts', async () => {
    const f = session(() => new Endpoint(async request => ({ type: 'result', record: await resign(await executePlaqueGrowthRequest(request), r => { r.method.version = '1'; }) })));
    assert.equal(await f.state.run('fit', JSON.stringify(bounded())), false);
    assert.equal(f.state.getSnapshot().accepted, null); assert.match(f.state.getSnapshot().error!, /differs/);
  });
  it('preserves explicit v2 drafts and rejects missing versions or incompatible headers rather than guessing', () => {
    const source = bounded(), draft: PlaqueGrowthDraft = { version: 2, title: source.title,
      kind: source.provenance.kind, source: source.provenance.source, csv: source.csv,
      centers: '10', support: '3.84', extracellular: true };
    assert.deepEqual(JSON.parse(plaqueGrowthDraftContent(draft)), source);
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, version: 1 }));
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, version: undefined } as unknown as PlaqueGrowthDraft));
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, csv: input.csv }));
    assert.throws(() => plaqueGrowthDraftContent({ ...draft, csv: source.csv.replace('at-most', 'TNTC') }));
  });
  it('preserves accepted bounded evidence after numerical failure, cancellation and malformed later files', async () => {
    const f = session(); assert.equal(await f.state.run('fit', JSON.stringify(bounded())), true);
    const accepted = f.state.getSnapshot().accepted!, invalid = bounded();
    invalid.csv = invalid.csv.replaceAll('at-most', 'at-least').replaceAll('exact', 'at-least');
    assert.equal(await f.state.run('fit', JSON.stringify(invalid)), false); assert.equal(f.state.getSnapshot().accepted, accepted);
    assert.match(f.state.getSnapshot().error!, /plateau.*unbounded/);
    const late = latch<string>(), pending = f.state.run('fit', () => late.promise); await immediate(); f.state.cancel();
    assert.equal(await pending, false); late.resolve(content()); await immediate(); assert.equal(f.state.getSnapshot().accepted, accepted);
    assert.equal(await f.state.run('replay', '{'), false); assert.equal(f.state.getSnapshot().accepted, accepted);
  });
});
