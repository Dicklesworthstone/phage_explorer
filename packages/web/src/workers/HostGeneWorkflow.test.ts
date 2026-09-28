import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { hostGeneWorkflowFixture } from '../../../core/src/analysis/host-gene-knockout.fixture';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { executeHostMetabolismRequest, HostMetabolismSession, type HostMetabolismMessage,
  type HostMetabolismRequest, type HostMetabolismWork, type HostMetabolismWorker } from './HostMetabolismSession';
const request=():HostMetabolismRequest=>({kind:'knockout',input:hostGeneWorkflowFixture(),options:{genes:['c','d'],reference:'Browser test',mode:'joint',variability:['complex']}});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
class WorkerProbe implements HostMetabolismWorker {
  onmessage:HostMetabolismWorker['onmessage']=null;onerror:HostMetabolismWorker['onerror']=null;onmessageerror:HostMetabolismWorker['onmessageerror']=null;
  request:HostMetabolismRequest|null=null;terminated=false;
  postMessage=(request:HostMetabolismRequest)=>{this.request=request;};terminate=()=>{this.terminated=true;};
  reply=(value:HostMetabolismWork)=>this.onmessage?.({data:{kind:'result',value}} as MessageEvent<HostMetabolismMessage>);
}
describe('browser model-gene workflow',()=>{
  it('computes and restores a knockout record without masquerading as a manual-bound experiment',async()=>{
    const answer=await executeHostMetabolismRequest(request());assert.equal(answer.result,null);assert.ok(answer.geneResult);assert.equal(answer.geneResult!.baseline.objective,9);assert.equal(answer.geneResult!.runs[0].scenario.objective,6);
    const restored=await executeHostMetabolismRequest({kind:'import',content:serializeAnalysisRecord(answer.record!)});
    assert.equal(restored.verified,true);assert.equal(restored.record!.resultId,answer.record!.resultId);assert.deepEqual(restored.geneResult,answer.geneResult);
  });
  it('ordinary input replacement clears a previous knockout result',async()=>{
    const loaded=await executeHostMetabolismRequest({kind:'import',content:JSON.stringify(hostGeneWorkflowFixture())});
    assert.equal(loaded.geneResult,undefined);assert.equal(loaded.record,null);
  });
  it('still reopens existing manual-bound records unchanged',async()=>{
    const answer=await executeHostMetabolismRequest({kind:'analyze',input:hostGeneWorkflowFixture(),options:{}});
    const replay=await executeHostMetabolismRequest({kind:'import',content:serializeAnalysisRecord(answer.record!)});
    assert.equal(replay.record!.resultId,answer.record!.resultId);assert.equal(replay.geneResult,undefined);assert.ok(replay.result);
  });
  it('rejects forged association-derived results even with valid integrity checks',async()=>{
    const answer=await executeHostMetabolismRequest(request());const record=structuredClone(answer.record!);
    const experiment=record.fields.experiment.value as unknown as {runs:Array<{disabled:unknown[]}>};experiment.runs[0].disabled=[];
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(executeHostMetabolismRequest({kind:'import',content:serializeAnalysisRecord(forged)}),/Fresh gene-knockout/);
  });
  it('preserves accepted evidence and ignores cancelled file reads',async()=>{
    const workers:WorkerProbe[]=[];const session=new HostMetabolismSession(()=>{const worker=new WorkerProbe();workers.push(worker);return worker;});session.activate();
    const initial=session.run(request());await flush();const accepted=await executeHostMetabolismRequest(request());workers[0].reply(accepted);await initial;
    const file=deferred<HostMetabolismRequest>();const waiting=session.run(file.promise);session.cancel();await waiting;file.resolve({kind:'import',content:'invalid'});await flush();
    assert.strictEqual(session.getSnapshot().accepted,accepted);assert.equal(workers.length,1);assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
  it('snapshots submitted genes and ignores old successes and errors after a replacement request',async()=>{
    const workers:WorkerProbe[]=[];const session=new HostMetabolismSession(()=>{const worker=new WorkerProbe();workers.push(worker);return worker;});session.activate();
    const submitted=request();const old=session.run(submitted);(submitted as {options:{genes:string[]}}).options.genes.push('a');await flush();
    assert.deepEqual((workers[0].request as {options:{genes:string[]}}).options.genes,['c','d']);
    const fresh=session.run({kind:'import',content:JSON.stringify(hostGeneWorkflowFixture())});await flush();assert.equal(workers[0].terminated,true);
    workers[0].reply(await executeHostMetabolismRequest(request()));workers[0].onerror?.({} as ErrorEvent);await old;
    assert.equal(session.getSnapshot().busy,true);assert.equal(session.getSnapshot().accepted,null);
    const loaded=await executeHostMetabolismRequest(workers[1].request!);workers[1].reply(loaded);await fresh;
    assert.strictEqual(session.getSnapshot().accepted,loaded);assert.equal(session.getSnapshot().error,null);session.deactivate();
  });
  it('cancellation terminates the active worker without accepting a later result',async()=>{
    const worker=new WorkerProbe(),session=new HostMetabolismSession(()=>worker);session.activate();const pending=session.run(request());await flush();session.cancel();await pending;
    worker.reply(await executeHostMetabolismRequest(request()));assert.equal(worker.terminated,true);assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().busy,false);session.deactivate();
  });
});
