import { describe, it, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import { analyzeHostMetabolism, validateHostModelInput, parseCobraHostModel, resolveHostFluxOptions,
  createHostFluxRecord, replayHostFluxRecord, type HostModelInput, type HostFluxChange } from './host-metabolism';
import { createAnalysisRecord, serializeAnalysisRecord, parseAnalysisRecord } from '../analysis-result';
import { FBASimplexSolver, type FBAStatus } from './amg-flux';

export function hostFixture(): HostModelInput {
  return { format:'phage-explorer-host-model',version:1,
    source:{kind:'demo',name:'Analytical parallel-path network',version:'1',organism:'Synthetic',strain:'Not biological',accession:'synthetic',
      reference:'Hand-derived conservation: uptake=pathA+pathB=biomass',license:'CC0',fluxUnits:'arbitrary flux',objectiveUnits:'arbitrary flux'},
    medium:{name:'Ten units of substrate',reference:'Supplied source bound; no other exchange',bounds:[]},
    cobra:{id:'parallel',compartments:{c:'cytosol'},genes:[{id:'gA'},{id:'gB'}],metabolites:[{id:'a',compartment:'c'},{id:'b',compartment:'c'}],
      reactions:[
        {id:'EX',name:'Input',metabolites:{a:-1},lower_bound:-10,upper_bound:0},
        {id:'A',name:'Path A',metabolites:{a:-1,b:1},lower_bound:0,upper_bound:10,gene_reaction_rule:'gA',annotation:{'kegg.reaction':'test'}},
        {id:'B',name:'Path B',metabolites:{a:-1,b:1},lower_bound:0,upper_bound:10,gene_reaction_rule:'gB'},
        {id:'BIO',name:'Biomass sink',metabolites:{b:-1},lower_bound:0,upper_bound:100,objective_coefficient:1},
      ]}};
}
function raw(input:HostModelInput){return input.cobra as {reactions:Array<Record<string,any>>;metabolites:Array<Record<string,any>>;[key:string]:any};}
function change(reactionId:string,lowerBound:number,upperBound:number):HostFluxChange{return {reactionId,lowerBound,upperBound,evidence:{kind:'assumption',reference:'analytical test',description:'Explicit conditional capacity',gene:null}};}
const close=(a:number|null,b:number,tol=3e-6)=>{assert.notEqual(a,null);assert.ok(Math.abs(a!-b)<tol,`${a} != ${b}`);};

describe('sourced host model validation',()=>{
  it('retains compartments, coefficients, GPR metadata and original annotations without converting them to kinetics',()=>{
    const input=hostFixture(),copy=validateHostModelInput(input),network=parseCobraHostModel(copy.cobra);
    assert.equal(network.reactions[1].geneRule,'gA');assert.deepEqual(network.metabolites,[{id:'a',compartment:'c'},{id:'b',compartment:'c'}]);
    assert.deepEqual(copy.cobra,input.cobra);raw(input).reactions[1].annotation['kegg.reaction']='changed';
    assert.equal(raw(copy).reactions[1].annotation['kegg.reaction'],'test');
  });
  it('requires source, host, units and medium provenance rather than using the selected phage name',()=>{
    for(const key of ['organism','strain','accession','version','reference','license','fluxUnits','objectiveUnits'] as const){
      const data=hostFixture();data.source[key]='';assert.throws(()=>validateHostModelInput(data),/nonempty/);
    }
    const data=hostFixture();data.medium.reference='';assert.throws(()=>validateHostModelInput(data),/Medium/);
  });
  it('rejects duplicate/unknown IDs, malformed bounds and absent objectives',()=>{
    for(const edit of [
      (x:any)=>x.reactions.push(x.reactions[0]),(x:any)=>x.metabolites.push(x.metabolites[0]),
      (x:any)=>{x.reactions[1].metabolites.unknown=1;},(x:any)=>{x.reactions[0].lower_bound=NaN;},
      (x:any)=>{x.reactions[0].upper_bound=-20;},(x:any)=>{x.reactions[3].objective_coefficient=0;},
      (x:any)=>{x.metabolites[0].compartment='absent';},(x:any)=>{x.reactions[0].metabolites={};},
    ]){const data=hostFixture();edit(raw(data));assert.throws(()=>validateHostModelInput(data));}
  });
  it('refuses nonstandard mathematical fields and unsupported minimization instead of silently changing the model',()=>{
    for(const edit of [
      (x:any)=>{x.constraints=[];},(x:any)=>{x.metabolites[0]._bound=2;},
      (x:any)=>{x.reactions[0].kinetic_law='custom';},(x:any)=>{x.objective_direction='min';},
    ]){const data=hostFixture();edit(raw(data));assert.throws(()=>validateHostModelInput(data),/Unsupported|Only/);}
  });
  it('bounds problem size before allocating an LP tableau',()=>{
    const data=hostFixture();raw(data).reactions=Array.from({length:201},(_,i)=>({...raw(hostFixture()).reactions[0],id:String(i)}));
    assert.throws(()=>validateHostModelInput(data),/200/);
    assert.throws(()=>parseCobraHostModel({notes:'x'.repeat(2*1024*1024)}),/2 MiB/);
  });
  it('validates explicit mappings and disallows contradictory duplicate changes',()=>{
    assert.throws(()=>resolveHostFluxOptions({changes:[change('A',0,1),change('A',0,2)]}),/Duplicate/);
    const mapping=change('A',0,1);mapping.evidence.kind='annotation';
    assert.throws(()=>resolveHostFluxOptions({changes:[mapping]}),/accession/);
    mapping.evidence.gene={accession:'SOURCE.1',locusTag:'CDS_1'};
    assert.deepEqual(resolveHostFluxOptions({changes:[mapping]}).changes[0],mapping);
    assert.throws(()=>analyzeHostMetabolism(hostFixture(),{changes:[change('RNR_REDUCTASE',0,5)]}),/absent/);
    assert.throws(()=>resolveHostFluxOptions({variability:['A','A']}),/Duplicate/);
  });
});

describe('conditional host scenarios and alternative optima',()=>{
  it('matches a hand-derived optimum and checks stoichiometric balance and bounds',()=>{
    const result=analyzeHostMetabolism(hostFixture());close(result.baseline.objective,10);
    const v=result.baseline.fluxes;close(-v.EX-v.A-v.B,0);close(v.A+v.B-v.BIO,0);
    assert.ok(result.baseline.certificate!.maxBalanceResidual<1e-8);assert.equal(result.perturbed,null);assert.equal(result.objectiveDelta,null);
  });
  it('changes actual exchange bounds in the declared medium before both scenarios',()=>{
    const data=hostFixture();data.medium.bounds=[{reactionId:'EX',lowerBound:-4,upperBound:0}];
    const result=analyzeHostMetabolism(data,{changes:[change('A',0,1),change('B',0,1)]});
    close(result.baseline.objective,4);close(result.perturbed!.objective,2);close(result.objectiveDelta,-2);close(result.percentChange,-50);
  });
  it('applies all mapped capacities simultaneously rather than adding independent apparent benefits',()=>{
    const data=hostFixture();raw(data).reactions[1].upper_bound=2;raw(data).reactions[2].upper_bound=3;
    const before=structuredClone(data);const result=analyzeHostMetabolism(data,{changes:[change('A',0,10),change('B',0,10)]});
    close(result.baseline.objective,5);close(result.perturbed!.objective,10);close(result.objectiveDelta,5);
    assert.deepEqual(data,before); // Both individual changes could gain five, but joint gain is five, not ten.
  });
  it('represents reverse-direction restrictions with negative lower bounds',()=>{
    const data=hostFixture();raw(data).reactions[1].metabolites={a:1,b:-1};raw(data).reactions[1].lower_bound=-10;raw(data).reactions[1].upper_bound=0;
    raw(data).reactions[2].upper_bound=0;
    const result=analyzeHostMetabolism(data,{changes:[change('A',-3,0)],variability:['A','BIO']});
    close(result.baseline.objective,10);close(result.perturbed!.objective,3);
    close(result.baseline.ranges[0].minimum.value,-10);close(result.perturbed!.ranges[0].minimum.value,-3);
    assert.equal(result.rangeChanges[0].interpretation,'increased'); // Signed flux increased from -10 to -3.
    assert.equal(result.rangeChanges[1].interpretation,'decreased');
  });
  it('supports weighted multi-reaction objectives without selecting a guessed biomass reaction',()=>{
    const data=hostFixture();raw(data).reactions[1].objective_coefficient=1;raw(data).reactions[3].objective_coefficient=2;
    const result=analyzeHostMetabolism(data,{variability:['A','B']});close(result.baseline.objective,30);
    close(result.baseline.ranges[0].minimum.value,10,1e-5);close(result.baseline.ranges[1].maximum.value,0,1e-5);
  });
  it('reports the full nonunique [0,10] flux ranges of interchangeable pathways',()=>{
    const result=analyzeHostMetabolism(hostFixture(),{variability:['A','B','BIO']});
    for(const range of result.baseline.ranges.slice(0,2)){close(range.minimum.value,0);close(range.maximum.value,10);}
    close(result.baseline.ranges[2].minimum.value,10);close(result.baseline.ranges[2].maximum.value,10);
    assert.equal(result.baseline.objectiveFloor,10-result.baseline.objectiveSlack!);
  });
  it('does not claim forced reaction changes from arbitrary optimal point vectors',()=>{
    const result=analyzeHostMetabolism(hostFixture(),{changes:[change('A',0,2)],variability:['A','B']});
    close(result.objectiveDelta,0);assert.ok(result.rangeChanges.every(r=>r.interpretation==='overlapping'));
    close(result.perturbed!.ranges[0].maximum.value,2);close(result.perturbed!.ranges[1].minimum.value,8);
  });
  it('uses absolute objective loss correctly even when the best objective is negative',()=>{
    const data=hostFixture();raw(data).reactions[3].lower_bound=2;raw(data).reactions[3].objective_coefficient=-1;
    const result=analyzeHostMetabolism(data,{variability:['BIO'],objectiveLoss:1});close(result.baseline.objective,-2);
    close(result.baseline.ranges[0].minimum.value,2);close(result.baseline.ranges[0].maximum.value,3);
  });
  it('preserves infeasibility and never displays a finite benefit from a failed scenario',()=>{
    const result=analyzeHostMetabolism(hostFixture(),{changes:[change('EX',0,0),change('BIO',1,100)],variability:['A']});
    assert.equal(result.perturbed!.status,'infeasible');assert.equal(result.perturbed!.objective,null);assert.deepEqual(result.perturbed!.fluxes,{});
    assert.equal(result.objectiveDelta,null);assert.equal(result.percentChange,null);assert.equal(result.rangeChanges[0].interpretation,'unavailable');
  });
  it('reports undefined percentage at zero baseline and keeps ordinary finite flux changes',()=>{
    const data=hostFixture();data.medium.bounds=[{reactionId:'EX',lowerBound:0,upperBound:0}];
    const result=analyzeHostMetabolism(data,{changes:[change('EX',-5,0)]});close(result.objectiveDelta,5);assert.equal(result.percentChange,null);
  });
  it('allows source-defined prototype-looking IDs without mutating prototypes or losing constraints',()=>{
    const data=hostFixture();raw(data).reactions[3].id='__proto__';const result=analyzeHostMetabolism(data,{variability:['__proto__']}); // ubs:ignore[js.security.prototype-pollution] Adversarial fixture assigns an ordinary string ID, not a prototype.
    assert(Object.hasOwn(result.baseline.fluxes,'__proto__'));
    close(result.baseline.fluxes.__proto__,10);close(result.baseline.ranges[0].minimum.value,10);assert.equal(({} as any).polluted,undefined); // ubs:ignore[js.security.prototype-pollution] Read the verified own data property; assert unrelated prototypes stay unchanged.
  });
});

describe('parsimonious host flux selection',()=>{
  function routeFixture():HostModelInput {
    const data=hostFixture();
    data.source.name='Analytical short and long routes';
    data.source.reference='uptake=direct+long1=biomass; long1=long2. At biomass 10, total absolute flux=30+long1.';
    raw(data).metabolites.push({id:'middle',compartment:'c'});
    raw(data).reactions[1].metabolites={a:-1,middle:1};
    raw(data).reactions[2].metabolites={middle:-1,b:1};
    raw(data).reactions.push({id:'direct',metabolites:{a:-1,b:1},lower_bound:0,upper_bound:10});
    return data;
  }
  it('selects the independently minimal short route while preserving the ordinary optimum and full FVA',()=>{
    const data=routeFixture();
    const original=analyzeHostMetabolism(data,{variability:['A','direct']});
    const result=analyzeHostMetabolism(data,{parsimonious:true,variability:['A','direct']});
    const selected=result.baseline.parsimonious!;
    assert.equal(selected.status,'optimal');close(selected.primaryObjective,10,2e-6);close(selected.totalAbsoluteFlux,30,4e-6);
    close(selected.fluxes.EX,-10,2e-6);close(selected.fluxes.direct,10,2e-6);close(selected.fluxes.A,0);close(selected.fluxes.B,0);
    close(-selected.fluxes.EX-selected.fluxes.direct-selected.fluxes.A,0);
    close(selected.fluxes.A-selected.fluxes.B,0);close(selected.fluxes.B+selected.fluxes.direct-selected.fluxes.BIO,0);
    assert(selected.certificate!.maxBalanceResidual<1e-8);assert(selected.certificate!.objectiveResidual<1e-8);
    assert.equal(selected.objectiveFloorTolerance,result.baseline.objectiveSlack!);
    assert.equal(selected.objectiveSlack,result.baseline.objectiveSlack!+selected.objectiveFloorTolerance);
    assert(selected.primaryObjective!>=result.baseline.objective!-selected.objectiveSlack);
    assert.deepEqual(result.baseline.fluxes,original.baseline.fluxes);assert.deepEqual(result.baseline.ranges,original.baseline.ranges);
    close(result.baseline.ranges[0].minimum.value,0);close(result.baseline.ranges[0].maximum.value,10);
    close(result.baseline.ranges[1].minimum.value,0);close(result.baseline.ranges[1].maximum.value,10);
  });
  it('charges reverse-only flux positively and retains the original signed bounds',()=>{
    const data=routeFixture(),direct=raw(data).reactions.at(-1)!;
    direct.metabolites={a:1,b:-1};direct.lower_bound=-10;direct.upper_bound=0;
    const result=analyzeHostMetabolism(data,{parsimonious:true,changes:[change('direct',-3,0)]});
    const base=result.baseline.parsimonious!,changed=result.perturbed!.parsimonious!;
    close(base.fluxes.direct,-10,2e-6);close(base.totalAbsoluteFlux,30,4e-6);
    // The three-unit short route plus seven units of the two-step route still produce ten biomass units.
    close(changed.fluxes.direct,-3);close(changed.fluxes.A,7,2e-6);close(changed.fluxes.B,7,2e-6);
    close(changed.totalAbsoluteFlux,37,5e-6);close(result.objectiveDelta,0);
    assert(base.certificate!.maxBoundViolation<1e-8);assert(changed.certificate!.maxBoundViolation<1e-8);
  });
  it('does not trade primary objective for the allowed FVA objective loss',()=>{
    const result=analyzeHostMetabolism(routeFixture(),{parsimonious:true,variability:['BIO'],objectiveLoss:5});
    close(result.baseline.ranges[0].minimum.value,5,2e-6);
    close(result.baseline.parsimonious!.primaryObjective,10,2e-6);
    assert.equal(result.baseline.parsimonious!.objectiveFloor,result.baseline.objective!-result.baseline.objectiveSlack!);
    assert(result.baseline.parsimonious!.objectiveFloor>result.baseline.objectiveFloor!);
  });
  it('preserves negative weighted primary objectives and forced positive flux',()=>{
    const data=routeFixture();raw(data).reactions[3].lower_bound=2;raw(data).reactions[3].objective_coefficient=-2;
    const result=analyzeHostMetabolism(data,{parsimonious:true,objectiveLoss:2,variability:['BIO']});
    close(result.baseline.objective,-4);close(result.baseline.parsimonious!.primaryObjective,-4);
    close(result.baseline.parsimonious!.totalAbsoluteFlux,6);close(result.baseline.parsimonious!.fluxes.BIO,2);
    close(result.baseline.ranges[0].maximum.value,3);assert(result.baseline.parsimonious!.objectiveFloor< -4);
  });
  it('removes dispensable cycles but retains mandatory cycles without claiming looplessness',()=>{
    const data=routeFixture();raw(data).metabolites.push({id:'cycle1',compartment:'c'},{id:'cycle2',compartment:'c'});
    raw(data).reactions.push(
      {id:'cycle-forward',metabolites:{cycle1:-1,cycle2:1},lower_bound:0,upper_bound:10},
      {id:'cycle-return',metabolites:{cycle1:1,cycle2:-1},lower_bound:0,upper_bound:10});
    const result=analyzeHostMetabolism(data,{parsimonious:true,changes:[change('cycle-forward',2,10)]});
    const base=result.baseline.parsimonious!,forced=result.perturbed!.parsimonious!;
    close(base.fluxes['cycle-forward'],0);close(base.fluxes['cycle-return'],0);close(base.totalAbsoluteFlux,30,4e-6);
    close(forced.fluxes['cycle-forward'],2);close(forced.fluxes['cycle-return'],2);close(forced.totalAbsoluteFlux,34,4e-6);
    assert(result.warnings.some(w=>w.includes('not measured enzyme allocation')));
  });
  it('keeps equal-length alternatives nonunique and tolerates IDs resembling internal columns',()=>{
    const data=hostFixture();raw(data).reactions[1].id='forward:0';raw(data).reactions[2].id='objective-floor';
    raw(data).reactions[0].id='__proto__';
    const result=analyzeHostMetabolism(data,{parsimonious:true,variability:['forward:0','objective-floor']});
    const selected=result.baseline.parsimonious!;
    close(selected.totalAbsoluteFlux,30,4e-6);close(selected.fluxes['forward:0']+selected.fluxes['objective-floor'],10,2e-6);
    assert(Object.hasOwn(selected.fluxes,'__proto__'));close(selected.fluxes.__proto__,-10,2e-6);
    for(const range of result.baseline.ranges){close(range.minimum.value,0);close(range.maximum.value,10);}
    assert(result.warnings.some(w=>w.includes('can remain nonunique')));
  });
  it('does not run a secondary optimization when the primary model is infeasible',()=>{
    const data=routeFixture();data.medium.bounds=[{reactionId:'EX',lowerBound:0,upperBound:0},{reactionId:'BIO',lowerBound:1,upperBound:100}];
    const phases:string[]=[];
    const result=analyzeHostMetabolism(data,{parsimonious:true},phase=>phases.push(phase));
    assert.equal(result.baseline.status,'infeasible');assert.equal(result.baseline.parsimonious,null);
    assert(!phases.some(phase=>phase.includes('Minimizing')));assert.equal(result.baseline.objective,null);
  });
  it('preserves a successful primary result when the secondary solver reports failure',()=>{
    // Controlled solver-failure routing; numerical correctness is checked by the separate analytical cases.
    const solve=FBASimplexSolver.prototype.solve;
    for(const status of ['infeasible','unbounded','iteration_limit','numerical_error','invalid_input'] as const){
      let calls=0;
      const mock=spyOn(FBASimplexSolver.prototype,'solve').mockImplementation(function(this:FBASimplexSolver){
        return ++calls===2?{optimal:false,status:status as FBAStatus,objective:null,fluxes:{}}:solve.call(this);
      });
      try{
        const result=analyzeHostMetabolism(routeFixture(),{parsimonious:true});
        close(result.baseline.objective,10);assert.equal(result.baseline.status,'optimal');
        assert.equal(result.baseline.parsimonious!.status,status);assert.equal(result.baseline.parsimonious!.primaryObjective,null);
        assert.equal(result.baseline.parsimonious!.totalAbsoluteFlux,null);assert.equal(result.baseline.parsimonious!.certificate,null);
        assert.deepEqual(result.baseline.parsimonious!.fluxes,{});
      }finally{mock.mockRestore();}
    }
  });
  it('rejects a secondary objective inconsistent with the reconstructed absolute flux',()=>{
    const solve=FBASimplexSolver.prototype.solve;let calls=0;
    const mock=spyOn(FBASimplexSolver.prototype,'solve').mockImplementation(function(this:FBASimplexSolver){
      const result=solve.call(this);return ++calls===2?{...result,objective:result.objective!+1}:result;
    });
    try{
      const result=analyzeHostMetabolism(routeFixture(),{parsimonious:true});
      assert.equal(result.baseline.status,'optimal');assert.equal(result.baseline.parsimonious!.status,'numerical_error');
      assert.equal(result.baseline.parsimonious!.totalAbsoluteFlux,null);assert.deepEqual(result.baseline.parsimonious!.fluxes,{});
    }finally{mock.mockRestore();}
  });
  it('validates the opt-in flag and retains zero-cost legacy options when disabled',()=>{
    for(const parsimonious of [null,0,1,'true',{},[]])assert.throws(()=>resolveHostFluxOptions({parsimonious}),/boolean/);
    assert.deepEqual(resolveHostFluxOptions({parsimonious:false}),resolveHostFluxOptions());
    assert.deepEqual(analyzeHostMetabolism(hostFixture(),{parsimonious:false}),analyzeHostMetabolism(hostFixture()));
    assert(!Object.hasOwn(analyzeHostMetabolism(hostFixture()).baseline,'parsimonious'));
  });
  it('exports the independent L1 result, binds its method, and recomputes it on replay',async()=>{
    const input=routeFixture(),result=analyzeHostMetabolism(input,{parsimonious:true,changes:[change('direct',0,3)],variability:['A']});
    const record=await createHostFluxRecord(input,result),replay=await replayHostFluxRecord(serializeAnalysisRecord(record));
    assert.equal(record.method.version,'2');assert.equal(replay.record.resultId,record.resultId);assert.deepEqual(replay.result,result);
    assert.equal(record.parameters.parsimonious,true);assert(record.references.some(reference=>reference.id==='parsimonious-fba'));
    const forged=await parseAnalysisRecord(serializeAnalysisRecord(record));
    ((forged.fields.baseline.value as Record<string,unknown>).parsimonious as Record<string,unknown>).totalAbsoluteFlux=29;
    const rehashed=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_hash,...row})=>row)});
    await assert.rejects(replayHostFluxRecord(serializeAnalysisRecord(rehashed)),/Fresh host-model results differ/);
    const wrongVersion=await createAnalysisRecord({...record,method:{...record.method,version:'1'},inputs:record.inputs.map(({sha256:_hash,...row})=>row)});
    await assert.rejects(replayHostFluxRecord(serializeAnalysisRecord(wrongVersion)),/incompatible/);
  });
  it('preserves the pinned pre-pFBA version-1 identity when omitted or explicitly disabled',async()=>{
    const input:HostModelInput={format:'phage-explorer-host-model',version:1,
      source:{kind:'demo',name:'Legacy two-reaction fixture',version:'1',organism:'Synthetic',strain:'None',accession:'legacy',reference:'One pool, source=sink<=4.',license:'CC0',fluxUnits:'arbitrary',objectiveUnits:'arbitrary'},
      medium:{name:'Original bounds',reference:'No overrides',bounds:[]},cobra:{id:'legacy',metabolites:[{id:'a',compartment:'c'}],reactions:[
        {id:'source',metabolites:{a:1},lower_bound:0,upper_bound:4},{id:'sink',metabolites:{a:-1},lower_bound:0,upper_bound:9,objective_coefficient:1}]}};
    // Captured from d2e01e884b84793ab130121ba13678f365dcd402 before this feature was implemented.
    for(const options of [{},{parsimonious:false}]){
      const record=await createHostFluxRecord(input,analyzeHostMetabolism(input,options));
      assert.equal(record.method.version,'1');assert.equal(record.resultId,'7ddee32581f1ca41db0e3b8ec0e9b528ec23346eb588a303d8434025286e79c6');
      assert.equal(record.cacheKey,'d4519c75a165972aeaa137d5610c9084b2c2e06bcc112fed351a9dc1966f51c0');
      assert.equal((await replayHostFluxRecord(serializeAnalysisRecord(record))).record.resultId,record.resultId);
    }
  });
});

