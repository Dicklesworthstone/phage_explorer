/** Sourced COBRA-JSON host models and explicit, conditional reaction-bound experiments.
 * Reuses the project's bounded simplex; no name/Pfam-to-capacity inference is made.
 * Standard FVA: extrema subject to the scenario's objective floor, not confidence intervals.
 */
import { FBASimplexSolver, type FBAStatus } from './amg-flux';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisJson, type AnalysisRecord } from '../analysis-result';

export const HOST_FLUX_LIMITS = { bytes: 2 * 1024 * 1024, reactions: 200, metabolites: 200, variability: 12, changes: 50 } as const;
export interface ReactionBounds { reactionId: string; lowerBound: number; upperBound: number }
export interface HostModelSource {
  kind: 'local' | 'reference' | 'demo'; name: string; version: string;
  organism: string; strain: string; accession: string; reference: string; license: string;
  fluxUnits: string; objectiveUnits: string;
}
export interface HostModelInput {
  format: 'phage-explorer-host-model'; version: 1;
  source: HostModelSource;
  medium: { name: string; reference: string; bounds: ReactionBounds[] };
  /** Original COBRA document is retained, including compartments, GPRs and annotations. */
  cobra: AnalysisJson;
}
export interface HostReaction {
  id: string; name: string; subsystem: string; geneRule: string;
  stoichiometry: Record<string, number>; lowerBound: number; upperBound: number; objective: number;
}
export interface HostNetwork { id: string; metabolites: Array<{ id: string; compartment: string }>; reactions: HostReaction[] }
export interface HostFluxChange extends ReactionBounds {
  evidence: { kind: 'assumption' | 'annotation'; reference: string; description: string;
    gene: { accession: string; locusTag: string } | null };
}
export interface HostFluxOptions { changes: HostFluxChange[]; variability: string[]; objectiveLoss: number }
export interface FluxCertificate { maxBalanceResidual: number; maxBoundViolation: number; objectiveResidual: number }
export interface FluxEndpoint { status: FBAStatus; value: number | null; certificate: FluxCertificate | null }
export interface FluxRange { reactionId: string; minimum: FluxEndpoint; maximum: FluxEndpoint }
export interface HostFluxScenario {
  status: FBAStatus; objective: number | null; fluxes: Record<string, number>; certificate: FluxCertificate | null;
  bounds: ReactionBounds[]; objectiveFloor: number | null; objectiveSlack: number | null; ranges: FluxRange[];
}
export interface HostFluxResult {
  options: HostFluxOptions; baseline: HostFluxScenario; perturbed: HostFluxScenario | null;
  objectiveDelta: number | null; percentChange: number | null;
  rangeChanges: Array<{ reactionId: string; lower: number | null; upper: number | null;
    interpretation: 'increased' | 'decreased' | 'overlapping' | 'unavailable' }>;
  warnings: string[];
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, label: string, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error(`${label} requires nonempty text without control characters.`);
  return v.trim();
}
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error(`Unsupported ${label} field; custom constraints are not silently discarded.`);
}
function finite(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) throw new Error(`${label} must be finite and at most 1000000 in magnitude.`);
  return v;
}
function bounded(v: unknown): ReactionBounds {
  if (!obj(v)) throw new Error('Reaction bounds must be objects.');
  const reactionId = text(v.reactionId, 'Reaction ID', 256), lowerBound = finite(v.lowerBound, 'Lower bound'), upperBound = finite(v.upperBound, 'Upper bound');
  if (lowerBound > upperBound) throw new Error(`Lower bound exceeds upper bound for ${reactionId}.`);
  return { reactionId, lowerBound, upperBound };
}
function unique(ids: string[], label: string): void { if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs.`); }
function size(v: unknown): void { if (new TextEncoder().encode(JSON.stringify(v)).length > HOST_FLUX_LIMITS.bytes) throw new Error('Host model exceeds the 2 MiB limit.'); }

/** Strict finite-bounded subset of the COBRApy/Escher JSON format; not SBML or arbitrary optlang constraints. */
export function parseCobraHostModel(value: unknown): HostNetwork {
  size(value);
  if (!obj(value)) throw new Error('Supply a COBRA JSON object.');
  keys(value, ['id','name','description','metabolites','reactions','genes','compartments','version','notes','annotation','objective_direction'], 'COBRA model');
  if (value.objective_direction !== undefined && value.objective_direction !== 'max') throw new Error('Only explicitly maximized linear COBRA objectives are supported.');
  if (!Array.isArray(value.metabolites) || !value.metabolites.length || value.metabolites.length > HOST_FLUX_LIMITS.metabolites ||
    !Array.isArray(value.reactions) || !value.reactions.length || value.reactions.length > HOST_FLUX_LIMITS.reactions) throw new Error('Host models require 1–200 metabolites and 1–200 reactions.');
  const metabolites = value.metabolites.map(m => {
    if (!obj(m)) throw new Error('Invalid COBRA metabolite.');
    keys(m, ['id','name','compartment','charge','formula','notes','annotation'], 'COBRA metabolite');
    return { id: text(m.id,'Metabolite ID',256), compartment: text(m.compartment,'Metabolite compartment',256) };
  });
  unique(metabolites.map(m => m.id), 'metabolite');
  const known = new Set(metabolites.map(m => m.id));
  if (value.compartments !== undefined && (!obj(value.compartments) || metabolites.some(m => !Object.hasOwn(value.compartments as object, m.compartment)))) throw new Error('A declared compartment is missing from the model compartment map.');
  if (value.genes !== undefined) {
    if (!Array.isArray(value.genes) || value.genes.length > 5000) throw new Error('Invalid COBRA gene list.');
    unique(value.genes.map(g => { if (!obj(g)) throw new Error('Invalid gene.'); return text(g.id,'Gene ID',256); }), 'gene');
  }
  const reactions = value.reactions.map(r => {
    if (!obj(r) || !obj(r.metabolites)) throw new Error('COBRA reactions require metabolite coefficients.');
    keys(r, ['id','name','metabolites','lower_bound','upper_bound','gene_reaction_rule','objective_coefficient','subsystem','notes','annotation'], 'COBRA reaction');
    const bounds = bounded({ reactionId:r.id, lowerBound:r.lower_bound, upperBound:r.upper_bound });
    const coefficients = Object.entries(r.metabolites).map(([id,c]) => {
      if (!known.has(id)) throw new Error(`Undeclared metabolite: ${id}`);
      return [id, finite(c,'Stoichiometric coefficient')] as const;
    }).filter(([,c]) => c !== 0);
    if (!coefficients.length) throw new Error(`Reaction ${bounds.reactionId} has no stoichiometry.`);
    if (r.gene_reaction_rule !== undefined && (typeof r.gene_reaction_rule !== 'string' || r.gene_reaction_rule.length > 10000)) throw new Error('Invalid gene-reaction rule.');
    return { id: bounds.reactionId, name: r.name === undefined || r.name === '' ? bounds.reactionId : text(r.name,'Reaction name'),
      subsystem: typeof r.subsystem === 'string' ? r.subsystem : '', geneRule: (r.gene_reaction_rule as string | undefined) ?? '',
      stoichiometry: Object.fromEntries(coefficients), lowerBound:bounds.lowerBound, upperBound:bounds.upperBound,
      objective: r.objective_coefficient === undefined ? 0 : finite(r.objective_coefficient,'Objective coefficient') };
  });
  unique(reactions.map(r => r.id), 'reaction');
  if (!reactions.some(r => r.objective !== 0)) throw new Error('An explicit nonzero linear objective is required; no biomass reaction is guessed.');
  return { id:text(value.id,'Model ID',256), metabolites, reactions };
}
export function validateHostModelInput(value: unknown): HostModelInput {
  if (!obj(value) || value.format !== 'phage-explorer-host-model' || value.version !== 1 || !obj(value.source) || !obj(value.medium)) throw new Error('Unsupported host-model format/version.');
  keys(value, ['format','version','source','medium','cobra'], 'host-model');
  keys(value.source, ['kind','name','version','organism','strain','accession','reference','license','fluxUnits','objectiveUnits'], 'host-model source');
  if (!['local','reference','demo'].includes(String(value.source.kind))) throw new Error('Host source must be local, reference or demo.');
  const source = {kind:value.source.kind} as HostModelSource;
  for (const key of ['name','version','organism','strain','accession','reference','license','fluxUnits','objectiveUnits'] as const) source[key] = text(value.source[key],key);
  const cobra = analysisJson(value.cobra), network = parseCobraHostModel(cobra);
  keys(value.medium, ['name','reference','bounds'], 'medium');
  if (!Array.isArray(value.medium.bounds) || value.medium.bounds.length > HOST_FLUX_LIMITS.reactions) throw new Error('Supply a medium-bound list, even when retaining all source-model bounds.');
  const bounds = value.medium.bounds.map(v => { if (!obj(v)) throw new Error('Invalid medium bound.'); keys(v,['reactionId','lowerBound','upperBound'],'medium bound'); return bounded(v); });
  unique(bounds.map(b => b.reactionId),'medium reaction');
  if (bounds.some(b => !network.reactions.some(r => r.id === b.reactionId))) throw new Error('A medium reaction is absent from this host model.');
  const result: HostModelInput = {format:'phage-explorer-host-model',version:1,source,cobra,
    medium:{ name:text(value.medium.name,'Medium name'), reference:text(value.medium.reference,'Medium reference/assumptions'), bounds }};
  size(result); return result;
}
export function resolveHostFluxOptions(value: unknown = {}): HostFluxOptions {
  if (!obj(value)) throw new Error('Host flux settings must be an object.');
  keys(value,['changes','variability','objectiveLoss'],'host-flux parameter');
  const rawChanges=value.changes ?? [], rawVariability=value.variability ?? [], objectiveLoss=finite(value.objectiveLoss ?? 0,'Allowed objective loss');
  if (objectiveLoss<0 || !Array.isArray(rawChanges) || rawChanges.length>HOST_FLUX_LIMITS.changes || !Array.isArray(rawVariability) || rawVariability.length>HOST_FLUX_LIMITS.variability) throw new Error('Use at most 50 changes and 12 variability reactions, with nonnegative objective loss.');
  const changes=rawChanges.map(c => {
    if(!obj(c)||!obj(c.evidence))throw new Error('Every reaction change requires explicit evidence or an assumption.');
    keys(c,['reactionId','lowerBound','upperBound','evidence'],'reaction change');
    keys(c.evidence,['kind','reference','description','gene'],'change evidence');
    if(!['assumption','annotation'].includes(String(c.evidence.kind)))throw new Error('Unsupported mapping evidence kind.');
    const gene=c.evidence.gene;
    if(gene!==null && !obj(gene))throw new Error('Mapping gene must be a sourced accession/locus tag or null.');
    if(obj(gene))keys(gene,['accession','locusTag'],'mapped gene');
    if(c.evidence.kind==='annotation'&&!gene)throw new Error('Annotation mappings require an explicit source-gene accession and locus tag.');
    return {...bounded(c),evidence:{kind:c.evidence.kind as 'assumption'|'annotation',reference:text(c.evidence.reference,'Mapping reference'),
      description:text(c.evidence.description,'Capacity-change assumption'),gene:gene?{accession:text(gene.accession,'Gene accession'),locusTag:text(gene.locusTag,'Gene locus tag')}:null}};
  });
  unique(changes.map(c=>c.reactionId),'changed reaction');
  const variability=rawVariability.map(id=>text(id,'Variability reaction',256));unique(variability,'variability reaction');
  return {changes,variability,objectiveLoss};
}
function mediumNetwork(input:HostModelInput):HostNetwork {
  const model=parseCobraHostModel(input.cobra),bounds=new Map(input.medium.bounds.map(b=>[b.reactionId,b]));
  return {...model,reactions:model.reactions.map(r=>({...r,...(bounds.has(r.id)?{lowerBound:bounds.get(r.id)!.lowerBound,upperBound:bounds.get(r.id)!.upperBound}:{})}))};
}
function solve(model:HostNetwork,objective:number[],floor?:number):{status:FBAStatus;value:number|null;fluxes:Record<string,number>;certificate:FluxCertificate|null} {
  const ids=model.reactions.map(r=>r.id), lb=model.reactions.map(r=>r.lowerBound),ub=model.reactions.map(r=>r.upperBound);
  const matrix=model.metabolites.map(m=>model.reactions.map(r=>Object.hasOwn(r.stoichiometry,m.id)?r.stoichiometry[m.id]:0)), cost=[...objective];
  if(floor!==undefined){
    // Objective c.v is represented by an auxiliary variable with a lower bound.
    // This keeps the existing equality+box LP solver unchanged and supports signed objectives.
    let aux='__objective_floor';while(ids.includes(aux))aux+='_';ids.push(aux);lb.push(floor);
    ub.push(Math.max(floor,model.reactions.reduce((s,r)=>s+Math.max(r.objective*r.lowerBound,r.objective*r.upperBound),0)));
    matrix.forEach(row=>row.push(0));matrix.push([...model.reactions.map(r=>r.objective),-1]);cost.push(0);
  }
  const answer=new FBASimplexSolver(matrix,lb,ub,cost,ids).solve();
  if(answer.status!=='optimal'||answer.objective===null)return {status:answer.status==='optimal'?'numerical_error':answer.status,value:null,fluxes:{},certificate:null};
  const flux=model.reactions.map(r=>answer.fluxes[r.id]);
  const balance=model.metabolites.map(m=>model.reactions.reduce((s,r,j)=>s+(Object.hasOwn(r.stoichiometry,m.id)?r.stoichiometry[m.id]:0)*flux[j],0));
  const objectiveValue=flux.reduce((s,v,j)=>s+objective[j]*v,0);
  const certificate={maxBalanceResidual:Math.max(0,...balance.map(Math.abs)),maxBoundViolation:Math.max(0,...flux.flatMap((v,j)=>[model.reactions[j].lowerBound-v,v-model.reactions[j].upperBound])),
    objectiveResidual:Math.abs(objectiveValue-answer.objective)};
  const achieved=flux.reduce((s,v,j)=>s+model.reactions[j].objective*v,0);
  if(floor!==undefined&&achieved<floor-1e-7*Math.max(1,Math.abs(floor)))return {status:'numerical_error',value:null,fluxes:{},certificate:null};
  return {status:'optimal',value:objectiveValue,fluxes:Object.fromEntries(model.reactions.map((r,j)=>[r.id,flux[j]])),certificate};
}
function scenario(model:HostNetwork,options:HostFluxOptions,progress:(phase:string)=>void):HostFluxScenario {
  const answer=solve(model,model.reactions.map(r=>r.objective));
  const bounds=model.reactions.map(r=>({reactionId:r.id,lowerBound:r.lowerBound,upperBound:r.upperBound}));
  const result:HostFluxScenario={status:answer.status,objective:answer.value,fluxes:answer.fluxes,certificate:answer.certificate,bounds,objectiveFloor:null,objectiveSlack:null,ranges:[]};
  if(answer.status!=='optimal'||answer.value===null)return result;
  const slack=1e-7*Math.max(1,Math.abs(answer.value));
  result.objectiveSlack=slack;result.objectiveFloor=answer.value-options.objectiveLoss-slack;
  options.variability.forEach((id,i)=>{
    progress(`Flux ranges ${i+1}/${options.variability.length}`);
    const vector=model.reactions.map(r=>r.id===id?1:0);
    const lower=solve(model,vector.map(v=>-v),result.objectiveFloor!);
    const upper=solve(model,vector,result.objectiveFloor!);
    result.ranges.push({reactionId:id,minimum:{status:lower.status,value:lower.value===null?null:-lower.value,certificate:lower.certificate},
      maximum:{status:upper.status,value:upper.value,certificate:upper.certificate}});
  });
  return result;
}
export function analyzeHostMetabolism(value:HostModelInput,settings:Partial<HostFluxOptions>={},progress:(phase:string)=>void=()=>{}):HostFluxResult {
  const input=validateHostModelInput(value),options=resolveHostFluxOptions(settings),network=mediumNetwork(input),known=new Set(network.reactions.map(r=>r.id));
  if([...options.changes.map(c=>c.reactionId),...options.variability].some(id=>!known.has(id)))throw new Error('An explicit mapped/variability reaction is absent from the selected model. No replacement is guessed.');
  progress('Solving supplied host model and medium');const baseline=scenario(network,options,progress);
  const edits=new Map(options.changes.map(c=>[c.reactionId,c]));
  progress('Solving simultaneous reaction-bound scenario');
  const perturbed=options.changes.length?scenario({...network,reactions:network.reactions.map(r=>({...r,...(edits.has(r.id)?{lowerBound:edits.get(r.id)!.lowerBound,upperBound:edits.get(r.id)!.upperBound}:{})}))},options,progress):null;
  const comparable=baseline.status==='optimal'&&perturbed?.status==='optimal';
  const rangeChanges:HostFluxResult['rangeChanges']=options.variability.map(id=>{
    const a=baseline.ranges.find(r=>r.reactionId===id),b=perturbed?.ranges.find(r=>r.reactionId===id);
    if(!a||!b||[a.minimum,a.maximum,b.minimum,b.maximum].some(v=>v.status!=='optimal'||v.value===null))return {reactionId:id,lower:null,upper:null,interpretation:'unavailable'};
    const lower=b.minimum.value!-a.maximum.value!,upper=b.maximum.value!-a.minimum.value!;
    const tolerance=1e-6*Math.max(1,...[a.minimum,a.maximum,b.minimum,b.maximum].map(v=>Math.abs(v.value!)));
    return {reactionId:id,lower,upper,interpretation:lower>tolerance?'increased':upper< -tolerance?'decreased':'overlapping'};
  });
  const objectiveDelta=comparable?perturbed!.objective!-baseline.objective!:null;
  return {options,baseline,perturbed,objectiveDelta,percentChange:objectiveDelta!==null&&Math.abs(baseline.objective!)>1e-9?100*objectiveDelta/Math.abs(baseline.objective!):null,rangeChanges,warnings:[
    'This is a conditional steady-state model experiment, not measured host growth, viral burst yield, fitness or validated AMG activity.',
    'All medium overrides and reaction changes are explicit signed absolute bounds. Changes are applied simultaneously, never summed across independent gene experiments.',
    'Source, organism, medium and gene associations are supplied provenance, not independently verified by this program. No Pfam/name-based capacity mapping is inferred.',
    'Gene-reaction rules and chemical annotations are retained as metadata, not evaluated as kinetic, regulatory or thermodynamic constraints.',
    'A displayed flux vector is one optimum and may not be unique. Ranges constrain the objective within the recorded absolute loss plus numerical slack; they are not confidence intervals.',
    'Flux ranges permit cycles; no loopless or thermodynamic feasibility constraint is imposed. Stoichiometric balance is not a chemical element/charge balance certificate.',
    ...(input.source.kind==='demo'?['Explicit synthetic demonstration model; no organism-specific prediction is made.']:[]),
  ]};
}
const METHOD={id:'sourced-host-flux',version:'1',implementation:'COBRA JSON finite-bounded linear objective; existing two-phase simplex; explicit simultaneous bound edits; objective-floor FVA'};
export function createHostFluxRecord(input:HostModelInput,result:HostFluxResult):Promise<AnalysisRecord>{
  const dataset=validateHostModelInput(input),network=parseCobraHostModel(dataset.cobra);
  const field=(label:string,value:unknown)=>({label,kind:dataset.source.kind==='demo'?'demo' as const:'simulation' as const,units:'model-flux' as const,value:analysisJson(value),
    coverage:{available:network.reactions.length,total:network.reactions.length,unit:'reactions' as const},assumptions:['Maximize the supplied linear objective with S.v=0 and the exact recorded medium/scenario bounds.'],limitations:result.warnings});
  return createAnalysisRecord({method:METHOD,inputs:[{id:'hostModel',accession:dataset.source.accession,source:dataset.source.kind==='reference'?'external':dataset.source.kind,
    description:dataset.source.name,data:analysisJson(dataset)}],parameters:analysisJson(result.options) as AnalysisRecord['parameters'],seed:null,
    references:[{id:'host-model',version:dataset.source.version,description:dataset.source.reference},{id:'flux-variability',version:'Mahadevan-Schilling-2003',description:'Conditional flux ranges over alternative objective-constrained solutions; no unique flux-vector claim.'}],
    fields:{baseline:field('Supplied host and medium baseline (status included)',result.baseline),perturbed:field('Simultaneous mapped-bound scenario (null when no changes)',result.perturbed),
      comparison:field('Conditional objective difference and alternative-flux ranges',{objectiveDelta:result.objectiveDelta,percentChange:result.percentChange,rangeChanges:result.rangeChanges})}});
}
export async function replayHostFluxRecord(content:string,progress:(phase:string)=>void=()=>{}):Promise<{input:HostModelInput;result:HostFluxResult;record:AnalysisRecord}>{
  const saved=await parseAnalysisRecord(content,{methodId:METHOD.id,methodVersion:METHOD.version});
  if(saved.inputs.length!==1||saved.inputs[0].id!=='hostModel')throw new Error('Unsupported host experiment input contract.');
  const input=validateHostModelInput(saved.inputs[0].data),result=analyzeHostMetabolism(input,saved.parameters as Partial<HostFluxOptions>,progress),record=await createHostFluxRecord(input,result);
  if(record.resultId!==saved.resultId||record.cacheKey!==saved.cacheKey)throw new Error('Fresh host-model results differ from the saved experiment.');
  return {input,result,record};
}
