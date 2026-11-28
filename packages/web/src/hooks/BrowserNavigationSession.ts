import { usePhageStore, type PhageExplorerState } from '@phage-explorer/state';
import {
  SAVED_VIEW_LIMITS, parseSavedViews, serializeSavedViews, savedViewIdentity, savedViewSource,
  validateNamedSavedView, validateSavedViewName,
  type SavedView, type NamedSavedView, type SavedViewSource,
} from '../../../core/src/saved-views';
import { commandValuesEqual } from '../../../core/src/command-session';
import type { PhageSelectionSession, PhageSelection } from './PhageSelectionSession';
import type { PhageRepository } from '../db/types';
import { readLocalTextFile } from '../utils/fileSystem';

export interface BrowserNavigationSnapshot {
  history: SavedView[]; historyIndex: number; saved: NamedSavedView[];
  ready: boolean; busy: boolean; error: string | null; notice: string | null;
}
interface ActiveSource {
  repository: PhageRepository; selection: PhageSelection; source: SavedViewSource;
  phages: PhageExplorerState['phages'];
}
interface Restore {
  controller: AbortController; repository: PhageRepository; phages: PhageExplorerState['phages'];
  origin: PhageExplorerState; originSelection: PhageSelection | null; index: number;
  accepted: PhageSelection | null; source: SavedViewSource | null;
  entry: SavedView; timedOut: boolean;
}
export interface BrowserNavigationRuntime {
  now?: () => number; timeoutMs?: number;
}
function aborted(): DOMException { return new DOMException('View restoration cancelled.', 'AbortError'); }
export function readSavedViewsFile(file: Pick<Blob, 'size' | 'arrayBuffer'>, signal: AbortSignal): Promise<string> {
  return readLocalTextFile(file, SAVED_VIEW_LIMITS.bytes, signal);
}
async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function browserViewSource(selection: Pick<PhageSelection, 'phage' | 'sequence'>): Promise<SavedViewSource> {
  const phage = structuredClone(selection.phage), sequence = selection.sequence;
  const sequenceSha256 = await digest(sequence);
  const fingerprint = await digest(savedViewIdentity(phage, sequence.length, sequenceSha256));
  return savedViewSource(phage, sequence.length, sequenceSha256, fingerprint);
}
function samePosition(a: PhageExplorerState, b: PhageExplorerState): boolean {
  return a.phages === b.phages && a.currentPhageIndex === b.currentPhageIndex && a.currentPhage === b.currentPhage
    && a.viewMode === b.viewMode && a.readingFrame === b.readingFrame
    && a.scrollPosition === b.scrollPosition && a.selectedGeneId === b.selectedGeneId;
}
/** Ordinary navigation owns the same accepted complete selection as the explorer.
 * Save is explicit; history stays in this tab. Restores verify before selection
 * publication. A newer user navigation retires the pending request.
 */
