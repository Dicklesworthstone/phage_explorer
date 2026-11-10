/** Exact local mosaic inputs and disposable workers, owned by one repository/view selection. */
import type { PhageSummary } from '../../../core/src/types';
import {
  createMosaicExperiment, parseMosaicDataset, replayMosaicExperiment,
  MOSAIC_LIMITS,
  type MosaicDataset, type MosaicExperiment, type MosaicRadarConfig, type MosaicSequenceInput,
} from '../../../core/src/analysis/recombination-radar';
import { importLocalGenomes } from '../../../core/src/genome-import';

export const MOSAIC_FILE_LIMIT = 10 * 1024 * 1024;
export const REPOSITORY_MOSAIC_PANEL = 'Current repository reference panel';
export type MosaicRequest =
  | { kind: 'analyze'; dataset: MosaicDataset; options: MosaicRadarConfig }
  | { kind: 'import'; content: string; options: MosaicRadarConfig }
  | { kind: 'replay'; content: string }
  | { kind: 'panel'; name: string; content: string; query: MosaicSequenceInput; options: MosaicRadarConfig };
export type MosaicMessage =
  | { kind: 'progress'; phase: string }
  | { kind: 'result'; experiment: MosaicExperiment; verified: boolean }
  | { kind: 'error'; message: string };

export async function executeMosaicRequest(request: MosaicRequest,
  progress: (phase: string) => void = () => {}): Promise<MosaicExperiment> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported mosaic request.');
  if (request.kind === 'analyze') {
    progress('Computing canonical k-mer evidence from the exact query and reference panel');
    return createMosaicExperiment(request.dataset, request.options);
  }
  if (typeof request.content !== 'string' || request.content.length > MOSAIC_FILE_LIMIT
    || new TextEncoder().encode(request.content).length > MOSAIC_FILE_LIMIT) {
    throw new Error('Mosaic input exceeds the 10 MiB file limit.');
  }
  const content = request.content.replace(/^\uFEFF/, '');
  if (request.kind === 'replay') {
    progress('Checking saved identities and recomputing every mosaic result');
    return replayMosaicExperiment(content);
  }
  if (request.kind === 'import') {
    progress('Validating the exact query, reference sequences and source ranges');
    return createMosaicExperiment(parseMosaicDataset(content), request.options);
  }
  if (request.kind === 'panel') {
    progress('Reading private reference sequences without uploading them');
    const { genomes } = await importLocalGenomes({ name: request.name, text: content });
    const references = genomes.map((genome, index): MosaicSequenceInput => ({
      id: `imported-reference:${index + 1}`,
      label: `${genome.phage.name} [reference ${index + 1}]`,
      accession: genome.phage.accession, sequence: genome.sequence, source: 'local',
      sourceDescription: `Private reference file: ${request.name}`,
      sourceReference: null, sourceLicense: null, sourceLength: genome.sequence.length, sourceStart: 0,
    }));
    return createMosaicExperiment({ format: 'phage-explorer-mosaic-dataset', version: 1,
      name: `Private references: ${request.name}`, query: request.query, references, excludedReferences: [] }, request.options);
  }
  throw new Error('Unsupported mosaic operation.');
}

const cancelled = () => new DOMException('Mosaic operation cancelled.', 'AbortError');
const check = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };
export interface MosaicRepository {
  listPhages(): Promise<PhageSummary[]>;
  getFullGenomeLength(id: number): Promise<number>;
  getSequenceWindow(id: number, start: number, end: number): Promise<string>;
}

/** Abort after every read; never cache a sequence using a reusable numeric ID. */
export async function readMosaicSequence(repository: MosaicRepository, phage: PhageSummary,
  signal: AbortSignal, maximum?: number): Promise<MosaicSequenceInput> {
  check(signal);
  const sourceLength = await repository.getFullGenomeLength(phage.id); check(signal);
  if (!Number.isSafeInteger(sourceLength) || sourceLength < 1) throw new Error('Genome length is unavailable or invalid.');
  if (maximum === undefined && sourceLength > MOSAIC_LIMITS.sequenceBases) throw new Error('The selected query exceeds the 5,000,000-base mosaic limit. Import an explicit query interval instead.');
  const length = Math.min(sourceLength, maximum ?? MOSAIC_LIMITS.sequenceBases);
  const sequence = await repository.getSequenceWindow(phage.id, 0, length); check(signal);
  if (sequence.length !== length) throw new Error('Genome read is incomplete; no partial read was accepted.');
  return { id: `repository:${phage.id}`, label: `${phage.name || 'Phage'} #${phage.id}`,
    accession: phage.accession || null, sequence, source: phage.localGenome ? 'local' : 'catalog',
    sourceDescription: phage.localGenome ? 'Private genome in the current repository' : 'Genome in the current catalogue',
    sourceReference: phage.localGenome || !phage.accession ? null : `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(phage.accession)}`,
    sourceLicense: null, sourceLength, sourceStart: 0 };
}

