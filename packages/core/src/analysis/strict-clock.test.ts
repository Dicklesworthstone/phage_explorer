import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { analyzeTemporalSignal, parseTemporalNewick, temporalTreeTips, type TemporalDataset } from './temporal-signal';
import { fitDatedTree, resolveDatingOptions, createDatedTreeRecord, replayDatedTreeRecord, exportDatedNewick, type DatedTreeResult } from './strict-clock';

export function datingFixture(): TemporalDataset {
  // Independent construction: rate .01, R=1990, X=1998, Y=2001;
  // A/B/C/D are 2000/2002/2004/2006. Each branch = rate * elapsed years.
  return {format:'phage-explorer-temporal-signal',version:1,name:'Analytical chronology',
    source:{kind:'local',description:'Hand-derived synthetic reference',reference:null,license:'CC0'},
    tree:{newick:'((A:.02,B:.04)X:.08,(C:.03,D:.05)Y:.11)R;',units:'substitutions/site',inferredWithoutDates:true,
      method:'Analytical fixture',rooting:'Known fixture root',alignmentProvenance:'Synthetic branch lengths, not a measured alignment'},
    samples:['A','B','C','D'].map((id,i)=>({id,accession:null,collectionDate:2000+2*i,dateSource:'Exact synthetic year',permutationGroup:null}))};
}
const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
function chronological(result: DatedTreeResult) {
  assert.equal(result.status,'fitted',result.reason??undefined);
  const byId = new Map(result.nodes.map(n=>[n.id,n]));
  for(const node of result.nodes) {
    if(node.parentId)assert.ok(node.date>=byId.get(node.parentId)!.date);
    if(node.dateRange)assert.ok(node.date>=node.dateRange.lower-1e-8&&node.date<=node.dateRange.upper+1e-8);
    close(node.fittedLength,result.rate*node.duration,1e-12);
  }
  assert.equal(result.certificate.converged,true);
  assert.ok(result.certificate.primalViolation<=1e-10);
  assert.ok(result.certificate.stationarity<=1e-10);
}

