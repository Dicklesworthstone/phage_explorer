import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable, PassThrough } from 'node:stream';
import { hostGeneWorkflowFixture } from '../../../core/src/analysis/host-gene-knockout.fixture';
import { analyzeHostGeneKnockouts, createHostGeneRecord } from '../../../core/src/analysis/host-gene-knockout';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { executeHostMetabolismJob, parseHostMetabolismCommand, runHostMetabolismCommand, runHostMetabolismJob, hostExperimentFailures } from './host-metabolism';
const parameters = JSON.stringify({ genes: ['c','d'], mode: 'joint', reference: 'Explicit test assumption', variability: ['complex'] });
const job = () => ({ operation: 'knockout' as const, input: JSON.stringify(hostGeneWorkflowFixture()), parameters });
function sink() { let text='';return { stream:new Writable({write(chunk,_encoding,callback){text+=chunk.toString();callback();}}), read:()=>text }; }
async function files(input=hostGeneWorkflowFixture()) {
  const dir=await mkdtemp(join(tmpdir(),'phage-gene-'));
  const model=join(dir,'model.json'),params=join(dir,'parameters.json');
  await writeFile(model,JSON.stringify(input));await writeFile(params,parameters);
  return {dir,model,params};
}

describe('headless model-gene experiments',()=>{
  it('parses the new command and explicit pipeline requirements without changing old defaults',()=>{
    const command=parseHostMetabolismCommand(['knockout','model.json','--params','genes.json','--require-optimal','--timeout-ms','5000'])!;
    assert.equal(command.operation,'knockout');assert.equal(command.requireOptimal,true);assert.equal(command.timeoutMs,5000);
    assert.equal(parseHostMetabolismCommand(['analyze','x'])!.requireOptimal,undefined);
    for(const args of [['knockout','x'],['inspect','x','--require-optimal'],['replay','x','--params','p'],['analyze','x','--timeout-ms','0'],['analyze','x','--timeout-ms','1e3'],['analyze','x','--timeout-ms','86400001']])assert.throws(()=>parseHostMetabolismCommand(args));
  });
  it('uses the same core record and verifies it in a new actual worker',async()=>{
    const input=hostGeneWorkflowFixture();
    const expected=await createHostGeneRecord(input,analyzeHostGeneKnockouts(input,JSON.parse(parameters)));
    const result=await runHostMetabolismJob(job());
    assert.equal(result.content,serializeAnalysisRecord(expected));
    const restored=await runHostMetabolismJob({operation:'replay',input:result.content});
    assert.equal(restored.verified,true);assert.equal(restored.content,result.content);
  });
  it('retains ordinary host-flux replay compatibility',async()=>{
    const original=await executeHostMetabolismJob({operation:'analyze',input:job().input});
    const replay=await executeHostMetabolismJob({operation:'replay',input:original.content});
    assert.equal(replay.content,original.content);assert.equal(replay.verified,true);
  });
  it('accepts explicit raw COBRA/source/medium input for knockouts',async()=>{
    const input=hostGeneWorkflowFixture();
    const raw=await executeHostMetabolismJob({operation:'knockout',input:JSON.stringify(input.cobra),source:JSON.stringify(input.source),medium:JSON.stringify(input.medium),parameters});
    assert.equal(raw.content,(await executeHostMetabolismJob(job())).content);
  });
  it('rejects an internally rehashed false knockout record',async()=>{
    const record=await parseAnalysisRecord((await executeHostMetabolismJob(job())).content);
    const value=record.fields.experiment.value as unknown as {runs:Array<{scenario:{objective:number}}>};value.runs[0].scenario.objective=500;
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(runHostMetabolismJob({operation:'replay',input:serializeAnalysisRecord(forged)}),/Fresh gene-knockout/);
  });
  it('runs the file command through a real worker and emits only a portable JSON result to stdout',async()=>{
    const {model,params}=await files(),out=sink(),err=sink();
    const code=await runHostMetabolismCommand(['knockout',model,'--params',params,'--require-optimal'],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream});
    assert.equal(code,0);const saved=await parseAnalysisRecord(out.read());assert.equal(saved.method.id,'host-gene-knockout');
    assert.ok(err.read().includes('computing'));assert.equal(hostExperimentFailures(saved).length,0);
  });
  it('writes the full infeasibility record with exit 2 and private creation permissions',async()=>{
    const input=hostGeneWorkflowFixture();input.medium.bounds=[{reactionId:'objective',lowerBound:8,upperBound:20}];
    const {dir,model,params}=await files(input),destination=join(dir,'result.json'),out=sink(),err=sink();
    const code=await runHostMetabolismCommand(['knockout',model,'--params',params,'--require-optimal','--output',destination],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream});
    assert.equal(code,2);assert.equal(out.read(),'');const saved=await parseAnalysisRecord(await readFile(destination,'utf8'));
    assert.match(hostExperimentFailures(saved).join(' '),/infeasible/);assert.match(err.read(),/Non-optimal/);
    if(process.platform!=='win32')assert.equal((await stat(destination)).mode&0o777,0o600);
    const again=await runHostMetabolismCommand(['knockout',model,'--params',params,'--output',destination],{stdin:Readable.from([]),stdout:out.stream,stderr:err.stream});assert.equal(again,1);
  });
  it('includes failed flux-range endpoints in pipeline status checks',async()=>{
    const record=await parseAnalysisRecord((await executeHostMetabolismJob(job())).content);
    const value=record.fields.experiment.value as unknown as {runs:Array<{scenario:{ranges:Array<{minimum:{status:string;value:number|null}}>}}>} ;
    value.runs[0].scenario.ranges[0].minimum.status='iteration_limit';value.runs[0].scenario.ranges[0].minimum.value=null;
    assert.match(hostExperimentFailures(record).join(' '),/minimum: iteration_limit/);
  });
  it('cancels an unfinished stdin read at the deadline without starting a worker or publishing output',async()=>{
    const stdin=new PassThrough(),out=sink(),err=sink();let called=false;
    const code=await runHostMetabolismCommand(['analyze','-','--timeout-ms','10'],{stdin,stdout:out.stream,stderr:err.stream,execute:async()=>{called=true;throw new Error('Must not execute');}});
    assert.equal(code,124);assert.equal(called,false);assert.equal(out.read(),'');assert.match(err.read(),/deadline/);
    assert.equal(stdin.listenerCount('data'),0);stdin.end();
  });
  it('terminates actual-worker computation when cancelled and does not return stale output',async()=>{
    const input=hostGeneWorkflowFixture();
    // A long serial network exercises the full numerical dependency, not a mock worker result.
    input.cobra={id:'large',genes:[{id:'a'}],metabolites:Array.from({length:190},(_,i)=>({id:'m'+i,compartment:'c'})),reactions:[
      {id:'supply',metabolites:{m0:1},lower_bound:0,upper_bound:9},
      ...Array.from({length:189},(_,i)=>({id:'r'+i,metabolites:{['m'+i]:-1,['m'+(i+1)]:1},lower_bound:0,upper_bound:9,gene_reaction_rule:'a'})),
      {id:'objective',metabolites:{m189:-1},lower_bound:0,upper_bound:9,objective_coefficient:1}]};
    const controller=new AbortController();let started=false;
    await assert.rejects(runHostMetabolismJob({operation:'knockout',input:JSON.stringify(input),parameters:JSON.stringify({genes:['a'],reference:'Cancellation probe'})},controller.signal,phase=>{
      if(phase==='computing'){started=true;controller.abort();}
    }),/cancelled/);assert.equal(started,true);
  });
});
