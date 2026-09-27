/** Adapters for canonical navigation, repeat and CDS-analysis actions; not a second keyboard registry. */
import type { AnalysisRecord, GenomeImportResult, LocalGenome, LocalGenomeView } from '@phage-explorer/core';
import { analysisJson } from '../../../core/src/analysis-result';
import { CommandSession, commandValuesEqual, parseCommandTape, type CommandValue, type CommandAdapter } from '../../../core/src/command-session';

export interface ResearchView extends LocalGenomeView { geneId: number | null }
export interface ResearchActionIds { view: string; repeats: string; codons: string }
export interface ResearchEnvironment {
  genomes: () => readonly LocalGenome[];
  bundle: () => string;
  parseBundle: (content: string, signal: AbortSignal) => Promise<GenomeImportResult>;
  currentView: () => ResearchView | null;
  applyView: (view: ResearchView, signal: AbortSignal) => Promise<void>;
  repeats: (genome: LocalGenome, options: { minLength: number; maxGap: number }, signal: AbortSignal) => Promise<AnalysisRecord>;
  codons: (genome: LocalGenome, geneId: number | null, signal: AbortSignal) => Promise<AnalysisRecord>;
}
export interface ResearchSnapshot {
  view: ResearchView | null;
  result: AnalysisRecord | null;
  undoAvailable: boolean;
  redoAvailable: boolean;
}
const object = (value: CommandValue): value is { [key: string]: CommandValue } => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value: CommandValue, expected: string[]): asserts value is { [key: string]: CommandValue } {
  if (!object(value) || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) throw new Error('Unsupported command parameters.');
}
function contentId(value: CommandValue): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('A stable local-genome content ID is required.');
}
function integer(value: CommandValue, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
}
function geneId(value: CommandValue): void { if (value !== null) integer(value, 1, 50000); }
export function validateResearchView(value: CommandValue): asserts value is unknown & ResearchView & CommandValue {
  fields(value, ['contentId', 'geneId', 'viewMode', 'readingFrame', 'scrollPosition']);
  contentId(value.contentId); geneId(value.geneId);
  if (!['dna', 'aa', 'dual'].includes(String(value.viewMode)) || ![0, 1, 2, -1, -2, -3].includes(Number(value.readingFrame)) || typeof value.readingFrame !== 'number') throw new Error('Unsupported sequence view or reading frame.');
  integer(value.scrollPosition, 0, 4999999);
}
function abort(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Workflow cancelled.', 'AbortError'); }

export class ResearchWorkflow {
  readonly commands: CommandSession;
  private expectedBundle: string | null = null;
  private expectedGenomes: LocalGenome[] = [];
  private history: ResearchView[] = [];
  private historyIndex = -1;
  private historyTarget: number | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ResearchSnapshot = { view: null, result: null, undoAvailable: false, redoAvailable: false };

  constructor(readonly ids: ResearchActionIds, private readonly environment: ResearchEnvironment) {
    const adapters = new Map<string, CommandAdapter>();
    adapters.set(ids.view, {
      validate: validateResearchView,
      prepare: async (parameters, signal) => {
        validateResearchView(parameters);
        const view = parameters as ResearchView;
        const historyTarget = this.historyTarget;
        const genome = await this.genome(view.contentId, signal);
        this.checkSelection(genome, view.geneId, false);
        const viewLength = view.viewMode === 'aa' ? Math.ceil(genome.sequence.length / 3) : genome.sequence.length;
        if (view.scrollPosition >= viewLength) throw new Error('Saved position lies outside the exact genome view.');
        return { output: analysisJson({ view, sequenceSha256: genome.phage.localGenome!.sequenceSha256 }),
          apply: async activeSignal => {
            abort(activeSignal);
            const before = this.environment.currentView();
            await this.environment.applyView(structuredClone(view), activeSignal);
            abort(activeSignal);
            const accepted = this.environment.currentView();
            if (!accepted || !commandValuesEqual(analysisJson(accepted), analysisJson(view))) {
              throw new Error('The explorer did not accept the exact saved view. No navigation command was recorded.');
            }
            if (historyTarget !== null) this.historyIndex = historyTarget;
            else {
              const next = this.history.slice(0, this.historyIndex + 1);
              if (before && (!next.length || !commandValuesEqual(analysisJson(next[next.length - 1]), analysisJson(before)))) next.push(structuredClone(before));
              if (!next.length || !commandValuesEqual(analysisJson(next[next.length - 1]), analysisJson(view))) next.push(structuredClone(view));
              this.history = next.slice(-64); this.historyIndex = this.history.length - 1;
            }
            this.publish({ view: structuredClone(view), result: null });
          } };
      },
    });
    adapters.set(ids.repeats, {
      validate(parameters) { fields(parameters, ['contentId', 'minLength', 'maxGap']); contentId(parameters.contentId); integer(parameters.minLength, 4, 256); integer(parameters.maxGap, 0, 100000); },
      prepare: async (parameters, signal) => {
        const values = parameters as { contentId: string; minLength: number; maxGap: number };
        const genome = await this.genome(values.contentId, signal);
        const record = await environment.repeats(genome, { minLength: values.minLength, maxGap: values.maxGap }, signal);
        return this.result(record, genome, signal);
      },
    });
    adapters.set(ids.codons, {
      validate(parameters) { fields(parameters, ['contentId', 'geneId']); contentId(parameters.contentId); geneId(parameters.geneId); },
      prepare: async (parameters, signal) => {
        const values = parameters as { contentId: string; geneId: number | null };
        const genome = await this.genome(values.contentId, signal);
        this.checkSelection(genome, values.geneId);
        const record = await environment.codons(genome, values.geneId, signal);
        return this.result(record, genome, signal);
      },
    });
    if (adapters.size !== 3) throw new Error('Research actions must use distinct canonical IDs.');
    this.commands = new CommandSession(adapters, (context, signal) => this.validateContext(context, signal));
  }
  getSnapshot = (): ResearchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<ResearchSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change, undoAvailable: this.historyIndex > 0, redoAvailable: this.historyIndex < this.history.length - 1 };
    for (const listener of this.listeners) listener();
  }
  private result(record: AnalysisRecord, genome: LocalGenome, signal: AbortSignal) {
    abort(signal);
    const copy = structuredClone(record);
    return { output: analysisJson({ method: copy.method, cacheKey: copy.cacheKey, resultId: copy.resultId }),
      apply: (activeSignal: AbortSignal) => { abort(activeSignal); this.matchLoaded(genome); this.publish({ result: copy }); } };
  }
  private checkSelection(genome: LocalGenome, selected: number | null, requireCDS = true): void {
    if (selected !== null && !genome.phage.genes.some(gene => gene.id === selected && (!requireCDS || gene.type === 'CDS'))) throw new Error('The selected CDS is unavailable in this exact annotation snapshot.');
  }
  private async validateContext(context: CommandValue, signal: AbortSignal): Promise<void> {
    fields(context, ['bundle']);
    if (typeof context.bundle !== 'string') throw new Error('A portable local-genome input bundle is required.');
    if (this.expectedBundle !== context.bundle) {
      const parsed = await this.environment.parseBundle(context.bundle, signal);
      abort(signal);
      this.expectedGenomes = structuredClone(parsed.genomes);
      this.expectedBundle = context.bundle;
    }
    for (const expected of this.expectedGenomes) this.matchLoaded(expected);
    abort(signal);
  }
  private matchLoaded(expected: LocalGenome): LocalGenome {
    const id = expected.phage.localGenome!.contentId;
    const loaded = this.environment.genomes().find(item => item.phage.localGenome?.contentId === id);
    if (!loaded) throw new Error(`Missing local genome ${id.slice(0, 12)}. Add the workflow's bundled genomes before replay.`);
    if (loaded.sequence !== expected.sequence || !commandValuesEqual(analysisJson(loaded.phage), analysisJson(expected.phage))) throw new Error(`Local genome ${id.slice(0, 12)} has changed sequence or annotations.`);
    return structuredClone(loaded);
  }
  private async genome(id: string, signal: AbortSignal): Promise<LocalGenome> {
    await this.validateContext(this.commands.getSnapshot().tape.context, signal);
    const expected = this.expectedGenomes.find(item => item.phage.localGenome?.contentId === id);
    if (!expected) throw new Error('The command refers to a genome outside the recorded input bundle.');
    return this.matchLoaded(expected);
  }
  start = (name: string): void => {
    if (!this.environment.genomes().length) throw new Error('Add local genomes before recording a workflow.');
    this.commands.start(name, { bundle: this.environment.bundle() });
    this.expectedBundle = null; this.expectedGenomes = [];
    this.history = []; this.historyIndex = -1;
    this.publish({ view: null, result: null });
  };
  /** Import remains declarative. Adding bundled genomes is a separate, explicit user action. */
  load = (content: string): void => {
    const tape = parseCommandTape(content);
    fields(tape.context, ['bundle']);
    if (typeof tape.context.bundle !== 'string') throw new Error('Workflow has no input bundle.');
    this.commands.load(content);
    this.expectedBundle = null; this.expectedGenomes = [];
    this.history = []; this.historyIndex = -1;
    this.publish({ view: null, result: null });
  };
  /** Parse private inputs before replacing an accepted tape or result. */
  loadAndReview = async (content: string, signal: AbortSignal): Promise<GenomeImportResult> => {
    const tape = parseCommandTape(content);
    fields(tape.context, ['bundle']);
    if (typeof tape.context.bundle !== 'string') throw new Error('Workflow has no input bundle.');
    const parsed = await this.environment.parseBundle(tape.context.bundle, signal);
    abort(signal);
    this.load(content);
    return parsed;
  };
  bundledInputs = async (signal: AbortSignal): Promise<GenomeImportResult> => {
    const context = this.commands.getSnapshot().tape.context;
    fields(context, ['bundle']);
    if (typeof context.bundle !== 'string') throw new Error('Workflow has no input bundle.');
    const parsed = await this.environment.parseBundle(context.bundle, signal);
    abort(signal); return parsed;
  };
  /** Undo/redo emits another absolute canonical navigation command when recording. */
  moveHistory = async (direction: -1 | 1): Promise<void> => {
    if (!['idle', 'recording'].includes(this.commands.getSnapshot().mode)) throw new Error('Cancel running work before navigating history.');
    const target = this.historyIndex + direction;
    if (target < 0 || target >= this.history.length) throw new Error('No saved view in that direction.');
    this.historyTarget = target;
    const task = this.commands.dispatch(this.ids.view, analysisJson(this.history[target]));
    this.historyTarget = null; // The adapter captures this synchronously, before its first await.
    await task;
  };
}
