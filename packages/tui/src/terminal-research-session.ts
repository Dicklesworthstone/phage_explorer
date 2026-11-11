/** Interactive terminal owner for the existing bounded, isolated replay worker.
 * Opening a document only inspects it. Numerical verification is explicit, and
 * neither operation changes the explorer's accepted genomes or selected view.
 */
import { parseCommandTape, COMMAND_LIMITS } from '../../core/src/command-session';
import { serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { parseWorkflowResults, workflowResultIndex, workflowAnalysisAt, WORKFLOW_RESULTS_LIMITS,
  type WorkflowResults, type WorkflowResultEntry } from '../../core/src/workflow-results';
import { readInput, writeNewOutput, runTerminalResearchWorker } from '../../../scripts/research-workflow';
import type { ResearchReplayResult, ResearchTapeInspection, ReplayProgress } from './research-replay';
import { terminalGenomeLabel, type TerminalGenomeSession } from './local-genome-session';

export interface TerminalResearchDocument {
  name: string;
  tapeJson: string;
  inspection: ResearchTapeInspection;
  /** A supplied archive has integrity checks, never implied fresh computation. */
  savedResults: { archive: WorkflowResults; json: string } | null;
}
export interface TerminalResearchRun {
  archive: WorkflowResults;
  json: string;
  report: ResearchReplayResult['report'];
}
export interface TerminalResearchSnapshot {
  document: TerminalResearchDocument | null;
  completedRun: TerminalResearchRun | null;
  busy: 'reading' | 'replaying' | 'saving' | 'restoring' | null;
  progress: ReplayProgress | null;
  error: string | null;
  notice: string | null;
}
interface Operation { controller: AbortController; timer: ReturnType<typeof setTimeout> }
export interface TerminalResearchRuntime {
  run?: typeof runTerminalResearchWorker;
  /** A finite deadline also covers an unresponsive isolated worker. */
  timeoutMs?: number;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Research operation cancelled.', 'AbortError');
}
function path(value: string): void {
  if (!value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Provide a local path without control characters.');
}
/** Make cancellation prompt even if an injected provider ignores its signal.
 * The normal native worker also terminates its thread on abort.
 */
function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { try { check(signal); } catch (cause) { reject(cause); } };
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
export class TerminalResearchSession {
  private operation: Operation | null = null;
  private readonly run: typeof runTerminalResearchWorker;
  private readonly timeoutMs: number;
  private listeners = new Set<() => void>();
  private state: TerminalResearchSnapshot = { document: null, completedRun: null,
    busy: null, progress: null, error: null, notice: null };
  constructor(runtime: TerminalResearchRuntime = {}) {
    this.run = runtime.run ?? runTerminalResearchWorker;
    this.timeoutMs = runtime.timeoutMs ?? 300000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) {
      throw new Error('Research deadline must be an integer from 1 to 300000 ms.');
    }
  }
  getSnapshot = (): TerminalResearchSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<TerminalResearchSnapshot>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private begin(busy: NonNullable<TerminalResearchSnapshot['busy']>): Operation {
    if (this.operation) throw new Error('Cancel or finish the active research operation first.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Research operation timed out. Previous accepted work is unchanged.')), this.timeoutMs);
    const operation = { controller, timer };
    this.operation = operation;
    this.publish({ busy, progress: null, error: null, notice: null });
    return operation;
  }
  private current(operation: Operation): boolean { return this.operation === operation; }
  private finish(operation: Operation): void {
    clearTimeout(operation.timer);
    if (this.current(operation)) { this.operation = null; this.publish({ busy: null, progress: null }); }
  }
  private failed(operation: Operation, cause: unknown): void {
    if (this.current(operation)) this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)),
      notice: this.state.busy === 'saving'
        ? 'The save did not finish. A new destination may be incomplete; existing files were not overwritten. Previously accepted results are unchanged.'
        : 'The operation did not finish. The previously accepted workflow and results are unchanged.' });
  }
  cancel = (): void => {
    const operation = this.operation;
    const saving = this.state.busy === 'saving';
    this.operation = null;
    if (operation) {
      clearTimeout(operation.timer);
      operation.controller.abort(new DOMException('Research operation cancelled.', 'AbortError'));
      this.publish({ busy: null, progress: null, notice: saving
        ? 'Saving was interrupted. The new destination may contain a partial or complete file; inspect it before retrying. Existing files were not overwritten.'
        : 'Cancelled. Previously accepted workflow results and explorer selection are unchanged.' });
    }
  };
  load = async (filePath: string): Promise<boolean> => {
    const operation = this.begin('reading'), signal = operation.controller.signal;
    try {
      path(filePath);
      const content = await readInput(filePath, signal, WORKFLOW_RESULTS_LIMITS.bytes);
      const envelope: unknown = JSON.parse(content);
      const isArchive = !!envelope && typeof envelope === 'object' && 'format' in envelope
        && envelope.format === 'phage-explorer-workflow-results';
      const archive = isArchive ? await parseWorkflowResults(content, signal) : null;
      check(signal);
      const tapeJson = archive?.tapeJson ?? content;
      const tape = parseCommandTape(tapeJson);
      const response = await cancellable(this.run({ type: 'inspect', content: tapeJson }, signal), signal);
      check(signal);
      if (response.type !== 'inspection') throw new Error('Expected a workflow inspection.');
      if (!this.current(operation)) return false;
      this.publish({ document: { name: tape.name, tapeJson, inspection: response.inspection,
        savedResults: archive ? { archive, json: content } : null }, completedRun: null,
        notice: archive ? 'Opened archive: record integrity checked. No numerical methods have run and no genomes were installed.'
          : 'Opened workflow for inspection only. No commands ran and no genomes were installed.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  replay = async (repetitions = 1): Promise<boolean> => {
    const operation = this.begin('replaying'), signal = operation.controller.signal;
    try {
      const document = this.state.document;
      if (!document) throw new Error('Open a workflow before replaying.');
      if (!document.inspection.canReplay) throw new Error('This workflow has no commands or includes unsupported terminal actions. Inspect the steps before replay.');
      const saved = document.savedResults;
      const repeats = saved?.archive.repetitions ?? repetitions;
      if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > COMMAND_LIMITS.repetitions
        || document.inspection.steps.length * repeats > COMMAND_LIMITS.executions) {
        throw new Error('Replay allows 1–10 repetitions and at most 256 executions.');
      }
      const progress = (value: ReplayProgress) => { if (this.current(operation) && !signal.aborted) this.publish({ progress: value }); };
      const response = await cancellable(this.run(saved
        ? { type: 'replay-results', content: saved.json }
        : { type: 'replay', content: document.tapeJson, repetitions: repeats, exportAnalysis: false, captureResults: true }, signal, progress), signal);
      check(signal);
      if (response.type !== 'replayed' && response.type !== 'results-replayed') throw new Error('Expected a complete replay response.');
      const json = response.type === 'replayed' ? response.allResultsJson : response.archiveJson;
      if (typeof json !== 'string') throw new Error('Replay did not return its complete results.');
      const archive = await parseWorkflowResults(json, signal);
      check(signal);
      if (archive.tapeJson !== document.tapeJson || archive.repetitions !== repeats) throw new Error('Replay results belong to a different workflow.');
      if (!this.current(operation)) return false;
      this.publish({ completedRun: { archive, json, report: response.report },
        notice: 'Freshly verified ' + response.report.completed + ' executions. Explorer genomes and selection have not changed.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  /** An imported archive remains explicitly integrity-only until replay succeeds. */
  availableResults = (): { archive: WorkflowResults; json: string; replayed: boolean } | null => {
    if (this.state.completedRun) return { ...this.state.completedRun, replayed: true };
    const saved = this.state.document?.savedResults;
    return saved ? { ...saved, replayed: false } : null;
  };
  entries = (): WorkflowResultEntry[] => {
    const result = this.availableResults();
    return result ? workflowResultIndex(result.archive.tapeJson, result.archive.repetitions) : [];
  };
  analysis = (execution: number): AnalysisRecord => {
    const result = this.availableResults();
    if (!result) throw new Error('No complete workflow results are available.');
    return workflowAnalysisAt(result.archive, execution);
  };
  save = async (filePath: string, execution: number | null = null): Promise<boolean> => {
    const operation = this.begin('saving'), signal = operation.controller.signal;
    try {
      path(filePath);
      const result = this.availableResults();
      if (!result) throw new Error('Load a complete archive or finish replay before exporting results.');
      // Resolve and validate the exact execution before any filesystem mutation.
      const content = execution === null ? result.json : serializeAnalysisRecord(workflowAnalysisAt(result.archive, execution));
      await writeNewOutput(filePath, content, signal);
      check(signal);
      if (!this.current(operation)) return false;
      this.publish({ notice: execution === null
        ? 'Saved the complete private workflow archive to a new file.'
        : 'Saved the analysis from execution ' + execution + ' to a new file. Source genomes and references remain embedded.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  /** Staging is separate from collision approval and from installation. */
  stageRestore = async (genomes: TerminalGenomeSession): Promise<boolean> => {
    const operation = this.begin('restoring'), signal = operation.controller.signal;
    const cancel = () => genomes.cancel();
    try {
      const completed = this.state.completedRun;
      if (!completed) throw new Error('Replay successfully before restoring its final view.');
      if (genomes.getSnapshot().busy) throw new Error('Finish the current genome operation before restoring research inputs.');
      const tape = parseCommandTape(completed.archive.tapeJson), context = tape.context;
      if (!context || typeof context !== 'object' || Array.isArray(context) || typeof context.bundle !== 'string') throw new Error('The workflow has no original input bundle.');
      signal.addEventListener('abort', cancel, { once: true });
      const staged = await cancellable(genomes.prepareBundle(context.bundle, completed.report.finalView ?? undefined), signal);
      check(signal);
      if (!staged) throw new Error(genomes.getSnapshot().error ?? 'Could not stage workflow inputs.');
      if (!this.current(operation)) return false;
      this.publish({ notice: 'Workflow inputs and final view are ready for collision review. Nothing has been installed yet.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { signal.removeEventListener('abort', cancel); this.finish(operation); }
  };
}