describe('constrained fixed-root strict-clock dating',()=>{
  it('recovers the independent internal chronology, rate and all exact tip dates',()=>{
    const result=fitDatedTree(datingFixture()); chronological(result);
    close(result.rate,.01,1e-12); close(result.rootDate!,1990);
    assert.deepEqual(Object.fromEntries(result.nodes.map(n=>[n.label,n.date])),{R:1990,X:1998,A:2000,B:2002,Y:2001,C:2004,D:2006});
    assert.ok(result.sumSquaredResiduals<1e-24);
    assert.equal(result.clockValidated,false);assert.equal(result.uncertainty,'not-estimated');
  });
  it('jointly refits a chronology constraint, rather than clipping a negative branch',()=>{
    const data=datingFixture(); data.tree.newick='(A:.001,B:.001,C:.02,D:.04)R;';
    const result=fitDatedTree(data); chronological(result);
    // At the optimum the root is constrained to A's date. Holding that root,
    // r=(2*.001+4*.02+6*.04)/(2^2+4^2+6^2)=.00575, SSE=.0001505.
    close(result.rate,.00575,1e-10);close(result.rootDate!,2000,1e-8);
    close(result.sumSquaredResiduals,.0001505,1e-11);
    assert.equal(result.zeroDurationBranches,1);
    assert.ok(result.certificate.iterations>0);
  });
  it('fits uncertain tips inside supplied bounds, not at fabricated midpoints',()=>{
    const data=datingFixture();data.samples[1].collectionDate={lower:2001,upper:2005};
    const result=fitDatedTree(data);chronological(result);
    close(result.nodes.find(n=>n.label==='B')!.date,2002);
    assert.notEqual(result.nodes.find(n=>n.label==='B')!.date,2003);
    close(result.rate,.01,1e-12);assert.equal(result.intervalTips,1);
    assert.deepEqual(result.nodes.find(n=>n.label==='B')!.dateRange,{lower:2001,upper:2005});
  });
  it('enforces active uncertain-date bounds while refitting the other dates',()=>{
    const data=datingFixture();data.samples[1].collectionDate={lower:2003,upper:2004};
    const result=fitDatedTree(data);chronological(result);
    close(result.nodes.find(n=>n.label==='B')!.date,2003,1e-7);
    assert.equal(result.nodes.find(n=>n.label==='B')!.atDateBound,true);
    assert.ok(result.sumSquaredResiduals>0);
  });
  it('uses calendar precision as an interval in dating, while diagnostics still exclude it',()=>{
    const data=datingFixture();data.samples[1].collectionDate='2002';
    const result=fitDatedTree(data);chronological(result);
    close(result.nodes.find(n=>n.label==='B')!.date,2002,1e-7);
    assert.equal(result.intervalTips,1);
    assert.match(analyzeTemporalSignal(data).tips[1].exclusion!,/Uncertain/);
  });
  it('supports a sourced external rate for same-date tips, without pretending to estimate it',()=>{
    const data=datingFixture();data.tree.newick='(A:.10,B:.12,C:.08,D:.10)R;';
    data.samples.forEach(s=>{s.collectionDate=2000;});
    assert.throws(()=>fitDatedTree(data),/two different exact/);
    const result=fitDatedTree(data,{rateMode:'fixed',fixedRate:.01,rateSource:'Synthetic external rate, not inferred'});
    chronological(result);close(result.rootDate!,1990);close(result.sumSquaredResiduals,.0008);
    assert.equal(result.options.rateMode,'fixed');assert.ok(result.warnings.some(w=>w.includes('supplied, not inferred')));
  });
  it('withholds dates when the inferred rate hits either search bound',()=>{
    for(const options of [{minimumRate:.02},{maximumRate:.005}]) {
      const result=fitDatedTree(datingFixture(),options);
      assert.equal(result.status,'rate-boundary');assert.equal(result.rootDate,null);assert.deepEqual(result.nodes,[]);
      assert.throws(()=>exportDatedNewick(result),/certified/);
    }
  });
  it('does not convert anti-temporal lengths into a positive dated history',()=>{
    const data=datingFixture();data.tree.newick='(A:.04,B:.03,C:.02,D:.01)R;';
    const result=fitDatedTree(data);
    assert.equal(result.status,'rate-boundary');assert.equal(result.rootDate,null);
    assert.equal(result.clockValidated,false);
  });
  it('reports uncompleted optimization instead of publishing an uncertified dated tree',()=>{
    const data=datingFixture();data.tree.newick='((A:.001,B:.001)X:.001,(C:.1,D:.5)Y:.001)R;';
    const result=fitDatedTree(data,{maxIterations:1});
    assert.equal(result.status,'unresolved');assert.equal(result.certificate.converged,false);
    assert.equal(result.rootDate,null);assert.deepEqual(result.nodes,[]);
  });
  it('rejects missing dates, absent tip metadata, interval-only and zero-length data',()=>{
    for(const change of [
      (d:TemporalDataset)=>{d.samples.pop();},
      (d:TemporalDataset)=>{d.samples[0].collectionDate=null;},
      (d:TemporalDataset)=>{d.samples.forEach(s=>{s.collectionDate='2000';});},
      (d:TemporalDataset)=>{d.tree.newick='(A:0,B:0,C:0,D:0);';},
    ]){const data=datingFixture();change(data);assert.throws(()=>fitDatedTree(data));}
  });
  it('requires positive rates, bounded work, explicit units and supported options',()=>{
    for(const options of [null,[],{rateMode:'relaxed'},{minimumRate:0},{maximumRate:Infinity},{minimumRate:2,maximumRate:1},
      {fixedRate:.01},{rateMode:'fixed',fixedRate:.01},{rateMode:'fixed',fixedRate:-1,rateSource:'none'},
      {rateMode:'fixed',fixedRate:.01,rateSource:'\x1b[31m'}, {maxIterations:0},{maxIterations:20001},{excludedSamples:['A']}]) {
      assert.throws(()=>resolveDatingOptions(options as never));
    }
    const data=datingFixture();data.tree.units='years' as never;assert.throws(()=>fitDatedTree(data),/substitutions/);
  });
  it('does not silently prune or exceed the bounded dense problem size',()=>{
    const data=datingFixture();data.tree.newick=`(${Array.from({length:129},(_,i)=>`S${i}:1`).join(',')});`;
    data.samples=Array.from({length:129},(_,i)=>({id:`S${i}`,accession:null,collectionDate:2000+i/100,dateSource:'Synthetic',permutationGroup:null}));
    assert.throws(()=>fitDatedTree(data),/128 tips/);
  });
  it('retains topology and dates through child order and metadata order changes',()=>{
    const data=datingFixture(),expected=fitDatedTree(data);
    data.samples.reverse();data.tree.newick='((D:.05,C:.03)Y:.11,(B:.04,A:.02)X:.08)R;';
    const result=fitDatedTree(data);chronological(result);
    for(const node of expected.nodes)close(result.nodes.find(n=>n.label===node.label)!.date,node.date);
    close(result.rate,expected.rate,1e-12);
  });
  it('rescales substitution units without changing the recovered calendar chronology',()=>{
    const data=datingFixture();data.tree.newick='((A:2e-8,B:4e-8)X:8e-8,(C:3e-8,D:5e-8)Y:11e-8)R;';
    const result=fitDatedTree(data);chronological(result);
    close(result.rate,1e-8,1e-18);close(result.rootDate!,1990);
  });
  it('does not mutate original inputs or let an earlier returned tree affect a later fit',()=>{
    const data=datingFixture(),before=structuredClone(data),first=fitDatedTree(data),expected=structuredClone(first);
    first.nodes[0].date=1234;
    assert.deepEqual(data,before);assert.deepEqual(fitDatedTree(data),expected);
  });
  it('agrees with an independent SciPy constrained optimum with two active chronological edges',()=>{
    const data=datingFixture();data.tree.newick='((A:.001,B:.001)X:.001,(C:.1,D:.5)Y:.001)R;';
    const result=fitDatedTree(data);chronological(result);
    // Independent SLSQP on variables (rate-scaled R,X,Y ages from 2006,rate):
    // optimum (.372,.372,.365,.062), objective .053273. Both R->X and X->A
    // are active. Enforcing them only after an unconstrained fit is incorrect.
    close(result.rate,.062,2e-9);close(result.sumSquaredResiduals,.053273,1e-9);
    close(result.rootDate!,2000);close(result.nodes.find(n=>n.label==='X')!.date,2000);
    close(result.nodes.find(n=>n.label==='Y')!.date,2000.1129032258063,1e-6);
  });
  it('agrees with independent noisy branch and active interval-date optima',()=>{
    const data=datingFixture();data.tree.newick='((A:.021,B:.041)X:.078,(C:.032,D:.049)Y:.109)R;';
    let result=fitDatedTree(data);chronological(result);
    close(result.rate,.00975,1e-10);close(result.rootDate!,1989.743589796673,1e-6);
    close(result.sumSquaredResiduals,.000004,1e-12);
    const interval=datingFixture();interval.samples[1].collectionDate={lower:2003,upper:2004};
    result=fitDatedTree(interval);chronological(result);
    close(result.rate,.00913385850418887,1e-9);close(result.rootDate!,1989.0172418406191,1e-6);
    close(result.sumSquaredResiduals,.0000503937007874084,1e-12);
  });
  it('exports time units, node mapping, labels and tip path durations without fabricating branch support',()=>{
    const data=datingFixture();data.tree.newick=data.tree.newick.replace('A:',"'O''Brien_λ':");data.samples[0].id="O'Brien_λ";
    const result=fitDatedTree(data),newick=exportDatedNewick(result);
    assert.match(newick,/branch_units=years/);assert.match(newick,/clock_validated=false/);assert.match(newick,/'O''Brien_λ'/);
    const tree=parseTemporalNewick(newick),tips=temporalTreeTips(tree);
    assert.deepEqual(tips.map(t=>t.distance),[10,12,14,16]);
    assert.equal(tree.label,'R');
  });
});

