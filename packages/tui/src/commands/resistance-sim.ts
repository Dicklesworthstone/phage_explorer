/** Reproducible seeded resistance-cocktail simulation; explicitly illustrative, never fitted. */
import{parseArgs,stripVTControlCharacters}from'node:util';
import{resolve}from'node:path';
import{lstat,writeFile}from'node:fs/promises';
import type{Readable,Writable}from'node:stream';
import{createResistanceExperimentRecord,replayResistanceExperimentRecord,exportResistanceExperimentTsv,
  resolveResistanceExperimentOptions,type ResistanceExperimentOptions}from'../../../core/src/analysis/resistance-evolution';
import{serializeAnalysisRecord}from'../../../core/src/analysis-result';
import{readAbundanceFile,readAbundanceStdin}from'./abundance';
const RECORD_LIMIT=10*1024*1024;
export const RESISTANCE_SIM_HELP=`Seeded resistance-cocktail teaching simulation

  phage-explorer resistance-sim run [--params FILE]
  phage-explorer resistance-sim replay SAVED_ANALYSIS

run options:
  --params FILE       partial JSON object of model parameters
  --seed UINT32       overrides seed in --params (default 1)
  --cocktail-size N   overrides cocktailSize in --params (1..5)

common:
  --format json|tsv
  --output NEW_FILE
  - may be used for --params or replay input

This is an illustrative stochastic model, not a fit to the selected phage, host,
patient, treatment or experiment. A saved seed and complete parameter snapshot make
the trajectory reproducible; replay recomputes and verifies the exact result identity.
`;
export interface ResistanceSimIO{stdin:Readable;stdout:Writable;stderr:Writable;signal?:AbortSignal}
function check(signal?:AbortSignal){if(signal?.aborted)throw new DOMException('Resistance simulation cancelled.','AbortError');}
function clean(cause:unknown){return stripVTControlCharacters(cause instanceof Error?cause.message:String(cause)).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');}
function writeStream(stream:Writable,content:string):Promise<void>{return new Promise((yes,no)=>{const fail=(e:Error)=>{stream.off('error',fail);no(e);};stream.once('error',fail);stream.write(content,e=>{if(e){no(e);return;}stream.off('error',fail);yes();});});}
async function newOutput(path:string){try{await lstat(path);}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return;throw cause;}throw new Error('Output already exists; choose a new file.');}
export async function runResistanceSimCommand(args:string[],io:ResistanceSimIO):Promise<number>{
  let values:any,positionals:string[];
  try{({values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    params:{type:'string'},seed:{type:'string'},'cocktail-size':{type:'string'},format:{type:'string'},output:{type:'string'},help:{type:'boolean',short:'h'},
  }}));}catch(cause){await writeStream(io.stderr,'Resistance simulation: '+clean(cause)+'\n');return 2;}
  if(values.help||args.length===0){await writeStream(io.stdout,RESISTANCE_SIM_HELP);return 0;}
  const operation=positionals[0];
  try{
    if(operation!=='run'&&operation!=='replay')throw new Error('Expected resistance-sim run or replay.');
    if(operation==='run'&&positionals.length!==1||operation==='replay'&&positionals.length!==2)throw new Error('Unexpected positional arguments.');
    if(operation==='replay'&&(values.params!==undefined||values.seed!==undefined||values['cocktail-size']!==undefined))
      throw new Error('Replay cannot override saved simulation parameters.');
    const format=values.format??'json';if(format!=='json'&&format!=='tsv')throw new Error('--format must be json or tsv.');
    const destination=values.output&&values.output!=='-'?resolve(values.output):undefined;if(destination)await newOutput(destination);
    check(io.signal);
    let result;
    if(operation==='replay'){
      const input=positionals[1]==='-'?await readAbundanceStdin(io.stdin,RECORD_LIMIT,io.signal):await readAbundanceFile(positionals[1],RECORD_LIMIT,io.signal);
      result=await replayResistanceExperimentRecord(input.replace(/^\uFEFF/,''));
    }else{
      let params:Partial<ResistanceExperimentOptions>={};
      if(values.params!==undefined){
        const text=values.params==='-'?await readAbundanceStdin(io.stdin,64*1024,io.signal):await readAbundanceFile(values.params,64*1024,io.signal);
        const parsed:unknown=JSON.parse(text.replace(/^\uFEFF/,''));
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('--params must contain a JSON object.');
        params=parsed as Partial<ResistanceExperimentOptions>;
      }
      if(values.seed!==undefined){const seed=Number(values.seed);params={...params,seed};}
      if(values['cocktail-size']!==undefined){const cocktailSize=Number(values['cocktail-size']);params={...params,cocktailSize};}
      resolveResistanceExperimentOptions(params);
      result=await createResistanceExperimentRecord(params);
    }
    check(io.signal);
    const output=format==='tsv'?exportResistanceExperimentTsv(result.record):serializeAnalysisRecord(result.record)+'\n';
    if(destination)await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});else await writeStream(io.stdout,output);
    return 0;
  }catch(cause){await writeStream(io.stderr,'Resistance simulation: '+clean(cause)+'\n');return io.signal?.aborted||cause instanceof Error&&cause.name==='AbortError'?130:1;}
}
export async function runResistanceSimProcess(args:string[]):Promise<void>{
  const controller=new AbortController();const interrupt=()=>controller.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try{process.exitCode=await runResistanceSimCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});}
  finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);process.stdin.pause();}
}
