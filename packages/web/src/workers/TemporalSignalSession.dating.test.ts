import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment } from '../../../core/src/analysis/phylogeny-rooting';
import { createRootedTemporalExperiment } from '../../../core/src/analysis/phylogeny-temporal';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { executeTemporalRequest, isLinkedDatingRecord, temporalAnalysisRequest, temporalDatingRequest, TemporalSignalSession,
  type TemporalRequest, type TemporalWorker, type TemporalMessage, type TemporalWorkResult } from './TemporalSignalSession';

async function parent(): Promise<TemporalWorkResult> {
  const source = { name: 'Synthetic linked-clock quartet', kind: 'demo' as const, reference: 'Synthetic disjoint private substitutions',
    fasta: ['A', 'B', 'C', 'D'].map((id, i) => `>${id}\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(99 - i * 6)}\n`).join('') };
  const tree = await createAlignedPhylogenyExperiment(source, { distance: 'jc69', bootstrap: 20, seed: 42 });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(tree.record), { outgroup: ['A'], fractionFromOutgroup: .25,
    evidence: 'Synthetic fixed outgroup, not chosen using dates', dateIndependent: true });
  const value = await createRootedTemporalExperiment(serializeAnalysisRecord(rooted.record), {
    name: source.name, kind: 'demo', description: 'Synthetic collection metadata', reference: null, license: 'CC0 synthetic fixture', dateIndependent: true,
    sampleTable: 'sampleId,collectionDate,dateSource\nD,2003.0,fixture\nA,2000.0,fixture\nC,2002.0,fixture\nB,2001.0,fixture\n',
  }, { permutations: 24, seed: 0 });
  return { ...value, options: value.result.options, verified: false };
}
class ControlledWorker implements TemporalWorker {
  onmessage: TemporalWorker['onmessage'] = null;
  onerror: TemporalWorker['onerror'] = null;
  onmessageerror: TemporalWorker['onmessageerror'] = null;
  request: TemporalRequest | null = null;
  terminated = false;
  postMessage(request: TemporalRequest) { this.request = request; }
  terminate() { this.terminated = true; }
  async execute() {
    try {
      const value = await executeTemporalRequest(this.request!);
      this.onmessage?.({ data: { kind: 'result', value } } as MessageEvent<TemporalMessage>);
    } catch (cause) {
      this.onmessage?.({ data: { kind: 'error', message: (cause as Error).message } } as MessageEvent<TemporalMessage>);
    }
  }
}
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function harness() {
  const workers: ControlledWorker[] = [];
  const session = new TemporalSignalSession(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
  session.activate();
  const run = async (request: TemporalRequest) => {
    const pending = session.run(request); await turn(); await workers[workers.length - 1].execute(); await pending;
    return session.getSnapshot().accepted!;
  };
  return { workers, session, run };
}
function threadFactory(): TemporalWorker {
  const thread = new Worker(`const {parentPort}=require('node:worker_threads');
    import(${JSON.stringify(new URL('./TemporalSignalSession.ts', import.meta.url).href)}).then(module=>{
      parentPort.on('message',async request=>{try{
        const value=await module.executeTemporalRequest(request,phase=>parentPort.postMessage({kind:'progress',phase}));
        parentPort.postMessage({kind:'result',value});
      }catch(error){parentPort.postMessage({kind:'error',message:error.message});}});
    });`, { eval: true });
  const adapter: TemporalWorker = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: request => thread.postMessage(request), terminate: () => { void thread.terminate(); } };
  thread.on('message', data => adapter.onmessage?.({ data } as MessageEvent<TemporalMessage>));
  thread.on('error', error => adapter.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent));
  thread.on('messageerror', () => adapter.onmessageerror?.({} as MessageEvent));
  return adapter;
}

