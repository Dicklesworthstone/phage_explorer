import{describe,it}from'bun:test';import assert from'node:assert/strict';import{parseAnalysisRecord}from'../../../core/src/analysis-result';import{executeMosaicJob,parseMosaicCommand}from'./mosaic';
const dataset=JSON.stringify({format:'phage-explorer-mosaic-dataset',version:1,name:'Synthetic mosaic',
 query:{id:'query',label:'query',accession:null,sequence:'A'.repeat(300)+'C'.repeat(300),source:'demo',sourceDescription:'fixture',sourceReference:null,sourceLicense:'CC0',sourceLength:600,sourceStart:0},
 references:[
  {id:'a',label:'Aref',accession:null,sequence:'A'.repeat(600),source:'demo',sourceDescription:'fixture',sourceReference:null,sourceLicense:'CC0',sourceLength:600,sourceStart:0},
  {id:'c',label:'Cref',accession:null,sequence:'C'.repeat(600),source:'demo',sourceDescription:'fixture',sourceReference:null,sourceLicense:'CC0',sourceLength:600,sourceStart:0}
 ],excludedReferences:[]});
describe('mosaic command',()=>{
 it('parses provenance-bound preparation and prevents canonical relabeling',()=>{
  const p=parseMosaicCommand(['prepare','q.fa','--references','refs.fa','--name','n','--query-source','query lab','--reference-source','panel lab','--demo']);
  assert.equal(p?.operation,'prepare');assert.equal(p?.metadata?.kind,'demo');
  assert.throws(()=>parseMosaicCommand(['analyze','d.json','--query-source','changed']),/cannot override/);
  assert.throws(()=>parseMosaicCommand(['replay','r.json','--params','p.json']),/cannot override|Replay/);
 });
 it('detects a supported reference switch and verified replay preserves identity',async()=>{
  const first=await executeMosaicJob({operation:'analyze',input:{name:'d.json',text:dataset},params:JSON.stringify({k:5,window:200,step:100,minSimilarity:.05,maxReferences:30,topN:2})});
  const record=await parseAnalysisRecord(first.content);assert.equal(record.method.id,'canonical-kmer-mosaic');
  const result=record.fields.mosaic.value as any;assert.ok(result.referenceSwitches.length>=1);
  assert.match(first.switches,/from_reference\tto_reference/);
  const replay=await executeMosaicJob({operation:'replay',input:{name:'saved.json',text:first.content}});
  assert.equal(replay.verified,true);assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
 });
 it('retains evidence gaps instead of inventing donor assignments',async()=>{
  const gap=JSON.parse(dataset);gap.query.sequence='N'.repeat(600);
  const result=await executeMosaicJob({operation:'analyze',input:{name:'gap.json',text:JSON.stringify(gap)}});
  const record=await parseAnalysisRecord(result.content);const value=record.fields.mosaic.value as any;
  assert.equal(value.windows.every((w:any)=>w.status==='no-evidence'),true);assert.equal(value.referenceSwitches.length,0);
 });
});
