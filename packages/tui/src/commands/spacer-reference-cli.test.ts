import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnalysisRecord } from '../../../core/src/analysis-result';
import {
  executeSpacerHeadlessJob, parseSpacerCommand, runSpacerCommand, type SpacerCommandIO,
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
