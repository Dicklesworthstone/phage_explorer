/**
 * Loads the diff reference genome whenever diff mode is on.
 *
 * `toggleDiff` sets `diffReferencePhageId` but not the sequence itself --
 * fetching a whole genome is I/O and belongs to the app, not the store. The
 * TUI has always done this load; the web app never did, so
 * `diffReferenceSequence` stayed null in the browser forever.
 *
 * Two user-visible consequences of that gap:
 *
 *   - The selection-pressure overlay (a real, gene-aware dN/dS estimator with
 *     reverse-frame handling) could never run. It rendered "Enable Diff mode to
 *     compare against a reference sequence" even with diff mode already on.
 *   - Diff rendering in the sequence grid had no reference to diff against.
 *
 * Mounted once at app level rather than per-overlay, so every consumer of
 * `diffReferenceSequence` sees the same loaded reference.
 */

import { useEffect } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { PhageRepository } from '@phage-explorer/db-runtime';

export function useDiffReferenceSequence(repository: PhageRepository | null): void {
  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const diffReferencePhageId = usePhageStore(s => s.diffReferencePhageId);
  const diffReferenceSequence = usePhageStore(s => s.diffReferenceSequence);
  const setDiffReference = usePhageStore(s => s.setDiffReference);

  useEffect(() => {
    if (!repository || !diffEnabled || diffReferencePhageId === null) return;

    // Already loaded for this reference; nothing to do. Without this guard the
    // effect would re-fetch on every render, since writing the sequence back to
    // the store is itself a dependency change.
    if (diffReferenceSequence !== null) return;

    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const length = await repository.getFullGenomeLength(diffReferencePhageId);
        const sequence = await repository.getSequenceWindow(diffReferencePhageId, 0, length);
        if (!cancelled) setDiffReference(diffReferencePhageId, sequence);
      } catch {
        // Leave the sequence null. Consumers already render an empty state for
        // that, which is honest: no reference means no comparison.
        if (!cancelled) setDiffReference(diffReferencePhageId, null);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    repository,
    diffEnabled,
    diffReferencePhageId,
    diffReferenceSequence,
    setDiffReference,
  ]);
}
