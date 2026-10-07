import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { runGrowthWork, type GrowthWorker } from './growth-inference-client';
import { executeGrowthRequest, type GrowthRequest, type GrowthWorkResult } from './growth-inference.worker';
import { DEFAULT_GROWTH_CONDITIONS, resolveGrowthOptions } from '../../../core/src/analysis/growth-inference';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';

const request: GrowthRequest = { kind:'load', name:'curve.csv', conditions:DEFAULT_GROWTH_CONDITIONS,
  content:'timeMin,type,value,sigma\n0,PFU,100000,.1\n5,PFU,95000,.1\n10,PFU,120000,.1\n15,PFU,200000,.1\n20,PFU,350000,.1\n30,PFU,1000000,.1' };
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (cause:Error)=>void;
  const promise = new Promise<T>((yes,no)=>{ resolve=yes;reject=no; });
  return { promise, resolve, reject };
}
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
class MockWorker implements GrowthWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  sent: unknown[] = [];
  terminated=0;
  postMessage(value: unknown): void { this.sent.push(value); }
  terminate(): void { this.terminated++; }
  message(value: unknown): void { this.onmessage?.call(this as unknown as Worker, {data:value} as MessageEvent); }
}

describe('growth worker lifecycle', () => {
  it('cancels delayed input immediately without starting abandoned work', async () => {
    const file = deferred<GrowthRequest>(), abort = new AbortController(); let starts=0;
    const task=runGrowthWork(file.promise,abort.signal,()=>{},()=>{ starts++;return new MockWorker(); });
    abort.abort(); await assert.rejects(task,/cancelled/);
    file.resolve(request); await flush(); assert.equal(starts,0);
  });
  it('observes late file-read rejection after cancellation', async () => {
    const file=deferred<GrowthRequest>(), abort=new AbortController();
    const task=runGrowthWork(file.promise,abort.signal,()=>{},()=>new MockWorker());
    abort.abort(); await assert.rejects(task,/cancelled/);
    file.reject(new Error('late read error')); await flush();
  });
  it('terminates a running worker, clears callbacks and ignores stale results/progress', async () => {
    const worker=new MockWorker(), abort=new AbortController(), progress:string[]=[];
    const task=runGrowthWork(request,abort.signal,m=>progress.push(m),()=>worker);
    await flush(); assert.equal(worker.sent.length,1);
    const callback=worker.onmessage!;
    abort.abort(); await assert.rejects(task,/cancelled/);
    callback.call(worker as unknown as Worker,{data:{kind:'progress',message:'stale'}} as MessageEvent);
    callback.call(worker as unknown as Worker,{data:{kind:'result',value:{}}} as MessageEvent);
    assert.deepEqual(progress,[]); assert.equal(worker.terminated,1); assert.equal(worker.onmessage,null);
  });
  it('settles a successful result once and releases the worker', async () => {
    const worker=new MockWorker(), abort=new AbortController();
    const value=await executeGrowthRequest(request);
    const task=runGrowthWork(request,abort.signal,()=>{},()=>worker);
    await flush(); worker.message({kind:'result',value});
    assert.deepEqual(await task,value); assert.equal(worker.terminated,1);
    abort.abort(); assert.equal(worker.terminated,1);
  });
  it('rejects worker errors and malformed response types without hanging', async () => {
    for(const kind of ['worker','decode','protocol','model']) {
      const worker=new MockWorker();
      const task=runGrowthWork(request,new AbortController().signal,()=>{},()=>worker);
      await flush();
      if(kind==='worker') worker.onerror!.call(worker as unknown as Worker,{} as ErrorEvent);
      else if(kind==='decode') worker.onmessageerror!.call(worker as unknown as Worker,{} as MessageEvent);
      else worker.message(kind==='model'?{kind:'error',message:'invalid model'}:{kind:'other'});
      await assert.rejects(task); assert.equal(worker.terminated,1);
    }
  });
  it('fails closed on empty messages or throwing progress subscribers', async () => {
    for (const malformed of [null, {}, {kind:'result'}, {kind:'progress',message:3}]) {
      const worker=new MockWorker();
      const pending=runGrowthWork(request,new AbortController().signal,()=>{},()=>worker);
      await flush();worker.message(malformed);
      await assert.rejects(pending,/Unexpected/);assert.equal(worker.terminated,1);
    }
    const worker=new MockWorker();
    const pending=runGrowthWork(request,new AbortController().signal,()=>{throw new Error('progress failed');},()=>worker);
    await flush();worker.message({kind:'progress',message:'working'});
    await assert.rejects(pending,/progress failed/);assert.equal(worker.terminated,1);
  });
  it('handles constructor and structured-clone failures', async () => {
    await assert.rejects(runGrowthWork(request,new AbortController().signal,()=>{},()=>{throw new Error('constructor');}),/constructor/);
    const worker=new MockWorker(); worker.postMessage=()=>{throw new Error('clone');};
    await assert.rejects(runGrowthWork(request,new AbortController().signal,()=>{},()=>worker),/clone/);
    assert.equal(worker.terminated,1);
  });
  it('cleans up a worker whose factory cancels reentrantly', async () => {
    const worker=new MockWorker(), abort=new AbortController();
    const task=runGrowthWork(request,abort.signal,()=>{},()=>{abort.abort();return worker;});
    await assert.rejects(task,/cancelled/); assert.equal(worker.terminated,1); assert.equal(worker.sent.length,0);
  });
  it('does not let cancellation of one request disturb an independent worker', async () => {
    const a=new MockWorker(),b=new MockWorker(),abortA=new AbortController(),abortB=new AbortController();
    const first=runGrowthWork(request,abortA.signal,()=>{},()=>a),second=runGrowthWork(request,abortB.signal,()=>{},()=>b);
    await flush();abortA.abort();await assert.rejects(first);
    const result=await executeGrowthRequest(request);b.message({kind:'result',value:result});
    assert.deepEqual(await second,result);assert.equal(b.terminated,1);
  });
});

