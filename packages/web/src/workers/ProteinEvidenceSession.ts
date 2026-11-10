/** Portable, source-bound protein evidence computed in disposable workers. */
import { analysisJson, parseAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { parseProteinReferenceBundle, type ProteinReferenceBundle } from '../../../core/src/protein-reference';
import {
  createProteinStructureExperiment, replayProteinStructureExperiment, resolveProteinStructureOptions,
  PROTEIN_STRUCTURE_LIMITS, PROTEIN_STRUCTURE_METHOD, type ProteinStructureOptions,
} from '../../../core/src/analysis/tail-fiber-structure';

export type ProteinEvidenceExperiment = Awaited<ReturnType<typeof createProteinStructureExperiment>>;
export type ProteinEvidenceOrigin =
  | { kind: 'current-cds'; genomeAccession: string; geneId: number; proteinAccession: string }
  | { kind: 'reference-file' | 'saved-experiment'; name: string };
export type ProteinEvidenceRequest =
  | { kind: 'analyze'; reference: ProteinReferenceBundle; options: ProteinStructureOptions }
  | { kind: 'inspect' | 'replay'; content: string };
export type ProteinEvidenceResult =
  | { kind: 'reference'; reference: ProteinReferenceBundle }
  | { kind: 'experiment'; experiment: ProteinEvidenceExperiment; verified: boolean };
export type ProteinEvidenceMessage = ProteinEvidenceResult
  | { kind: 'progress'; phase: string } | { kind: 'error'; message: string };
export const PROTEIN_EXPERIMENT_FILE_LIMIT = 10 * 1024 * 1024;

function checkContent(content: unknown, maximum: number): asserts content is string {
  if (typeof content !== 'string' || content.length > maximum || new TextEncoder().encode(content).length > maximum) {
    throw new Error('Protein input exceeds the ' + maximum / 1024 + ' KiB file limit.');
  }
}

export async function readProteinEvidenceFile(file: Pick<File, 'size' | 'arrayBuffer'>, kind: 'reference' | 'experiment'): Promise<string> {
  const maximum = kind === 'reference' ? PROTEIN_STRUCTURE_LIMITS.referenceBytes : PROTEIN_EXPERIMENT_FILE_LIMIT;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) throw new Error('Protein input exceeds the ' + maximum / 1024 + ' KiB file limit.');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > maximum) throw new Error('Protein input exceeds the ' + maximum / 1024 + ' KiB file limit.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

/** Only the real core producer and fresh numerical replay can produce an experiment. */
export async function executeProteinEvidenceRequest(request: ProteinEvidenceRequest,
  progress: (phase: string) => void = () => {}): Promise<ProteinEvidenceResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported protein evidence request.');
  if (request.kind === 'analyze') {
    progress('Computing observed alignment diversity and mapped C-alpha geometry');
    return { kind: 'experiment', experiment: await createProteinStructureExperiment(request.reference, request.options), verified: false };
  }
  if (request.kind === 'inspect') {
    checkContent(request.content, PROTEIN_STRUCTURE_LIMITS.referenceBytes);
    progress('Validating source identities, alignment rows and observed coordinate mappings');
    return { kind: 'reference', reference: await parseProteinReferenceBundle(JSON.parse(request.content.replace(/^\uFEFF/, ''))) };
  }
  if (request.kind === 'replay') {
    checkContent(request.content, PROTEIN_EXPERIMENT_FILE_LIMIT);
    progress('Recomputing the saved reference experiment and verifying its complete result identity');
    return { kind: 'experiment', experiment: await replayProteinStructureExperiment(request.content.replace(/^\uFEFF/, '')), verified: true };
  }
  throw new Error('Unsupported protein evidence operation.');
}

export interface ProteinEvidenceWorker {
  postMessage(request: ProteinEvidenceRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ProteinEvidenceMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface ProteinEvidenceSnapshot {
  scope: object | null;
  reference: ProteinReferenceBundle | null;
  accepted: ProteinEvidenceExperiment | null;
  origin: ProteinEvidenceOrigin | null;
  verified: boolean;
  busy: boolean;
  phase: string;
  error: string | null;
}
const cancelled = () => new DOMException('Protein evidence operation cancelled.', 'AbortError');
const same = (a: unknown, b: unknown) => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      cause => { signal.removeEventListener('abort', abort); reject(cause); });
    if (signal.aborted) abort();
  });
}

