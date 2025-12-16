/**
 * ProteinDomainOverlay - Protein Domain Annotations
 *
 * Visualizes InterPro/Pfam domain annotations for genes in the current phage.
 * Shows domain architecture and functional predictions.
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository, ProteinDomain } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment } from './primitives/types';

// Domain type color mapping
const DOMAIN_COLORS: Record<string, string> = {
  Pfam: '#3b82f6',      // Blue
  TIGRFAM: '#8b5cf6',   // Purple
  SUPERFAMILY: '#ec4899', // Pink
  Gene3D: '#f97316',    // Orange
  CDD: '#22c55e',       // Green
  SMART: '#14b8a6',     // Teal
  PANTHER: '#eab308',   // Yellow
  default: '#6b7280',   // Gray
};

function getDomainColor(domainType: string | null): string {
  if (!domainType) return DOMAIN_COLORS.default;
  return DOMAIN_COLORS[domainType] ?? DOMAIN_COLORS.default;
}

// Format E-value for display
function formatEValue(eValue: number | null): string {
  if (eValue === null) return 'N/A';
  if (eValue === 0) return '0';
  if (eValue < 1e-100) return '<1e-100';
  if (eValue < 0.001) return eValue.toExponential(1);
  return eValue.toFixed(3);
}

// Group domains by gene
interface GeneDomains {
  gene: GeneInfo;
  domains: ProteinDomain[];
}

interface ProteinDomainOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function ProteinDomainOverlay({
  repository,
  currentPhage,
}: ProteinDomainOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('proteinDomains');

  const [domains, setDomains] = useState<ProteinDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGene, setSelectedGene] = useState<GeneInfo | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  // Hotkey (Alt+D for Domains)
  useHotkey(
    { key: 'd', modifiers: { alt: true } },
    'Protein Domains',
    () => toggle('proteinDomains'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch domains when overlay opens
  useEffect(() => {
    if (!isOpen('proteinDomains')) return;
    if (!repository?.getProteinDomains || !currentPhage) {
      setDomains([]);
      return;
    }

    setLoading(true);
    repository
      .getProteinDomains(currentPhage.id)
      .then(setDomains)
      .catch(() => setDomains([]))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Get unique domain types for filter
  const domainTypes = useMemo(() => {
    const types = new Set(domains.map((d) => d.domainType).filter(Boolean));
    return ['all', ...Array.from(types)] as string[];
  }, [domains]);

  // Filter domains by type
  const filteredDomains = useMemo(() => {
    if (filterType === 'all') return domains;
    return domains.filter((d) => d.domainType === filterType);
  }, [domains, filterType]);

  // Group domains by gene
  const geneDomains = useMemo((): GeneDomains[] => {
    if (!currentPhage?.genes) return [];

    const geneMap = new Map<number, ProteinDomain[]>();
    for (const domain of filteredDomains) {
      if (domain.geneId) {
        const existing = geneMap.get(domain.geneId) ?? [];
        existing.push(domain);
        geneMap.set(domain.geneId, existing);
      }
    }

    return currentPhage.genes
      .filter((g) => geneMap.has(g.id))
      .map((gene) => ({
        gene,
        domains: geneMap.get(gene.id) ?? [],
      }))
      .sort((a, b) => a.gene.startPos - b.gene.startPos);
  }, [currentPhage, filteredDomains]);

  // Create genome track segments for domains (only include those with valid gene positions)
  const domainSegments = useMemo((): GenomeTrackSegment[] => {
    return filteredDomains
      .map((domain) => {
        if (!domain.geneId) return null;
        const gene = currentPhage?.genes?.find((g) => g.id === domain.geneId);
        if (!gene) return null;

        return {
          start: gene.startPos,
          end: gene.endPos,
          label: domain.domainName ?? domain.domainId,
          color: getDomainColor(domain.domainType),
          height: 16,
          data: domain,
        } as GenomeTrackSegment;
      })
      .filter((segment): segment is GenomeTrackSegment => segment !== null);
  }, [filteredDomains, currentPhage]);

  // Handle gene click for detail view
  const handleGeneClick = useCallback((gene: GeneInfo) => {
    setSelectedGene((prev) => (prev?.id === gene.id ? null : gene));
  }, []);

  if (!isOpen('proteinDomains')) return null;

  return (
    <Overlay
      id="proteinDomains"
      title="PROTEIN DOMAINS"
      hotkey="Alt+D"
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
            <strong style={{ color: colors.accent }}>Protein Domain Annotations</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about protein domains"
                tooltip={overlayHelp?.summary ?? 'Protein domains are conserved functional units that can be identified by sequence similarity.'}
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'protein-domain')}
              />
            )}
          </div>
          <div>
            Conserved protein domains identified via InterProScan. Domains provide
            functional predictions and evolutionary insights for phage proteins.
          </div>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : domains.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!currentPhage
              ? 'No phage selected'
              : 'No protein domain annotations available for this phage'}
          </div>
        ) : (
          <>
            {/* Stats and filter */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <span style={{ color: colors.textMuted }}>
                {filteredDomains.length} domain{filteredDomains.length !== 1 ? 's' : ''} in{' '}
                {geneDomains.length} gene{geneDomains.length !== 1 ? 's' : ''}
              </span>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label htmlFor="domain-type-filter" style={{ color: colors.textMuted }}>
                  Filter:
                </label>
                <select
                  id="domain-type-filter"
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
                  {domainTypes.map((type) => (
                    <option key={type} value={type}>
                      {type === 'all' ? 'All Types' : type}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Genome track visualization */}
            {currentPhage && currentPhage.genomeLength && (
              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                  Domain Distribution
                </div>
                <GenomeTrack
                  genomeLength={currentPhage.genomeLength}
                  segments={domainSegments}
                  width={540}
                  height={40}
                  ariaLabel="Protein domain distribution track"
                />
              </div>
            )}

            {/* Domain list by gene */}
            <div
              style={{
                maxHeight: '300px',
                overflowY: 'auto',
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
              }}
            >
              {geneDomains.map(({ gene, domains: geneDoms }) => (
                <div
                  key={gene.id}
                  style={{
                    borderBottom: `1px solid ${colors.borderLight}`,
                  }}
                >
                  {/* Gene header */}
                  <button
                    onClick={() => handleGeneClick(gene)}
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      backgroundColor:
                        selectedGene?.id === gene.id ? colors.backgroundAlt : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ color: colors.text, fontWeight: 500 }}>
                      {gene.name ?? gene.locusTag ?? `Gene ${gene.id}`}
                    </span>
                    <span style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                      {gene.startPos.toLocaleString()}-{gene.endPos.toLocaleString()} |{' '}
                      {geneDoms.length} domain{geneDoms.length !== 1 ? 's' : ''}
                    </span>
                  </button>

                  {/* Domain details when expanded */}
                  {selectedGene?.id === gene.id && (
                    <div
                      style={{
                        padding: '0.5rem',
                        backgroundColor: colors.backgroundAlt,
                        fontSize: '0.75rem',
                      }}
                    >
                      {geneDoms.map((domain) => (
                        <div
                          key={domain.id}
                          style={{
                            padding: '0.5rem',
                            marginBottom: '0.5rem',
                            borderLeft: `3px solid ${getDomainColor(domain.domainType)}`,
                            paddingLeft: '0.75rem',
                          }}
                        >
                          <div style={{ fontWeight: 500, color: colors.text }}>
                            {domain.domainName ?? domain.domainId}
                          </div>
                          <div style={{ color: colors.textMuted }}>
                            {domain.domainId} ({domain.domainType ?? 'Unknown'})
                          </div>
                          {domain.description && (
                            <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
                              {domain.description}
                            </div>
                          )}
                          <div style={{ color: colors.textDim, marginTop: '0.25rem' }}>
                            E-value: {formatEValue(domain.eValue)} | Score:{' '}
                            {domain.score?.toFixed(1) ?? 'N/A'}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
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
              {Object.entries(DOMAIN_COLORS)
                .filter(([key]) => key !== 'default')
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
                    <span style={{ color: colors.textMuted }}>{type}</span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default ProteinDomainOverlay;
