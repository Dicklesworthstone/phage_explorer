import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { analyzeTemporalSignal, collectionDateRange, createTemporalRecord, parseTemporalNewick,
  parseTemporalSampleTable, replayTemporalRecord, resolveTemporalOptions, temporalTreeTips, validateTemporalDataset,
  type TemporalDataset } from './temporal-signal';

function fixture(): TemporalDataset {
  return { format: 'phage-explorer-temporal-signal', version: 1, name: 'Hand-constructed rooted cohort',
    source: { kind: 'local', description: 'User-provided toy data for mathematical verification, not experimental observations', reference: null, license: 'CC0 synthetic test fixture' },
    tree: { newick: '((A:.01,B:.02):.01,(C:.03,D:.04):.01);', units: 'substitutions/site', inferredWithoutDates: true,
      method: 'Hand-constructed test phylogram', rooting: 'Fixed root supplied before date comparison', alignmentProvenance: 'Analytical branch-length fixture; no sequence homology claim' },
    samples: ['A','B','C','D'].map((id,i) => ({ id, accession: `TEST${i}`, collectionDate: 2000+i, dateSource: 'Explicit test decimal year', permutationGroup: i<2?'one':'two' })) };
}
const close = (actual: number, expected: number, epsilon = 1e-12) => assert.ok(Math.abs(actual-expected) <= epsilon, `${actual} != ${expected}`);
async function changedRecord(content: string, edit: (record: Awaited<ReturnType<typeof parseAnalysisRecord>>) => void) {
  const record = await parseAnalysisRecord(content); edit(record);
  return serializeAnalysisRecord(await createAnalysisRecord({ ...record, inputs: record.inputs.map(({sha256:_sha,...input})=>input) }));
}

describe('explicit rooted phylogram input', () => {
  it('sums paths through internal branches instead of mistaking terminal edges for root distances', () => {
    assert.deepEqual(temporalTreeTips(parseTemporalNewick('((A:0.1,B:0.2):0.3,C:0.9);')), [
      {id:'A',distance:0.4},{id:'B',distance:0.5},{id:'C',distance:0.9}]);
  });
  it('handles quoted Unicode, commas, doubled quotes, comments and scientific notation', () => {
    const tips = temporalTreeTips(parseTemporalNewick("[&R]('α_sample':1e-2,'O''Brien, β':[nested [note]]2e-2,ordinary_name:.03):0;"));
    assert.deepEqual(tips, [{id:'α_sample',distance:.01},{id:"O'Brien, β",distance:.02},{id:'ordinary name',distance:.03}]);
  });
  it('rejects missing branch lengths, multiple trees, unrooted declarations and root stems', () => {
    for (const value of ['(A:.1,B);','(A:.1,B:.2)','(A:.1,B:.2);(C:.1,D:.2);','[&U](A:.1,B:.2);','(A:.1,B:.2):.01;']) {
      assert.throws(()=>parseTemporalNewick(value),/length|semicolon|one Newick|unrooted|root stem/);
    }
  });
  it('rejects duplicate/empty tips, invalid numbers, malformed comments and quoted labels', () => {
    for (const value of ['(A:.1,A:.2);','(:.1,B:.2);','(A:NaN,B:.2);','(A:-.1,B:.2);','(A:1e99,B:.2);',"('bad:.1,B:.2);",'(A:.1,B:.2)[bad;','(A:.1);']) {
      assert.throws(()=>parseTemporalNewick(value));
    }
  });
  it('bounds tree size and nesting before computation', () => {
    assert.throws(()=>parseTemporalNewick('('.repeat(66)+'A:.1'+',B:.1):.1'.repeat(66)+';'),/depth/);
    assert.throws(()=>parseTemporalNewick('('+Array.from({length:501},(_,i)=>`s${i}:.1`).join(',')+');'),/500/);
    assert.throws(()=>parseTemporalNewick(' '.repeat(2*1024*1024+1)),/2 MiB/);
  });
  it('requires method, source, units and date-independent rooting evidence', () => {
    const data=fixture();
    assert.throws(()=>validateTemporalDataset({...data,tree:{...data.tree,inferredWithoutDates:false}}),/without using these dates/);
    assert.throws(()=>validateTemporalDataset({...data,tree:{...data.tree,units:'years'}}),/substitutions/);
    assert.throws(()=>validateTemporalDataset({...data,tree:{...data.tree,alignmentProvenance:''}}),/provenance/);
    assert.throws(()=>validateTemporalDataset({...data,source:{...data.source,license:''}}),/license/);
    assert.throws(()=>validateTemporalDataset({...data,unknown:true}),/Unsupported/);
  });
  it('matches samples by exact tip ID, not table order, and rejects duplicate/unknown IDs', () => {
    const data=fixture();data.samples.reverse();
    close(analyzeTemporalSignal(data).regression!.slope,.01);
    assert.throws(()=>validateTemporalDataset({...data,samples:[...data.samples,data.samples[0]]}),/unique/);
    assert.throws(()=>validateTemporalDataset({...data,samples:[{...data.samples[0],id:'UNKNOWN'}]}),/match tree tips/);
    assert.throws(()=>validateTemporalDataset({...data,tree:{...data.tree,newick:'(A_one:.1,B:.1);'},samples:[{...data.samples[0],id:'A_one'}]}),/underscores/);
  });
  it('snapshots input without aliasing date intervals and arrays', () => {
    const data=fixture();data.samples[0].collectionDate={lower:2000,upper:2001};
    const validated=validateTemporalDataset(data);
    data.samples[0].collectionDate.lower=1990;data.samples.reverse();
    assert.deepEqual(validated.samples[0].collectionDate,{lower:2000,upper:2001});
  });
});

