/**
 * CodonAdaptationOverlay - Host Codon Adaptation Analysis
 *
 * Visualizes how well phage codon usage matches different bacterial hosts.
 * Uses pre-computed CAI/TAI scores from the annotation pipeline.
 */

import React, { useMemo, useState, useEffect } from 'react';
import {
  analyzePhageHostCodonAdaptation,
  type PhageFull,
  type PhageHostAdaptationResult,
} from '@phage-explorer/core';
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
export function getAdaptationColor(score: number): string {
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
  const [viewMode, setViewMode] = useState<'summary' | 'genes' | 'codon_pair_lens'>('summary');
  const [selectedModuleFilter, setSelectedModuleFilter] = useState<string>('all');

  const adaptationLens = useMemo((): PhageHostAdaptationResult | null => {
    if (!currentPhage) return null;
    return analyzePhageHostCodonAdaptation(currentPhage);
  }, [currentPhage]);

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
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
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
                type="button"
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
              <button
                type="button"
                onClick={() => setViewMode('codon_pair_lens')}
                style={{
                  padding: '0.25rem 0.75rem',
                  backgroundColor: viewMode === 'codon_pair_lens' ? colors.accent : colors.backgroundAlt,
                  color: viewMode === 'codon_pair_lens' ? '#fff' : colors.text,
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: viewMode === 'codon_pair_lens' ? 'bold' : 'normal',
                }}
              >
                Codon-Pair Adaptation Lens
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

                      {/* CPB bar */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.7rem', color: colors.textMuted, width: '30px' }}>
                          CPB
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
                              width: `${Math.max(0, Math.min(100, (host.avgCpb + 0.15) / 0.3 * 100))}%`,
                              height: '100%',
                              backgroundColor: host.avgCpb >= 0 ? '#22c55e' : '#f59e0b',
                            }}
                          />
                        </div>
                        <span style={{ fontSize: '0.7rem', color: colors.text, width: '35px' }}>
                          {host.avgCpb.toFixed(2)}
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
            ) : viewMode === 'genes' ? (
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
            ) : (
              /* Codon-Pair Adaptation Lens (Roadmap #44) */
              adaptationLens && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* Hero / Summary Banner */}
                  <div
                    style={{
                      padding: '0.75rem 1rem',
                      backgroundColor: colors.backgroundAlt ?? '#0f172a',
                      borderRadius: '6px',
                      border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <strong style={{ color: colors.accent ?? '#38bdf8', fontSize: '0.95rem' }}>
                          Translational Compatibility & Tropism Lens
                        </strong>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontFamily: 'monospace',
                            padding: '0.15rem 0.4rem',
                            backgroundColor: `${colors.accent ?? '#38bdf8'}22`,
                            color: colors.accent ?? '#38bdf8',
                            borderRadius: '3px',
                          }}
                        >
                          Roadmap #44
                        </span>
                      </div>

                      <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                        <span>Primary Host: <strong style={{ color: colors.text ?? '#f8fafc' }}>{adaptationLens.primaryHost}</strong></span>
                        <span>Top Match: <strong style={{ color: colors.success ?? '#22c55e' }}>{adaptationLens.hostRankings[0]?.hostName}</strong></span>
                      </div>
                    </div>

                    <div style={{ fontSize: '0.8rem', color: colors.textDim ?? '#94a3b8', lineHeight: 1.4 }}>
                      {adaptationLens.summary}
                    </div>
                  </div>

                  {/* Multi-Host Compatibility Rankings */}
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: colors.text ?? '#f8fafc', marginBottom: '0.4rem' }}>
                      Candidate Bacterial Host Translational Rankings ({adaptationLens.hostRankings.length} Hosts)
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                        gap: '0.6rem',
                      }}
                    >
                      {adaptationLens.hostRankings.map((hr, idx) => {
                        const isTop = idx === 0;
                        return (
                          <div
                            key={hr.hostKey}
                            style={{
                              padding: '0.6rem 0.75rem',
                              backgroundColor: colors.backgroundAlt ?? '#0f172a',
                              borderRadius: '6px',
                              border: `1px solid ${
                                hr.isPrimaryHost
                                  ? (colors.accent ?? '#38bdf8')
                                  : isTop
                                    ? (colors.success ?? '#22c55e')
                                    : (colors.borderLight ?? '#1e293b')
                              }`,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.35rem',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontWeight: 600, fontSize: '0.82rem', color: colors.text ?? '#f8fafc' }}>
                                #{idx + 1} {hr.hostName}
                              </span>
                              {hr.isPrimaryHost && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '3px',
                                    backgroundColor: `${colors.accent ?? '#38bdf8'}33`,
                                    color: colors.accent ?? '#38bdf8',
                                    fontWeight: 'bold',
                                  }}
                                >
                                  PRIMARY
                                </span>
                              )}
                              {!hr.isPrimaryHost && isTop && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '0.1rem 0.35rem',
                                    borderRadius: '3px',
                                    backgroundColor: `${colors.success ?? '#22c55e'}33`,
                                    color: colors.success ?? '#22c55e',
                                    fontWeight: 'bold',
                                  }}
                                >
                                  TOP MATCH
                                </span>
                              )}
                            </div>

                            {/* Compatibility Progress Bar */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <div
                                style={{
                                  flex: 1,
                                  height: '6px',
                                  backgroundColor: colors.background ?? '#020617',
                                  borderRadius: '3px',
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    width: `${hr.overallCompatibility}%`,
                                    height: '100%',
                                    backgroundColor:
                                      hr.overallCompatibility >= 70
                                        ? (colors.success ?? '#22c55e')
                                        : hr.overallCompatibility >= 50
                                          ? (colors.warning ?? '#eab308')
                                          : (colors.error ?? '#ef4444'),
                                  }}
                                />
                              </div>
                              <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', fontWeight: 'bold', color: colors.text ?? '#f8fafc' }}>
                                {hr.overallCompatibility.toFixed(1)}%
                              </span>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', fontFamily: 'monospace', color: colors.textMuted ?? '#64748b' }}>
                              <span>CAI: {hr.meanCai.toFixed(3)}</span>
                              <span>CPB: {hr.meanCpb.toFixed(3)}</span>
                              <span>Z: {hr.meanZScore.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Functional Module Adaptation Status */}
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: colors.text ?? '#f8fafc', marginBottom: '0.4rem' }}>
                      Functional Module Adaptation & Acquisition Status
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '0.6rem',
                      }}
                    >
                      {adaptationLens.modules.map((mod) => {
                        const statusColor =
                          mod.adaptationStatus === 'adapted'
                            ? (colors.success ?? '#22c55e')
                            : mod.adaptationStatus === 'transitional'
                              ? (colors.warning ?? '#eab308')
                              : (colors.error ?? '#ef4444');
                        const statusLabel =
                          mod.adaptationStatus === 'adapted'
                            ? 'Host-Adapted'
                            : mod.adaptationStatus === 'transitional'
                              ? 'Transitional'
                              : 'Mismatched / Acquired';

                        return (
                          <div
                            key={mod.module}
                            style={{
                              padding: '0.6rem 0.75rem',
                              backgroundColor: colors.backgroundAlt ?? '#0f172a',
                              borderRadius: '6px',
                              border: `1px solid ${statusColor}44`,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.35rem',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontWeight: 600, fontSize: '0.8rem', color: colors.text ?? '#f8fafc' }}>
                                {mod.displayName}
                              </span>
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '0.1rem 0.35rem',
                                  borderRadius: '3px',
                                  backgroundColor: `${statusColor}22`,
                                  color: statusColor,
                                  fontWeight: 'bold',
                                }}
                              >
                                {statusLabel}
                              </span>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', fontFamily: 'monospace', color: colors.textDim ?? '#94a3b8' }}>
                              <span>Genes: {mod.geneCount}</span>
                              <span>Mean CAI: {mod.meanCai.toFixed(3)}</span>
                              <span>Mean CPB: {mod.meanCpb.toFixed(3)}</span>
                              <span>Z: {mod.meanZScore.toFixed(2)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Candidate Host-Switching Footprints */}
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: colors.text ?? '#f8fafc', marginBottom: '0.4rem' }}>
                      Candidate Host-Switching Footprints ({adaptationLens.hostSwitchCandidates.length})
                    </div>
                    {adaptationLens.hostSwitchCandidates.length === 0 ? (
                      <div
                        style={{
                          padding: '0.6rem 0.8rem',
                          backgroundColor: colors.backgroundAlt ?? '#0f172a',
                          borderRadius: '6px',
                          border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                          fontSize: '0.75rem',
                          color: colors.textMuted ?? '#64748b',
                        }}
                      >
                        No strong host-switching divergence detected. All viral genes show consistent translational alignment with the primary host profile.
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                          gap: '0.5rem',
                        }}
                      >
                        {adaptationLens.hostSwitchCandidates.map((g) => (
                          <div
                            key={g.geneId}
                            style={{
                              padding: '0.6rem 0.75rem',
                              backgroundColor: colors.backgroundAlt ?? '#0f172a',
                              borderRadius: '6px',
                              border: `1px solid ${(colors.warning ?? '#eab308')}66`,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.3rem',
                              fontSize: '0.75rem',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontWeight: 'bold', color: colors.text ?? '#f8fafc', fontFamily: 'monospace' }}>
                                {g.name} ({g.locusTag})
                              </span>
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '0.1rem 0.35rem',
                                  borderRadius: '3px',
                                  backgroundColor: `${colors.warning ?? '#eab308'}22`,
                                  color: colors.warning ?? '#eab308',
                                  fontWeight: 'bold',
                                }}
                              >
                                ΔCAI +{g.hostSwitchFootprint?.caiDelta.toFixed(3)}
                              </span>
                            </div>
                            <div style={{ color: colors.textMuted ?? '#64748b', fontSize: '0.7rem' }}>
                              {g.product}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: colors.textDim ?? '#94a3b8', fontFamily: 'monospace' }}>
                              <span>Preferred: {g.hostSwitchFootprint?.candidateHost}</span>
                              <span>Significance: {g.hostSwitchFootprint?.significance}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Gene-Level CPB & Z-Score Table */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: colors.text ?? '#f8fafc' }}>
                        Gene Translational Adaptation Matrix ({adaptationLens.genes.length} CDS)
                      </span>

                      {/* Module Filter */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                        <label htmlFor="lens-module-filter" style={{ color: colors.textMuted ?? '#64748b' }}>Module:</label>
                        <select
                          id="lens-module-filter"
                          value={selectedModuleFilter}
                          onChange={(e) => setSelectedModuleFilter(e.target.value)}
                          style={{
                            padding: '0.2rem 0.4rem',
                            backgroundColor: colors.backgroundAlt ?? '#0f172a',
                            color: colors.text ?? '#f8fafc',
                            border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                            borderRadius: '3px',
                            fontSize: '0.75rem',
                          }}
                        >
                          <option value="all">All Modules</option>
                          <option value="structural">Structural</option>
                          <option value="replication">Replication</option>
                          <option value="lysis">Lysis</option>
                          <option value="packaging_regulatory">Packaging & Regulatory</option>
                          <option value="amg_auxiliary">AMGs</option>
                          <option value="unclassified">Unclassified</option>
                        </select>
                      </div>
                    </div>

                    <div
                      style={{
                        maxHeight: '260px',
                        overflowY: 'auto',
                        border: `1px solid ${colors.borderLight ?? '#1e293b'}`,
                        borderRadius: '4px',
                      }}
                    >
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}`, backgroundColor: colors.backgroundAlt ?? '#0f172a', textAlign: 'left', color: colors.textMuted ?? '#64748b' }}>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Gene</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Module</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Codons</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Primary CAI</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Primary CPB</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Z-Score</th>
                            <th style={{ padding: '0.35rem 0.5rem' }}>Best Host</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adaptationLens.genes
                            .filter((g) => selectedModuleFilter === 'all' || g.module === selectedModuleFilter)
                            .map((g) => (
                              <tr key={g.geneId} style={{ borderBottom: `1px solid ${colors.borderLight ?? '#1e293b'}22` }}>
                                <td style={{ padding: '0.35rem 0.5rem', color: colors.text ?? '#f8fafc', fontWeight: 500 }}>
                                  {g.name}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: colors.textMuted ?? '#64748b', textTransform: 'capitalize' }}>
                                  {g.module.replace('_', ' ')}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: colors.textDim ?? '#94a3b8' }}>
                                  {g.codonCount}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: getAdaptationColor(g.primaryHostCai), fontWeight: 'bold' }}>
                                  {g.primaryHostCai.toFixed(3)}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: g.primaryHostCpb >= 0 ? (colors.success ?? '#22c55e') : (colors.warning ?? '#eab308') }}>
                                  {g.primaryHostCpb.toFixed(3)}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: g.primaryHostZScore >= 0 ? (colors.success ?? '#22c55e') : (colors.error ?? '#ef4444') }}>
                                  {g.primaryHostZScore.toFixed(2)}
                                </td>
                                <td style={{ padding: '0.35rem 0.5rem', color: colors.accent ?? '#38bdf8' }}>
                                  {g.bestHost.replace('_', ' ')}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )
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
