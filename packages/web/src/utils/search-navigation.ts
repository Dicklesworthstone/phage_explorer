import type { ReadingFrame, ViewMode } from '@phage-explorer/core';

/** The browser AA grid is ordered left-to-right along the forward genome in all six frames. */
export function searchNavigationTarget(position: number, length: number, viewMode: ViewMode, frame: ReadingFrame) {
  if (viewMode !== 'aa') return { viewMode, position };
  const offset = frame < 0 ? -frame - 1 : frame;
  const translatedLength = Math.max(0, length - offset);
  const residues = Math.floor(translatedLength / 3);
  const firstBase = frame < 0 ? translatedLength % 3 : offset;
  const residue = Math.floor((position - firstBase) / 3);
  // A hit in an untranslated end has no cell in this frame. Open its exact DNA position.
  if (residue < 0 || residue >= residues) return { viewMode: 'dna' as const, position };
  return { viewMode, position: residue };
}
