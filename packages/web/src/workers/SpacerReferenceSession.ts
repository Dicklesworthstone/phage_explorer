/** Selection-scoped private reference evidence; no numeric-ID sequence cache. */
import { parseSpacerLibrary, validateSpacerGenome, validateSpacerLibrary, resolveSpacerOptions,
  searchSpacerReferences, createSpacerRecord, replaySpacerRecord, SPACER_LIMITS,
  type SpacerLibrary, type SpacerGenome, type SpacerSearchOptions, type SpacerSearchResult } from '../../../core/src/analysis/spacer-reference';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type SpacerRequest = { kind:'library'; content:string }
  | { kind:'analyze'; genome:SpacerGenome; library:SpacerLibrary; options:Partial<SpacerSearchOptions> }
  | { kind:'replay'; content:string; genome:SpacerGenome };
export interface SpacerWorkResult { library:SpacerLibrary; genome:SpacerGenome|null; result:SpacerSearchResult|null; record:AnalysisRecord|null; verified:boolean }
export type SpacerMessage = {kind:'progress';phase:string}|{kind:'result';value:SpacerWorkResult}|{kind:'error';message:string};
export async function executeSpacerRequest(request:SpacerRequest,progress:(phase:string)=>void=()=>{}):Promise<SpacerWorkResult> {
  if(!request||typeof request!=='object')throw new Error('Unsupported spacer request.');
  if(request.kind==='library'){
    progress('Validating spacer reference provenance and host records');
    return {library:parseSpacerLibrary(request.content),genome:null,result:null,record:null,verified:false};
  }
  if(request.kind==='replay'){
    if(typeof request.content!=='string'||new TextEncoder().encode(request.content).length>10*1024*1024)throw new Error('Saved spacer evidence exceeds the 10 MiB limit.');
    progress('Checking saved identities and recomputing spacer evidence');
    return {...await replaySpacerRecord(request.content.replace(/^\uFEFF/,''),request.genome),verified:true};
  }
  if(request.kind!=='analyze')throw new Error('Unsupported spacer operation.');
  const genome=validateSpacerGenome(request.genome),library=validateSpacerLibrary(request.library),options=resolveSpacerOptions(request.options);
  progress('Searching complete unambiguous DNA windows on both strands');
  const result=searchSpacerReferences(genome,library,options);
  progress('Binding exact inputs, host scope and match evidence');
  return {library,genome,result,record:await createSpacerRecord(genome,library,result),verified:false};
}
export interface SpacerRepository { getFullGenomeLength:(id:number)=>Promise<number>; getSequenceWindow:(id:number,start:number,length:number)=>Promise<string> }
export interface SpacerSelection { id:number; name:string; accession:string|null; localGenome?:unknown }
const abortError=()=>new DOMException('Spacer work cancelled','AbortError');
function check(signal:AbortSignal):void{if(signal.aborted)throw abortError();}
/** Reads belong to the current repository and phage object, not merely their numeric ID. */
export async function readSpacerGenome(repository:SpacerRepository,phage:SpacerSelection,topology:SpacerGenome['topology'],signal:AbortSignal):Promise<SpacerGenome>{
  check(signal);const length=await repository.getFullGenomeLength(phage.id);check(signal);
  if(!Number.isSafeInteger(length)||length<1||length>SPACER_LIMITS.genomeBases)throw new Error('Selected genome is empty or exceeds the 5,000,000-base limit.');
  const sequence=await repository.getSequenceWindow(phage.id,0,length);check(signal);
  if(sequence.length!==length)throw new Error('Genome read is incomplete; no partial sequence was searched.');
  return validateSpacerGenome({name:phage.name,accession:phage.accession,sequence,topology,source:phage.localGenome?'local':'catalog'});
}
export interface SpacerWorker {
  postMessage:(request:SpacerRequest)=>void;terminate:()=>void;
  onmessage:((event:MessageEvent<SpacerMessage>)=>void)|null;onerror:((event:ErrorEvent)=>void)|null;onmessageerror:((event:MessageEvent)=>void)|null;
}
interface Snapshot { library:SpacerLibrary|null; accepted:SpacerWorkResult|null; acceptedScope:object|null; busy:boolean; phase:string; error:string|null; notice:string|null }
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(abortError());
    if(signal.aborted){void promise.catch(()=>{});reject(abortError());return;}
    signal.addEventListener('abort',cancel,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},cause=>{signal.removeEventListener('abort',cancel);reject(cause);});
  });
}
export class SpacerReferenceSession {
  private active=false;private scope:object|null=null;private operation:AbortController|null=null;
  private listeners=new Set<()=>void>();
  private snapshot:Snapshot={library:null,accepted:null,acceptedScope:null,busy:false,phase:'',error:null,notice:null};
  constructor(private readonly factory:()=>SpacerWorker){}
  getSnapshot=():Snapshot=>this.snapshot;
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(update:Partial<Snapshot>):void{this.snapshot={...this.snapshot,...update};for(const listener of this.listeners)listener();}
  activate=():void=>{this.active=true;};
  deactivate=():void=>{this.active=false;this.cancel();};
  setScope=(scope:object):void=>{
    if(this.scope===scope)return;this.scope=scope;this.cancel();
    this.publish({accepted:null,acceptedScope:null,error:null,notice:this.snapshot.library?'Genome selection changed. Loaded reference library retained; run a fresh comparison.':null});
  };
  cancel=():void=>{
    const old=this.operation;this.operation=null;old?.abort();
    this.publish({busy:false,phase:'',...(old?{notice:'Spacer work cancelled; previous accepted evidence was preserved.'}:{})});
  };
  run=async(scope:object,input:SpacerRequest|((signal:AbortSignal)=>Promise<SpacerRequest>)):Promise<void>=>{
    if(!this.active||scope!==this.scope)return;
    this.cancel();const owner=new AbortController();this.operation=owner;
    const current=()=>this.active&&this.scope===scope&&this.operation===owner&&!owner.signal.aborted;
    try{
      // Capture direct input before notifying subscribers or awaiting anything.
      const captured=typeof input==='function'?input:structuredClone(input);
      this.publish({busy:true,phase:'Reading local inputs',error:null,notice:null});if(!current())return;
      const request=await abortable(typeof captured==='function'?captured(owner.signal).then(value=>structuredClone(value)):Promise.resolve(captured),owner.signal);
      if(!current())return;
      const value=await new Promise<SpacerWorkResult>((resolve,reject)=>{
        const worker=this.factory();let done=false;
        const finish=(result?:SpacerWorkResult,error?:Error)=>{if(done)return;done=true;owner.signal.removeEventListener('abort',cancel);worker.terminate();if(error)reject(error);else resolve(result!);};
        const cancel=()=>finish(undefined,abortError());owner.signal.addEventListener('abort',cancel,{once:true});
        worker.onmessage=event=>{
          if(done||!current())return;const message=event.data;
          if(message?.kind==='progress'&&typeof message.phase==='string')this.publish({phase:message.phase});
          else if(message?.kind==='result'&&message.value?.library?.format==='phage-explorer-spacer-library')finish(message.value);
          else if(message?.kind==='error'&&typeof message.message==='string')finish(undefined,new Error(message.message));
          else finish(undefined,new Error('Unexpected spacer worker response.'));
        };
        worker.onerror=()=>finish(undefined,new Error('Spacer worker failed. Retry the local comparison.'));
        worker.onmessageerror=()=>finish(undefined,new Error('Spacer worker response could not be read.'));
        try{if(owner.signal.aborted)cancel();else worker.postMessage(request);}catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}
      });
      if(current())this.publish({library:value.library,accepted:value.result?value:null,acceptedScope:value.result?scope:null,
        notice:value.verified?'Verified spacer replay: fresh matches, references and complete result identity agree.':value.result?'Spacer comparison complete. Inspect coverage and rule limitations.':'Spacer library loaded. Select hosts and run a comparison; no sequence has been searched yet.'});
    }catch(cause){if(current())this.publish({error:cause instanceof Error?cause.message:String(cause)});}
    finally{if(current()){this.operation=null;this.publish({busy:false,phase:''});}}
  };
}
