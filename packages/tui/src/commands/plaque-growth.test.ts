import{describe,it}from'bun:test';
import assert from'node:assert/strict';
import{Readable,Writable}from'node:stream';
import{parseAnalysisRecord}from'../../../core/src/analysis-result';
import{executePlaqueGrowthJob,parsePlaqueGrowthCommand,runPlaqueGrowthCommand,type PlaqueGrowthCommandIO}from'./plaque-growth';

const csv='time_min,plaque_count,dilution_fraction,volume_ml\n0,10,0.001,0.1\n5,11,0.001,0.1\n10,12,0.001,0.1\n15,20,0.001,0.1\n20,70,0.001,0.1\n25,100,0.001,0.1\n30,105,0.001,0.1\n';
function capture(){let value='';const stream=new Writable({write(chunk,_encoding,done){value+=chunk.toString();done();}});return{stream,value:()=>value};}
function io(input=''){const out=capture(),err=capture();return{stdin:Readable.from([Buffer.from(input)]),stdout:out.stream,stderr:err.stream,output:out.value,errors:err.value};}
const inline:NonNullable<PlaqueGrowthCommandIO['execute']>=(job,_signal,progress)=>executePlaqueGrowthJob(job,progress);

describe('raw plaque-count growth command',()=>{
  it('parses exact-count CSV settings and protects replay evidence',()=>{
    assert.equal(parsePlaqueGrowthCommand([]),null);
    assert.deepEqual(parsePlaqueGrowthCommand(['fit','-','--title','Assay','--source','Notebook','--centers','2000','--support-deviance','3.84','--extracellular','--output','-']),
      {operation:'fit',input:'-',output:undefined,format:'json',version:1,title:'Assay',source:'Notebook',centers:2000,
       supportDeviance:3.84,synthetic:false,extracellular:true,draftProvided:true});
    assert.throws(()=>parsePlaqueGrowthCommand(['replay','saved.json','--version','2']));
    assert.throws(()=>parsePlaqueGrowthCommand(['fit','x.csv','--extracellular']));
    assert.throws(()=>parsePlaqueGrowthCommand(['inspect','x.csv','--format','tsv']));
  });

  it('requires extracellular confirmation and preserves original exposure/count CSV',async()=>{
    await assert.rejects(executePlaqueGrowthJob({operation:'inspect',input:{name:'x.csv',text:csv},
      draft:{version:1,title:'Assay',source:'Lab',centers:null,supportDeviance:3.84,synthetic:false,extracellular:false}}),/--extracellular/);
    const result=await executePlaqueGrowthJob({operation:'inspect',input:{name:'x.csv',text:csv},
      draft:{version:1,title:'Assay',source:'Lab',centers:null,supportDeviance:3.84,synthetic:false,extracellular:true}});
    const input=JSON.parse(result.content);
    assert.equal(input.csv,csv);
    assert.equal(input.version,1);
    assert.equal(input.provenance.kind,'user-supplied');
  });

  it('fits Poisson exposure evidence and verified replay preserves identity',async()=>{
    const fit=await executePlaqueGrowthJob({operation:'fit',input:{name:'x.csv',text:csv},
      draft:{version:1,title:'Assay',source:'Lab',centers:2000,supportDeviance:3.84,synthetic:false,extracellular:true}});
    const record=await parseAnalysisRecord(fit.content);
    assert.equal(record.method.id,'plaque-count-growth');
    assert.equal(record.method.version,'1');
    assert.equal(record.inputs[0].source,'local');
    assert.ok((record.fields.fit.value as any).candidates>0);
    assert.match(fit.tsv!,/plaque_count/);
    const replay=await executePlaqueGrowthJob({operation:'replay',input:{name:'saved.json',text:fit.content}});
    assert.equal(replay.verified,true);
    assert.equal(replay.identity,record.resultId);
    assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
  });

  it('supports explicit inclusive count bounds only in version 2',async()=>{
    const bounded='time_min,plaque_count,dilution_fraction,volume_ml,count_status\n0,10,0.001,0.1,exact\n5,11,0.001,0.1,exact\n10,12,0.001,0.1,exact\n15,20,0.001,0.1,exact\n20,70,0.001,0.1,at-least\n25,100,0.001,0.1,at-least\n30,105,0.001,0.1,at-least\n';
    const result=await executePlaqueGrowthJob({operation:'fit',input:{name:'bounds.csv',text:bounded},
      draft:{version:2,title:'Bounded assay',source:'Lab',centers:null,supportDeviance:3.84,synthetic:false,extracellular:true}});
    const record=await parseAnalysisRecord(result.content);
    assert.equal(record.method.version,'2');
    const fitted=record.fields.fit.value as any;
    assert.equal(fitted.countCoverage.atLeast,3);
    assert.equal(fitted.totalPlaques,null);
    assert.match(result.tsv!,/count_status/);
  });

  it('command fits stdin data and progress never contains private counts',async()=>{
    const streams=io(csv);
    assert.equal(await runPlaqueGrowthCommand(['fit','-','--title','Assay','--source','Private plate batch','--extracellular','--format','tsv'],
      {...streams,execute:inline}),0);
    assert.match(streams.output(),/time_min\tplaque_count/);
    assert.match(streams.errors(),/"operation":"fit"/);
    assert.ok(!streams.errors().includes('105'));
  });
});
