import {describe,it} from 'bun:test';
import assert from 'node:assert/strict';
import {serializeAnalysisRecord,createAnalysisRecord} from '../../../core/src/analysis-result';
import {executeSpacerRequest,readSpacerGenome,SpacerReferenceSession,type SpacerRequest,type SpacerWorker,type SpacerMessage,type SpacerWorkResult} from './SpacerReferenceSession';
import type {SpacerLibrary,SpacerGenome} from '../../../core/src/analysis/spacer-reference';
const sequence='ACGATTCGGTACCTAGTGCA';
const library:SpacerLibrary={format:'phage-explorer-spacer-library',version:1,name:'Synthetic fixture',source:{kind:'demo',version:'1',reference:'Analytical fixture',license:'CC0',scope:'One synthetic strain'},
  hosts:[{id:'host',name:'Test',strain:'one',accession:'synthetic:host'}],spacers:[{id:'spacer',hostId:'host',sequence,arrayAccession:'synthetic:array',system:null,target:'DNA',orientation:'guide-equivalent',pam:null,seed:null}]};
const genome:SpacerGenome={name:'Synthetic',accession:'synthetic:query',sequence:'TTTT'+sequence+'AGG',source:'local',topology:'linear'};
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
class FakeWorker implements SpacerWorker {
  onmessage:SpacerWorker['onmessage']=null;onerror:SpacerWorker['onerror']=null;onmessageerror:SpacerWorker['onmessageerror']=null;
  request:SpacerRequest|null=null;terminated=false;
  postMessage(request:SpacerRequest){this.request=request;}terminate(){this.terminated=true;}
  send(message:SpacerMessage){this.onmessage?.({data:message} as MessageEvent<SpacerMessage>);}
}
function fixture(){const scope={},workers:FakeWorker[]=[];const session=new SpacerReferenceSession(()=>{const w=new FakeWorker();workers.push(w);return w;});session.activate();session.setScope(scope);return {session,workers,scope};}
const analysisRequest=():SpacerRequest=>({kind:'analyze',genome,library,options:{maxMismatches:0}});
async function accept(f:ReturnType<typeof fixture>,request=analysisRequest()):Promise<SpacerWorkResult>{const task=f.session.run(f.scope,request);await flush();const value=await executeSpacerRequest(request);f.workers.at(-1)!.send({kind:'result',value});await task;return value;}

