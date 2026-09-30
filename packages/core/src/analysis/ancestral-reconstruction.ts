/** Conditional nucleotide reconstruction on an explicitly homologous alignment.
 * JC69 or supplied reversible DNA models/site-rate mixtures; fixed tree/lengths.
 * Felsenstein (1981), doi:10.1007/BF01734359. Two-pass sum-product gives marginal
 * node states AND joint edge endpoints; multiplying marginal states is not equivalent.
 */
import { parseTemporalNewick, type TemporalNode } from './temporal-signal';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createNucleotideKernel, resolveNucleotideModel, type NucleotideModel } from './nucleotide-model';

export const ANCESTRAL_LIMITS = { bytes: 2 * 1024 * 1024, tips: 128, columns: 100000,
  inputCells: 2000000, window: 4096, patternNodes: 16000 } as const;
export const NUCLEOTIDES = ['A', 'C', 'G', 'T'] as const;
const MASKS: Record<string, number> = { A:1, C:2, G:4, T:8, R:5, Y:10, S:6, W:9, K:12, M:3,
  B:14, D:13, H:11, V:7, N:15, '?':15, '-':15 };
export interface AncestralDataset {
  format: 'phage-explorer-ancestral'; version: 1; name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string; license: string };
  tree: { newick: string; units: 'substitutions/site'; method: string; rooting: string };
  alignment: { fasta: string; homologous: true; method: string; reference: string };
}
export interface AncestralOptions {
  startColumn: number; endColumn: number; gapPolicy: 'missing' | 'exclude-column'; minPosterior: number;
  /** Omitted means the original fixed JC69 contract; supplied models retain their source. */
  substitution?: NucleotideModel;
}
export interface AncestralNode { id: string; label: string | null; parent: number | null; length: number; children: number[] }
export interface AncestralPattern {
  /** Input observation masks in tree-tip order, not a reconstructed sequence. */
  observations: string; logLikelihood: number | null;
  /** Nodes in result.nodes order; each vector is [A,C,G,T]. Null means zero likelihood. */
  nodes: number[][] | null;
  /** Entry i corresponds to result.nodes[i+1]'s incoming edge. Row-major parent/child A,C,G,T. */
  edges: number[][] | null;
  /** Whole-site rate-category probabilities conditional on all tip observations. */
  categoryPosterior?: number[] | null;
}
export interface AncestralSite {
  column: number; resolvedTips: number; ambiguousTips: number; missingTips: number;
  pattern: number | null; exclusion: 'gap' | 'all-missing' | 'zero-likelihood' | null;
}
export interface AncestralResult {
  options: AncestralOptions; nodes: AncestralNode[]; tipOrder: string[]; alignmentColumns: number;
  sites: AncestralSite[]; patterns: AncestralPattern[];
  analyzedColumns: number; excludedColumns: number; impossibleColumns: number;
  /** Sum over included columns; null when any included observation has zero likelihood. */
  logLikelihood: number | null; warnings: string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, name: string, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error(`${name} needs nonempty text without control characters.`);
  return v.trim();
}
function keys(v: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error(`Unsupported ${name} field.`);
}
function boundedText(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || new TextEncoder().encode(v).length > ANCESTRAL_LIMITS.bytes) throw new Error(`${name} exceeds the 2 MiB input limit.`);
}
/** Whole trimmed FASTA headers are exact tip IDs. Whitespace in sequence lines is formatting only. */
export function parseAncestralFasta(content: string): Array<{ id: string; sequence: string }> {
  boundedText(content, 'Alignment');
  const rows: Array<{ id: string; sequence: string }> = []; const ids = new Set<string>();
  let parts: string[] = [], length = 0, cells = 0;
  const finish = () => { if (rows.length) rows[rows.length - 1].sequence = parts.join(''); parts = []; length = 0; };
  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('>')) {
      finish(); const id = text(line.slice(1), 'FASTA tip ID', 256);
      if (ids.has(id)) throw new Error('Duplicate FASTA tip ID.'); ids.add(id);
      if (rows.length >= ANCESTRAL_LIMITS.tips) throw new Error('At most 128 alignment tips are supported.');
      rows.push({ id, sequence: '' });
    } else {
      if (!rows.length) throw new Error('Alignment sequences require FASTA headers.');
      const sequence = line.replace(/\s/g, '').toUpperCase();
      if (!/^[ACGTRYSWKMBDHVN?-]+$/.test(sequence)) throw new Error('Alignment must contain DNA IUPAC bases, ? or -; RNA/protein symbols are not silently converted.');
      length += sequence.length; cells += sequence.length;
      if (length > ANCESTRAL_LIMITS.columns || cells > ANCESTRAL_LIMITS.inputCells) throw new Error('Alignment exceeds the column/cell budget.');
      parts.push(sequence);
    }
  }
  finish();
  if (rows.length < 2 || !rows[0].sequence.length || rows.some(r => r.sequence.length !== rows[0].sequence.length)) throw new Error('Supply at least two nonempty, equally aligned FASTA sequences. Equal length alone does not establish homology.');
  return rows;
}
function flatten(root: TemporalNode): AncestralNode[] {
  const nodes: AncestralNode[] = [];
  const visit = (node: TemporalNode, parent: number | null): number => {
    const index = nodes.length;
    nodes.push({ id: `n${index}`, label: node.label, parent, length: node.length, children: [] });
    nodes[index].children = node.children.map(child => visit(child, index)); return index;
  };
  visit(root, null); return nodes;
}
export function validateAncestralDataset(value: unknown): AncestralDataset {
  if (!object(value) || value.format !== 'phage-explorer-ancestral' || value.version !== 1 || !object(value.source) || !object(value.tree) || !object(value.alignment)) throw new Error('Unsupported ancestral dataset format/version.');
  boundedText(JSON.stringify(value), 'Dataset');
  keys(value, ['format','version','name','source','tree','alignment'], 'ancestral dataset');
  keys(value.source, ['kind','description','reference','license'], 'source');
  keys(value.tree, ['newick','units','method','rooting'], 'tree');
  keys(value.alignment, ['fasta','homologous','method','reference'], 'alignment');
  if (!['local','demo'].includes(String(value.source.kind)) || value.tree.units !== 'substitutions/site' || value.alignment.homologous !== true) throw new Error('Declare homologous DNA alignment and a rooted tree in substitutions/site; time-scaled trees and equal-length raw genomes are not sufficient.');
  boundedText(value.tree.newick, 'Tree'); boundedText(value.alignment.fasta, 'Alignment');
  const rows = parseAncestralFasta(value.alignment.fasta), nodes = flatten(parseTemporalNewick(value.tree.newick));
  const tips = nodes.filter(n => !n.children.length);
  if (tips.length !== rows.length || tips.some(n => !rows.some(r => r.id === n.label))) throw new Error('FASTA IDs must match every tree tip exactly; unquoted Newick underscores mean spaces. No samples are silently pruned.');
  return { format:'phage-explorer-ancestral', version:1, name:text(value.name,'Dataset name'),
    source:{ kind:value.source.kind as 'local'|'demo', description:text(value.source.description,'Source description'), reference:text(value.source.reference,'Source reference'), license:text(value.source.license,'License/permission') },
    tree:{ newick:value.tree.newick, units:'substitutions/site', method:text(value.tree.method,'Tree method'), rooting:text(value.tree.rooting,'Rooting evidence') },
    alignment:{ fasta:value.alignment.fasta, homologous:true, method:text(value.alignment.method,'Alignment method'), reference:text(value.alignment.reference,'Alignment homology evidence') } };
}
export function resolveAncestralOptions(columns: number, settings: unknown = {}): AncestralOptions {
  if (!object(settings)) throw new Error('Ancestral settings must be an object.');
  keys(settings, ['startColumn','endColumn','gapPolicy','minPosterior','substitution'], 'ancestral parameter');
  const startColumn = settings.startColumn ?? 1, endColumn = settings.endColumn ?? Math.min(columns, ANCESTRAL_LIMITS.window);
  const gapPolicy = settings.gapPolicy ?? 'missing', minPosterior = settings.minPosterior ?? 0.9;
  if (!Number.isSafeInteger(startColumn) || !Number.isSafeInteger(endColumn) || Number(startColumn) < 1 || Number(endColumn) > columns || Number(endColumn) < Number(startColumn) || Number(endColumn)-Number(startColumn)+1 > ANCESTRAL_LIMITS.window) throw new Error('Select an inclusive, 1-based alignment window of at most 4096 columns.');
  if (!['missing','exclude-column'].includes(String(gapPolicy)) || typeof minPosterior !== 'number' || !Number.isFinite(minPosterior) || minPosterior < 0.25 || minPosterior > 1) throw new Error('Use a supported gap policy and a posterior threshold between 0.25 and 1.');
  return { startColumn:Number(startColumn), endColumn:Number(endColumn), gapPolicy:gapPolicy as AncestralOptions['gapPolicy'], minPosterior,
    ...(settings.substitution === undefined ? {} : { substitution: resolveNucleotideModel(settings.substitution) }) };
}
function logSum(values: number[]): number {
  const m = Math.max(...values); if (m === -Infinity) return m;
  return m + Math.log(values.reduce((s, v) => s + Math.exp(v - m), 0));
}
function probabilities(logs: number[]): number[] {
  const total = logSum(logs);
  if (!Number.isFinite(total)) throw new Error('Nonfinite conditional state normalization.');
  return logs.map(v => Math.exp(v - total));
}
/** Stable at tiny branches, where 1-exp(-4t/3) would cancel. Zero length remains exactly zero. */
function transition(length: number): number[] {
  const different = -Math.expm1(-4 * length / 3) / 4, same = 1 - 3 * different;
  return Array.from({ length:16 }, (_, i) => Math.log(Math.floor(i / 4) === i % 4 ? same : different));
}
function reconstructPattern(nodes: AncestralNode[], tips: number[], observations: string, transitions: number[][],
  prior: number[] = [0.25,0.25,0.25,0.25]): AncestralPattern {
  const up = nodes.map(() => [0,0,0,0]), messages = nodes.map(() => [0,0,0,0]);
  tips.forEach((index, i) => { const mask = parseInt(observations[i],16); up[index] = NUCLEOTIDES.map((_, s) => mask & (1 << s) ? 0 : -Infinity); });
  for (let n = nodes.length - 1; n >= 0; n--) {
    if (nodes[n].children.length) up[n] = NUCLEOTIDES.map((_, s) => nodes[n].children.reduce((sum,c) => sum + messages[c][s],0));
    if (n) messages[n] = NUCLEOTIDES.map((_, s) => logSum(up[n].map((v,t) => transitions[n][s*4+t]+v)));
  }
  const rootPrior = prior.map(Math.log);
  const logLikelihood = logSum(up[0].map((v,s) => v + rootPrior[s]));
  if (logLikelihood === -Infinity) return { observations, logLikelihood:null, nodes:null, edges:null };
  if (!Number.isFinite(logLikelihood)) throw new Error('Nonfinite alignment likelihood.');
  const down = nodes.map(() => [0,0,0,0]); down[0] = rootPrior;
  const posteriors: number[][] = [], edges: number[][] = new Array(nodes.length - 1);
  for (let n = 0; n < nodes.length; n++) {
    posteriors[n] = probabilities(up[n].map((v,s) => v + down[n][s]));
    const children = nodes[n].children;
    // Prefix/suffix products in log space avoid 0/0 when excluding a child's
    // evidence and avoid O(degree^2) work on large polytomies.
    const prefix = [[0,0,0,0]], suffix: number[][] = new Array(children.length + 1);
    suffix[children.length] = [0,0,0,0];
    children.forEach((child,i) => { prefix.push(prefix[i].map((v,s) => v + messages[child][s])); });
    for (let i=children.length-1; i>=0; i--) suffix[i] = suffix[i+1].map((v,s) => v+messages[children[i]][s]);
    children.forEach((child,i) => {
      const outside = down[n].map((v,s) => v+prefix[i][s]+suffix[i+1][s]);
      down[child] = NUCLEOTIDES.map((_, t) => logSum(outside.map((v,s) => v+transitions[child][s*4+t])));
      edges[child-1] = probabilities(Array.from({ length:16 }, (_,j) => outside[Math.floor(j/4)]+transitions[child][j]+up[child][j%4]));
    });
  }
  return { observations, logLikelihood, nodes:posteriors, edges };
}

