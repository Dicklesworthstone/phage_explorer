/** Database-free mapped protein-reference inspection, structural evidence and verified replay. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { parseProteinReferenceBundle, prepareProteinCoordinateInput, parseProteinCoordinates, PROTEIN_COORDINATE_LIMITS,
  type ProteinCoordinateInput } from '../../../core/src/protein-reference';
import {
  createProteinStructureExperiment, replayProteinStructureExperiment,
  exportProteinStructureTsv, createProteinCoordinateExperiment, replayProteinCoordinateExperiment, exportProteinCoordinateTsv,
  PROTEIN_COORDINATE_METHOD, type ProteinStructureOptions,
} from '../../../core/src/analysis/tail-fiber-structure';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;

export const PROTEIN_STRUCTURE_HELP = `Mapped protein reference evidence (local files only; no catalog/network required)

  phage-explorer protein-structure prepare STRUCTURE_CIF --sequence PROTEIN_FASTA --chain LABEL --protein-start N
  phage-explorer protein-structure inspect INPUT_JSON
  phage-explorer protein-structure analyze INPUT_JSON [settings]
  phage-explorer protein-structure replay SAVED_ANALYSIS

Prepare settings (standalone local mmCIF; no complex/embedding metadata needed):
  --sequence FILE          exactly one canonical protein FASTA record
  --chain LABEL            explicit mmCIF label_asym_id
  --protein-start N        protein position corresponding to label_seq_id 1
  --model N                explicit model number (default 1)
  --alt-location ID        required when selected C-alpha atoms have alternatives
  --source DESCRIPTION    source attribution (defaults to the mmCIF filename)
  --citation REFERENCE    optional publication, model or notebook reference
  --demo                   mark the supplied coordinates as a teaching demonstration

Analyze settings:
  --protein ID              protein ID from the reference snapshot
  --chain LABEL|none        explicit label chain, or none for alignment-only evidence
  --scope chain|assembly    within-chain only or compare supplied assembly partners
  --cutoff ANGSTROM         inclusive C-alpha contact cutoff (>0, <=30; default 8)
  --separation RESIDUES     minimum within-chain sequence separation (1..10000; default 3)

Common options:
  --format json|residues|contacts   analyze/replay output (default json)
  --output NEW_FILE                 write a new file; existing files are never replaced
  -                                 read the single input from stdin

prepare validates a local mmCIF chain against its explicitly mapped protein and emits
portable input JSON. inspect validates either this local input or the complete
versioned reference snapshot without running geometry. analyze computes observed alignment diversity and
C-alpha proximity using the same producer as the browser. Local mmCIF inputs use
one mapped chain; --scope assembly is available only for validated complex references. replay recomputes every
field and rejects changed source bytes, settings or results. Residue/contact TSV
exports retain source identity and coordinate conventions.

Checksums identify content; they do not authenticate sources. C-alpha proximity is
not docking energy, affinity, SASA, mutation effect or host range. Missing residues,
atoms, chains and assembly copies are never invented.
`;

export type ProteinStructureOperation = 'prepare' | 'inspect' | 'analyze' | 'replay';
interface CoordinatePreparation {
  sequence: string; labelAsymId: string; proteinStart: number; model: number; alternateLocation: string | null;
  source: ProteinCoordinateInput['source'];
}
export interface ProteinStructureCommand {
  operation: ProteinStructureOperation; input: string; output?: string;
  format: 'json' | 'residues' | 'contacts'; options: ProteinStructureOptions; preparation?: CoordinatePreparation;
}
export interface ProteinStructureJob {
  operation: ProteinStructureOperation; input: { name: string; text: string }; options?: ProteinStructureOptions;
  preparation?: Omit<CoordinatePreparation, 'sequence'> & { proteinFasta: string };
}
export interface ProteinStructureJobResult {
  content: string; residues: string | null; contacts: string | null; identity: string | null; verified: boolean;
}
export type ProteinStructureJobMessage =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; result: ProteinStructureJobResult }
  | { kind: 'error'; message: string };
export interface ProteinStructureCommandIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  execute?: typeof runProteinStructureJob;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Protein structure operation cancelled.','AbortError');
}
function requireText(value: unknown, limit: number, label: string): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) throw new Error(label + ' exceeds its byte limit.');
}
export async function executeProteinStructureJob(job: ProteinStructureJob,
  progress: (message: string) => void = () => {}): Promise<ProteinStructureJobResult> {
  if (!job || !['prepare','inspect','analyze','replay'].includes(job.operation) || !job.input || typeof job.input.name !== 'string') {
    throw new Error('Unsupported protein structure job.');
  }
  requireText(job.input.text,job.operation === 'replay' ? RECORD_LIMIT : PROTEIN_COORDINATE_LIMITS.bytes,'Protein input');
  if (job.operation === 'prepare') {
    if (!job.preparation || job.options && Object.keys(job.options).length) throw new Error('prepare requires one protein FASTA and explicit mapping, without analysis settings.');
    const { proteinFasta, source, ...mapping } = job.preparation;
    progress('Validating supplied mmCIF chain, model and explicit protein mapping');
    const input = prepareProteinCoordinateInput(job.input.text, proteinFasta, job.input.name, mapping, source);
    parseProteinCoordinates(input);
    return { content:JSON.stringify(input,null,2),residues:null,contacts:null,identity:null,verified:false };
  }
  if (job.preparation) throw new Error('Coordinate preparation settings apply only to prepare.');
  const content = job.input.text.replace(/^\uFEFF/, '');
  if (job.operation === 'replay') {
    if (job.options && Object.keys(job.options).length) throw new Error('Replay cannot override saved protein structure settings.');
    progress('Recomputing saved protein evidence');
    if (JSON.parse(content)?.method?.id === PROTEIN_COORDINATE_METHOD.id) {
      const experiment=await replayProteinCoordinateExperiment(content);
      return {content:serializeAnalysisRecord(experiment.record),residues:exportProteinCoordinateTsv(experiment.record,'residues'),
        contacts:exportProteinCoordinateTsv(experiment.record,'contacts'),identity:experiment.record.resultId,verified:true};
    }
    const experiment=await replayProteinStructureExperiment(content);
    return {content:serializeAnalysisRecord(experiment.record),residues:exportProteinStructureTsv(experiment.record,'residues'),
      contacts:exportProteinStructureTsv(experiment.record,'contacts'),identity:experiment.record.resultId,verified:true};
  }
  const value: unknown = JSON.parse(content);
  if ((value as {format?:unknown} | null)?.format === 'phage-explorer-protein-coordinates') {
    progress('Validating local mmCIF coordinates and explicit residue correspondence');
    const { input } = parseProteinCoordinates(value);
    if (job.operation === 'inspect') {
      if (job.options && Object.keys(job.options).length) throw new Error('inspect validates inputs without analysis settings.');
      return {content:JSON.stringify(input,null,2),residues:null,contacts:null,identity:null,verified:false};
    }
    progress('Computing supplied within-chain C-alpha geometry');
    const experiment=await createProteinCoordinateExperiment(input,job.options ?? {});
    return {content:serializeAnalysisRecord(experiment.record),residues:exportProteinCoordinateTsv(experiment.record,'residues'),
      contacts:exportProteinCoordinateTsv(experiment.record,'contacts'),identity:experiment.record.resultId,verified:false};
  }
  progress('Validating versioned protein reference sources and mappings');
  const reference=await parseProteinReferenceBundle(value);
  if (job.operation === 'inspect') {
    if (job.options && Object.keys(job.options).length) throw new Error('inspect validates the reference without analysis settings.');
    return {content:JSON.stringify(reference,null,2),residues:null,contacts:null,identity:null,verified:false};
  }
  progress('Computing observed alignment diversity and C-alpha geometry');
  const experiment=await createProteinStructureExperiment(reference,job.options ?? {});
  return {content:serializeAnalysisRecord(experiment.record),residues:exportProteinStructureTsv(experiment.record,'residues'),
    contacts:exportProteinStructureTsv(experiment.record,'contacts'),identity:experiment.record.resultId,verified:false};
}

declare const PHAGE_PROTEIN_STRUCTURE_WORKER: string | undefined;
export function runProteinStructureJob(job: ProteinStructureJob, signal?: AbortSignal,
  progress: (message: string) => void = () => {}): Promise<ProteinStructureJobResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('Protein structure operation cancelled.','AbortError'));
  return new Promise((resolveResult,reject) => {
    let settled=false;
    const url=typeof PHAGE_PROTEIN_STRUCTURE_WORKER === 'string'
      ? new URL(PHAGE_PROTEIN_STRUCTURE_WORKER,import.meta.url)
      : new URL('../workers/protein-structure-worker.ts',import.meta.url);
    const worker=new Worker(url);
    const finish=(error: Error|null,result?: ProteinStructureJobResult) => {
      if (settled) return; settled=true;
      signal?.removeEventListener('abort',abort); void worker.terminate().catch(()=>{});
      if (error) reject(error); else resolveResult(result!);
    };
    const abort=()=>finish(new DOMException('Protein structure operation cancelled.','AbortError'));
    worker.on('message',(message: ProteinStructureJobMessage)=>{
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message.kind === 'progress') {
        try { progress(message.message); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
      } else if (message.kind === 'result') finish(null,message.result);
      else finish(new Error(message.kind === 'error' ? message.message : 'Invalid protein structure worker response.'));
    });
    worker.on('error',cause=>finish(cause instanceof Error ? cause : new Error(String(cause))));
    worker.on('exit',code=>finish(new Error('Protein structure worker exited before returning a result (code ' + code + ').')));
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

export function parseProteinStructureCommand(args: string[]): ProteinStructureCommand|null {
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:{
    protein:{type:'string'},chain:{type:'string'},scope:{type:'string'},cutoff:{type:'string'},separation:{type:'string'},
    sequence:{type:'string'},'protein-start':{type:'string'},model:{type:'string'},'alt-location':{type:'string'},
    source:{type:'string'},citation:{type:'string'},demo:{type:'boolean'},
    format:{type:'string'},output:{type:'string'},help:{type:'boolean',short:'h'},
  }});
  if (values.help || args.length===0) return null;
  const [operation,input]=positionals;
  if (positionals.length!==2 || !['prepare','inspect','analyze','replay'].includes(operation)) {
    throw new Error('Expected protein-structure prepare|inspect|analyze|replay INPUT. See protein-structure --help.');
  }
  if (!input.trim() || Object.values(values).some(value=>typeof value==='string' && !value.trim())) throw new Error('Paths and setting values must not be empty.');
  const format=values.format ?? 'json';
  if (!['json','residues','contacts'].includes(format)) throw new Error('--format must be json, residues or contacts.');
  if (operation==='prepare') {
    if (!values.sequence || !values.chain || values.chain==='none' || values['protein-start']===undefined) {
      throw new Error('prepare requires --sequence PROTEIN_FASTA, --chain LABEL and --protein-start N.');
    }
    if (format!=='json' || [values.protein,values.scope,values.cutoff,values.separation].some(value=>value!==undefined)) {
      throw new Error('prepare emits input JSON and accepts no analysis settings.');
    }
    if (input==='-' && values.sequence==='-') throw new Error('Only one preparation input can use stdin.');
    const proteinStart=Number(values['protein-start']),model=values.model===undefined?1:Number(values.model);
    if (!Number.isSafeInteger(proteinStart) || proteinStart<1 || !Number.isSafeInteger(model) || model<1 || model>9999) throw new Error('Protein start and model must be positive integers; model is at most 9999.');
    return {operation:'prepare',input,format:'json',output:values.output==='-'?undefined:values.output,options:{},
      preparation:{sequence:values.sequence,labelAsymId:values.chain,proteinStart,model,alternateLocation:values['alt-location']??null,
        source:{kind:values.demo?'demo':'local',description:values.source??basename(input),reference:values.citation??null}}};
  }
  if ([values.sequence,values['protein-start'],values.model,values['alt-location'],values.source,values.citation,values.demo].some(value=>value!==undefined)) {
    throw new Error('Sequence, mapping and source options apply only to prepare; analysis and replay retain the embedded input.');
  }
  const hasSettings=[values.protein,values.chain,values.scope,values.cutoff,values.separation].some(value=>value!==undefined);
  if (operation==='inspect' && (hasSettings || format!=='json')) throw new Error('inspect accepts no analysis settings and emits reference JSON.');
  if (operation==='replay' && hasSettings) throw new Error('Replay cannot override saved protein structure settings.');
  const options: ProteinStructureOptions={};
  if (values.protein!==undefined) options.proteinId=values.protein;
  if (values.chain!==undefined) options.chainLabelAsymId=values.chain==='none' ? null : values.chain;
  if (values.scope!==undefined) {
    if (values.scope!=='chain' && values.scope!=='assembly') throw new Error('--scope must be chain or assembly.');
    options.contactScope=values.scope;
  }
  if (values.cutoff!==undefined) {
    const value=Number(values.cutoff); if (!Number.isFinite(value)) throw new Error('--cutoff must be numeric.');
    options.contactCutoffAngstrom=value;
  }
  if (values.separation!==undefined) {
    const value=Number(values.separation); if (!Number.isSafeInteger(value)) throw new Error('--separation must be an integer.');
    options.minSequenceSeparation=value;
  }
  return {operation:operation as ProteinStructureOperation,input,format:format as ProteinStructureCommand['format'],
    output:values.output==='-'?undefined:values.output,options};
}
function writeStream(stream: Writable,content: string): Promise<void> {
  return new Promise((resolveWrite,reject)=>{
    const fail=(error: Error)=>{stream.off('error',fail);reject(error);};
    stream.once('error',fail);
    stream.write(content,error=>{if(error){reject(error);return;}stream.off('error',fail);resolveWrite();});
  });
}
async function assertNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code==='ENOENT') return;
    throw cause;
  }
  throw new Error('Output already exists; choose a new file. Existing inputs and results are never overwritten.');
}
function clean(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
}
export async function runProteinStructureCommand(args: string[],io: ProteinStructureCommandIO): Promise<number> {
  let command: ProteinStructureCommand|null;
  try { command=parseProteinStructureCommand(args); }
  catch(cause){await writeStream(io.stderr,'Protein structure: '+clean(cause)+'\n');return 2;}
  if(!command){await writeStream(io.stdout,PROTEIN_STRUCTURE_HELP);return 0;}
  try {
    check(io.signal);
    const destination=command.output?resolve(command.output):undefined;
    if(destination) await assertNewOutput(destination);
    const limit=command.operation==='replay'?RECORD_LIMIT:PROTEIN_COORDINATE_LIMITS.bytes;
    const content=command.input==='-'?await readAbundanceStdin(io.stdin,limit,io.signal):await readAbundanceFile(command.input,limit,io.signal);
    check(io.signal);
    const progress=(message:string)=>{void writeStream(io.stderr,JSON.stringify({operation:command!.operation,phase:clean(message)})+'\n').catch(()=>{});};
    let preparation: ProteinStructureJob['preparation'];
    if(command.preparation) {
      const {sequence,...settings}=command.preparation;
      const proteinFasta=sequence==='-'?await readAbundanceStdin(io.stdin,PROTEIN_COORDINATE_LIMITS.proteinBytes,io.signal)
        :await readAbundanceFile(sequence,PROTEIN_COORDINATE_LIMITS.proteinBytes,io.signal);
      preparation={...settings,proteinFasta};
    }
    check(io.signal);
    const result=await (io.execute??runProteinStructureJob)({operation:command.operation,
      input:{name:command.input==='-'?'stdin protein input':basename(command.input),text:content},
      options:command.options,...(preparation?{preparation}:{})},io.signal,progress);
    check(io.signal);
    const output=command.format==='json'?result.content+'\n':command.format==='residues'?result.residues:result.contacts;
    if(output===null) throw new Error('TSV export requires an analyzed or replayed protein reference.');
    if(destination) await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});
    else await writeStream(io.stdout,output);
    return 0;
  } catch(cause) {
    await writeStream(io.stderr,'Protein structure: '+clean(cause)+'\n');
    return io.signal?.aborted || cause instanceof Error && cause.name==='AbortError'?130:1;
  }
}
export async function runProteinStructureProcess(args: string[]): Promise<void> {
  const controller=new AbortController(); let terminated=false;
  const interrupt=()=>controller.abort();
  const terminate=()=>{terminated=true;controller.abort();};
  process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try {
    const code=await runProteinStructureCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});
    process.exitCode=code===130&&terminated?143:code;
  } finally {process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);process.stdin.pause();}
}
