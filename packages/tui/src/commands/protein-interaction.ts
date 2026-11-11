/** Portable deposited-complex host-interaction evidence without the illustrative docking model. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { parseProteinReferenceBundle } from '../../../core/src/protein-reference';
import { createDepositedHostInteractionRecord, replayDepositedHostInteractionRecord,
  exportDepositedHostInteractionTsv } from '../../../core/src/analysis/host-interaction-evidence';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const REFERENCE_LIMIT=512*1024, RECORD_LIMIT=10*1024*1024;
export const PROTEIN_INTERACTION_HELP=`Deposited phage-host protein interaction evidence

  phage-explorer protein-interaction inspect REFERENCE_JSON
  phage-explorer protein-interaction analyze REFERENCE_JSON
  phage-explorer protein-interaction replay SAVED_ANALYSIS

  --format json|tsv     analyze/replay output (default json)
  --output NEW_FILE     existing files are never overwritten
  -                     read the single input from stdin

inspect validates the pinned protein-reference bundle. analyze emits a portable
analysis record containing only deposited-complex identity, experimental host,
published domain/loop assignments, mapped chain coverage and source manifest.
replay validates the embedded bundle again and reconstructs the record.

Binding affinity, ΔG, Kd, buried surface area, mutation effects and engineered
host-range changes are deliberately unavailable unless separately supplied by a
validated method. This command does not run the illustrative docking model.
`;
export type ProteinInteractionOperation='inspect'|'analyze'|'replay';
export interface ProteinInteractionCommand{operation:ProteinInteractionOperation;input:string;format:'json'|'tsv';output?:string}
export interface ProteinInteractionIO{stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal}
function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Protein interaction operation cancelled.','AbortError');}
export function parseProteinInteractionCommand(args:string[]):ProteinInteractionCommand|null{
  const{values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    format:{type:'string'},output:{type:'string'},help:{type:'boolean',short:'h'},
  }});
  if(values.help||args.length===0)return null;
  const[operation,input]=positionals;
  if(positionals.length!==2||!['inspect','analyze','replay'].includes(operation))
    throw new Error('Expected protein-interaction inspect|analyze|replay INPUT.');
  if(!input.trim()||values.output!==undefined&&!values.output.trim())throw new Error('Paths must not be empty.');
  const format=values.format??'json';
  if(format!=='json'&&format!=='tsv')throw new Error('--format must be json or tsv.');
  if(operation==='inspect'&&format!=='json')throw new Error('inspect emits canonical reference JSON; TSV requires analyze or replay.');
  return{operation:operation as ProteinInteractionOperation,input,format:format as 'json'|'tsv',output:values.output==='-'?undefined:values.output};
}
function writeStream(stream:Writable,content:string):Promise<void>{
  return new Promise((resolveWrite,reject)=>{
    const fail=(cause:Error)=>{stream.off('error',fail);reject(cause);};stream.once('error',fail);
    stream.write(content,cause=>{if(cause){reject(cause);return;}stream.off('error',fail);resolveWrite();});
  });
}
async function newOutput(filename:string):Promise<void>{
  try{await lstat(filename);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
function clean(cause:unknown):string{
  return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
}
export async function runProteinInteractionCommand(args:string[],io:ProteinInteractionIO):Promise<number>{
  let command:ProteinInteractionCommand|null;
  try{command=parseProteinInteractionCommand(args);}catch(cause){await writeStream(io.stderr,'Protein interaction: '+clean(cause)+'\n');return 2;}
  if(!command){await writeStream(io.stdout,PROTEIN_INTERACTION_HELP);return 0;}
  try{
    check(io.signal);
    const destination=command.output?resolve(command.output):undefined;if(destination)await newOutput(destination);
    const limit=command.operation==='replay'?RECORD_LIMIT:REFERENCE_LIMIT;
    const content=command.input==='-'?await readAbundanceStdin(io.stdin,limit,io.signal):await readAbundanceFile(command.input,limit,io.signal);
    check(io.signal);
    let output:string;
    if(command.operation==='inspect'){
      const bundle=await parseProteinReferenceBundle(JSON.parse(content.replace(/^\uFEFF/,'')));
      output=JSON.stringify(bundle,null,2)+'\n';
    }else{
      const experiment=command.operation==='replay'
        ?await replayDepositedHostInteractionRecord(content.replace(/^\uFEFF/,''))
        :await createDepositedHostInteractionRecord(JSON.parse(content.replace(/^\uFEFF/,'')));
      check(io.signal);
      output=command.format==='tsv'?exportDepositedHostInteractionTsv(experiment.record):serializeAnalysisRecord(experiment.record)+'\n';
    }
    if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);
    return 0;
  }catch(cause){
    await writeStream(io.stderr,'Protein interaction: '+clean(cause)+'\n');
    return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;
  }
}
export async function runProteinInteractionProcess(args:string[]):Promise<void>{
  const controller=new AbortController();let terminated=false;
  const interrupt=()=>controller.abort();const terminate=()=>{terminated=true;controller.abort();};
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{
    const code=await runProteinInteractionCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});
    process.exitCode=code===130&&terminated?143:code;
  }finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}
}
