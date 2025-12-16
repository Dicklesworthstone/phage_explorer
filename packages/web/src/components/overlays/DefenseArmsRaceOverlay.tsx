/**
 * DefenseArmsRaceOverlay - Phage Defense/Anti-Defense Systems
 *
 * Visualizes defense evasion systems carried by phages:
 * - Anti-CRISPR proteins
 * - Anti-restriction modification systems
 * - Other host defense countermeasures
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import type { PhageRepository, DefenseSystem } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment } from './primitives/types';

// Defense system type colors
const DEFENSE_COLORS: Record<string, string> = {
  'anti-CRISPR': '#ef4444',      // Red
  'anti-RM': '#f59e0b',          // Orange (anti-restriction modification)
  'anti-toxin': '#8b5cf6',       // Purple
  'DNA-mimicry': '#3b82f6',      // Blue
  'methyltransferase': '#22c55e', // Green
  'nuclease-inhibitor': '#ec4899', // Pink
  'abortive-escape': '#14b8a6',  // Teal
  'unknown': '#6b7280',          // Gray
};

function getDefenseColor(systemType: string): string {
  // Try exact match first, then check prefixes
  if (DEFENSE_COLORS[systemType]) return DEFENSE_COLORS[systemType];

  const lower = systemType.toLowerCase();
  if (lower.includes('crispr')) return DEFENSE_COLORS['anti-CRISPR'];
  if (lower.includes('rm') || lower.includes('restriction')) return DEFENSE_COLORS['anti-RM'];
  if (lower.includes('toxin')) return DEFENSE_COLORS['anti-toxin'];
  if (lower.includes('mimic')) return DEFENSE_COLORS['DNA-mimicry'];
  if (lower.includes('methyl')) return DEFENSE_COLORS['methyltransferase'];
  if (lower.includes('nuclease')) return DEFENSE_COLORS['nuclease-inhibitor'];

  return DEFENSE_COLORS['unknown'];
}

// Defense system descriptions
const DEFENSE_DESCRIPTIONS: Record<string, string> = {
  'anti-CRISPR':
    'Inhibits CRISPR-Cas adaptive immunity, allowing phages to evade sequence-specific targeting',
  'anti-RM':
    'Counteracts restriction-modification systems that cleave unmethylated foreign DNA',
  'anti-toxin':
    'Neutralizes toxin-antitoxin systems that trigger programmed cell death during infection',
  'DNA-mimicry':
    'DNA mimic proteins that sequester host defense machinery away from phage DNA',
  'methyltransferase':
    'Modifies phage DNA to protect from restriction enzymes',
  'nuclease-inhibitor':
    'Inhibits host nucleases that degrade foreign DNA',
  'abortive-escape':
    'Evades abortive infection systems that sacrifice infected cells',
};

interface DefenseArmsRaceOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function DefenseArmsRaceOverlay({
  repository,
  currentPhage,
}: DefenseArmsRaceOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('defenseArmsRace');

  const [defenseSystems, setDefenseSystems] = useState<DefenseSystem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSystem, setSelectedSystem] = useState<DefenseSystem | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  // Hotkey (Alt+E for dEfense - Alt+R used by StructureConstraintOverlay)
  useHotkey(
    { key: 'e', modifiers: { alt: true } },
    'Defense Arms Race',
    () => toggle('defenseArmsRace'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch defense systems when overlay opens
  useEffect(() => {
    if (!isOpen('defenseArmsRace')) return;
    if (!repository?.getDefenseSystems || !currentPhage) {
      setDefenseSystems([]);
      return;
    }

    setLoading(true);
    repository
      .getDefenseSystems(currentPhage.id)
      .then(setDefenseSystems)
      .catch(() => setDefenseSystems([]))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Filter systems
  const filteredSystems = useMemo(() => {
    if (filterType === 'all') return defenseSystems;
    return defenseSystems.filter((d) => d.systemType === filterType);
  }, [defenseSystems, filterType]);

  // Count by type
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const sys of defenseSystems) {
      counts[sys.systemType] = (counts[sys.systemType] ?? 0) + 1;
    }
    return counts;
  }, [defenseSystems]);

  // Create genome track segments (only include those with valid gene positions)
  const defenseSegments = useMemo((): GenomeTrackSegment[] => {
    return filteredSystems
      .map((sys) => {
        if (!sys.geneId) return null;
        const gene = currentPhage?.genes?.find((g) => g.id === sys.geneId);
        if (!gene) return null;

        return {
          start: gene.startPos,
          end: gene.endPos,
          label: sys.systemType,
          color: getDefenseColor(sys.systemType),
          height: 16,
          data: sys,
        } as GenomeTrackSegment;
      })
      .filter((segment): segment is GenomeTrackSegment => segment !== null);
  }, [filteredSystems, currentPhage]);

  // Handle system selection
  const handleSystemClick = useCallback((sys: DefenseSystem) => {
    setSelectedSystem((prev) => (prev?.id === sys.id ? null : sys));
  }, []);

  // Find gene for system
  const getGeneForSystem = useCallback(
    (sys: DefenseSystem): GeneInfo | undefined => {
      return currentPhage?.genes?.find((g) => g.id === sys.geneId);
    },
    [currentPhage]
  );

  if (!isOpen('defenseArmsRace')) return null;

  return (
    <Overlay
      id="defenseArmsRace"
      title="DEFENSE ARMS RACE"
      hotkey="Alt+E"
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
            <strong style={{ color: colors.accent }}>Phage-Host Arms Race</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about phage defense systems"
                tooltip={
                  overlayHelp?.summary ??
                  'Phages and bacteria are locked in an evolutionary arms race. Phages carry genes to evade host defenses.'
                }
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'anti-crispr')}
              />
            )}
          </div>
          <div>
            Phages encode proteins that counteract bacterial immune systems. These
            anti-defense genes are crucial for successful infection and reveal
            co-evolutionary dynamics.
          </div>
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : defenseSystems.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!currentPhage
              ? 'No phage selected'
              : 'No defense system annotations available for this phage'}
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
                  onClick={() => setFilterType(type === filterType ? 'all' : type)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem',
                    padding: '0.25rem 0.5rem',
                    backgroundColor: filterType === type ? colors.accent : colors.backgroundAlt,
                    borderRadius: '4px',
                    border: `1px solid ${getDefenseColor(type)}`,
                    cursor: 'pointer',
                    color: filterType === type ? '#fff' : colors.text,
                  }}
                >
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      backgroundColor: filterType === type ? '#fff' : getDefenseColor(type),
                      borderRadius: '50%',
                    }}
                  />
                  <span>{type}: {count}</span>
                </div>
              ))}
            </div>

            {/* Genome track */}
            {currentPhage && currentPhage.genomeLength && (
              <div>
                <div style={{ fontSize: '0.75rem', color: colors.textMuted, marginBottom: '0.25rem' }}>
                  Defense Gene Distribution
                </div>
                <GenomeTrack
                  genomeLength={currentPhage.genomeLength}
                  segments={defenseSegments}
                  width={540}
                  height={40}
                  ariaLabel="Defense system distribution track"
                />
              </div>
            )}

            {/* System list */}
            <div
              style={{
                maxHeight: '250px',
                overflowY: 'auto',
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
              }}
            >
              {filteredSystems.map((sys) => {
                const gene = getGeneForSystem(sys);
                const isSelected = selectedSystem?.id === sys.id;

                return (
                  <div
                    key={sys.id}
                    style={{
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    <button
                      onClick={() => handleSystemClick(sys)}
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
                            backgroundColor: getDefenseColor(sys.systemType),
                            borderRadius: '2px',
                          }}
                        />
                        <span style={{ color: colors.text, fontWeight: 500 }}>
                          {sys.systemFamily ?? sys.systemType}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {sys.confidence !== null && (
                          <span
                            style={{
                              fontSize: '0.7rem',
                              padding: '0.125rem 0.375rem',
                              backgroundColor:
                                sys.confidence >= 0.8
                                  ? '#22c55e20'
                                  : sys.confidence >= 0.5
                                    ? '#f59e0b20'
                                    : '#ef444420',
                              color:
                                sys.confidence >= 0.8
                                  ? '#22c55e'
                                  : sys.confidence >= 0.5
                                    ? '#f59e0b'
                                    : '#ef4444',
                              borderRadius: '3px',
                            }}
                          >
                            {(sys.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                        <span style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                          {sys.systemType}
                        </span>
                      </div>
                    </button>

                    {isSelected && (
                      <div
                        style={{
                          padding: '0.75rem',
                          backgroundColor: colors.backgroundAlt,
                          fontSize: '0.8rem',
                        }}
                      >
                        {gene && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Gene:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>
                              {gene.name ?? gene.locusTag ?? sys.locusTag} (
                              {gene.startPos.toLocaleString()}-{gene.endPos.toLocaleString()} bp)
                            </span>
                          </div>
                        )}

                        {sys.targetSystem && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Target:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>{sys.targetSystem}</span>
                          </div>
                        )}

                        {sys.mechanism && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Mechanism:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>{sys.mechanism}</span>
                          </div>
                        )}

                        {sys.source && (
                          <div style={{ marginBottom: '0.5rem' }}>
                            <strong style={{ color: colors.text }}>Source:</strong>{' '}
                            <span style={{ color: colors.textMuted }}>{sys.source}</span>
                          </div>
                        )}

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
                          {DEFENSE_DESCRIPTIONS[sys.systemType] ??
                            'Defense evasion system with unknown mechanism'}
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
              {Object.entries(DEFENSE_COLORS)
                .filter(([key]) => key !== 'unknown' && (typeCounts[key] || filterType === 'all'))
                .slice(0, 6)
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

            {/* Interpretation */}
            <div
              style={{
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.75rem',
                color: colors.textDim,
              }}
            >
              <strong>Interpretation:</strong> Phages with diverse anti-defense arsenals may
              have broader host ranges or infect hosts with complex immune systems. The
              presence of specific anti-CRISPR types can suggest which CRISPR subtypes
              the phage's hosts possess.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default DefenseArmsRaceOverlay;
