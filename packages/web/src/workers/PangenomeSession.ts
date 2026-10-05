/** Private sequence-graph workspace. Only accepted results replace the visible experiment. */
import { buildAlignmentPangenome, createAlignmentPangenomeRecord, parsePangenomeInput, replayAlignmentPangenome,
  resolveAlignmentGraphOptions, validatePangenomeInput, type AlignmentGraphOptions, type AlignmentPangenome,
  createAnnotatedAlignmentPangenome, type PangenomeCdsSelection, type PangenomeInput } from '../../../core/src/analysis/alignment-pangenome';
import type { AnalysisRecord } from '../../../core/src/analysis-result';
import type { CdsConsequenceExperiment } from '../../../core/src/analysis/cds-consequences';
import type { GenomeInput } from '../../../core/src/genome-import';

export type PangenomeRequest =
  | { kind: 'import'; content: string; filename: string }
  | { kind: 'local-genomes'; input: PangenomeInput }
  | { kind: 'analyze'; input: PangenomeInput; options: AlignmentGraphOptions }
  | { kind: 'annotate'; input: PangenomeInput; options: AlignmentGraphOptions; annotation: GenomeInput; selection?: PangenomeCdsSelection }
  | { kind: 'demo' };
export interface PangenomeAccepted {
  input: PangenomeInput; options: AlignmentGraphOptions;
  graph: AlignmentPangenome | null; record: AnalysisRecord | null; verified: boolean;
  cds?: CdsConsequenceExperiment;
}
export type PangenomeMessage = { kind: 'progress'; phase: string } | { kind: 'result'; result: PangenomeAccepted } | { kind: 'error'; message: string };
export interface PangenomeSnapshot { accepted: PangenomeAccepted | null; busy: boolean; phase: string; error: string | null; notice: string | null }
export type PangenomeWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** Snapshot chosen private sequences without catalog lookups or accession-based merging.
 * Validation of full sequence payloads remains off-thread in executePangenomeRequest.
 */
export function pangenomeRequestFromLocalGenomes(genomes: readonly {
  sequence: string; phage: { name: string; accession: string; localGenome?: { contentId: string } };
}[], contentIds: readonly string[]): PangenomeRequest {
  if (contentIds.length < 2 || contentIds.length > 24 || new Set(contentIds).size !== contentIds.length) {
    throw new Error('Choose 2–24 distinct imported genomes.');
  }
  const sequences = contentIds.map(contentId => {
    if (!/^[a-f0-9]{64}$/.test(contentId)) throw new Error('Invalid local genome content identity.');
    const matches = genomes.filter(g => g.phage.localGenome?.contentId === contentId);
    if (matches.length !== 1) throw new Error('A selected local genome is missing or duplicated. Choose the current inputs again.');
    const genome = matches[0];
    return { id: `local-${contentId}`, description: `${genome.phage.name} (${genome.phage.accession})`, sequence: genome.sequence };
  });
  return { kind: 'local-genomes', input: { format: 'phage-explorer-pangenome', version: 1,
    name: 'Imported genome comparison', source: 'local', sequences } };
}

export async function executePangenomeRequest(request: PangenomeRequest, report: (phase: string) => void = () => {}): Promise<PangenomeAccepted> {
  if (request.kind === 'local-genomes') {
    report('Validating selected local genomes');
    const input = validatePangenomeInput(request.input);
    if (input.source !== 'local' || input.sequences.some(s => s.sequence.includes('-'))) throw new Error('Imported genomes must be local ungapped DNA.');
    return { input, options: resolveAlignmentGraphOptions(input, { alignment: 'wavefront' }), graph: null, record: null, verified: false };
  }
  if (request.kind === 'annotate') {
    report('Rebuilding the sequence graph and comparing annotated coding transcripts');
    const result = await createAnnotatedAlignmentPangenome(request.input, request.options, request.annotation, request.selection);
    return { ...result, options: result.graph.options, graph: result.graph, verified: false };
  }
  if (request.kind === 'analyze') {
    const input = validatePangenomeInput(request.input);
    report('Aligning sequences and constructing exact graph paths');
    const graph = buildAlignmentPangenome(input, request.options);
    report('Binding sequence inputs, graph and variants to the result');
    const record = await createAlignmentPangenomeRecord(input, graph);
    return { input, options: graph.options, graph, record, verified: false };
  }
  if (request.kind === 'demo') {
    const input = { ...parsePangenomeInput('>reference\nACGT--ACGT\n>insertion_deletion\nACGTGGAC-T\n>substitution\nATGT--ACGT', 'Synthetic alignment example'), source: 'demo' as const };
    return { input, options: resolveAlignmentGraphOptions(input, { referenceId: 'reference' }), graph: null, record: null, verified: false };
  }
  if (request.kind !== 'import') throw new Error('Unsupported pangenome operation.');
  if (typeof request.content !== 'string' || request.content.length > 10 * 1024 * 1024 || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) {
    throw new Error('Pangenome file exceeds 10 MiB (sequence datasets are limited to 4 MiB).');
  }
  const content = request.content.replace(/^\uFEFF/, '');
  report('Reading local sequence input');
  if (content.trimStart().startsWith('{') && JSON.parse(content).format === 'phage-explorer-analysis') {
    report('Recomputing and verifying the saved sequence graph');
    const result = await replayAlignmentPangenome(content);
    return { ...result, options: result.graph.options, verified: true };
  }
  const input = parsePangenomeInput(content, request.filename);
  return { input, options: resolveAlignmentGraphOptions(input), graph: null, record: null, verified: false };
}

