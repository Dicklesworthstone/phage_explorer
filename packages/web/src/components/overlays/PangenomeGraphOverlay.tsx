import React, { useEffect, useMemo, useState } from 'react';
import { useHotkey } from '../../hooks';
import { useTheme } from '../../hooks/useTheme';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '../../store';
import {
  constructPangenomeGraph,
  type PangenomeGraphResult,
  type VariantCard,
  type VariantBubbleType,
} from '@phage-explorer/core';
import {
  OverlayDescription,
  OverlayEmptyState,
  OverlaySection,
  OverlaySectionHeader,
  OverlayStack,
  OverlayStatCard,
  OverlayStatGrid,
} from './primitives';

const BUBBLE_TYPE_COLORS: Record<VariantBubbleType, string> = {
  insertion: '#10b981',             // Emerald
  deletion: '#ef4444',              // Rose
  hypervariable_cassette: '#f59e0b', // Amber
  inversion: '#8b5cf6',             // Purple
  complex_recombination: '#06b6d4', // Cyan
  snv: '#64748b',                   // Slate
};

const BUBBLE_TYPE_LABELS: Record<VariantBubbleType, string> = {
  insertion: 'Insertion',
  deletion: 'Deletion',
  hypervariable_cassette: 'Hypervariable Cassette',
  inversion: 'Inversion',
  complex_recombination: 'Complex Recomb',
  snv: 'SNV Cluster',
};

const IMPACT_COLORS: Record<string, string> = {
  novel_insertion: '#10b981',
  modified: '#f59e0b',
  disrupted: '#ef4444',
  deleted: '#94a3b8',
};

