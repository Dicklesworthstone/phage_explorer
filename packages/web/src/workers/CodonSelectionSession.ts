/** One private coding-alignment workflow. It never reads the selected raw genome. */
import { CODON_SELECTION_LIMITS, analyzeCodonSelection, createCodonSelectionRecord, parseCodonAlignmentFasta,
  replayCodonSelectionRecord, resolveCodonSelectionOptions, validateCodonAlignment,
  type CodonAlignmentInput, type CodonSequence, type CodonSelectionOptions, type CodonSelectionResult } from '../../../core/src/analysis/codon-selection';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type CodonSelectionRequest = { kind: 'load'; input: CodonAlignmentInput }
  | { kind: 'import'; content: string }
  | { kind: 'analyze'; input: CodonAlignmentInput; options: Partial<CodonSelectionOptions> };
export interface CodonSelectionWork { input: CodonAlignmentInput; sequences: CodonSequence[];
  options: CodonSelectionOptions; result: CodonSelectionResult | null; record: AnalysisRecord | null; verified: boolean }
export type CodonSelectionMessage = { kind: 'progress'; phase: string } | { kind: 'result'; value: CodonSelectionWork } | { kind: 'error'; message: string };
export interface CodonSelectionWorker {
  postMessage(request: CodonSelectionRequest): void; terminate(): void;
  onmessage: ((event: MessageEvent<CodonSelectionMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null; onmessageerror: ((event: MessageEvent) => void) | null;
}
export async function executeCodonSelectionRequest(request: CodonSelectionRequest, progress: (phase: string) => void = () => {}): Promise<CodonSelectionWork> {
  if (!request || typeof request !== 'object') throw new Error('Invalid coding-alignment request.');
  progress('Validating declared coding alignment'); let input: CodonAlignmentInput;
  if (request.kind === 'import') {
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) throw new Error('Saved codon input exceeds 10 MiB.');
    const content = request.content.replace(/^\uFEFF/, ''), decoded: unknown = JSON.parse(content);
    if (decoded && typeof decoded === 'object' && 'format' in decoded && decoded.format === 'phage-explorer-analysis') {
      progress('Recomputing saved codon evidence');
      const replay = await replayCodonSelectionRecord(content, progress);
      return { ...replay, sequences: parseCodonAlignmentFasta(replay.input.alignment.fasta), options: replay.result.options, verified: true };
    }
    input = validateCodonAlignment(decoded);
  } else if (request.kind === 'load' || request.kind === 'analyze') input = validateCodonAlignment(request.input);
  else throw new Error('Unsupported codon workflow operation.');
  const sequences = parseCodonAlignmentFasta(input.alignment.fasta);
  if (request.kind === 'analyze') {
    const result = analyzeCodonSelection(input, request.options, progress);
    progress('Binding alignment, model and numerical evidence');
    return { input, sequences, options: result.options, result, record: await createCodonSelectionRecord(input, result), verified: false };
  }
  // Loading a valid large alignment must not fail merely because 50-codon default windows exceed the output budget.
  const maxWindowsPerPair = Math.floor(CODON_SELECTION_LIMITS.windows / (sequences.length - 1));
  const windowCodons = Math.max(50, Math.ceil(sequences[0].sequence.length / 3 / maxWindowsPerPair));
  return { input, sequences, options: resolveCodonSelectionOptions(input, { windowCodons }), result: null, record: null, verified: false };
}
export interface CodonSelectionSnapshot { accepted: CodonSelectionWork | null; busy: boolean; phase: string; error: string | null; notice: string | null }
const aborted = () => new DOMException('Codon comparison cancelled.', 'AbortError');
function read<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    if (signal.aborted) { void pending.catch(() => {}); cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    void pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
export class CodonSelectionSession {
  private active = false;
  private owner: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CodonSelectionSnapshot = { accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => CodonSelectionWorker) {}
  getSnapshot = (): CodonSelectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<CodonSelectionSnapshot>): void { this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener(); }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const old = this.owner; this.owner = null; old?.abort();
    this.publish({ busy: false, phase: '', ...(old ? { notice: 'Codon work cancelled; accepted evidence was preserved.' } : {}) });
  };
  run = async (input: CodonSelectionRequest | Promise<CodonSelectionRequest>): Promise<void> => {
    if (!this.active) { if (input instanceof Promise) void input.catch(() => {}); return; }
    this.cancel(); const owner = new AbortController(); this.owner = owner;
    const current = () => this.active && this.owner === owner && !owner.signal.aborted;
    this.publish({ busy: true, phase: 'Reading local codon input', error: null, notice: null });
    try {
      const request = await read(input instanceof Promise ? input.then(v => structuredClone(v)) : Promise.resolve(structuredClone(input)), owner.signal);
      if (!current()) return;
      const value = await new Promise<CodonSelectionWork>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (value?: CodonSelectionWork, error?: Error) => {
          if (done) return; done = true; owner.signal.removeEventListener('abort', cancel); worker.terminate();
          if (error) reject(error); else resolve(value!);
        };
        const cancel = () => finish(undefined, aborted()); owner.signal.addEventListener('abort', cancel, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return; const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
          else if (message?.kind === 'result' && message.value?.input && Array.isArray(message.value.sequences) && message.value.options) finish(message.value);
          else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
          else finish(undefined, new Error('Malformed codon-worker reply.'));
        };
        worker.onerror = () => finish(undefined, new Error('Codon worker failed. Retry this operation.'));
        worker.onmessageerror = () => finish(undefined, new Error('Codon-worker reply could not be decoded.'));
        try { if (!current()) cancel(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (current()) this.publish({ accepted: value, notice: value.verified ? 'Verified codon replay: fresh counts, distances and evidence identity match.'
        : value.result ? 'Aligned codon comparison complete. Inspect exclusions and unavailable ratios.' : 'Codon alignment loaded. Review the inputs, then run a comparison.' });
    } catch (cause) { if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (current()) { this.owner = null; this.publish({ busy: false, phase: '' }); } }
  };
}
