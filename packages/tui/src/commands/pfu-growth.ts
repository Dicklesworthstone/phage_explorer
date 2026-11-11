/** Database-free descriptive fitting for corrected extracellular PFU/mL one-step growth observations. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  GROWTH_CURVE_LIMITS, GROWTH_CURVE_METHOD, parseGrowthCurveCSV, parseGrowthCurveRecordInput,
  createGrowthCurveRecord, replayGrowthCurveRecord, exportGrowthCurveTsv,
  type GrowthCurveExperiment,
} from '../../../core/src/analysis/one-step-growth';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;

export const PFU_GROWTH_HELP = `Corrected extracellular PFU/mL growth fitting (local files only)

  phage-explorer pfu-growth inspect INPUT [CSV attribution/options]
  phage-explorer pfu-growth fit INPUT [CSV attribution/options]
  phage-explorer pfu-growth replay SAVED_ANALYSIS

For CSV/TSV INPUT:
  --title TEXT            experiment title (required)
  --source TEXT           assay/source description (required)
  --centers N             independently measured infected centers/mL (optional)
  --bootstrap N           residual-bootstrap samples: 0 or 20..200 (default 100)
  --seed N                uint32 bootstrap seed (default 1)
  --synthetic             mark the supplied observations as synthetic
  --extracellular         required confirmation that values are corrected free-phage PFU/mL

Common:
  --format json|tsv       fit/replay output (default json)
  --output NEW_FILE       write a new file; existing files are never replaced
  -                       read INPUT from stdin

Canonical one-step-growth JSON already embeds observations, provenance and options;
CSV attribution flags cannot relabel it. fit uses the same nonnegative observed-time
ramp and seeded centered-residual bootstrap as the browser. replay recomputes the
saved experiment and rejects changed values, intervals, seed or input identity.

This is descriptive corrected-PFU evidence. Population rise timing is not single-cell
latency. Net infectious yield is reported only when an independently measured
infected-center concentration is supplied; initial PFU, MOI or host counts are not substitutes.
`;

export type PfuGrowthOperation = 'inspect' | 'fit' | 'replay';
export interface PfuGrowthCommand {
  operation: PfuGrowthOperation; input: string; output?: string; format: 'json'|'tsv';
  title?: string; source?: string; centers?: number; bootstrap: number; seed: number;
  synthetic: boolean; extracellular: boolean; draftProvided: boolean;
}
export interface PfuGrowthJob {
  operation: PfuGrowthOperation; input: {name:string;text:string};
  draft?: {title:string;source:string;centers:number|null;bootstrap:number;seed:number;synthetic:boolean;extracellular:boolean};
}
export interface PfuGrowthJobResult {
  content:string; tsv:string|null; identity:string|null; verified:boolean;
}
export type PfuGrowthJobMessage =
  | {kind:'progress';message:string}
  | {kind:'result';result:PfuGrowthJobResult}
  | {kind:'error';message:string};
export interface PfuGrowthCommandIO {
  stdin:Readable; stdout:Writable; stderr:Writable; signal?:AbortSignal;
  execute?:typeof runPfuGrowthJob;
}

function check(signal?:AbortSignal):void{
  if(signal?.aborted) throw new DOMException('Corrected-PFU operation cancelled.','AbortError');
}
function finite(value:number,label:string):number{
  if(!Number.isFinite(value)) throw new Error(label+' must be finite.');
  return value;
}
function buildExperiment(content:string,name:string,draft:PfuGrowthJob['draft']):string{
  const text=content.replace(/^\uFEFF/,'').trim();
  if(text.startsWith('{')){
    if(draft) throw new Error('Canonical corrected-PFU JSON retains embedded provenance/options; CSV flags cannot relabel it.');
    return JSON.stringify(parseGrowthCurveRecordInput(text),null,2);
  }
  if(!draft) throw new Error('CSV/TSV corrected-PFU input requires explicit title, source and --extracellular confirmation.');
  if(!draft.extracellular) throw new Error('Pass --extracellular to confirm corrected free-phage PFU/mL, not total infective-center counts.');
  const experiment:GrowthCurveExperiment={
    schemaVersion:'one-step-growth-v1',method:GROWTH_CURVE_METHOD,measurement:'extracellular-pfu-per-ml',
    title:draft.title,provenance:{kind:draft.synthetic?'synthetic':'user-supplied',source:draft.source},
    observations:parseGrowthCurveCSV(text),
    options:{infectedCentersPerMl:draft.centers,bootstrapSamples:draft.bootstrap,seed:draft.seed},
  };
  return JSON.stringify(parseGrowthCurveRecordInput(JSON.stringify(experiment)),null,2);
}

export async function executePfuGrowthJob(job:PfuGrowthJob,
  progress:(message:string)=>void=()=>{}):Promise<PfuGrowthJobResult>{
  if(!job||!['inspect','fit','replay'].includes(job.operation)||!job.input||typeof job.input.text!=='string')
    throw new Error('Unsupported corrected-PFU job.');
  const bytes=new TextEncoder().encode(job.input.text).length;
  if(bytes>(job.operation==='replay'?RECORD_LIMIT:GROWTH_CURVE_LIMITS.bytes))
    throw new Error(job.operation==='replay'?'Saved corrected-PFU evidence exceeds 10 MiB.':'Corrected-PFU input exceeds 1,000,000 bytes.');
  if(job.operation==='replay'){
    if(job.draft) throw new Error('Replay cannot override saved corrected-PFU provenance or options.');
    progress('Recomputing corrected-PFU fit and bootstrap evidence');
    const record=await replayGrowthCurveRecord(job.input.text.replace(/^\uFEFF/,''));
    return {content:serializeAnalysisRecord(record),tsv:exportGrowthCurveTsv(record),identity:record.resultId,verified:true};
  }
  progress('Validating corrected extracellular PFU/mL experiment');
  const experiment=buildExperiment(job.input.text,job.input.name,job.draft);
  if(job.operation==='inspect'){
    parseGrowthCurveRecordInput(experiment);
    return {content:experiment,tsv:null,identity:null,verified:false};
  }
  progress('Fitting population baseline, rise and plateau with conditional bootstrap intervals');
  const record=await createGrowthCurveRecord(experiment);
  return {content:serializeAnalysisRecord(record),tsv:exportGrowthCurveTsv(record),identity:record.resultId,verified:false};
}

declare const PHAGE_PFU_GROWTH_WORKER:string|undefined;
export function runPfuGrowthJob(job:PfuGrowthJob,signal?:AbortSignal,
  progress:(message:string)=>void=()=>{}):Promise<PfuGrowthJobResult>{
  if(signal?.aborted) return Promise.reject(new DOMException('Corrected-PFU operation cancelled.','AbortError'));
  return new Promise((resolveResult,reject)=>{
    let settled=false;
    const url=typeof PHAGE_PFU_GROWTH_WORKER==='string'
      ?new URL(PHAGE_PFU_GROWTH_WORKER,import.meta.url)
      :new URL('../workers/pfu-growth-worker.ts',import.meta.url);
    const worker=new Worker(url);
    const finish=(error:Error|null,result?:PfuGrowthJobResult)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);
      void worker.terminate().catch(()=>{});
      if(error)reject(error);else resolveResult(result!);
    };
    const abort=()=>finish(new DOMException('Corrected-PFU operation cancelled.','AbortError'));
    worker.on('message',(message:PfuGrowthJobMessage)=>{
      if(settled)return;
      if(signal?.aborted){abort();return;}
      if(message.kind==='progress'){
        try{progress(message.message);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}
      }else if(message.kind==='result')finish(null,message.result);
      else finish(new Error(message.kind==='error'?message.message:'Invalid corrected-PFU worker response.'));
    });
    worker.on('error',cause=>finish(cause instanceof Error?cause:new Error(String(cause))));
    worker.on('exit',code=>finish(new Error('Corrected-PFU worker exited before returning a result (code '+code+').')));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{worker.postMessage(job);}catch(cause){finish(cause instanceof Error?cause:new Error(String(cause)));}
  });
}

function numberOption(value:string|undefined,fallback:number,label:string):number{
  if(value===undefined)return fallback;
  if(!/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))throw new Error(label+' must be numeric.');
  return finite(Number(value),label);
}
export function parsePfuGrowthCommand(args:string[]):PfuGrowthCommand|null{
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    title:{type:'string'},source:{type:'string'},centers:{type:'string'},bootstrap:{type:'string'},seed:{type:'string'},
    synthetic:{type:'boolean',default:false},extracellular:{type:'boolean',default:false},
    format:{type:'string'},output:{type:'string'},help:{type:'boolean',short:'h'},
  }});
  if(values.help||args.length===0)return null;
  const [operation,input]=positionals;
  if(positionals.length!==2||!['inspect','fit','replay'].includes(operation))
    throw new Error('Expected pfu-growth inspect|fit|replay INPUT. See pfu-growth --help.');
  if(!input.trim()||[values.title,values.source,values.output].some(v=>v!==undefined&&!v.trim()))
    throw new Error('Paths, title and source must not be empty.');
  const format=values.format??'json';
  if(format!=='json'&&format!=='tsv')throw new Error('--format must be json or tsv.');
  if(operation==='inspect'&&format!=='json')throw new Error('inspect emits canonical experiment JSON; TSV requires fit or replay.');
  const centers=values.centers===undefined?undefined:numberOption(values.centers,0,'--centers');
  if(centers!==undefined&&centers<=0)throw new Error('--centers must be a positive measured concentration.');
  const bootstrap=numberOption(values.bootstrap,100,'--bootstrap');
  const seed=numberOption(values.seed,1,'--seed');
  if(!Number.isSafeInteger(bootstrap)||bootstrap<0||bootstrap>GROWTH_CURVE_LIMITS.bootstrap||(bootstrap>0&&bootstrap<20))
    throw new Error('--bootstrap must be 0 or an integer from 20 to 200.');
  if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw new Error('--seed must be a uint32.');
  const supplied=values.title!==undefined||values.source!==undefined||values.centers!==undefined||values.bootstrap!==undefined
    ||values.seed!==undefined||values.synthetic||values.extracellular;
  if(operation==='replay'&&supplied)throw new Error('Replay cannot override saved corrected-PFU provenance or options.');
  if(operation!=='replay'&&supplied&&(values.title===undefined||values.source===undefined))
    throw new Error('CSV/TSV import options require both --title and --source; canonical JSON needs no import flags.');
  return {operation:operation as PfuGrowthOperation,input,output:values.output==='-'?undefined:values.output,
    format:format as PfuGrowthCommand['format'],title:values.title,source:values.source,centers,bootstrap,seed,
    synthetic:values.synthetic,extracellular:values.extracellular,draftProvided:supplied};
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
export async function runPfuGrowthCommand(args:string[],io:PfuGrowthCommandIO):Promise<number>{
  let command:PfuGrowthCommand|null;
  try{command=parsePfuGrowthCommand(args);}catch(cause){await writeStream(io.stderr,'PFU growth: '+clean(cause)+'\n');return 2;}
  if(!command){await writeStream(io.stdout,PFU_GROWTH_HELP);return 0;}
  try{
    check(io.signal);
    const destination=command.output?resolve(command.output):undefined;
    if(destination)await assertNewOutput(destination);
    const limit=command.operation==='replay'?RECORD_LIMIT:GROWTH_CURVE_LIMITS.bytes;
    const text=command.input==='-'?await readAbundanceStdin(io.stdin,limit,io.signal):await readAbundanceFile(command.input,limit,io.signal);
    check(io.signal);
    const draft=command.draftProvided?{title:command.title??'',source:command.source??'',centers:command.centers??null,
      bootstrap:command.bootstrap,seed:command.seed,synthetic:command.synthetic,extracellular:command.extracellular}:undefined;
    const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    const result=await(io.execute??runPfuGrowthJob)({operation:command.operation,
      input:{name:command.input==='-'?'stdin corrected PFU data':basename(command.input),text},draft},io.signal,progress);
    check(io.signal);
    const output=command.format==='tsv'?result.tsv:result.content+'\n';
    if(output===null)throw new Error('TSV export requires fitted or replayed corrected-PFU evidence.');
    if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});
    else await writeStream(io.stdout,output);
    return 0;
  }catch(cause){
    await writeStream(io.stderr,'PFU growth: '+clean(cause)+'\n');
    return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;
  }
}
export async function runPfuGrowthProcess(args:string[]):Promise<void>{
  const controller=new AbortController();let terminated=false;
  const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{
    const code=await runPfuGrowthCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});
    process.exitCode=code===130&&terminated?143:code;
  }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}
}
