import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisJson, type AnalysisRecord } from '../analysis-result';
import { validateGrowthDataset, resolveGrowthOptions, GROWTH_PARAMETERS, GROWTH_BOUNDS, GROWTH_LIMITS,
  fitGrowthDataset, parseGrowthData, DEFAULT_GROWTH_CONDITIONS, type GrowthParameter, type GrowthDataset } from './growth-inference';
import { profileGrowthDataset, replayGrowthProfile, GROWTH_PROFILE_CUTOFF, GROWTH_PROFILE_LIMITS, type ProfiledGrowthFit } from './growth-profile';

// Independent SciPy DOP853 trajectory: rtol=1e-12, atol=1e-7. Same fixture as
// growth-inference.test.ts; no production solver generated these observations.
const rows = [
  [0,10000000,100000,.0125], [5,10243365.688072033,93280.94372026029,.012816146192369622],
  [10,10491982.40966677,118586.96354245362,.013138809595028503], [15,10740933.441461252,202532.353341776,.013466940356537307],
  [20,10982460.908055,365671.1188761933,.013799402446191327], [25,11204799.851815766,652430.7256915687,.01413376437474343],
  [30,11387615.446612658,1159277.719087575,.014464934136778582], [40,11458833.99430788,3706946.7041725204,.015071362856815252],
  [50,10460237.0643752,12003115.608275421,.015408351601819774], [60,6980213.60355128,38230272.161794186,.014876257203690612],
  [70,1858838.6444297095,108981059.77823624,.012380732842506303], [80,68776.9335401689,230184889.17843506,.00790792915032959],
];
const truth = { adsorptionRate:2e-9, latentPeriod:20, burstSize:35 };
function dataset(): GrowthDataset {
  return validateGrowthDataset({ format:'phage-explorer-growth',version:1,name:'Independent profile fixture',
    source:{kind:'demo',description:'Synthetic numerical control, not an experiment',reference:null},
    conditions:{initialBacteria:1e7,initialPhage:1e5,bacterialGrowthRate:.005,phageDecayRate:.002,stages:3,odCellsPerMl:8e8},
    observations:rows.flatMap(([timeMin,cfu,pfu,od])=>(['PFU','CFU','OD'] as const).map(type=>({
      timeMin,type,value:type==='PFU'?pfu:type==='CFU'?cfu:od,sigma:type==='OD'?.001:.03,
    }))) });
}
const options = () => resolveGrowthOptions({initial:{adsorptionRate:1e-9,latentPeriod:32,burstSize:55},seed:0,starts:3});
const cache = new Map<GrowthParameter, Promise<ProfiledGrowthFit>>();
const reference = (key:GrowthParameter) => {
  if (!cache.has(key)) cache.set(key, profileGrowthDataset(dataset(),options(),key));
  return cache.get(key)!;
};
const near = (a:number,b:number,tolerance:number) => assert.ok(Math.abs(a-b)<=tolerance, `${a} vs ${b}, tolerance ${tolerance}`);