describe('growth import and fit worker operations', () => {
  it('loads without silently fitting or changing the supplied initial conditions', async () => {
    const value=await executeGrowthRequest(request);
    assert.equal(value.result,null);assert.equal(value.record,null);assert.equal(value.verified,false);
    assert.deepEqual(value.dataset.conditions,DEFAULT_GROWTH_CONDITIONS);
  });
  it('executes fitting and fresh verification using the shared core model', async () => {
    const loaded=await executeGrowthRequest(request), messages:string[]=[];
    const fitted=await executeGrowthRequest({kind:'fit',dataset:loaded.dataset,options:resolveGrowthOptions({starts:1})},m=>messages.push(m));
    assert.ok(fitted.result);assert.ok(fitted.record);assert.ok(messages.some(m=>m.includes('Fitting')));
    const restored:GrowthWorkResult=await executeGrowthRequest({...request,content:serializeAnalysisRecord(fitted.record!)});
    assert.equal(restored.verified,true);assert.equal(restored.record?.resultId,fitted.record?.resultId);
  });
  it('keeps detection limits distinct from measured counts through actual fit/profile operations and replay', async () => {
    const lines = request.content.split('\n');
    const content = `${lines[0]},censoring\n` + lines.slice(1).map((line, i) => `${line},${i === 0 ? 'left' : 'none'}`).join('\n');
    const loaded = await executeGrowthRequest({ ...request, content });
    assert.equal(loaded.dataset.observations[0].value, 100000);
    assert.equal(loaded.dataset.observations[0].censoring, 'left');
    const options = resolveGrowthOptions({ starts: 1, freeParameters: ['burstSize'] });
    const fitted = await executeGrowthRequest({ kind: 'fit', dataset: loaded.dataset, options });
    const first = fitted.result!.residuals[0];
    assert.equal(first.standardizedResidual, null);
    assert.ok(Math.abs(first.likelihoodDeviance! - 2 * Math.LN2) < 1e-12); // prediction equals limit at t=0.
    assert.equal(fitted.record!.method.version, '2');
    const profiled = await executeGrowthRequest({ kind: 'profile', dataset: loaded.dataset, options, parameter: 'burstSize', baselineResultId: fitted.record!.resultId });
    assert.equal(profiled.profileRecord!.method.version, '2');
    const restored = await executeGrowthRequest({ ...request, content: serializeAnalysisRecord(profiled.profileRecord!) });
    assert.equal(restored.verified, true);
    assert.equal(restored.profileRecord!.resultId, profiled.profileRecord!.resultId);
    assert.equal(restored.result!.residuals[0].standardizedResidual, null);
    assert.equal(restored.dataset.observations[0].censoring, 'left');
  });
  it('rejects unknown operations and oversized inputs', async () => {
    await assert.rejects(executeGrowthRequest({kind:'other'} as unknown as GrowthRequest),/Unsupported/);
    await assert.rejects(executeGrowthRequest({...request,content:' '.repeat(10*1024*1024+1)}),/limit/);
  });
});

it('profiles an accepted fit, replays its separate record and rejects altered fit identity', async()=>{
  const data=await executeGrowthRequest(request);
  const options=resolveGrowthOptions({starts:1,freeParameters:['burstSize']});
  const fit=await executeGrowthRequest({kind:'fit',dataset:data.dataset,options});
  const profileRequest:GrowthRequest={kind:'profile',dataset:data.dataset,options,parameter:'burstSize',baselineResultId:fit.record!.resultId};
  const profiled=await executeGrowthRequest(profileRequest);
  assert.equal(profiled.record!.resultId,fit.record!.resultId);
  assert.equal(profiled.profile!.parameter,'burstSize');
  assert.ok(profiled.profileRecord);
  const replayed=await executeGrowthRequest({...request,content:serializeAnalysisRecord(profiled.profileRecord!)});
  assert.equal(replayed.verified,true);
  assert.equal(replayed.profileRecord!.resultId,profiled.profileRecord!.resultId);
  await assert.rejects(executeGrowthRequest({...profileRequest,baselineResultId:'not-a-digest'}),/identity/);
  await assert.rejects(executeGrowthRequest({...profileRequest,baselineResultId:'0'.repeat(64)}),/differ from the accepted fit/);
});
