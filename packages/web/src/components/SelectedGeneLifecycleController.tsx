import { usePhageStore } from '@phage-explorer/state';
import type { PhageSelectionSnapshot, SelectionView } from '../hooks/PhageSelectionSession';

/** A genome switch must scope its gene and coordinates to the newly accepted source.
 * Apply the whole selection in one publication, before any renderer or history subscriber sees it.
 */
export function commitExplorerSelection(
  next: PhageSelectionSnapshot,
  previous: PhageSelectionSnapshot,
  view?: SelectionView,
): void {
  usePhageStore.setState({
    currentPhage: next.selection?.phage ?? null,
    currentPhageIndex: next.selection?.index ?? 0,
    isLoadingPhage: next.pendingIndex !== null,
    error: next.error?.message ?? null,
    ...(next.selection !== previous.selection ? view ?? { scrollPosition: 0, selectedGeneId: null } : {}),
  });
}
