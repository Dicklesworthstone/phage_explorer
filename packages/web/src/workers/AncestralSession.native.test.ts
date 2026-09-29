import { it } from 'bun:test';
import assert from 'node:assert/strict';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import type { AncestralDataset } from '../../../core/src/analysis/ancestral-reconstruction';
import { AncestralSession } from './AncestralSession';

const dataset=():AncestralDataset=>({format:'phage-explorer-ancestral',version:1,name:'Native worker fixture',
  source:{kind:'demo',description:'Synthetic likelihood oracle',reference:'Pii=1/2 at t=3/4 log3',license:'Test fixture'},
  tree:{newick:`(a:${.75*Math.log(3)},b:${.75*Math.log(3)});`,units:'substitutions/site',method:'Prespecified',rooting:'Prespecified'},
  alignment:{fasta:'>a\nA\n>b\nA',homologous:true,method:'Explicit alignment',reference:'Independent same-base two-tip likelihood'}});
it('native worker computes and freshly replays the full ancestral record',async()=>{
  const session=new AncestralSession(()=>new Worker(new URL('./ancestral.worker.ts',import.meta.url),{type:'module'}));session.activate();
  try{
    await session.run({kind:'analyze',input:dataset(),options:{minPosterior:.7}});
    const first=session.getSnapshot().accepted;assert.ok(first?.result&&first.record,session.getSnapshot().error??'No result');
    assert.ok(Math.abs(first.result.patterns[0].nodes![0][0]-.75)<1e-12);
    await session.run({kind:'import',content:serializeAnalysisRecord(first.record)});
    assert.equal(session.getSnapshot().accepted!.verified,true);assert.equal(session.getSnapshot().accepted!.record!.resultId,first.record.resultId);
  }finally{session.deactivate();}
},15000);
it('native cancellation interrupts a started reconstruction without accepting partial posteriors',async()=>{
  const session=new AncestralSession(()=>new Worker(new URL('./ancestral.worker.ts',import.meta.url),{type:'module'}));session.activate();
  let started=false;const stop=session.subscribe(()=>{if(session.getSnapshot().phase.startsWith('Reconstructing')){started=true;session.cancel();}});
  const data=dataset();data.tree.newick='('+Array.from({length:128},(_,i)=>`x${i}:.01`).join(',')+');';
  data.alignment.fasta=Array.from({length:128},(_,i)=>`>x${i}\n`+Array.from({length:2048},(_,j)=>'ACGT'[Math.floor(j/4**(i%6))%4]).join('')).join('\n');
  try{
    await session.run({kind:'analyze',input:data,options:{}});assert.equal(started,true);
    assert.equal(session.getSnapshot().busy,false);assert.equal(session.getSnapshot().accepted,null);assert.equal(session.getSnapshot().error,null);
  }finally{stop();session.deactivate();}
},15000);
