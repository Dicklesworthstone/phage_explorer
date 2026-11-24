/** Owned local attachment reconstruction and complete-record replay. */
import {
  ATTACHMENT_LIMITS, parseAttachmentDna, validateAttachmentInput, resolveAttachmentOptions,
  reconstructAttachment, createAttachmentExperimentRecord, replayAttachmentExperiment,
  PROPHAGE_EXCISION_METHOD, parseProphageExcisionDna, validateProphageExcisionInput,
  reconstructProphageExcision, createProphageExcisionRecord, replayProphageExcisionRecord,
  type ProphageExcisionInput, type ProphageExcisionResult,
  type AttachmentSequenceInput, type AttachmentCoreSite, type AttachmentOptions,
  type AttachmentReconstructionInput, type AttachmentReconstructionResult,
} from '../../../core/src/analysis/prophage-excision';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type ProphageIntegrationRequest =
  | { kind: 'analyze'; input: AttachmentReconstructionInput; options?: Partial<AttachmentOptions> }
  | { kind: 'prepare'; hostContent: string; host: Omit<AttachmentSequenceInput, 'sequence'>;
      phage: AttachmentSequenceInput; attB: AttachmentCoreSite; attP: AttachmentCoreSite;
      circularization: AttachmentReconstructionInput['circularization']; options?: Partial<AttachmentOptions> };
export type ProphageExcisionRequest =
  | { kind: 'excise'; input: ProphageExcisionInput; options?: Partial<AttachmentOptions> }
  | { kind: 'prepare-excision'; locusContent: string; locus: Omit<AttachmentSequenceInput, 'sequence'>;
      attL: AttachmentCoreSite; attR: AttachmentCoreSite; options?: Partial<AttachmentOptions> };
export type ProphageAttachmentRequest = ProphageIntegrationRequest | ProphageExcisionRequest
  | { kind: 'replay'; content: string; expectedPhage?: AttachmentSequenceInput; expectedLocus?: AttachmentSequenceInput };
export interface ProphageAttachmentWork {
  input: AttachmentReconstructionInput; options: AttachmentOptions;
  result: AttachmentReconstructionResult; record: AnalysisRecord; verified: boolean;
}
export interface ProphageExcisionWork {
  input: ProphageExcisionInput; options: AttachmentOptions;
  result: ProphageExcisionResult; record: AnalysisRecord; verified: boolean;
}
export type ProphageAttachmentResult = ProphageAttachmentWork | ProphageExcisionWork;
export function isProphageExcisionWork(value: unknown): value is ProphageExcisionWork {
  return !!value && typeof value === 'object' &&
    (value as Partial<ProphageExcisionWork>).input?.format === 'phage-explorer-prophage-excision';
}
export type ProphageAttachmentMessage = { kind: 'progress'; phase: string }
  | { kind: 'result'; value: ProphageAttachmentResult } | { kind: 'error'; message: string };