describe('portable dated-tree evidence',()=>{
  it('round trips exact inputs, constraints, branch residuals and the complete numerical certificate',async()=>{
    const dataset=datingFixture(),dating=fitDatedTree(dataset),record=await createDatedTreeRecord(dataset,dating);
    assert.equal(record.fields.dating.kind,'fitted-estimate');
    const replay=await replayDatedTreeRecord(serializeAnalysisRecord(record));
    assert.equal(replay.datingRecord.resultId,record.resultId);assert.deepEqual(replay.dating,dating);
    assert.deepEqual(replay.dataset,dataset);
  });
  it('keeps synthetic evidence and unresolved optimization explicitly labeled',async()=>{
    const dataset=datingFixture();dataset.source.kind='demo';
    let record=await createDatedTreeRecord(dataset,fitDatedTree(dataset));assert.equal(record.fields.dating.kind,'demo');
    dataset.tree.newick='((A:.001,B:.001)X:.001,(C:.1,D:.5)Y:.001)R;';
    record=await createDatedTreeRecord(dataset,fitDatedTree(dataset,{maxIterations:1}));
    const replay=await replayDatedTreeRecord(serializeAnalysisRecord(record));
    assert.equal(replay.dating.status,'unresolved');assert.deepEqual(replay.dating.nodes,[]);
  });
  it('rejects forged node dates even when the saved checksums are internally valid',async()=>{
    const data=datingFixture(),record=await createDatedTreeRecord(data,fitDatedTree(data));
    const forged=await parseAnalysisRecord(serializeAnalysisRecord(record));
    (forged.fields.dating.value as unknown as DatedTreeResult).nodes[0].date=1980;
    const signed=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(replayDatedTreeRecord(serializeAnalysisRecord(signed)),/Fresh strict-clock dating differs/);
  });
  it('rejects unsupported versions and unknown fit settings, including internally rehashed ones',async()=>{
    const data=datingFixture(),record=await createDatedTreeRecord(data,fitDatedTree(data));
    const changed=structuredClone(record);changed.method.version='999';
    const signed=await createAnalysisRecord({...changed,inputs:changed.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(replayDatedTreeRecord(serializeAnalysisRecord(signed)),/incompatible/);
    changed.method.version='1';changed.parameters.arbitraryScript='do not execute';
    const invalid=await createAnalysisRecord({...changed,inputs:changed.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(replayDatedTreeRecord(serializeAnalysisRecord(invalid)),/Unsupported/);
  });
});