describe('linked strict-clock workspace', () => {
  it('runs the existing session protocol through real workers for fitting and full-chain import', async () => {
    const session = new TemporalSignalSession(threadFactory); session.activate();
    const watchdog = setTimeout(() => session.cancel(), 10000);
    try {
      const original = await parent();
      await session.run({ kind: 'import', content: serializeAnalysisRecord(original.record!) });
      assert.equal(session.getSnapshot().error, null);
      await session.run(temporalDatingRequest(session.getSnapshot().accepted!, {}));
      const fitted = session.getSnapshot().accepted!;
      assert.equal(session.getSnapshot().error, null); assert.equal(fitted.dating?.status, 'fitted');
      assert.equal(isLinkedDatingRecord(fitted.datingRecord), true);
      assert.equal(fitted.record!.resultId, original.record!.resultId);
      await session.run({ kind: 'import', content: '\uFEFF' + serializeAnalysisRecord(fitted.datingRecord!) });
      const replay = session.getSnapshot().accepted!;
      assert.equal(replay.verified, true); assert.deepEqual(replay.datingRecord, fitted.datingRecord);
      assert.deepEqual(replay.record, original.record); assert.deepEqual(replay.options, original.options);
      assert.deepEqual(replay.rootedSource, original.rootedSource);
      assert.match(session.getSnapshot().notice!, /alignment, root, temporal diagnostics and strict-clock/);
    } finally { clearTimeout(watchdog); session.deactivate(); }
  });
  it('routes linked and external-tree fits explicitly and refuses to drop a missing parent record', async () => {
    const linked = await parent(), external = await executeTemporalRequest({ kind: 'example' });
    assert.equal(temporalDatingRequest(linked, {}).kind, 'date-rooted');
    assert.equal(temporalDatingRequest(external, {}).kind, 'date');
    assert.throws(() => temporalDatingRequest({ ...linked, record: null }, {}), /Run alignment-backed temporal diagnostics/);
    const request = temporalDatingRequest(linked, {});
    linked.dataset.tree.newick = '(A:1,B:2,C:3,D:4);';
    const fitted = await executeTemporalRequest(request);
    assert.notEqual(fitted.dataset.tree.newick, linked.dataset.tree.newick);
  });
  it('clears a linked fit when diagnostic settings change and refits against the new parent', async () => {
    const { session, run } = harness();
    try {
      const initial = await parent();
      const old = await run(temporalDatingRequest(initial, {}));
      const next = await run(temporalAnalysisRequest(old, { ...old.options, seed: 7, excludedSamples: ['D'] }));
      assert.equal(next.datingRecord, undefined); assert.equal(next.dating, undefined);
      assert.match(session.getSnapshot().notice!, /diagnostic parent changed/);
      assert.equal(next.result!.regression, null);
      const fitted = await run(temporalDatingRequest(next, {}));
      assert.deepEqual(fitted.result!.options.excludedSamples, ['D']);
      assert.equal(fitted.dating!.nodes.filter(node => node.isTip).length, 4);
      assert.notEqual(fitted.datingRecord!.resultId, old.datingRecord!.resultId);
      assert.equal((fitted.datingRecord!.fields.lineage.value as { temporalResultId: string }).temporalResultId, next.record!.resultId);
    } finally { session.deactivate(); }
  });
  it('retains a linked fit for identical diagnostic replay, without changing its evidence identity', async () => {
    const { session, run } = harness();
    try {
      const fitted = await run(temporalDatingRequest(await parent(), {}));
      const same = await run(temporalAnalysisRequest(fitted, fitted.options));
      assert.equal(same.datingRecord!.resultId, fitted.datingRecord!.resultId);
      assert.equal(same.record!.resultId, fitted.record!.resultId);
    } finally { session.deactivate(); }
  });
  it('continues to fit, retain and replay standalone external-tree dating', async () => {
    const { session, run } = harness();
    try {
      const example = await run({ kind: 'example' });
      const diagnosed = await run(temporalAnalysisRequest(example, { permutations: 24 }));
      const fitted = await run(temporalDatingRequest(diagnosed, {}));
      assert.equal(fitted.dating!.status, 'fitted'); assert.equal(isLinkedDatingRecord(fitted.datingRecord), false);
      const next = await run(temporalAnalysisRequest(fitted, { permutations: 19, seed: 99 }));
      assert.equal(next.datingRecord!.resultId, fitted.datingRecord!.resultId);
      const restored = await run({ kind: 'import', content: serializeAnalysisRecord(fitted.datingRecord!) });
      assert.equal(restored.verified, true); assert.equal(restored.rootedSource, undefined);
      assert.deepEqual(restored.datingRecord, fitted.datingRecord);
    } finally { session.deactivate(); }
  });
  it('never lets a failed or rehashed forged import overwrite accepted linked evidence', async () => {
    const { session, run } = harness();
    try {
      const accepted = await run(temporalDatingRequest(await parent(), {}));
      const changed = structuredClone(accepted.datingRecord!);
      (changed.fields.dating.value as { rate: number }).rate = .9;
      const forged = await createAnalysisRecord({ ...changed, inputs: changed.inputs.map(({ sha256: _sha, ...row }) => row) });
      await run({ kind: 'import', content: serializeAnalysisRecord(forged) });
      assert.equal(session.getSnapshot().accepted, accepted); assert.match(session.getSnapshot().error!, /differs from saved evidence/);
      await run({ kind: 'date-rooted', content: '{}', options: {} });
      assert.equal(session.getSnapshot().accepted, accepted); assert.ok(session.getSnapshot().error);
    } finally { session.deactivate(); }
  });
  it('cancels pending file reads and terminated workers without accepting their late outputs', async () => {
    const { session, run, workers } = harness();
    try {
      const accepted = await run(temporalDatingRequest(await parent(), {}));
      let deliver!: (request: TemporalRequest) => void;
      const read = session.run(new Promise(resolve => { deliver = resolve; }));
      session.cancel(); await read; const before = workers.length;
      deliver({ kind: 'import', content: serializeAnalysisRecord(accepted.datingRecord!) }); await turn();
      assert.equal(workers.length, before); assert.equal(session.getSnapshot().accepted, accepted);
      const pending = session.run(temporalDatingRequest(accepted, {})); await turn();
      const stale = workers[workers.length - 1], message = stale.onmessage;
      const replacement = await run({ kind: 'example' }); await pending;
      message?.({ data: { kind: 'result', value: accepted } } as MessageEvent<TemporalMessage>);
      assert.equal(stale.terminated, true); assert.equal(session.getSnapshot().accepted, replacement);
      assert.equal(replacement.datingRecord, undefined); assert.equal(replacement.rootedSource, undefined);
    } finally { session.deactivate(); }
  });
  it('captures fixed-rate options before the caller mutates them', async () => {
    const { session, workers } = harness();
    try {
      const initial = await parent(), options = { rateMode: 'fixed' as const, fixedRate: .01, rateSource: 'Original assumption' };
      const work = session.run(temporalDatingRequest(initial, options));
      options.fixedRate = .2; options.rateSource = 'Changed';
      await turn(); await workers[0].execute(); await work;
      assert.equal(session.getSnapshot().accepted!.dating!.options.fixedRate, .01);
      assert.equal(session.getSnapshot().accepted!.datingRecord!.parameters.rateSource, 'Original assumption');
    } finally { session.deactivate(); }
  });
  it('preserves unresolved fits and solver certificates through import without claiming node dates', async () => {
    const { session, run } = harness();
    try {
      const unresolved = await run(temporalDatingRequest(await parent(), { maximumRate: .0001, maxIterations: 1 }));
      assert.equal(unresolved.dating!.status, 'unresolved'); assert.equal(unresolved.dating!.rootDate, null);
      const restored = await run({ kind: 'import', content: serializeAnalysisRecord(unresolved.datingRecord!) });
      assert.equal(restored.verified, true); assert.deepEqual(restored.dating!.nodes, []);
      assert.equal(restored.dating!.certificate.converged, false); assert.deepEqual(restored.record, unresolved.record);
    } finally { session.deactivate(); }
  });
});
