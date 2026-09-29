import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ancestralConsensus, createAncestralRecord, reconstructAncestors, type AncestralDataset } from '../../../core/src/analysis/ancestral-reconstruction';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { AncestralSession, executeAncestralRequest, type AncestralMessage, type AncestralRequest, type AncestralWorker } from './AncestralSession';

const input=():AncestralDataset=>({format:'phage-explorer-ancestral',version:1,name:'Synthetic two-tip input',
  source:{kind:'demo',description:'Hand-derived transition fixture',reference:'At t=3/4 log 3, Pii=1/2, Pij=1/6',license:'Test fixture'},
  tree:{newick:`(a:${.75*Math.log(3)},b:${.75*Math.log(3)});`,units:'substitutions/site',method:'Prespecified',rooting:'Synthetic root'},
  alignment:{homologous:true,fasta:'>a\nAAN\n>b\nACN',method:'Prespecified columns',reference:'Synthetic aligned DNA'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
class TestWorker implements AncestralWorker {
  onmessage:AncestralWorker['onmessage']=null;onerror:AncestralWorker['onerror']=null;onmessageerror:AncestralWorker['onmessageerror']=null;
  stopped=false;request:AncestralRequest|null=null;
  constructor(readonly automatic=true){}
  send(message:AncestralMessage){this.onmessage?.({data:message} as MessageEvent<AncestralMessage>);}
  postMessage(request:AncestralRequest){this.request=request;if(this.automatic)void executeAncestralRequest(request,phase=>this.send({kind:'progress',phase})).then(value=>this.send({kind:'result',value}),cause=>this.send({kind:'error',message:String(cause)}));}
  terminate(){this.stopped=true;}
}

describe('ancestral worker request boundary',()=>{
  it('loads exact inputs without computing or inventing an ancestral result',async()=>{
    const loaded=await executeAncestralRequest({kind:'load',input:input()});
    assert.equal(loaded.result,null);assert.equal(loaded.record,null);assert.equal(loaded.columns,3);assert.equal(loaded.tips,2);
    assert.equal(loaded.input.alignment.fasta,input().alignment.fasta);
  });
  it('runs actual numerical code and restores complete evidence on a fresh request',async()=>{
    const work=await executeAncestralRequest({kind:'analyze',input:input(),options:{minPosterior:.7}});
    assert.ok(work.result&&work.record);assert.equal(ancestralConsensus(work.result,'n0'),'ANN');
    assert.ok(Math.abs(work.result.patterns[0].nodes![0][0]-.75)<1e-12);
    const replay=await executeAncestralRequest({kind:'import',content:'\uFEFF'+serializeAnalysisRecord(work.record)});
    assert.equal(replay.verified,true);assert.equal(replay.record!.resultId,work.record.resultId);
    assert.deepEqual(replay.result,work.result);
  });
  it('rejects rehashed false probability vectors instead of displaying stored output',async()=>{
    const d=input(),record=await createAncestralRecord(d,reconstructAncestors(d));
    const values=record.fields.reconstruction.value as unknown as ReturnType<typeof reconstructAncestors>;
    values.patterns[0].nodes![0]=[1,0,0,0];
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...row})=>row)});
    await assert.rejects(executeAncestralRequest({kind:'import',content:serializeAnalysisRecord(forged)}),/Fresh ancestral evidence differs/);
  });
  it('rejects unknown operations and oversized or malformed saved input',async()=>{
    await assert.rejects(executeAncestralRequest({kind:'other'} as unknown as AncestralRequest),/Unsupported/);
    for(const content of ['{',' '.repeat(10*1024*1024+1)])await assert.rejects(executeAncestralRequest({kind:'import',content}));
  });
});