/** The bounded catalogue policy is explicit, including skipped and truncated references. */
export async function readRepositoryMosaicDataset(repository: MosaicRepository, phage: PhageSummary,
  signal: AbortSignal): Promise<MosaicDataset> {
  const query = await readMosaicSequence(repository, phage, signal);
  const phages = await repository.listPhages(); check(signal);
  const candidates = phages.filter(candidate => candidate.id !== phage.id).sort((a, b) => a.id - b.id);
  if (candidates.length > MOSAIC_LIMITS.references + MOSAIC_LIMITS.excludedReferences) throw new Error('This catalogue exceeds the auditable 30-reference/500-exclusion limit. Import an explicit reference dataset instead.');
  const references: MosaicSequenceInput[] = [], excludedReferences: MosaicDataset['excludedReferences'] = [];
  let budget = MOSAIC_LIMITS.bases - query.sequence.length;
  for (const [index, candidate] of candidates.entries()) {
    check(signal);
    let reason: string | null = index >= MOSAIC_LIMITS.references ? 'Outside the first 30 other genomes by catalogue ID.'
      : budget < 1 ? 'The 5,000,000-base panel budget has been reached.' : null;
    if (!reason) {
      try {
        const reference = await readMosaicSequence(repository, candidate, signal, Math.min(150_000, budget));
        references.push(reference); budget -= reference.sequence.length;
      } catch (cause) {
        check(signal);
        reason = `Reference unavailable: ${cause instanceof Error ? cause.message.slice(0, 300) : 'sequence read failed'}`;
      }
    }
    if (reason) excludedReferences.push({ id: `repository:${candidate.id}`, label: `${candidate.name || 'Phage'} #${candidate.id}`,
      accession: candidate.accession || null, reason });
  }
  return { format: 'phage-explorer-mosaic-dataset', version: 1, name: REPOSITORY_MOSAIC_PANEL,
    query, references, excludedReferences };
}

/** Fatal UTF-8 decoding preserves exact sequence bytes instead of replacing malformed input. */
export async function readMosaicFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MOSAIC_FILE_LIMIT) throw new Error('Mosaic input exceeds the 10 MiB file limit.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MOSAIC_FILE_LIMIT) throw new Error('Mosaic input exceeds the 10 MiB file limit.');
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

export interface MosaicWorker {
  postMessage(request: MosaicRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<MosaicMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface MosaicSnapshot {
  scope: object | null;
  dataset: MosaicDataset | null;
  accepted: MosaicExperiment | null;
  verified: boolean;
  busy: boolean;
  phase: string;
  error: string | null;
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      cause => { signal.removeEventListener('abort', abort); reject(cause); });
    if (signal.aborted) abort();
  });
}

/** Cancellation terminates synchronous computation and prevents delayed reads from launching work. */
export class MosaicSession {
  private active = false;
  private scope: object | null = null;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: MosaicSnapshot = { scope: null, dataset: null, accepted: null, verified: false, busy: false, phase: '', error: null };
  constructor(private readonly factory: () => MosaicWorker) {}
  getSnapshot = (): MosaicSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<MosaicSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  setScope = (scope: object): void => {
    if (scope === this.scope) return;
    this.scope = scope; this.cancel();
    this.publish({ scope, dataset: null, accepted: null, verified: false, error: null, phase: '' });
  };
  cancel = (): void => {
    const previous = this.operation; this.operation = null; previous?.abort();
    this.publish({ busy: false, phase: previous ? 'Cancelled. No partial result was accepted.' : '' });
  };
  run = async (scope: object, input: MosaicRequest | ((signal: AbortSignal) => Promise<MosaicRequest>)): Promise<boolean> => {
    if (!this.active || scope !== this.scope) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.scope === scope && this.operation === owner && !owner.signal.aborted;
    try {
      const captured = typeof input === 'function' ? input : structuredClone(input);
      this.publish({ accepted: null, verified: false, busy: true, error: null, phase: 'Reading exact mosaic inputs' });
      if (!current()) return false;
      const pending = typeof captured === 'function' ? captured(owner.signal).then(value => structuredClone(value)) : Promise.resolve(captured);
      const request = await abortable(pending, owner.signal);
      if (!current()) return false;
      const experiment = await new Promise<MosaicExperiment>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (value?: MosaicExperiment, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* A failed termination must not strand the operation. */ }
          if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(undefined, cancelled());
        owner.signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return;
          const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
          else if (message?.kind === 'result' && message.verified === (request.kind === 'replay')
            && message.experiment?.record?.method?.id === 'canonical-kmer-mosaic'
            && message.experiment.dataset?.format === 'phage-explorer-mosaic-dataset'
            && Array.isArray(message.experiment.result?.windows)) finish(message.experiment);
          else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
          else finish(undefined, new Error('Unexpected mosaic worker response.'));
        };
        worker.onerror = () => finish(undefined, new Error('Mosaic worker failed. Retry the local comparison.'));
        worker.onmessageerror = () => finish(undefined, new Error('Mosaic worker response could not be decoded.'));
        try { if (owner.signal.aborted) abort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ dataset: experiment.dataset, accepted: experiment, verified: request.kind === 'replay',
        phase: request.kind === 'replay' ? 'Replay verified: exact inputs and the recomputed result identity agree.' : 'Comparison complete. Inspect the reference coverage and unresolved windows.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause), phase: '' });
      return false;
    } finally { if (current()) { this.operation = null; this.publish({ busy: false }); } }
  };
}
