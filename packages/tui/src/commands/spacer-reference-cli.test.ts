import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import {
  executeSpacerHeadlessJob, parseSpacerCommand, runSpacerCommand, runSpacerHeadlessJob,
  type SpacerCommandIO, type SpacerHeadlessJob,
} from './spacer-reference';

const spacer='ACGTACGTACGTACGTACGT';
const genome='>private genome\nTTTT'+spacer+'GGGG\n';
const library=JSON.stringify({
  format:'phage-explorer-spacer-library',version:1,name:'Private reference panel',
  source:{kind:'local',reference:'Lab spacer table',version:'2026-11',license:'private-use',scope:'one host test panel'},
  hosts:[{id:'host-1',name:'Host one',strain:'strain A',accession:'LOCAL-HOST-1'}],
  spacers:[{id:'spacer-1',hostId:'host-1',arrayAccession:'ARRAY-1',sequence:spacer,system:null,
    target:'DNA',orientation:'guide-equivalent',pam:null,seed:null}],
});
function capture(){
  let value=''; const stream=new Writable({write(chunk,_encoding,done){value+=chunk.toString();done();}});
  return {stream,value:()=>value};
}
function io(input=''){
  const out=capture(),err=capture();
  return {stdin:Readable.from([Buffer.from(input)]),stdout:out.stream,stderr:err.stream,output:out.value,errors:err.value};
}
const inline: NonNullable<SpacerCommandIO['execute']> =
  (job,_signal,progress)=>executeSpacerHeadlessJob(job,progress);

