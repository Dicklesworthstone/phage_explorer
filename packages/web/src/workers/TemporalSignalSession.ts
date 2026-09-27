/** One private dated-tree workspace. Late reads/workers cannot replace accepted evidence. */
import { analyzeTemporalSignal, createTemporalRecord, parseTemporalSampleTable, replayTemporalRecord,
  resolveTemporalOptions, validateTemporalDataset, type TemporalDataset, type TemporalOptions, type TemporalResult } from '../../../core/src/analysis/temporal-signal';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type TemporalRequest =
  | { kind: 'import'; content: string }
  | { kind: 'prepare'; dataset: Omit<TemporalDataset, 'samples'>; sampleTable: string }
  | { kind: 'analyze'; dataset: TemporalDataset; options: Partial<TemporalOptions> }
  | { kind: 'example' };
export interface TemporalWorkResult { dataset: TemporalDataset; options: TemporalOptions; result: TemporalResult | null; record: AnalysisRecord | null; verified: boolean }
export type TemporalMessage = { kind: 'progress'; phase: string } | { kind: 'result'; value: TemporalWorkResult } | { kind: 'error'; message: string };

export async function executeTemporalRequest(request: TemporalRequest, progress: (phase: string) => void = () => {}): Promise<TemporalWorkResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported temporal request.');
  progress('Validating private tree and collection-date inputs');
  let dataset: TemporalDataset;
  if (request.kind === 'import') {
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) throw new Error('Saved temporal file exceeds the 10 MiB limit.');
    const parsed: unknown = JSON.parse(request.content.replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object' && 'format' in parsed && parsed.format === 'phage-explorer-analysis') {
      progress('Verifying saved input hashes and recomputing temporal diagnostics');
      const replay = await replayTemporalRecord(request.content.replace(/^\uFEFF/, ''));
      return { ...replay, options: replay.result.options, verified: true };
    }
    dataset = validateTemporalDataset(parsed);
  } else if (request.kind === 'prepare') {
    dataset = validateTemporalDataset({ ...request.dataset, samples: parseTemporalSampleTable(request.sampleTable) });
  } else if (request.kind === 'example') {
    dataset = validateTemporalDataset({ format: 'phage-explorer-temporal-signal', version: 1, name: 'Synthetic fixed-root teaching example',
      source: { kind: 'demo', description: 'Hand-constructed branch lengths and dates; not samples of the selected phage.', reference: null, license: 'CC0 synthetic example' },
      tree: { newick: '((A:.01,B:.02):.01,(C:.03,D:.04):.01);', units: 'substitutions/site', inferredWithoutDates: true,
        method: 'Analytical teaching fixture', rooting: 'Fixed synthetic root', alignmentProvenance: 'Synthetic branch lengths; no measured sequence alignment' },
      samples: ['A','B','C','D'].map((id,i) => ({ id, accession: null, collectionDate: 2000+i,
        dateSource: 'Synthetic decimal year', permutationGroup: i<2?'one':'two' })) });
  } else if (request.kind === 'analyze') {
    dataset = validateTemporalDataset(request.dataset);
    progress('Computing fixed-root regression, sensitivity and date-label permutations');
    const result = analyzeTemporalSignal(dataset, request.options);
    progress('Binding exact inputs, settings and evidence to the portable result');
    const record = await createTemporalRecord(dataset, result);
    return { dataset, options: result.options, result, record, verified: false };
  } else throw new Error('Unsupported temporal operation.');
  return { dataset, options: resolveTemporalOptions(), result: null, record: null, verified: false };
}

export interface TemporalWorker {
  postMessage: (request: TemporalRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<TemporalMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface Snapshot { accepted: TemporalWorkResult | null; busy: boolean; phase: string; error: string | null; notice: string | null }
const abortError = () => new DOMException('Temporal work cancelled', 'AbortError');
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve,reject) => {
    const cancel = () => reject(abortError());
    if (signal.aborted) { reject(abortError()); void work.catch(()=>{}); return; }
    signal.addEventListener('abort',cancel,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));
  });
}
export class TemporalSignalSession {
  private active = false;
  private operation: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => TemporalWorker) {}
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (()=>void) => { this.listeners.add(listener); return ()=>{this.listeners.delete(listener);}; };
  private publish(update: Partial<Snapshot>): void { this.snapshot={...this.snapshot,...update};for(const listener of this.listeners)listener(); }
  activate = (): void => { this.active=true; };
  deactivate = (): void => { this.active=false; this.cancel(); };
  cancel = (): void => {
    const previous=this.operation; this.operation=null; previous?.abort();
    this.publish({busy:false,phase:'',...(previous?{notice:'Temporal work cancelled; the last accepted dataset and result were preserved.'}:{})});
  };
  run = async (input: TemporalRequest | Promise<TemporalRequest>): Promise<void> => {
    if(!this.active)return;
    this.cancel();const owner=new AbortController();this.operation=owner;
    const current=()=>this.active&&this.operation===owner&&!owner.signal.aborted;
    this.publish({busy:true,error:null,notice:null,phase:'Reading private input'});
    try {
      const request=await untilCancelled(input instanceof Promise?input.then(value=>structuredClone(value)):Promise.resolve(structuredClone(input)),owner.signal);
      if(!current())return;
      const value=await new Promise<TemporalWorkResult>((resolve,reject)=>{
        const worker=this.factory(); let done=false;
        const finish=(result?:TemporalWorkResult,error?:Error)=>{
          if(done)return;done=true;owner.signal.removeEventListener('abort',cancel);worker.terminate();
          if(error)reject(error);else resolve(result!);
        };
        const cancel=()=>finish(undefined,abortError());
        owner.signal.addEventListener('abort',cancel,{once:true});
        worker.onmessage=event=>{
          if(done||!current())return;
          const message=event.data;
          if(message?.kind==='progress'&&typeof message.phase==='string')this.publish({phase:message.phase});
          else if(message?.kind==='result'&&message.value&&typeof message.value==='object')finish(message.value);
          else if(message?.kind==='error'&&typeof message.message==='string')finish(undefined,new Error(message.message));
          else finish(undefined,new Error('Unexpected temporal worker response.'));
        };
        worker.onerror=()=>finish(undefined,new Error('Temporal worker failed. Retry the local operation.'));
        worker.onmessageerror=()=>finish(undefined,new Error('Temporal worker response could not be read.'));
        try { if(owner.signal.aborted)cancel();else worker.postMessage(request); } catch(cause){finish(undefined,cause instanceof Error?cause:new Error(String(cause)));}
      });
      if(current())this.publish({accepted:value,notice:value.verified?'Verified temporal replay: fresh diagnostics and complete evidence identity match.'
        :value.result?'Temporal diagnostics computed. Review exclusions, residuals and assumptions.':'Dataset loaded. Review inputs and select Run temporal diagnostics.'});
    } catch(cause){if(current())this.publish({error:cause instanceof Error?cause.message:String(cause)});}
    finally {if(current()){this.operation=null;this.publish({busy:false,phase:''});}}
  };
}