describe('private spacer workspace',()=>{
  it('separates validated references from actual comparison and never substitutes example data',async()=>{
    const loaded=await executeSpacerRequest({kind:'library',content:JSON.stringify(library)});assert.equal(loaded.record,null);assert.equal(loaded.genome,null);
    const result=await executeSpacerRequest(analysisRequest());assert.equal(result.result!.hits[0].start,4);assert.equal(result.record!.inputs[0].source,'local');
    await assert.rejects(executeSpacerRequest({kind:'library',content:'bad json'}));
    await assert.rejects(executeSpacerRequest({kind:'invented'} as never),/Unsupported/);
  });
  it('recomputes saved reference evidence and rejects a rehashed invented hit',async()=>{
    const result=await executeSpacerRequest(analysisRequest()),content=serializeAnalysisRecord(result.record!);
    const replay=await executeSpacerRequest({kind:'replay',content,genome});assert.equal(replay.verified,true);assert.equal(replay.record!.resultId,result.record!.resultId);
    const record=structuredClone(result.record!);(record.fields.matches.value as Array<Record<string,unknown>>)[0].start=100;
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(executeSpacerRequest({kind:'replay',content:serializeAnalysisRecord(forged),genome}),/Fresh spacer evidence/);
    await assert.rejects(executeSpacerRequest({kind:'replay',content,genome:{...genome,sequence:genome.sequence+'A'}}),/Selected genome/);
  });
  it('reads from each repository even when numeric genome IDs collide',async()=>{
    const phage={id:1,name:'same',accession:'same'},signal=new AbortController().signal;
    const a={getFullGenomeLength:async()=>20,getSequenceWindow:async()=>sequence};
    const b={getFullGenomeLength:async()=>20,getSequenceWindow:async()=>'G'.repeat(20)};
    assert.equal((await readSpacerGenome(a,phage,'unknown',signal)).sequence,sequence);
    assert.equal((await readSpacerGenome(b,phage,'unknown',signal)).sequence,'G'.repeat(20));
    await assert.rejects(readSpacerGenome({...a,getSequenceWindow:async()=>sequence.slice(1)},phage,'linear',signal),/incomplete/);
  });
  it('cancels a delayed genome length read before requesting sequence bytes',async()=>{
    const length=deferred<number>(),controller=new AbortController();let reads=0;
    const task=readSpacerGenome({getFullGenomeLength:()=>length.promise,getSequenceWindow:async()=>{reads++;return sequence;}},{id:1,name:'test',accession:null},'linear',controller.signal);
    controller.abort();length.resolve(20);await assert.rejects(task,{name:'AbortError'});assert.equal(reads,0);
  });
  it('cancels an unresolved file read immediately and never launches its late worker',async()=>{
    const f=fixture(),file=deferred<SpacerRequest>();const task=f.session.run(f.scope,()=>file.promise);f.session.cancel();await task;
    file.resolve(analysisRequest());await flush();assert.equal(f.workers.length,0);assert.equal(f.session.getSnapshot().busy,false);
  });
  it('snapshots submitted settings before listeners can mutate the original request',async()=>{
    const f=fixture(),request=analysisRequest() as Extract<SpacerRequest,{kind:'analyze'}>;
    f.session.subscribe(()=>{if(f.session.getSnapshot().busy)request.options.maxMismatches=5;});
    const task=f.session.run(f.scope,request);await flush();assert.equal((f.workers[0].request as typeof request).options.maxMismatches,0);f.session.cancel();await task;
  });
  it('selection changes cancel work and clear results while retaining the reference library',async()=>{
    const f=fixture();await accept(f);const before=f.session.getSnapshot().library;
    const pending=f.session.run(f.scope,analysisRequest());await flush();const old=f.workers.at(-1)!;
    f.session.setScope({});await pending;assert.equal(old.terminated,true);assert.equal(f.session.getSnapshot().accepted,null);
    assert.strictEqual(f.session.getSnapshot().library,before);old.send({kind:'result',value:await executeSpacerRequest(analysisRequest())});assert.equal(f.session.getSnapshot().accepted,null);
  });
  it('stale read rejection cannot unlock or overwrite a newer operation',async()=>{
    const f=fixture(),file=deferred<SpacerRequest>();const old=f.session.run(f.scope,()=>file.promise),fresh=f.session.run(f.scope,analysisRequest());await old;await flush();
    file.reject(new Error('obsolete'));await flush();assert.equal(f.session.getSnapshot().busy,true);assert.equal(f.session.getSnapshot().error,null);
    f.workers[0].send({kind:'result',value:await executeSpacerRequest(analysisRequest())});await fresh;assert.ok(f.session.getSnapshot().accepted);
  });
  it('failed replacement references and cancelled work preserve accepted evidence',async()=>{
    const f=fixture();await accept(f);const before=f.session.getSnapshot().accepted;
    const task=f.session.run(f.scope,{kind:'library',content:'broken'});await flush();f.workers.at(-1)!.send({kind:'error',message:'Invalid reference'});await task;
    assert.strictEqual(f.session.getSnapshot().accepted,before);
    const next=f.session.run(f.scope,analysisRequest());await flush();const w=f.workers.at(-1)!;f.session.cancel();await next;
    w.send({kind:'result',value:{...before!,verified:true}});assert.strictEqual(f.session.getSnapshot().accepted,before);assert.equal(w.terminated,true);
  });
  it('successful replacement library invalidates old comparisons',async()=>{
    const f=fixture();await accept(f);await accept(f,{kind:'library',content:JSON.stringify({...library,name:'replacement'})});
    assert.equal(f.session.getSnapshot().accepted,null);assert.equal(f.session.getSnapshot().library!.name,'replacement');
  });
  it('handles worker construction, clone, decode and protocol failures without stranded requests',async()=>{
    const f=fixture();await accept(f);const before=f.session.getSnapshot().accepted;
    for(const mode of ['error','decode','protocol']){const task=f.session.run(f.scope,analysisRequest());await flush();const w=f.workers.at(-1)!;
      if(mode==='error')w.onerror?.({} as ErrorEvent);else if(mode==='decode')w.onmessageerror?.({} as MessageEvent);else w.send({kind:'result',value:{} as never});
      await task;assert.equal(w.terminated,true);assert.equal(f.session.getSnapshot().busy,false);assert.strictEqual(f.session.getSnapshot().accepted,before);assert.ok(f.session.getSnapshot().error);
    }
    for(const factory of [()=>{throw new Error('construction failed');},()=>{const w=new FakeWorker();w.postMessage=()=>{throw new Error('clone failed');};return w;}]){
      const s=new SpacerReferenceSession(factory),scope={};s.activate();s.setScope(scope);await s.run(scope,analysisRequest());assert.equal(s.getSnapshot().busy,false);assert.match(s.getSnapshot().error!,/failed/);
    }
  });
  it('does not allocate for stale scopes or inactive views; reactivation cannot accept old work',async()=>{
    const f=fixture();await f.session.run({},analysisRequest());assert.equal(f.workers.length,0);f.session.deactivate();await f.session.run(f.scope,analysisRequest());assert.equal(f.workers.length,0);
    f.session.activate();const old=f.session.run(f.scope,analysisRequest());await flush();f.session.deactivate();await old;f.session.activate();
    const fresh=f.session.run(f.scope,analysisRequest());await flush();f.workers[0].send({kind:'result',value:await executeSpacerRequest(analysisRequest())});assert.equal(f.session.getSnapshot().accepted,null);
    f.workers[1].send({kind:'result',value:await executeSpacerRequest(analysisRequest())});await fresh;assert.ok(f.session.getSnapshot().accepted);
  });
  it('supports synchronous replies and reentrant cancellation without publishing obsolete evidence',async()=>{
    const value=await executeSpacerRequest(analysisRequest()),w=new FakeWorker();w.postMessage=()=>w.send({kind:'result',value});
    const s=new SpacerReferenceSession(()=>w),scope={};s.activate();s.setScope(scope);await s.run(scope,analysisRequest());assert.equal(s.getSnapshot().accepted?.record?.resultId,value.record!.resultId);assert.equal(w.terminated,true);
    const f=fixture();f.session.subscribe(()=>{if(f.session.getSnapshot().phase==='stop')f.session.cancel();});const task=f.session.run(f.scope,analysisRequest());await flush();f.workers[0].send({kind:'progress',phase:'stop'});await task;assert.equal(f.workers[0].terminated,true);assert.equal(f.session.getSnapshot().accepted,null);
  });
});