describe('portable sourced metabolic experiments',()=>{
  it('retains numerical failure through imported models, perturbations, flux ranges and replay',async()=>{
    const input=hostFixture();
    input.cobra={id:'low-yield',compartments:{c:'cytosol'},metabolites:[{id:'precursor',compartment:'c'}],reactions:[
      {id:'source',metabolites:{precursor:1e-10},lower_bound:0,upper_bound:1e6},
      {id:'biomass',metabolites:{precursor:-1},lower_bound:0,upper_bound:1e6,objective_coefficient:1},
    ]};
    // Conservation gives biomass=1e-10*source: the old coefficient cutoff
    // falsely reported zero as optimal for both supported model conditions.
    const result=analyzeHostMetabolism(input,{changes:[change('source',0,5e5)],variability:['biomass']});
    assert.equal(result.objectiveDelta,null);assert.equal(result.percentChange,null);
    for(const scenario of [result.baseline,result.perturbed!]){
      assert.equal(scenario.status,'numerical_error');assert.equal(scenario.objective,null);
      assert.deepEqual(scenario.fluxes,{});assert.deepEqual(scenario.ranges,[]);
      assert.equal(scenario.certificate,null);assert.equal(scenario.objectiveFloor,null);
    }
    assert.equal(result.rangeChanges[0].interpretation,'unavailable');
    assert.equal(result.rangeChanges[0].lower,null);assert.equal(result.rangeChanges[0].upper,null);
    const record=await createHostFluxRecord(input,result),replay=await replayHostFluxRecord(serializeAnalysisRecord(record));
    assert.deepEqual(replay.result,result);assert.equal(replay.record.resultId,record.resultId);
  });
  it('snapshots exact source, medium, annotations, mappings and flux ranges for replay',async()=>{
    const input=hostFixture(),result=analyzeHostMetabolism(input,{changes:[change('A',0,2)],variability:['A','B']}),promise=createHostFluxRecord(input,result);
    input.medium.name='Edited while hashing';result.options.changes[0].upperBound=99;
    const record=await promise,replay=await replayHostFluxRecord(serializeAnalysisRecord(record));
    assert.equal(replay.record.resultId,record.resultId);assert.equal(replay.input.medium.name,'Ten units of substrate');
    assert.equal(replay.result.options.changes[0].upperBound,2);assert.equal(record.fields.baseline.kind,'demo');
  });
  it('does not upgrade locally imported model predictions into observed growth',async()=>{
    const input=hostFixture();input.source.kind='local';const record=await createHostFluxRecord(input,analyzeHostMetabolism(input));
    assert.equal(record.inputs[0].source,'local');assert.equal(record.fields.baseline.kind,'simulation');assert.equal(record.fields.baseline.units,'model-flux');
  });
  it('rejects internally rehashed false fluxes, mapping identity and version changes',async()=>{
    const input=hostFixture(),record=await createHostFluxRecord(input,analyzeHostMetabolism(input,{variability:['A']}));
    const text=serializeAnalysisRecord(record);const forged=await parseAnalysisRecord(text);
    (forged.fields.baseline.value as Record<string,unknown>).objective=999;
    const signed=await createAnalysisRecord({...forged,inputs:forged.inputs.map(({sha256:_hash,...row})=>row)});
    await assert.rejects(replayHostFluxRecord(serializeAnalysisRecord(signed)),/Fresh host-model results differ/);
    signed.method.version='999';await assert.rejects(replayHostFluxRecord(serializeAnalysisRecord(signed)),/incompatible/);
    const tampered=JSON.parse(text);tampered.parameters.objectiveLoss=1;await assert.rejects(replayHostFluxRecord(JSON.stringify(tampered)),/identity/);
  });
  it('binds medium and reference-version changes even when the optimal value is unchanged',async()=>{
    const input=hostFixture(),first=await createHostFluxRecord(input,analyzeHostMetabolism(input));
    input.source.version='2';const second=await createHostFluxRecord(input,analyzeHostMetabolism(input));
    assert.notEqual(first.cacheKey,second.cacheKey);input.medium.name='other recorded medium';
    const third=await createHostFluxRecord(input,analyzeHostMetabolism(input));assert.notEqual(second.resultId,third.resultId);
  });
});
