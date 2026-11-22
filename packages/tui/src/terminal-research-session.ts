/** Interactive terminal owner for the existing bounded, isolated replay worker.
 * Opening a document only inspects it. Numerical verification is explicit, and
 * neither operation changes the explorer's accepted genomes or selected view.
 */
import { parseCommandTape, serializeCommandPlan, commandValuesEqual, COMMAND_LIMITS,
  type CommandPlan, type RecordedCommand } from '../../core/src/command-session';
import { analysisJson, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import type { GeneInfo, PhageFull } from '../../core/src/types';
import type { LocalGenome } from '../../core/src/genome-import';
import { ALIGNMENT_GRAPH_LIMITS } from '../../core/src/analysis/alignment-pangenome';
import { MOSAIC_LIMITS } from '../../core/src/analysis/recombination-radar';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { validateResearchView, researchRNASource, researchRNARequest,
  type ResearchView, type ResearchPangenomeParameters, type ResearchRNAParameters, type ResearchMosaicParameters } from '../../web/src/keyboard/ResearchWorkflow';
import { parseWorkflowResults, workflowResultIndex, workflowAnalysisAt, WORKFLOW_RESULTS_LIMITS,
  type WorkflowResults, type WorkflowResultEntry } from '../../core/src/workflow-results';
import { readInput, writeNewOutput, runTerminalResearchWorker } from '../../../scripts/research-workflow';
import { validateResearchPlan, type ResearchReplayResult, type ResearchTapeInspection, type ReplayProgress } from './research-replay';
import { loadTerminalGenomeBundle, terminalGenomeLabel, type TerminalGenomeSession } from './local-genome-session';

export interface TerminalResearchDocument {
  name: string;
  tapeJson: string;
  inspection: ResearchTapeInspection;
  origin: 'file' | 'recording';
  /** Imported or newly recorded results remain distinct from verified replay. */
  savedResults: { archive: WorkflowResults; json: string } | null;
}
export interface TerminalResearchRun {
  archive: WorkflowResults;
  json: string;
  report: ResearchReplayResult['report'];
}
export type TerminalResearchStep = Pick<RecordedCommand, 'actionId' | 'parameters'>;
export interface TerminalResearchDraftSource {
  contentId: string; name: string; accession: string; bases: number;
  format: NonNullable<PhageFull['localGenome']>['format']; sequenceSha256: string;
  topology: 'linear' | 'circular' | 'unknown';
  genes: Array<Pick<GeneInfo, 'id' | 'name' | 'locusTag' | 'type' | 'startPos' | 'endPos'>>;
}
export interface TerminalResearchDraft {
  plan: CommandPlan;
  sources: TerminalResearchDraftSource[];
  initialView: ResearchView | null;
}
export interface TerminalResearchRNASource { bases: number; synonymousSupported: boolean }
export interface TerminalResearchDraftReview { name: string; sourceCount: number; stepCount: number }
export interface TerminalResearchSnapshot {
  draft: TerminalResearchDraft | null;
  /** Only the proposed replacement's summary is exposed before approval. */
  pendingDraft: TerminalResearchDraftReview | null;
  document: TerminalResearchDocument | null;
  completedRun: TerminalResearchRun | null;
  busy: 'reading' | 'drafting' | 'recording' | 'replaying' | 'saving' | 'restoring' | null;
  progress: ReplayProgress | null;
  error: string | null;
  notice: string | null;
}
interface Operation { controller: AbortController; timer: ReturnType<typeof setTimeout> }
interface PreparedDraft { draft: TerminalResearchDraft; genomes: LocalGenome[] }
export interface TerminalResearchRuntime {
  run?: typeof runTerminalResearchWorker;
  parseBundle?: typeof loadTerminalGenomeBundle;
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
  /** Parsed inputs stay with the session, never in the editor's form state.
   * Extract a selected transcript on demand instead of copying every CDS.
   */
  private draftGenomes: LocalGenome[] = [];
  private draftReplacement: { prepared: PreparedDraft; notice: string } | null = null;
  private readonly run: typeof runTerminalResearchWorker;
  private readonly parseBundle: typeof loadTerminalGenomeBundle;
  private readonly timeoutMs: number;
  private listeners = new Set<() => void>();
  private state: TerminalResearchSnapshot = { draft: null, pendingDraft: null, document: null, completedRun: null,
    busy: null, progress: null, error: null, notice: null };
  constructor(runtime: TerminalResearchRuntime = {}) {
    this.run = runtime.run ?? runTerminalResearchWorker;
    this.parseBundle = runtime.parseBundle ?? loadTerminalGenomeBundle;
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
    if (this.draftReplacement) throw new Error('Accept or discard the reviewed draft replacement first.');
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
    if (this.draftReplacement) this.discardDraftReplacement();
    if (operation) {
      clearTimeout(operation.timer);
      operation.controller.abort(new DOMException('Research operation cancelled.', 'AbortError'));
      this.publish({ busy: null, progress: null, notice: saving
        ? 'Saving was interrupted. The new destination may contain a partial or complete file; inspect it before retrying. Existing files were not overwritten.'
        : 'Cancelled. Previously accepted workflow results and explorer selection are unchanged.' });
    }
  };
  /** Parse and validate every proposed step against its own captured sources.
   * Nothing is published until the whole draft is ready, including RNA/CDS
   * checks that require the new annotations rather than the previous draft.
   */
  private async prepareDraft(content: string, signal: AbortSignal, capturedView?: ResearchView | null): Promise<PreparedDraft> {
    const plan = validateResearchPlan(content);
    // validateResearchPlan requires exactly this embedded-bundle context.
    const bundle = (plan.context as { bundle: string }).bundle;
    const parsed = await cancellable(this.parseBundle(bundle, signal), signal);
    check(signal);
    const genomes = structuredClone(parsed.genomes);
    const sources = genomes.map(genome => ({ contentId: genome.phage.localGenome!.contentId,
      name: genome.phage.name, accession: genome.phage.accession, bases: genome.sequence.length,
      format: genome.phage.localGenome!.format, sequenceSha256: genome.phage.localGenome!.sequenceSha256,
      topology: genome.phage.localGenome!.topology,
      genes: genome.phage.genes.map(({ id, name, locusTag, type, startPos, endPos }) => ({ id, name, locusTag, type, startPos, endPos })) }));
    const first = plan.commands[0];
    const initialView = capturedView !== undefined ? capturedView
      : first?.actionId === ActionIds.NavGoto ? first.parameters as unknown as ResearchView : null;
    const draft = { plan, sources, initialView: initialView ? structuredClone(initialView) : null };
    for (const [index, step] of plan.commands.entries()) {
      try { this.validateStep(draft, step, genomes); }
      catch (cause) { throw new Error(`Step ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return { draft, genomes };
  }
  private publishDraft(prepared: PreparedDraft, notice: string): void {
    this.draftGenomes = prepared.genomes;
    this.draftReplacement = null;
    this.publish({ draft: prepared.draft, pendingDraft: null, error: null, notice });
  }
  private reviewDraft(prepared: PreparedDraft, notice: string): void {
    if (!this.state.draft) { this.publishDraft(prepared, notice); return; }
    this.draftReplacement = { prepared, notice };
    this.publish({ pendingDraft: { name: prepared.draft.plan.name,
      sourceCount: prepared.draft.sources.length, stepCount: prepared.draft.plan.commands.length },
      notice: 'Reviewed the proposed draft. Confirm replacement before changing the current editable draft. Accepted recordings and results are unchanged.' });
  }
  acceptDraftReplacement = (): void => {
    if (this.operation) throw new Error('Finish or cancel active work before accepting the replacement.');
    const replacement = this.draftReplacement;
    if (!replacement) throw new Error('There is no reviewed draft replacement to accept.');
    this.publishDraft(replacement.prepared, replacement.notice);
  };
  discardDraftReplacement = (): void => {
    if (!this.draftReplacement) return;
    this.draftReplacement = null;
    this.publish({ pendingDraft: null, error: null,
      notice: 'Kept the existing editable draft. The reviewed replacement was not installed; accepted results are unchanged.' });
  };
  /** Capture originals and view once. Later explorer navigation/imports cannot
   * relabel this draft; existing accepted results survive a failed new draft.
   */
  createDraft = async (name: string, bundle: string, view: ResearchView | null = null): Promise<boolean> => {
    const operation = this.begin('drafting'), signal = operation.controller.signal;
    try {
      const initialView = view ? structuredClone(view) : null;
      const prepared = await this.prepareDraft(serializeCommandPlan({ format: 'phage-explorer-command-plan', version: 1,
        name, context: { bundle }, commands: initialView ? [{ actionId: ActionIds.NavGoto, parameters: analysisJson(initialView) }] : [] }), signal, initialView);
      if (!this.current(operation)) return false;
      this.reviewDraft(prepared, 'Draft captured the accepted private inputs' + (initialView ? ' and selected view' : '')
        + '. No analyses have run; previous accepted results are unchanged.');
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  private editableDraft(): TerminalResearchDraft {
    if (this.operation) throw new Error('Finish or cancel active work before editing the draft.');
    if (this.draftReplacement) throw new Error('Accept or discard the reviewed draft replacement before editing.');
    if (!this.state.draft) throw new Error('Create a named draft from accepted private genomes first.');
    return this.state.draft;
  }
  private draftGenome(contentId: string, genomes = this.draftGenomes): LocalGenome {
    const source = genomes.find(genome => genome.phage.localGenome?.contentId === contentId);
    if (!source) throw new Error('Select a genome from this draft\'s captured input bundle.');
    return source;
  }
  describeRNA = (contentId: string, geneId: number | null): TerminalResearchRNASource => {
    const source = researchRNASource(this.draftGenome(contentId), geneId);
    return { bases: source.sequence.length, synonymousSupported: source.synonymousSupported };
  };
  private validateStep(draft: TerminalResearchDraft, step: TerminalResearchStep, genomes = this.draftGenomes): void {
    const supported: readonly string[] = [ActionIds.NavGoto, ActionIds.OverlayGCSkew, ActionIds.OverlayRepeats,
      ActionIds.OverlayCodonAdaptation, ActionIds.OverlayGel, ActionIds.OverlayDotPlot, ActionIds.OverlayPangenomeGraph,
      ActionIds.OverlayRNAStructure, ActionIds.OverlayMosaicRadar];
    if (!supported.includes(step.actionId)) throw new Error('This draft editor supports view, GC-skew, exact repeats, codons, digest, dot-plot, pangenome, RNA and mosaic commands.');
    validateResearchPlan(serializeCommandPlan({ ...draft.plan, commands: [step] }));
    if (step.actionId === ActionIds.OverlayMosaicRadar) {
      const parameters = step.parameters as unknown as ResearchMosaicParameters;
      const sources = [parameters.queryContentId, ...parameters.referenceContentIds].map(id => {
        const source = draft.sources.find(item => item.contentId === id);
        if (!source) throw new Error('Select every mosaic query and reference from this draft\'s captured input bundle.');
        return source;
      });
      if (sources.reduce((total, source) => total + source.bases, 0) > MOSAIC_LIMITS.bases) {
        throw new Error('Mosaic query and reference sequences exceed 5,000,000 supplied bases. Select a smaller explicit panel.');
      }
      return;
    }
    if (step.actionId === ActionIds.OverlayPangenomeGraph) {
      const parameters = step.parameters as unknown as ResearchPangenomeParameters;
      const sources = parameters.contentIds.map(id => {
        const source = draft.sources.find(item => item.contentId === id);
        if (!source) throw new Error('Select every pangenome source from this draft\'s captured input bundle.');
        return source;
      });
      if (sources.some(source => source.bases > ALIGNMENT_GRAPH_LIMITS.columns)
        || sources.reduce((total, source) => total + source.bases, 0) > ALIGNMENT_GRAPH_LIMITS.cells) {
        throw new Error('Pangenomes allow at most 250,000 bases per sequence and 4,000,000 total input bases. Choose smaller captured regions.');
      }
      const reference = sources.find(source => `local-${source.contentId}` === parameters.options.referenceId)!;
      if (parameters.options.alignment === 'provided' && sources.some(source => source.bases !== reference.bases)) {
        throw new Error('Using input columns unchanged requires every captured sequence to have the same length. Choose an alignment method.');
      }
      if (parameters.options.normalization === 'circular' && sources.some(source => source.topology === 'linear')) {
        throw new Error('Complete-circle normalization conflicts with a captured linear sequence. Use strand normalization or preserve the input representation.');
      }
      if (parameters.annotation) {
        const annotation = draft.sources.find(source => source.contentId === parameters.annotation!.contentId);
        if (!annotation || annotation.format !== 'genbank') throw new Error('Coding consequences require a captured GenBank annotation.');
        if (annotation.sequenceSha256 !== reference.sequenceSha256 || annotation.bases !== reference.bases) {
          throw new Error('The GenBank annotation must have exactly the reference bases and origin.');
        }
        if (parameters.annotation.geneIds?.some(id => !annotation.genes.some(gene => gene.id === id && gene.type === 'CDS'))) {
          throw new Error('Choose CDS features from the captured reference annotation.');
        }
      }
      return;
    }
    const parameters = step.parameters as Record<string, unknown>;
    const source = draft.sources.find(item => item.contentId === parameters.contentId);
    if (!source) throw new Error('Select a genome from this draft\'s captured input bundle.');
    if (step.actionId === ActionIds.OverlayRNAStructure) {
      // The same extraction and interval checks used by browser/native replay
      // preserve complement/join/codon_start and exceptional-code boundaries.
      researchRNARequest(this.draftGenome(source.contentId, genomes), step.parameters as unknown as ResearchRNAParameters);
    }
    if (step.actionId === ActionIds.NavGoto) {
      validateResearchView(step.parameters);
      const view = step.parameters as unknown as ResearchView;
      const length = view.viewMode === 'aa' ? Math.ceil(source.bases / 3) : source.bases;
      if (view.scrollPosition >= length || view.geneId !== null && !source.genes.some(gene => gene.id === view.geneId)) {
        throw new Error('The saved position or feature is outside this exact captured genome.');
      }
    }
    if (step.actionId === ActionIds.OverlayCodonAdaptation) {
      const selected = parameters.method === 'reference-cai' ? parameters.geneIds : parameters.geneId === null ? null : [parameters.geneId];
      if (Array.isArray(selected) && selected.some(id => !source.genes.some(gene => gene.id === id && gene.type === 'CDS'))) {
        throw new Error('Select CDS features from this exact captured annotation.');
      }
    }
    if (step.actionId === ActionIds.OverlayDotPlot) {
      const comparison = parameters.comparisonContentId === null ? source
        : draft.sources.find(item => item.contentId === parameters.comparisonContentId);
      if (!comparison) throw new Error('Select the comparison genome from the captured input bundle.');
      if (Number(parameters.window) > Math.min(source.bases, comparison.bases)) throw new Error('The dot-plot window must fit both captured sequences.');
    }
    if (step.actionId === ActionIds.OverlayGel && source.topology !== 'unknown' && source.topology !== parameters.topology) {
      throw new Error('Digest topology conflicts with the captured source annotation.');
    }
  }
  private updateDraft(draft: TerminalResearchDraft, steps: TerminalResearchStep[]): void {
    const plan = validateResearchPlan(serializeCommandPlan({ ...draft.plan, commands: steps }));
    this.publish({ draft: { ...draft, plan }, error: null,
      notice: 'Draft updated. Compute and record explicitly to create a new baseline; accepted results are unchanged.' });
  }
  setStep = (step: TerminalResearchStep, index: number | null = null): void => {
    const draft = this.editableDraft(), captured = structuredClone(step);
    this.validateStep(draft, captured);
    const commands = [...draft.plan.commands];
    if (index === null) commands.push(captured);
    else {
      if (!Number.isSafeInteger(index) || index < 0 || index >= commands.length) throw new Error('Select an existing draft step to edit.');
      commands[index] = captured;
    }
    this.updateDraft(draft, commands);
  };
  moveStep = (index: number, direction: -1 | 1): void => {
    const draft = this.editableDraft(), commands = [...draft.plan.commands];
    if (!Number.isSafeInteger(index) || index < 0 || index >= commands.length || direction !== -1 && direction !== 1) throw new Error('Select a draft step and an adjacent position.');
    const target = index + direction;
    if (target < 0 || target >= commands.length) return;
    [commands[index], commands[target]] = [commands[target], commands[index]];
    this.updateDraft(draft, commands);
  };
  removeStep = (index: number): void => {
    const draft = this.editableDraft();
    if (!Number.isSafeInteger(index) || index < 0 || index >= draft.plan.commands.length) throw new Error('Select an existing draft step.');
    this.updateDraft(draft, draft.plan.commands.filter((_, position) => position !== index));
  };
  recordDraft = async (): Promise<boolean> => {
    const operation = this.begin('recording'), signal = operation.controller.signal;
    try {
      const draft = this.state.draft;
      if (!draft || !draft.plan.commands.length) throw new Error('Add at least one command to a named draft before recording.');
      const content = serializeCommandPlan(draft.plan), plan = validateResearchPlan(content);
      const progress = (value: ReplayProgress) => { if (this.current(operation) && !signal.aborted) this.publish({ progress: value }); };
      const response = await cancellable(this.run({ type: 'record', content, captureResults: true }, signal, progress), signal);
      check(signal);
      if (response.type !== 'recorded' || typeof response.allResultsJson !== 'string') throw new Error('Recording did not return a complete new baseline.');
      const tape = parseCommandTape(response.tapeJson);
      if (tape.name !== plan.name || !commandValuesEqual(tape.context, plan.context)
        || !commandValuesEqual(tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })), plan.commands)) {
        throw new Error('Recorded commands or source inputs differ from the submitted draft.');
      }
      const archive = await parseWorkflowResults(response.allResultsJson, signal);
      if (archive.tapeJson !== response.tapeJson || archive.repetitions !== 1) throw new Error('Recorded results belong to a different command baseline.');
      const inspected = await cancellable(this.run({ type: 'inspect', content: response.tapeJson }, signal), signal);
      check(signal);
      if (inspected.type !== 'inspection' || !inspected.inspection.canReplay) throw new Error('The new recording could not be inspected for replay.');
      if (!this.current(operation)) return false;
      this.publish({ document: { name: tape.name, tapeJson: response.tapeJson, inspection: inspected.inspection,
        origin: 'recording', savedResults: { archive, json: response.allResultsJson } }, completedRun: null,
        notice: 'Computed and recorded ' + tape.commands.length + ' steps with complete results. This is a new baseline; replay it separately to verify the recorded outputs. Explorer selection is unchanged.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  load = async (filePath: string): Promise<boolean> => {
    const operation = this.begin('reading'), signal = operation.controller.signal;
    try {
      path(filePath);
      const content = await readInput(filePath, signal, WORKFLOW_RESULTS_LIMITS.bytes);
      const envelope: unknown = JSON.parse(content);
      if (envelope && typeof envelope === 'object' && 'format' in envelope
        && envelope.format === 'phage-explorer-command-plan') {
        const prepared = await this.prepareDraft(content, signal);
        check(signal);
        if (!this.current(operation)) return false;
        this.reviewDraft(prepared, 'Opened the saved draft with its exact captured inputs and parameters. No commands ran; accepted recordings and results are unchanged.');
        return true;
      }
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
        origin: 'file',
        savedResults: archive ? { archive, json: content } : null }, completedRun: null,
        notice: archive ? 'Opened archive: record integrity checked. No numerical methods have run and no genomes were installed.'
          : 'Opened workflow for inspection only. No commands ran and no genomes were installed.' });
      return true;
    } catch (cause) { this.failed(operation, cause); return false; }
    finally { this.finish(operation); }
  };
  /** Explicitly author a NEW experiment from inspected commands. The accepted
   * recording, its expectations and any verified results remain untouched.
   */
  forkDraft = async (name: string): Promise<boolean> => {
    const operation = this.begin('drafting'), signal = operation.controller.signal;
    try {
      const document = this.state.document;
      if (!document) throw new Error('Open a recording or complete archive before making an editable copy.');
      const tape = parseCommandTape(document.tapeJson);
      const prepared = await this.prepareDraft(serializeCommandPlan({ format: 'phage-explorer-command-plan', version: 1,
        name, context: tape.context, commands: tape.commands.map(({ actionId, parameters }) => ({ actionId, parameters })) }), signal);
      check(signal);
      if (!this.current(operation)) return false;
      this.reviewDraft(prepared, 'Copied the inspected commands and original inputs into an unexecuted draft. Recording will compute a NEW baseline, not verify the old expectations. Accepted recordings and results are unchanged.');
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
  availableResults = (): { archive: WorkflowResults; json: string; replayed: boolean; provenance: 'verified' | 'recorded' | 'loaded' } | null => {
    if (this.state.completedRun) return { ...this.state.completedRun, replayed: true, provenance: 'verified' };
    const saved = this.state.document?.savedResults;
    return saved ? { ...saved, replayed: false, provenance: this.state.document?.origin === 'recording' ? 'recorded' : 'loaded' } : null;
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
  save = async (filePath: string, execution: number | 'plan' | 'tape' | null = null): Promise<boolean> => {
    const operation = this.begin('saving'), signal = operation.controller.signal;
    try {
      path(filePath);
      // Resolve and validate the exact execution before any filesystem mutation.
      let content: string;
      if (execution === 'plan') {
        if (!this.state.draft) throw new Error('Create a draft before exporting its plan.');
        content = serializeCommandPlan(this.state.draft.plan);
      } else if (execution === 'tape') {
        if (!this.state.document) throw new Error('Load or compute a recording before exporting its tape.');
        content = this.state.document.tapeJson;
      } else {
        const result = this.availableResults();
        if (!result) throw new Error('Load a complete archive or finish recording/replay before exporting results.');
        content = execution === null ? result.json : serializeAnalysisRecord(workflowAnalysisAt(result.archive, execution));
      }
      await writeNewOutput(filePath, content, signal);
      check(signal);
      if (!this.current(operation)) return false;
      this.publish({ notice: execution === 'plan' ? 'Saved the declarative draft plan to a new file; no recorded output is implied.'
        : execution === 'tape' ? 'Saved the accepted command recording to a new file.' : execution === null
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
