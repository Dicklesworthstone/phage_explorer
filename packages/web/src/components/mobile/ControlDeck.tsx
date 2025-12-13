import React, { useEffect, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useOverlay } from '../overlays/OverlayProvider';
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconCube,
  IconDiff,
  IconLayers,
  IconRepeat,
  IconSearch,
  IconTarget,
} from '../ui';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function ControlDeck(): JSX.Element {
  const [activeTab, setActiveTab] = useState<'view' | 'nav' | 'tools'>('view');
  const isLandscape = useMediaQuery('(orientation: landscape)');
  const isPhoneWidth = useMediaQuery('(max-width: 640px)');
  const isLandscapePhone = isLandscape && isPhoneWidth;
  const deckIconSize = isLandscapePhone ? 18 : 20;
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (isLandscapePhone) setExpanded(false);
  }, [isLandscapePhone]);
  
  // Store Actions
  const toggleViewMode = usePhageStore(s => s.toggleViewMode);
  const viewMode = usePhageStore(s => s.viewMode);
  const readingFrame = usePhageStore(s => s.readingFrame);
  const setReadingFrame = usePhageStore(s => s.setReadingFrame);
  const diffEnabled = usePhageStore(s => s.diffEnabled);
  const toggleDiff = usePhageStore(s => s.toggleDiff);
  const show3DModel = usePhageStore(s => s.show3DModel);
  const toggle3DModel = usePhageStore(s => s.toggle3DModel);
  const { open } = useOverlay();

  const setScrollPosition = usePhageStore(s => s.setScrollPosition);
  const currentPhage = usePhageStore(s => s.currentPhage);
  const scrollPosition = usePhageStore(s => s.scrollPosition);

  // Gene Navigation Logic
  const handleGeneNav = (direction: 'prev' | 'next') => {
    if (!currentPhage?.genes?.length) return;
    
    const sortedGenes = [...currentPhage.genes].sort((a, b) => a.startPos - b.startPos);

    const containingIndex = sortedGenes.findIndex((gene) => {
      return scrollPosition >= gene.startPos && scrollPosition <= gene.endPos;
    });

    const indexBefore = (() => {
      for (let i = sortedGenes.length - 1; i >= 0; i--) {
        if (sortedGenes[i].startPos < scrollPosition) return i;
      }
      return -1;
    })();

    if (direction === 'next') {
      const baseIndex = containingIndex === -1 ? indexBefore : containingIndex;
      const nextGene = sortedGenes[baseIndex + 1] ?? null;
      if (nextGene) setScrollPosition(nextGene.startPos);
      return;
    }

    const baseIndex = containingIndex === -1 ? indexBefore : containingIndex - 1;
    const prevGene = sortedGenes[baseIndex] ?? null;
    if (prevGene) {
      setScrollPosition(prevGene.startPos);
      return;
    }
    if (scrollPosition > 0) setScrollPosition(0);
  };

  // Cycle Frame
  const cycleFrame = () => {
    const frames = [0, 1, 2, -1, -2, -3];
    const idx = frames.indexOf(readingFrame as number);
    setReadingFrame(frames[(idx + 1) % frames.length]);
  };

  const viewModeShortLabel = viewMode === 'dna' ? 'DNA' : viewMode === 'aa' ? 'AA' : 'Dual';
  const viewModeLabel = viewMode === 'dna' ? 'DNA' : viewMode === 'aa' ? 'Amino Acids' : 'Dual';
  const frameLabel = readingFrame === 0 ? '+1' : readingFrame > 0 ? `+${readingFrame + 1}` : `${readingFrame}`;

  return (
    <div className={`control-deck${isLandscapePhone ? ' is-landscape' : ''}${expanded ? ' is-expanded' : ''}`}>
      {/* Tab Content Area */}
      {(!isLandscapePhone || expanded) && (
        <div className="deck-content" aria-hidden={isLandscapePhone && !expanded}>
          {activeTab === 'view' && (
            <div className="deck-row">
              <button
                type="button"
                className="deck-btn"
                onClick={toggleViewMode}
                aria-label={`Cycle view mode, current ${viewModeLabel}`}
              >
                <span className="icon">
                  <IconLayers size={deckIconSize} />
                </span>
                <span className="label">Mode {viewModeShortLabel}</span>
              </button>
              <button
                type="button"
                className="deck-btn"
                onClick={cycleFrame}
                aria-label={`Cycle reading frame, current frame ${frameLabel}`}
              >
                <span className="icon">
                  <IconRepeat size={deckIconSize} />
                </span>
                <span className="label">Frame {frameLabel}</span>
              </button>
              <button
                type="button"
                className={`deck-btn ${diffEnabled ? 'active' : ''}`}
                onClick={toggleDiff}
                aria-pressed={diffEnabled}
                aria-label={`Toggle diff mode, currently ${diffEnabled ? 'on' : 'off'}`}
              >
                <span className="icon">
                  <IconDiff size={deckIconSize} />
                </span>
                <span className="label">Diff</span>
              </button>
              <button
                type="button"
                className={`deck-btn ${show3DModel ? 'active' : ''}`}
                onClick={toggle3DModel}
                aria-pressed={show3DModel}
                aria-label={`Toggle 3D model, currently ${show3DModel ? 'on' : 'off'}`}
              >
                <span className="icon">
                  <IconCube size={deckIconSize} />
                </span>
                <span className="label">3D</span>
              </button>
            </div>
          )}

          {activeTab === 'nav' && (
            <div className="deck-row">
              <button
                type="button"
                className="deck-btn"
                onClick={() => open('search')}
                aria-label="Open search"
              >
                <span className="icon">
                  <IconSearch size={deckIconSize} />
                </span>
                <span className="label">Search</span>
              </button>
              <button
                type="button"
                className="deck-btn"
                onClick={() => open('goto')}
                aria-label="Open go-to position"
              >
                <span className="icon">
                  <IconTarget size={deckIconSize} />
                </span>
                <span className="label">Goto</span>
              </button>
              {/* Gene Navigation */}
              <button
                type="button"
                className="deck-btn"
                onClick={() => handleGeneNav('prev')}
                aria-label="Go to previous gene"
              >
                <span className="icon">
                  <IconArrowLeft size={deckIconSize} />
                </span>
                <span className="label">Prev Gene</span>
              </button>
              <button
                type="button"
                className="deck-btn"
                onClick={() => handleGeneNav('next')}
                aria-label="Go to next gene"
              >
                <span className="icon">
                  <IconArrowRight size={deckIconSize} />
                </span>
                <span className="label">Next Gene</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Bottom Tabs */}
      <div className="deck-tabs" role="navigation" aria-label="Mobile control deck">
        <button 
          type="button"
          className={`tab-btn ${activeTab === 'view' ? 'active' : ''}`} 
          onClick={() => {
            setActiveTab('view');
            if (isLandscapePhone && !expanded) setExpanded(true);
          }}
          aria-current={activeTab === 'view' ? 'page' : undefined}
        >
          View
        </button>
        <button 
          type="button"
          className={`tab-btn ${activeTab === 'nav' ? 'active' : ''}`} 
          onClick={() => {
            setActiveTab('nav');
            if (isLandscapePhone && !expanded) setExpanded(true);
          }}
          aria-current={activeTab === 'nav' ? 'page' : undefined}
        >
          Navigate
        </button>
        <button 
          type="button"
          className="tab-btn"
          onClick={() => open('commandPalette')}
          aria-label="Open tools"
        >
          Tools
        </button>
        {isLandscapePhone && (
          <button
            type="button"
            className="tab-btn tab-btn-toggle"
            aria-label={expanded ? 'Collapse control deck' : 'Expand control deck'}
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span className="tab-btn-toggle-icon" aria-hidden="true">
              {expanded ? <IconChevronDown size={18} /> : <IconChevronUp size={18} />}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
