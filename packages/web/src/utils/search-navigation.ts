import { aminoAcidIndexAtBase, type ReadingFrame, type ViewMode } from '@phage-explorer/core';

export function searchNavigationTarget(position: number, length: number, viewMode: ViewMode, frame: ReadingFrame) {
  if (viewMode !== 'aa') return { viewMode, position };
  const residue = aminoAcidIndexAtBase(position, length, frame);
  // A hit in an untranslated end has no cell in this frame. Open its exact DNA position.
  return residue === null ? { viewMode: 'dna' as const, position } : { viewMode, position: residue };
}
