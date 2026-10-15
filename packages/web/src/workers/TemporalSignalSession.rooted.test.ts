import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment } from '../../../core/src/analysis/phylogeny-rooting';
import { createRootedTemporalExperiment, type RootedTemporalSource } from '../../../core/src/analysis/phylogeny-temporal';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { executeTemporalRequest, temporalAnalysisRequest, TemporalSignalSession,
  type TemporalRequest, type TemporalWorker, type TemporalMessage, type TemporalWorkResult } from './TemporalSignalSession';

async function input(): Promise<RootedTemporalSource> {
  const source = { name: 'Synthetic handoff quartet', kind: 'demo' as const, reference: 'Disjoint private substitutions, not observations',
    fasta: ['A', 'B', 'C', 'D'].map((id, i) => `>${id}\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}\n`).join('') };
  const tree = await createAlignedPhylogenyExperiment(source, { distance: 'jc69', bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(tree.record), { outgroup: ['A'], fractionFromOutgroup: .25,
    evidence: 'Chosen synthetic root, no dates used', dateIndependent: true });
  return { content: serializeAnalysisRecord(rooted.record), metadata: { name: source.name, kind: 'demo', description: 'Synthetic metadata',
    reference: null, license: 'CC0 synthetic fixture', dateIndependent: true,
    sampleTable: 'sampleId,collectionDate,dateSource\nD,2003.0,fixture\nA,2000.0,fixture\nC,2002.0,fixture\nB,2001.0,fixture\n' } };
}
class ControlledWorker implements TemporalWorker {
  onmessage: TemporalWorker['onmessage'] = null;
  onerror: TemporalWorker['onerror'] = null;
  onmessageerror: TemporalWorker['onmessageerror'] = null;
  request: TemporalRequest | null = null;
  terminated = false;
  postMessage(request: TemporalRequest) { this.request = request; }
  terminate() { this.terminated = true; }
  emit(value: TemporalWorkResult) { this.onmessage?.({ data: { kind: 'result', value } } as MessageEvent<TemporalMessage>); }
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function complete(session: TemporalSignalSession, workers: ControlledWorker[], request: TemporalRequest) {
  const pending = session.run(request); await turn();
  const worker = workers[workers.length - 1];
  worker.emit(await executeTemporalRequest(worker.request!)); await pending;
  return session.getSnapshot().accepted!;
}

describe('rooted temporal browser handoff', () => {
  it('executes the actual full-chain request in a real OS worker and replays its export', async () => {
    const rootedSource = await input();
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      import(${JSON.stringify(new URL('./TemporalSignalSession.ts', import.meta.url).href)}).then(module=>{
        parentPort.on('message',async request=>{try{
          const value=await module.executeTemporalRequest(request);
          parentPort.postMessage({kind:'result',value});
        }catch(error){parentPort.postMessage({kind:'error',message:error.message});}});
      });`, { eval: true });
    try {
      const call = (request: TemporalRequest): Promise<TemporalWorkResult> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Real worker test timed out')); }, 10000);
        const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); };
        const error = (cause: Error) => { cleanup(); reject(cause); };
        const message = (reply: TemporalMessage) => {
          if (reply.kind === 'progress') return;
          cleanup(); if (reply.kind === 'error') reject(new Error(reply.message)); else resolve(reply.value);
        };
        worker.on('message', message); worker.on('error', error); worker.postMessage(request);
      });
      const value = await call({ kind: 'analyze-rooted', rootedSource, options: { permutations: 24, seed: 42 } });
      assert.ok(Math.abs(value.result!.regression!.slope - 0.015125692605006662) < 1e-12);
      assert.equal(value.result!.randomization!.tailFraction, 1 / 24);
      assert.equal(value.record!.inputs.length, 3); assert.equal(value.verified, false);
      const replay = await call({ kind: 'import', content: '\uFEFF' + serializeAnalysisRecord(value.record!) });
      assert.equal(replay.verified, true); assert.deepEqual(replay.record, value.record);
      assert.deepEqual(replay.rootedSource, value.rootedSource);
    } finally { await worker.terminate(); }
  });
  it('routes changed parameters back through parent replay instead of stripping provenance', async () => {
    const first = await executeTemporalRequest({ kind: 'analyze-rooted', rootedSource: await input(), options: { permutations: 24 } });
    const request = temporalAnalysisRequest(first, { permutations: 19, seed: 0, excludedSamples: ['D'] });
    assert.equal(request.kind, 'analyze-rooted');
    const next = await executeTemporalRequest(request);
    assert.equal(next.record!.method.id, 'rooted-nj-temporal-signal');
    assert.equal(next.record!.seed, 0); assert.equal(next.result!.regression, null);
    assert.deepEqual(next.rootedSource, first.rootedSource); assert.notEqual(next.record!.resultId, first.record!.resultId);
    const replay = await executeTemporalRequest({ kind: 'import', content: serializeAnalysisRecord(next.record!) });
    assert.deepEqual(replay.record, next.record);
  });
  it('keeps existing external-tree preparation, analysis and replay available', async () => {
    const example = await executeTemporalRequest({ kind: 'example' });
    const request = temporalAnalysisRequest(example, { permutations: 24 }); assert.equal(request.kind, 'analyze');
    const analyzed = await executeTemporalRequest(request);
    assert.equal(analyzed.record!.method.id, 'fixed-root-temporal-signal'); assert.equal(analyzed.rootedSource, undefined);
    const replayed = await executeTemporalRequest({ kind: 'import', content: serializeAnalysisRecord(analyzed.record!) });
    assert.deepEqual(replayed.record, analyzed.record);
    const loaded = await executeTemporalRequest({ kind: 'import', content: JSON.stringify(example.dataset) });
    assert.equal(loaded.result, null); assert.equal(loaded.rootedSource, undefined);
  });
  it('preserves accepted linked evidence when a rehashed forged import fails', async () => {
    const workers: ControlledWorker[] = [], session = new TemporalSignalSession(() => { const w = new ControlledWorker(); workers.push(w); return w; });
    session.activate();
    const accepted = await complete(session, workers, { kind: 'analyze-rooted', rootedSource: await input(), options: {} });
    const record = structuredClone(accepted.record!);
    (record.fields.regression.value as unknown as { slope: number }).slope = 99;
    const forged = await createAnalysisRecord({ ...record, inputs: record.inputs.map(({ sha256: _sha, ...row }) => row) });
    const work = session.run({ kind: 'import', content: serializeAnalysisRecord(forged) }); await turn();
    const worker = workers[workers.length - 1];
    try { await executeTemporalRequest(worker.request!); assert.fail('Forged evidence was accepted'); }
    catch (cause) { worker.onmessage?.({ data: { kind: 'error', message: (cause as Error).message } } as MessageEvent<TemporalMessage>); }
    await work; assert.equal(session.getSnapshot().accepted, accepted); assert.match(session.getSnapshot().error!, /differs/);
    assert.equal(worker.terminated, true); session.deactivate();
  });
  it('cancels a pending metadata read without allowing its late completion to replace evidence', async () => {
    const workers: ControlledWorker[] = [], session = new TemporalSignalSession(() => { const w = new ControlledWorker(); workers.push(w); return w; });
    session.activate();
    const accepted = await complete(session, workers, { kind: 'analyze-rooted', rootedSource: await input(), options: {} });
    let deliver!: (r: TemporalRequest) => void;
    const work = session.run(new Promise(resolve => { deliver = resolve; })); session.cancel(); await work;
    deliver({ kind: 'example' }); await turn();
    assert.equal(workers.length, 1); assert.equal(session.getSnapshot().accepted, accepted); session.deactivate();
  });
  it('terminates cancelled computation and ignores late worker messages after a newer import', async () => {
    const workers: ControlledWorker[] = [], session = new TemporalSignalSession(() => { const w = new ControlledWorker(); workers.push(w); return w; });
    session.activate();
    const source = await input(), prior = await executeTemporalRequest({ kind: 'analyze-rooted', rootedSource: source, options: {} });
    const old = session.run({ kind: 'analyze-rooted', rootedSource: source, options: {} }); await turn();
    const stale = workers[0], listener = stale.onmessage;
    const replacement = await complete(session, workers, { kind: 'example' });
    await old; listener?.({ data: { kind: 'result', value: prior } } as MessageEvent<TemporalMessage>);
    assert.equal(stale.terminated, true); assert.equal(session.getSnapshot().accepted, replacement);
    assert.equal(session.getSnapshot().accepted!.rootedSource, undefined); session.deactivate();
  });
  it('captures the exact root, dates and exclusions before the caller edits their objects', async () => {
    const workers: ControlledWorker[] = [], session = new TemporalSignalSession(() => { const w = new ControlledWorker(); workers.push(w); return w; });
    session.activate();
    const rootedSource = await input(), options = { excludedSamples: [] as string[], seed: 0 };
    const work = session.run({ kind: 'analyze-rooted', rootedSource, options });
    rootedSource.content = 'changed'; rootedSource.metadata.sampleTable = ''; options.excludedSamples.push('A');
    await turn(); const worker = workers[0];
    worker.emit(await executeTemporalRequest(worker.request!)); await work;
    assert.equal(session.getSnapshot().accepted!.record!.seed, 0);
    assert.deepEqual(session.getSnapshot().accepted!.options.excludedSamples, []);
    assert.equal(session.getSnapshot().accepted!.result!.tips.length, 4); session.deactivate();
  });
  it('settles cancellation even when worker termination throws', async () => {
    const worker = new ControlledWorker(); worker.terminate = () => { throw new Error('Already detached'); };
    const session = new TemporalSignalSession(() => worker); session.activate();
    const work = session.run({ kind: 'example' }); await turn(); session.cancel(); await work;
    assert.equal(session.getSnapshot().busy, false); assert.equal(worker.onmessage, null); session.deactivate();
  });
  it('preserves linked diagnostics across a separate dating result for exactly the same dataset', async () => {
    const workers: ControlledWorker[] = [], session = new TemporalSignalSession(() => { const w = new ControlledWorker(); workers.push(w); return w; });
    session.activate();
    const accepted = await complete(session, workers, { kind: 'analyze-rooted', rootedSource: await input(), options: {} });
    // Protocol coexistence test only: this does not exercise the strict-clock solver.
    const work = session.run({ kind: 'date', dataset: accepted.dataset, options: {} }); await turn();
    workers[workers.length - 1].emit({ dataset: accepted.dataset, options: accepted.options, result: null, record: null, verified: false });
    await work;
    assert.deepEqual(session.getSnapshot().accepted!.rootedSource, accepted.rootedSource);
    assert.equal(session.getSnapshot().accepted!.record, accepted.record); session.deactivate();
  });
  it('returns the same new record through the core API and the browser worker handler', async () => {
    const source = await input();
    const expected = await createRootedTemporalExperiment(source.content, source.metadata, { permutations: 19, seed: 7 });
    const value = await executeTemporalRequest({ kind: 'analyze-rooted', rootedSource: source, options: { permutations: 19, seed: 7 } });
    assert.deepEqual(value.record, expected.record); assert.deepEqual(value.dataset, expected.dataset);
  });
});
