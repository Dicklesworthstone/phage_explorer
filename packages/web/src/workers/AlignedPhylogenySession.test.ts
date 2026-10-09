import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { AlignedPhylogenySession, executeAlignedPhylogenyRequest, readAlignedPhylogenyFile,
  type AlignedPhylogenyRequest, type AlignedPhylogenyWorker, type AlignedPhylogenyMessage } from './AlignedPhylogenySession';

const request = (): Extract<AlignedPhylogenyRequest, {kind:'infer'}> => ({ kind: 'infer',
  source: { name: 'Synthetic quartet', kind: 'demo', reference: 'Four synthetic aligned sequences; not experimental data.',
    fasta: '>A\nAAAAAAAAAAAA\n>B\nAAAAAAAATAAA\n>C\nGGGGAAAAAAAA\n>D\nGGGGAAAAATAA\n' },
  options: { distance: 'p-distance', deletion: 'complete', bootstrap: 20, seed: 0 } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
class FakeWorker implements AlignedPhylogenyWorker {
  onmessage: AlignedPhylogenyWorker['onmessage'] = null;
  onerror: AlignedPhylogenyWorker['onerror'] = null;
  onmessageerror: AlignedPhylogenyWorker['onmessageerror'] = null;
  terminated = 0;
  request: AlignedPhylogenyRequest | null = null;
  postMessage(value: AlignedPhylogenyRequest) { this.request = value; }
  terminate() { this.terminated++; }
  emit(value: AlignedPhylogenyMessage) { this.onmessage?.({data:value} as MessageEvent<AlignedPhylogenyMessage>); }
}
function workspace() { const workers: FakeWorker[] = [];
  const session = new AlignedPhylogenySession(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  session.activate(); return { session, workers }; }

describe('aligned phylogeny real execution and evidence', () => {
  test('produces the independently specified quartet distances and split from actual bases', async () => {
    const experiment = await executeAlignedPhylogenyRequest(request());
    assert.deepEqual(experiment.result.taxa, ['A','B','C','D']);
    assert.deepEqual(experiment.result.distances, [[0,1/12,4/12,5/12],[1/12,0,5/12,6/12],[4/12,5/12,0,1/12],[5/12,6/12,1/12,0]]);
    assert.deepEqual(experiment.result.splits.map(split=>split.side), [['A','B']]);
    assert.ok(experiment.result.distanceResidualRMSE < 1e-12);
    assert.equal(experiment.result.bootstrap.completed, 20);
    assert.equal(experiment.record.inputs[0].source, 'demo');
  });
  test('worker replay preserves exact seeds, original alignment and complete result identity', async () => {
    const experiment = await executeAlignedPhylogenyRequest(request());
    const loaded = await executeAlignedPhylogenyRequest({kind:'replay',content:serializeAnalysisRecord(experiment.record)});
    assert.deepEqual(loaded, experiment); assert.equal(loaded.options.seed, 0);
  });
  test('self-consistent forged output passes hashes but fails fresh numerical replay', async () => {
    const experiment = await executeAlignedPhylogenyRequest(request());
    const fields = structuredClone(experiment.record.fields);
    fields.phylogeny.value = { inventedTree: true };
    const forged = await createAnalysisRecord({ ...experiment.record, fields });
    await assert.rejects(executeAlignedPhylogenyRequest({kind:'replay',content:serializeAnalysisRecord(forged)}), /Recomputed/);
  });
  test('unequal lengths and complete deletion with no usable sites fail instead of manufacturing a tree', async () => {
    for (const fasta of ['>A\nAA\n>B\nA\n>C\nAA', '>A\nNN\n>B\n??\n>C\n--']) {
      const input = request(); input.source.fasta = fasta;
      await assert.rejects(executeAlignedPhylogenyRequest(input), /aligned|No complete/);
    }
  });
  test('saturation is an error, not a silently bounded JC69 distance', async () => {
    const input = request(); input.source.fasta='>A\nAAAA\n>B\nCCCC\n>C\nGGGG'; input.options.distance='jc69';
    await assert.rejects(executeAlignedPhylogenyRequest(input), /undefined/);
  });
  test('common deletion excludes the same ambiguous column from every pair', async () => {
    const input=request(); input.source.fasta='>A\nAAAAN\n>B\nAAAAC\n>C\nAGAAC';
    const {result}=await executeAlignedPhylogenyRequest(input);
    assert.equal(result.usedSites,4);assert.deepEqual(result.excludedColumns,[4]);
    assert.equal(result.distances[0][1],0);assert.equal(result.distances[0][2],0.25);
  });
  test('rejects unsupported request kinds and over-budget saved input', async () => {
    await assert.rejects(executeAlignedPhylogenyRequest({kind:'invalid'} as unknown as AlignedPhylogenyRequest), /Unsupported/);
    await assert.rejects(executeAlignedPhylogenyRequest({kind:'replay',content:'x'.repeat(10*1024*1024+1)}), /limit/);
  });
});

describe('aligned phylogeny ownership and cancellation', () => {
  test('does not instantiate a worker before an explicit operation', async () => {
    const {session,workers}=workspace();assert.equal(workers.length,0);
    session.deactivate();assert.equal(await session.run(request()),false);assert.equal(workers.length,0);
  });
  test('snapshots immediate input before yielding and terminates a successful worker', async () => {
    const {session,workers}=workspace(), input=request(), expected=structuredClone(input);
    const pending=session.run(input);input.source.fasta='changed'; await tick();
    assert.deepEqual(workers[0].request,expected);
    workers[0].emit({kind:'progress',phase:'Computing'});assert.equal(session.getSnapshot().phase,'Computing');
    workers[0].emit({kind:'result',experiment:await executeAlignedPhylogenyRequest(expected),verified:false});
    assert.equal(await pending,true);assert.equal(workers[0].terminated,1);assert.equal(session.getSnapshot().busy,false);
    assert.equal(session.getSnapshot().accepted?.source.fasta,expected.source.fasta);
    session.deactivate();
  });
  test('edits cancel a blocked file read immediately and ignore its later success', async () => {
    const {session,workers}=workspace(), read=deferred<AlignedPhylogenyRequest>();
    const pending=session.run(()=>read.promise);session.invalidate();assert.equal(await pending,false);
    read.resolve(request());await tick();assert.equal(workers.length,0);assert.equal(session.getSnapshot().accepted,null);
  });
  test('a late rejected file read is observed and cannot overwrite a newer operation', async () => {
    const {session,workers}=workspace(), read=deferred<AlignedPhylogenyRequest>();
    const first=session.run(()=>read.promise), second=session.run(request());await tick();
    read.reject(new Error('Obsolete read failed'));assert.equal(await first,false);await tick();
    assert.equal(session.getSnapshot().error,null);assert.equal(session.getSnapshot().busy,true);
    workers[0].emit({kind:'result',experiment:await executeAlignedPhylogenyRequest(request()),verified:false});
    assert.equal(await second,true);session.deactivate();
  });
  test('cancels running CPU work by terminating its worker, then ignores retained late callbacks', async () => {
    const {session,workers}=workspace();const first=session.run(request());await tick();
    const late=workers[0].onmessage!;session.cancel();assert.equal(await first,false);assert.equal(workers[0].terminated,1);
    late({data:{kind:'result',experiment:await executeAlignedPhylogenyRequest(request()),verified:false}} as MessageEvent<AlignedPhylogenyMessage>);
    assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().busy,false);
    session.deactivate();
  });
  test('clears accepted evidence on edits and survives deactivate/reactivate without resurrecting it', async () => {
    const {session,workers}=workspace();const pending=session.run(request());await tick();
    workers[0].emit({kind:'result',experiment:await executeAlignedPhylogenyRequest(request()),verified:false});await pending;
    session.invalidate();session.deactivate();session.activate();assert.equal(session.getSnapshot().accepted,null);
    const next=session.run(request());await tick();session.deactivate();assert.equal(await next,false);assert.equal(workers[1].terminated,1);
  });
  for (const failure of ['error','messageerror','malformed','post','termination'] as const) {
    test(`worker ${failure} failure settles loading and allows a subsequent retry`, async () => {
      let count=0;const workers:FakeWorker[]=[];
      const session=new AlignedPhylogenySession(()=>{const w=new FakeWorker();workers.push(w);if(count++===0){
        if(failure==='post')w.postMessage=()=>{throw new Error('Cannot post');};
        if(failure==='termination')w.terminate=()=>{throw new Error('Cannot terminate');};
      }return w;});session.activate();const pending=session.run(request());await tick();
      if(failure==='error')workers[0].onerror?.({} as ErrorEvent);
      if(failure==='messageerror')workers[0].onmessageerror?.({} as MessageEvent);
      if(failure==='malformed'||failure==='termination')workers[0].emit({kind:'garbage'} as unknown as AlignedPhylogenyMessage);
      assert.equal(await pending,false);assert.equal(session.getSnapshot().busy,false);assert.ok(session.getSnapshot().error);
      const next=session.run(request());await tick();workers[1].emit({kind:'result',experiment:await executeAlignedPhylogenyRequest(request()),verified:false});
      assert.equal(await next,true);assert.equal(session.getSnapshot().error,null);session.deactivate();
    });
  }
  test('worker constructor failure is visible without hanging the workspace', async () => {
    const session=new AlignedPhylogenySession(()=>{throw new Error('Worker blocked');});session.activate();
    assert.equal(await session.run(request()),false);assert.equal(session.getSnapshot().error,'Worker blocked');assert.equal(session.getSnapshot().busy,false);
  });
  test('an inference response cannot be presented as verified replay', async () => {
    const {session,workers}=workspace(), experiment=await executeAlignedPhylogenyRequest(request());
    const pending=session.run({kind:'replay',content:serializeAnalysisRecord(experiment.record)});await tick();
    workers[0].emit({kind:'result',experiment,verified:false});assert.equal(await pending,false);assert.equal(session.getSnapshot().accepted,null);session.deactivate();
  });
});

describe('private file boundaries', () => {
  test('accepts UTF-8 with a BOM and rejects malformed UTF-8', async () => {
    assert.equal(await readAlignedPhylogenyFile(new Blob(['\ufeff>A\nACGT']),100),'>A\nACGT');
    await assert.rejects(readAlignedPhylogenyFile(new Blob([new Uint8Array([0xc3,0x28])]),100));
  });
  test('checks byte count before and after reading, including a provider that understates size', async () => {
    let reads=0;const file={size:200,arrayBuffer:async()=>{reads++;return new ArrayBuffer(200);}};
    await assert.rejects(readAlignedPhylogenyFile(file,100),/limit/);assert.equal(reads,0);
    await assert.rejects(readAlignedPhylogenyFile({...file,size:1},100),/limit/);assert.equal(reads,1);
  });
});