export function PangenomeGraphOverlay(): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;
  const phage = usePhageStore((s) => s.currentPhage);
  const setSelectedGeneId = usePhageStore((s) => s.setSelectedGeneId);

  // Keyboard shortcut toggle: Shift+P
  useHotkey(ActionIds.OverlayPangenomeGraph, () => toggle('pangenomeGraph'));

  const [activeTypeFilter, setActiveTypeFilter] = useState<VariantBubbleType | 'all'>('all');
  const [hgtOnly, setHgtOnly] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [demoPhageId, setDemoPhageId] = useState<number | null>(null);
  const demonstration = phage !== null && demoPhageId === phage.id;
  useEffect(() => { setDemoPhageId(null); setSelectedCardId(null); }, [phage?.id]);

  // Build variation pangenome graph
  const graphResult: PangenomeGraphResult | null = useMemo(() => {
    if (!phage || !demonstration) return null;
    return constructPangenomeGraph(phage, [], { demonstration: true });
  }, [phage, demonstration]);

  // Filter variant cards
  const filteredCards: VariantCard[] = useMemo(() => {
    if (!graphResult) return [];
    let list = graphResult.variantCards;

    if (activeTypeFilter !== 'all') {
      list = list.filter((c) => c.type === activeTypeFilter);
    }

    if (hgtOnly) {
      list = list.filter((c) => c.isHgtCandidate);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.functionalSignificance.toLowerCase().includes(q) ||
          c.donorLineageHints.some(
            (d) => d.genomeName.toLowerCase().includes(q) || d.possibleLineage.toLowerCase().includes(q)
          ) ||
          c.overlappedGenes.some((g) => g.name.toLowerCase().includes(q) || g.product.toLowerCase().includes(q))
      );
    }

    return list;
  }, [graphResult, activeTypeFilter, hgtOnly, searchQuery]);

  // Active selected card
  const selectedCard: VariantCard | null = useMemo(() => {
    if (filteredCards.length === 0) return null;
    if (selectedCardId) {
      const hit = filteredCards.find((c) => c.id === selectedCardId);
      if (hit) return hit;
    }
    return filteredCards[0] ?? null;
  }, [filteredCards, selectedCardId]);

  if (!isOpen('pangenomeGraph')) return null;

  if (!phage) {
    return (
      <Overlay
        id="pangenomeGraph"
        title="Pan-Phage Variation Graph Pangenome"
        size="lg"
      >
        <OverlayEmptyState
          message="Select a bacteriophage from the sidebar or catalog to view its variation graph pangenome."
        />
      </Overlay>
    );
  }

  if (!graphResult || graphResult.variantCards.length === 0) {
    return (
      <Overlay
        id="pangenomeGraph"
        title={`Pangenome Graph: ${phage.name}`}
        size="lg"
      >
        <OverlayDescription title="Pan-Phage Graph Pangenome & Variant Cards">
          A real variation graph requires comparative nucleotide sequences and their alignments. The available annotation templates cannot identify variants, donors or recombination breakpoints.
        </OverlayDescription>
        <OverlayEmptyState
          message={`${phage.genes.length} annotated genes are available for ${phage.name}. Comparative sequence evidence has not been supplied to this panel.`}
        />
        <button type="button" onClick={() => toggle('comparison')}>Open sequence comparison</button>
        <button type="button" onClick={() => setDemoPhageId(phage.id)}>Show illustrative pangenome</button>
      </Overlay>
    );
  }

  const { metrics } = graphResult;

  return (
    <Overlay
      id="pangenomeGraph"
      title={`DEMONSTRATION — Pangenome templates: ${phage.name}`}
      size="lg"
    >
      <OverlayStack gap="md">
        <p role="note" aria-label="Demonstration assumptions">{graphResult.assumptions}</p>
        <button type="button" onClick={() => setDemoPhageId(null)}>Return to available data</button>
        <OverlayDescription title="Variation Graph Pangenome & Recombination Mosaicism">
          {graphResult.summary}
        </OverlayDescription>

        {/* High-Level Pangenome Metrics Stat Grid */}
        <OverlayStatGrid columns={4}>
          <OverlayStatCard
            label="Core Genome Ratio"
            value={
              <div>
                <div>{(metrics.coreFraction * 100).toFixed(1)}%</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>
                  {Math.round(metrics.coreGenomeLengthBp / 1000)} kb core / {Math.round(metrics.panGenomeLengthBp / 1000)} kb pan
                </div>
              </div>
            }
          />
          <OverlayStatCard
            label="Heaps' Law Openness (α)"
            value={
              <div>
                <div>α = {metrics.opennessAlpha.toFixed(2)}</div>
                <div style={{ fontSize: '0.65rem', color: colors.success, fontWeight: 'normal' }}>
                  Open pangenome (high flux)
                </div>
              </div>
            }
          />
          <OverlayStatCard
            label="Variation Bubbles"
            value={
              <div>
                <div>{metrics.totalBubbles}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>
                  {metrics.bubblesByType.hypervariable_cassette} cassette · {metrics.bubblesByType.insertion} ins · {metrics.bubblesByType.deletion} del
                </div>
              </div>
            }
          />
          <OverlayStatCard
            label="Recombination Hotspots"
            value={
              <div>
                <div>{metrics.recombinationHotspots.length}</div>
                <div style={{ fontSize: '0.65rem', color: colors.textDim, fontWeight: 'normal' }}>
                  Tail adhesin & anti-defense islands
                </div>
              </div>
            }
          />
        </OverlayStatGrid>

        {/* Interactive Variation Graph Ribbon */}
        <OverlaySection>
          <OverlaySectionHeader
            title="Variation Graph Genome Topology Ribbon"
            description="Visual representation of sequence graph paths. Core segments form the stable backbone; colored bubbles represent structural variations, cassettes, and HGT introgression events."
          />

          <div
            style={{
              padding: '0.75rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '8px',
              border: `1px solid ${colors.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            {/* Graph Ribbon visualization */}
            <div
              style={{
                display: 'flex',
                height: '38px',
                width: '100%',
                borderRadius: '6px',
                overflow: 'hidden',
                backgroundColor: `${colors.borderLight}40`,
                position: 'relative',
              }}
            >
              {graphResult.segments.map((seg) => {
                const isCore = seg.isCore;
                // Find matching card if branch
                const matchingCard = graphResult.variantCards.find(
                  (c) => seg.startCoordRef !== undefined && c.locusStartBp === seg.startCoordRef
                );
                const bubbleType = matchingCard ? matchingCard.type : 'insertion';
                const isSelected = matchingCard && selectedCard && matchingCard.id === selectedCard.id;
                const segColor = isCore
                  ? colors.primary
                  : BUBBLE_TYPE_COLORS[bubbleType] || colors.warning;

                const flexGrow = Math.max(1, Math.round(seg.lengthBp / 500));

                return (
                  <button
                    key={seg.id}
                    type="button"
                    title={`${seg.name} (${seg.lengthBp} bp, GC: ${seg.gcContent}%)${matchingCard ? ` - Bubble #${matchingCard.bubbleIndex}: ${matchingCard.type}` : ''}`}
                    onClick={() => {
                      if (matchingCard) {
                        setSelectedCardId(matchingCard.id);
                      }
                    }}
                    style={{
                      flex: `${flexGrow} 0 auto`,
                      minWidth: isCore ? '8px' : '14px',
                      backgroundColor: segColor,
                      opacity: isCore ? 0.85 : isSelected ? 1.0 : 0.65,
                      border: isSelected ? '2px solid #ffffff' : `1px solid ${colors.background}`,
                      cursor: matchingCard ? 'pointer' : 'default',
                      padding: 0,
                      outline: 'none',
                      transition: 'opacity 0.15s ease, transform 0.15s ease',
                      position: 'relative',
                    }}
                  />
                );
              })}
            </div>

            {/* Legend for Graph Ribbon */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.85rem',
                fontSize: '0.72rem',
                color: colors.textMuted,
                paddingTop: '0.2rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ width: '10px', height: '10px', backgroundColor: colors.primary, borderRadius: '2px' }} />
                <span>Core Backbone</span>
              </div>
              {(['insertion', 'deletion', 'hypervariable_cassette', 'inversion', 'complex_recombination'] as VariantBubbleType[]).map((type) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '10px', height: '10px', backgroundColor: BUBBLE_TYPE_COLORS[type], borderRadius: '2px' }} />
                  <span>{BUBBLE_TYPE_LABELS[type]}</span>
                </div>
              ))}
            </div>
          </div>
        </OverlaySection>

        {/* Filter Controls Bar */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.6rem',
            padding: '0.6rem 0.8rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            border: `1px solid ${colors.borderLight}`,
          }}
        >
          {/* Type Filter Buttons */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            <button
              type="button"
              onClick={() => setActiveTypeFilter('all')}
              style={{
                padding: '4px 10px',
                fontSize: '0.75rem',
                fontWeight: activeTypeFilter === 'all' ? 700 : 500,
                backgroundColor: activeTypeFilter === 'all' ? colors.primary : 'transparent',
                color: activeTypeFilter === 'all' ? '#fff' : colors.textMuted,
                border: `1px solid ${activeTypeFilter === 'all' ? colors.primary : colors.borderLight}`,
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              All Types ({graphResult.variantCards.length})
            </button>

            {(['insertion', 'deletion', 'hypervariable_cassette', 'inversion', 'complex_recombination'] as VariantBubbleType[]).map((type) => {
              const count = metrics.bubblesByType[type] || 0;
              if (count === 0) return null;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setActiveTypeFilter(type)}
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    fontWeight: activeTypeFilter === type ? 700 : 500,
                    backgroundColor: activeTypeFilter === type ? `${BUBBLE_TYPE_COLORS[type]}25` : 'transparent',
                    color: activeTypeFilter === type ? BUBBLE_TYPE_COLORS[type] : colors.textMuted,
                    border: `1px solid ${activeTypeFilter === type ? BUBBLE_TYPE_COLORS[type] : colors.borderLight}`,
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  {BUBBLE_TYPE_LABELS[type]} ({count})
                </button>
              );
            })}
          </div>

          {/* HGT Toggle and Search Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.75rem',
                color: colors.textMuted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={hgtOnly}
                onChange={(e) => setHgtOnly(e.target.checked)}
              />
              <span>HGT Candidates Only (|ΔGC| ≥ 4%)</span>
            </label>

            <input
              type="text"
              placeholder="Search variants / genes / donors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                padding: '3px 8px',
                fontSize: '0.75rem',
                backgroundColor: colors.background,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                width: '180px',
              }}
            />
          </div>
        </div>

        {/* Master-Detail Two Column View: Variant Cards & Card Inspector */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr', gap: '0.9rem' }}>
          {/* Left Column: Variant Card List */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.45rem',
              maxHeight: '440px',
              overflowY: 'auto',
              paddingRight: '4px',
            }}
          >
            {filteredCards.length === 0 ? (
              <div
                style={{
                  padding: '1.5rem',
                  textAlign: 'center',
                  color: colors.textDim,
                  fontSize: '0.8rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                No variant cards match the current filters.
              </div>
            ) : (
              filteredCards.map((card) => {
                const isSelected = selectedCard?.id === card.id;
                const typeColor = BUBBLE_TYPE_COLORS[card.type] || colors.primary;

                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => setSelectedCardId(card.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.3rem',
                      padding: '0.6rem 0.8rem',
                      borderRadius: '6px',
                      backgroundColor: isSelected ? `${typeColor}15` : colors.backgroundAlt,
                      border: `1px solid ${isSelected ? typeColor : colors.borderLight}`,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.15s ease',
                      outline: 'none',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span
                          style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '1px 6px',
                            borderRadius: '3px',
                            backgroundColor: `${typeColor}25`,
                            color: typeColor,
                          }}
                        >
                          #{card.bubbleIndex} {BUBBLE_TYPE_LABELS[card.type]}
                        </span>
                        {card.isHgtCandidate && (
                          <span
                            style={{
                              fontSize: '0.62rem',
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: '3px',
                              backgroundColor: '#f59e0b25',
                              color: '#f59e0b',
                            }}
                          >
                            HGT
                          </span>
                        )}
                      </div>

                      <span style={{ fontSize: '0.7rem', color: colors.textDim }}>
                        {card.locusStartBp.toLocaleString()} – {card.locusEndBp.toLocaleString()} bp
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.72rem' }}>
                      <span style={{ color: colors.textMuted }}>
                        Span: <strong>{card.spanBp.toLocaleString()} bp</strong>
                      </span>
                      <span style={{ color: card.netLengthDeltaBp >= 0 ? colors.success : colors.error }}>
                        ΔL: {card.netLengthDeltaBp >= 0 ? `+${card.netLengthDeltaBp}` : card.netLengthDeltaBp} bp
                      </span>
                      <span style={{ color: card.gcShift >= 0 ? colors.primary : colors.warning }}>
                        ΔGC: {card.gcShift >= 0 ? `+${card.gcShift}` : card.gcShift}%
                      </span>
                    </div>

                    <div
                      style={{
                        fontSize: '0.7rem',
                        color: colors.textDim,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {card.functionalSignificance}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Right Column: Detailed Variant Card Inspector */}
          {selectedCard ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
                padding: '0.85rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '8px',
                border: `1px solid ${colors.borderLight}`,
                maxHeight: '440px',
                overflowY: 'auto',
              }}
            >
              {/* Header Title & Locus */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        backgroundColor: `${BUBBLE_TYPE_COLORS[selectedCard.type]}25`,
                        color: BUBBLE_TYPE_COLORS[selectedCard.type],
                      }}
                    >
                      Variant Bubble #{selectedCard.bubbleIndex}: {BUBBLE_TYPE_LABELS[selectedCard.type]}
                    </span>
                    {selectedCard.isHgtCandidate && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: '#f59e0b25',
                          color: '#f59e0b',
                        }}
                      >
                        HGT Introgression Candidate
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: colors.textDim, marginTop: '4px' }}>
                    Coordinates: <strong>{selectedCard.locusStartBp.toLocaleString()} bp</strong> to{' '}
                    <strong>{selectedCard.locusEndBp.toLocaleString()} bp</strong> (Span: {selectedCard.spanBp.toLocaleString()} bp)
                  </div>
                </div>

                {/* Jump to Locus action */}
                <button
                  type="button"
                  onClick={() => {
                    const firstGene = phage.genes?.find(
                      (g) => g.startPos >= selectedCard.locusStartBp && g.startPos <= selectedCard.locusEndBp
                    );
                    if (firstGene) {
                      setSelectedGeneId(firstGene.id);
                    }
                  }}
                  style={{
                    padding: '3px 8px',
                    fontSize: '0.72rem',
                    backgroundColor: colors.background,
                    color: colors.primary,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Inspect Locus
                </button>
              </div>

              {/* Path Traversals Comparison */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.5rem',
                  padding: '0.5rem 0.65rem',
                  backgroundColor: colors.background,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  fontSize: '0.72rem',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: colors.textMuted }}>Reference Path</div>
                  <div style={{ color: colors.text }}>Length: {selectedCard.referenceLengthBp} bp</div>
                  <div style={{ color: colors.textDim, fontSize: '0.68rem' }}>{selectedCard.referencePathDescription}</div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, color: colors.textMuted }}>Alternative Branch</div>
                  <div style={{ color: colors.text }}>Length: {selectedCard.variantLengthBp} bp</div>
                  <div style={{ color: colors.textDim, fontSize: '0.68rem' }}>{selectedCard.variantPathDescription}</div>
                </div>
              </div>

              {/* Recombination Breakpoints Box */}
              <div
                style={{
                  padding: '0.5rem 0.65rem',
                  backgroundColor: colors.background,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                  fontSize: '0.72rem',
                }}
              >
                <div style={{ fontWeight: 600, color: colors.text, marginBottom: '2px' }}>
                  Recombination Breakpoint Junctions
                </div>
                <div style={{ display: 'flex', gap: '1rem', color: colors.textMuted, fontSize: '0.7rem' }}>
                  <div>Left: <strong>{selectedCard.recombinationBreakpoints.leftBreakpointBp} bp</strong></div>
                  <div>Right: <strong>{selectedCard.recombinationBreakpoints.rightBreakpointBp} bp</strong></div>
                  {selectedCard.recombinationBreakpoints.microhomologySequence && (
                    <div>Microhomology: <code style={{ color: colors.primary }}>{selectedCard.recombinationBreakpoints.microhomologySequence}</code></div>
                  )}
                  {selectedCard.recombinationBreakpoints.invertedRepeatDetected && (
                    <div style={{ color: '#8b5cf6', fontWeight: 600 }}>Inverted Repeat Loop</div>
                  )}
                </div>
              </div>

              {/* Overlapped Gene Impacts */}
              <div
                style={{
                  padding: '0.5rem 0.65rem',
                  backgroundColor: colors.background,
                  borderRadius: '6px',
                  border: `1px solid ${colors.borderLight}`,
                }}
              >
                <div style={{ fontWeight: 600, color: colors.text, fontSize: '0.72rem', marginBottom: '4px' }}>
                  Overlapped Gene Impacts ({selectedCard.overlappedGenes.length})
                </div>
                {selectedCard.overlappedGenes.length === 0 ? (
                  <div style={{ fontSize: '0.7rem', color: colors.textDim }}>No annotated gene intersections in this intergenic bubble.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {selectedCard.overlappedGenes.map((g, idx) => (
                      <div
                        key={`${g.name}-${idx}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: '0.7rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                          <span style={{ fontWeight: 600, color: colors.text }}>{g.name}</span>
                          <span style={{ color: colors.textDim, fontSize: '0.67rem' }}>{g.product}</span>
                        </div>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            padding: '1px 5px',
                            borderRadius: '3px',
                            backgroundColor: `${IMPACT_COLORS[g.impact] || colors.primary}20`,
                            color: IMPACT_COLORS[g.impact] || colors.primary,
                          }}
                        >
                          {g.impact}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Donor Lineage Hints */}
              {selectedCard.donorLineageHints.length > 0 && (
                <div
                  style={{
                    padding: '0.5rem 0.65rem',
                    backgroundColor: colors.background,
                    borderRadius: '6px',
                    border: `1px solid ${colors.borderLight}`,
                    fontSize: '0.72rem',
                  }}
                >
                  <div style={{ fontWeight: 600, color: colors.text, marginBottom: '2px' }}>
                    Suspected Donor Lineage & Homology
                  </div>
                  {selectedCard.donorLineageHints.map((donor, idx) => (
                    <div key={`${donor.genomeName}-${idx}`} style={{ fontSize: '0.7rem', color: colors.textMuted }}>
                      <div>
                        Donor: <strong>{donor.genomeName}</strong> ({donor.possibleLineage})
                      </div>
                      <div style={{ color: colors.textDim, fontSize: '0.68rem', marginTop: '1px' }}>
                        Evidence: {donor.evidence}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Evolutionary Rationale / Biological Narrative */}
              <div style={{ fontSize: '0.72rem', color: colors.textMuted, fontStyle: 'italic', lineHeight: 1.4 }}>
                {selectedCard.functionalSignificance}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.backgroundAlt,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '8px',
                padding: '2rem',
                color: colors.textDim,
                fontSize: '0.85rem',
              }}
            >
              Select a variant bubble on the left to inspect its genomic architecture.
            </div>
          )}
        </div>

        {/* Recombination Hotspots Section */}
        {metrics.recombinationHotspots.length > 0 && (
          <OverlaySection>
            <OverlaySectionHeader
              title="Genomic Mosaicism & Recombination Hotspots"
              description="High-frequency recombination modules identified by clustering variant bubbles and nucleotide divergence across the pangenome."
            />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: '0.6rem',
              }}
            >
              {metrics.recombinationHotspots.map((hotspot) => (
                <div
                  key={hotspot.id}
                  style={{
                    padding: '0.65rem 0.8rem',
                    borderRadius: '6px',
                    backgroundColor: colors.backgroundAlt,
                    border: `1px solid ${colors.borderLight}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.8rem', color: colors.text }}>
                      {hotspot.locusStartBp.toLocaleString()} – {hotspot.locusEndBp.toLocaleString()} bp
                    </span>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: colors.warning,
                        backgroundColor: `${colors.warning}20`,
                        padding: '1px 6px',
                        borderRadius: '3px',
                      }}
                    >
                      Diversity Score: {hotspot.diversityScore} / 100
                    </span>
                  </div>

                  <div style={{ fontSize: '0.72rem', color: colors.textMuted }}>
                    {hotspot.associatedFunctionalModule}
                  </div>

                  <div style={{ fontSize: '0.68rem', color: colors.textDim }}>
                    Dominant variation: <strong>{BUBBLE_TYPE_LABELS[hotspot.dominantVariantType]}</strong> ({hotspot.bubbleCount} bubbles in cluster)
                  </div>
                </div>
              ))}
            </div>
          </OverlaySection>
        )}
      </OverlayStack>
    </Overlay>
  );
}
