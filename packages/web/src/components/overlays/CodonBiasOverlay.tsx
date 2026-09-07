/**
 * CodonBiasOverlay - Codon Usage Bias Analysis
 *
 * Visualizes Relative Synonymous Codon Usage (RSCU) and other
 * composition metrics from a forward frame-zero genome scan.
 */

import React, { useMemo, useState, useEffect } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayToolbar,
  OverlayStatGrid,
  OverlayStatCard,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
  OverlayLegend,
  OverlayLegendItem,
  HowDoIKnowThis,
} from './primitives';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  analyzeCodonBias,
  CODON_FAMILIES,
} from '@phage-explorer/core';
import type { CodonBiasAnalysis, RSCUResult } from '@phage-explorer/core';

// Color for RSCU value (green = preferred, red = avoided)
function rscuColor(rscu: number): string {
  if (rscu >= 1.5) return '#22c55e'; // Strong preference
  if (rscu >= 1.0) return '#86efac'; // Slight preference
  if (rscu >= 0.5) return '#fde047'; // Slight avoidance
  return '#ef4444'; // Strong avoidance
}

// Color intensity based on count
function countOpacity(count: number, maxCount: number): number {
  return Math.max(0.3, Math.min(1, count / (maxCount * 0.5)));
}

interface CodonBiasOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// RSCU bar component
function RSCUBar({
  rscu,
  count,
  maxCount,
  colors,
}: {
  rscu: RSCUResult;
  count: number;
  maxCount: number;
  colors: { textMuted: string; backgroundAlt: string };
}): React.ReactElement {
  const barWidth = Math.min(100, (rscu.rscu / 2) * 100); // Max at RSCU=2
  const color = rscuColor(rscu.rscu);
  const opacity = countOpacity(count, maxCount);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.7rem' }}>
      <span style={{ fontFamily: 'monospace', width: '32px', color: colors.textMuted }}>
        {rscu.codon}
      </span>
      <div
        style={{
          flex: 1,
          height: '12px',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${barWidth}%`,
            height: '100%',
            backgroundColor: color,
            opacity,
            transition: 'width 0.2s',
          }}
        />
      </div>
      <span style={{ width: '36px', textAlign: 'right', color: colors.textMuted }}>
        {rscu.rscu.toFixed(2)}
      </span>
      <span style={{ width: '32px', textAlign: 'right', color: colors.textMuted, fontSize: '0.65rem' }}>
        ({count})
      </span>
    </div>
  );
}

// Amino acid family component
function AminoAcidFamily({
  aminoAcid,
  codons,
  rscuMap,
  maxCount,
  colors,
}: {
  aminoAcid: string;
  codons: string[];
  rscuMap: Map<string, RSCUResult>;
  maxCount: number;
  colors: { text: string; textMuted: string; backgroundAlt: string; borderLight: string };
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.5rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
      }}
    >
      <div
        style={{
          fontWeight: 'bold',
          marginBottom: '0.25rem',
          color: colors.text,
          fontSize: '0.8rem',
        }}
      >
        {aminoAcid} ({codons.length} codons)
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {codons.map(codon => {
          const rscu = rscuMap.get(codon);
          if (!rscu) return null;
          return (
            <RSCUBar
              key={codon}
              rscu={rscu}
              count={rscu.count}
              maxCount={maxCount}
              colors={colors}
            />
          );
        })}
      </div>
    </div>
  );
}

export function CodonBiasOverlay({
  repository,
  currentPhage,
}: CodonBiasOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const [loaded, setLoaded] = useState<{
    repository: PhageRepository; phage: PhageFull; sequence: string;
  } | null>(null);
  const sequence = loaded?.repository === repository && loaded?.phage === currentPhage
    ? loaded.sequence : '';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // View options
  const [viewMode, setViewMode] = useState<'family' | 'ranked'>('family');
  const [filterFamily, setFilterFamily] = useState<string | null>(null);

  // Hotkey to toggle overlay (Alt+U for Usage)
  useHotkey(
    ActionIds.OverlayCodonBias,
    () => toggle('codonBias'),
    { modes: ['NORMAL'] }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('codonBias')) return;
    setLoaded(null);
    setError(null);
    if (!repository || !currentPhage) {
      setLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    let cancelled = false;
    setLoading(true);

    repository
      .getFullGenomeLength(phageId)
      .then(length => cancelled ? '' : repository.getSequenceWindow(phageId, 0, length))
      .then(seq => {
        if (cancelled) return;
        setLoaded({ repository, phage: currentPhage, sequence: seq });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoaded(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  // Compute codon bias analysis
  const analysis = useMemo((): CodonBiasAnalysis | null => {
    if (!sequence || sequence.length < 300) return null;
    return analyzeCodonBias(sequence);
  }, [sequence]);

  // Build RSCU map for quick lookup
  const rscuMap = useMemo(() => {
    if (!analysis) return new Map<string, RSCUResult>();
    return new Map(analysis.rscu.map(r => [r.codon, r]));
  }, [analysis]);

  // Max count for bar scaling
  const maxCount = useMemo(() => {
    if (!analysis) return 1;
    return Math.max(...analysis.rscu.map(r => r.count));
  }, [analysis]);

  // Filtered families based on view
  const displayFamilies = useMemo(() => {
    const families = Object.entries(CODON_FAMILIES)
      .filter(([aa]) => aa !== '*') // Skip stop codons
      .filter(([aa]) => !filterFamily || aa === filterFamily);

    return families;
  }, [filterFamily]);

  // Ranked codons
  const rankedCodons = useMemo(() => {
    if (!analysis) return [];
    return [...analysis.rscu]
      .filter(r => r.aminoAcid !== '*' && r.familySize > 1)
      .sort((a, b) => b.rscu - a.rscu);
  }, [analysis]);

  if (!isOpen('codonBias')) return null;

  const hasData = !!analysis && analysis.totalCodons > 0;
  const isEmpty = !loading && !error && !hasData;

  return (
    <Overlay
      id="codonBias"
      title="CODON USAGE BIAS (RSCU Analysis)"
      hotkey="Alt+U"
      size="lg"
    >
      <OverlayStack>
        {/* Description */}
        <OverlayDescription
          title="Codon Usage Bias"
          action={
            hasData && currentPhage ? (
              <HowDoIKnowThis
                title="Genome Frame-Zero Codon Composition"
                computation="RSCU compares observed triplet counts with equal usage within each synonymous codon family. The complete genome is scanned from its first base in forward frame zero; CDS annotations, reading-frame changes and host tRNA reference data are not used. Nc uses the implementation's simplified Wright-style estimator."
                inputs={[
                  { label: 'Genome', value: `${currentPhage.name} (${currentPhage.accession ?? currentPhage.id})` },
                  { label: 'Total Codons', value: `${analysis.totalCodons.toLocaleString()}` },
                  { label: 'GC3 Bias', value: `${(analysis.gc3Content * 100).toFixed(1)}%` },
                  { label: 'Nc Value', value: `${analysis.effectiveNumberOfCodons.toFixed(1)} (61 possible)` },
                ]}
                implementation={{
                  engine: 'JavaScript',
                  details: 'Frame-zero triplet counts, within-family RSCU and simplified effective codon number estimate with fallback values for codon-family groups lacking sufficient counts',
                }}
                citation={`Phage Explorer counted consecutive triplets in forward frame zero of the complete ${currentPhage.name} genome and calculated within-family RSCU, GC3 and a simplified effective codon number estimate. CDS annotations and host tRNA reference data were not used; these genome-composition statistics do not establish translational adaptation.`}
              />
            ) : undefined
          }
        >
          This view counts consecutive triplets from the first genome base in forward frame zero.
          RSCU &gt; 1.0 indicates above-equal usage within a synonymous family; RSCU &lt; 1.0 indicates below-equal usage.
          CDS annotations and host tRNA reference data are not used, so these statistics alone do not establish translational adaptation.
        </OverlayDescription>

        {/* Loading State */}
        {loading && (
          <OverlayLoadingState message="Analyzing codon usage...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        )}

        {/* Empty State */}
        {error && <OverlayErrorState message="Could not load sequence" details={error} />}
        {isEmpty && (
          <OverlayEmptyState
            message={!sequence ? 'No sequence loaded' : sequence.length < 300
              ? 'Sequence too short for analysis' : 'No complete A/C/G/T triplets in frame zero'}
            hint={sequence.length >= 300
              ? 'Unresolved triplets provide no codon-usage observations. Bias statistics require complete triplets.'
              : 'Select a genome with at least 300 bases to scan.'}
          />
        )}

        {/* Main Content */}
        {hasData && (
          <>
            {/* Summary metrics */}
            <OverlayStatGrid columns={5}>
              <OverlayStatCard
                label="Total Codons"
                value={analysis.totalCodons.toLocaleString()}
              />
              <OverlayStatCard
                label="GC Content"
                value={`${(analysis.gcContent * 100).toFixed(1)}%`}
              />
              <OverlayStatCard
                label="GC3 Content"
                value={`${(analysis.gc3Content * 100).toFixed(1)}%`}
              />
              <OverlayStatCard
                label="Nc (Bias)"
                value={
                  <span style={{ color: analysis.effectiveNumberOfCodons < 40 ? '#22c55e' : undefined }}>
                    {analysis.effectiveNumberOfCodons.toFixed(1)}
                  </span>
                }
              />
              <OverlayStatCard
                label="Bias Score"
                value={
                  <span style={{ color: analysis.biasScore > 0.5 ? '#22c55e' : undefined }}>
                    {(analysis.biasScore * 100).toFixed(0)}%
                  </span>
                }
              />
            </OverlayStatGrid>

            {/* Controls */}
            <OverlayToolbar>
              <label style={{ color: 'var(--color-text-muted)' }}>
                View:
                <select
                  value={viewMode}
                  onChange={e => setViewMode(e.target.value as typeof viewMode)}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: 'var(--color-background-alt)',
                    color: 'var(--color-text)',
                    border: '1px solid var(--color-border-light)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <option value="family">By Amino Acid</option>
                  <option value="ranked">Ranked by RSCU</option>
                </select>
              </label>

              {viewMode === 'family' && (
                <label style={{ color: 'var(--color-text-muted)' }}>
                  Filter:
                  <select
                    value={filterFamily || ''}
                    onChange={e => setFilterFamily(e.target.value || null)}
                    style={{
                      marginLeft: '0.5rem',
                      padding: '0.25rem',
                      backgroundColor: 'var(--color-background-alt)',
                      color: 'var(--color-text)',
                      border: '1px solid var(--color-border-light)',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    <option value="">All Amino Acids</option>
                    {Object.keys(CODON_FAMILIES)
                      .filter(aa => aa !== '*')
                      .map(aa => (
                        <option key={aa} value={aa}>
                          {aa} ({CODON_FAMILIES[aa].length})
                        </option>
                      ))}
                  </select>
                </label>
              )}

              <span style={{ color: 'var(--color-text-muted)' }}>
                Preferred: {analysis.preferredCodons.length} |
                Avoided: {analysis.avoidedCodons.length}
              </span>
            </OverlayToolbar>

            {/* RSCU visualization */}
            {viewMode === 'family' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap: '0.5rem',
                  maxHeight: '400px',
                  overflowY: 'auto',
                }}
              >
                {displayFamilies.map(([aa, codons]) => (
                  <AminoAcidFamily
                    key={aa}
                    aminoAcid={aa}
                    codons={codons}
                    rscuMap={rscuMap}
                    maxCount={maxCount}
                    colors={colors}
                  />
                ))}
              </div>
            ) : (
              <div
                style={{
                  maxHeight: '400px',
                  overflowY: 'auto',
                  padding: '0.5rem',
                  backgroundColor: 'var(--color-background-alt)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '0.25rem 1rem',
                  }}
                >
                  {rankedCodons.map(rscu => (
                    <RSCUBar
                      key={rscu.codon}
                      rscu={rscu}
                      count={rscu.count}
                      maxCount={maxCount}
                      colors={colors}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Legend */}
            <OverlayLegend>
              <OverlayLegendItem
                indicator={<span style={{ width: '12px', height: '12px', display: 'inline-block', backgroundColor: '#22c55e', borderRadius: '2px' }} />}
                color="#22c55e"
                label="Strong Preference (RSCU > 1.5)"
              />
              <OverlayLegendItem
                indicator={<span style={{ width: '12px', height: '12px', display: 'inline-block', backgroundColor: '#86efac', borderRadius: '2px' }} />}
                color="#86efac"
                label="Slight Preference (1.0-1.5)"
              />
              <OverlayLegendItem
                indicator={<span style={{ width: '12px', height: '12px', display: 'inline-block', backgroundColor: '#fde047', borderRadius: '2px' }} />}
                color="#fde047"
                label="Slight Avoidance (0.5-1.0)"
              />
              <OverlayLegendItem
                indicator={<span style={{ width: '12px', height: '12px', display: 'inline-block', backgroundColor: '#ef4444', borderRadius: '2px' }} />}
                color="#ef4444"
                label="Strong Avoidance (< 0.5)"
              />
            </OverlayLegend>

            {/* Interpretation */}
            <OverlayDescription title="Interpretation:" style={{ fontSize: '0.75rem' }}>
              Nc (Effective Number of Codons) ranges from 20 (extreme bias) to 61 (uniform).
              Lower estimates indicate greater skew in the counted triplets. GC3 summarizes their
              third-position GC content. Inferring coding-region usage or host adaptation requires
              CDS and host-reference analysis beyond this frame-zero genome scan.
            </OverlayDescription>
          </>
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default CodonBiasOverlay;
