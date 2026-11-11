/** Database-free conditional pairwise dN/dS on explicitly homologous coding alignments. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  CODON_SELECTION_LIMITS, CODON_GENETIC_CODES, validateCodonAlignment, analyzeCodonSelection,
  createCodonSelectionRecord, replayCodonSelectionRecord, resolveCodonSelectionOptions,
  type CodonAlignmentInput, type CodonSelectionOptions, type CodonSelectionResult, type CodonGeneticCode,
} from '../../../core/src/analysis/codon-selection';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT=10*1024*1024, PARAM_LIMIT=128*1024;

export const CODON_SELECTION_HELP=`Conditional aligned-CDS pairwise dN/dS (local files only)

  phage-explorer codon-selection prepare ALIGNMENT_FASTA --name NAME
    --source DESCRIPTION --reference CITATION --license LICENSE
    --alignment-method METHOD --homology-reference EVIDENCE --genetic-code 1|4|11|15|25
    [--demo] [--output NEW_FILE]

  phage-explorer codon-selection inspect DATASET_JSON
  phage-explorer codon-selection analyze DATASET_JSON [--params FILE]
    [--format json|pairs|windows] [--output NEW_FILE]
  phage-explorer codon-selection replay SAVED_ANALYSIS
    [--format json|pairs|windows] [--output NEW_FILE]

prepare accepts 2..32 already aligned coding DNA sequences. Equal length, gene names
or genomic coordinates do NOT establish homology: the command requires explicit
homology/CDS provenance, coding 5'→3' orientation, frame zero and a stated NCBI
genetic code. Partial-codon gaps/frameshifts are refused.

--params accepts comparison (reference|all-pairs), referenceId, startCodon,
endCodon, windowCodons and missing (pairwise|complete). Coordinates are zero-based
half-open alignment codons.

The producer uses NG86-style equal mutation opportunities, averages sense-only
shortest paths, and applies separate JC69 corrections to pooled synonymous and
nonsynonymous counts. Saturation and dS=0 remain unavailable rather than clamped.
A descriptive dN/dS ratio is NOT a statistical test/classification of selection,
a branch estimate, fitness prediction or proof of homology.
`;

export type CodonSelectionOperation='prepare'|'inspect'|'analyze'|'replay';
export interface CodonSelectionCommand{
  operation:CodonSelectionOperation;input:string;output?:string;params?:string;format:'json'|'pairs'|'windows';
  metadata?:{name:string;kind:'local'|'demo';description:string;reference:string;license:string;
    alignmentMethod:string;homologyReference:string;geneticCode:CodonGeneticCode};
}
export interface CodonSelectionJob{operation:'analyze'|'replay';input:{name:string;text:string};params?:string}
export interface CodonSelectionJobResult{content:string;pairs:string;windows:string;identity:string;verified:boolean}
export type CodonSelectionJobMessage=|{kind:'progress';message:string}|{kind:'result';result:CodonSelectionJobResult}|{kind:'error';message:string};
export interface CodonSelectionIO{stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal;execute?:typeof runCodonSelectionJob}

function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Codon-selection operation cancelled.','AbortError');}
function settings(text:string|undefined):Partial<CodonSelectionOptions>{
 if(text===undefined)return{};
 if(new TextEncoder().encode(text).length>PARAM_LIMIT)throw new Error('Codon-selection parameter JSON exceeds 128 KiB.');
 const value:unknown=JSON.parse(text.replace(/^\uFEFF/,''));
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Codon-selection parameters must be a JSON object.');
 return value as Partial<CodonSelectionOptions>;
}
function cell(value:string|number|null):string{return value===null?'':String(value).replace(/[\t\r\n]/g,' ');}
function pairTsv(result:CodonSelectionResult):string{
 return [
  '# Conditional aligned-CDS dN/dS; descriptive pairwise estimate, NOT a selection test.',
  ['left','right','start_codon','end_codon','retained','gap_excluded','ambiguous_excluded','stop_excluded','no_sense_path_excluded','complete_deletion_excluded',
   'synonymous_sites','nonsynonymous_sites','synonymous_differences','nonsynonymous_differences','dN','dN_status','dS','dS_status','omega','unavailable_reason'].join('\t'),
  ...result.pairs.map(pair=>{const x=pair.overall;return[pair.left,pair.right,x.startCodon,x.endCodon,x.retained,x.excluded.gap,x.excluded.ambiguous,x.excluded.stop,
    x.excluded['no-sense-path'],x.excluded['complete-deletion'],x.synonymousSites,x.nonsynonymousSites,x.synonymousDifferences,x.nonsynonymousDifferences,
    x.dN.value,x.dN.status,x.dS.value,x.dS.status,x.omega,x.unavailableReason??''].map(cell).join('\t');})
 ].join('\n')+'\n';
}
function windowTsv(result:CodonSelectionResult):string{
 return [
  '# Zero-based half-open alignment-codon windows; descriptive dN/dS, NOT independent selection tests.',
  ['left','right','start_codon','end_codon','retained','dN','dN_status','dS','dS_status','omega','unavailable_reason'].join('\t'),
  ...result.pairs.flatMap(pair=>pair.windows.map(x=>[pair.left,pair.right,x.startCodon,x.endCodon,x.retained,x.dN.value,x.dN.status,x.dS.value,x.dS.status,x.omega,x.unavailableReason??''].map(cell).join('\t')))
 ].join('\n')+'\n';
}
export async function executeCodonSelectionJob(job:CodonSelectionJob,progress:(message:string)=>void=()=>{}):Promise<CodonSelectionJobResult>{
 if(!job||!['analyze','replay'].includes(job.operation)||!job.input||typeof job.input.text!=='string')throw new Error('Unsupported codon-selection job.');
 const bytes=new TextEncoder().encode(job.input.text).length;
 if(bytes>(job.operation==='replay'?RECORD_LIMIT:CODON_SELECTION_LIMITS.bytes))throw new Error(job.operation==='replay'?'Saved codon evidence exceeds 10 MiB.':'Codon dataset exceeds 2 MiB.');
 let input:CodonAlignmentInput,result:CodonSelectionResult,record,verified=false;
 if(job.operation==='replay'){
  if(job.params!==undefined)throw new Error('Replay cannot override saved codon-selection settings.');
  progress('Recomputing aligned-codon evidence from exact saved inputs');
  ({input,result,record}=await replayCodonSelectionRecord(job.input.text.replace(/^\uFEFF/,''),progress));verified=true;
 }else{
  progress('Validating homologous coding alignment and genetic-code declaration');
  input=validateCodonAlignment(JSON.parse(job.input.text.replace(/^\uFEFF/,'')));
  const options=resolveCodonSelectionOptions(input,settings(job.params));
  progress('Counting synonymous/nonsynonymous opportunities and sense-only paths');
  result=analyzeCodonSelection(input,options,progress);record=await createCodonSelectionRecord(input,result);
 }
 return{content:serializeAnalysisRecord(record),pairs:pairTsv(result),windows:windowTsv(result),identity:record.resultId,verified};
}
declare const PHAGE_CODON_SELECTION_WORKER:string|undefined;
export function runCodonSelectionJob(job:CodonSelectionJob,signal?:AbortSignal,progress:(message:string)=>void=()=>{}):Promise<CodonSelectionJobResult>{
 if(signal?.aborted)return Promise.reject(new DOMException('Codon-selection operation cancelled.','AbortError'));
 return new Promise((yes,no)=>{let done=false;const url=typeof PHAGE_CODON_SELECTION_WORKER==='string'?new URL(PHAGE_CODON_SELECTION_WORKER,import.meta.url):new URL('../workers/codon-selection-worker.ts',import.meta.url);const worker=new Worker(url);
  const finish=(result?:CodonSelectionJobResult,error?:Error)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);void worker.terminate().catch(()=>{});error?no(error):yes(result!);};
  const abort=()=>finish(undefined,new DOMException('Codon-selection operation cancelled.','AbortError'));
  worker.on('message',(message:CodonSelectionJobMessage)=>{if(done)return;if(signal?.aborted){abort();return;}if(message.kind==='progress'){try{progress(message.message);}catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}}
   else if(message.kind==='result')finish(message.result);else finish(undefined,new Error(message.kind==='error'?message.message:'Invalid codon-selection worker response.'));});
  worker.on('error',cause=>finish(undefined,cause instanceof Error?cause:new Error(String(cause))));worker.on('exit',code=>finish(undefined,new Error('Codon-selection worker exited before returning a result (code '+code+').')));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}try{worker.postMessage(job);}catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}});
}
export function parseCodonSelectionCommand(args:string[]):CodonSelectionCommand|null{
 const{values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
  output:{type:'string'},params:{type:'string'},format:{type:'string'},name:{type:'string'},source:{type:'string'},reference:{type:'string'},license:{type:'string'},
  'alignment-method':{type:'string'},'homology-reference':{type:'string'},'genetic-code':{type:'string'},demo:{type:'boolean',default:false},help:{type:'boolean',short:'h'},
 }});
 if(values.help||args.length===0)return null;const[operation,input]=positionals;if(positionals.length!==2||!['prepare','inspect','analyze','replay'].includes(operation))throw new Error('Expected codon-selection prepare|inspect|analyze|replay INPUT.');
 if(!input.trim()||[values.output,values.params,values.name,values.source,values.reference,values.license,values['alignment-method'],values['homology-reference'],values['genetic-code']].some(v=>v!==undefined&&!v.trim()))
  throw new Error('Codon-selection paths and metadata fields must not be empty.');
 const format=values.format??'json';if(!['json','pairs','windows'].includes(format))throw new Error('--format must be json, pairs or windows.');
 const metadataSupplied=values.name!==undefined||values.source!==undefined||values.reference!==undefined||values.license!==undefined||values['alignment-method']!==undefined||values['homology-reference']!==undefined||values['genetic-code']!==undefined||values.demo;
 if(operation==='prepare'){
  for(const key of ['name','source','reference','license','alignment-method','homology-reference','genetic-code'] as const)if(values[key]===undefined)throw new Error('prepare requires --'+key+'.');
  const code=Number(values['genetic-code']);if(!(CODON_GENETIC_CODES as readonly number[]).includes(code))throw new Error('--genetic-code must be 1, 4, 11, 15 or 25.');
  if(values.params!==undefined||format!=='json')throw new Error('prepare creates canonical dataset JSON; analysis settings/table exports require analyze.');
  return{operation,input,output:values.output==='-'?undefined:values.output,format:'json',metadata:{name:values.name!,kind:values.demo?'demo':'local',description:values.source!,reference:values.reference!,
   license:values.license!,alignmentMethod:values['alignment-method']!,homologyReference:values['homology-reference']!,geneticCode:code as CodonGeneticCode}};
 }
 if(metadataSupplied)throw new Error('inspect/analyze/replay use canonical coding provenance and cannot relabel it.');
 if(operation==='inspect'&&(values.params!==undefined||format!=='json'))throw new Error('inspect validates canonical codon JSON without analysis settings.');
 if(operation==='replay'&&values.params!==undefined)throw new Error('Replay cannot override saved codon-selection settings.');
 if([input,values.params].filter(v=>v==='-').length>1)throw new Error('Only one codon-selection input may use stdin.');
 return{operation:operation as CodonSelectionOperation,input,output:values.output==='-'?undefined:values.output,params:values.params,format:format as CodonSelectionCommand['format']};
}
function writeStream(stream:Writable,content:string):Promise<void>{return new Promise((yes,no)=>{const fail=(e:Error)=>{stream.off('error',fail);no(e);};stream.once('error',fail);stream.write(content,e=>{if(e){no(e);return;}stream.off('error',fail);yes();});});}
async function newOutput(path:string){try{await lstat(path);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}throw new Error('Output already exists; choose a new file.');}
function clean(cause:unknown){return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');}
export async function runCodonSelectionCommand(args:string[],io:CodonSelectionIO):Promise<number>{
 let command:CodonSelectionCommand|null;try{command=parseCodonSelectionCommand(args);}catch(cause){await writeStream(io.stderr,'Codon selection: '+clean(cause)+'\n');return 2;}if(!command){await writeStream(io.stdout,CODON_SELECTION_HELP);return 0;}
 try{check(io.signal);const destination=command.output?resolve(command.output):undefined;if(destination)await newOutput(destination);const read=(path:string,limit:number)=>path==='-'?readAbundanceStdin(io.stdin,limit,io.signal):readAbundanceFile(path,limit,io.signal);let output:string;
  if(command.operation==='prepare'){const fasta=await read(command.input,CODON_SELECTION_LIMITS.bytes),m=command.metadata!;const dataset=validateCodonAlignment({format:'phage-explorer-codon-alignment',version:1,name:m.name,
    source:{kind:m.kind,description:m.description,reference:m.reference,license:m.license},alignment:{fasta,homologousCodons:true,orientation:'coding-5to3',frame:0,geneticCode:m.geneticCode,method:m.alignmentMethod,reference:m.homologyReference}});
    output=JSON.stringify(dataset,null,2)+'\n';
  }else{const limit=command.operation==='replay'?RECORD_LIMIT:CODON_SELECTION_LIMITS.bytes,input=await read(command.input,limit);
   if(command.operation==='inspect')output=JSON.stringify(validateCodonAlignment(JSON.parse(input.replace(/^\uFEFF/,''))),null,2)+'\n';
   else{const parameters=command.params===undefined?undefined:await read(command.params,PARAM_LIMIT);const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    const result=await(io.execute??runCodonSelectionJob)({operation:command.operation,input:{name:basename(command.input),text:input},params:parameters},io.signal,progress);
    output=command.format==='json'?result.content+'\n':result[command.format];}}
  check(io.signal);if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);return 0;
 }catch(cause){await writeStream(io.stderr,'Codon selection: '+clean(cause)+'\n');return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;}}
export async function runCodonSelectionProcess(args:string[]):Promise<void>{const controller=new AbortController();let terminated=false;const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 try{const code=await runCodonSelectionCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});process.exitCode=code===130&&terminated?143:code;}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}}
