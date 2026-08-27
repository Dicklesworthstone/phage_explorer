import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { usePhageStore, useSelectedGeneStore } from '../store';

export function shouldClearSelectedGene(
  previousPhageId: number | null,
  currentPhageId: number | null
): boolean {
  return (
    previousPhageId !== null &&
    currentPhageId !== null &&
    previousPhageId !== currentPhageId
  );
}

/**
 * Keeps a gene selection scoped to the phage that owns it.
 *
 * Gene IDs are database-local integers and can collide across phages. Without
 * this guard, switching phages can make an unrelated gene with the same ID look
 * selected until another interaction repairs the state.
 */
export function SelectedGeneLifecycleController(): ReactElement | null {
  const currentPhageId = usePhageStore((state) => state.currentPhage?.id ?? null);
  const clearSelectedGene = useSelectedGeneStore((state) => state.clearSelectedGene);
  const previousPhageIdRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (currentPhageId === null) return;

    const previousPhageId = previousPhageIdRef.current;
    previousPhageIdRef.current = currentPhageId;

    if (shouldClearSelectedGene(previousPhageId, currentPhageId)) {
      clearSelectedGene();
    }
  }, [clearSelectedGene, currentPhageId]);

  return null;
}

export default SelectedGeneLifecycleController;
