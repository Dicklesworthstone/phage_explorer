import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { CodonSelectionSession } from './CodonSelectionSession';
import type { CodonAlignmentInput } from '../../../core/src/analysis/codon-selection';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
const fixture = (): CodonAlignmentInput => ({ format:'phage-explorer-codon-alignment',version:1,name:'Native worker fixture',
  source:{kind:'demo',description:'Ten codons, one synonymous and one nonsynonymous difference',reference:'Hand-derived',license:'CC0'},
  alignment:{fasta:'>a\n'+'GCT'.repeat(10)+'\n>b\nGCCGAT'+'GCT'.repeat(8),homologousCodons:true,orientation:'coding-5to3',frame:0,geneticCode:11,method:'By construction',reference:'Analytic fixture'} });
it('executes actual codon workers and replays their accepted numerical result',async()=>{
  const session=new CodonSelectionSession(()=>new Worker(new URL('./codon-selection.worker.ts',import.meta.url),{type:'module'}));session.activate();
  try{
    await session.run({kind:'analyze',input:fixture(),options:{windowCodons:2}});const accepted=session.getSnapshot().accepted;
    assert.equal(session.getSnapshot().error,null);assert.ok(accepted?.result);assert.ok(accepted.record);
    assert.ok(Math.abs(accepted.result.pairs[0].overall.synonymousSites-29/3)<1e-12);
    await session.run({kind:'import',content:serializeAnalysisRecord(accepted.record)});
    assert.equal(session.getSnapshot().error,null);assert.equal(session.getSnapshot().accepted?.verified,true);
    assert.deepEqual(session.getSnapshot().accepted?.result,accepted.result);
  }finally{session.deactivate();}
});
it('terminates a real multi-pair coding worker after numerical work begins',async()=>{
  const input=fixture();input.alignment.fasta=Array.from({length:16},(_,i)=>`>sample${i}\n${'GCTGCCGAT'.repeat(3000)}`).join('\n');
  const session=new CodonSelectionSession(()=>new Worker(new URL('./codon-selection.worker.ts',import.meta.url),{type:'module'}));session.activate();
  let started=false;const unsub=session.subscribe(()=>{if(session.getSnapshot().phase.endsWith('alignment codon 1025')){started=true;session.cancel();}});
  try{
    await session.run({kind:'analyze',input,options:{comparison:'all-pairs',windowCodons:1000}});
    assert.ok(started);assert.equal(session.getSnapshot().busy,false);assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().error,null);
  }finally{unsub();session.deactivate();}
});