describe('headless spacer evidence command',()=>{
  it('parses explicit inspect/analyze/replay contracts and prevents evidence overrides',()=>{
    assert.equal(parseSpacerCommand([]),null);
    assert.equal(parseSpacerCommand(['--help']),null);
    assert.deepEqual(parseSpacerCommand(['analyze','genome.fa','--library','spacers.json','--host','host-1','--mismatches','1','--topology','linear','--format','tsv','--output','-']),
      {operation:'analyze',input:'genome.fa',library:'spacers.json',genome:undefined,hostId:'host-1',maxMismatches:1,
        topology:'linear',topologyExplicit:true,format:'tsv',output:undefined});
    assert.throws(()=>parseSpacerCommand(['analyze','-','--library','-']));
    assert.throws(()=>parseSpacerCommand(['replay','saved.json','--genome','genome.fa','--host','host-1']));
    assert.throws(()=>parseSpacerCommand(['inspect','library.json','--format','tsv']));
  });

  it('inspects the exact supplied library without searching DNA',async()=>{
    const result=await executeSpacerHeadlessJob({operation:'inspect',input:{name:'library.json',text:library},
      maxMismatches:0,topology:'unknown',topologyExplicit:false});
    const parsed=JSON.parse(result.content);
    assert.equal(parsed.name,'Private reference panel');
    assert.equal(parsed.source.reference,'Lab spacer table');
    assert.equal(result.identity,null);
    assert.equal(result.tsv,null);
  });

  it('finds exact DNA evidence and verified replay preserves its complete identity',async()=>{
    const result=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},hostId:'host-1',maxMismatches:0,topology:'linear',topologyExplicit:true});
    const record=await parseAnalysisRecord(result.content);
    assert.equal(record.method.id,'sourced-spacer-dna-search');
    assert.equal(record.inputs[0].source,'local');
    assert.equal(record.inputs[1].source,'local');
    assert.match(result.tsv!,/spacer-1/);
    const savedGenome=record.inputs[0].data as any;
    const replay=await executeSpacerHeadlessJob({operation:'replay',input:{name:'saved.json',text:result.content},
      genome:{name:'genome.json',text:JSON.stringify(savedGenome)},maxMismatches:0,topology:'unknown',topologyExplicit:false});
    assert.equal(replay.verified,true);
    assert.equal(replay.identity,record.resultId);
    assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
  });

  it('replay refuses changed genome bytes or topology',async()=>{
    const result=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},maxMismatches:0,topology:'linear',topologyExplicit:true});
    await assert.rejects(executeSpacerHeadlessJob({operation:'replay',input:{name:'saved.json',text:result.content},
      genome:{name:'changed.fa',text:genome.replace('GGGG','GGGA')},maxMismatches:0,topology:'linear',topologyExplicit:true}),/differs/);
    await assert.rejects(executeSpacerHeadlessJob({operation:'replay',input:{name:'saved.json',text:result.content},
      genome:{name:'same.fa',text:genome},maxMismatches:0,topology:'circular',topologyExplicit:true}),/differs/);
  });

  it('requires an explicit standalone operation and refuses every evidence override',()=>{
    const command=parseSpacerCommand(['replay-standalone','saved.json','--format','tsv']);
    assert.equal(command?.operation,'replay-standalone');
    assert.equal(command?.input,'saved.json');
    assert.equal(command?.genome,undefined);
    assert.equal(command?.format,'tsv');
    assert.throws(()=>parseSpacerCommand(['replay','saved.json']),/requires --genome/);
    for(const [option,value] of [
      ['--genome','genome.fa'],['--library','spacers.json'],['--host','host-1'],
      ['--mismatches','0'],['--topology','unknown'],
    ]) assert.throws(()=>parseSpacerCommand(['replay-standalone','saved.json',option,value]),/overrides/);
  });

  it('reopens a private experiment from its saved inputs alone in both native and inline executors',async()=>{
    const original=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},hostId:'host-1',maxMismatches:1,topology:'circular',topologyExplicit:true});
    const record=await parseAnalysisRecord(original.content);
    const job:SpacerHeadlessJob={operation:'replay-standalone',input:{name:'saved.json',text:original.content},
      maxMismatches:0,topology:'unknown',topologyExplicit:false};
    for(const execute of [executeSpacerHeadlessJob,runSpacerHeadlessJob]){
      const replay=await execute(job),verified=await parseAnalysisRecord(replay.content);
      assert.equal(replay.verified,true);
      assert.equal(replay.identity,record.resultId);
      assert.equal(verified.cacheKey,record.cacheKey);
      assert.deepEqual(verified.inputs,record.inputs);
      assert.deepEqual(verified.parameters,record.parameters);
      assert.deepEqual(verified.references,record.references);
      assert.deepEqual(verified.fields,record.fields);
      assert.equal(replay.tsv,original.tsv);
    }
    for(const override of [
      {genome:{name:'unused.fa',text:genome}},{library:{name:'unused.json',text:library}},
      {hostId:'host-1'},{maxMismatches:1},{topologyExplicit:true},{topology:'linear' as const},
    ]){
      await assert.rejects(executeSpacerHeadlessJob({...job,...override}),/overrides/);
      await assert.rejects(runSpacerHeadlessJob({...job,...override}),/overrides/);
    }
  });

  it('standalone replay recomputes saved evidence and rejects even a rehashed invented hit',async()=>{
    const original=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},maxMismatches:0,topology:'linear',topologyExplicit:true});
    const record=await parseAnalysisRecord(original.content);
    (record.fields.matches.value as Array<Record<string,unknown>>)[0].start=100;
    const forged=await createAnalysisRecord({...record,inputs:record.inputs.map(({sha256:_sha,...input})=>input)});
    const job:SpacerHeadlessJob={operation:'replay-standalone',input:{name:'saved.json',text:serializeAnalysisRecord(forged)},
      maxMismatches:0,topology:'unknown',topologyExplicit:false};
    await assert.rejects(executeSpacerHeadlessJob(job),/Fresh spacer evidence/);
    await assert.rejects(runSpacerHeadlessJob(job),/Fresh spacer evidence/);
  });

  it('standalone command accepts saved JSON on stdin and preserves source labels in TSV',async()=>{
    const original=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},maxMismatches:0,topology:'linear',topologyExplicit:true});
    const streams=io(original.content);
    assert.equal(await runSpacerCommand(['replay-standalone','-','--format','tsv'],{...streams,execute:inline}),0);
    assert.equal(streams.output(),original.tsv);
    assert.match(streams.errors(),/"operation":"replay-standalone"/);
    assert.ok(!streams.errors().includes(spacer));
    const metadata=JSON.parse(streams.output().split('\n')[0].slice(2));
    assert.equal(metadata.genome,'private genome');
    assert.equal(metadata.source.reference,'Lab spacer table');
  });

  it('cancels a standalone native replay without returning unverified output',async()=>{
    const original=await executeSpacerHeadlessJob({operation:'analyze',input:{name:'private.fa',text:genome},
      library:{name:'library.json',text:library},maxMismatches:0,topology:'linear',topologyExplicit:true});
    const job:SpacerHeadlessJob={operation:'replay-standalone',input:{name:'saved.json',text:original.content},
      maxMismatches:0,topology:'unknown',topologyExplicit:false};
    const controller=new AbortController();
    await assert.rejects(runSpacerHeadlessJob(job,controller.signal,()=>controller.abort()),{name:'AbortError'});
    const alreadyCancelled=new AbortController();alreadyCancelled.abort();
    await assert.rejects(runSpacerHeadlessJob(job,alreadyCancelled.signal),{name:'AbortError'});
  });

  it('command emits complete TSV while structured progress contains no private sequence',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'phage-spacer-'));
    const libraryPath=join(dir,'library.json');
    await writeFile(libraryPath,library);
    const streams=io(genome);
    assert.equal(await runSpacerCommand(['analyze','-','--library',libraryPath,'--format','tsv','--topology','linear'],
      {...streams,execute:inline}),0);
    assert.match(streams.output(),/spacer_id\thost_id/);
    assert.match(streams.output(),/spacer-1/);
    assert.match(streams.errors(),/"operation":"analyze"/);
    assert.ok(!streams.errors().includes(spacer));
  });
});
