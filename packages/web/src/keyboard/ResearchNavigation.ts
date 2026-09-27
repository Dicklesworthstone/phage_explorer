/** Distinguish an owned asynchronous genome load from a later navigation intent. */
export interface ResearchNavigationState {
  currentPhageIndex: number;
  currentPhage: { localGenome?: { contentId: string } } | null;
  selectedGeneId: number | null;
  viewMode: string;
  readingFrame: number;
  scrollPosition: number;
}
export interface ResearchNavigationTarget {
  index: number;
  signal: AbortSignal;
  view: { contentId: string; geneId: number | null; viewMode: string; readingFrame: number; scrollPosition: number };
}

/** A genome loader resets the old gene/scroll asynchronously as its new data arrives.
 * Accept only those resets and changes toward this exact target. Different selection,
 * frame, mode, gene or position still interrupts, including during the pending load.
 * The caller excludes its own synchronous writes separately, not an entire await.
 */
export function interruptsResearchNavigation(next: ResearchNavigationState, previous: ResearchNavigationState,
  owner: ResearchNavigationTarget | null): boolean {
  const identityChanged = next.currentPhage?.localGenome?.contentId !== previous.currentPhage?.localGenome?.contentId;
  const changed = identityChanged || next.currentPhageIndex !== previous.currentPhageIndex ||
    next.selectedGeneId !== previous.selectedGeneId || next.viewMode !== previous.viewMode ||
    next.readingFrame !== previous.readingFrame || next.scrollPosition !== previous.scrollPosition;
  if (!changed) return false;
  if (!owner || owner.signal.aborted) return true;
  if (next.currentPhageIndex !== owner.index) return true;
  if (identityChanged && next.currentPhage?.localGenome?.contentId !== owner.view.contentId) return true;
  return next.viewMode !== previous.viewMode && next.viewMode !== owner.view.viewMode ||
    next.readingFrame !== previous.readingFrame && next.readingFrame !== owner.view.readingFrame ||
    next.selectedGeneId !== previous.selectedGeneId && next.selectedGeneId !== null && next.selectedGeneId !== owner.view.geneId ||
    next.scrollPosition !== previous.scrollPosition && next.scrollPosition !== 0 && next.scrollPosition !== owner.view.scrollPosition;
}
