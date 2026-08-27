import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { usePhageStore, useSelectedGeneStore } from '../store';
import { useOverlay } from './overlays/OverlayProvider';
import {
  buildShareUrl,
  findGeneId,
  getGeneShareKey,
  getInitialShareState,
  normalizeShareableOverlayId,
  parseShareState,
  type ShareableOverlayId,
} from '../utils/share-state';

let pendingInitialRestore = true;

function normalizePhageKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

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

export function ShareStateController(): ReactElement | null {
  const currentPhage = usePhageStore((state) => state.currentPhage);
  const viewMode = usePhageStore((state) => state.viewMode);
  const readingFrame = usePhageStore((state) => state.readingFrame);
  const scrollPosition = usePhageStore((state) => state.scrollPosition);
  const show3DModel = usePhageStore((state) => state.show3DModel);
  const selectedGeneId = useSelectedGeneStore((state) => state.selectedGeneId);
  const setSelectedGeneId = useSelectedGeneStore((state) => state.setSelectedGeneId);
  const { stack, open } = useOverlay();
  const [restoreComplete, setRestoreComplete] = useState(false);
  const lastHistoryPhageKeyRef = useRef<string | null>(null);
  const lastSelectedGenePhageIdRef = useRef<number | null>(null);

  const selectedGene = useMemo(() => {
    if (!currentPhage || selectedGeneId === null) return null;
    return currentPhage.genes.find((gene) => gene.id === selectedGeneId) ?? null;
  }, [currentPhage, selectedGeneId]);

  useEffect(() => {
    if (!currentPhage) return;

    const previousPhageId = lastSelectedGenePhageIdRef.current;
    const phageChanged = previousPhageId !== null && previousPhageId !== currentPhage.id;
    lastSelectedGenePhageIdRef.current = currentPhage.id;

    if (pendingInitialRestore) {
      pendingInitialRestore = false;
      const initial = getInitialShareState();
      const linkedGeneId = findGeneId(currentPhage.genes, initial.geneKey);

      usePhageStore.setState((state) => {
        const effectiveViewMode = initial.viewMode ?? state.viewMode;
        const genomeLength = Math.max(0, currentPhage.genomeLength ?? 0);
        const coordinateLength = effectiveViewMode === 'aa'
          ? Math.floor(genomeLength / 3)
          : genomeLength;
        const maxPosition = Math.max(0, coordinateLength - 1);
        const requestedPosition = initial.position ?? state.scrollPosition;

        return {
          viewMode: effectiveViewMode,
          readingFrame: initial.readingFrame ?? state.readingFrame,
          scrollPosition: Math.min(Math.max(0, requestedPosition), maxPosition),
          show3DModel: initial.show3DModel ?? state.show3DModel,
        };
      });
      setSelectedGeneId(linkedGeneId);

      if (initial.tool) {
        open(initial.tool);
      }
    } else if (phageChanged) {
      setSelectedGeneId(null);
    }

    setRestoreComplete(true);
  }, [currentPhage, open, setSelectedGeneId]);

  useEffect(() => {
    if (!currentPhage || typeof document === 'undefined') return;
    const geneLabel = selectedGene?.locusTag?.trim() || selectedGene?.name?.trim();
    document.title = geneLabel
      ? `${geneLabel} — ${currentPhage.name} — Phage Explorer`
      : `${currentPhage.name} — Phage Explorer`;
  }, [currentPhage, selectedGene]);

  useEffect(() => {
    if (!restoreComplete || !currentPhage || typeof window === 'undefined') return;

    const timer = window.setTimeout(() => {
      const phageKey = currentPhage.slug?.trim() || currentPhage.accession.trim();
      const geneKey = getGeneShareKey(selectedGene);
      let tool: ShareableOverlayId | null = null;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        tool = normalizeShareableOverlayId(stack[index]);
        if (tool) break;
      }

      const nextUrl = buildShareUrl(window.location.href, {
        phageKey,
        geneKey,
        viewMode,
        position: scrollPosition,
        readingFrame,
        show3DModel,
        tool,
      });
      const previousPhageKey = lastHistoryPhageKeyRef.current;
      const phageChanged = previousPhageKey !== null && previousPhageKey !== phageKey;
      lastHistoryPhageKeyRef.current = phageKey;

      if (nextUrl === window.location.href) return;
      try {
        if (phageChanged) {
          window.history.pushState(window.history.state, '', nextUrl);
        } else {
          window.history.replaceState(window.history.state, '', nextUrl);
        }
      } catch {
        // Sharing still constructs a fresh URL at interaction time if history mutation is blocked.
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [
    currentPhage,
    readingFrame,
    restoreComplete,
    scrollPosition,
    selectedGene,
    show3DModel,
    stack,
    viewMode,
  ]);

  useEffect(() => {
    if (!currentPhage || typeof window === 'undefined') return;
    let reloadScheduled = false;

    const handlePopState = () => {
      const linkedPhageKey = normalizePhageKey(parseShareState(window.location.href).phageKey);
      const currentKeys = [
        currentPhage.slug,
        currentPhage.accession,
        String(currentPhage.id),
        currentPhage.name,
      ].map(normalizePhageKey);

      if (linkedPhageKey && !currentKeys.includes(linkedPhageKey) && !reloadScheduled) {
        reloadScheduled = true;
        window.setTimeout(() => window.location.reload(), 0);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [currentPhage]);

  return null;
}

export default ShareStateController;
