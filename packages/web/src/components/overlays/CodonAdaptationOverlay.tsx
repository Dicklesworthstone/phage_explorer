/**
 * CodonAdaptationOverlay - Host Codon Adaptation Analysis
 *
 * Visualizes how well phage codon usage matches different bacterial hosts.
 * Uses pre-computed CAI/TAI scores from the annotation pipeline.
 */

import React, { useMemo, useState, useEffect } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository, CodonAdaptation, HostTrnaPool } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';

// Color scale for adaptation scores
function getAdaptationColor(score: number): string {
  if (score >= 0.8) return '#22c55e';  // Green - high adaptation
  if (score >= 0.6) return '#84cc16';  // Lime
  if (score >= 0.4) return '#f59e0b';  // Orange - moderate
  if (score >= 0.2) return '#f97316';  // Dark orange
  return '#ef4444';                     // Red - low adaptation
}

// Host summary statistics
interface HostAdaptationSummary {
  hostName: string;
  avgCai: number;
  avgTai: number;
  avgCpb: number;
  geneCount: number;
}

interface CodonAdaptationOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function CodonAdaptationOverlay({
  repository,
  currentPhage,
}: CodonAdaptationOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('codonAdaptation');

  const [adaptations, setAdaptations] = useState<CodonAdaptation[]>([]);
  const [hostPools, setHostPools] = useState<HostTrnaPool[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'summary' | 'genes'>('summary');

  // Hotkey (Alt+T for tRNA/adaptation)
  useHotkey(
    ActionIds.OverlayCodonAdaptation,
    () => toggle('codonAdaptation'),
    { modes: ['NORMAL'] }
  );

  // Fetch data when overlay opens
  useEffect(() => {
    if (!isOpen('codonAdaptation')) return;
    if (!repository?.getCodonAdaptation || !repository?.getHostTrnaPools || !currentPhage) {
      setAdaptations([]);
      setHostPools([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([
      repository.getCodonAdaptation(currentPhage.id),
      repository.getHostTrnaPools(),
    ])
      .then(([adapt, pools]) => {
        if (cancelled) return;
        setAdaptations(adapt);
        setHostPools(pools);
      })
      .catch(() => {
        if (cancelled) return;
        setAdaptations([]);
        setHostPools([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Compute per-host summaries (skip the synthetic 'intrinsic' row that only
  // stores the genome-wide effective number of codons).
  const hostSummaries = useMemo((): HostAdaptationSummary[] => {
    const byHost = new Map<string, CodonAdaptation[]>();

    for (const a of adaptations) {
      if (a.hostName === 'intrinsic') continue;
      const existing = byHost.get(a.hostName) ?? [];
      existing.push(a);
      byHost.set(a.hostName, existing);
    }

    return Array.from(byHost.entries()).map(([hostName, genes]) => {
      const caiValues = genes.map((g) => g.cai).filter((v): v is number => v !== null);
      const taiValues = genes.map((g) => g.tai).filter((v): v is number => v !== null);
      const cpbValues = genes.map((g) => g.cpb).filter((v): v is number => v !== null);

      return {
        hostName,
        avgCai: caiValues.length > 0 ? caiValues.reduce((a, b) => a + b, 0) / caiValues.length : 0,
        avgTai: taiValues.length > 0 ? taiValues.reduce((a, b) => a + b, 0) / taiValues.length : 0,
        avgCpb: cpbValues.length > 0 ? cpbValues.reduce((a, b) => a + b, 0) / cpbValues.length : 0,
        geneCount: genes.length,
      };
    });
  }, [adaptations]);

  // Get genes for selected host
  const selectedHostGenes = useMemo(() => {
    if (!selectedHost) return [];
    return adaptations
      .filter((a) => a.hostName === selectedHost)
      .sort((a, b) => (b.cai ?? 0) - (a.cai ?? 0));
  }, [adaptations, selectedHost]);

  // Get available hosts from tRNA pools (exclude synthetic intrinsic marker).
  const availableHosts = useMemo(() => {
    const hostNames = new Set(hostPools.map((p) => p.hostName));
    hostNames.delete('intrinsic');
    return Array.from(hostNames);
  }, [hostPools]);

  if (!isOpen('codonAdaptation')) return null;

  return (
    <Overlay
      id="codonAdaptation"
      title="CODON ADAPTATION"
      hotkey="Alt+T"
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
            <strong style={{ color: colors.accent }}>Host Codon Adaptation</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about codon adaptation"
                tooltip={
                  overlayHelp?.summary ??
                  'Codon adaptation measures how well a phage\'s codon usage matches its host\'s tRNA availability.'
                }
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'codon-adaptation-index')}
              />
            )}
          </div>
          <div>
            Higher CAI (Codon Adaptation Index) and TAI (tRNA Adaptation Index) suggest
            the phage is well-adapted for efficient translation in that host.
          </div>
        </div>

        {loading ? (
          <OverlayLoadingState message="Loading codon adaptation data...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : adaptations.length === 0 ? (
          <OverlayEmptyState
            message={
              !currentPhage
                ? 'No phage selected'
                : hostSummaries.length === 0
                  ? 'No pre-computed adaptation scores available'
                  : 'No codon adaptation data available for this phage'
            }
            hint={
              !currentPhage
                ? 'Select a phage to analyze.'
                : hostSummaries.length === 0
                  ? `Available host tRNA pools: ${availableHosts.join(', ') || 'None'}`
                  : 'CAI/TAI scores are computed during the annotation pipeline.'
            }
          />
        ) : (
          <>
            {/* View toggle */}
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                fontSize: '0.8rem',
              }}
            >
              <button
                onClick={() => setViewMode('summary')}
                style={{
                  padding: '0.25rem 0.75rem',
                  backgroundColor: viewMode === 'summary' ? colors.accent : colors.backgroundAlt,
                  color: viewMode === 'summary' ? '#fff' : colors.text,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Host Summary
              </button>
              <button
                onClick={() => setViewMode('genes')}
                style={{
                  padding: '0.25rem 0.75rem',
                  backgroundColor: viewMode === 'genes' ? colors.accent : colors.backgroundAlt,
                  color: viewMode === 'genes' ? '#fff' : colors.text,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Per-Gene View
              </button>
            </div>

            {viewMode === 'summary' ? (
              /* Host summary view */
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '0.75rem',
                }}
              >
                {hostSummaries.map((host) => (
                  <div
                    key={host.hostName}
                    onClick={() => {
                      setSelectedHost(host.hostName);
                      setViewMode('genes');
                    }}
                    style={{
                      padding: '0.75rem',
                      backgroundColor: colors.backgroundAlt,
                      borderRadius: '4px',
                      border: `1px solid ${colors.borderLight}`,
                      cursor: 'pointer',
                      transition: 'border-color 0.2s',
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.borderColor = colors.accent)
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.borderColor = colors.borderLight)
                    }
                  >
                    <div
                      style={{
                        fontWeight: 500,
                        color: colors.text,
                        marginBottom: '0.5rem',
                        fontSize: '0.85rem',
                      }}
                    >
                      {host.hostName}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {/* CAI bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.7rem', color: colors.textMuted, width: '30px' }}>
                          CAI
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: '8px',
                            backgroundColor: colors.background,
                            borderRadius: '4px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${host.avgCai * 100}%`,
                              height: '100%',
                              backgroundColor: getAdaptationColor(host.avgCai),
                            }}
                          />
                        </div>
                        <span style={{ fontSize: '0.7rem', color: colors.text, width: '35px' }}>
                          {host.avgCai.toFixed(2)}
                        </span>
                      </div>

                      {/* TAI bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.7rem', color: colors.textMuted, width: '30px' }}>
                          TAI
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: '8px',
                            backgroundColor: colors.background,
                            borderRadius: '4px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${host.avgTai * 100}%`,
                              height: '100%',
                              backgroundColor: getAdaptationColor(host.avgTai),
                            }}
                          />
                        </div>
                        <span style={{ fontSize: '0.7rem', color: colors.text, width: '35px' }}>
                          {host.avgTai.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        fontSize: '0.7rem',
                        color: colors.textMuted,
                        marginTop: '0.5rem',
                      }}
                    >
                      {host.geneCount} gene{host.geneCount !== 1 ? 's' : ''} analyzed
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Per-gene view */
              <>
                {/* Host selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <label htmlFor="host-select" style={{ color: colors.textMuted }}>
                    Host:
                  </label>
                  <select
                    id="host-select"
                    value={selectedHost ?? ''}
                    onChange={(e) => setSelectedHost(e.target.value || null)}
                    style={{
                      padding: '0.25rem',
                      backgroundColor: colors.backgroundAlt,
                      color: colors.text,
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: '3px',
                    }}
                  >
                    <option value="">Select host...</option>
                    {hostSummaries.map((h) => (
                      <option key={h.hostName} value={h.hostName}>
                        {h.hostName}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedHost && selectedHostGenes.length > 0 && (
                  <div
                    style={{
                      maxHeight: '300px',
                      overflowY: 'auto',
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: '4px',
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: colors.backgroundAlt }}>
                          <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textMuted }}>
                            Gene
                          </th>
                          <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                            CAI
                          </th>
                          <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                            TAI
                          </th>
                          <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                            CPB
                          </th>
                          <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                            Nc'
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedHostGenes.map((gene) => {
                          const geneInfo = currentPhage?.genes?.find((g) => g.id === gene.geneId);
                          return (
                            <tr
                              key={gene.id}
                              style={{ borderBottom: `1px solid ${colors.borderLight}` }}
                            >
                              <td style={{ padding: '0.5rem', color: colors.text }}>
                                {geneInfo?.name ?? gene.locusTag ?? `Gene ${gene.geneId}`}
                              </td>
                              <td
                                style={{
                                  padding: '0.5rem',
                                  textAlign: 'right',
                                  color: getAdaptationColor(gene.cai ?? 0),
                                  fontWeight: 500,
                                }}
                              >
                                {gene.cai?.toFixed(3) ?? '-'}
                              </td>
                              <td
                                style={{
                                  padding: '0.5rem',
                                  textAlign: 'right',
                                  color: getAdaptationColor(gene.tai ?? 0),
                                }}
                              >
                                {gene.tai?.toFixed(3) ?? '-'}
                              </td>
                              <td style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                                {gene.cpb?.toFixed(3) ?? '-'}
                              </td>
                              <td style={{ padding: '0.5rem', textAlign: 'right', color: colors.textMuted }}>
                                {gene.encPrime?.toFixed(1) ?? '-'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {selectedHost && selectedHostGenes.length === 0 && (
                  <div style={{ padding: '1rem', textAlign: 'center', color: colors.textMuted }}>
                    No gene data for this host
                  </div>
                )}
              </>
            )}

            {/* Metric explanations */}
            <div
              style={{
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
                fontSize: '0.7rem',
                color: colors.textDim,
              }}
            >
              <strong>Metrics:</strong>
              <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                <li>
                  <strong>CAI</strong> - Codon Adaptation Index (0-1): Higher = better codon usage match
                </li>
                <li>
                  <strong>TAI</strong> - tRNA Adaptation Index (0-1): Higher = better tRNA availability
                </li>
                <li>
                  <strong>CPB</strong> - Codon Pair Bias: Measures codon pair usage preferences
                </li>
                <li>
                  <strong>Nc'</strong> - Effective Number of Codons: Lower = stronger codon bias
                </li>
              </ul>
            </div>

            {/* Color legend */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                alignItems: 'center',
                fontSize: '0.75rem',
              }}
            >
              <span style={{ color: colors.textMuted }}>Adaptation:</span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {[
                  { label: 'Low', value: 0.1 },
                  { label: 'Med', value: 0.5 },
                  { label: 'High', value: 0.9 },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span
                      style={{
                        width: '10px',
                        height: '10px',
                        backgroundColor: getAdaptationColor(value),
                        borderRadius: '2px',
                      }}
                    />
                    <span style={{ color: colors.textMuted }}>{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default CodonAdaptationOverlay;