describe('left-censored Gaussian likelihood profiles', () => {
  function censoredDataset(): GrowthDataset {
    const data = dataset();
    data.observations = data.observations.filter(row => row.type !== 'OD').map(row => row.type === 'PFU' && row.value < 120000
      ? { ...row, value: 120000, censoring: 'left' } : row);
    return data;
  }
  let accepted: Promise<ProfiledGrowthFit> | undefined;
  const fitted = () => accepted ??= profileGrowthDataset(censoredDataset(), options(), 'burstSize');
  it('agrees with independent censored-MLE likelihood crossings while refitting nuisance parameters', async () => {
    // Independent SciPy DOP853 rtol=2e-12/atol=1e-7 + log_ndtr likelihood,
    // Nelder-Mead log-parameter optimization (xatol/fatol <=2e-10), and Brent
    // roots of delta(-2 log L)=chi2.ppf(.95,1). No production numerics used.
    const { profile, result, record, profileRecord } = await fitted();
    assert.equal(record.method.version, '2'); assert.equal(profileRecord.method.version, '2');
    near(result.objective, 1.1002942961782112, 2e-6);
    assert.ok(profile.interval95);
    near(profile.interval95[0], 28.78261126118199, .015);
    near(profile.interval95[1], 45.71428308252969, .015);
    for (const side of ['lower', 'upper'] as const) {
      assert.equal(profile[side].status, 'crossed');
      near(profile[side].delta!, GROWTH_PROFILE_CUTOFF, .003);
      const point = profile.points.find(row => row.value === profile[side].value)!;
      near(point.objective! - result.objective, point.delta!, 1e-12);
      assert.ok(point.conditionalObjective! > point.objective! * 20);
      assert.ok(Math.abs(point.parameters!.latentPeriod / result.parameters.latentPeriod - 1) > .05);
    }
    // A valid profile can supply asymptotic limits even though the misleading
    // Gram-matrix Wald intervals are intentionally not produced for censoring.
    assert.equal(result.estimates.burstSize.interval95, null);
  });
  it('recomputes exported censoring events, profile probabilities and method identities', async () => {
    const original = await fitted();
    const fresh = await replayGrowthProfile(serializeAnalysisRecord(original.profileRecord));
    assert.equal(fresh.profileRecord.resultId, original.profileRecord.resultId);
    assert.equal(fresh.record.resultId, original.record.resultId);
    assert.equal(fresh.dataset.observations.filter(row => row.censoring === 'left').length, 3);
    const downgraded = await createAnalysisRecord({ ...original.profileRecord,
      method: { ...original.profileRecord.method, version: '1' }, inputs: original.profileRecord.inputs.map(({ sha256: _sha, ...input }) => input) });
    await assert.rejects(replayGrowthProfile(serializeAnalysisRecord(downgraded)), /contract/);
  });
  it('withholds bounded intervals when only detection limits are available', async () => {
    const data = censoredDataset(); data.conditions.initialBacteria = 0; data.conditions.initialPhage = 0;
    data.observations = data.observations.map(row => ({ ...row, value: 100, censoring: 'left' }));
    const { profile, result } = await profileGrowthDataset(data, resolveGrowthOptions({ initial: truth, starts: 1, freeParameters: ['burstSize'] }), 'burstSize');
    assert.equal(profile.interval95, null); assert.equal(result.censoring?.quantifiedSensitivityRank, 0);
    assert.equal(profile.lower.status, 'range-limit'); assert.equal(profile.upper.status, 'range-limit');
    assert.ok(profile.points.every(point => point.delta === 0));
    assert.ok(profile.warnings.some(warning => warning.includes('quantified observations')));
  });
  it('keeps the exact-only v1 profile identity captured before censoring support', async () => {
    const data = parseGrowthData('timeMin,type,value,sigma\n0,PFU,100000,.1\n5,PFU,95000,.1\n10,PFU,120000,.1\n15,PFU,200000,.1\n20,PFU,350000,.1\n30,PFU,1000000,.1', 'uncensored-v1-regression.csv', DEFAULT_GROWTH_CONDITIONS);
    const { profileRecord } = await profileGrowthDataset(data, resolveGrowthOptions({ starts: 1, freeParameters: ['burstSize'] }), 'burstSize');
    assert.equal(profileRecord.method.version, '1');
    assert.equal(profileRecord.resultId, '044fe7b5a2b2c5dbe5ecc16641af2ce72e0f991b1df9a934bfda65685acb5c2c');
  });
  it('checks individual profile coverage over 24 seeded synthetic datasets with assay-fixed censoring', async () => {
    // Predeclared 19..24 / 24 acceptance at nominal .95, one fitted parameter.
    // Noise is applied to the independent DOP853 values before a fixed 120000
    // PFU/mL detection rule is applied; limits never follow the fitted curve.
    let rng = 567890, covered = 0, censored = 0;
    const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return (rng + .5) / 2 ** 32; };
    for (let repetition = 0; repetition < 24; repetition++) {
      const data = dataset(); data.observations = data.observations.filter(row => row.type === 'PFU').map(row => {
        const z = Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
        const value = row.value * 10 ** (.08 * z);
        if (value < 120000) { censored++; return { ...row, sigma: .08, value: 120000, censoring: 'left' }; }
        return { ...row, sigma: .08, value };
      });
      const { profile } = await profileGrowthDataset(data, resolveGrowthOptions({ initial: truth, starts: 1, freeParameters: ['burstSize'] }), 'burstSize');
      if (profile.interval95 && profile.interval95[0] <= truth.burstSize && profile.interval95[1] >= truth.burstSize) covered++;
    }
    assert.ok(censored > 0);
    assert.ok(covered >= 19 && covered <= 24, `burstSize coverage: ${covered}/24; ${censored} censored observations`);
  });
});