export class BrowserNavigationSession {
  private state: BrowserNavigationSnapshot = { history: [], historyIndex: -1, saved: [], ready: false, busy: false, error: null, notice: null };
  private listeners = new Set<() => void>();
  private active: ActiveSource | null = null;
  private operation: Restore | null = null;
  private sourceGeneration = 0;
  private sourceCache = new WeakMap<PhageSelection, Promise<SavedViewSource>>();
  private disconnect: (() => void) | null = null;
  private queued = false;
  private lastChange = 0;
  private scrollBurst = false;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly selection: PhageSelectionSession, runtime: BrowserNavigationRuntime = {}) {
    this.now = runtime.now ?? Date.now;
    this.timeoutMs = runtime.timeoutMs ?? SAVED_VIEW_LIMITS.timeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw new Error('Invalid navigation deadline.');
  }
  getSnapshot = (): BrowserNavigationSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(change: Partial<BrowserNavigationSnapshot>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
  connect = (): (() => void) => {
    this.disconnect?.();
    const store = usePhageStore.subscribe((next, previous) => {
      if (this.operation) {
        const op = this.operation;
        const accepted = op.accepted;
        const valid = this.selection.getSnapshot().repository === op.repository && next.phages === op.phages
          && (accepted && next.currentPhage === accepted.phage
            ? next.currentPhageIndex === accepted.index && next.scrollPosition === op.entry.view.scrollPosition
              && next.selectedGeneId === op.entry.view.geneId && next.viewMode === op.entry.view.viewMode
              && next.readingFrame === op.entry.view.readingFrame
            : samePosition(next, op.origin));
        if (!valid) this.cancel('View restoration stopped because you navigated or changed the view.');
        return;
      }
      if (!samePosition(next, previous) || next.isLoadingPhage !== previous.isLoadingPhage) this.queueCapture();
    });
    const selection = this.selection.subscribe(() => this.observeSelection());
    const disconnect = () => {
      store(); selection();
      if (this.disconnect === disconnect) {
        this.disconnect = null; this.cancel(); this.sourceGeneration++; this.active = null; this.publish({ ready: false });
      }
    };
    this.disconnect = disconnect;
    this.observeSelection();
    return disconnect;
  };
  private sourceFor(selection: PhageSelection): Promise<SavedViewSource> {
    let source = this.sourceCache.get(selection);
    if (!source) { source = browserViewSource(selection); this.sourceCache.set(selection, source); }
    return source;
  }
  private observeSelection(): void {
    const snapshot = this.selection.getSnapshot(), op = this.operation;
    if (op && (snapshot.repository !== op.repository || usePhageStore.getState().phages !== op.phages
      || snapshot.selection !== op.originSelection && snapshot.selection !== op.accepted
      || snapshot.pendingIndex !== null && snapshot.pendingIndex !== op.index)) {
      this.cancel('View restoration stopped because the genome selection changed.');
    }
    const selection = snapshot.selection, repository = snapshot.repository;
    if (!selection || !repository) {
      this.sourceGeneration++; this.active = null; this.publish({ ready: false }); return;
    }
    if (this.active?.selection === selection && this.active.repository === repository
      && this.active.phages === usePhageStore.getState().phages) { this.queueCapture(); return; }
    const generation = ++this.sourceGeneration, phages = usePhageStore.getState().phages;
    this.active = null; this.publish({ ready: false });
    void this.sourceFor(selection).then(source => {
      if (generation !== this.sourceGeneration || this.selection.getSnapshot().selection !== selection
        || this.selection.getSnapshot().repository !== repository || usePhageStore.getState().phages !== phages) return;
      this.active = { repository, selection, source, phages };
      this.queueCapture();
    }).catch(cause => {
      if (generation === this.sourceGeneration) this.publish({ ready: false,
        error: cause instanceof Error ? cause.message : 'This genome cannot be saved as a view.' });
    });
  }
  private capture(): SavedView | null {
    const state = usePhageStore.getState(), active = this.active;
    if (!active || state.isLoadingPhage || active.repository !== this.selection.getSnapshot().repository
      || this.selection.getSnapshot().selection !== active.selection || state.phages !== active.phages
      || state.currentPhage !== active.selection.phage || state.currentPhageIndex !== active.selection.index
      || state.phages[active.selection.index]?.id !== active.selection.phage.id) return null;
    const entry: SavedView = { source: active.source, view: {
      contentId: active.source.contentId, viewMode: state.viewMode, readingFrame: state.readingFrame,
      scrollPosition: state.scrollPosition, geneId: state.selectedGeneId,
    } };
    try {
      validateNamedSavedView({ name: 'Current view', ...entry });
      if (entry.view.geneId !== null && !active.selection.phage.genes.some(gene => gene.id === entry.view.geneId)) return null;
    } catch { return null; }
    return structuredClone(entry);
  }
  private queueCapture(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (this.disconnect && !this.operation) this.flush(); });
  }
  private append(entry: SavedView, coalesce = true): void {
    const previous = this.state.history[this.state.historyIndex];
    if (previous && commandValuesEqual(previous, entry)) return;
    const history = this.state.history.slice(0, this.state.historyIndex + 1), now = this.now();
    const scrollOnly = previous && previous.source.fingerprint === entry.source.fingerprint
      && previous.view.viewMode === entry.view.viewMode && previous.view.readingFrame === entry.view.readingFrame
      && previous.view.geneId === entry.view.geneId;
    if (coalesce && this.scrollBurst && scrollOnly && this.state.historyIndex === this.state.history.length - 1
      && now - this.lastChange < SAVED_VIEW_LIMITS.scrollBurstMs) history[history.length - 1] = entry;
    else history.push(entry);
    if (history.length > SAVED_VIEW_LIMITS.history) history.shift();
    this.lastChange = now; this.scrollBurst = !!scrollOnly && coalesce;
    this.publish({ history, historyIndex: history.length - 1 });
  }
  private flush(): void {
    if (this.operation) return;
    const entry = this.capture();
    if (this.state.ready !== !!entry) this.publish({ ready: !!entry });
    if (entry) this.append(entry);
  }
  saveCurrent(name: string): boolean {
    try {
      validateSavedViewName(name); this.flush();
      const entry = this.capture();
      if (!entry || this.operation) throw new Error('Wait for the complete genome and current position before saving a view.');
      if (this.state.saved.some(view => view.name === name)) throw new Error('A saved view already uses that name. Choose another name.');
      if (this.state.saved.length >= SAVED_VIEW_LIMITS.saved) throw new Error('At most 64 named views can be kept. Export or forget a view first.');
      this.publish({ saved: [...this.state.saved, { name, ...entry }], error: null,
        notice: 'Named view added to this tab. Export JSON or save a device snapshot to keep it after reload.' });
      return true;
    } catch (cause) { this.fail(cause); return false; }
  }
  rename(name: string, nextName: string): boolean {
    try {
      validateSavedViewName(nextName);
      if (!this.state.saved.some(view => view.name === name)) throw new Error('Choose an existing saved view.');
      if (name !== nextName && this.state.saved.some(view => view.name === nextName)) throw new Error('A saved view already uses that name.');
      this.publish({ saved: this.state.saved.map(view => view.name === name ? { ...view, name: nextName } : view), error: null, notice: 'View renamed in this tab.' });
      return true;
    } catch (cause) { this.fail(cause); return false; }
  }
  forget(name: string): void {
    this.publish({ saved: this.state.saved.filter(view => view.name !== name), error: null, notice: 'Named view removed from this tab.' });
  }
  export = (): string => serializeSavedViews(this.state.saved);
  import = (content: string): void => {
    const collection = parseSavedViews(content), merged = [...this.state.saved];
    for (const entry of collection.views) {
      const existing = merged.find(view => view.name === entry.name);
      if (existing && !commandValuesEqual(existing, entry)) throw new Error('An imported view uses an existing name with a different position. Rename or forget it first: ' + entry.name);
      if (!existing) merged.push(entry);
    }
    if (merged.length > SAVED_VIEW_LIMITS.saved) throw new Error('The combined collection exceeds 64 named views.');
    this.publish({ saved: structuredClone(merged), error: null, notice: 'Named views loaded. Restore a view to verify its original genome and annotations.' });
  };
  private fail(cause: unknown): void {
    this.publish({ error: cause instanceof Error ? cause.message : 'Saved-view operation failed.', notice: null });
  }
  cancel = (notice = 'View restoration cancelled.'): void => {
    const op = this.operation;
    if (!op) return;
    this.operation = null; op.controller.abort();
    this.publish({ busy: false, notice, error: null });
    this.queueCapture();
  };
  moveHistory = async (delta: -1 | 1): Promise<boolean> => {
    if (this.operation) this.cancel();
    this.flush();
    const index = this.state.historyIndex + delta, entry = this.state.history[index];
    if (!entry) { this.fail(new Error(delta < 0 ? 'No earlier explorer view is available.' : 'No later explorer view is available.')); return false; }
    return this.restore(entry, index);
  };
  restoreHistory = async (entry: SavedView): Promise<boolean> => {
    if (this.operation) this.cancel();
    this.flush();
    // A scroll burst or a new branch may have replaced the displayed row.
    // Resolve the selected entry after capture so its old index cannot point elsewhere.
    const index = this.state.history.indexOf(entry);
    if (index < 0) {
      this.fail(new Error('This history position is no longer available. Choose another position.'));
      return false;
    }
    return this.restore(entry, index);
  };
  restoreNamed = async (name: string): Promise<boolean> => {
    const entry = this.state.saved.find(view => view.name === name);
    if (!entry) { this.fail(new Error('Choose an existing saved view.')); return false; }
    return this.restore({ source: entry.source, view: entry.view });
  };
  /** Only a complete public catalog view may leave this tab through live sync. */
  currentCatalogView = (): SavedView | null => {
    if (this.operation || this.active?.source.kind !== 'catalog') return null;
    return this.capture();
  };
  followCatalogView = async (entry: SavedView, signal: AbortSignal): Promise<boolean> => {
    const current = this.currentCatalogView();
    if (!current || signal.aborted || entry?.source?.kind !== 'catalog') return false;
    try { validateNamedSavedView({ ...entry, name: 'Shared catalog view' }); } catch { return false; }
    if (!commandValuesEqual(current.source, entry.source)) return this.restore(entry, undefined, signal);
    // Scrolling an already verified source should never re-read its entire sequence.
    if (entry.view.geneId !== null && !this.active?.selection.phage.genes.some(gene => gene.id === entry.view.geneId)) return false;
    if (!commandValuesEqual(current.view, entry.view)) {
      usePhageStore.setState({ viewMode: entry.view.viewMode, readingFrame: entry.view.readingFrame,
        scrollPosition: entry.view.scrollPosition, selectedGeneId: entry.view.geneId });
    }
    return true;
  };
  private async restore(value: SavedView, historyIndex?: number, signal?: AbortSignal): Promise<boolean> {
    this.cancel(); this.flush();
    const entry = structuredClone(value), origin = usePhageStore.getState(), snapshot = this.selection.getSnapshot();
    let op: Restore | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { if (op && this.operation === op) this.cancel('Stopped following the other tab.'); };
    try {
      validateNamedSavedView({ name: 'Restore', ...entry });
      if (!snapshot.repository) throw new Error('Load the catalog or a local genome workspace first.');
      const matches = origin.phages.map((phage, index) => ({ phage, index })).filter(({ phage }) => entry.source.kind === 'local'
        ? phage.localGenome?.contentId === entry.source.contentId
        : !phage.localGenome && phage.accession === entry.source.accession && phage.slug === entry.source.slug);
      if (matches.length !== 1) throw new Error(entry.source.kind === 'local'
        ? 'This view requires the exact original local genome. Reimport its file or local workspace bundle first.'
        : 'This view requires one matching catalog genome. Reload the original catalog before restoring.');
      op = { controller: new AbortController(), repository: snapshot.repository, phages: origin.phages, origin,
        originSelection: snapshot.selection, index: matches[0].index, accepted: null, source: null, entry, timedOut: false };
      this.operation = op;
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return false; }
      this.publish({ busy: true, error: null, notice: 'Verifying the complete genome and saved annotations…' });
      const owner = op;
      timer = setTimeout(() => { owner.timedOut = true; owner.controller.abort(); }, this.timeoutMs);
      const accepted = await this.selection.select(op.index, matches[0].phage.id, {
        background: !!signal,
        signal: op.controller.signal,
        verify: async candidate => {
          const source = await this.sourceFor(candidate);
          if (this.operation !== owner || owner.controller.signal.aborted) throw aborted();
          if (!commandValuesEqual(source, entry.source)) throw new Error('The saved genome bases or annotations have changed. The current selection was preserved.');
          if (entry.view.geneId !== null && !candidate.phage.genes.some(gene => gene.id === entry.view.geneId)) throw new Error('The saved gene is absent from the exact source.');
          owner.accepted = candidate; owner.source = source;
          return { viewMode: entry.view.viewMode, readingFrame: entry.view.readingFrame,
            scrollPosition: entry.view.scrollPosition, selectedGeneId: entry.view.geneId };
        },
      });
      if (this.operation !== op) return false;
      if (!accepted || !op.accepted || !op.source) throw new Error(op.timedOut ? 'View restoration timed out. Retry when the genome is available.'
        : this.selection.getSnapshot().error?.message ?? 'The genome selection changed before restoration finished.');
      this.active = { repository: op.repository, phages: op.phages, selection: op.accepted, source: op.source };
      this.operation = null; this.scrollBurst = false;
      if (historyIndex === undefined) this.append(entry, false);
      else this.publish({ historyIndex });
      this.publish({ ready: true, busy: false, error: null, notice: 'Restored the verified genome, position, frame and selected gene.' });
      return true;
    } catch (cause) {
      if (!op || this.operation === op) {
        if (op) { this.operation = null; op.controller.abort(); }
        this.publish({ busy: false });
        this.fail(op?.timedOut ? new Error('View restoration timed out. Retry when the genome is available.') : cause);
        this.queueCapture();
      }
      return false;
    } finally { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
}
