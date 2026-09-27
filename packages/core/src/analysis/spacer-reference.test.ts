import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { validateSpacerLibrary, validateSpacerGenome, parseSpacerLibrary, resolveSpacerOptions, searchSpacerReferences,
  createSpacerRecord, replaySpacerRecord, type SpacerLibrary, type SpacerGenome, type ReferenceSpacer } from './spacer-reference';

const SEQ='ACGATTCGGTACCTAGTGCA';
const rc=(s:string)=>s.split('').reverse().map(c=>({A:'T',C:'G',G:'C',T:'A',N:'N'}[c])).join('');
function library(edits:Partial<ReferenceSpacer>={}):SpacerLibrary {
  return {format:'phage-explorer-spacer-library',version:1,name:'Synthetic reference oracle',source:{kind:'demo',reference:'Hand-constructed matching fixture',version:'1',license:'CC0',scope:'Two synthetic strains only; no biological assay'},
    hosts:[{id:'one',name:'Test host',strain:'strain one',accession:'synthetic:one'},{id:'two',name:'Test host',strain:'strain two',accession:'synthetic:two'}],
    spacers:[{id:'s1',hostId:'one',arrayAccession:'synthetic:array1',sequence:SEQ,system:null,target:'DNA',orientation:'guide-equivalent',pam:null,seed:null,...edits}]};
}
function genome(sequence='TTTT'+SEQ+'AGG',topology:SpacerGenome['topology']='linear'):SpacerGenome {
  return {name:'Synthetic query',accession:'synthetic:query',sequence,topology,source:'local'};
}
const run=(g=genome(),l=library(),maxMismatches=0)=>searchSpacerReferences(g,l,{maxMismatches});
const summarize=(r:ReturnType<typeof run>)=>r.hits.map(h=>[h.start,h.end,h.strand,h.mismatchPositions]);

// Independent oracle enumerates every full target window; it does not use seed blocks or the production reverse complement.
function exhaustive(g:SpacerGenome,query:string,k:number) {
  const results:Array<[number,number,string,number[]]>=[],n=g.sequence.length;
  for(let start=0;start<(g.topology==='circular'?n:Math.max(0,n-query.length+1));start++) {
    const window=Array.from({length:query.length},(_,j)=>g.sequence[(start+j)%n]).join('');
    if(/[^ACGT]/.test(window))continue;
    for(const strand of ['+','-']) {
      const oriented=strand==='+'?window:rc(window),mismatches:number[]=[];
      for(let j=0;j<query.length;j++)if(query[j]!==oriented[j])mismatches.push(j);
      if(mismatches.length<=k)results.push([start,start+query.length,strand,mismatches]);
    }
  }
  return results;
}

