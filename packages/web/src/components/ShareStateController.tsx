import React, { useEffect, useState } from 'react';
import { usePhageStore } from '../store';
import { useOverlay } from './overlays/OverlayProvider';
import {
  buildShareUrl,
  getInitialShareState,
  normalizeShareableOverlayId,
} from '../utils/share-state';

let pendingInitialRestore = true;

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

export function ShareStateController(): React.ReactElement | null {
  const currentPhage = usePhageStore((state) => state.currentPhage);
  const viewMode = usePhageStore((state) => state.viewMode);
  const readingFrame = usePhageStore((state) => state.readingFrame);
  const scrollPosition = usePhageStore((state) => state.scrollPosition);
  const show3DModel = usePhageStore((state) => state.show3DModel);
  const { topOverlay, open } = useOverlay();
  const [restoreComplete, setRestoreComplete] = useState(false);

  useEffect(() => {
    if (!currentPhage) return;

    if (pendingInitialRestore) {
      pendingInitialRestore = false;
      const initial = getInitialShareState();

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

      if (initial.tool) {
        open(initial.tool);
      }
    }

    setRestoreComplete(true);
  }, [currentPhage, open]);

  useEffect(() => {
    if (!restoreComplete || !currentPhage || typeof window === 'undefined') return;

    const timer = window.setTimeout(() => {
      const phageKey = currentPhage.slug?.trim() || currentPhage.accession.trim();
      const tool = normalizeShareableOverlayId(topOverlay);
      const nextUrl = buildShareUrl(window.location.href, {
        phageKey,
        viewMode,
        position: scrollPosition,
        readingFrame,
        show3DModel,
        tool,
      });

      if (nextUrl === window.location.href) return;
      try {
        window.history.replaceState(window.history.state, '', nextUrl);
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
    show3DModel,
    topOverlay,
    viewMode,
  ]);

  return null;
}

export default ShareStateController;