/** Integrate a single latent rate category shared by ALL branches at this site.
 * Prior-weight averaging of posteriors or of edge transition matrices is wrong:
 * the observed tips change category probabilities via the full-site likelihood.
 */
function reconstructMixture(nodes: AncestralNode[], tips: number[], observations: string,
  transitions: number[][][], prior: number[], weights: number[]): AncestralPattern {
  const categories = transitions.map(matrix => reconstructPattern(nodes, tips, observations, matrix, prior));
  const weighted = categories.map((category, i) => category.logLikelihood === null ? -Infinity : Math.log(weights[i]) + category.logLikelihood);
  const logLikelihood = logSum(weighted);
  if (logLikelihood === -Infinity) return { observations, logLikelihood: null, nodes: null, edges: null, categoryPosterior: null };
  const categoryPosterior = probabilities(weighted);
  const average = (kind: 'nodes' | 'edges', count: number, states: number): number[][] =>
    Array.from({ length: count }, (_, n) => Array.from({ length: states }, (_, s) =>
      categories.reduce((sum, category, i) => sum + categoryPosterior[i] * (category[kind]?.[n][s] ?? 0), 0)));
  return { observations, logLikelihood, nodes: average('nodes', nodes.length, 4),
    edges: average('edges', nodes.length - 1, 16), categoryPosterior };
}
export function reconstructAncestors(value: AncestralDataset, settings: unknown = {}, progress: (phase: string) => void = () => {}): AncestralResult {
  const input = validateAncestralDataset(value), rows = parseAncestralFasta(input.alignment.fasta);
  const options = resolveAncestralOptions(rows[0].sequence.length,settings), nodes = flatten(parseTemporalNewick(input.tree.newick));
  const tips = nodes.flatMap((n,i) => n.children.length ? [] : [i]), tipOrder=tips.map(i=>nodes[i].label!);
  const aligned = tipOrder.map(id=>rows.find(r=>r.id===id)!.sequence);
  const model = options.substitution, kernel = model ? createNucleotideKernel(model) : null;
  const categories = model?.siteRates ?? [{ rate: 1, weight: 1 }];
  const transitions = categories.map(category => nodes.map(n => {
    const length = n.length * category.rate;
    if (n.length > 0 && category.rate > 0 && length === 0) throw new Error('Effective branch length underflow; no zero-length branch is substituted.');
    return kernel ? kernel.logTransition(length) : transition(length);
  }));
  const sites: AncestralSite[]=[], patterns: AncestralPattern[]=[], cache=new Map<string,number>();
  let analyzedColumns=0, impossibleColumns=0, logLikelihood=0;
  for (let column=options.startColumn; column<=options.endColumn; column++) {
    if ((column-options.startColumn)%64===0) progress(`Reconstructing alignment columns ${column-options.startColumn+1}/${options.endColumn-options.startColumn+1}`);
    const letters=aligned.map(row=>row[column-1]), masks=letters.map(c=>MASKS[c]);
    const missingTips=masks.filter(m=>m===15).length, resolvedTips=masks.filter(m=>(m&(m-1))===0).length;
    const site: AncestralSite={column,resolvedTips,missingTips,ambiguousTips:tips.length-missingTips-resolvedTips,pattern:null,exclusion:null};
    if (options.gapPolicy==='exclude-column' && letters.includes('-')) site.exclusion='gap';
    else if (missingTips===tips.length) site.exclusion='all-missing';
    else {
      const key=masks.map(m=>m.toString(16)).join(''); let index=cache.get(key);
      if (index===undefined) {
        if ((patterns.length+1)*nodes.length*categories.length>ANCESTRAL_LIMITS.patternNodes) throw new Error('Ancestral posterior output exceeds the pattern/node budget (including rate categories). Select a narrower alignment window; no partial result is published.');
        index=patterns.length; cache.set(key,index);
        patterns.push(kernel ? reconstructMixture(nodes,tips,key,transitions,kernel.frequencies,categories.map(c=>c.weight))
          : reconstructPattern(nodes,tips,key,transitions[0]));
      }
      site.pattern=index;
      if (patterns[index].logLikelihood===null) { site.exclusion='zero-likelihood'; impossibleColumns++; }
      else { analyzedColumns++; logLikelihood+=patterns[index].logLikelihood!; }
    }
    sites.push(site);
  }
  return { options,nodes,tipOrder,alignmentColumns:rows[0].sequence.length,sites,patterns,analyzedColumns,
    excludedColumns:sites.length-analyzedColumns-impossibleColumns,impossibleColumns,
    logLikelihood:impossibleColumns || !analyzedColumns ? null : logLikelihood,warnings:[
      ...(model ? [
        `${model.model} uses the supplied stationary reversible DNA model and its stationary root prior. The generator has mean rate one; supplied branch lengths remain expected substitutions/site.`,
        'A rate category is shared across all branches of each site and integrated using its full-site likelihood. Supplied weights are priors, not site-posterior weights. A zero rate is an invariant category, not a zero branch in every category.',
        `Model and site-rate source/assumption: ${model.source}. Parameters are fixed, not estimated or independently verified. Sites are independent; no empirical confidence, topology search or model-adequacy test is supplied.`,
      ] : ['JC69 assumes equal stationary base frequencies and equal substitution rates, independent sites, and fixed supplied topology/root/branch lengths. Model adequacy and tree/alignment uncertainty are not estimated.']),
      'Posteriors are conditional state probabilities under this model, not empirical confidence or biological validation. No branch lengths or parameters are fitted.',
      'IUPAC ambiguity constrains allowed observed bases; N and ? are missing. Gaps follow the recorded policy and are not a fifth evolutionary state or an indel model.',
      'Edge probabilities describe joint parent/child endpoint states. Endpoint differences are not substitution counts, event dates, selection scores or a reconstructed mutation history.',
      'Columns with no information or zero model likelihood have no reconstructed probabilities. Consensus uses N for excluded, impossible, tied or below-threshold sites. Coordinates are original 1-based alignment columns.',
      ...(input.source.kind==='demo'?['Explicit synthetic example; no empirical reference accuracy is claimed.']:[]),
    ] };
}
/** Display/export the accepted result's threshold, never silently reinterpret it using draft settings. */
export function ancestralConsensus(result: AncestralResult, nodeId: string): string {
  const index=result.nodes.findIndex(n=>n.id===nodeId); if(index<0)throw new Error('Unknown ancestral node.');
  return result.sites.map(site=>{
    const p=site.exclusion || site.pattern===null ? null : result.patterns[site.pattern].nodes?.[index];
    if(!p)return 'N'; const maximum=Math.max(...p), best=p.flatMap((v,i)=>Math.abs(v-maximum)<=1e-12?[i]:[]);
    return maximum>=result.options.minPosterior && best.length===1 ? NUCLEOTIDES[best[0]]:'N';
  }).join('');
}
export function ancestralFasta(result: AncestralResult): string {
  return result.nodes.filter(n=>n.children.length).map(node=>`>${node.id} conditional-${result.options.substitution?.model??'JC69'}${result.options.substitution?` rate-categories=${result.options.substitution.siteRates.length}`:''} columns=${result.options.startColumn}-${result.options.endColumn} threshold=${result.options.minPosterior}\n${ancestralConsensus(result,node.id).match(/.{1,80}/g)?.join('\n')??''}`).join('\n')+'\n';
}
const METHOD={id:'ancestral-jc69',version:'1',implementation:'Log-space two-pass sum-product; fixed rooted substitution-length tree; IUPAC observation masks; joint edge endpoints'};
const REVERSIBLE_METHOD={id:'ancestral-reversible-dna',version:'1',implementation:'Mean-rate-one JC69/HKY85/GTR; nonnegative uniformization; stationary root prior; whole-site rate mixture; two-pass joint edge endpoints'};
export function createAncestralRecord(input: AncestralDataset, result: AncestralResult): Promise<AnalysisRecord> {
  const dataset=validateAncestralDataset(input), model=result.options.substitution;
  if(model)resolveNucleotideModel(model);
  return createAnalysisRecord({method:model?REVERSIBLE_METHOD:METHOD,inputs:[{id:'alignmentTree',accession:null,source:dataset.source.kind,description:dataset.name,data:analysisJson(dataset)}],
    parameters:analysisJson(result.options) as AnalysisRecord['parameters'],seed:null,
    references:[{id:'likelihood-pruning',version:'Felsenstein-1981',description:'doi:10.1007/BF01734359; fixed-tree likelihood by summing ancestral states.'},
      model?{id:'substitution-model',version:model.model,description:`Q_ij=r_ij*pi_j, normalized by -sum(pi_i*Q_ii); shared site-rate categories with mean one. Supplied source/assumption: ${model.source}`}
        :{id:'substitution-model',version:'JC69',description:'P_same(t)=1/4+3/4 exp(-4t/3); P_different(t)=1/4-1/4 exp(-4t/3); t is substitutions/site, uniform root prior.'}],
    fields:{reconstruction:{label:'Conditional ancestral states and joint branch endpoints',kind:dataset.source.kind==='demo'?'demo':'simulation',units:'records',value:analysisJson(result),
      coverage:{available:result.analyzedColumns,total:result.sites.length,unit:'bases'},assumptions:[model?'Exact recorded homologous alignment, supplied reversible DNA model and site-rate mixture, fixed tree and branch lengths; no estimated alignment or model-parameter uncertainty.':'Exact recorded homologous alignment, JC69, fixed tree and branch lengths; no estimated alignment or model-parameter uncertainty.'],limitations:result.warnings}}});
}
export async function replayAncestralRecord(content: string, progress: (phase:string)=>void=()=>{}): Promise<{input:AncestralDataset;result:AncestralResult;record:AnalysisRecord}> {
  const saved=await parseAnalysisRecord(content);
  if(![METHOD,REVERSIBLE_METHOD].some(method=>method.id===saved.method.id&&method.version===saved.method.version))throw new Error('Analysis method/version is incompatible.');
  if(saved.inputs.length!==1||saved.inputs[0].id!=='alignmentTree')throw new Error('Unsupported ancestral input contract.');
  const input=validateAncestralDataset(saved.inputs[0].data), result=reconstructAncestors(input,saved.parameters,progress), record=await createAncestralRecord(input,result);
  if(record.resultId!==saved.resultId||record.cacheKey!==saved.cacheKey)throw new Error('Fresh ancestral evidence differs from the saved experiment.');
  return {input,result,record};
}