/** A view scope owns reads, worker lifetime, accepted results and their export identity. */
export class ProteinEvidenceSession {
  private active = false;
  private scope: object | null = null;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: ProteinEvidenceSnapshot = { scope: null, reference: null, accepted: null, origin: null,
    verified: false, busy: false, phase: '', error: null };
  constructor(private readonly factory: () => ProteinEvidenceWorker) {}
  getSnapshot = (): ProteinEvidenceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ProteinEvidenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  setScope = (scope: object): void => {
    if (scope === this.scope) return;
    this.scope = scope; this.cancel();
    this.publish({ scope, reference: null, accepted: null, origin: null, verified: false, error: null, phase: '' });
  };
  cancel = (): void => {
    const old = this.operation; this.operation = null; old?.abort();
    this.publish({ busy: false, phase: old ? 'Cancelled. No partial evidence was accepted.' : '' });
  };
  run = async (scope: object, input: ProteinEvidenceRequest | ((signal: AbortSignal) => Promise<ProteinEvidenceRequest>),
    origin: ProteinEvidenceOrigin): Promise<boolean> => {
    if (!this.active || this.scope !== scope) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.scope === scope && this.operation === owner && !owner.signal.aborted;
    try {
      const captured = typeof input === 'function' ? input : structuredClone(input);
      const capturedOrigin = structuredClone(origin);
      this.publish({ accepted: null, reference: null, origin: null, verified: false, busy: true, error: null, phase: 'Reading exact protein inputs' });
      if (!current()) return false;
      const request = await abortable(typeof captured === 'function'
        ? captured(owner.signal).then(value => structuredClone(value)) : Promise.resolve(captured), owner.signal);
      if (!current()) return false;
      // Bind replies to submitted inputs/settings; the worker performs every numerical calculation.
      let expectedReference: unknown = null;
      if (request.kind === 'analyze') expectedReference = request.reference;
      else if (request.kind === 'inspect') {
        checkContent(request.content, PROTEIN_STRUCTURE_LIMITS.referenceBytes);
        expectedReference = JSON.parse(request.content.replace(/^\uFEFF/, ''));
      } else checkContent(request.content, PROTEIN_EXPERIMENT_FILE_LIMIT);
      const expectedOptions = request.kind === 'analyze' ? resolveProteinStructureOptions(request.reference, request.options) : null;
      const saved: AnalysisRecord | null = request.kind === 'replay'
        ? await abortable(parseAnalysisRecord(request.content.replace(/^\uFEFF/, '')), owner.signal) : null;
      if (!current()) return false;
      const response = await new Promise<ProteinEvidenceResult>((resolve, reject) => {
        const worker = this.factory(); let done = false, validating = false;
        const finish = (value?: ProteinEvidenceResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* Ownership still ends if termination fails. */ }
          if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(undefined, cancelled());
        owner.signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          if (done || validating || !current()) return;
          const message = event.data;
          try {
            if (message?.kind === 'progress' && typeof message.phase === 'string') { this.publish({ phase: message.phase }); return; }
            if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
            if (message?.kind === 'reference' && request.kind === 'inspect' && same(message.reference, expectedReference)) { finish(message); return; }
            if (message?.kind !== 'experiment' || request.kind === 'inspect' || message.verified !== (request.kind === 'replay')
              || message.experiment?.record?.method?.id !== PROTEIN_STRUCTURE_METHOD.id) {
              finish(undefined, new Error('Unexpected protein evidence worker response.')); return;
            }
            validating = true;
            void parseAnalysisRecord(JSON.stringify(message.experiment.record), { methodId: PROTEIN_STRUCTURE_METHOD.id, methodVersion: PROTEIN_STRUCTURE_METHOD.version })
              .then(record => {
                if (done || !current()) return;
                const experiment = message.experiment;
                const selectedProtein = experiment.reference.proteins.find(protein => protein.id === experiment.options.proteinId);
                if (!same(record.method, PROTEIN_STRUCTURE_METHOD) || record.seed !== null || record.inputs.length !== 1 || record.inputs[0].id !== 'reference'
                  || record.inputs[0].source !== 'external' || !selectedProtein || record.inputs[0].accession !== selectedProtein.accession
                  || !same(record.inputs[0].data, experiment.reference) || !same(record.parameters, experiment.options)
                  || !same(record.fields.structure?.value, experiment.result)
                  || (expectedReference !== null && (!same(expectedReference, experiment.reference) || !same(expectedOptions, experiment.options)))
                  || (saved !== null && saved.resultId !== record.resultId)) {
                  throw new Error('Protein evidence reply differs from its submitted source, settings or saved identity.');
                }
                finish(message);
              }).catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
          } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
        };
        worker.onerror = () => finish(undefined, new Error('Protein evidence worker failed. Retry the local computation.'));
        worker.onmessageerror = () => finish(undefined, new Error('Protein evidence worker response could not be decoded.'));
        try { if (owner.signal.aborted) abort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      if (response.kind === 'reference') this.publish({ reference: response.reference, origin: capturedOrigin,
        phase: 'Reference loaded. Choose a protein and mapped chain, then analyze.' });
      else this.publish({ reference: response.experiment.reference, accepted: response.experiment, origin: capturedOrigin, verified: response.verified,
        phase: response.verified ? 'Replay verified: fresh calculations and the saved complete result identity agree.' : 'Analysis complete. Inspect the observed coverage and missing residues.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause), phase: '' });
      return false;
    } finally { if (current()) { this.operation = null; this.publish({ busy: false }); } }
  };
}
