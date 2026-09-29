/** Private alignment/tree input and fresh reconstruction share one cancellable owner. */
import { createAncestralRecord, parseAncestralFasta, reconstructAncestors, replayAncestralRecord,
  resolveAncestralOptions, validateAncestralDataset, type AncestralDataset, type AncestralOptions,
  type AncestralResult } from '../../../core/src/analysis/ancestral-reconstruction';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type AncestralRequest = { kind:'load'; input:AncestralDataset }
  | { kind:'import'; content:string }
  | { kind:'analyze'; input:AncestralDataset; options:Partial<AncestralOptions> };
export interface AncestralWork {
  input:AncestralDataset; columns:number; tips:number; options:AncestralOptions;
  result:AncestralResult|null; record:AnalysisRecord|null; verified:boolean;
}
export type AncestralMessage = {kind:'progress';phase:string}|{kind:'result';value:AncestralWork}|{kind:'error';message:string};
export async function executeAncestralRequest(request:AncestralRequest, progress:(phase:string)=>void=()=>{}):Promise<AncestralWork>{
  if(!request||typeof request!=='object')throw new Error('Unsupported ancestral request.');
  progress('Validating homologous alignment, tree and provenance');
  let input:AncestralDataset;
  if(request.kind==='import'){
    if(typeof request.content!=='string'||new TextEncoder().encode(request.content).length>10*1024*1024)throw new Error('Ancestral file exceeds the 10 MiB limit.');
    const content=request.content.replace(/^\uFEFF/,''), decoded:unknown=JSON.parse(content);
    if(decoded&&typeof decoded==='object'&&'format' in decoded&&decoded.format==='phage-explorer-analysis'){
      progress('Verifying saved inputs and recomputing ancestral evidence');
      const replay=await replayAncestralRecord(content,progress);
      const rows=parseAncestralFasta(replay.input.alignment.fasta);
      return {...replay,columns:rows[0].sequence.length,tips:rows.length,options:replay.result.options,verified:true};
    }
    input=validateAncestralDataset(decoded);
  }else if(request.kind==='load'||request.kind==='analyze')input=validateAncestralDataset(request.input);
  else throw new Error('Unsupported ancestral operation.');
  const rows=parseAncestralFasta(input.alignment.fasta);
  if(request.kind==='analyze'){
    const result=reconstructAncestors(input,request.options,progress);
    progress('Binding exact inputs, model and posterior evidence');
    return {input,columns:rows[0].sequence.length,tips:rows.length,options:result.options,result,
      record:await createAncestralRecord(input,result),verified:false};
  }
  return {input,columns:rows[0].sequence.length,tips:rows.length,options:resolveAncestralOptions(rows[0].sequence.length),result:null,record:null,verified:false};
}
export interface AncestralWorker {
  postMessage:(request:AncestralRequest)=>void; terminate:()=>void;
  onmessage:((event:MessageEvent<AncestralMessage>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null; onmessageerror:((event:MessageEvent)=>void)|null;
}
interface Snapshot { accepted:AncestralWork|null; busy:boolean; phase:string; error:string|null; notice:string|null }
const aborted=()=>new DOMException('Ancestral work cancelled','AbortError');
function awaitRead<T>(read:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const cancel=()=>reject(aborted());
    if(signal.aborted){void read.catch(()=>{});cancel();return;}
    signal.addEventListener('abort',cancel,{once:true});
    void read.then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(error);});
  });
}
export class AncestralSession {
  private active=false; private owner:AbortController|null=null;
  private readonly listeners=new Set<()=>void>();
  private snapshot:Snapshot={accepted:null,busy:false,phase:'',error:null,notice:null};
  constructor(private readonly factory:()=>AncestralWorker){}
  getSnapshot=():Snapshot=>this.snapshot;
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(update:Partial<Snapshot>):void{this.snapshot={...this.snapshot,...update};for(const listener of this.listeners)listener();}
  activate=():void=>{this.active=true;};
  deactivate=():void=>{this.active=false;this.cancel();};
  cancel=():void=>{
    const old=this.owner;this.owner=null;old?.abort();
    this.publish({busy:false,phase:'',...(old?{notice:'Ancestral work cancelled; accepted evidence was preserved.'}:{})});
  };
  run=async(input:AncestralRequest|Promise<AncestralRequest>):Promise<void>=>{
    if(!this.active){if(input instanceof Promise)void input.catch(()=>{});return;}
    this.cancel();const owner=new AbortController();this.owner=owner;
    const current=()=>this.active&&this.owner===owner&&!owner.signal.aborted;
    this.publish({busy:true,error:null,notice:null,phase:'Reading local ancestral input'});
    try{
      const request=await awaitRead(input instanceof Promise?input.then(value=>structuredClone(value)):Promise.resolve(structuredClone(input)),owner.signal);
      if(!current())return;
      const value=await new Promise<AncestralWork>((resolve,reject)=>{
        const worker=this.factory();let done=false;
        const finish=(value?:AncestralWork,error?:Error)=>{
          if(done)return;done=true;owner.signal.removeEventListener('abort',cancel);worker.terminate();
          if(error)reject(error);else resolve(value!);
        };
        const cancel=()=>finish(undefined,aborted());owner.signal.addEventListener('abort',cancel,{once:true});
        worker.onmessage=event=>{
          if(done||!current())return;const message=event.data;
          if(message?.kind==='progress'&&typeof message.phase==='string')this.publish({phase:message.phase});
          else if(message?.kind==='result'&&message.value?.input&&message.value.options&&Number.isSafeInteger(message.value.columns))finish(message.value);
          else finish(undefined,new Error(message?.kind==='error'?message.message:'Unexpected ancestral worker response.'));
        };
        worker.onerror=()=>finish(undefined,new Error('Ancestral worker failed. Retry the local operation.'));
        worker.onmessageerror=()=>finish(undefined,new Error('Ancestral worker response could not be read.'));
        try{if(owner.signal.aborted)cancel();else worker.postMessage(request);}
        catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}
      });
      if(current())this.publish({accepted:value,notice:value.verified?'Verified ancestral replay: fresh node and edge probabilities and complete evidence identity match.':value.result?'Ancestral reconstruction computed. Inspect excluded sites and conditional model assumptions.':'Alignment and tree loaded. Review inputs, then run reconstruction.'});
    }catch(cause){if(current())this.publish({error:cause instanceof Error?cause.message:String(cause)});}
    finally{if(current()){this.owner=null;this.publish({busy:false,phase:''});}}
  };
}
