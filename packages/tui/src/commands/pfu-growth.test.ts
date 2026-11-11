import { describe,it } from 'bun:test';
import assert from 'node:assert/strict';
import { Readable,Writable } from 'node:stream';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import { executePfuGrowthJob,parsePfuGrowthCommand,runPfuGrowthCommand,type PfuGrowthCommandIO } from './pfu-growth';

const csv='time_min,pfu_per_ml\n0,10000\n5,10000\n10,11000\n15,20000\n20,90000\n25,110000\n30,110000\n';
function capture(){let value='';const stream=new Writable({write(chunk,_encoding,done){value+=chunk.toString();done();}});return{stream,value:()=>value};}
function io(input=''){const out=capture(),err=capture();return{stdin:Readable.from([Buffer.from(input)]),stdout:out.stream,stderr:err.stream,output:out.value,errors:err.value};}
const inline:NonNullable<PfuGrowthCommandIO['execute']>=(job,_signal,progress)=>executePfuGrowthJob(job,progress);

describe('corrected-PFU growth command',()=>{
  it('parses explicit CSV confirmation/options and protects replay identity',()=>{
    assert.equal(parsePfuGrowthCommand([]),null);
    assert.deepEqual(parsePfuGrowthCommand(['fit','-','--title','Assay 1','--source','Lab notebook','--centers','2000','--bootstrap','0','--seed','7','--extracellular','--output','-']),
      {operation:'fit',input:'-',output:undefined,format:'json',title:'Assay 1',source:'Lab notebook',centers:2000,bootstrap:0,seed:7,synthetic:false,extracellular:true,draftProvided:true});
    assert.throws(()=>parsePfuGrowthCommand(['replay','saved.json','--seed','7']));
    assert.throws(()=>parsePfuGrowthCommand(['inspect','x.csv','--format','tsv']));
    assert.throws(()=>parsePfuGrowthCommand(['fit','experiment.json','--bootstrap','100']));
    assert.throws(()=>parsePfuGrowthCommand(['fit','x.csv','--extracellular']));
  });

  it('requires explicit extracellular confirmation for CSV and preserves observed values',async()=>{
    await assert.rejects(executePfuGrowthJob({operation:'inspect',input:{name:'x.csv',text:csv},
      draft:{title:'Assay',source:'Lab',centers:null,bootstrap:0,seed:1,synthetic:false,extracellular:false}}),/--extracellular/);
    const result=await executePfuGrowthJob({operation:'inspect',input:{name:'x.csv',text:csv},
      draft:{title:'Assay',source:'Lab',centers:2000,bootstrap:0,seed:1,synthetic:false,extracellular:true}});
    const experiment=JSON.parse(result.content);
    assert.equal(experiment.observations[0].pfuPerMl,10000);
    assert.equal(experiment.options.infectedCentersPerMl,2000);
    assert.equal(experiment.provenance.kind,'user-supplied');
  });

  it('fits and verified replay preserves exact evidence identity',async()=>{
    const fit=await executePfuGrowthJob({operation:'fit',input:{name:'x.csv',text:csv},
      draft:{title:'Assay',source:'Lab',centers:2000,bootstrap:0,seed:1,synthetic:false,extracellular:true}});
    const record=await parseAnalysisRecord(fit.content);
    assert.equal(record.method.id,'extracellular-pfu-growth');
    assert.equal(record.inputs[0].source,'local');
    assert.equal(record.parameters.infectedCentersPerMl,2000);
    assert.ok((record.fields.infectiousYieldPerInfectedCenter.value as number)>0);
    assert.match(fit.tsv!,/observed_pfu_per_ml/);
    const replay=await executePfuGrowthJob({operation:'replay',input:{name:'saved.json',text:fit.content}});
    assert.equal(replay.verified,true);
    assert.equal(replay.identity,record.resultId);
    assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
    assert.equal(replay.tsv,fit.tsv);
  });

  it('canonical experiment JSON cannot be relabeled by CSV flags',async()=>{
    const inspected=await executePfuGrowthJob({operation:'inspect',input:{name:'x.csv',text:csv},
      draft:{title:'Assay',source:'Lab',centers:null,bootstrap:0,seed:1,synthetic:false,extracellular:true}});
    await assert.rejects(executePfuGrowthJob({operation:'fit',input:{name:'experiment.json',text:inspected.content},
      draft:{title:'Changed',source:'Changed',centers:null,bootstrap:0,seed:1,synthetic:false,extracellular:true}}),/retains embedded provenance/);
  });

  it('command fits stdin CSV and emits content-free progress',async()=>{
    const streams=io(csv);
    assert.equal(await runPfuGrowthCommand(['fit','-','--title','Assay','--source','Private batch','--bootstrap','0','--extracellular','--format','tsv'],
      {...streams,execute:inline}),0);
    assert.match(streams.output(),/time_min\tobserved_pfu_per_ml/);
    assert.match(streams.errors(),/"operation":"fit"/);
    assert.ok(!streams.errors().includes('110000'));
  });
});
