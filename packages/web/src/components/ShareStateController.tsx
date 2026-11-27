import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import { usePhageStore } from '../store';
import type { PhageSelectionSession, PhageSelectionSnapshot } from '../hooks/PhageSelectionSession';
import { useOverlay } from './overlays/OverlayProvider';
import { useToast } from './ui/Toast';
import {
  ExplorerBrowserHistory,
  HistorySelectionAttempt,
  findGeneId,
  findPhageIndex,
  getGeneShareKey,
  getInitialShareState,
  getShareableTool,
  isShareableOverlayId,
  type ParsedShareState,
} from '../utils/share-state';

export function applyInitialShareState(): void {
  if (typeof window === 'undefined') return;
  const initial = getInitialShareState();
  usePhageStore.setState((state) => ({
    viewMode: initial.viewMode ?? state.viewMode,
    readingFrame: initial.readingFrame ?? state.readingFrame,
    scrollPosition: initial.position ?? state.scrollPosition,
    show3DModel: initial.show3DModel ?? state.show3DModel,
  }));
}

function applyView(phage: PhageFull, view: ParsedShareState): void {
  usePhageStore.setState(state => {
    const viewMode = view.viewMode ?? state.viewMode;
    const readingFrame = view.readingFrame ?? state.readingFrame;
    const frameOffset = readingFrame < 0 ? -readingFrame - 1 : readingFrame;
    const genomeLength = phage.genomeLength ?? 0;
    const length = viewMode === 'aa' ? Math.floor((genomeLength - frameOffset) / 3) : genomeLength;
    return {
      viewMode, readingFrame,
      scrollPosition: Math.max(0, Math.min(length - 1, view.position ?? state.scrollPosition)),
      show3DModel: view.show3DModel ?? state.show3DModel,
      selectedGeneId: findGeneId(phage.genes, view.geneKey),
    };
  });
}

interface Traversal {
  repository: PhageSelectionSnapshot['repository'];
  phageId: number;
  view: ParsedShareState;
  controller: AbortController;
  attempt: HistorySelectionAttempt;
}

export function ShareStateController({ selection }: { selection: PhageSelectionSession }): ReactElement | null {
  const currentPhage = usePhageStore(s => s.currentPhage);
  const viewMode = usePhageStore(s => s.viewMode);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const scrollPosition = usePhageStore(s => s.scrollPosition);
  const show3DModel = usePhageStore(s => s.show3DModel);
  const selectedGeneId = usePhageStore(s => s.selectedGeneId);
  const { stack, open, close } = useOverlay();
  const { toast } = useToast();
  const [history] = useState(() => new ExplorerBrowserHistory());
  const [initialized, setInitialized] = useState(false);
  const [traversal, setTraversal] = useState<Traversal | null>(null);
  const operation = useRef<Traversal | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const selectedGene = currentPhage?.genes.find(gene => gene.id === selectedGeneId);
  const tool = getShareableTool(stack);

  useEffect(() => {
    if (!currentPhage || initialized || traversal) return;
    const initial = getInitialShareState();
    if (!currentPhage.localGenome && (!initial.phageKey || findPhageIndex([currentPhage], initial.phageKey) === 0)) {
      applyView(currentPhage, initial);
      if (initial.tool) open(initial.tool);
    }
    setInitialized(true);
  }, [currentPhage, initialized, traversal, open]);

  useEffect(() => {
    const gene = selectedGene?.locusTag?.trim() || selectedGene?.name?.trim();
    document.title = !currentPhage ? 'Phage Explorer'
      : currentPhage.localGenome ? 'Local genome — Phage Explorer'
      : [gene, currentPhage.name, 'Phage Explorer'].filter(Boolean).join(' — ');
  }, [currentPhage, selectedGene]);

  useEffect(() => {
    const changed = selection.subscribe(() => {
      const active = operation.current;
      if (!active) return;
      const next = selection.getSnapshot();
      if (next.repository !== active.repository
        || !active.attempt.observe(next.pendingIndex, next.selection?.index ?? null, next.error?.index ?? null)) {
        operation.current = null;
        active.controller.abort();
        setTraversal(null);
      }
    });
    const handlePopState = (event: PopStateEvent) => {
      window.clearTimeout(timer.current);
      const previous = operation.current;
      operation.current = null;
      previous?.controller.abort();
      // The app's Retry button owns its own signal. Retire that read on traversal too.
      if (previous?.attempt.retrying) selection.cancel();
      setTraversal(null);
      // Rewrite the traversed entry even when restoring fails without a store change.
      setHistoryRevision(revision => revision + 1);
      const target = history.read(window.location, event.state);
      const phages = usePhageStore.getState().phages;
      const index = !target ? -1 : target.source.kind === 'local'
        ? phages.findIndex(phage => phage.localGenome?.contentId === target.source.key)
        : phages.findIndex(phage => !phage.localGenome && findPhageIndex([phage], target.source.key) === 0);
      if (!target || index < 0 || !selection.getSnapshot().repository) {
        if (event.state?.phageExplorerPrivateView || target) {
          toast({ message: 'This history entry is unavailable in the current catalog or local workspace.', variant: 'warning' });
        }
        return;
      }
      const needsRead = selection.getSnapshot().selection?.index !== index;
      const request = { repository: selection.getSnapshot().repository,
        phageId: phages[index].id, view: target.view, controller: new AbortController(),
        attempt: new HistorySelectionAttempt(index, needsRead) };
      operation.current = request;
      setTraversal(request);
      if (!needsRead) {
        selection.cancel();
        return;
      }
      // The selection subscription observes success, failure, retry and supersession
      // synchronously, before React can render an older accepted selection.
      void selection.select(index, request.phageId, { signal: request.controller.signal });
    };
    window.addEventListener('popstate', handlePopState);
    return () => { changed(); window.removeEventListener('popstate', handlePopState); };
  }, [history, selection, toast]);

  useEffect(() => () => {
    const active = operation.current;
    operation.current = null;
    active?.controller.abort();
    if (active?.attempt.retrying) selection.cancel();
  }, [selection]);

  // Ordinary selection clears the previous gene. Apply the traversed view only
  // after its target is the current, fully loaded selection.
  useEffect(() => {
    if (!traversal || operation.current !== traversal || currentPhage?.id !== traversal.phageId
      || selection.getSnapshot().selection?.phage !== currentPhage || selection.getSnapshot().pendingIndex !== null) return;
    applyView(currentPhage, traversal.view);
    for (const item of stack) {
      if (item.id !== traversal.view.tool && isShareableOverlayId(item.id)) close(item.id);
    }
    if (traversal.view.tool && tool !== traversal.view.tool) open(traversal.view.tool);
    operation.current = null;
    setTraversal(null);
    setInitialized(true);
  }, [currentPhage, traversal, selection, stack, tool, open, close]);

  useEffect(() => {
    if (!initialized || !currentPhage || traversal || operation.current) return;
    const write = () => {
      if (operation.current || usePhageStore.getState().currentPhage !== currentPhage) return;
      try {
        history.write(window.location, window.history, currentPhage, {
          geneKey: getGeneShareKey(selectedGene), viewMode, position: scrollPosition, readingFrame, show3DModel, tool,
        });
      } catch {
        // Explicit sharing remains available if browser history writes are blocked.
      }
    };
    if (history.changedSource(currentPhage)) write();
    else timer.current = window.setTimeout(write, 300);
    return () => window.clearTimeout(timer.current);
  }, [history, historyRevision, initialized, currentPhage, traversal, readingFrame, scrollPosition, selectedGene, show3DModel, tool, viewMode]);

  return null;
}

export default ShareStateController;
