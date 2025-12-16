/**
 * AMGPathwayOverlay - Auxiliary Metabolic Gene Visualization
 *
 * Displays AMG annotations mapped to KEGG pathways.
 * Shows how phage genes may modulate host metabolism.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository, AmgAnnotation } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment } from './primitives/types';

// AMG type colors matching KEGG pathway categories
const AMG_COLORS: Record<string, string> = {
  photosynthesis: '#22c55e',  // Green - photosynthesis
  carbon: '#f59e0b',          // Orange - carbon metabolism
  nucleotide: '#3b82f6',      // Blue - nucleotide metabolism
  amino_acid: '#8b5cf6',      // Purple - amino acid metabolism
  sulfur: '#eab308',          // Yellow - sulfur/nitrogen
  phosphorus: '#14b8a6',      // Teal - phosphorus
  stress: '#ef4444',          // Red - stress response
  lipid: '#ec4899',           // Pink - lipid metabolism
  default: '#6b7280',         // Gray - unknown
};

function getAmgColor(amgType: string): string {
  return AMG_COLORS[amgType] ?? AMG_COLORS.default;
}

// AMG type descriptions
const AMG_DESCRIPTIONS: Record<string, string> = {
  photosynthesis: 'Photosynthesis-related genes that can enhance host photosynthetic capacity during infection',
  carbon: 'Carbon metabolism genes that redirect host carbon flux for viral replication',
  nucleotide: 'Nucleotide biosynthesis genes that boost nucleotide pools for genome replication',
  amino_acid: 'Amino acid metabolism genes for protein synthesis support',
  sulfur: 'Sulfur/nitrogen metabolism genes for nutrient acquisition',
  phosphorus: 'Phosphorus metabolism genes for nucleic acid synthesis',
  stress: 'Stress response genes that help maintain host viability',
  lipid: 'Lipid metabolism genes for membrane synthesis',
};

interface AMGPathwayOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function AMGPathwayOverlay({
  repository,
  currentPhage,
}: AMGPathwayOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('amgPathway');

  const [amgs, setAmgs] = useState<AmgAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAmg, setSelectedAmg] = useState<AmgAnnotation | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  // Hotkey (Alt+A for AMG)
  useHotkey(
    { key: 'a', modifiers: { alt: true } },
    'AMG Pathways',
    () => toggle('amgPathway'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch AMGs when overlay opens
  useEffect(() => {
    if (!isOpen('amgPathway')) return;
    if (!repository?.getAmgAnnotations || !currentPhage) {
      setAmgs([]);
      return;
    }

    setLoading(true);
    repository
      .getAmgAnnotations(currentPhage.id)
      .then(setAmgs)
      .catch(() => setAmgs([]))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Get unique AMG types
  const amgTypes = useMemo(() => {
    const types = new Set(amgs.map((a) => a.amgType));
    return ['all', ...Array.from(types)];
  }, [amgs]);

  // Filter AMGs
  const filteredAmgs = useMemo(() => {
    if (filterType === 'all') return amgs;
    return amgs.filter((a) => a.amgType === filterType);
  }, [amgs, filterType]);

  // Count by type for summary
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const amg of amgs) {
      counts[amg.amgType] = (counts[amg.amgType] ?? 0) + 1;
    }
    return counts;
  }, [amgs]);

  // Create genome track segments (only include those with valid gene positions)
  const amgSegments = useMemo((): GenomeTrackSegment[] => {
    return filteredAmgs
      .map((amg) => {
        if (!amg.geneId) return null;
        const gene = currentPhage?.genes?.find((g) => g.id === amg.geneId);
        if (!gene) return null;

        return {
          start: gene.startPos,
          end: gene.endPos,
          label: amg.keggOrtholog ?? amg.amgType,
          color: getAmgColor(amg.amgType),
          height: 16,
          data: amg,
        } as GenomeTrackSegment;
      })
      .filter((segment): segment is GenomeTrackSegment => segment !== null);
  }, [filteredAmgs, currentPhage]);

  // Handle AMG selection
  const handleAmgClick = useCallback((amg: AmgAnnotation) => {
    setSelectedAmg((prev) => (prev?.id === amg.id ? null : amg));
  }, []);

  // Find gene for AMG
  const getGeneForAmg = useCallback(
    (amg: AmgAnnotation): GeneInfo | undefined => {
      return currentPhage?.genes?.find((g) => g.id === amg.geneId);
    },
    [currentPhage]
  );

  if (!isOpen('amgPathway')) return null;

  return (
    <Overlay
      id="amgPathway"
      title="AUXILIARY METABOLIC GENES"
      hotkey="Alt+A"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong style={{ color: colors.accent }}>AMG Detection (KEGG)</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about AMGs"
                tooltip={
                  overlayHelp?.summary ??
                  'AMGs are host-derived metabolic genes carried by phages that can redirect host metabolism during infection.'
                }
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'auxiliary-metabolic-gene')}
              />
            )}
          </div>
          <div>
            Auxiliary Metabolic Genes (AMGs) are host-derived genes that phages use to
            manipulate host metabolism during infection, particularly for enhancing
            energy production and nucleotide synthesis.
          </div>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : amgs.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!currentPhage
              ? 'No phage selected'
              : 'No AMG annotations available for this phage'}
          </div>
        ) : (
          <>
            {/* Summary stats */}
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                flexWrap: 'wrap',
                fontSize: '0.8rem',
              }}
            >
              {Object.entries(typeCounts).map(([type, count]) => (
                <div
                  key={type}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.25rem 0.5rem',
                    backgroundColor: colors.backgroundAlt,
                    borderRadius: '4px',
                    border: `1px solid ${getAmgColor(type)}`,
                  }}
                >
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      backgroundColor: getAmgColor(type),
                      borderRadius: '50%',
                    }}
                  />
                  <span style={{ color: colors.text, textTransform: 'capitalize' }}>
                    {type.replace('_', ' ')}: {count}
                  </span>
                </div>
              ))}
            </div>

            {/* Filter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
              <label htmlFor="amg-type-filter" style={{ color: colors.textMuted }}>
                Filter by type:
              </label>
              <select
                id="amg-type-filter"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                style={{
                  padding: '0.25rem',
                  backgroundColor: colors.backgroundAlt,
                  color: colors.text,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '3px',
                }}
              >
                {amgTypes.map((type) => (
                  <option key={type} value={type}>
                    {type === 'all' ? 'All Types' : type.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>

            {/* Genome track */}
            {currentPhage && currentPhage.genomeLength && (
              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                  AMG Distribution
                </div>
                <GenomeTrack
                  genomeLength={currentPhage.genomeLength}
                  segments={amgSegments}
                  width={540}
                  height={40}
                  ariaLabel="AMG distribution track"
                />
              </div>
            )}

            {/* AMG list */}
            <div
              style={{
                maxHeight: '250px',
                overflowY: 'auto',
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
              }}
            >
              {filteredAmgs.map((amg) => {
                const gene = getGeneForAmg(amg);
                const isSelected = selectedAmg?.id === amg.id;

                return (
                  <div
                    key={amg.id}
                    style={{
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    <button
                      onClick={() => handleAmgClick(amg)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          style={{
                            width: '10px',
                            height: '10px',
                            backgroundColor: getAmgColor(amg.amgType),
                            borderRadius: '2px',
                          }}
                        />
                        <span style={{ color: colors.text, fontWeight: 500 }}>
                          {amg.keggOrtholog ?? amg.locusTag ?? 'Unknown'}
                        </span>
                      </div>
                      <span
                        style={{
                          color: colors.textMuted,
                          fontSize: '0.75rem',
                          textTransform: 'capitalize',
                        }}
                      >
                        {amg.amgType.replace('_', ' ')}
                      </span>
                    </button>

                    {isSelected && (
                      <div
                        style={{
                          padding: '0.75rem',
                          backgroundColor: colors.backgroundAlt,
                          fontSize: '0.8rem',
                        }}
                      >
                        <div style={{ marginBottom: '0.5rem' }}>
                          <strong style={{ color: colors.text }}>Pathway:</strong>{' '}
                          <span style={{ color: colors.textMuted }}>
                            {amg.pathwayName ?? amg.keggPathway ?? 'Unknown'}
                          </span>
                        </div>

                        {gene && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Gene:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>
                              {gene.name ?? gene.locusTag} ({gene.startPos.toLocaleString()}-
                              {gene.endPos.toLocaleString()} bp)
                            </span>
                          </div>
                        )}

                        {amg.keggReaction && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Reaction:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>{amg.keggReaction}</span>
                          </div>
                        )}

                        <div style={{ marginBottom: '0.5rem' }}>
                          <strong style={{ color: colors.text }}>Confidence:</strong>{' '}
                          <span
                            style={{
                              color:
                                (amg.confidence ?? 0) >= 0.8
                                  ? '#22c55e'
                                  : (amg.confidence ?? 0) >= 0.5
                                    ? '#f59e0b'
                                    : '#ef4444',
                            }}
                          >
                            {((amg.confidence ?? 0) * 100).toFixed(0)}%
                          </span>
                        </div>

                        <div
                          style={{
                            padding: '0.5rem',
                            backgroundColor: colors.background,
                            borderRadius: '4px',
                            color: colors.textDim,
                            fontSize: '0.75rem',
                            marginTop: '0.5rem',
                          }}
                        >
                          {AMG_DESCRIPTIONS[amg.amgType] ?? 'Metabolic gene of unknown function'}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                fontSize: '0.75rem',
              }}
            >
              {Object.entries(AMG_COLORS)
                .filter(([key]) => key !== 'default' && typeCounts[key])
                .map(([type, color]) => (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span
                      style={{
                        width: '10px',
                        height: '10px',
                        backgroundColor: color,
                        borderRadius: '2px',
                      }}
                    />
                    <span style={{ color: colors.textMuted, textTransform: 'capitalize' }}>
                      {type.replace('_', ' ')}
                    </span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default AMGPathwayOverlay;
