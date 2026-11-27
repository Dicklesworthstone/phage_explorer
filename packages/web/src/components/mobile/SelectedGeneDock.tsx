import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { GeneInfo, PhageFull, ViewMode, SelectedCdsSource } from '@phage-explorer/core';
import { SelectedCdsInspector } from '../SelectedCdsInspector';
import { usePhageStore, useSelectedGeneStore } from '../../store';
import { copyToClipboard } from '../../utils/export';
import { formatGeneStrand } from '../../utils/gene-strand';
import { haptics } from '../../utils/haptics';
import {
  buildShareUrl,
  getGeneShareKey,
  getShareableTool,
  type ShareUrlState,
} from '../../utils/share-state';
import {
  buildNcbiNucleotideUrl,
  buildPhageCitation,
  buildRcsbPdbUrl,
} from '../../utils/research-record';
import { useOverlay } from '../overlays/OverlayProvider';
import { BottomSheet } from './BottomSheet';

export type GeneNavigationDirection = 'previous' | 'next';

type FeedbackState = 'id-copied' | 'link-copied' | 'citation-copied' | null;

function getOrderedGeneBounds(gene: Pick<GeneInfo, 'startPos' | 'endPos'>): {
  start: number;
  end: number;
} {
  return {
    start: Math.min(gene.startPos, gene.endPos),
    end: Math.max(gene.startPos, gene.endPos),
  };
}

export function sortGenesForNavigation(genes: readonly GeneInfo[]): GeneInfo[] {
  return genes.slice().sort((left, right) => {
    const leftBounds = getOrderedGeneBounds(left);
    const rightBounds = getOrderedGeneBounds(right);
    return (
      leftBounds.start - rightBounds.start ||
      leftBounds.end - rightBounds.end ||
      left.id - right.id
    );
  });
}

export function getAdjacentGene(
  genes: readonly GeneInfo[],
  selectedGeneId: number,
  direction: GeneNavigationDirection
): GeneInfo | null {
  const sorted = sortGenesForNavigation(genes);
  const selectedIndex = sorted.findIndex((gene) => gene.id === selectedGeneId);
  if (selectedIndex < 0) return null;

  const adjacentIndex = direction === 'previous'
    ? selectedIndex - 1
    : selectedIndex + 1;
  return sorted[adjacentIndex] ?? null;
}

export function getGeneFocusPosition(gene: GeneInfo, viewMode: ViewMode): number {
  const nucleotidePosition = Math.max(0, Math.floor(getOrderedGeneBounds(gene).start));
  return viewMode === 'aa'
    ? Math.floor(nucleotidePosition / 3)
    : nucleotidePosition;
}

export function getGeneDisplayLabel(gene: GeneInfo): string {
  return (
    gene.locusTag?.trim() ||
    gene.name?.trim() ||
    gene.product?.trim() ||
    `Gene ${gene.id}`
  );
}

function GeneIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M4 17h16" />
      <path d="m7 7 3 5-3 5" />
      <path d="m17 7-3 5 3 5" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }): ReactElement {
  const points = direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6';
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function FocusIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
    </svg>
  );
}

function CloseIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ShareIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 10.5 6.8-4" />
      <path d="m8.6 13.5 6.8 4" />
    </svg>
  );
}

function CopyIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

function BookIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </svg>
  );
}

function ExternalLinkIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function getSelectedGenePublicLinks(baseUrl: string, phage: PhageFull, gene: GeneInfo,
  view: Omit<ShareUrlState, 'phageKey' | 'geneKey'>): { shareUrl: string; ncbiUrl: string; citation: string } | null {
  if (phage.localGenome) return null;
  const shareUrl = buildShareUrl(baseUrl, { ...view,
    phageKey: phage.slug?.trim() || phage.accession, geneKey: getGeneShareKey(gene) });
  return { shareUrl, ncbiUrl: buildNcbiNucleotideUrl(phage.accession), citation: buildPhageCitation({
    name: `${getGeneDisplayLabel(gene)} in ${phage.name}`, accession: phage.accession,
    pdbIds: phage.pdbIds, explorerUrl: shareUrl,
  }) };
}

