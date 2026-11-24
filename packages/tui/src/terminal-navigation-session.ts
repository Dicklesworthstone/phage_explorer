/** Ordinary explorer navigation, using the canonical command executor and view shape.
 * Saved views contain source fingerprints, never a second copy of private genomes.
 */
import { createHash } from 'node:crypto';
import { usePhageStore, type PhageExplorerState } from '@phage-explorer/state';
import type { PhageFull, PhageSummary } from '../../core/src/types';
import type { PhageRepository } from '../../db-runtime/src/types';
import { analysisJson } from '../../core/src/analysis-result';
import { CommandSession, commandValuesEqual } from '../../core/src/command-session';
import {
  SAVED_VIEW_LIMITS as TERMINAL_VIEW_LIMITS,
  parseSavedViews as parseTerminalViews, serializeSavedViews as serializeTerminalViews,
  validateNamedSavedView as validateEntry, validateSavedViewName as title,
  savedViewIdentity, savedViewSource,
  type SavedViewSource as TerminalViewSource, type SavedView as TerminalView, type NamedSavedView as NamedTerminalView,
} from '../../core/src/saved-views';
export {
  SAVED_VIEW_LIMITS as TERMINAL_VIEW_LIMITS,
  parseSavedViews as parseTerminalViews, serializeSavedViews as serializeTerminalViews,
  type SavedViewSource as TerminalViewSource, type SavedView as TerminalView,
  type NamedSavedView as NamedTerminalView, type SavedViewCollection as TerminalViewCollection,
} from '../../core/src/saved-views';
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { validateResearchView, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { readInput, writeNewOutput } from '../../../scripts/research-workflow';
import { terminalGenomeLabel, terminalGenomePath } from './local-genome-session';

export interface TerminalNavigationSource {
  repository: PhageRepository; phages: PhageSummary[]; index: number; phage: PhageFull; sequence: string;
}
export interface TerminalNavigationSnapshot {
  history: TerminalView[]; historyIndex: number; saved: NamedTerminalView[];
  loadRevision: number;
  busy: 'restoring' | 'opening' | 'saving' | null; error: string | null; notice: string | null;
}
interface Restore {
  entry: TerminalView; repository: PhageRepository; phages: PhageSummary[]; origin: PhageExplorerState;
  phase: 'reading' | 'applying'; prepared: TerminalNavigationSource | null;
  ready: (() => void) | null; fail: ((cause: Error) => void) | null;
}
export interface TerminalNavigationRuntime {
  read?: typeof readInput; write?: typeof writeNewOutput; now?: () => number; timeoutMs?: number;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Saved-view operation cancelled.', 'AbortError');
}
function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Saved-view operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

/** Fingerprint complete bases and ordered annotations, not a numeric catalog ID.
 * A catalog rebuild may renumber genomes, but changed bases/features must reject.
 */
export function terminalViewSource(phage: PhageFull, sequence: string): TerminalViewSource {
  const sequenceSha256 = hash(sequence);
  const fingerprint = hash(savedViewIdentity(phage, sequence.length, sequenceSha256));
  return savedViewSource(phage, sequence.length, sequenceSha256, fingerprint);
}
function samePosition(a: PhageExplorerState, b: PhageExplorerState): boolean {
  return a.phages === b.phages && a.currentPhageIndex === b.currentPhageIndex && a.currentPhage === b.currentPhage
    && a.viewMode === b.viewMode && a.readingFrame === b.readingFrame && a.scrollPosition === b.scrollPosition
    && a.selectedGeneId === b.selectedGeneId;
}
function matchesView(state: PhageExplorerState, view: ResearchView): boolean {
  return state.viewMode === view.viewMode && state.readingFrame === view.readingFrame
    && state.scrollPosition === view.scrollPosition && state.selectedGeneId === view.geneId;
}

export class TerminalNavigationSession {
  private active: (TerminalNavigationSource & { source: TerminalViewSource }) | null = null;
  private restore: Restore | null = null;
  private io: AbortController | null = null;
  private selfWrite = false;
  private pending: TerminalView | null = null;
  private queued = false;
  private lastChange = 0;
  private scrollBurst = false;
  private listeners = new Set<() => void>();
  private disconnectStore: (() => void) | null = null;
  private readonly commands: CommandSession;
  private state: TerminalNavigationSnapshot = { history: [], historyIndex: -1, saved: [], loadRevision: 0, busy: null, error: null, notice: null };
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly repository: () => PhageRepository, private readonly runtime: TerminalNavigationRuntime = {}) {
    this.now = runtime.now ?? Date.now;
    this.timeoutMs = runtime.timeoutMs ?? TERMINAL_VIEW_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid navigation deadline.');
    this.commands = new CommandSession(new Map([[ActionIds.NavGoto, {
      validate: validateResearchView,
      prepare: (parameters, signal) => this.prepare(parameters as unknown as ResearchView, signal),
    }]]), async () => {});
  }
  getSnapshot = (): TerminalNavigationSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<TerminalNavigationSnapshot>): void {
    this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener();
  }
  connect = (): (() => void) => {
    this.disconnectStore?.();
    const disconnect = usePhageStore.subscribe((next, previous) => this.observe(next, previous));
    this.disconnectStore = disconnect;
    return () => {
      disconnect();
      if (this.disconnectStore === disconnect) {
        this.flush(); this.disconnectStore = null; this.cancel(); this.active = null;
      }
    };
  };
  private owns(source: TerminalNavigationSource, state = usePhageStore.getState()): boolean {
    return this.repository() === source.repository && state.phages === source.phages && state.currentPhageIndex === source.index
      && state.currentPhage === source.phage && state.phages[source.index]?.id === source.phage.id;
  }
  private capture(): TerminalView | null {
    const state = usePhageStore.getState(), source = this.active;
    if (!source || !this.owns(source, state) || state.isLoadingPhage) return null;
    const geneId = state.selectedGeneId !== null && source.phage.genes.some(gene => gene.id === state.selectedGeneId) ? state.selectedGeneId : null;
    const view: ResearchView = { contentId: source.source.contentId, geneId, viewMode: state.viewMode,
      readingFrame: state.readingFrame, scrollPosition: state.scrollPosition };
    const entry = { source: source.source, view };
    try { validateEntry({ name: 'Current view', ...entry }); } catch { return null; }
    return structuredClone(entry);
  }
  private observe(next: PhageExplorerState, previous: PhageExplorerState): void {
    if (this.selfWrite) return;
    const operation = this.restore;
    if (operation) {
      const target = operation.prepared;
      const changed = this.repository() !== operation.repository || next.phages !== operation.phages
        || (operation.phase === 'reading' ? !samePosition(next, operation.origin)
          : !target || next.currentPhageIndex !== target.index || !matchesView(next, operation.entry.view)
            || next.currentPhage !== null && next.currentPhage !== target.phage);
      if (changed) this.cancel('Navigation changed. The pending view restoration was cancelled.');
      else return;
    }
    if (samePosition(next, previous) && next.isLoadingPhage === previous.isLoadingPhage) return;
    this.queueCapture();
  }
  private queueCapture(): void {
    const entry = this.capture(); if (!entry) return;
    this.pending = entry;
    if (!this.queued) {
      this.queued = true;
      queueMicrotask(() => { this.queued = false; this.flush(); });
    }
  }
  private flush(): void {
    const entry = this.pending; this.pending = null;
    if (entry) this.remember(entry);
  }
  private remember(entry: TerminalView): void {
    const { history, historyIndex } = this.state, current = history[historyIndex];
    if (current && commandValuesEqual(current, entry)) return;
    const now = this.now(), next = history.slice(0, historyIndex + 1);
    const scrollOnly = current && current.source.fingerprint === entry.source.fingerprint
      && current.view.geneId === entry.view.geneId && current.view.viewMode === entry.view.viewMode
      && current.view.readingFrame === entry.view.readingFrame;
    if (scrollOnly && this.scrollBurst && historyIndex === history.length - 1 && next.length > 1
      && now - this.lastChange < TERMINAL_VIEW_LIMITS.scrollBurstMs) next[next.length - 1] = entry;
    else next.push(entry);
    this.scrollBurst = !!scrollOnly; this.lastChange = now;
    const bounded = next.slice(-TERMINAL_VIEW_LIMITS.history);
    this.publish({ history: bounded, historyIndex: bounded.length - 1 });
  }
  /** Called only after App accepted one complete sequence/annotation pair. */
  acceptSource = (source: TerminalNavigationSource): void => {
    if (!this.owns(source)) return;
    try {
      const identity = terminalViewSource(source.phage, source.sequence);
      this.active = { ...source, source: identity };
      const operation = this.restore;
      if (operation?.phase === 'applying') {
        if (operation.prepared?.phage !== source.phage || !commandValuesEqual(identity, operation.entry.source)) {
          throw new Error('The loaded source differs from the saved view.');
        }
        this.writeView(operation.entry.view, { isLoadingPhage: false });
        operation.ready?.();
      } else this.queueCapture();
    } catch (cause) {
      this.active = null;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.restore?.fail?.(error);
      this.publish({ error: terminalGenomeLabel(error.message) });
    }
  };
  /** One verified read is handed to the existing App loader, with exact ownership. */
  takePreparedSource = (repository: PhageRepository, phages: PhageSummary[], index: number): TerminalNavigationSource | null => {
    const operation = this.restore, prepared = operation?.prepared, state = usePhageStore.getState();
    return operation?.phase === 'applying' && prepared && repository === operation.repository && repository === this.repository()
      && phages === operation.phages && state.phages === phages && index === prepared.index && state.currentPhageIndex === index
      && matchesView(state, operation.entry.view) ? prepared : null;
  };
  failSource = (cause: unknown): void => {
    this.restore?.fail?.(cause instanceof Error ? cause : new Error(String(cause)));
  };
  private writeView(view: ResearchView, extra: Partial<PhageExplorerState> = {}): void {
    this.selfWrite = true;
    try { usePhageStore.setState({ ...extra, viewMode: view.viewMode, readingFrame: view.readingFrame,
      scrollPosition: view.scrollPosition, selectedGeneId: view.geneId }); }
    finally { this.selfWrite = false; }
  }
  /** An explicit cancel before loader acknowledgement returns to the departure
   * view only while we still own the pending selection. A user's newer selection wins.
   */
  private restoreDeparture(operation: Restore): void {
    const state = usePhageStore.getState(), prepared = operation.prepared;
    if (operation.phase !== 'applying' || !prepared || this.repository() !== operation.repository
      || state.phages !== operation.phages || state.currentPhageIndex !== prepared.index
      || state.currentPhage !== null && state.currentPhage !== prepared.phage || !matchesView(state, operation.entry.view)) return;
    const origin = operation.origin;
    this.selfWrite = true;
    try { usePhageStore.setState({ currentPhageIndex: origin.currentPhageIndex, currentPhage: origin.currentPhage,
      viewMode: origin.viewMode, readingFrame: origin.readingFrame, scrollPosition: origin.scrollPosition,
      selectedGeneId: origin.selectedGeneId, isLoadingPhage: origin.isLoadingPhage, overlayData: origin.overlayData,
      diffEnabled: origin.diffEnabled, diffReferencePhageId: origin.diffReferencePhageId, diffReferenceSequence: origin.diffReferenceSequence }); }
    finally { this.selfWrite = false; }
  }
  private current(operation: Restore, signal: AbortSignal): void {
    check(signal);
    if (this.restore !== operation || this.repository() !== operation.repository || usePhageStore.getState().phages !== operation.phages) {
      throw new Error('The active input repository changed during view restoration.');
    }
    if (operation.phase === 'reading' && !samePosition(usePhageStore.getState(), operation.origin)) {
      throw new Error('The current selection changed during view restoration.');
    }
  }
  private async prepare(view: ResearchView, signal: AbortSignal) {
    const operation = this.restore;
    if (!operation || !commandValuesEqual(view, operation.entry.view)) throw new Error('No owned view restoration.');
    this.current(operation, signal);
    const expected = operation.entry.source;
    const matches = operation.phages.map((phage, index) => ({ phage, index })).filter(({ phage }) => expected.kind === 'local'
      ? phage.localGenome?.contentId === expected.contentId
      : !phage.localGenome && phage.accession === expected.accession && phage.slug === expected.slug);
    if (!matches.length) throw new Error(expected.kind === 'local'
      ? `Missing local genome ${expected.name}. Import its original FASTA/GenBank file or saved genome bundle, then restore this view again.`
      : `Catalog genome ${expected.accession} is unavailable in this repository.`);
    if (matches.length !== 1) throw new Error('The saved source is ambiguous in this repository; no genome was selected.');
    const { phage: summary, index } = matches[0], repository = operation.repository;
    const found = await repository.getPhageById(summary.id); this.current(operation, signal);
    if (!found || found.id !== summary.id) throw new Error('The saved genome is no longer available.');
    const phage = structuredClone(found);
    const length = await repository.getFullGenomeLength(phage.id); this.current(operation, signal);
    if (length !== expected.bases || length !== phage.genomeLength) throw new Error('Genome length changed since this view was saved.');
    const sequence = await repository.getSequenceWindow(phage.id, 0, length); this.current(operation, signal);
    const source = terminalViewSource(phage, sequence);
    if (!commandValuesEqual(source, expected)) throw new Error('Genome bases or annotations changed since this view was saved. Reimport the exact source or save a new view.');
    if (view.geneId !== null && !phage.genes.some(gene => gene.id === view.geneId)) throw new Error('The saved gene is unavailable in this exact annotation snapshot.');
    return { output: analysisJson({ source: source.fingerprint, view }), apply: async (activeSignal: AbortSignal) => {
      this.current(operation, activeSignal);
      const active = this.active;
      if (active && this.owns(active) && active.index === index && commandValuesEqual(active.source, expected)) {
        this.writeView(view); return;
      }
      operation.phase = 'applying'; operation.prepared = { repository, phages: operation.phages, index, phage, sequence };
      const ready = new Promise<void>((resolve, reject) => { operation.ready = resolve; operation.fail = reject; });
      this.writeView(view, { currentPhageIndex: index, currentPhage: null, isLoadingPhage: true, overlayData: {}, error: null,
        diffEnabled: false, diffReferencePhageId: null, diffReferenceSequence: null });
      if (index === operation.origin.currentPhageIndex) this.publish({ loadRevision: this.state.loadRevision + 1 });
      await cancellable(ready, activeSignal); this.current(operation, activeSignal);
    } };
  }
  private async go(entry: TerminalView, historyIndex: number | null): Promise<boolean> {
    this.flush();
    if (this.state.busy) { this.publish({ error: 'Finish or cancel the active saved-view operation first.' }); return false; }
    const operation: Restore = { entry: structuredClone(entry), repository: this.repository(), phages: usePhageStore.getState().phages,
      origin: usePhageStore.getState(), phase: 'reading', prepared: null, ready: null, fail: null };
    this.restore = operation; this.scrollBurst = false;
    this.publish({ busy: 'restoring', error: null, notice: null });
    const timer = setTimeout(() => { if (this.restore === operation) this.cancel('View restoration timed out; no later result will take control.'); }, this.timeoutMs);
    try {
      await this.commands.dispatch(ActionIds.NavGoto, analysisJson(operation.entry.view));
      if (this.restore !== operation) return false;
      if (historyIndex === null) this.remember(operation.entry);
      else this.publish({ historyIndex });
      this.publish({ notice: `Restored ${terminalGenomeLabel(entry.source.name)} at ${entry.view.viewMode === 'aa' ? 'residue' : 'base'} ${entry.view.scrollPosition + 1}.` });
      return true;
    } catch (cause) {
      if (this.restore === operation) {
        this.restoreDeparture(operation);
        this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (this.restore === operation) { this.restore = null; this.publish({ busy: null }); }
    }
  }
  moveHistory = async (direction: -1 | 1): Promise<boolean> => {
    this.flush(); const target = this.state.historyIndex + direction, entry = this.state.history[target];
    if (!entry) { this.publish({ error: direction < 0 ? 'No earlier explorer view.' : 'No later explorer view.' }); return false; }
    return this.go(entry, target);
  };
  restoreHistory = async (index: number): Promise<boolean> => {
    this.flush(); const entry = this.state.history[index];
    if (!entry) { this.publish({ error: 'Select an available history entry.' }); return false; }
    return this.go(entry, index);
  };
  restoreSaved = async (index: number): Promise<boolean> => {
    const entry = this.state.saved[index];
    if (!entry) { this.publish({ error: 'Select a named saved view first.' }); return false; }
    return this.go({ source: entry.source, view: entry.view }, null);
  };
  saveCurrent = (name: string): void => {
    this.editable(); title(name); this.flush();
    if (this.state.saved.some(view => view.name === name)) throw new Error('That view name already exists. Choose another name or rename the existing view.');
    if (this.state.saved.length >= TERMINAL_VIEW_LIMITS.saved) throw new Error('The collection already contains 64 named views.');
    const entry = this.capture();
    if (!entry) throw new Error('Wait for a complete selected genome and valid position before saving its view.');
    this.publish({ saved: [...this.state.saved, { name, ...entry }], error: null,
      notice: 'Named view captured. Export the collection to keep it after quitting; local source files stay in the local-genome workspace.' });
  };
  rename = (index: number, name: string): void => {
    this.editable(); title(name);
    if (!this.state.saved[index]) throw new Error('Select a saved view first.');
    if (this.state.saved.some((view, i) => i !== index && view.name === name)) throw new Error('That view name already exists.');
    this.publish({ saved: this.state.saved.map((view, i) => i === index ? { ...view, name } : view), error: null });
  };
  forget = (index: number): void => {
    this.editable(); this.publish({ saved: this.state.saved.filter((_view, i) => i !== index), error: null,
      notice: 'Removed the named view from this session. Files and genome inputs are unchanged.' });
  };
  private editable(): void { if (this.state.busy) throw new Error('Finish or cancel the active saved-view operation first.'); }
  private async fileOperation(kind: 'opening' | 'saving', run: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (this.state.busy) { this.publish({ error: 'Finish or cancel the active saved-view operation first.' }); return false; }
    const controller = new AbortController(); this.io = controller;
    this.publish({ busy: kind, error: null, notice: null });
    const timer = setTimeout(() => {
      if (this.io === controller) this.cancel(kind === 'saving'
        ? 'Saved-view export timed out. A partial new export may remain.'
        : 'Opening saved views timed out. Existing named views remain available.');
    }, this.timeoutMs);
    try { await cancellable(run(controller.signal), controller.signal); return this.io === controller; }
    catch (cause) {
      if (this.io === controller) this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
      return false;
    } finally { clearTimeout(timer); if (this.io === controller) { this.io = null; this.publish({ busy: null }); } }
  }
  open = (path: string): Promise<boolean> => this.fileOperation('opening', async signal => {
    const content = await (this.runtime.read ?? readInput)(terminalGenomePath(path), signal, TERMINAL_VIEW_LIMITS.bytes);
    check(signal); const imported = parseTerminalViews(content), merged = [...this.state.saved];
    for (const entry of imported.views) {
      const prior = merged.find(view => view.name === entry.name);
      if (prior && !commandValuesEqual(prior, entry)) throw new Error(`A different view is already named ${terminalGenomeLabel(entry.name)}. Rename it before opening this collection.`);
      if (!prior) merged.push(entry);
    }
    if (merged.length > TERMINAL_VIEW_LIMITS.saved) throw new Error('The combined collection exceeds 64 named views.');
    this.publish({ saved: merged, notice: 'Opened named views. No genome was selected. Restore verifies the exact catalog/local source; import missing local files or bundles first.' });
  });
  save = (path: string): Promise<boolean> => this.fileOperation('saving', async signal => {
    const content = serializeTerminalViews(this.state.saved);
    await (this.runtime.write ?? writeNewOutput)(terminalGenomePath(path), content, signal); check(signal);
    this.publish({ notice: 'Saved the named-view collection. It contains source fingerprints and view settings, not genome bases. Existing files were not overwritten.' });
  });
  cancel = (notice?: string): void => {
    const active = this.restore !== null || this.io !== null;
    const message = notice ?? (this.state.busy === 'saving'
      ? 'Export cancelled. Saved views remain available; a partial new export may remain.'
      : 'Cancelled. Saved views and completed navigation remain available.');
    if (this.restore) this.restoreDeparture(this.restore);
    this.restore = null; this.io?.abort(); this.io = null; this.commands.cancel();
    if (active) this.publish({ busy: null, notice: message });
  };
}
