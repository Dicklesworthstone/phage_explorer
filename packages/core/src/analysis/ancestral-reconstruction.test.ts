import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { ancestralConsensus, ancestralFasta, createAncestralRecord, parseAncestralFasta,
  reconstructAncestors, replayAncestralRecord, resolveAncestralOptions, validateAncestralDataset,
  type AncestralDataset, type AncestralResult } from './ancestral-reconstruction';

// At this branch length the JC69 transition is 1/2 on the diagonal, 1/6 otherwise.
const length = 0.75 * Math.log(3);
export function ancestralFixture(fasta = '>a\nAAC\n>b\nACC\n>c\nGCC\n'): AncestralDataset {
  return { format:'phage-explorer-ancestral',version:1,name:'Independent finite-state example',
    source:{kind:'demo',description:'Synthetic likelihood test, not a biological reference',reference:'Enumerate every state; transition weights 3 or 1 over six',license:'Test fixture'},
    tree:{newick:`((a:${length},b:${length})I:${length},c:${length})Root;`,units:'substitutions/site',method:'Prespecified test topology',rooting:'Known root in synthetic construction'},
    alignment:{fasta,homologous:true,method:'Explicit aligned columns',reference:'Hand-constructed homologous sites'} };
}
function two(a:string,b:string,t=length):AncestralDataset {
  const data=ancestralFixture(`>a\n${a}\n>b\n${b}\n`);data.tree.newick=`(a:${t},b:${t})Root;`;return data;
}
function close(a:number,b:number,eps=1e-12):void {assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);}
function normalized(result:AncestralResult):void {
  for(const pattern of result.patterns){
    if(!pattern.nodes||!pattern.edges)continue;
    pattern.nodes.forEach(p=>{close(p.reduce((s,v)=>s+v,0),1);p.forEach(v=>assert.ok(v>=0&&v<=1));});
    pattern.edges.forEach((edge,index)=>{
      close(edge.reduce((s,v)=>s+v,0),1);const parent=result.nodes[index+1].parent!;
      for(let s=0;s<4;s++){
        close(edge.slice(s*4,s*4+4).reduce((x,y)=>x+y,0),pattern.nodes![parent][s]);
        close([0,1,2,3].reduce((sum,p)=>sum+edge[p*4+s],0),pattern.nodes![index+1][s]);
      }
    });
  }
}
/** Independent exhaustive integer-weight oracle; no pruning, floating matrix or production parser.
 * Node order Root,I,a,b,c. There are 4^5 complete assignments; inconsistent leaf
 * observations get zero weight. Each of the four edges contributes integer 3 or 1.
 */
function enumerate(observed:string[]):{likelihood:number;nodes:number[][];edges:number[][]}{
  const allowed:Record<string,string>={A:'A',C:'C',G:'G',T:'T',R:'AG',Y:'CT',N:'ACGT','?':'ACGT','-':'ACGT'};
  const bases='ACGT', parents=[0,1,1,0], children=[1,2,3,4];
  const nodes=Array.from({length:5},()=>[0,0,0,0]),edges=Array.from({length:4},()=>new Array(16).fill(0));let total=0;
  for(let code=0;code<1024;code++){
    let n=code;const states=Array.from({length:5},()=>{const s=n%4;n=Math.floor(n/4);return s;});
    if([2,3,4].some((leaf,i)=>!allowed[observed[i]].includes(bases[states[leaf]])))continue;
    let weight=1;for(let e=0;e<4;e++)weight*=states[parents[e]]===states[children[e]]?3:1;
    total+=weight;states.forEach((s,i)=>nodes[i][s]+=weight);
    parents.forEach((p,i)=>edges[i][states[p]*4+states[children[i]]]+=weight);
  }
  return {likelihood:total/(4*6**4),nodes:nodes.map(row=>row.map(v=>v/total)),edges:edges.map(row=>row.map(v=>v/total))};
}

