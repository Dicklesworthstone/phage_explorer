import {describe,it} from 'bun:test';
import assert from 'node:assert/strict';
import {serializeAnalysisRecord,parseAnalysisRecord,createAnalysisRecord} from '../../../core/src/analysis-result';
import {executeTemporalRequest,TemporalSignalSession,type TemporalRequest,type TemporalWorker,type TemporalMessage} from './TemporalSignalSession';

function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
class FakeWorker implements TemporalWorker {
  onmessage:TemporalWorker['onmessage']=null;onerror:TemporalWorker['onerror']=null;onmessageerror:TemporalWorker['onmessageerror']=null;
  terminated=false;request:TemporalRequest|null=null;
  postMessage(request:TemporalRequest){this.request=request;}
  terminate(){this.terminated=true;}
  send(message:TemporalMessage){this.onmessage?.({data:message} as MessageEvent<TemporalMessage>);}
}
function sessionFixture(){const workers:FakeWorker[]=[];const session=new TemporalSignalSession(()=>{const worker=new FakeWorker();workers.push(worker);return worker;});session.activate();return {session,workers};}
async function acceptExample(session:TemporalSignalSession,workers:FakeWorker[]){const task=session.run({kind:'example'});await flush();const value=await executeTemporalRequest({kind:'example'});workers.at(-1)!.send({kind:'result',value});await task;return value;}

describe('temporal worker operations',()=>{
  it('separates loading from analysis and never silently substitutes example input',async()=>{
    const loaded=await executeTemporalRequest({kind:'example'});assert.equal(loaded.record,null);assert.equal(loaded.result,null);assert.equal(loaded.dataset.source.kind,'demo');
    const calculated=await executeTemporalRequest({kind:'analyze',dataset:loaded.dataset,options:{seed:0}});
    assert.ok(Math.abs(calculated.result!.regression!.slope-.01)<1e-12);assert.equal(calculated.options.seed,0);
    await assert.rejects(executeTemporalRequest({kind:'import',content:'not json'}));
    await assert.rejects(executeTemporalRequest({kind:'other'} as never),/Unsupported/);
  });
  it('imports Newick and keyed collection metadata through the production parser',async()=>{
    const sample=await executeTemporalRequest({kind:'example'});const {samples:_samples,...dataset}=sample.dataset;
    const loaded=await executeTemporalRequest({kind:'prepare',dataset,sampleTable:'sampleId,collectionDate,dateSource\nD,2003.0,archive\nB,2001.0,archive\nA,2000.0,archive\nC,2002.0,archive'});
    assert.deepEqual(loaded.dataset.samples.map(s=>s.id),['D','B','A','C']);assert.equal(loaded.result,null);
    const calculated=await executeTemporalRequest({kind:'analyze',dataset:loaded.dataset,options:{}});
    assert.equal(calculated.result!.randomization!.tailFraction,1/24);
  });
  it('round-trips accepted datasets and recomputes saved diagnostics with identical IDs',async()=>{
    const example=await executeTemporalRequest({kind:'example'});
    const imported=await executeTemporalRequest({kind:'import',content:JSON.stringify(example.dataset)});
    assert.deepEqual(imported.dataset,example.dataset);
    const fit=await executeTemporalRequest({kind:'analyze',dataset:imported.dataset,options:{permutationScheme:'within-groups'}});
    const restored=await executeTemporalRequest({kind:'import',content:'\uFEFF'+serializeAnalysisRecord(fit.record!)});
    assert.equal(restored.verified,true);assert.deepEqual(restored.result,fit.result);assert.equal(restored.record!.resultId,fit.record!.resultId);
  });
  it('rejects internally rehashed false output and bounded oversized records',async()=>{
    const example=await executeTemporalRequest({kind:'example'}),fit=await executeTemporalRequest({kind:'analyze',dataset:example.dataset,options:{}});
    const record=await parseAnalysisRecord(serializeAnalysisRecord(fit.record!));(record.fields.regression.value as Record<string,unknown>).slope=123;
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(executeTemporalRequest({kind:'import',content:serializeAnalysisRecord(forged)}),/Fresh temporal diagnostic differs/);
    await assert.rejects(executeTemporalRequest({kind:'import',content:' '.repeat(10*1024*1024+1)}),/limit/);
  });
});