describe('collection dates and sample tables', () => {
  it('uses Gregorian leap years and rejects impossible or ambiguous calendar strings', () => {
    close(collectionDateRange('2020-07-02')!.lower,2020.5); // 183 of 366 days
    close(collectionDateRange('2021-01-01')!.lower,2021);
    for (const bad of ['2021-02-29','2020-02-30','2020-13-01','2020-00-01','2020-01-00','02/03/2020','2020-1-1','2020-01-01T00:00:00Z']) assert.throws(()=>collectionDateRange(bad),/date/);
  });
  it('preserves year/month/interval uncertainty without inventing precise dates', () => {
    assert.deepEqual(collectionDateRange('2020'),{lower:2020,upper:2021});
    assert.deepEqual(collectionDateRange('2020-12'),{lower:2020+335/366,upper:2021});
    assert.deepEqual(collectionDateRange(2020.5),{lower:2020.5,upper:2020.5});
    assert.equal(collectionDateRange(null),null);
    assert.throws(()=>collectionDateRange({lower:2001,upper:2000}),/interval/);
    assert.throws(()=>collectionDateRange(NaN),/year/);
  });
  it('parses keyed CSV/TSV dates, quoted source text and optional accession/groups', () => {
    const parsed=parseTemporalSampleTable('sampleId,collectionDate,dateSource,accession,permutationGroup\r\nA,2000.0,"Archive, field record",ACC_A,g1\r\nB,2001,year only,,g2\r\nC,,missing,,\r\n');
    assert.equal(parsed[0].collectionDate,2000);assert.equal(parsed[0].dateSource,'Archive, field record');
    assert.equal(parsed[1].collectionDate,'2001');assert.equal(parsed[2].collectionDate,null);
    assert.equal(parseTemporalSampleTable('dateSource\tsampleId\tcollectionDate\narchive\tD\t2003-01-01')[0].id,'D');
  });
  it('rejects submission-date headers, silent extra columns, malformed quotes and invalid dates', () => {
    for (const table of ['sampleId,submissionDate,dateSource\nA,2000,x','sampleId,collectionDate,dateSource\nA,2000,x,extra',
      'sampleId,collectionDate,dateSource\nA,2020-02-30,x','sampleId,collectionDate,dateSource\nA,2000,"oops',
      'sampleId,collectionDate,dateSource\nA,2000,"x" trailing']) assert.throws(()=>parseTemporalSampleTable(table));
  });
  it('reports uncertain, missing and explicitly excluded samples separately', () => {
    const data=fixture();data.samples[0].collectionDate='2000';data.samples[1].collectionDate=null;data.samples.pop();
    const result=analyzeTemporalSignal(data,{excludedSamples:['C']});
    assert.deepEqual(result.tips.map(t=>t.exclusion),['Uncertain collection date; not replaced by a midpoint','Missing collection date','Explicit user exclusion','Missing sample metadata']);
    assert.equal(result.regression,null);assert.match(result.unavailableReason!,/four tips/);
    assert.throws(()=>analyzeTemporalSignal(data,{excludedSamples:['unseen']}),/does not exist/);
  });
});

