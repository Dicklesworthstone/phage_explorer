import{describe,it}from'bun:test';import assert from'node:assert/strict';import{Readable,Writable}from'node:stream';
import{parseAnalysisRecord}from'../../../core/src/analysis-result';import{runAncestralCommand,parseAncestralCommand,executeAncestralJob,type AncestralIO}from'./ancestral';
import { createAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { createAlignedPhylogenyExperiment } from '../../../core/src/analysis/aligned-phylogeny';
import { rootAlignedPhylogenyExperiment, createRootedAncestralExperiment } from '../../../core/src/analysis/phylogeny-rooting';
import { ancestralFasta } from '../../../core/src/analysis/ancestral-reconstruction';
const fasta='>A\nAAAA\n>B\nAAGA\n>C\nAGGA\n';const tree='((A:0.01,B:0.01):0.01,C:0.02);';
function cap(){let v='';const stream=new Writable({write(c,_e,d){v+=c.toString();d();}});return{stream,value:()=>v};}
function io(input=''){const o=cap(),e=cap();return{stdin:Readable.from([Buffer.from(input)]),stdout:o.stream,stderr:e.stream,output:o.value,errors:e.value};}
const inline:NonNullable<AncestralIO['execute']>=(job,_signal,progress)=>executeAncestralJob(job,progress);
const dataset=JSON.stringify({format:'phage-explorer-ancestral',version:1,name:'Synthetic tree',
 source:{kind:'demo',description:'Synthetic fixture',reference:'fixture',license:'CC0'},
 tree:{newick:tree,units:'substitutions/site',method:'synthetic rooted tree',rooting:'synthetic explicit root'},
 alignment:{fasta,homologous:true,method:'manual alignment',reference:'synthetic homology'}});
describe('ancestral command',()=>{
 it('parses provenance-bound prepare and prevents canonical relabeling',()=>{
  const parsed=parseAncestralCommand(['prepare','a.fa','--tree','t.nwk','--name','n','--source','s','--reference','r','--license','l',
   '--tree-method','tm','--rooting','root','--alignment-method','am','--alignment-reference','ar','--demo']);
  assert.equal(parsed?.operation,'prepare');assert.equal(parsed?.metadata?.kind,'demo');
  assert.throws(()=>parseAncestralCommand(['analyze','d.json','--source','changed']),/cannot override/);
  assert.throws(()=>parseAncestralCommand(['replay','r.json','--params','p.json']),/cannot override|Replay/);
 });
 it('analyzes exact fixed inputs and verified replay preserves identity',async()=>{
  const first=await executeAncestralJob({operation:'analyze',input:{name:'d.json',text:dataset},params:JSON.stringify({startColumn:1,endColumn:4,minPosterior:.7,gapPolicy:'missing'})});
  const record=await parseAnalysisRecord(first.content);assert.match(record.method.id,/ancestral/);assert.equal(record.inputs[0].source,'demo');
  assert.match(first.fasta,/conditional-JC69/);
  const replay=await executeAncestralJob({operation:'replay',input:{name:'saved.json',text:first.content}});
  assert.equal(replay.verified,true);assert.equal((await parseAnalysisRecord(replay.content)).resultId,record.resultId);assert.equal(replay.fasta,first.fasta);
 });
 it('command emits conditional FASTA while progress contains no alignment sequence',async()=>{
  const streams=io(dataset);
  const params='{"startColumn":1,"endColumn":4,"gapPolicy":"missing","minPosterior":0.7}';
  const pio=io(params);
  // Use dataset on stdin and inject parameters through a virtual file-independent executor contract.
  const executor:NonNullable<AncestralIO['execute']>=async(job,_signal,progress)=>executeAncestralJob({...job,params},progress);
  assert.equal(await runAncestralCommand(['analyze','-','--format','fasta'],{...streams,execute:executor}),0);
  assert.match(streams.output(),/>n0 conditional-JC69/);assert.ok(!streams.errors().includes('AAAA'));
  void pio;
 });
});

it('standalone ancestral replay uses its real worker and retains the verified phylogeny lineage', async () => {
  const alignment = ['A', 'B', 'C', 'D'].map((id, i) => `>${id} original description\n${'A'.repeat(i * 5)}${'G'.repeat(i + 1)}${'A'.repeat(100 - i * 5 - i - 1)}`).join('\n');
  const original = await createAlignedPhylogenyExperiment({ name: 'Synthetic linked ancestry', kind: 'demo',
    reference: 'Explicit synthetic aligned columns', fasta: alignment }, { distance: 'k80' });
  const rooted = await rootAlignedPhylogenyExperiment(serializeAnalysisRecord(original.record), { outgroup: ['A'],
    fractionFromOutgroup: .25, evidence: 'Synthetic explicit root hypothesis', dateIndependent: true });
  const expected = await createRootedAncestralExperiment(serializeAnalysisRecord(rooted.record), 'CC0 synthetic fixture', { endColumn: 20 });
  const content = serializeAnalysisRecord(expected.record);
  const streams = io('\uFEFF' + content);
  assert.equal(await runAncestralCommand(['replay', '-'], streams), 0, streams.errors());
  assert.deepEqual(JSON.parse(streams.output()), expected.record);
  assert.deepEqual(JSON.parse(streams.output()).inputs[1].data, rooted.record);
  const fastaStreams = io(content);
  assert.equal(await runAncestralCommand(['replay', '-', '--format', 'fasta'], fastaStreams), 0, fastaStreams.errors());
  assert.equal(fastaStreams.output(), ancestralFasta(expected.result));
  assert.ok(!streams.errors().includes(alignment));
  const changed = structuredClone(expected.record);
  (changed.fields.reconstruction.value as { logLikelihood: number }).logLikelihood += 1;
  const forged = serializeAnalysisRecord(await createAnalysisRecord(changed));
  await parseAnalysisRecord(forged);
  const rejected = io(forged);
  assert.equal(await runAncestralCommand(['replay', '-', '--format', 'fasta'], rejected), 1);
  assert.equal(rejected.output(), ''); assert.match(rejected.errors(), /differs/);
});