describe('explicit aligned-tree input',()=>{
  it('requires homology provenance, substitutions/site units and a supported schema',()=>{
    for(const mutate of [
      (d:any)=>d.alignment.homologous=false,(d:any)=>d.alignment.reference='',
      (d:any)=>d.tree.units='years',(d:any)=>d.tree.rooting='',
      (d:any)=>d.source.license='',(d:any)=>d.extra=true,
    ]){const d=ancestralFixture();mutate(d);assert.throws(()=>validateAncestralDataset(d));}
  });
  it('joins whole exact IDs, irrespective of FASTA ordering, with literal quoted labels',()=>{
    const d=two('A','C');d.tree.newick=`('a_one':${length},'literal <img>':${length});`;
    d.alignment.fasta='>literal <img>\nC\n>a_one\nA\n';
    const r=reconstructAncestors(d);assert.deepEqual(r.tipOrder,['a_one','literal <img>']);
    close(r.patterns[0].nodes![0][0],3/8);
    d.tree.newick=d.tree.newick.replace("'a_one'",'a_one');assert.throws(()=>reconstructAncestors(d),/match every tree tip/);
  });
  it('rejects duplicates, missing tips and extra rows instead of silently pruning',()=>{
    for(const fasta of ['>a\nA\n>a\nC\n','>a\nA\n>x\nC\n','>a\nA\n>b\nC\n>x\nG\n']){
      const d=two('A','A');d.alignment.fasta=fasta;assert.throws(()=>reconstructAncestors(d));
    }
  });
  it('accepts lowercase formatting and IUPAC, but rejects unaligned, empty, protein and RNA input',()=>{
    assert.deepEqual(parseAncestralFasta('\uFEFF>a\r\n a c R ? -\r\n>b\r\nACTGN\r\n'),[{id:'a',sequence:'ACR?-'},{id:'b',sequence:'ACTGN'}]);
    for(const fasta of ['ACGT','>a\nA\n>b\nAA','>a\n\n>b\n','>a\nU\n>b\nA','>a\nX\n>b\nA'])assert.throws(()=>parseAncestralFasta(fasta));
  });
  it('rejects absent/negative branch lengths, unrooted markers and extra trees',()=>{
    for(const tree of ['(a,b:1);','(a:-1,b:1);','[&U](a:1,b:1);','(a:1,b:1);(a:1,b:1);']){
      const d=two('A','A');d.tree.newick=tree;assert.throws(()=>validateAncestralDataset(d));
    }
  });
  it('bounds input allocations, windows and supported settings',()=>{
    assert.throws(()=>parseAncestralFasta('x'.repeat(2*1024*1024+1)),/limit/);
    assert.throws(()=>parseAncestralFasta(Array.from({length:129},(_,i)=>`>x${i}\nA`).join('\n')),/128/);
    for(const settings of [{startColumn:0},{endColumn:4},{minPosterior:NaN},{minPosterior:1.1},{gapPolicy:'fifth-state'},{unexpected:true}])assert.throws(()=>resolveAncestralOptions(3,settings));
    assert.throws(()=>resolveAncestralOptions(5000,{endColumn:5000}),/4096/);
    assert.equal(resolveAncestralOptions(5000).endColumn,4096);
  });
});