describe('fixed-root temporal diagnostics', () => {
  it('matches hand-derived slope, x-intercept, leverage and exact one-sided randomization', () => {
    const result=analyzeTemporalSignal(fixture());
    const fit=result.regression!;
    close(fit.slope,.01);close(fit.r,1);close(fit.r2,1);close(fit.xIntercept!,1998);
    close(fit.sumSquaredResiduals,0);close(fit.residuals[0].leverage,.7);close(fit.residuals[1].leverage,.3);
    close(fit.residuals[1].leverage,.3);
    fit.residuals.forEach(row=>{close(row.residual,0);close(row.leaveOneOutSlope!,.01);});
    assert.deepEqual(result.randomization,{mode:'exact',draws:24,extreme:1,tailFraction:1/24,groups:1});
    assert.equal(result.clockCalibrated,false);
  });
  it('matches an independent scalar covariance/permutation oracle for an imperfect cohort', () => {
    const data=fixture();data.tree.newick='(A:.02,B:.05,C:.03,D:.06);';
    const r=analyzeTemporalSignal(data).regression!;
    // x centered = [-1.5,-.5,.5,1.5], y centered = [-.02,.01,-.01,.02].
    close(r.slope,.05/5);close(r.r,.05/Math.sqrt(5*.001));close(r.r2,.5);
    close(r.sumSquaredResiduals,.0005);
    assert.deepEqual(r.residuals.map(row=>Number(row.predicted.toFixed(6))),[.025,.035,.045,.055]);
    // Enumerate all 24 permutations independently using four distinct index loops.
    const x=[0,1,2,3],y=[.02,.05,.03,.06];let extreme=0;
    for(const a of x)for(const b of x)for(const c of x)for(const d of x){
      if(new Set([a,b,c,d]).size!==4)continue;
      const sum=[a,b,c,d].reduce((total,value,i)=>total+(value-1.5)*(y[i]-.04),0);
      if(sum>=.05-1e-12)extreme++;
    }
    close(analyzeTemporalSignal(data).randomization!.tailFraction,extreme/24);
  });
  it('does not call an anticlockwise temporal pattern evidence of positive accumulation', () => {
    const data=fixture();data.samples.forEach((s,i)=>{s.collectionDate=2003-i;});
    const result=analyzeTemporalSignal(data);close(result.regression!.slope,-.01);
    assert.equal(result.regression!.xIntercept,null);assert.equal(result.randomization!.tailFraction,1);
    assert.ok(result.warnings.some(w=>w.includes('nonpositive')));
  });
  it('reports same-date, ultrametric and insufficient cohorts as unavailable, never neutral or calibrated', () => {
    const data=fixture();data.samples.forEach(s=>{s.collectionDate=2000;});
    assert.match(analyzeTemporalSignal(data).unavailableReason!,/dates do not vary/);
    const ultrametric=fixture();ultrametric.tree.newick='((A:.1,B:.1):.1,(C:.1,D:.1):.1);';
    const result=analyzeTemporalSignal(ultrametric);assert.equal(result.regression,null);assert.match(result.unavailableReason!,/ultrametric/);
    assert.equal(result.randomization,null);assert.equal(result.clockCalibrated,false);
  });
  it('enumerates only within-block permutations and distinguishes no within-block variation', () => {
    const data=fixture(),result=analyzeTemporalSignal(data,{permutationScheme:'within-groups'});
    assert.deepEqual(result.randomization,{mode:'exact',draws:4,extreme:1,tailFraction:.25,groups:2});
    data.samples.forEach((s,i)=>{s.permutationGroup=String(i);});
    const locked=analyzeTemporalSignal(data,{permutationScheme:'within-groups'});
    assert.ok(locked.regression);assert.equal(locked.randomization,null);assert.match(locked.randomizationUnavailableReason!,/No collection-date variation/);
    data.samples[0].permutationGroup=null;
    assert.throws(()=>analyzeTemporalSignal(data,{permutationScheme:'within-groups'}),/every retained/);
  });
  it('uses seeded Monte Carlo with the plus-one correction and preserves the actual fit', () => {
    const data=fixture();
    const a=analyzeTemporalSignal(data,{permutations:19,seed:0}),b=analyzeTemporalSignal(data,{permutations:19,seed:0});
    assert.deepEqual(a,b);assert.equal(a.randomization!.mode,'monte-carlo');
    close(a.randomization!.tailFraction,(a.randomization!.extreme+1)/20);assert.ok(a.randomization!.tailFraction>0);
    assert.deepEqual(a.regression,analyzeTemporalSignal(data,{permutations:99,seed:12}).regression);
  });
  it('exposes leverage and leave-one-out slope changes rather than dropping influential samples', () => {
    const data=fixture();data.tree.newick='(A:.02,B:.03,C:.04,D:.30);';
    const result=analyzeTemporalSignal(data);
    assert.equal(result.tips.filter(t=>!t.exclusion).length,4);
    close(result.regression!.residuals[3].leaveOneOutSlope!,.01);
    assert.ok(result.regression!.leaveOneOutSlopeRange![1]>.08);
  });
  it('bounds parameters and rejects unknown controls instead of silently defaulting them', () => {
    for(const options of [{permutations:18},{permutations:10000},{seed:-1},{seed:1.5},{permutationScheme:'shuffle'},{excludedSamples:['A','A']},{unexpected:1},null]) {
      assert.throws(()=>resolveTemporalOptions(options as never));
    }
  });
});

