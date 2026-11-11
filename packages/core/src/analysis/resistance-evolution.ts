/** Reproducible illustrative resistance-evolution simulations.
 * This is a parameterized stochastic teaching model, not a fit to a selected phage.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createSeededRng } from './metagenomic-niche';
import { makeResistanceSimulation, type ResistanceCocktailState } from '../simulation-implementations';

export const RESISTANCE_EVOLUTION_METHOD = {
  id: 'resistance-cocktail-simulation',
  version: '1',
  implementation: 'seeded tau-leaping resistance-cocktail simulation using the core resistance-cocktail transition model',
} as const;

export interface ResistanceExperimentOptions {
  cocktailSize: number;
  initialBacteria: number;
  initialPhage: number;
  carryingCap: number;
  growthRate: number;
  infectionRate: number;
  burstSize: number;
  latentPeriod: number;
  mutationRate: number;
  multiResRate: number;
  phageDecay: number;
  seed: number;
}
export interface ResistanceExperimentResult {
  options: ResistanceExperimentOptions;
  durationHours: number;
  steps: number;
  outcome: 'bacteria-cleared' | 'phage-extinct' | 'time-limit';
  resistanceEmerged: boolean;
  resistanceTime: number | null;
  final: { sensitive: number; partialResistant: number[]; fullyResistant: number; phage: number[] };
  trajectory: ResistanceCocktailState['history'];
  recentEvents: ResistanceCocktailState['events'];
  limitations: string[];
}
const DEFAULTS: ResistanceExperimentOptions = {
  cocktailSize: 3, initialBacteria: 1e7, initialPhage: 1e8, carryingCap: 1e9,
  growthRate: .5, infectionRate: 2e-9, burstSize: 100, latentPeriod: .5,
  mutationRate: 1e-7, multiResRate: 1e-8, phageDecay: .1, seed: 1,
};
const LIMITS = {
  cocktailSize:[1,5], initialBacteria:[1e5,1e9], initialPhage:[1e4,1e10], carryingCap:[1e7,1e10],
  growthRate:[.1,2], infectionRate:[1e-10,1e-7], burstSize:[10,500], latentPeriod:[.1,2],
  mutationRate:[1e-9,1e-5], multiResRate:[1e-10,1e-6], phageDecay:[0,.5],
} as const;
const LIMITATIONS = [
  'This is an illustrative stochastic model with user-selected parameters, not a fit to the selected phage, bacterial strain, treatment or experiment.',
  'Resistance is represented by simplified partial/full classes and fixed mutation rates. Receptor biology, fitness costs, spatial structure, immunity, pharmacokinetics and ecological interactions are omitted.',
  'The infection and lysis transitions are tau-leaping approximations. A simulated resistance time or clearance event is not a clinical or evolutionary prediction.',
  'Cocktail members are represented symmetrically except for their stochastic histories; sequence identity, receptor independence and cross-resistance are not supplied by this model.',
] as const;

export function resolveResistanceExperimentOptions(value: Partial<ResistanceExperimentOptions> = {}): ResistanceExperimentOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resistance simulation options must be an object.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULTS,key)) throw new Error('Unsupported resistance simulation option: '+key);
  const options={...DEFAULTS,...value};
  for(const [key,bounds] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS,readonly[number,number]]>){
    const v=options[key];
    if(typeof v!=='number'||!Number.isFinite(v)||v<bounds[0]||v>bounds[1]) throw new Error('Resistance simulation option '+key+' is outside its supported range.');
  }
  if(!Number.isSafeInteger(options.cocktailSize)) throw new Error('cocktailSize must be an integer from 1 to 5.');
  if(!Number.isSafeInteger(options.seed)||options.seed<0||options.seed>0xffffffff) throw new Error('seed must be a uint32.');
  return options;
}

export function runResistanceExperiment(value: Partial<ResistanceExperimentOptions> = {}): ResistanceExperimentResult {
  const options=resolveResistanceExperimentOptions(value), simulation=makeResistanceSimulation();
  const {seed,...params}=options;
  let state=simulation.init(null,params);
  const rng=createSeededRng('resistance-cocktail:'+seed);
  let steps=0;
  while(!simulation.isComplete?.(state)){
    if(steps++>=5000) throw new Error('Resistance simulation exceeded its bounded 50-hour step budget.');
    state=simulation.step(state,1,rng);
  }
  const totalBacteria=state.sensitiveBacteria+state.fullyResistant+state.partialResistant.reduce((a,b)=>a+b,0);
  const totalPhage=state.phageCounts.reduce((a,b)=>a+b,0);
  const outcome:ResistanceExperimentResult['outcome']=totalBacteria<1?'bacteria-cleared':totalPhage<1?'phage-extinct':'time-limit';
  return {options,durationHours:state.simTime,steps,outcome,resistanceEmerged:state.resistanceEmerged,
    resistanceTime:state.resistanceTime,
    final:{sensitive:state.sensitiveBacteria,partialResistant:[...state.partialResistant],fullyResistant:state.fullyResistant,phage:[...state.phageCounts]},
    trajectory:structuredClone(state.history),recentEvents:structuredClone(state.events),limitations:[...LIMITATIONS]};
}

export async function createResistanceExperimentRecord(value: Partial<ResistanceExperimentOptions> = {}): Promise<{
  result: ResistanceExperimentResult; record: AnalysisRecord;
}> {
  const result=runResistanceExperiment(value), options=result.options;
  const record=await createAnalysisRecord({
    method:RESISTANCE_EVOLUTION_METHOD,
    inputs:[{id:'model',accession:null,source:'demo',
      description:'Explicit illustrative resistance-cocktail stochastic model; no selected-phage or experimental calibration is implied.',
      data:analysisJson({model:'resistance-cocktail',transitionModelVersion:1,timeStepHours:.01,maxHours:48,
        resistanceThresholdFraction:.1,limitations:LIMITATIONS})}],
    parameters:analysisJson(options) as AnalysisRecord['parameters'],seed:options.seed,
    references:[{id:'resistance-cocktail-model',version:'1',
      description:'Internal parameterized teaching model using Poisson tau-leaping transitions; not a fitted biological reference.'}],
    fields:{trajectory:{kind:'simulation',label:'Seeded illustrative resistance and phage population trajectory',
      value:analysisJson(result),units:'records',coverage:{available:result.trajectory.length,total:result.trajectory.length,unit:'records'},
      limitations:[...result.limitations],assumptions:['All transition rates and initial populations are user-selected model assumptions.']}},
  });
  return {result,record};
}

export async function replayResistanceExperimentRecord(content:string):Promise<{result:ResistanceExperimentResult;record:AnalysisRecord}>{
  const saved=await parseAnalysisRecord(content,{methodId:RESISTANCE_EVOLUTION_METHOD.id,methodVersion:RESISTANCE_EVOLUTION_METHOD.version});
  if(saved.inputs.length!==1||saved.inputs[0].id!=='model'||saved.inputs[0].source!=='demo'||saved.seed===null)
    throw new Error('Resistance simulation replay contract differs.');
  const fresh=await createResistanceExperimentRecord(saved.parameters as Partial<ResistanceExperimentOptions>);
  if(fresh.record.cacheKey!==saved.cacheKey||fresh.record.resultId!==saved.resultId)
    throw new Error('Recomputed resistance simulation differs from the saved experiment.');
  return fresh;
}

export function exportResistanceExperimentTsv(record:AnalysisRecord):string{
  if(record.method.id!==RESISTANCE_EVOLUTION_METHOD.id||record.method.version!==RESISTANCE_EVOLUTION_METHOD.version)
    throw new Error('Expected a resistance simulation record.');
  const result=record.fields.trajectory.value as unknown as ResistanceExperimentResult;
  return [
    '# method='+record.method.id+'; version='+record.method.version+'; result='+record.resultId+'; seed='+record.seed,
    '# Illustrative stochastic model only; not fitted to a selected phage, host or treatment.',
    ['time_hours','sensitive','partial_resistant','fully_resistant','total_phage'].join('\t'),
    ...result.trajectory.map(row=>[row.t,row.sensitive,row.partialResistant,row.fullyResistant,row.totalPhage].join('\t')),
  ].join('\n')+'\n';
}