describe('private temporal workspace lifecycle',()=>{
  it('does not allocate workers while inactive and terminates each successful worker',async()=>{
    let count=0;const session=new TemporalSignalSession(()=>{count++;return new FakeWorker();});await session.run({kind:'example'});assert.equal(count,0);
    const f=sessionFixture();await acceptExample(f.session,f.workers);assert.equal(f.workers[0].terminated,true);assert.equal(f.session.getSnapshot().busy,false);
  });
  it('snapshots submitted settings before any asynchronous wait',async()=>{
    const f=sessionFixture(),loaded=await executeTemporalRequest({kind:'example'});
    const request:TemporalRequest={kind:'analyze',dataset:loaded.dataset,options:{seed:1}};
    const task=f.session.run(request);request.options.seed=7;await flush();
    assert.equal((f.workers[0].request as Extract<TemporalRequest,{kind:'analyze'}>).options.seed,1);
    f.session.cancel();await task;
  });
  it('cancels an unresolved file read immediately without launching computation',async()=>{
    const f=sessionFixture(),file=deferred<TemporalRequest>();const task=f.session.run(file.promise);f.session.cancel();await task;
    assert.equal(f.workers.length,0);assert.equal(f.session.getSnapshot().busy,false);
    file.resolve({kind:'example'});await flush();assert.equal(f.workers.length,0);
  });
  it('a late rejected file read cannot overwrite or unlock a newer job',async()=>{
    const f=sessionFixture(),file=deferred<TemporalRequest>();const old=f.session.run(file.promise);
    const fresh=f.session.run({kind:'example'});await old;await flush();file.reject(new Error('old read failed'));await flush();
    assert.equal(f.session.getSnapshot().busy,true);assert.equal(f.session.getSnapshot().error,null);
    f.workers[0].send({kind:'result',value:await executeTemporalRequest({kind:'example'})});await fresh;assert.equal(f.session.getSnapshot().error,null);
  });
  it('cancels running work, ignores stale progress/results, and preserves accepted data',async()=>{
    const f=sessionFixture();await acceptExample(f.session,f.workers);const prior=f.session.getSnapshot().accepted;
    const task=f.session.run({kind:'example'});await flush();const worker=f.workers[1];f.session.cancel();await task;
    assert.equal(worker.terminated,true);worker.send({kind:'progress',phase:'obsolete'});worker.send({kind:'result',value:{...prior!,verified:true}});
    assert.strictEqual(f.session.getSnapshot().accepted,prior);assert.equal(f.session.getSnapshot().phase,'');assert.match(f.session.getSnapshot().notice!,/cancelled/);
  });
  it('worker errors, decode failures and malformed messages settle with accepted evidence intact',async()=>{
    const f=sessionFixture();await acceptExample(f.session,f.workers);const prior=f.session.getSnapshot().accepted;
    for(const kind of ['error','decode','invalid','reported']){
      const task=f.session.run({kind:'example'});await flush();const worker=f.workers.at(-1)!;
      if(kind==='error')worker.onerror?.({} as ErrorEvent);else if(kind==='decode')worker.onmessageerror?.({} as MessageEvent);
      else if(kind==='reported')worker.send({kind:'error',message:'Invalid date'});else worker.send({kind:'invalid'} as never);
      await task;assert.strictEqual(f.session.getSnapshot().accepted,prior);assert.equal(f.session.getSnapshot().busy,false);assert.ok(f.session.getSnapshot().error);assert.equal(worker.terminated,true);
    }
  });
  it('handles worker construction and postMessage failures without orphaned busy state',async()=>{
    const failed=new TemporalSignalSession(()=>{throw new Error('No worker');});failed.activate();await failed.run({kind:'example'});assert.match(failed.getSnapshot().error!,/No worker/);assert.equal(failed.getSnapshot().busy,false);
    const worker=new FakeWorker();worker.postMessage=()=>{throw new Error('Could not clone');};const session=new TemporalSignalSession(()=>worker);session.activate();await session.run({kind:'example'});
    assert.equal(worker.terminated,true);assert.match(session.getSnapshot().error!,/clone/);
  });
  it('deactivation stops computation and reactivation cannot accept an old completion',async()=>{
    const f=sessionFixture();const old=f.session.run({kind:'example'});await flush();f.session.deactivate();await old;f.session.activate();
    const fresh=f.session.run({kind:'example'});await flush();const value=await executeTemporalRequest({kind:'example'});
    f.workers[0].send({kind:'result',value});assert.equal(f.session.getSnapshot().accepted,null);assert.equal(f.session.getSnapshot().busy,true);
    f.workers[1].send({kind:'result',value});await fresh;assert.ok(f.session.getSnapshot().accepted);assert.equal(f.session.getSnapshot().busy,false);
  });
  it('a successful replacement dataset clears only the obsolete result',async()=>{
    const f=sessionFixture();const loaded=await acceptExample(f.session,f.workers);
    const fit=await executeTemporalRequest({kind:'analyze',dataset:loaded.dataset,options:{}});
    const calculating=f.session.run({kind:'analyze',dataset:loaded.dataset,options:{}});await flush();f.workers.at(-1)!.send({kind:'result',value:fit});await calculating;
    assert.ok(f.session.getSnapshot().accepted?.record);
    await acceptExample(f.session,f.workers);assert.equal(f.session.getSnapshot().accepted!.result,null);assert.equal(f.session.getSnapshot().accepted!.record,null);
  });
  it('supports synchronous worker replies and reentrant cancellation from a progress listener',async()=>{
    const value=await executeTemporalRequest({kind:'example'});const worker=new FakeWorker();worker.postMessage=()=>worker.send({kind:'result',value});
    const session=new TemporalSignalSession(()=>worker);session.activate();await session.run({kind:'example'});assert.equal(session.getSnapshot().accepted?.dataset.name,value.dataset.name);
    const f=sessionFixture();f.session.subscribe(()=>{if(f.session.getSnapshot().phase==='cancel now')f.session.cancel();});
    const task=f.session.run({kind:'example'});await flush();f.workers[0].send({kind:'progress',phase:'cancel now'});await task;
    assert.equal(f.workers[0].terminated,true);assert.equal(f.session.getSnapshot().accepted,null);
  });
});

