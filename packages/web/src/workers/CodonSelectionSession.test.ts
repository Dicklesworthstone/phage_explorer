import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { CodonSelectionSession, executeCodonSelectionRequest, type CodonSelectionWorker, type CodonSelectionRequest,
  type CodonSelectionMessage, type CodonSelectionWork } from './CodonSelectionSession';
import type { CodonAlignmentInput } from '../../../core/src/analysis/codon-selection';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
const fixture = (): CodonAlignmentInput => ({ format:'phage-explorer-codon-alignment',version:1,name:'Session test',
  source:{kind:'local',description:'Synthetic test supplied locally',reference:'Hand-derived fixture',license:'CC0'},
  alignment:{fasta:'>a\n'+'GCT'.repeat(10)+'\n>b\nGCCGAT'+'GCT'.repeat(8),homologousCodons:true,orientation:'coding-5to3',frame:0,geneticCode:11,method:'Aligned by construction',reference:'Test CDS columns'} });
function deferred<T>() { let resolve!: (v:T)=>void, reject!: (v:Error)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
async function flush(){for(let i=0;i<10;i++)await Promise.resolve();}
class FakeWorker implements CodonSelectionWorker {
  onmessage: CodonSelectionWorker['onmessage'] = null;
  onerror: CodonSelectionWorker['onerror'] = null;
  onmessageerror: CodonSelectionWorker['onmessageerror'] = null;
  stopped = false; request: CodonSelectionRequest | null = null;
  constructor(readonly automatic = true) {}
  postMessage(request:CodonSelectionRequest){this.request=request;if(this.automatic)void executeCodonSelectionRequest(request,p=>this.send({kind:'progress',phase:p})).then(value=>this.send({kind:'result',value}),error=>this.send({kind:'error',message:String(error.message)}));}
  terminate(){this.stopped=true;}
  send(message:CodonSelectionMessage){this.onmessage?.({data:message} as MessageEvent<CodonSelectionMessage>);}
}
const load = async () => {
  const workers:FakeWorker[]=[],session=new CodonSelectionSession(()=>{const w=new FakeWorker();workers.push(w);return w;});session.activate();
  await session.run({kind:'load',input:fixture()}); return {session,workers};
};
describe('coding alignment worker requests and lifecycle',()=>{
  it('loads without computing and then returns the actual hand-derived result',async()=>{
    const {session,workers}=await load();assert.equal(session.getSnapshot().accepted?.result,null);
    await session.run({kind:'analyze',input:fixture(),options:{}});
    const work=session.getSnapshot().accepted!;assert.equal(work.result!.pairs[0].overall.synonymousDifferences,1);
    assert.ok(Math.abs(work.result!.pairs[0].overall.synonymousSites-29/3)<1e-12);assert.ok(work.record);assert.ok(workers.every(w=>w.stopped));session.deactivate();
  });
  it('loads a large valid alignment with budget-compatible defaults without starting analysis',async()=>{
    const input=fixture();input.alignment.fasta=Array.from({length:32},(_,i)=>`>s${i}\n${'GCT'.repeat(20000)}`).join('\n');
    const work=await executeCodonSelectionRequest({kind:'load',input});
    assert.equal(work.result,null);assert.ok(work.options.windowCodons>50);
    assert.ok(31*Math.ceil(20000/work.options.windowCodons)<=4096);
  });
  it('recomputes an import and preserves complete accepted evidence identity',async()=>{
    const work=await executeCodonSelectionRequest({kind:'analyze',input:fixture(),options:{windowCodons:2}});
    const reopened=await executeCodonSelectionRequest({kind:'import',content:serializeAnalysisRecord(work.record!)});
    assert.equal(reopened.verified,true);assert.deepEqual(reopened.result,work.result);assert.deepEqual(reopened.record,work.record);
  });
  it('refuses rehashed output forgery and preserves a prior accepted result',async()=>{
    const {session}=await load();await session.run({kind:'analyze',input:fixture(),options:{}});const accepted=session.getSnapshot().accepted!;
    const record=structuredClone(accepted.record!);(record.fields.comparisons.value as any).pairs[0].overall.omega=10;
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...value})=>value)});
    await session.run({kind:'import',content:serializeAnalysisRecord(forged)});assert.strictEqual(session.getSnapshot().accepted,accepted);assert.match(session.getSnapshot().error!,/differs/);session.deactivate();
  });
  it('invalid replacement input preserves accepted evidence but a valid replacement clears stale results',async()=>{
    const {session}=await load();await session.run({kind:'analyze',input:fixture(),options:{}});const before=session.getSnapshot().accepted;
    await session.run({kind:'import',content:'{}'});assert.strictEqual(session.getSnapshot().accepted,before);
    const next=fixture();next.name='Replacement';await session.run({kind:'load',input:next});assert.equal(session.getSnapshot().accepted!.input.name,'Replacement');assert.equal(session.getSnapshot().accepted!.record,null);session.deactivate();
  });
  it('cancels a pending file read immediately and ignores its late rejection',async()=>{
    const {session,workers}=await load();const before=session.getSnapshot().accepted, pending=deferred<CodonSelectionRequest>();
    const running=session.run(pending.promise);session.cancel();await running;assert.equal(session.getSnapshot().busy,false);
    pending.reject(new Error('late file error'));await flush();assert.equal(workers.length,1);assert.strictEqual(session.getSnapshot().accepted,before);assert.equal(session.getSnapshot().error,null);session.deactivate();
  });
  it('terminates cancelled work and rejects a late successful worker reply',async()=>{
    const w=new FakeWorker(false),session=new CodonSelectionSession(()=>w);session.activate();const running=session.run({kind:'analyze',input:fixture(),options:{}});await flush();
    session.cancel();await running;assert.equal(w.stopped,true);w.send({kind:'result',value:await executeCodonSelectionRequest(w.request!)});
    assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('obsolete errors and finalizers cannot unlock or replace a newer request',async()=>{
    const workers:FakeWorker[]=[],session=new CodonSelectionSession(()=>{const w=new FakeWorker(false);workers.push(w);return w;});session.activate();
    const a=session.run({kind:'load',input:fixture()});await flush();const b=session.run({kind:'analyze',input:fixture(),options:{}});await flush();await a;
    workers[0].send({kind:'error',message:'obsolete failure'});assert.equal(session.getSnapshot().busy,true);assert.equal(session.getSnapshot().error,null);
    workers[1].send({kind:'result',value:await executeCodonSelectionRequest(workers[1].request!)});await b;assert.ok(session.getSnapshot().accepted?.result);session.deactivate();
  });
  it('snapshots submitted parameters before the first asynchronous boundary',async()=>{
    const {session}=await load();const input=fixture(),options={windowCodons:2};const running=session.run({kind:'analyze',input,options});
    input.name='Changed after submission';options.windowCodons=1;await running;assert.equal(session.getSnapshot().accepted!.options.windowCodons,2);assert.equal(session.getSnapshot().accepted!.input.name,'Session test');session.deactivate();
  });
  it('deactivation and reactivation cannot accept a previous-session reply',async()=>{
    const workers:FakeWorker[]=[],session=new CodonSelectionSession(()=>{const w=new FakeWorker(false);workers.push(w);return w;});session.activate();
    const old=session.run({kind:'load',input:fixture()});await flush();session.deactivate();await old;session.activate();
    const current=session.run({kind:'load',input:fixture()});await flush();workers[0].send({kind:'result',value:await executeCodonSelectionRequest(workers[0].request!)});
    assert.equal(session.getSnapshot().busy,true);assert.equal(session.getSnapshot().accepted,null);
    workers[1].send({kind:'result',value:await executeCodonSelectionRequest(workers[1].request!)});await current;assert.ok(session.getSnapshot().accepted);session.deactivate();
  });
  it('settles worker errors, decoding errors, malformed responses and startup failures',async()=>{
    for(const fail of [(w:FakeWorker)=>w.onerror?.({} as ErrorEvent),(w:FakeWorker)=>w.onmessageerror?.({} as MessageEvent),(w:FakeWorker)=>w.send({kind:'result',value:{} as CodonSelectionWork})]){
      const w=new FakeWorker(false),session=new CodonSelectionSession(()=>w);session.activate();const running=session.run({kind:'load',input:fixture()});await flush();fail(w);await running;
      assert.ok(session.getSnapshot().error);assert.equal(session.getSnapshot().busy,false);assert.ok(w.stopped);session.deactivate();
    }
    const session=new CodonSelectionSession(()=>{throw new Error('Worker unavailable');});session.activate();await session.run({kind:'load',input:fixture()});assert.match(session.getSnapshot().error!,/Worker unavailable/);session.deactivate();
  });
  it('rejects oversized saved files and unknown operations',async()=>{
    await assert.rejects(executeCodonSelectionRequest({kind:'import',content:' '.repeat(10*1024*1024+1)}),/exceeds/);
    await assert.rejects(executeCodonSelectionRequest({kind:'other'} as unknown as CodonSelectionRequest),/Unsupported/);
  });
  it('never creates a worker for a disabled session or a cancelled late file read',async()=>{
    let calls=0;const session=new CodonSelectionSession(()=>{calls++;return new FakeWorker();});
    await session.run(Promise.reject(new Error('disabled file error')));session.activate();const file=deferred<CodonSelectionRequest>();const running=session.run(file.promise);session.cancel();await running;
    file.resolve({kind:'load',input:fixture()});await flush();assert.equal(calls,0);session.deactivate();
  });
});