describe('accepted ancestral evidence lifecycle',()=>{
  it('snapshots submitted inputs and options, ignoring edits while the worker is scheduled',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();
    const data=input(),options={minPosterior:.7};const running=session.run({kind:'analyze',input:data,options});
    data.name='Later edit';options.minPosterior=1;await running;
    assert.equal(session.getSnapshot().accepted!.input.name,'Synthetic two-tip input');
    assert.equal(session.getSnapshot().accepted!.options.minPosterior,.7);
    assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('preserves accepted results after invalid replacement and clears them only after valid new input',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();
    await session.run({kind:'analyze',input:input(),options:{}});const before=session.getSnapshot().accepted;
    await session.run({kind:'import',content:'bad input'});
    assert.strictEqual(session.getSnapshot().accepted,before);assert.ok(session.getSnapshot().error);assert.equal(session.getSnapshot().busy,false);
    const replacement=input();replacement.name='Replacement';await session.run({kind:'load',input:replacement});
    assert.equal(session.getSnapshot().accepted!.input.name,'Replacement');assert.equal(session.getSnapshot().accepted!.record,null);session.deactivate();
  });
  it('cancels a pending file read immediately and never creates its abandoned worker',async()=>{
    let created=0;const session=new AncestralSession(()=>{created++;return new TestWorker();});session.activate();
    await session.run({kind:'load',input:input()});const before=session.getSnapshot().accepted;
    const file=deferred<AncestralRequest>(),running=session.run(file.promise);session.cancel();await running;
    assert.equal(session.getSnapshot().busy,false);assert.strictEqual(session.getSnapshot().accepted,before);assert.equal(created,1);
    file.resolve({kind:'load',input:input()});await flush();assert.equal(created,1);session.deactivate();
  });
  it('terminates running work and ignores its late success, failure and progress',async()=>{
    const workers:TestWorker[]=[];const session=new AncestralSession(()=>{const w=new TestWorker(false);workers.push(w);return w;});session.activate();
    const running=session.run({kind:'analyze',input:input(),options:{}});await flush();session.cancel();await running;
    assert.equal(workers[0].stopped,true);
    workers[0].send({kind:'result',value:await executeAncestralRequest({kind:'load',input:input()})});
    workers[0].send({kind:'error',message:'old failure'});workers[0].send({kind:'progress',phase:'obsolete'});
    assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().error,null);assert.equal(session.getSnapshot().phase,'');session.deactivate();
  });
  it('an old promise cannot clear a newer loading owner or overwrite its evidence',async()=>{
    const workers:TestWorker[]=[];const session=new AncestralSession(()=>{const w=new TestWorker(false);workers.push(w);return w;});session.activate();
    const old=session.run({kind:'load',input:input()});await flush();
    const next=input();next.name='Newer';const fresh=session.run({kind:'load',input:next});await flush();await old;
    workers[0].send({kind:'error',message:'late failure'});assert.equal(session.getSnapshot().busy,true);assert.equal(session.getSnapshot().error,null);
    workers[1].send({kind:'result',value:await executeAncestralRequest({kind:'load',input:next})});await fresh;
    assert.equal(session.getSnapshot().accepted!.input.name,'Newer');assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('settles constructor, postMessage, worker and malformed-response failures',async()=>{
    for(const mode of ['construct','post','error','messageerror','malformed']){
      let worker:TestWorker|undefined;
      const session=new AncestralSession(()=>{
        if(mode==='construct')throw new Error('Creation failed');worker=new TestWorker(false);
        worker.postMessage=()=>{if(mode==='post')throw new Error('Send failed');};return worker;
      });session.activate();const running=session.run({kind:'load',input:input()});await flush();
      if(mode==='error')worker!.onerror?.({} as ErrorEvent);
      if(mode==='messageerror')worker!.onmessageerror?.({} as MessageEvent);
      if(mode==='malformed')worker!.send({kind:'broken'} as unknown as AncestralMessage);
      await running;assert.equal(session.getSnapshot().busy,false);assert.ok(session.getSnapshot().error);
      if(worker)assert.equal(worker.stopped,true);session.deactivate();
    }
  });
  it('deactivation cancels and reactivation cannot adopt the previous owner',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();const file=deferred<AncestralRequest>();
    const previous=session.run(file.promise);session.deactivate();session.activate();
    const d=input();d.name='Current activation';await session.run({kind:'load',input:d});file.resolve({kind:'load',input:input()});await previous;
    assert.equal(session.getSnapshot().accepted!.input.name,'Current activation');session.deactivate();
  });
  it('keeps legitimate zero-likelihood diagnostics without treating them as computed certainty',async()=>{
    const session=new AncestralSession(()=>new TestWorker());session.activate();const d=input();d.tree.newick='(a:0,b:0);';
    await session.run({kind:'analyze',input:d,options:{}});const result=session.getSnapshot().accepted!.result!;
    assert.equal(result.impossibleColumns,1);assert.equal(result.logLikelihood,null);assert.equal(result.patterns[1].nodes,null);
    assert.equal(session.getSnapshot().error,null);session.deactivate();
  });
});