async function acceptRequest(f:ReturnType<typeof sessionFixture>,request:TemporalRequest) {
  const task=f.session.run(request);await flush();
  const value=await executeTemporalRequest(request);f.workers.at(-1)!.send({kind:'result',value});await task;return value;
}
describe('strict-clock worker and workspace integration',()=>{
  it('fits the supplied branch chronology and keeps it distinct from a regression result',async()=>{
    const loaded=await executeTemporalRequest({kind:'example'});
    const work=await executeTemporalRequest({kind:'date',dataset:loaded.dataset,options:{}});
    assert.equal(work.record,null);assert.equal(work.result,null);
    assert.equal(work.dating!.status,'fitted');assert.ok(Math.abs(work.dating!.rate-.01)<1e-12);
    assert.ok(Math.abs(work.dating!.rootDate!-1998)<1e-8);assert.equal(work.dating!.nodes.length,7);
    assert.equal(work.datingRecord!.method.id,'fixed-root-strict-clock-dating');assert.equal(work.datingRecord!.fields.dating.kind,'demo');
  });
  it('replays a standalone dated-tree record through the real solver and preserves identity',async()=>{
    const loaded=await executeTemporalRequest({kind:'example'});loaded.dataset.source.kind='local';
    loaded.dataset.samples[1].collectionDate={lower:2000.5,upper:2002.5};
    const original=await executeTemporalRequest({kind:'date',dataset:loaded.dataset,options:{}});
    const replay=await executeTemporalRequest({kind:'import',content:serializeAnalysisRecord(original.datingRecord!)});
    assert.equal(replay.verified,true);assert.deepEqual(replay.dating,original.dating);
    assert.equal(replay.datingRecord!.resultId,original.datingRecord!.resultId);
    assert.ok(Math.abs(replay.dating!.nodes.find(n=>n.label==='B')!.date-2001)<1e-8);
  });
  it('rejects internally rehashed false dated evidence rather than installing it',async()=>{
    const loaded=await executeTemporalRequest({kind:'example'});
    const fit=await executeTemporalRequest({kind:'date',dataset:loaded.dataset,options:{}});
    const forged=structuredClone(fit.datingRecord!);
    (forged.fields.dating.value as Record<string,unknown>).rootDate=1234;
    const signed=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(executeTemporalRequest({kind:'import',content:serializeAnalysisRecord(signed)}),/Fresh strict-clock dating differs/);
  });
  it('retains separate diagnostics and dating evidence only for identical full input datasets',async()=>{
    const f=sessionFixture(),loaded=await acceptExample(f.session,f.workers);
    const diagnostic=await acceptRequest(f,{kind:'analyze',dataset:loaded.dataset,options:{seed:7,excludedSamples:['D']}});
    const dated=await acceptRequest(f,{kind:'date',dataset:loaded.dataset,options:{}});
    assert.equal(f.session.getSnapshot().accepted!.record!.resultId,diagnostic.record!.resultId);
    assert.equal(f.session.getSnapshot().accepted!.options.seed,7);
    assert.equal(f.session.getSnapshot().accepted!.dating!.exactTips,4,'diagnostic exclusions must not prune the dated tree');
    await acceptRequest(f,{kind:'analyze',dataset:loaded.dataset,options:{seed:12}});
    assert.equal(f.session.getSnapshot().accepted!.datingRecord!.resultId,dated.datingRecord!.resultId);
    const different=structuredClone(loaded.dataset);different.name='A different input identity';
    await acceptRequest(f,{kind:'analyze',dataset:different,options:{}});
    assert.equal(f.session.getSnapshot().accepted!.dating,undefined);
    await acceptRequest(f,{kind:'date',dataset:loaded.dataset,options:{}});
    assert.equal(f.session.getSnapshot().accepted!.record,null);
    f.session.deactivate();
  });
  it('explicit replacement input clears both result families, even when input contents are identical',async()=>{
    const f=sessionFixture(),loaded=await acceptExample(f.session,f.workers);
    await acceptRequest(f,{kind:'date',dataset:loaded.dataset,options:{}});
    await acceptRequest(f,{kind:'import',content:JSON.stringify(loaded.dataset)});
    assert.equal(f.session.getSnapshot().accepted!.dating,undefined);assert.equal(f.session.getSnapshot().accepted!.record,null);
    f.session.deactivate();
  });
  it('cancels pending dating and ignores a late computed tree without changing accepted evidence',async()=>{
    const f=sessionFixture(),loaded=await acceptExample(f.session,f.workers);
    const dated=await acceptRequest(f,{kind:'date',dataset:loaded.dataset,options:{}}),before=f.session.getSnapshot().accepted;
    const task=f.session.run({kind:'date',dataset:loaded.dataset,options:{minimumRate:.02}});await flush();
    const worker=f.workers.at(-1)!;f.session.cancel();await task;
    worker.send({kind:'result',value:dated});worker.send({kind:'progress',phase:'Obsolete fit'});
    assert.strictEqual(f.session.getSnapshot().accepted,before);assert.equal(worker.terminated,true);
    assert.equal(f.session.getSnapshot().busy,false);f.session.deactivate();
  });
  it('snapshots submitted dating constraints and rejects missing-date replacement fits',async()=>{
    const f=sessionFixture(),loaded=await acceptExample(f.session,f.workers);
    const request:TemporalRequest={kind:'date',dataset:loaded.dataset,options:{minimumRate:.001}};
    const task=f.session.run(request);request.options.minimumRate=.02;await flush();
    assert.equal((f.workers.at(-1)!.request as Extract<TemporalRequest,{kind:'date'}>).options.minimumRate,.001);
    f.session.cancel();await task;
    const invalid=structuredClone(loaded.dataset);invalid.samples[0].collectionDate=null;
    await assert.rejects(executeTemporalRequest({kind:'date',dataset:invalid,options:{}}),/Every dated-tree tip/);
    f.session.deactivate();
  });
  it('keeps rate-bound and unresolved outcomes explicit through saved-record replay',async()=>{
    const loaded=await executeTemporalRequest({kind:'example'});
    const bound=await executeTemporalRequest({kind:'date',dataset:loaded.dataset,options:{minimumRate:.02}});
    assert.equal(bound.dating!.status,'rate-boundary');assert.deepEqual(bound.dating!.nodes,[]);
    const restored=await executeTemporalRequest({kind:'import',content:serializeAnalysisRecord(bound.datingRecord!)});
    assert.equal(restored.dating!.rootDate,null);assert.equal(restored.verified,true);
    loaded.dataset.tree.newick='((A:.001,B:.001):.001,(C:.1,D:.5):.001);';
    const incomplete=await executeTemporalRequest({kind:'date',dataset:loaded.dataset,options:{maxIterations:1}});
    assert.equal(incomplete.dating!.status,'unresolved');assert.equal(incomplete.dating!.certificate.converged,false);
  });
});