describe('likelihood and conditional state reconstruction',()=>{
  it('matches hand-derived two-tip likelihood and marginal probabilities',()=>{
    const r=reconstructAncestors(two('A','A'));
    close(Math.exp(r.logLikelihood!),1/12);
    const p=r.patterns[0].nodes![0];close(p[0],3/4);p.slice(1).forEach(v=>close(v,1/12));
    normalized(r);
  });
  it('does not confuse marginal maxima with a resolved sequence when states tie',()=>{
    const r=reconstructAncestors(two('A','C'),{minPosterior:0.25});
    assert.deepEqual(ancestralConsensus(r,'n0'),'N');
    const p=r.patterns[0].nodes![0];[3/8,3/8,1/8,1/8].forEach((v,i)=>close(p[i],v));
  });
  it('matches exhaustive integer enumeration at every node and edge for diverse observations',()=>{
    const states=['A','C','G','T','R','Y','N','?','-'];
    for(let i=0;i<36;i++){
      const obs=[states[i%9],states[(i*2+1)%9],states[(i*5+3)%9]];
      const d=ancestralFixture(`>a\n${obs[0]}\n>b\n${obs[1]}\n>c\n${obs[2]}`);
      const actual=reconstructAncestors(d),expected=enumerate(obs),p=actual.patterns[0];
      if(obs.every(base=>'N?-'.includes(base))){
        close(expected.likelihood,1); assert.equal(actual.sites[0].exclusion,'all-missing');
        assert.equal(actual.patterns.length,0); assert.equal(actual.logLikelihood,null); continue;
      }
      close(Math.exp(p.logLikelihood!),expected.likelihood);
      expected.nodes.forEach((row,n)=>row.forEach((v,s)=>close(p.nodes![n][s],v)));
      expected.edges.forEach((row,n)=>row.forEach((v,s)=>close(p.edges![n][s],v)));
      normalized(actual);
    }
  });
  it('uses evidence outside a clade to reconstruct its ancestor',()=>{
    const r=reconstructAncestors(ancestralFixture('>a\nN\n>b\nN\n>c\nA'));
    // c -> Root -> I spans two transitions: exp(-4*(2t)/3)=1/9.
    close(r.patterns[0].nodes![1][0],1/3);
    r.patterns[0].nodes![1].slice(1).forEach(v=>close(v,2/9));
  });
  it('uses joint edge probabilities rather than products of separate marginals',()=>{
    const r=reconstructAncestors(two('N','A')),p=r.patterns[0],edge=p.edges![0];
    close(edge.reduce((sum,v,i)=>sum+(Math.floor(i/4)!==i%4?v:0),0),0.5);
    const independent=1-p.nodes![0].reduce((sum,v,s)=>sum+v*p.nodes![1][s],0);
    assert.ok(Math.abs(independent-0.5)>0.1);normalized(r);
  });
  it('treats IUPAC as allowed-state observations, not uniformly weighted data',()=>{
    const r=reconstructAncestors(two('R','A')); const a=reconstructAncestors(two('A','A')),g=reconstructAncestors(two('G','A'));
    close(Math.exp(r.logLikelihood!),Math.exp(a.logLikelihood!)+Math.exp(g.logLikelihood!));
    const leaf=r.patterns[0].nodes![1];close(leaf[1],0);close(leaf[3],0);assert.ok(leaf[0]>leaf[2]);
    assert.equal(r.sites[0].ambiguousTips,1);
  });
  it('retains exact zero edges and reports incompatible observations without invented probabilities',()=>{
    const same=reconstructAncestors(two('A','A',0));close(same.logLikelihood!,-Math.log(4));
    assert.deepEqual(same.patterns[0].nodes![0],[1,0,0,0]);normalized(same);
    const different=reconstructAncestors(two('AC','AA',0));
    assert.equal(different.impossibleColumns,1);assert.equal(different.analyzedColumns,1);assert.equal(different.logLikelihood,null);
    assert.equal(different.sites[1].exclusion,'zero-likelihood');assert.equal(different.patterns[1].nodes,null);
    assert.equal(ancestralConsensus(different,'n0'),'AN');
  });
  it('preserves tiny positive transitions instead of rounding them to zero',()=>{
    const r=reconstructAncestors(two('A','C',1e-18));
    assert.ok(Number.isFinite(r.logLikelihood));assert.equal(r.impossibleColumns,0);normalized(r);
  });
  it('preserves uninformative and excluded columns with original coordinates',()=>{
    const r=reconstructAncestors(two('AN-A','CN?A'),{startColumn:2,endColumn:4,gapPolicy:'exclude-column',minPosterior:0.7});
    assert.deepEqual(r.sites.map(s=>[s.column,s.exclusion]),[[2,'all-missing'],[3,'gap'],[4,null]]);
    assert.equal(r.analyzedColumns,1);assert.equal(r.excludedColumns,2);assert.equal(ancestralConsensus(r,'n0'),'NNA');
    const all=reconstructAncestors(two('N?-','-NN'));assert.equal(all.logLikelihood,null);assert.equal(all.patterns.length,0);
  });
  it('changes gap treatment only through the accepted option and does not invent indels',()=>{
    const missing=reconstructAncestors(two('-A','AA'),{minPosterior:0.4});
    assert.equal(missing.analyzedColumns,2);close(missing.patterns[0].nodes![0][0],0.5);
    const excluded=reconstructAncestors(two('-A','AA'),{gapPolicy:'exclude-column'});
    assert.equal(excluded.analyzedColumns,1);assert.equal(excluded.sites[0].pattern,null);
  });
  it('compresses repeated patterns without losing likelihood multiplicity or site identity',()=>{
    const r=reconstructAncestors(two('A'.repeat(1000),'A'.repeat(1000)));
    assert.equal(r.patterns.length,1);assert.equal(r.sites.length,1000);close(r.logLikelihood!,-1000*Math.log(12),1e-9);
  });
  it('stays finite on a 128-tip likelihood that underflows in probability space',()=>{
    const d=ancestralFixture();d.tree.newick='('+Array.from({length:128},(_,i)=>`x${i}:0.000001`).join(',')+');';
    d.alignment.fasta=Array.from({length:128},(_,i)=>`>x${i}\n${'ACGT'[i%4]}`).join('\n');
    const r=reconstructAncestors(d);assert.ok(r.logLikelihood! < -745);assert.equal(Math.exp(r.logLikelihood!),0);normalized(r);
    r.patterns[0].nodes![0].forEach(v=>close(v,0.25,1e-10));
  });
  it('refuses excessive posterior output rather than truncating a run',()=>{
    const d=ancestralFixture(); d.tree.newick='('+Array.from({length:64},(_,i)=>`x${i}:1`).join(',')+');';
    d.alignment.fasta=Array.from({length:64},(_,i)=>`>x${i}\n`+Array.from({length:300},(_,j)=>'ACGT'[Math.floor(j/4**(i%5))%4]).join('')).join('\n');
    assert.throws(()=>reconstructAncestors(d),/pattern\/node budget/);
  });
  it('applies the recorded threshold and uses safe internal node IDs in FASTA',()=>{
    const r=reconstructAncestors(two('AA','AA'),{minPosterior:0.7});assert.equal(ancestralConsensus(r,'n0'),'AA');
    assert.match(ancestralFasta(r),/>n0 conditional-JC69 columns=1-2 threshold=0.7\nAA/);
    assert.equal(ancestralConsensus(reconstructAncestors(two('A','A'),{minPosterior:0.8}),'n0'),'N');
    assert.throws(()=>ancestralConsensus(r,'not-a-node'),/Unknown/);
  });
});