// Independently optimized SciPy DOP853 + least_squares (log nuisance variables,
// bounded, rtol=2e-11; xtol/ftol=1e-11). These objectives were recomputed by a
// separate implementation at the named candidate values, not by our fitter.
const independent = {
  adsorptionRate:{ lower:[1.869516573644547e-9,3.8428373222445344], upper:[2.138830910348899e-9,3.841519721752906] },
  latentPeriod:{ lower:[17.98386659661151,3.84044670460355], upper:[22.365828934190198,3.840902881365297] },
  burstSize:{ lower:[29.604526908754252,3.841437408014325], upper:[42.048694860576646,3.840581007758493] },
};

describe('nuisance-refitted growth likelihood profiles', () => {
  for(const key of GROWTH_PARAMETERS) it(`resolves ${key} crossings and agrees with independent nonlinear optimization`, async()=>{
    const {profile}=await reference(key);
    assert.ok(profile.interval95);
    assert.ok(profile.interval95[0]<truth[key]&&profile.interval95[1]>truth[key]);
    for(const side of ['lower','upper'] as const){
      assert.equal(profile[side].status,'crossed');
      const [x,objective]=independent[key][side];
      near(profile[side].value!,x,x*2e-6);
      near(profile[side].delta!,objective,3e-5);
      near(profile[side].delta!,GROWTH_PROFILE_CUTOFF,.003);
    }
    assert.ok(profile.points.length<=GROWTH_PROFILE_LIMITS.points);
    assert.ok(profile.points.every(p=>p.converged));
    assert.deepEqual(profile.points.map(p=>p.value),profile.points.map(p=>p.value).sort((a,b)=>a-b));
  });
  it('profiles by reoptimizing nuisance parameters rather than fixing a likelihood slice', async()=>{
    const {profile,result}=await reference('burstSize');
    const crossing=profile.points.find(p=>p.value===profile.upper.value)!;
    assert.ok(crossing.conditionalObjective!>2000);
    assert.ok(crossing.objective!<4);
    assert.ok(Math.abs(crossing.parameters!.latentPeriod/result.parameters.latentPeriod-1)>.05);
    for(const point of profile.points) assert.ok(point.objective!<=point.conditionalObjective!+1e-3);
  });
  it('handles a single estimated parameter without inventing nuisance estimates', async()=>{
    const {profile}=await profileGrowthDataset(dataset(),resolveGrowthOptions({initial:truth,freeParameters:['burstSize'],starts:1}),'burstSize');
    assert.ok(profile.interval95);
    for(const point of profile.points){
      assert.equal(point.parameters!.adsorptionRate,truth.adsorptionRate);
      assert.equal(point.parameters!.latentPeriod,truth.latentPeriod);
      assert.equal(point.objective,point.conditionalObjective);
    }
  });
  it('reports a flat nonidentifiable profile as range-limited, not a bounded interval', async()=>{
    const data=dataset(); data.conditions.initialBacteria=0;
    data.observations=data.observations.filter(row=>row.type==='PFU');
    data.observations.forEach(row=>{row.value=data.conditions.initialPhage*Math.exp(-data.conditions.phageDecayRate*row.timeMin);});
    const {profile,result}=await profileGrowthDataset(data,resolveGrowthOptions({initial:truth,freeParameters:['burstSize'],starts:1}),'burstSize');
    assert.equal(result.sensitivityRank,0);assert.equal(profile.interval95,null);
    assert.equal(profile.lower.status,'range-limit');assert.equal(profile.upper.status,'range-limit');
    assert.equal(profile.lower.value,GROWTH_BOUNDS.burstSize[0]);assert.equal(profile.upper.value,GROWTH_BOUNDS.burstSize[1]);
    assert.ok(profile.points.every(point=>Math.abs(point.delta!)<1e-8));
    assert.match(profile.lower.reason,/not a confidence limit/);
  });
  it('does not turn nonconvergence into a confidence claim', async()=>{
    const config=resolveGrowthOptions({initial:{adsorptionRate:1e-12,latentPeriod:170,burstSize:2},starts:1,maxIterations:10});
    const {profile,result}=await profileGrowthDataset(dataset(),config,'burstSize');
    assert.equal(result.converged,false);assert.equal(profile.interval95,null);
    assert.ok(profile.warnings.some(warning=>warning.includes('remains descriptive')));
  });
  it('shares a finite integration budget between repeated fits', ()=>{
    const budget={steps:GROWTH_LIMITS.fitSteps};
    assert.throws(()=>fitGrowthDataset(dataset(),options(),()=>{},budget),/budget/);
    assert.ok(budget.steps>GROWTH_LIMITS.fitSteps);
  });
  it('rejects fixed or unsupported parameters and changed accepted-fit identity', async()=>{
    await assert.rejects(profileGrowthDataset(dataset(),resolveGrowthOptions({freeParameters:['burstSize']}),'latentPeriod'),/Only an estimated/);
    await assert.rejects(profileGrowthDataset(dataset(),options(),'unknown' as GrowthParameter),/Only an estimated/);
    const reports:string[]=[];
    await assert.rejects(profileGrowthDataset(dataset(),options(),'burstSize',message=>reports.push(message),'0'.repeat(64)),/differ from the accepted fit/);
    assert.ok(!reports.some(message=>message.startsWith('Profiling')));
  });
  it('binds and freshly replays the complete profile and its baseline result identity', async()=>{
    const expected=await reference('burstSize');
    const replayed=await replayGrowthProfile(serializeAnalysisRecord(expected.profileRecord));
    assert.deepEqual(replayed.profile,expected.profile);
    assert.equal(replayed.profileRecord.resultId,expected.profileRecord.resultId);
    assert.equal(replayed.record.resultId,expected.record.resultId);
    assert.equal(replayed.profileRecord.fields.profile.kind,'demo');
  });
  it('snapshots its inputs and keeps local data distinct from synthetic controls', async()=>{
    const data=dataset(), config=resolveGrowthOptions({initial:truth,freeParameters:['burstSize'],starts:1});
    data.source={kind:'local',description:'Supplied by user, not independently verified',reference:null};
    const original=structuredClone({data,config});
    const task=profileGrowthDataset(data,config,'burstSize');
    data.name='subsequent edit';config.seed=99;
    const value=await task;
    assert.deepEqual(value.dataset,original.data);assert.deepEqual(value.options,original.config);
    assert.equal(value.profileRecord.fields.profile.kind,'fitted-estimate');
  });
  it('rejects forged profile outputs even with internally consistent checksums', async()=>{
    const expected=await reference('burstSize'), copied=structuredClone(expected.profileRecord);
    (copied.fields.profile.value as Record<string,AnalysisJson>).interval95=[34.999,35.001];
    const resigned=await createAnalysisRecord({...copied,inputs:copied.inputs.map(({sha256:_sha,...input})=>input)});
    await assert.rejects(replayGrowthProfile(serializeAnalysisRecord(resigned)),/Fresh growth profile differs/);
  });
  it('refuses incompatible references, schemas and seeds before profile computation', async()=>{
    const {profileRecord}=await reference('burstSize');
    for(const change of [
      (record:AnalysisRecord)=>{record.references[0].version='incompatible';},
      (record:AnalysisRecord)=>{record.method.version='999';},
      (record:AnalysisRecord)=>{record.seed=99;},
      (record:AnalysisRecord)=>{record.parameters.extra='unsupported';},
    ]){
      const edited=structuredClone(profileRecord);change(edited);
      const signed=await createAnalysisRecord({...edited,inputs:edited.inputs.map(({sha256:_sha,...input})=>input)});
      const reports:string[]=[];
      await assert.rejects(replayGrowthProfile(serializeAnalysisRecord(signed),phase=>reports.push(phase)));
      assert.deepEqual(reports,[]);
    }
  });
});

it('checks profile coverage on 24 independent-noise controls with fixed nuisance inputs', async()=>{
  // Predeclared broad binomial check: at least 19/24 at nominal 95% coverage.
  // Withheld intervals count as misses. This is a model-correct synthetic
  // diagnostic, not an experimental or multi-parameter coverage guarantee.
  let cursor=20260927, covered=0, withheld=0;
  const random=()=>{cursor=(Math.imul(cursor,1664525)+1013904223)>>>0;return (cursor+.5)/2**32;};
  for(let repetition=0;repetition<24;repetition++){
    const data=dataset();
    data.observations=data.observations.filter(row=>row.type!=='OD');
    data.observations.forEach(row=>{
      const noise=Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
      row.value*=10**(row.sigma*noise);
    });
    const {profile}=await profileGrowthDataset(data,resolveGrowthOptions({initial:truth,freeParameters:['burstSize'],starts:1}),'burstSize');
    if(!profile.interval95) withheld++;
    else if(profile.interval95[0]<=truth.burstSize&&profile.interval95[1]>=truth.burstSize) covered++;
  }
  assert.ok(covered>=19&&covered<=24,`coverage ${covered}/24; withheld ${withheld}/24`);
});
