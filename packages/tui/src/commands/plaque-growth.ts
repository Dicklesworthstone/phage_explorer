/** Database-free Poisson exposure fitting for raw extracellular plaque-count experiments. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  PLAQUE_GROWTH_LIMITS, parsePlaqueGrowthInput, parsePlaqueGrowthCSV,
  createPlaqueGrowthRecord, replayPlaqueGrowthRecord, exportPlaqueGrowthTsv,
  type PlaqueGrowthInput,
} from '../../../core/src/analysis/plaque-growth';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT=10*1024*1024;

export const PLAQUE_GROWTH_HELP=`Raw extracellular plaque-count growth likelihood (local files only)

  phage-explorer plaque-growth inspect INPUT [CSV attribution/options]
  phage-explorer plaque-growth fit INPUT [CSV attribution/options]
  phage-explorer plaque-growth replay SAVED_ANALYSIS

For CSV/TSV INPUT:
  --version 1|2          exact-count v1 (default) or bound-aware v2
  --title TEXT           experiment title (required)
  --source TEXT          assay/source description (required)
  --centers N            independently measured infected centers/mL (optional)
  --support-deviance N   likelihood support cutoff, 0.01..100 (default 3.84)
  --synthetic            mark observations as synthetic
  --extracellular        required confirmation that plates measure extracellular free phage

Version 1 columns:
  time_min,plaque_count,dilution_fraction,volume_ml
Version 2 adds:
  count_status    exact | at-most | at-least

Common:
  --format json|tsv      fit/replay output (default json)
  --output NEW_FILE      write a new file; existing files are never replaced
  -                      read INPUT from stdin

Dilution is the plated fraction, not its reciprocal. Bare TNTC/confluent labels,
blank counts and inferred thresholds are rejected; v2 requires an explicit numeric
inclusive bound and count_status. Canonical plaque-growth JSON retains its embedded
CSV, provenance and options and cannot be relabeled by import flags.

The producer uses Poisson exposure likelihood and observed-time ramp profiling.
Likelihood support is descriptive, not a calibrated confidence interval. Population
rise timing is not single-cell latency, and infectious yield requires an independently
measured infected-center concentration.
`;

export type PlaqueGrowthOperation='inspect'|'fit'|'replay';
export interface PlaqueGrowthCommand{
  operation:PlaqueGrowthOperation;input:string;output?:string;format:'json'|'tsv';
  version:1|2;title?:string;source?:string;centers?:number;supportDeviance:number;
  synthetic:boolean;extracellular:boolean;draftProvided:boolean;
}
export interface PlaqueGrowthJob{
  operation:PlaqueGrowthOperation;input:{name:string;text:string};
  draft?:{version:1|2;title:string;source:string;centers:number|null;supportDeviance:number;synthetic:boolean;extracellular:boolean};
}
export interface PlaqueGrowthJobResult{content:string;tsv:string|null;identity:string|null;verified:boolean}
export type PlaqueGrowthJobMessage=
  |{kind:'progress';message:string}|{kind:'result';result:PlaqueGrowthJobResult}|{kind:'error';message:string};
export interface PlaqueGrowthCommandIO{
  stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal;execute?:typeof runPlaqueGrowthJob;
}
function check(signal?:AbortSignal):void{
  if(signal?.aborted)throw new DOMException('Plaque-growth operation cancelled.','AbortError');
}
function buildInput(content:string,draft:PlaqueGrowthJob['draft']):string{
  const text=content.replace(/^\uFEFF/,'').trim();
  if(text.startsWith('{')){
    if(draft)throw new Error('Canonical plaque-growth JSON retains embedded provenance/options; CSV flags cannot relabel it.');
    return JSON.stringify(parsePlaqueGrowthInput(text),null,2);
  }
  if(!draft)throw new Error('CSV/TSV plaque input requires explicit title, source and --extracellular confirmation.');
  if(!draft.extracellular)throw new Error('Pass --extracellular to confirm free-phage plaque counts, not total infective-center titers.');
  parsePlaqueGrowthCSV(text,draft.version);
  const input:PlaqueGrowthInput={
    format:'phage-explorer-plaque-growth-input',version:draft.version,measurement:'extracellular-plaque-counts',
    title:draft.title,provenance:{kind:draft.synthetic?'synthetic':'user-supplied',source:draft.source},
    csv:content,options:{infectedCentersPerMl:draft.centers,supportDeviance:draft.supportDeviance},
  };
  return JSON.stringify(parsePlaqueGrowthInput(JSON.stringify(input)),null,2);
}
export async function executePlaqueGrowthJob(job:PlaqueGrowthJob,
  progress:(message:string)=>void=()=>{}):Promise<PlaqueGrowthJobResult>{
  if(!job||!['inspect','fit','replay'].includes(job.operation)||!job.input||typeof job.input.text!=='string')
    throw new Error('Unsupported plaque-growth job.');
  const bytes=new TextEncoder().encode(job.input.text).length;
  if(bytes>(job.operation==='replay'?RECORD_LIMIT:PLAQUE_GROWTH_LIMITS.bytes))
    throw new Error(job.operation==='replay'?'Saved plaque-growth evidence exceeds 10 MiB.':'Plaque-growth input exceeds 1,000,000 bytes.');
  if(job.operation==='replay'){
    if(job.draft)throw new Error('Replay cannot override saved plaque-growth provenance or options.');
    progress('Recomputing plate-count likelihood and support evidence');
    const record=await replayPlaqueGrowthRecord(job.input.text.replace(/^\uFEFF/,''));
    return{content:serializeAnalysisRecord(record),tsv:exportPlaqueGrowthTsv(record),identity:record.resultId,verified:true};
  }
  progress('Validating extracellular plaque counts, exposure and source');
  const input=buildInput(job.input.text,job.draft);
  if(job.operation==='inspect')return{content:input,tsv:null,identity:null,verified:false};
  progress('Fitting Poisson exposure ramp and likelihood support');
  const record=await createPlaqueGrowthRecord(input);
  return{content:serializeAnalysisRecord(record),tsv:exportPlaqueGrowthTsv(record),identity:record.resultId,verified:false};
}

declare const PHAGE_PLAQUE_GROWTH_WORKER:string|undefined;
export function runPlaqueGrowthJob(job:PlaqueGrowthJob,signal?:AbortSignal,
  progress:(message:string)=>void=()=>{}):Promise<PlaqueGrowthJobResult>{
  if(signal?.aborted)return Promise.reject(new DOMException('Plaque-growth operation cancelled.','AbortError'));
  return new Promise((resolveResult,reject)=>{
    let settled=false;
    const url=typeof PHAGE_PLAQUE_GROWTH_WORKER==='string'
      ?new URL(PHAGE_PLAQUE_GROWTH_WORKER,import.meta.url)
      :new URL('../workers/plaque-growth-worker.ts',import.meta.url);
    const worker=new Worker(url);
    const finish=(error:Error|null,result?:PlaqueGrowthJobResult)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);void worker.terminate().catch(()=>{});
      if(error)reject(error);else resolveResult(result!);
    };
    const abort=()=>finish(new DOMException('Plaque-growth operation cancelled.','AbortError'));
    worker.on('message',(message:PlaqueGrowthJobMessage)=>{
      if(settled)return;if(signal?.aborted){abort();return;}
      if(message.kind==='progress'){try{progress(message.message);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}}
      else if(message.kind==='result')finish(null,message.result);
      else finish(new Error(message.kind==='error'?message.message:'Invalid plaque-growth worker response.'));
    });
    worker.on('error',cause=>finish(cause instanceof Error?cause:new Error(String(cause))));
    worker.on('exit',code=>finish(new Error('Plaque-growth worker exited before returning a result (code '+code+').')));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{worker.postMessage(job);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}
  });
}
function numeric(value:string|undefined,fallback:number,label:string):number{
  if(value===undefined)return fallback;
  if(!/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))throw new Error(label+' must be numeric.');
  const n=Number(value);if(!Number.isFinite(n))throw new Error(label+' must be finite.');return n;
}
export function parsePlaqueGrowthCommand(args:string[]):PlaqueGrowthCommand|null{
  const{values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    version:{type:'string'},title:{type:'string'},source:{type:'string'},centers:{type:'string'},
    'support-deviance':{type:'string'},synthetic:{type:'boolean',default:false},extracellular:{type:'boolean',default:false},
    format:{type:'string'},output:{type:'string'},help:{type:'boolean',short:'h'},
  }});
  if(values.help||args.length===0)return null;
  const[operation,input]=positionals;
  if(positionals.length!==2||!['inspect','fit','replay'].includes(operation))
    throw new Error('Expected plaque-growth inspect|fit|replay INPUT. See plaque-growth --help.');
  if(!input.trim()||[values.title,values.source,values.output].some(v=>v!==undefined&&!v.trim()))
    throw new Error('Paths, title and source must not be empty.');
  const version=values.version===undefined?1:Number(values.version);
  if(version!==1&&version!==2)throw new Error('--version must be 1 or 2.');
  const centers=values.centers===undefined?undefined:numeric(values.centers,0,'--centers');
  if(centers!==undefined&&centers<=0)throw new Error('--centers must be a positive measured concentration.');
  const supportDeviance=numeric(values['support-deviance'],3.84,'--support-deviance');
  if(supportDeviance<.01||supportDeviance>100)throw new Error('--support-deviance must be between 0.01 and 100.');
  const format=values.format??'json';if(format!=='json'&&format!=='tsv')throw new Error('--format must be json or tsv.');
  if(operation==='inspect'&&format!=='json')throw new Error('inspect emits canonical experiment JSON; TSV requires fit or replay.');
  const supplied=values.version!==undefined||values.title!==undefined||values.source!==undefined||values.centers!==undefined
    ||values['support-deviance']!==undefined||values.synthetic||values.extracellular;
  if(operation==='replay'&&supplied)throw new Error('Replay cannot override saved plaque-growth evidence.');
  if(operation!=='replay'&&supplied&&(values.title===undefined||values.source===undefined))
    throw new Error('CSV/TSV import options require both --title and --source; canonical JSON needs no import flags.');
  return{operation:operation as PlaqueGrowthOperation,input,output:values.output==='-'?undefined:values.output,
    format:format as PlaqueGrowthCommand['format'],version:version as 1|2,title:values.title,source:values.source,centers,
    supportDeviance,synthetic:values.synthetic,extracellular:values.extracellular,draftProvided:supplied};
}
function writeStream(stream:Writable,content:string):Promise<void>{
  return new Promise((resolveWrite,reject)=>{
    const fail=(cause:Error)=>{stream.off('error',fail);reject(cause);};stream.once('error',fail);
    stream.write(content,cause=>{if(cause){reject(cause);return;}stream.off('error',fail);resolveWrite();});
  });
}
async function assertNewOutput(filename:string):Promise<void>{
  try{await lstat(filename);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
function clean(cause:unknown):string{
  return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
}
export async function runPlaqueGrowthCommand(args:string[],io:PlaqueGrowthCommandIO):Promise<number>{
  let command:PlaqueGrowthCommand|null;
  try{command=parsePlaqueGrowthCommand(args);}catch(cause){await writeStream(io.stderr,'Plaque growth: '+clean(cause)+'\n');return 2;}
  if(!command){await writeStream(io.stdout,PLAQUE_GROWTH_HELP);return 0;}
  try{
    check(io.signal);
    const destination=command.output?resolve(command.output):undefined;if(destination)await assertNewOutput(destination);
    const limit=command.operation==='replay'?RECORD_LIMIT:PLAQUE_GROWTH_LIMITS.bytes;
    const text=command.input==='-'?await readAbundanceStdin(io.stdin,limit,io.signal):await readAbundanceFile(command.input,limit,io.signal);
    check(io.signal);
    const draft=command.draftProvided?{version:command.version,title:command.title??'',source:command.source??'',
      centers:command.centers??null,supportDeviance:command.supportDeviance,synthetic:command.synthetic,extracellular:command.extracellular}:undefined;
    const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    const result=await(io.execute??runPlaqueGrowthJob)({operation:command.operation,
      input:{name:command.input==='-'?'stdin plaque counts':basename(command.input),text},draft},io.signal,progress);
    check(io.signal);
    const output=command.format==='tsv'?result.tsv:result.content+'\n';
    if(output===null)throw new Error('TSV export requires fitted or replayed plaque-growth evidence.');
    if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);
    return 0;
  }catch(cause){
    await writeStream(io.stderr,'Plaque growth: '+clean(cause)+'\n');
    return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;
  }
}
export async function runPlaqueGrowthProcess(args:string[]):Promise<void>{
  const controller=new AbortController();let terminated=false;
  const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{
    const code=await runPlaqueGrowthCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});
    process.exitCode=code===130&&terminated?143:code;
  }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}
}