describe('portable conditional ancestral evidence',()=>{
  it('recomputes the complete original record and keeps source snapshots isolated',async()=>{
    const d=ancestralFixture(),r=reconstructAncestors(d),creating=createAncestralRecord(d,r);
    d.alignment.fasta='changed';r.patterns[0].nodes![0][0]=99;
    const record=await creating,replay=await replayAncestralRecord(serializeAnalysisRecord(record));
    assert.equal(replay.record.resultId,record.resultId);assert.notEqual(replay.result.patterns[0].nodes![0][0],99);
    assert.equal(record.fields.reconstruction.kind,'demo');
  });
  it('rejects rehashed invented output, changed method and incompatible input contracts',async()=>{
    const d=ancestralFixture(),record=await createAncestralRecord(d,reconstructAncestors(d));
    for(const change of [
      (r:any)=>r.fields.reconstruction.value.patterns[0].nodes[0][0]=0.123,
      (r:any)=>r.method.version='999',
      (r:any)=>r.inputs[0].id='other',
      (r:any)=>r.parameters.startColumn=2,
    ]){
      const changed=structuredClone(record);change(changed);
      const forged=await createAnalysisRecord({...changed,inputs:changed.inputs.map(({sha256:_sha,...input})=>input)});
      await assert.rejects(replayAncestralRecord(serializeAnalysisRecord(forged)));
    }
  });
  it('binds original input and evidence, not just a reconstructed consensus',async()=>{
    const d=two('A','A');const a=await createAncestralRecord(d,reconstructAncestors(d));
    d.source.reference='Another source with identical bases';const b=await createAncestralRecord(d,reconstructAncestors(d));
    assert.notEqual(a.cacheKey,b.cacheKey);assert.notEqual(a.resultId,b.resultId);
    const altered=JSON.parse(serializeAnalysisRecord(a));altered.inputs[0].data.alignment.fasta='>a\nA\n>b\nC';
    await assert.rejects(parseAnalysisRecord(JSON.stringify(altered)),/checksum/);
  });
});
