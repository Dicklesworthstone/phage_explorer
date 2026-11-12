/** Database-free conditional ancestral nucleotide reconstruction on an explicit homologous alignment and fixed rooted tree. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  ANCESTRAL_LIMITS, validateAncestralDataset, parseAncestralFasta, reconstructAncestors, createAncestralRecord,
  replayAncestralRecord, ancestralFasta, resolveAncestralOptions,
  type AncestralDataset, type AncestralOptions,
} from '../../../core/src/analysis/ancestral-reconstruction';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT=10*1024*1024, PARAM_LIMIT=256*1024;

export const ANCESTRAL_HELP=`Conditional ancestral nucleotide reconstruction (local files only)

  phage-explorer ancestral prepare ALIGNMENT_FASTA --tree ROOTED_NEWICK --name NAME
    --source DESCRIPTION --reference CITATION --license LICENSE
    --tree-method METHOD --rooting EVIDENCE --alignment-method METHOD
    --alignment-reference HOMOLOGY_EVIDENCE [--demo] [--output NEW_FILE]

  phage-explorer ancestral inspect DATASET_JSON
  phage-explorer ancestral analyze DATASET_JSON [--params FILE] [--format json|fasta] [--output NEW_FILE]
  phage-explorer ancestral replay SAVED_ANALYSIS [--format json|fasta] [--output NEW_FILE]

prepare binds an already-homologous DNA alignment to an explicitly rooted phylogram
whose branch lengths are substitutions/site. No alignment, rooting or branch lengths
are inferred. Complete FASTA headers must match every tree tip exactly.

--params is a partial JSON object with startColumn, endColumn, gapPolicy,
minPosterior and optionally a fully sourced reversible nucleotide substitution
model/site-rate mixture accepted by the core method. A reconstruction window is
at most 4096 columns.

analyze runs the same log-space two-pass conditional likelihood producer as the
browser. replay recomputes every conditional probability and rejects changed
alignment/tree/settings/results. FASTA export contains accepted-threshold
conditional internal-node consensus; it is not itself a replay record.
replay also accepts linked rooted-nj-ancestral records created by phylogeny
ancestral, recomputing and retaining the original alignment/root/result chain.

These are model-conditional state probabilities, not empirical confidence,
mutation times, event counts or selection estimates.
`;

export type AncestralOperation='prepare'|'inspect'|'analyze'|'replay';
export interface AncestralCommand{
  operation:AncestralOperation;input:string;tree?:string;output?:string;format:'json'|'fasta';params?:string;
  metadata?:{name:string;kind:'local'|'demo';description:string;reference:string;license:string;
    treeMethod:string;rooting:string;alignmentMethod:string;alignmentReference:string};
}
export interface AncestralJob{
  operation:'analyze'|'replay';input:{name:string;text:string};params?:string;
}
export interface AncestralJobResult{content:string;fasta:string;identity:string;verified:boolean}
export type AncestralJobMessage=
 |{kind:'progress';message:string}|{kind:'result';result:AncestralJobResult}|{kind:'error';message:string};
export interface AncestralIO{
  stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal;execute?:typeof runAncestralJob;
}
function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Ancestral reconstruction cancelled.','AbortError');}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function parameters(text:string|undefined):Partial<AncestralOptions>{
  if(text===undefined)return{};
  if(new TextEncoder().encode(text).length>PARAM_LIMIT)throw new Error('Ancestral parameter JSON exceeds 256 KiB.');
  const value:unknown=JSON.parse(text.replace(/^\uFEFF/,''));
  if(!plain(value))throw new Error('Ancestral parameters must be a JSON object.');
  return value as Partial<AncestralOptions>;
}
export async function executeAncestralJob(job:AncestralJob,
  progress:(message:string)=>void=()=>{}):Promise<AncestralJobResult>{
  if(!job||!['analyze','replay'].includes(job.operation)||!job.input||typeof job.input.text!=='string')
    throw new Error('Unsupported ancestral reconstruction job.');
  const bytes=new TextEncoder().encode(job.input.text).length;
  if(bytes>(job.operation==='replay'?RECORD_LIMIT:ANCESTRAL_LIMITS.bytes))
    throw new Error(job.operation==='replay'?'Saved ancestral evidence exceeds 10 MiB.':'Ancestral dataset exceeds 2 MiB.');
  if(job.operation==='replay'){
    if(job.params!==undefined)throw new Error('Replay cannot override saved ancestral settings.');
    progress('Recomputing conditional ancestral states from exact saved inputs');
    const content=job.input.text.replace(/^\uFEFF/,''), selected:unknown=JSON.parse(content);
    const method=plain(selected)&&plain(selected.method)?selected.method.id:null;
    const replay=method==='rooted-nj-ancestral'
      ?await(await import('../../../core/src/analysis/phylogeny-rooting')).replayRootedAncestralExperiment(content,undefined,progress)
      :await replayAncestralRecord(content,progress);
    return{content:serializeAnalysisRecord(replay.record),fasta:ancestralFasta(replay.result),identity:replay.record.resultId,verified:true};
  }
  progress('Validating homologous alignment and fixed rooted tree');
  const input=validateAncestralDataset(JSON.parse(job.input.text.replace(/^\uFEFF/,'')));
  const options=resolveAncestralOptions(parseAncestralFasta(input.alignment.fasta)[0].sequence.length,parameters(job.params));
  progress('Computing conditional ancestral states and joint edge endpoints');
  const result=reconstructAncestors(input,options,progress);
  progress('Binding fixed inputs and accepted settings to the result');
  const record=await createAncestralRecord(input,result);
  return{content:serializeAnalysisRecord(record),fasta:ancestralFasta(result),identity:record.resultId,verified:false};
}

declare const PHAGE_ANCESTRAL_WORKER:string|undefined;
export function runAncestralJob(job:AncestralJob,signal?:AbortSignal,
 progress:(message:string)=>void=()=>{}):Promise<AncestralJobResult>{
 if(signal?.aborted)return Promise.reject(new DOMException('Ancestral reconstruction cancelled.','AbortError'));
 return new Promise((resolveResult,reject)=>{
  let settled=false;
  const url=typeof PHAGE_ANCESTRAL_WORKER==='string'?new URL(PHAGE_ANCESTRAL_WORKER,import.meta.url):new URL('../workers/ancestral-worker.ts',import.meta.url);
  const worker=new Worker(url);
  const finish=(error:Error|null,result?:AncestralJobResult)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);void worker.terminate().catch(()=>{});if(error)reject(error);else resolveResult(result!);};
  const abort=()=>finish(new DOMException('Ancestral reconstruction cancelled.','AbortError'));
  worker.on('message',(message:AncestralJobMessage)=>{
   if(settled)return;if(signal?.aborted){abort();return;}
   if(message.kind==='progress'){try{progress(message.message);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}}
   else if(message.kind==='result')finish(null,message.result);
   else finish(new Error(message.kind==='error'?message.message:'Invalid ancestral worker response.'));
  });
  worker.on('error',cause=>finish(cause instanceof Error?cause:new Error(String(cause))));
  worker.on('exit',code=>finish(new Error('Ancestral worker exited before returning a result (code '+code+').')));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
  try{worker.postMessage(job);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}
 });
}
export function parseAncestralCommand(args:string[]):AncestralCommand|null{
 const{values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
  tree:{type:'string'},output:{type:'string'},format:{type:'string'},params:{type:'string'},
  name:{type:'string'},source:{type:'string'},reference:{type:'string'},license:{type:'string'},
  'tree-method':{type:'string'},rooting:{type:'string'},'alignment-method':{type:'string'},'alignment-reference':{type:'string'},
  demo:{type:'boolean',default:false},help:{type:'boolean',short:'h'},
 }});
 if(values.help||args.length===0)return null;
 const[operation,input]=positionals;
 if(positionals.length!==2||!['prepare','inspect','analyze','replay'].includes(operation))
  throw new Error('Expected ancestral prepare|inspect|analyze|replay INPUT.');
 if(!input.trim()||[values.tree,values.output,values.params,values.name,values.source,values.reference,values.license,
  values['tree-method'],values.rooting,values['alignment-method'],values['alignment-reference']].some(v=>v!==undefined&&!v.trim()))
  throw new Error('Ancestral paths and metadata fields must not be empty.');
 const format=values.format??'json';if(format!=='json'&&format!=='fasta')throw new Error('--format must be json or fasta.');
 const importFields=['tree','name','source','reference','license','tree-method','rooting','alignment-method','alignment-reference'] as const;
 const imported=importFields.some(key=>values[key]!==undefined)||values.demo;
 if(operation==='prepare'){
  if(values.tree===undefined)throw new Error('prepare requires --tree.');
  for(const key of ['name','source','reference','license','tree-method','rooting','alignment-method','alignment-reference'] as const)
   if(values[key]===undefined)throw new Error('prepare requires --'+key+'.');
  if(values.params!==undefined||format!=='json')throw new Error('prepare creates canonical dataset JSON; analysis settings/FASTA output require analyze.');
  return{operation,input,tree:values.tree,output:values.output==='-'?undefined:values.output,format:'json',
   metadata:{name:values.name!,kind:values.demo?'demo':'local',description:values.source!,reference:values.reference!,license:values.license!,
    treeMethod:values['tree-method']!,rooting:values.rooting!,alignmentMethod:values['alignment-method']!,alignmentReference:values['alignment-reference']!}};
 }
 if(imported)throw new Error('inspect/analyze/replay use canonical inputs and cannot override their alignment/tree provenance.');
 if(operation==='inspect'&&(values.params!==undefined||format!=='json'))throw new Error('inspect validates canonical dataset JSON without analysis settings.');
 if(operation==='replay'&&values.params!==undefined)throw new Error('Replay cannot override saved ancestral settings.');
 if([input,values.params].filter(value=>value==='-').length>1)throw new Error('Only one ancestral input may read from stdin (-).');
 return{operation:operation as AncestralOperation,input,output:values.output==='-'?undefined:values.output,
  format:format as AncestralCommand['format'],params:values.params};
}
function writeStream(stream:Writable,content:string):Promise<void>{return new Promise((yes,no)=>{const fail=(e:Error)=>{stream.off('error',fail);no(e);};stream.once('error',fail);stream.write(content,e=>{if(e){no(e);return;}stream.off('error',fail);yes();});});}
async function newOutput(path:string){try{await lstat(path);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}throw new Error('Output already exists; choose a new file.');}
function clean(cause:unknown){return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');}
export async function runAncestralCommand(args:string[],io:AncestralIO):Promise<number>{
 let command:AncestralCommand|null;
 try{command=parseAncestralCommand(args);}catch(cause){await writeStream(io.stderr,'Ancestral: '+clean(cause)+'\n');return 2;}
 if(!command){await writeStream(io.stdout,ANCESTRAL_HELP);return 0;}
 try{
  check(io.signal);
  const destination=command.output?resolve(command.output):undefined;if(destination)await newOutput(destination);
  const read=(file:string,limit:number)=>file==='-'?readAbundanceStdin(io.stdin,limit,io.signal):readAbundanceFile(file,limit,io.signal);
  let output:string;
  if(command.operation==='prepare'){
   if(command.input==='-'&&command.tree==='-')throw new Error('Only one ancestral input may use stdin.');
   const [fasta,newick]=await Promise.all([read(command.input,ANCESTRAL_LIMITS.bytes),read(command.tree!,ANCESTRAL_LIMITS.bytes)]);
   const m=command.metadata!;
   const dataset=validateAncestralDataset({format:'phage-explorer-ancestral',version:1,name:m.name,
    source:{kind:m.kind,description:m.description,reference:m.reference,license:m.license},
    tree:{newick,units:'substitutions/site',method:m.treeMethod,rooting:m.rooting},
    alignment:{fasta,homologous:true,method:m.alignmentMethod,reference:m.alignmentReference}});
   output=JSON.stringify(dataset,null,2)+'\n';
  }else{
   const limit=command.operation==='replay'?RECORD_LIMIT:ANCESTRAL_LIMITS.bytes;
   const input=await read(command.input,limit);
   if(command.operation==='inspect'){
    output=JSON.stringify(validateAncestralDataset(JSON.parse(input.replace(/^\uFEFF/,''))),null,2)+'\n';
   }else{
    const params=command.params===undefined?undefined:await read(command.params,PARAM_LIMIT);
    const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    const result=await(io.execute??runAncestralJob)({operation:command.operation,input:{name:basename(command.input),text:input},params},io.signal,progress);
    check(io.signal);output=command.format==='fasta'?result.fasta:result.content+'\n';
   }
  }
  check(io.signal);if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);return 0;
 }catch(cause){await writeStream(io.stderr,'Ancestral: '+clean(cause)+'\n');return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;}
}
export async function runAncestralProcess(args:string[]):Promise<void>{
 const controller=new AbortController();let terminated=false;const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};
 process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 try{const code=await runAncestralCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});process.exitCode=code===130&&terminated?143:code;}
 finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}
}