describe('sourced spacer DNA evidence',()=>{
  it('finds exact sequence coordinates without inventing a type or PAM',()=>{
    const result=run();assert.deepEqual(summarize(result),[[4,24,'+',[]]]);
    assert.equal(result.hits[0].protospacer,SEQ);assert.equal(result.hits[0].identity,1);
    assert.equal(result.hits[0].pam.status,'not-assessed');assert.equal(result.hits[0].seed.status,'not-assessed');
    assert.equal(result.hosts[0].uniqueLoci,1);assert.equal(result.status,'sequence-matches');
  });
  it('evaluates supplied 3prime PAM on the forward orientation',()=>{
    const result=run(genome(),library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic oriented rule'}}));
    assert.deepEqual(result.hits[0].pam,{status:'matched',sequence:'AGG',segments:[{start:24,end:27}],reason:null});
  });
  it('reverse-complements the opposite flank for a reverse-strand 3prime PAM',()=>{
    const result=run(genome('CCT'+rc(SEQ)+'AAAA'),library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic rule'}}));
    assert.deepEqual(summarize(result),[[3,23,'-',[]]]);assert.equal(result.hits[0].protospacer,SEQ);
    assert.equal(result.hits[0].pam.sequence,'AGG');assert.equal(result.hits[0].pam.status,'matched');
    assert.deepEqual(result.hits[0].pam.segments,[{start:0,end:3}]);
  });
  it('evaluates 5prime PAMs on both orientations without guessing them from system names',()=>{
    const l=library({system:'Caller designation',pam:{side:'5prime',motif:'TTTV',reference:'Synthetic rule'}});
    assert.equal(run(genome('TTTA'+SEQ+'CCC'),l).hits[0].pam.status,'matched');
    const opposite=run(genome('GGG'+rc(SEQ)+'TAAA'),l).hits[0];
    assert.equal(opposite.strand,'-');assert.equal(opposite.pam.sequence,'TTTA');assert.equal(opposite.pam.status,'matched');
    assert.equal(run(genome('TTTT'+SEQ+'CCC'),l).hits[0].pam.status,'mismatched');
  });
  it('does not drop sequence hits that fail a supplied seed or PAM rule',()=>{
    const changed=SEQ.slice(0,2)+'A'+SEQ.slice(3);
    const l=library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic'},seed:{start:0,end:5,maxMismatches:0,reference:'Synthetic'}});
    const h=run(genome('TTTT'+changed+'AAA'),l,1).hits[0];
    assert.deepEqual(h.mismatchPositions,[2]);assert.equal(h.seed.status,'mismatched');assert.equal(h.seed.mismatches,1);
    assert.equal(h.pam.status,'mismatched');assert.equal(h.identity,.95);
  });
  it('uses guide-relative mismatch coordinates on the reverse strand',()=>{
    const changed=SEQ.slice(0,2)+'A'+SEQ.slice(3);
    const h=run(genome('CCT'+rc(changed)+'AAAA'),library({seed:{start:0,end:4,maxMismatches:0,reference:'Synthetic'}}),1).hits[0];
    assert.equal(h.strand,'-');assert.deepEqual(h.mismatchPositions,[2]);assert.equal(h.seed.status,'mismatched');
  });
  it('distinguishes unmeasurable flanks from mismatched flanks',()=>{
    const l=library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic'}});
    assert.equal(run(genome(SEQ),l).hits[0].pam.status,'unavailable');
    const h=run(genome(SEQ+'NGG'),l).hits[0];assert.equal(h.pam.status,'unavailable');assert.match(h.pam.reason!,/ambiguous/);
    assert.equal(run(genome(SEQ+'AGT'),l).hits[0].pam.status,'mismatched');
  });
  it('finds origin-spanning matches only for an explicitly circular genome',()=>{
    const sequence=SEQ.slice(10)+'AGGTTTT'+SEQ.slice(0,10),l=library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic'}});
    const result=run(genome(sequence,'circular'),l);assert.deepEqual(summarize(result),[[17,37,'+',[]]]);
    assert.deepEqual(result.hits[0].segments,[{start:17,end:27},{start:0,end:10}]);assert.equal(result.hits[0].wrapsOrigin,true);
    assert.equal(result.hits[0].pam.sequence,'AGG');assert.equal(result.hits[0].pam.status,'matched');
    assert.equal(run(genome(sequence,'linear'),l).hits.length,0);assert.equal(run(genome(sequence,'unknown'),l).hits.length,0);
  });
  it('wraps reverse-strand contexts and keeps sequence orientation correct',()=>{
    const original='CCT'+rc(SEQ)+'AAAA', rotated=original.slice(13)+original.slice(0,13);
    const result=run(genome(rotated,'circular'),library({pam:{side:'3prime',motif:'NGG',reference:'Synthetic'}}));
    assert.equal(result.hits[0].strand,'-');assert.equal(result.hits[0].protospacer,SEQ);assert.equal(result.hits[0].pam.sequence,'AGG');
    assert.equal(result.hits[0].pam.status,'matched');
  });
  it('does not reuse protospacer bases as PAM when a circle is too short',()=>{
    const h=run(genome(SEQ,'circular'),library({pam:{side:'3prime',motif:'NNN',reference:'Synthetic'}})).hits[0];
    assert.equal(h.pam.status,'unavailable');
  });
  it('preserves both possible guide orientations for a palindromic spacer',()=>{
    const palindrome='ACGTACGTAA'+rc('ACGTACGTAA');
    const result=run(genome(palindrome),library({sequence:palindrome}));
    assert.equal(result.hits.length,2);assert.deepEqual(result.hits.map(h=>h.strand),['+','-']);
  });
  it('counts exact unambiguous coverage for linear and circular inputs',()=>{
    for(const topology of ['linear','circular'] as const){
      const g=genome('A'.repeat(13)+'N'+'C'.repeat(22)+'N'+'G'.repeat(16),topology),result=run(g);
      const starts=topology==='circular'?g.sequence.length:g.sequence.length-SEQ.length+1;
      let known=0;for(let s=0;s<starts;s++)if(Array.from({length:SEQ.length},(_,i)=>g.sequence[(s+i)%g.sequence.length]).every(c=>'ACGT'.includes(c)))known++;
      assert.deepEqual(result.coverage,[{length:20,possibleStarts:starts,unambiguousStarts:known}]);
    }
  });
  it('never treats ambiguous genome or spacer bases as wildcard matches',()=>{
    const unknown=SEQ.slice(0,8)+'N'+SEQ.slice(9),result=run(genome(unknown),library(),5);
    assert.equal(result.hits.length,0);assert.equal(result.status,'no-usable-windows');assert.equal(result.coverage[0].unambiguousStarts,0);
    const reference=run(genome(),library({sequence:unknown}));assert.equal(reference.status,'unsupported-references');assert.match(reference.excluded[0].reason,/ambiguous/);
  });
  it('separates absent host records, unsupported systems and an actual negative sequence comparison',()=>{
    const empty=searchSpacerReferences(genome(),library(),{hostId:'two'});assert.equal(empty.status,'no-spacer-data');assert.equal(empty.hosts[0].searched,0);
    for(const edits of [{target:'RNA' as const},{target:'unknown' as const},{orientation:'unknown' as const},{sequence:'ACGT'}]){
      const excluded=run(genome(),library(edits));assert.equal(excluded.status,'unsupported-references');assert.equal(excluded.searchedRecords,0);
    }
    assert.equal(run(genome('C'.repeat(30))).status,'no-sequence-match');
  });
  it('retains distinct array records for duplicate sequences without inflating unique locus counts',()=>{
    const l=library();l.spacers.push({...l.spacers[0],id:'s2',arrayAccession:'synthetic:array2'});
    const result=run(genome(),l);assert.equal(result.hits.length,2);assert.equal(result.distinctSequences,1);
    assert.equal(result.hosts[0].hitRecords,2);assert.equal(result.hosts[0].uniqueLoci,1);
  });
  it('uses exact host IDs, not shared species names or catalog-host assumptions',()=>{
    const l=library();l.spacers.push({...l.spacers[0],id:'s2',hostId:'two',sequence:'C'.repeat(20)});
    const result=searchSpacerReferences(genome(),l,{hostId:'two'});assert.equal(result.hits.length,0);assert.equal(result.searchedRecords,1);
    assert.deepEqual(result.hosts.map(h=>h.hostId),['two']);assert.throws(()=>searchSpacerReferences(genome(),l,{hostId:'missing'}),/absent/);
  });
  it('agrees with an independent exhaustive matcher across substitutions, strands, origins and ambiguous runs',()=>{
    let seed=13;const random=()=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed/2**32;};
    for(let trial=0;trial<45;trial++){
      const query=Array.from({length:20+trial%17},()=>'ACGT'[Math.floor(random()*4)]).join('');
      const k=trial%6,mutated=query.split('');
      for(let j=0;j<k;j++){const p=Math.floor(j*query.length/(k||1));mutated[p]='ACGT'[('ACGT'.indexOf(mutated[p])+1)%4];}
      const target='NACGT'+(trial%2?rc(mutated.join('')):mutated.join(''))+'TGCAAN'+query;
      const shift=trial%target.length,sequence=target.slice(shift)+target.slice(0,shift);
      for(const topology of ['linear','circular'] as const){const g=genome(sequence,topology);assert.deepEqual(summarize(run(g,library({sequence:query}),k)),exhaustive(g,query,k),`trial ${trial} ${topology}`);}
    }
  });
  it('keeps overlapping occurrences rather than skipping ahead by spacer length',()=>{
    const result=run(genome('A'.repeat(24)),library({sequence:'A'.repeat(20)}));assert.deepEqual(result.hits.map(h=>h.start),[0,1,2,3,4]);
  });
  it('rejects invalid input shapes, duplicates, provenance, rules and unknown options',()=>{
    for(const mutate of [
      (l:SpacerLibrary)=>{l.hosts.push(l.hosts[0]);},(l:SpacerLibrary)=>{l.spacers.push(l.spacers[0]);},
      (l:SpacerLibrary)=>{l.spacers[0].hostId='missing';},(l:SpacerLibrary)=>{l.source.license='';},
      (l:SpacerLibrary)=>{l.spacers[0].seed={start:4,end:2,maxMismatches:0,reference:'test'};},
      (l:SpacerLibrary)=>{l.spacers[0].orientation='unknown';l.spacers[0].pam={side:'3prime',motif:'NGG',reference:'test'};},
      (l:SpacerLibrary)=>{l.spacers[0].sequence='ACGU';},(l:SpacerLibrary)=>{l.spacers[0].pam={side:'3prime',motif:'N-G',reference:'test'};},
    ]){const l=library();mutate(l);assert.throws(()=>validateSpacerLibrary(l));}
    for(const maxMismatches of [-1,6,NaN,Infinity,.5])assert.throws(()=>resolveSpacerOptions({maxMismatches}));
    assert.throws(()=>resolveSpacerOptions({invented:true} as never),/Unsupported/);
    assert.throws(()=>validateSpacerGenome({...genome(),topology:'assumed'}),/topology/);
    assert.throws(()=>parseSpacerLibrary(' '.repeat(2*1024*1024+1)),/limit/);
  });
  it('normalizes DNA case without mutating source records and preserves literal labels',()=>{
    const l=library({sequence:SEQ.toLowerCase()});l.hosts[0].name='<b>host α</b>';
    const parsed=parseSpacerLibrary('\uFEFF'+JSON.stringify(l));assert.equal(parsed.spacers[0].sequence,SEQ);assert.equal(l.spacers[0].sequence,SEQ.toLowerCase());
    assert.equal(parsed.hosts[0].name,'<b>host α</b>');assert.equal(run(genome(),parsed).hits.length,1);
  });
  it('fails explicitly rather than returning a top-hit truncated result',()=>{
    assert.throws(()=>run(genome('A'.repeat(7000)),library({sequence:'A'.repeat(20)})),/budget exceeded/);
  });
  it('binds exact references, oriented rules, genome topology and parameter settings in exports',async()=>{
    const g=genome(),l=library(),result=run(g,l),record=await createSpacerRecord(g,l,result);
    assert.equal(record.fields.matches.kind,'demo');assert.equal(record.inputs[1].source,'demo');
    const restored=await replaySpacerRecord(serializeAnalysisRecord(record),g);assert.deepEqual(restored.result,result);assert.equal(restored.record.resultId,record.resultId);
    l.source.kind='external';const actual=await createSpacerRecord(g,l,run(g,l));assert.equal(actual.fields.matches.kind,'sequence-score');assert.notEqual(actual.resultId,record.resultId);
    l.spacers[0].pam={side:'3prime',motif:'NGG',reference:'Different reference'};assert.notEqual((await createSpacerRecord(g,l,run(g,l))).cacheKey,actual.cacheKey);
  });
  it('rejects a different sequence, topology or identity before accepting saved evidence',async()=>{
    const g=genome(),l=library(),record=await createSpacerRecord(g,l,run(g,l)),content=serializeAnalysisRecord(record);
    for(const changed of [{...g,sequence:g.sequence+'A'},{...g,topology:'circular' as const},{...g,accession:'another'}])await assert.rejects(replaySpacerRecord(content,changed),/Selected genome/);
  });
  it('rejects internally rehashed forged hits and replays even unavailable reference scopes',async()=>{
    const g=genome(),l=library(),record=await createSpacerRecord(g,l,run(g,l));
    const parsed=await parseAnalysisRecord(serializeAnalysisRecord(record));(parsed.fields.matches.value as Array<Record<string,unknown>>)[0].start=999;
    const forged=await createAnalysisRecord({...parsed,inputs:parsed.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(replaySpacerRecord(serializeAnalysisRecord(forged),g),/Fresh spacer evidence/);
    l.spacers=[];const empty=await createSpacerRecord(g,l,run(g,l));assert.equal((await replaySpacerRecord(serializeAnalysisRecord(empty),g)).result.status,'no-spacer-data');
  });
});