function aborted(): DOMException { return new DOMException('Pangenome work cancelled.', 'AbortError'); }
function cancellable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    // Always attach both handlers, including for an already-cancelled file read.
    value.then(result => { signal.removeEventListener('abort', cancel); resolve(result); }, cause => {
      signal.removeEventListener('abort', cancel); reject(cause);
    });
    if (signal.aborted) cancel();
  });
}
export class PangenomeSession {
  private active = false;
  private operation: AbortController | null = null;
  private snapshot: PangenomeSnapshot = { accepted: null, busy: false, phase: '', error: null, notice: null };
  private listeners = new Set<() => void>();
  constructor(private createWorker: () => PangenomeWorker) {}
  getSnapshot = (): PangenomeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<PangenomeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const previous = this.operation; this.operation = null; previous?.abort();
    this.publish({ busy: false, phase: '', ...(previous ? { notice: 'Pangenome work cancelled; the accepted dataset and result are unchanged.' } : {}) });
  };
  run = async (request: PangenomeRequest | Promise<PangenomeRequest>): Promise<void> => {
    if (!this.active) { if (request instanceof Promise) void request.catch(() => {}); return; }
    this.cancel();
    const operation = new AbortController(); this.operation = operation;
    const current = () => this.active && this.operation === operation && !operation.signal.aborted;
    this.publish({ busy: true, phase: 'Reading local input', error: null, notice: null });
    try {
      // Snapshot synchronous requests before yielding to user edits.
      const submitted = request instanceof Promise ? request.then(value => structuredClone(value)) : Promise.resolve(structuredClone(request));
      const value = await cancellable(submitted, operation.signal);
      if (!current()) return;
      const result = await new Promise<PangenomeAccepted>((resolve, reject) => {
        const worker = this.createWorker();
        let settled = false;
        const finish = (result?: PangenomeAccepted, cause?: unknown) => {
          if (settled) return; settled = true;
          operation.signal.removeEventListener('abort', cancel);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
          if (cause) reject(cause); else resolve(result!);
        };
        const cancel = () => finish(undefined, aborted());
        operation.signal.addEventListener('abort', cancel, { once: true });
        worker.onmessage = event => {
          if (!current()) { cancel(); return; }
          const message = event.data as PangenomeMessage | null;
          if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
          else if (message?.kind === 'result' && message.result?.input?.format === 'phage-explorer-pangenome' && message.result.options) finish(message.result);
          else finish(undefined, new Error(message?.kind === 'error' ? message.message : 'Unexpected pangenome worker response.'));
        };
        worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('Pangenome worker failed. Retry the operation.')); };
        worker.onmessageerror = () => finish(undefined, new Error('Pangenome worker response could not be read.'));
        try { if (!current()) cancel(); else worker.postMessage(value); } catch (cause) { finish(undefined, cause); }
      });
      if (current()) this.publish({ accepted: result,
        notice: result.verified ? `Verified pangenome replay: recomputed graph, paths, variants${result.cds ? ', coding transcripts and consequences' : ''} and complete result identity match.`
          : result.cds ? 'Sequence graph and CDS consequences computed from the submitted genomes and exact-matched GenBank reference.'
          : result.graph ? 'Sequence graph computed from the submitted inputs and settings.' : 'Input loaded locally. Choose the reference and alignment settings, then build the graph.' });
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: false, phase: '' }); }
    }
  };
}
