/** Database-free bounded canonical-kmer mosaic/recombination-reference scan. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  MOSAIC_LIMITS, validateMosaicDataset, createMosaicExperiment, replayMosaicExperiment,
  exportMosaicTsv, resolveMosaicRadarConfig,
  type MosaicDataset, type MosaicRadarConfig, type MosaicSequenceInput, type MosaicExcludedReference,
} from '../../../core/src/analysis/recombination-radar';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT=10*1024*1024, PARAM_LIMIT=64*1024;

export const MOSAIC_HELP=`Canonical-kmer mosaic/reference-similarity scan (local files only)

  phage-explorer mosaic prepare QUERY_FASTA --references REFERENCE_FASTA --name NAME
    --query-source DESCRIPTION --reference-source DESCRIPTION
    [--query-reference CITATION] [--reference-citation CITATION]
    [--license LICENSE] [--demo] [--excluded EXCLUDED_JSON] [--output NEW_FILE]

  phage-explorer mosaic inspect DATASET_JSON
  phage-explorer mosaic analyze DATASET_JSON [--params FILE]
    [--format json|windows|segments|switches] [--output NEW_FILE]
  phage-explorer mosaic replay SAVED_ANALYSIS
    [--format json|windows|segments|switches] [--output NEW_FILE]

prepare requires one query FASTA record and 1..30 reference FASTA records. Complete
FASTA headers become unique source labels/IDs; bases are retained exactly as supplied
(IUPAC DNA, no gaps). EXCLUDED_JSON may list known candidate references whose bases
were unavailable: [{id,label,accession,reason}, ...].

--params accepts k, window, step, minSimilarity, maxReferences and topN. The scan
uses exact strand-independent canonical DNA k-mer Jaccard in bounded linear windows.
Reference switches are sampled similarity changes, NOT inferred donors, recombination
events, transfer direction, age or biological breakpoints. Missing/ambiguous bases and
absent references remain explicit evidence gaps.

replay recomputes the complete experiment from its embedded query/reference panel.
TSV exports retain source ranges, panel coverage and explicit evidence status.
`;

export type MosaicOperation='prepare'|'inspect'|'analyze'|'replay';
export interface MosaicCommand{
  operation:MosaicOperation;input:string;references?:string;excluded?:string;output?:string;params?:string;
  format:'json'|'windows'|'segments'|'switches';
  metadata?:{name:string;kind:'local'|'demo';querySource:string;referenceSource:string;
    queryReference:string|null;referenceCitation:string|null;license:string|null};
}
export interface MosaicJob{operation:'analyze'|'replay';input:{name:string;text:string};params?:string}
export interface MosaicJobResult{content:string;windows:string;segments:string;switches:string;identity:string;verified:boolean}
export type MosaicJobMessage=|{kind:'progress';message:string}|{kind:'result';result:MosaicJobResult}|{kind:'error';message:string};
export interface MosaicIO{stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal;execute?:typeof runMosaicJob}

function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Mosaic experiment cancelled.','AbortError');}
function parseFasta(content:string,maximum:number):Array<{id:string;label:string;sequence:string}>{
 if(typeof content!=='string'||new TextEncoder().encode(content).length>MOSAIC_LIMITS.bytes)throw new Error('Mosaic FASTA exceeds 6 MiB.');
 const rows:Array<{id:string;label:string;sequence:string}>=[];let current:{id:string;label:string;sequence:string}|null=null;
 for(const raw of content.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const line=raw.trim();if(!line)continue;
  if(line.startsWith('>')){
   if(current)rows.push(current);
   const label=line.slice(1).trim();
   if(!label||label.length>256||/[\u0000-\u001f\u007f]/.test(label))throw new Error('Mosaic FASTA headers require 1-256 plain-text characters.');
   const id=label.replace(/[^A-Za-z0-9_.:-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,128);
   if(!id)throw new Error('Mosaic FASTA header cannot form a stable source ID.');
   current={id,label,sequence:''};
  }else{
   if(!current)throw new Error('Mosaic FASTA must begin with a header.');
   if(/[^ACGTRYSWKMBDHVN]/i.test(line))throw new Error('Mosaic FASTA sequences require ungapped IUPAC DNA.');
   current.sequence+=line.toUpperCase();
  }
 }
 if(current)rows.push(current);
 if(rows.length<1||rows.length>maximum)throw new Error('Mosaic FASTA requires 1-'+maximum+' records.');
 if(rows.some(row=>!row.sequence))throw new Error('Mosaic FASTA records require nonempty sequences.');
 if(new Set(rows.map(row=>row.id)).size!==rows.length||new Set(rows.map(row=>row.label)).size!==rows.length)
  throw new Error('Mosaic FASTA headers must produce unique source IDs and labels.');
 return rows;
}
function source(row:{id:string;label:string;sequence:string},kind:'local'|'demo',description:string,reference:string|null,license:string|null):MosaicSequenceInput{
 return{id:row.id,label:row.label,accession:null,sequence:row.sequence,source:kind,sourceDescription:description,
  sourceReference:reference,sourceLicense:license,sourceLength:row.sequence.length,sourceStart:0};
}
function params(text:string|undefined):MosaicRadarConfig{
 if(text===undefined)return{};
 if(new TextEncoder().encode(text).length>PARAM_LIMIT)throw new Error('Mosaic parameter JSON exceeds 64 KiB.');
 const value:unknown=JSON.parse(text.replace(/^\uFEFF/,''));
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Mosaic parameters must be a JSON object.');
 return value as MosaicRadarConfig;
}
export async function executeMosaicJob(job:MosaicJob,progress:(message:string)=>void=()=>{}):Promise<MosaicJobResult>{
 if(!job||!['analyze','replay'].includes(job.operation)||!job.input||typeof job.input.text!=='string')throw new Error('Unsupported mosaic job.');
 const bytes=new TextEncoder().encode(job.input.text).length;
 if(bytes>(job.operation==='replay'?RECORD_LIMIT:MOSAIC_LIMITS.bytes))throw new Error(job.operation==='replay'?'Saved mosaic evidence exceeds 10 MiB.':'Mosaic dataset exceeds 6 MiB.');
 let experiment;
 if(job.operation==='replay'){
  if(job.params!==undefined)throw new Error('Replay cannot override saved mosaic settings.');
  progress('Recomputing canonical-kmer mosaic evidence from exact saved sources');
  experiment=await replayMosaicExperiment(job.input.text.replace(/^\uFEFF/,''));
 }else{
  progress('Validating exact query/reference sources and explicit exclusions');
  const dataset=validateMosaicDataset(JSON.parse(job.input.text.replace(/^\uFEFF/,'')));
  const options=resolveMosaicRadarConfig(params(job.params));
  progress('Scanning bounded canonical-kmer reference similarity windows');
  experiment=await createMosaicExperiment(dataset,options);
 }
 return{content:serializeAnalysisRecord(experiment.record),windows:exportMosaicTsv(experiment.record,'windows'),
  segments:exportMosaicTsv(experiment.record,'segments'),switches:exportMosaicTsv(experiment.record,'switches'),
  identity:experiment.record.resultId,verified:job.operation==='replay'};
}
declare const PHAGE_MOSAIC_WORKER:string|undefined;
export function runMosaicJob(job:MosaicJob,signal?:AbortSignal,progress:(message:string)=>void=()=>{}):Promise<MosaicJobResult>{
 if(signal?.aborted)return Promise.reject(new DOMException('Mosaic experiment cancelled.','AbortError'));
 return new Promise((yes,no)=>{
  let done=false;const url=typeof PHAGE_MOSAIC_WORKER==='string'?new URL(PHAGE_MOSAIC_WORKER,import.meta.url):new URL('../workers/mosaic-worker.ts',import.meta.url);const worker=new Worker(url);
  const finish=(result?:MosaicJobResult,error?:Error)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);void worker.terminate().catch(()=>{});error?no(error):yes(result!);};
  const abort=()=>finish(undefined,new DOMException('Mosaic experiment cancelled.','AbortError'));
  worker.on('message',(message:MosaicJobMessage)=>{if(done)return;if(signal?.aborted){abort();return;}
   if(message.kind==='progress'){try{progress(message.message);}catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}}
   else if(message.kind==='result')finish(message.result);else finish(undefined,new Error(message.kind==='error'?message.message:'Invalid mosaic worker response.'));});
  worker.on('error',cause=>finish(undefined,cause instanceof Error?cause:new Error(String(cause))));
  worker.on('exit',code=>finish(undefined,new Error('Mosaic worker exited before returning a result (code '+code+').')));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}try{worker.postMessage(job);}catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}
 });
}
export function parseMosaicCommand(args:string[]):MosaicCommand|null{
 const{values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
  references:{type:'string'},excluded:{type:'string'},output:{type:'string'},params:{type:'string'},format:{type:'string'},
  name:{type:'string'},'query-source':{type:'string'},'reference-source':{type:'string'},'query-reference':{type:'string'},
  'reference-citation':{type:'string'},license:{type:'string'},demo:{type:'boolean',default:false},help:{type:'boolean',short:'h'},
 }});
 if(values.help||args.length===0)return null;
 const[operation,input]=positionals;if(positionals.length!==2||!['prepare','inspect','analyze','replay'].includes(operation))throw new Error('Expected mosaic prepare|inspect|analyze|replay INPUT.');
 if(!input.trim()||[values.references,values.excluded,values.output,values.params,values.name,values['query-source'],values['reference-source'],values['query-reference'],values['reference-citation'],values.license].some(v=>v!==undefined&&!v.trim()))
  throw new Error('Mosaic paths and metadata fields must not be empty.');
 const format=values.format??'json';if(!['json','windows','segments','switches'].includes(format))throw new Error('--format must be json, windows, segments or switches.');
 const metadataSupplied=values.name!==undefined||values['query-source']!==undefined||values['reference-source']!==undefined||values['query-reference']!==undefined||values['reference-citation']!==undefined||values.license!==undefined||values.demo;
 if(operation==='prepare'){
  for(const key of ['references','name','query-source','reference-source'] as const)if(values[key]===undefined)throw new Error('prepare requires --'+key+'.');
  if(values.params!==undefined||format!=='json')throw new Error('prepare creates canonical dataset JSON; scan settings/table exports require analyze.');
  const stdin=[input,values.references,values.excluded].filter(v=>v==='-').length;if(stdin>1)throw new Error('Only one mosaic prepare input may use stdin.');
  return{operation,input,references:values.references,excluded:values.excluded,output:values.output==='-'?undefined:values.output,format:'json',
   metadata:{name:values.name!,kind:values.demo?'demo':'local',querySource:values['query-source']!,referenceSource:values['reference-source']!,
    queryReference:values['query-reference']??null,referenceCitation:values['reference-citation']??null,license:values.license??null}};
 }
 if(values.references!==undefined||values.excluded!==undefined||metadataSupplied)throw new Error('inspect/analyze/replay use canonical sources and cannot override their panel provenance.');
 if(operation==='inspect'&&(values.params!==undefined||format!=='json'))throw new Error('inspect validates canonical dataset JSON without scan settings.');
 if(operation==='replay'&&values.params!==undefined)throw new Error('Replay cannot override saved mosaic settings.');
 if([input,values.params].filter(v=>v==='-').length>1)throw new Error('Only one mosaic input may use stdin.');
 return{operation:operation as MosaicOperation,input,output:values.output==='-'?undefined:values.output,params:values.params,format:format as MosaicCommand['format']};
}
function writeStream(stream:Writable,content:string):Promise<void>{return new Promise((yes,no)=>{const fail=(e:Error)=>{stream.off('error',fail);no(e);};stream.once('error',fail);stream.write(content,e=>{if(e){no(e);return;}stream.off('error',fail);yes();});});}
async function newOutput(path:string){try{await lstat(path);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}throw new Error('Output already exists; choose a new file.');}
function clean(cause:unknown){return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');}
export async function runMosaicCommand(args:string[],io:MosaicIO):Promise<number>{
 let command:MosaicCommand|null;try{command=parseMosaicCommand(args);}catch(cause){await writeStream(io.stderr,'Mosaic: '+clean(cause)+'\n');return 2;}if(!command){await writeStream(io.stdout,MOSAIC_HELP);return 0;}
 try{
  check(io.signal);const destination=command.output?resolve(command.output):undefined;if(destination)await newOutput(destination);
  const read=(path:string,limit:number)=>path==='-'?readAbundanceStdin(io.stdin,limit,io.signal):readAbundanceFile(path,limit,io.signal);
  let output:string;
  if(command.operation==='prepare'){
   const query=parseFasta(await read(command.input,MOSAIC_LIMITS.bytes),1)[0];
   const references=parseFasta(await read(command.references!,MOSAIC_LIMITS.bytes),MOSAIC_LIMITS.references);
   let excluded:MosaicExcludedReference[]=[];
   if(command.excluded){
    const raw:unknown=JSON.parse((await read(command.excluded,512*1024)).replace(/^\uFEFF/,''));
    if(!Array.isArray(raw))throw new Error('Excluded mosaic references must be a JSON array.');
    excluded=raw as MosaicExcludedReference[];
   }
   const m=command.metadata!;
   const dataset=validateMosaicDataset({format:'phage-explorer-mosaic-dataset',version:1,name:m.name,
    query:source(query,m.kind,m.querySource,m.queryReference,m.license),
    references:references.map(row=>source(row,m.kind,m.referenceSource,m.referenceCitation,m.license)),
    excludedReferences:excluded});
   output=JSON.stringify(dataset,null,2)+'\n';
  }else{
   const limit=command.operation==='replay'?RECORD_LIMIT:MOSAIC_LIMITS.bytes;const input=await read(command.input,limit);
   if(command.operation==='inspect')output=JSON.stringify(validateMosaicDataset(JSON.parse(input.replace(/^\uFEFF/,''))),null,2)+'\n';
   else{
    const parameters=command.params===undefined?undefined:await read(command.params,PARAM_LIMIT);
    const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    const result=await(io.execute??runMosaicJob)({operation:command.operation,input:{name:basename(command.input),text:input},params:parameters},io.signal,progress);
    output=command.format==='json'?result.content+'\n':result[command.format];
   }
  }
  check(io.signal);if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);return 0;
 }catch(cause){await writeStream(io.stderr,'Mosaic: '+clean(cause)+'\n');return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;}
}
export async function runMosaicProcess(args:string[]):Promise<void>{const controller=new AbortController();let terminated=false;const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
 try{const code=await runMosaicCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});process.exitCode=code===130&&terminated?143:code;}finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}}