export function SelectedGeneDock({ source }: { source: SelectedCdsSource | null }): ReactElement | null {
  const currentPhage = usePhageStore((state) => state.currentPhage);
  const viewMode = usePhageStore((state) => state.viewMode);
  const readingFrame = usePhageStore((state) => state.readingFrame);
  const scrollPosition = usePhageStore((state) => state.scrollPosition);
  const show3DModel = usePhageStore((state) => state.show3DModel);
  const setScrollPosition = usePhageStore((state) => state.setScrollPosition);
  const selectedGeneId = useSelectedGeneStore((state) => state.selectedGeneId);
  const setSelectedGeneId = useSelectedGeneStore((state) => state.setSelectedGeneId);
  const clearSelectedGene = useSelectedGeneStore((state) => state.clearSelectedGene);
  const { stack, open } = useOverlay();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const genes = useMemo(
    () => sortGenesForNavigation(currentPhage?.genes ?? []),
    [currentPhage]
  );
  const selectedGene = useMemo(() => {
    if (selectedGeneId === null) return null;
    return genes.find((gene) => gene.id === selectedGeneId) ?? null;
  }, [genes, selectedGeneId]);
  const selectedIndex = useMemo(
    () => selectedGene ? genes.findIndex((gene) => gene.id === selectedGene.id) : -1,
    [genes, selectedGene]
  );
  const previousGene = selectedGene
    ? getAdjacentGene(genes, selectedGene.id, 'previous')
    : null;
  const nextGene = selectedGene
    ? getAdjacentGene(genes, selectedGene.id, 'next')
    : null;
  const geneLabel = selectedGene ? getGeneDisplayLabel(selectedGene) : '';
  const geneId = selectedGene ? getGeneShareKey(selectedGene) : null;

  const publicLinks = useMemo(() => {
    if (!currentPhage || !selectedGene) return null;
    const baseUrl = typeof window === 'undefined'
      ? 'https://phage-explorer.org/'
      : window.location.href;
    return getSelectedGenePublicLinks(baseUrl, currentPhage, selectedGene, {
      viewMode,
      position: scrollPosition,
      readingFrame,
      show3DModel,
      tool: getShareableTool(stack),
    });
  }, [currentPhage, readingFrame, scrollPosition, selectedGene, show3DModel, stack, viewMode]);
  const shareUrl = publicLinks?.shareUrl;

  const showFeedback = useCallback((nextFeedback: Exclude<FeedbackState, null>) => {
    setFeedback(nextFeedback);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedGene) {
      setIsSheetOpen(false);
      if (selectedGeneId !== null) clearSelectedGene();
      return;
    }

    if (typeof document === 'undefined') return;
    document.documentElement.classList.add('has-selected-gene-dock');
    return () => document.documentElement.classList.remove('has-selected-gene-dock');
  }, [clearSelectedGene, selectedGene, selectedGeneId]);

  const focusGene = useCallback((gene: GeneInfo) => {
    setSelectedGeneId(gene.id);
    setScrollPosition(getGeneFocusPosition(gene, viewMode));
    haptics.selection();
  }, [setScrollPosition, setSelectedGeneId, viewMode]);

  const navigateGene = useCallback((direction: GeneNavigationDirection) => {
    if (!selectedGene) return;
    const adjacent = direction === 'previous' ? previousGene : nextGene;
    if (adjacent) focusGene(adjacent);
  }, [focusGene, nextGene, previousGene, selectedGene]);

  const handleClear = useCallback(() => {
    haptics.light();
    setIsSheetOpen(false);
    clearSelectedGene();
  }, [clearSelectedGene]);

  const handleCopyId = useCallback(async () => {
    if (!geneId) return;
    try {
      await copyToClipboard(geneId);
      haptics.success();
      showFeedback('id-copied');
    } catch {
      haptics.error();
    }
  }, [geneId, showFeedback]);

  const handleShare = useCallback(async () => {
    if (!currentPhage || !selectedGene || !shareUrl) return;
    const shareData = {
      title: `${geneLabel} — ${currentPhage.name} — Phage Explorer`,
      text: `Explore ${geneLabel} in ${currentPhage.name} (${currentPhage.accession}) at this exact genome position and view.`,
      url: shareUrl,
    };

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(shareData);
        haptics.success();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Fall through to copying the exact URL.
      }
    }

    try {
      await copyToClipboard(shareUrl);
      haptics.success();
      showFeedback('link-copied');
    } catch {
      haptics.error();
    }
  }, [currentPhage, geneLabel, selectedGene, shareUrl, showFeedback]);

  const handleCopyCitation = useCallback(async () => {
    if (!publicLinks) return;

    try {
      await copyToClipboard(publicLinks.citation);
      haptics.success();
      showFeedback('citation-copied');
    } catch {
      haptics.error();
    }
  }, [publicLinks, showFeedback]);

  const handleOpenAnalysis = useCallback((
    overlayId: 'proteinDomains' | 'foldQuickview' | 'selectionPressure' | 'rnaStructure'
  ) => {
    haptics.selection();
    setIsSheetOpen(false);
    open(overlayId);
  }, [open]);

  if (!currentPhage || !selectedGene) return null;

  const bounds = getOrderedGeneBounds(selectedGene);
  const coordinates = `${bounds.start.toLocaleString()}–${bounds.end.toLocaleString()}`;
  const strand = formatGeneStrand(selectedGene.strand);
  const pdbIds = Array.from(
    new Set(
      (currentPhage.pdbIds ?? [])
        .map((pdbId) => pdbId.trim().toUpperCase())
        .filter(Boolean)
    )
  );

  return (
    <>
      <aside
        className={`selected-gene-dock ${isSheetOpen ? 'selected-gene-dock--sheet-open' : ''}`}
        aria-label={`Selected gene: ${geneLabel}`}
        data-testid="selected-gene-dock"
      >
        <button
          type="button"
          className="selected-gene-dock__main"
          onClick={() => {
            haptics.light();
            setIsSheetOpen(true);
          }}
          aria-haspopup="dialog"
          aria-expanded={isSheetOpen}
          aria-label={`Open details for ${geneLabel}`}
        >
          <span className="selected-gene-dock__icon"><GeneIcon /></span>
          <span className="selected-gene-dock__copy">
            <span className="selected-gene-dock__eyebrow">
              Gene {selectedIndex + 1} of {genes.length}
            </span>
            <strong className="selected-gene-dock__label">{geneLabel}</strong>
            <span className="selected-gene-dock__product">
              {selectedGene.product?.trim() || selectedGene.name?.trim() || `${coordinates} · ${strand}`}
            </span>
          </span>
          <span className="selected-gene-dock__details">Details</span>
        </button>
        <button
          type="button"
          className="selected-gene-dock__clear"
          onClick={handleClear}
          aria-label={`Clear selected gene ${geneLabel}`}
          data-clear-selected-gene
        >
          <CloseIcon />
        </button>
      </aside>

      <BottomSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        title="Selected gene"
        initialSnapPoint="full"
        minHeight={50}
        maxHeight={92}
      >
        <article className="selected-gene-inspector" data-testid="selected-gene-inspector">
          <header className="selected-gene-inspector__hero">
            <div className="selected-gene-inspector__hero-icon"><GeneIcon /></div>
            <div className="selected-gene-inspector__hero-copy">
              <span className="selected-gene-inspector__context">{currentPhage.name}</span>
              <h3>{geneLabel}</h3>
              {selectedGene.product?.trim() && <p>{selectedGene.product.trim()}</p>}
            </div>
            <span className="selected-gene-inspector__position">
              {selectedIndex + 1}/{genes.length}
            </span>
          </header>

          <div className="selected-gene-inspector__nav" aria-label="Gene navigation">
            <button
              type="button"
              onClick={() => navigateGene('previous')}
              disabled={!previousGene}
              aria-label={previousGene ? `Previous gene: ${getGeneDisplayLabel(previousGene)}` : 'No previous gene'}
            >
              <ChevronIcon direction="left" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              className="selected-gene-inspector__focus"
              onClick={() => focusGene(selectedGene)}
            >
              <FocusIcon />
              <span>Focus sequence</span>
            </button>
            <button
              type="button"
              onClick={() => navigateGene('next')}
              disabled={!nextGene}
              aria-label={nextGene ? `Next gene: ${getGeneDisplayLabel(nextGene)}` : 'No next gene'}
            >
              <span>Next</span>
              <ChevronIcon direction="right" />
            </button>
          </div>

          <section className="selected-gene-inspector__section" aria-labelledby="selected-gene-details-heading">
            <h4 id="selected-gene-details-heading">Annotation</h4>
            <dl className="selected-gene-inspector__facts">
              <div><dt>Locus tag</dt><dd>{selectedGene.locusTag?.trim() || 'Not provided'}</dd></div>
              <div><dt>Gene name</dt><dd>{selectedGene.name?.trim() || 'Not provided'}</dd></div>
              <div><dt>Feature type</dt><dd>{selectedGene.type?.trim() || 'Not provided'}</dd></div>
              <div><dt>Feature span (0-based, end exclusive)</dt><dd>{coordinates}</dd></div>
              <div><dt>Strand</dt><dd>{strand}</dd></div>
              <div><dt>Database ID</dt><dd>{selectedGene.id}</dd></div>
            </dl>
          </section>

          {isSheetOpen && <SelectedCdsInspector source={source?.phage === currentPhage ? source : null} gene={selectedGene} />}

          <section className="selected-gene-inspector__section" aria-labelledby="selected-gene-actions-heading">
            <h4 id="selected-gene-actions-heading">Use this record</h4>
            <div className="selected-gene-inspector__action-grid">
              <button type="button" onClick={() => {
                if (currentPhage.localGenome) { setIsSheetOpen(false); open('genomeImport'); }
                else void handleShare();
              }}>
                <ShareIcon />
                <span>{currentPhage.localGenome ? 'Export local genome bundle' : feedback === 'link-copied' ? 'Link copied' : 'Share exact view'}</span>
              </button>
              {publicLinks && <button type="button" onClick={() => void handleCopyCitation()}>
                <BookIcon />
                <span>{feedback === 'citation-copied' ? 'Citation copied' : 'Copy citation'}</span>
              </button>}
              <button type="button" onClick={() => void handleCopyId()}>
                <CopyIcon />
                <span>{feedback === 'id-copied' ? 'ID copied' : 'Copy gene ID'}</span>
              </button>
              {publicLinks && <a href={publicLinks.ncbiUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon />
                <span>NCBI record</span>
              </a>}
            </div>
            {currentPhage.localGenome && <p className="selected-gene-inspector__section-intro">This gene belongs to a private local genome. Export a genome bundle to preserve the original sequence and annotations.</p>}
            <div className="selected-gene-inspector__feedback" role="status" aria-live="polite">
              {feedback === 'id-copied' && `Copied ${geneId}`}
              {publicLinks && feedback === 'link-copied' && 'Copied an exact, restorable gene link'}
              {publicLinks && feedback === 'citation-copied' && 'Copied a reproducible citation'}
            </div>
          </section>

          <section className="selected-gene-inspector__section" aria-labelledby="selected-gene-analysis-heading">
            <h4 id="selected-gene-analysis-heading">Analyze</h4>
            <p className="selected-gene-inspector__section-intro">
              Open a focused analysis with this gene kept selected in the explorer.
            </p>
            <div className="selected-gene-inspector__analysis-grid">
              <button type="button" onClick={() => handleOpenAnalysis('proteinDomains')}>
                <strong>Protein domains</strong><span>InterPro and Pfam architecture</span>
              </button>
              <button type="button" onClick={() => handleOpenAnalysis('foldQuickview')}>
                <strong>Fold quickview</strong><span>Structural fold evidence</span>
              </button>
              <button type="button" onClick={() => handleOpenAnalysis('selectionPressure')}>
                <strong>Selection pressure</strong><span>Evolutionary constraint signals</span>
              </button>
              <button type="button" onClick={() => handleOpenAnalysis('rnaStructure')}>
                <strong>RNA structure</strong><span>Local secondary-structure view</span>
              </button>
            </div>
          </section>

          {pdbIds.length > 0 && (
            <section className="selected-gene-inspector__section" aria-labelledby="selected-gene-structures-heading">
              <h4 id="selected-gene-structures-heading">Associated phage structures</h4>
              <p className="selected-gene-inspector__section-intro">
                All RCSB PDB records attached to this phage dataset. These records are phage-level associations and may represent proteins other than the selected gene.
              </p>
              <div className="selected-gene-inspector__pdb-list">
                {pdbIds.map((pdbId) => (
                  <a key={pdbId} href={buildRcsbPdbUrl(pdbId)} target="_blank" rel="noopener noreferrer">
                    <span><strong>{pdbId}</strong><small>RCSB Protein Data Bank</small></span>
                    <ExternalLinkIcon />
                  </a>
                ))}
              </div>
            </section>
          )}

          <button
            type="button"
            className="selected-gene-inspector__clear"
            onClick={handleClear}
            data-clear-selected-gene
          >
            Clear gene selection
          </button>
        </article>
      </BottomSheet>
    </>
  );
}

export default SelectedGeneDock;