describe('portable temporal evidence', () => {
  it('round-trips input, method, sample coverage, diagnostics and reference identities by recomputation', async () => {
    const data=fixture(),result=analyzeTemporalSignal(data),record=await createTemporalRecord(data,result);
    const replay=await replayTemporalRecord(serializeAnalysisRecord(record));
    assert.deepEqual(replay.result,result);assert.equal(replay.record.resultId,record.resultId);
    assert.equal(record.fields.regression.kind,'fitted-estimate');
    assert.equal(record.fields.regression.units,'records');
    assert.deepEqual(record.fields.regression.coverage,{available:4,total:4,unit:'records'});
    assert.match(record.fields.regression.limitations.join(' '),/non-independent/);
  });
  it('exports unavailable diagnostics with reasons and keeps explicit examples separate from measurements', async () => {
    const data=fixture();data.samples.forEach(s=>{s.collectionDate='2000';});
    const record=await createTemporalRecord(data,analyzeTemporalSignal(data));
    assert.equal(record.fields.regression.kind,'unavailable');
    assert.equal(record.fields.regression.value,null);assert.equal(record.fields.regression.coverage.available,0);
    const example=fixture();example.source.kind='demo';
    assert.equal((await createTemporalRecord(example,analyzeTemporalSignal(example))).fields.regression.kind,'demo');
  });
  it('rejects tampering and internally rehashed fabricated results, references or dates', async () => {
    const data=fixture(),record=await createTemporalRecord(data,analyzeTemporalSignal(data)),content=serializeAnalysisRecord(record);
    const raw=JSON.parse(content);raw.seed=7;
    await assert.rejects(replayTemporalRecord(JSON.stringify(raw)),/identity/);
    for(const edit of [
      (r: typeof record)=>{(r.fields.regression.value as Record<string,unknown>).slope=999;},
      (r: typeof record)=>{r.references[0].version='other';},
      (r: typeof record)=>{r.method.implementation='different';},
      (r: typeof record)=>{((r.inputs[0].data as unknown as TemporalDataset).samples[0]).collectionDate=1999;},
    ]) await assert.rejects(replayTemporalRecord(await changedRecord(content,edit)),/differs/);
  });
  it('separates changed root, grouping and exclusions in result identity', async () => {
    const data=fixture();
    const a=await createTemporalRecord(data,analyzeTemporalSignal(data));
    const grouped=await createTemporalRecord(data,analyzeTemporalSignal(data,{permutationScheme:'within-groups'}));
    assert.notEqual(a.resultId,grouped.resultId);
    data.tree.rooting='Alternative declared rooting provenance';
    assert.notEqual(a.resultId,(await createTemporalRecord(data,analyzeTemporalSignal(data))).resultId);
  });
});
