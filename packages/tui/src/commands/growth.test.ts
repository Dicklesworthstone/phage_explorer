import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { executeGrowthJob, parseGrowthCommand, runGrowthCommand, type GrowthCommandIO, type GrowthJob } from './growth';

const conditions = JSON.stringify({ initialBacteria: 1e7, initialPhage: 1e5, bacterialGrowthRate: 0,
  phageDecayRate: 0, odCellsPerMl: 8e8, stages: 4 });
const csv = 'timeMin,type,value,sigma\n0,PFU,100000,0.2\n5,PFU,110000,0.2\n10,PFU,130000,0.2\n20,PFU,300000,0.2\n30,PFU,900000,0.2\n40,PFU,1500000,0.2\n';
const params = JSON.stringify({ initial: { adsorptionRate: 2e-9, latentPeriod: 25, burstSize: 50 },
  freeParameters: ['burstSize'], seed: 1, starts: 1, maxIterations: 10 });
function capture() {
  let value='';
  const stream=new Writable({write(chunk,_encoding,done){value+=chunk.toString();done();}});
  return {stream,value:()=>value};
}
function io(input='') {
  const out=capture(),err=capture();
  return {stdin:Readable.from([Buffer.from(input)]),stdout:out.stream,stderr:err.stream,output:out.value,errors:err.value};
}
const inline: NonNullable<GrowthCommandIO['execute']> = (job,_signal,progress) => executeGrowthJob(job,progress);

describe('growth command', () => {
  it('parses explicit operations and protects replay identity', () => {
    assert.equal(parseGrowthCommand([]),null);
    assert.equal(parseGrowthCommand(['--help']),null);
    assert.deepEqual(parseGrowthCommand(['fit','input.csv','--conditions','conditions.json','--params','params.json','--format','residuals','--output','-']),
      {operation:'fit',input:'input.csv',conditions:'conditions.json',parameters:'params.json',output:undefined,
        format:'residuals',name:undefined,source:undefined,reference:undefined,demo:false});
    assert.throws(()=>parseGrowthCommand(['replay','saved.json','--params','p.json']));
    assert.throws(()=>parseGrowthCommand(['inspect','x.csv','--format','residuals']));
  });

  it('inspects delimited observations with explicit conditions and source attribution', async () => {
    const job: GrowthJob={operation:'inspect',input:{name:'counts.csv',text:csv},conditions,
      source:{name:'Measured series',description:'Local assay batch 4',reference:'Notebook 12',demo:false}};
    const result=await executeGrowthJob(job);
    const dataset=JSON.parse(result.content);
    assert.equal(dataset.name,'Measured series');
    assert.equal(dataset.source.description,'Local assay batch 4');
    assert.equal(dataset.source.reference,'Notebook 12');
    assert.equal(dataset.observations.length,6);
    assert.equal(result.identity,null);
  });

  it('fits and replay-verifies a bounded real-input record using the same core producer', async () => {
    const first=await executeGrowthJob({operation:'fit',input:{name:'counts.csv',text:csv},conditions,parameters:params,
      source:{description:'Private assay',demo:false}});
    const record=await parseAnalysisRecord(first.content);
    assert.equal(record.method.id,'mechanistic-growth-fit');
    assert.equal(record.parameters.seed,1);
    assert.equal(record.inputs[0].source,'local');
    const replay=await executeGrowthJob({operation:'replay',input:{name:'saved.json',text:first.content}});
    assert.equal(replay.verified,true);
    assert.equal(replay.identity,record.resultId);
    assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
    assert.match(replay.residuals!,/time_min,type,observed_value/);
  });

  it('runs the command with stdin conditions/params constraints and emits residuals without private data in progress JSON keys', async () => {
    const dir=await mkdtemp(join(tmpdir(),'phage-growth-'));
    const input=join(dir,'growth.csv'), c=join(dir,'conditions.json'), p=join(dir,'params.json');
    await writeFile(input,csv); await writeFile(c,conditions); await writeFile(p,params);
    const streams=io();
    assert.equal(await runGrowthCommand(['fit',input,'--conditions',c,'--params',p,'--format','residuals'],
      {...streams,execute:inline}),0);
    assert.match(streams.output(),/likelihood_deviance/);
    assert.match(streams.errors(),/"operation":"fit"/);
    assert.ok(!streams.errors().includes('100000'));
  });

  it('canonical dataset JSON cannot be relabeled and existing outputs are never overwritten', async () => {
    const inspected=await executeGrowthJob({operation:'inspect',input:{name:'counts.csv',text:csv},conditions,
      source:{description:'source',demo:false}});
    await assert.rejects(executeGrowthJob({operation:'fit',input:{name:'dataset.json',text:inspected.content},
      source:{description:'changed',demo:false},parameters:params}),/retains embedded source attribution/);

    const dir=await mkdtemp(join(tmpdir(),'phage-growth-output-')), path=join(dir,'existing.json');
    await writeFile(path,'keep');
    const streams=io(csv);
    assert.equal(await runGrowthCommand(['fit','-','--conditions',join(dir,'missing.json'),'--output',path],
      {...streams,execute:inline}),1);
    assert.equal(await readFile(path,'utf8'),'keep');
    assert.equal(streams.output(),'');
  });

  it('an already-cancelled command publishes no result', async () => {
    const controller=new AbortController(); controller.abort();
    const streams=io(csv);
    assert.equal(await runGrowthCommand(['inspect','-','--conditions','conditions.json'],{...streams,signal:controller.signal,execute:inline}),130);
    assert.equal(streams.output(),'');
  });
});
