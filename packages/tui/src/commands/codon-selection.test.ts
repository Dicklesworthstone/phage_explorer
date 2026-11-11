import{describe,it}from'bun:test';import assert from'node:assert/strict';import{parseAnalysisRecord}from'../../../core/src/analysis-result';import{executeCodonSelectionJob,parseCodonSelectionCommand}from'./codon-selection';
const fasta='>ref\nATGGCTGCTGCT\n>syn\nATGGCCGCTGCT\n>nonsyn\nATGGATGCTGCT\n';
const dataset=JSON.stringify({format:'phage-explorer-codon-alignment',version:1,name:'Synthetic codons',source:{kind:'demo',description:'fixture',reference:'fixture',license:'CC0'},
 alignment:{fasta,homologousCodons:true,orientation:'coding-5to3',frame:0,geneticCode:1,method:'manual synthetic alignment',reference:'known synthetic homology'}});
describe('codon-selection command',()=>{
 it('requires explicit coding/homology provenance and prevents canonical relabeling',()=>{
  const p=parseCodonSelectionCommand(['prepare','a.fa','--name','n','--source','s','--reference','r','--license','l','--alignment-method','m','--homology-reference','h','--genetic-code','1','--demo']);
  assert.equal(p?.operation,'prepare');assert.equal(p?.metadata?.geneticCode,1);assert.equal(p?.metadata?.kind,'demo');
  assert.throws(()=>parseCodonSelectionCommand(['analyze','d.json','--source','changed']),/cannot relabel/);
  assert.throws(()=>parseCodonSelectionCommand(['replay','r.json','--params','p.json']),/cannot override|Replay/);
 });
 it('computes conditional pairwise counts without converting dS=0 into a finite ratio',async()=>{
  const first=await executeCodonSelectionJob({operation:'analyze',input:{name:'d.json',text:dataset},params:JSON.stringify({comparison:'reference',referenceId:'ref',startCodon:0,endCodon:4,windowCodons:2,missing:'pairwise'})});
  const record=await parseAnalysisRecord(first.content);assert.equal(record.method.id,'aligned-codon-dnds');
  const result=record.fields.comparisons.value as any;assert.equal(result.pairs.length,2);assert.ok(result.pairs.some((p:any)=>p.overall.omega===null));
  assert.match(first.pairs,/descriptive pairwise estimate, NOT a selection test/);assert.match(first.windows,/start_codon\tend_codon/);
  const replay=await executeCodonSelectionJob({operation:'replay',input:{name:'saved.json',text:first.content}});
  assert.equal(replay.verified,true);assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);
 });
 it('rejects a partial-codon gap instead of silently realigning frames',async()=>{
  const bad=JSON.parse(dataset);bad.alignment.fasta='>a\nATGGC-\n>b\nATGGCT\n';
  await assert.rejects(executeCodonSelectionJob({operation:'analyze',input:{name:'bad.json',text:JSON.stringify(bad)}}),/Partial-codon gap/);
 });
});