export function executeAttachmentRequest(request: ProphageIntegrationRequest, progress?: (phase: string) => void): Promise<ProphageAttachmentWork>;
export function executeAttachmentRequest(request: ProphageExcisionRequest, progress?: (phase: string) => void): Promise<ProphageExcisionWork>;
export function executeAttachmentRequest(request: ProphageAttachmentRequest, progress?: (phase: string) => void): Promise<ProphageAttachmentResult>;
export async function executeAttachmentRequest(
  request: ProphageAttachmentRequest, progress: (phase: string) => void = () => {},
): Promise<ProphageAttachmentResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported attachment request.');
  if (request.kind === 'replay') {
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) {
      throw new Error('Saved attachment experiment exceeds the 10 MiB limit.');
    }
    progress('Verifying saved identities and recomputing exact attachment products');
    const method = JSON.parse(request.content.replace(/^\uFEFF/, ''))?.method?.id;
    if (method === PROPHAGE_EXCISION_METHOD.id) {
      if (request.expectedPhage) throw new Error('Excision replay expects an integrated locus, not a separate phage source.');
      return { ...await replayProphageExcisionRecord(request.content, request.expectedLocus), verified: true };
    }
    if (request.expectedLocus) throw new Error('Integration replay expects its separate sources, not an integrated locus.');
    return { ...await replayAttachmentExperiment(request.content, request.expectedPhage), verified: true };
  }
  if (request.kind === 'excise' || request.kind === 'prepare-excision') {
    progress('Checking the integrated source and declared attL/attR crossover cores');
    const raw: ProphageExcisionInput = request.kind === 'excise' ? request.input : {
      format: 'phage-explorer-prophage-excision', version: 1,
      locus: { ...request.locus, sequence: parseProphageExcisionDna(request.locusContent) },
      attL: request.attL, attR: request.attR,
    };
    const input = validateProphageExcisionInput(raw), options = resolveAttachmentOptions(request.options);
    progress('Reconstructing the excised phage, restored host and complete source-coordinate maps');
    const result = reconstructProphageExcision(input, options);
    progress('Binding both molecules and the declared sites to the excision experiment');
    return { input, options, result, record: await createProphageExcisionRecord(input, result), verified: false };
  }
  if (request.kind !== 'prepare' && request.kind !== 'analyze') throw new Error('Unsupported attachment operation.');
  progress('Checking supplied sources, core coordinates and orientations');
  let raw: AttachmentReconstructionInput;
  if (request.kind === 'prepare') {
    if (typeof request.hostContent !== 'string' || new TextEncoder().encode(request.hostContent).length > ATTACHMENT_LIMITS.inputBytes) {
      throw new Error('Host locus file exceeds the 4 MiB limit.');
    }
    raw = { format: 'phage-explorer-attachment-reconstruction', version: 1,
      host: { ...request.host, sequence: parseAttachmentDna(request.hostContent) }, phage: request.phage,
      attB: request.attB, attP: request.attP, circularization: request.circularization };
  } else raw = request.input;
  const input = validateAttachmentInput(raw), options = resolveAttachmentOptions(request.options);
  progress('Composing the conditional product and preserving both source coordinate maps');
  const result = reconstructAttachment(input, options);
  progress('Binding exact sources, assumptions, junctions and product to the experiment');
  return { input, options, result, record: await createAttachmentExperimentRecord(input, result), verified: false };
}
export interface ProphageAttachmentWorker {
  postMessage: (request: ProphageAttachmentRequest) => void; terminate: () => void;
  onmessage: ((event: MessageEvent<ProphageAttachmentMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
/** Transport checks prevent an unexpected worker payload from reaching view rendering.
 * The owned worker remains responsible for full input, source and result verification.
 */
function attachmentWorkShape(value: ProphageAttachmentResult | undefined): boolean {
  if (isProphageExcisionWork(value)) return excisionWorkShape(value);
  const result = value?.result, input = value?.input, record = value?.record;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  const plain = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const source = (item: AttachmentSequenceInput | undefined) => !!item &&
    typeof item.name === 'string' && typeof item.sequence === 'string' &&
    ['linear', 'circular', 'unknown'].includes(item.topology) &&
    (item.accession === null || typeof item.accession === 'string') &&
    !!item.source && ['local', 'catalog', 'external'].includes(item.source.kind) &&
    typeof item.source.reference === 'string' && typeof item.source.version === 'string' &&
    (item.source.license === null || typeof item.source.license === 'string');
  const interval = (item: { start: number; end: number } | undefined, limit: number) => !!item &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 &&
    item.end >= item.start && item.end <= limit;
  const junction = (item: AttachmentReconstructionResult['attL'] | undefined) => !!item &&
    typeof item.sequence === 'string' && ['+', '-'].includes(item.strand) &&
    interval(item.core, item.sequence.length) && Array.isArray(item.integratedSegments) &&
    item.integratedSegments.every(part => interval(part, result?.integratedSequence.length ?? 0)) &&
    Number.isSafeInteger(item.leftFlankBases) && item.leftFlankBases >= 0 &&
    Number.isSafeInteger(item.rightFlankBases) && item.rightFlankBases >= 0;
  const total = (input?.host?.sequence?.length ?? 0) + (input?.phage?.sequence?.length ?? 0);
  return !!value && typeof value.verified === 'boolean' && input?.format === 'phage-explorer-attachment-reconstruction' &&
    input.version === 1 && source(input.host) && source(input.phage) &&
    !!input.attB && !!input.attP && ['+', '-'].includes(input.attB.strand) && ['+', '-'].includes(input.attP.strand) &&
    interval(input.attB, input.host.sequence.length) && interval(input.attP, input.phage.sequence.length) &&
    typeof input.attB.evidence === 'string' && typeof input.attP.evidence === 'string' &&
    ['already-circular', 'assumed-circularized'].includes(input.circularization) &&
    record?.format === 'phage-explorer-analysis' && record.version === 1 &&
    record.method?.id === 'attachment-reconstruction' && record.method.version === '1' &&
    typeof record.method.implementation === 'string' && record.seed === null &&
    /^[a-f0-9]{64}$/.test(record.resultId) && /^[a-f0-9]{64}$/.test(record.cacheKey) &&
    plain(record.parameters) && record.parameters.flankLength === value.options?.flankLength &&
    Array.isArray(record.inputs) && record.inputs.length === 3 && record.inputs.every((item, index) => item &&
      item.id === ['hostLocus', 'phageGenome', 'attachmentSites'][index] &&
      ['local', 'catalog', 'external'].includes(item.source) && typeof item.description === 'string' &&
      (item.accession === null || typeof item.accession === 'string') &&
      /^[a-f0-9]{64}$/.test(item.sha256) && plain(item.data)) &&
    Array.isArray(record.references) && record.references.length === 1 && record.references.every(item => item &&
      typeof item.id === 'string' && typeof item.version === 'string' && typeof item.description === 'string') &&
    plain(record.fields) && Object.keys(record.fields).length === 1 &&
    record.fields.reconstruction?.kind === 'simulation' && record.fields.reconstruction.units === 'records' &&
    typeof record.fields.reconstruction.label === 'string' && plain(record.fields.reconstruction.value) &&
    strings(record.fields.reconstruction.assumptions) && record.fields.reconstruction.assumptions.length > 0 &&
    strings(record.fields.reconstruction.limitations) &&
    record.fields.reconstruction.coverage?.available === total && record.fields.reconstruction.coverage.total === total &&
    record.fields.reconstruction.coverage.unit === 'bases' &&
    !!result && typeof result.integratedSequence === 'string' && result.integratedSequence.length === total &&
    typeof result.sharedCore === 'string' && ['+', '-'].includes(result.insertionStrand) &&
    ['linear', 'circular'].includes(result.integratedTopology) &&
    Number.isSafeInteger(result.hostCut) && Number.isSafeInteger(result.phageCut) &&
    Number.isInteger(value.options?.flankLength) && value.options.flankLength >= 0 &&
    value.options.flankLength <= ATTACHMENT_LIMITS.flankBases && value.options.flankLength === result.options?.flankLength &&
    Array.isArray(result.segments) && result.segments.every(part => part &&
      ['host', 'phage'].includes(part.source) && ['+', '-'].includes(part.strand) &&
      interval({ start: part.sourceStart, end: part.sourceEnd }, input[part.source].sequence.length) &&
      interval({ start: part.productStart, end: part.productEnd }, total)) &&
    junction(result.attL) && junction(result.attR) &&
    result.conservation?.hostBases === input.host.sequence.length &&
    result.conservation.phageBases === input.phage.sequence.length &&
    result.conservation.integratedBases === total && result.conservation.expectedBases === total &&
    result.conservation.conserved === true &&
    Array.isArray(result.warnings) && result.warnings.every(warning => typeof warning === 'string');
}
function excisionWorkShape(value: ProphageExcisionWork): boolean {
  // The worker computes/validates the products. The main thread checks bounded
  // sources and the exact structures it renders; it never installs saved output.
  const input = validateProphageExcisionInput(value.input), options = resolveAttachmentOptions(value.options);
  const result = value.result, record = value.record, n = input.locus.sequence.length;
  const plain = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  const interval = (start: number, end: number, maximum: number) =>
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= maximum;
  const molecule = (item: ProphageExcisionResult['excisedPhage'] | undefined) => !!item &&
    typeof item.sequence === 'string' && item.sequence.length > 0 && item.sequence.length < n &&
    ['linear', 'circular'].includes(item.topology) && Number.isSafeInteger(item.sourceOrigin) &&
    item.sourceOrigin >= 0 && item.sourceOrigin < n && Array.isArray(item.segments) && item.segments.length > 0 &&
    item.segments.every(part => part && part.strand === '+' && interval(part.sourceStart, part.sourceEnd, n) &&
      interval(part.productStart, part.productEnd, item.sequence.length));
  const junction = (item: ProphageExcisionResult['attP'] | undefined, maximum: number) => !!item &&
    typeof item.sequence === 'string' && ['+', '-'].includes(item.strand) &&
    !!item.core && interval(item.core.start, item.core.end, item.sequence.length) &&
    Array.isArray(item.productSegments) && item.productSegments.every(part => part && interval(part.start, part.end, maximum)) &&
    Number.isSafeInteger(item.leftFlankBases) && item.leftFlankBases >= 0 &&
    Number.isSafeInteger(item.rightFlankBases) && item.rightFlankBases >= 0;
  return typeof value.verified === 'boolean' && value.input.locus.sequence === input.locus.sequence &&
    !!result && result.options?.flankLength === options.flankLength &&
    molecule(result.excisedPhage) && molecule(result.restoredHost) &&
    result.excisedPhage.topology === 'circular' && result.restoredHost.topology === input.locus.topology &&
    typeof result.sharedCore === 'string' && ['+', '-'].includes(result.attachmentStrand) &&
    !!result.sourceCuts && interval(result.sourceCuts.start, result.sourceCuts.start, n) &&
    interval(result.sourceCuts.end, result.sourceCuts.end, n) && typeof result.sourceCuts.wrapsOrigin === 'boolean' &&
    junction(result.attP, result.excisedPhage.sequence.length) && junction(result.attB, result.restoredHost.sequence.length) &&
    result.conservation?.inputBases === n && result.conservation.recoveredBases === n &&
    result.conservation.excisedBases === result.excisedPhage.sequence.length &&
    result.conservation.restoredBases === result.restoredHost.sequence.length &&
    result.excisedPhage.sequence.length + result.restoredHost.sequence.length === n && result.conservation.conserved === true &&
    strings(result.warnings) && record?.format === 'phage-explorer-analysis' && record.version === 1 &&
    record.method?.id === PROPHAGE_EXCISION_METHOD.id && record.method.version === PROPHAGE_EXCISION_METHOD.version &&
    typeof record.method.implementation === 'string' && record.seed === null &&
    /^[a-f0-9]{64}$/.test(record.resultId) && /^[a-f0-9]{64}$/.test(record.cacheKey) &&
    plain(record.parameters) && record.parameters.flankLength === options.flankLength &&
    Array.isArray(record.inputs) && record.inputs.length === 2 && record.inputs.every((item, index) => item &&
      item.id === ['integratedLocus', 'excisionSites'][index] && ['local', 'catalog', 'external'].includes(item.source) &&
      typeof item.description === 'string' && (item.accession === null || typeof item.accession === 'string') &&
      /^[a-f0-9]{64}$/.test(item.sha256) && plain(item.data)) &&
    Array.isArray(record.references) && record.references.length === 1 && record.references.every(item => item &&
      typeof item.id === 'string' && typeof item.version === 'string' && typeof item.description === 'string') &&
    plain(record.fields) && Object.keys(record.fields).length === 1 &&
    record.fields.reconstruction?.kind === 'simulation' && record.fields.reconstruction.units === 'records' &&
    typeof record.fields.reconstruction.label === 'string' && plain(record.fields.reconstruction.value) &&
    strings(record.fields.reconstruction.assumptions) && strings(record.fields.reconstruction.limitations) &&
    record.fields.reconstruction.coverage?.available === n && record.fields.reconstruction.coverage.total === n &&
    record.fields.reconstruction.coverage.unit === 'bases';
}
export interface ProphageAttachmentSnapshot {
  scope: string | null; accepted: ProphageAttachmentResult | null; busy: boolean;
  phase: string; error: string | null; notice: string | null;
}
const attachmentAbort = () => new DOMException('Attachment reconstruction cancelled', 'AbortError');
function attachmentRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(attachmentAbort());
    if (signal.aborted) { void promise.catch(() => {}); reject(attachmentAbort()); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      cause => { signal.removeEventListener('abort', cancel); reject(cause); });
  });
}
export class ProphageAttachmentSession {
  private active = false;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: ProphageAttachmentSnapshot = { scope: null, accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => ProphageAttachmentWorker) {}
  getSnapshot = (): ProphageAttachmentSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ProphageAttachmentSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  setScope = (scope: string | null, preserveAccepted = false): void => {
    if (scope === this.snapshot.scope) return;
    const accepted = preserveAccepted ? this.snapshot.accepted : null;
    this.cancel(); this.publish({ scope, accepted, error: null, notice: null });
  };
  cancel = (): void => {
    const old = this.operation; this.operation = null; old?.abort();
    this.publish({ busy: false, phase: '', ...(old ? { notice: 'Attachment work cancelled; the previous accepted experiment was preserved.' } : {}) });
  };
  run = async (
    input: ProphageAttachmentRequest | Promise<ProphageAttachmentRequest> | ((signal: AbortSignal) => Promise<ProphageAttachmentRequest>),
    scope: string | null,
  ): Promise<boolean> => {
    if (!this.active || scope === null || scope !== this.snapshot.scope) {
      if (input instanceof Promise) void input.catch(() => {});
      return false;
    }
    // Snapshot direct input before cancel() can notify subscribers.
    let captured: typeof input;
    try { captured = typeof input === 'function' || input instanceof Promise ? input : structuredClone(input); }
    catch (cause) { this.cancel(); this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.snapshot.scope === scope && this.operation === owner && !owner.signal.aborted;
    try {
      const pending = typeof captured === 'function' ? Promise.resolve().then(() => {
        if (!current()) throw attachmentAbort(); return captured(owner.signal);
      }) : Promise.resolve(captured);
      const reading = attachmentRead(pending.then(value => structuredClone(value)), owner.signal);
      this.publish({ busy: true, phase: 'Reading exact local inputs', error: null, notice: null });
      const request = await reading;
      if (!current()) return false;
      const value = await new Promise<ProphageAttachmentResult>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (result?: ProphageAttachmentResult, error?: Error) => {
          if (done) return; done = true; owner.signal.removeEventListener('abort', cancel);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* Ownership is already released; cancellation must still settle. */ }
          if (error) reject(error); else resolve(result!);
        };
        const cancel = () => finish(undefined, attachmentAbort());
        owner.signal.addEventListener('abort', cancel, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return;
          try {
            const message = event.data;
            if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
            else if (message?.kind === 'result' && attachmentWorkShape(message.value)) finish(message.value);
            else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
            else finish(undefined, new Error('Unexpected attachment worker response.'));
          } catch {
            finish(undefined, new Error('Unexpected attachment worker response.'));
          }
        };
        worker.onerror = () => finish(undefined, new Error('Attachment worker failed; retry the local reconstruction.'));
        worker.onmessageerror = () => finish(undefined, new Error('Attachment worker response could not be read.'));
        try { if (owner.signal.aborted) cancel(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ accepted: value, notice: value.verified
        ? 'Fresh reconstruction matches the saved experiment, including exact sources and assumptions.'
        : 'Conditional sequence reconstruction complete. Review both junctions and the source-coordinate map.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: false, phase: '' }); }
    }
  };
}
