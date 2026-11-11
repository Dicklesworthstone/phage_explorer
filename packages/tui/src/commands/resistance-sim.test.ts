import{describe,it}from'bun:test';import assert from'node:assert/strict';import{Readable,Writable}from'node:stream';
import{parseAnalysisRecord}from'../../../core/src/analysis-result';import{runResistanceSimCommand}from'./resistance-sim';
function cap(){let v='';const stream=new Writable({write(c,_e,d){v+=c.toString();d();}});return{stream,value:()=>v};}
function io(input=''){const o=cap(),e=cap();return{stdin:Readable.from([Buffer.from(input)]),stdout:o.stream,stderr:e.stream,output:o.value,errors:e.value};}
describe('resistance-sim command',()=>{
 it('runs a seeded portable simulation and replays it exactly',async()=>{
  const first=io();assert.equal(await runResistanceSimCommand(['run','--seed','9','--cocktail-size','2'],first),0);
  const record=await parseAnalysisRecord(first.output());assert.equal(record.seed,9);assert.equal(record.inputs[0].source,'demo');
  const replay=io(first.output());assert.equal(await runResistanceSimCommand(['replay','-'],replay),0);
  assert.equal((await parseAnalysisRecord(replay.output())).resultId,record.resultId);
 });
 it('emits TSV with explicit illustrative provenance',async()=>{
  const streams=io();assert.equal(await runResistanceSimCommand(['run','--seed','3','--format','tsv'],streams),0);
  assert.match(streams.output(),/Illustrative stochastic model only/);assert.match(streams.output(),/time_hours\tsensitive/);
 });
 it('rejects out-of-range parameters instead of clipping',async()=>{
  const streams=io();assert.equal(await runResistanceSimCommand(['run','--cocktail-size','0'],streams),1);
  assert.match(streams.errors(),/outside|integer/);assert.equal(streams.output(),'');
 });
});
