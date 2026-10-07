/**
 * MosaicRadarOverlay - Recombination & Mosaic Detection
 *
 * Visualizes mosaic/chimeric structure in phage genomes by comparing
 * against reference genomes and identifying recombination breakpoints.
 */

import React, { useMemo, useState, useCallback, useEffect } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds, getKeyboardManager, type HotkeyDefinition } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useIsTopOverlay, useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import {
  OverlayLoadingState,
  OverlayEmptyState,
} from './primitives';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';
import {
  computeMosaicRadar,
  type ReferenceSketch,
  type MosaicRadarResult,
  type MosaicSegment,
} from '@phage-explorer/core';

// Color palette for donors (distinct, accessible colors)
const DONOR_PALETTE = [
  '#3b82f6', // Blue
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#f97316', // Orange
];

interface MosaicRadarOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface MosaicInputs {
  repository: PhageRepository;
  phage: PhageFull;
  sequence: string;
  references: ReferenceSketch[];
}

function requireActiveRead(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Mosaic input read cancelled', 'AbortError');
}

async function readSequence(
  repository: PhageRepository,
  phageId: number,
  signal: AbortSignal,
  maxLength = Infinity
): Promise<string> {
  requireActiveRead(signal);
  const length = await repository.getFullGenomeLength(phageId);
  requireActiveRead(signal);
  const sequence = await repository.getSequenceWindow(phageId, 0, Math.min(length, maxLength));
  requireActiveRead(signal);
  return sequence;
}

// Build reference list from phage database
async function buildReferenceList(
  repository: PhageRepository,
  currentPhageId: number,
  signal: AbortSignal
): Promise<ReferenceSketch[]> {
  requireActiveRead(signal);
  const phages = await repository.listPhages();
  requireActiveRead(signal);
  // Preserve the bounded panel: at most 30 other genomes, up to 150kb each.
  const limited = phages.filter((p) => p.id !== currentPhageId).slice(0, 30);
  const results = await Promise.all(limited.map(async (p) => {
    try {
      const sequence = await readSequence(repository, p.id, signal, 150000);
      return { label: p.name || `Phage #${p.id}`, sequence };
    } catch {
      // A failed reference can be skipped, but a superseded panel must stop reading.
      requireActiveRead(signal);
      return null;
    }
  }));
  requireActiveRead(signal);
  return results.filter((r): r is ReferenceSketch => r !== null);
}

// Get donor statistics from result
function getDonorStats(result: MosaicRadarResult, genomeLength: number): Array<{
  donor: string;
  coverage: number;
  meanScore: number;
  color: string;
}> {
  const donorSet = new Set<string>();
  for (const seg of result.segments) {
    if (seg.donor) donorSet.add(seg.donor);
  }
  const donors = Array.from(donorSet);

  const stats = donors.map((donor, i) => {
    const segs = result.segments.filter((s) => s.donor === donor);
    const totalBp = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
    const weightedScore = segs.reduce(
      (acc, s) => acc + s.meanScore * (s.end - s.start),
      0
    );
    return {
      donor,
      coverage: totalBp / Math.max(1, genomeLength),
      meanScore: weightedScore / Math.max(1, totalBp),
      color: DONOR_PALETTE[i % DONOR_PALETTE.length],
    };
  });

  return stats.sort((a, b) => b.coverage - a.coverage);
}

export function MosaicRadarOverlay({
  repository,
  currentPhage,
}: MosaicRadarOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const isTopmost = useIsTopOverlay('mosaicRadar');
  const overlayOpen = isOpen('mosaicRadar');
  const shouldCaptureHotkeys = overlayOpen && isTopmost;
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('mosaicRadar');

  // Query and donor panel must be accepted together from the exact current source.
  // Numeric phage IDs are reused by replacement private repositories.
  const [inputSnapshot, setInputSnapshot] = useState<MosaicInputs | null>(null);
  const inputs = overlayOpen && inputSnapshot?.repository === repository &&
    inputSnapshot?.phage === currentPhage ? inputSnapshot : null;
  const sequence = inputs?.sequence ?? '';
  const references = inputs?.references ?? [];
  const loading = overlayOpen && !!repository && !!currentPhage && !inputs;

  // Analysis parameters
  const [k, setK] = useState(5);
  const [windowSize, setWindowSize] = useState(2000);
  const [minSimilarity, setMinSimilarity] = useState(0.05);
  const [showBreakpoints, setShowBreakpoints] = useState(true);

  const [hoverSnapshot, setHoverSnapshot] = useState<{
    analysis: MosaicRadarResult;
    info: GenomeTrackInteraction;
  } | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<{
    analysis: MosaicRadarResult;
    segment: MosaicSegment;
  } | null>(null);

  // Hotkey to toggle overlay (Alt+M to avoid conflict with StructureConstraint)
  useHotkey(
    ActionIds.OverlayMosaicRadar,
    () => toggle('mosaicRadar'),
    { modes: ['NORMAL'] }
  );

  // Keyboard controls
  useEffect(() => {
    if (!shouldCaptureHotkeys) return;
    if (typeof window === 'undefined') return;

    const manager = getKeyboardManager();

    const definitions: HotkeyDefinition[] = [
      // Window size
      {
        combo: { key: '+' },
        description: 'Mosaic radar: increase window size',
        action: () => setWindowSize((w) => Math.min(10000, Math.round(w * 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '=' },
        description: 'Mosaic radar: increase window size',
        action: () => setWindowSize((w) => Math.min(10000, Math.round(w * 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '-' },
        description: 'Mosaic radar: decrease window size',
        action: () => setWindowSize((w) => Math.max(500, Math.round(w / 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: '_' },
        description: 'Mosaic radar: decrease window size',
        action: () => setWindowSize((w) => Math.max(500, Math.round(w / 1.25))),
        modes: ['NORMAL'],
        priority: 10,
      },
      // K-mer size
      {
        combo: { key: '[' },
        description: 'Mosaic radar: decrease k',
        action: () => setK((v) => Math.max(3, v - 1)),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: ']' },
        description: 'Mosaic radar: increase k',
        action: () => setK((v) => Math.min(8, v + 1)),
        modes: ['NORMAL'],
        priority: 10,
      },
      // Breakpoints toggle
      {
        combo: { key: 'b' },
        description: 'Mosaic radar: toggle breakpoints',
        action: () => setShowBreakpoints((v) => !v),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: 'b', modifiers: { shift: true } },
        description: 'Mosaic radar: toggle breakpoints',
        action: () => setShowBreakpoints((v) => !v),
        modes: ['NORMAL'],
        priority: 10,
      },
      // Similarity threshold
      {
        combo: { key: 'm' },
        description: 'Mosaic radar: decrease min similarity',
        action: () => setMinSimilarity((s) => Math.max(0.01, +(s - 0.02).toFixed(2))),
        modes: ['NORMAL'],
        priority: 10,
      },
      {
        combo: { key: 'm', modifiers: { shift: true } },
        description: 'Mosaic radar: increase min similarity',
        action: () => setMinSimilarity((s) => Math.min(0.95, +(s + 0.02).toFixed(2))),
        modes: ['NORMAL'],
        priority: 10,
      },
    ];

    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [shouldCaptureHotkeys]);

  // Fetch sequence and references when overlay opens
  useEffect(() => {
    setInputSnapshot(null);
    if (!overlayOpen || !repository || !currentPhage) return;

    const controller = new AbortController();
    const { signal } = controller;

    Promise.all([
      readSequence(repository, currentPhage.id, signal),
      buildReferenceList(repository, currentPhage.id, signal),
    ])
      .then(([sequence, references]) => {
        if (signal.aborted) return;
        setInputSnapshot({ repository, phage: currentPhage, sequence, references });
      })
      .catch(() => {
        if (signal.aborted) return;
        setInputSnapshot({ repository, phage: currentPhage, sequence: '', references: [] });
        controller.abort();
      });

    return () => controller.abort();
  }, [overlayOpen, repository, currentPhage]);

  // Run mosaic analysis
  const analysis = useMemo<MosaicRadarResult | null>(() => {
    if (!inputs?.sequence || inputs.references.length === 0) return null;
    return computeMosaicRadar(inputs.sequence, inputs.references, {
      k,
      window: windowSize,
      step: Math.floor(windowSize / 2),
      minSimilarity,
    });
  }, [inputs, k, windowSize, minSimilarity]);
  const hoverInfo = hoverSnapshot?.analysis === analysis ? hoverSnapshot.info : null;
  const selectedSegment = selectedSnapshot?.analysis === analysis ? selectedSnapshot.segment : null;

  // Get donor statistics
  const donorStats = useMemo(() => {
    if (!analysis) return [];
    return getDonorStats(analysis, sequence.length);
  }, [analysis, sequence.length]);

  // Build color map for donors
  const donorColorMap = useMemo(() => {
    const map = new Map<string, string>();
    donorStats.forEach((s) => map.set(s.donor, s.color));
    return map;
  }, [donorStats]);

  // Convert segments to track segments
  const mosaicSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis) return [];
    return analysis.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      label: seg.donor ? `${seg.donor} (J=${seg.meanScore.toFixed(2)})` : 'Unknown',
      color: seg.donor ? donorColorMap.get(seg.donor) ?? colors.textMuted : colors.textMuted,
      height: 20,
      data: seg,
    }));
  }, [analysis, donorColorMap, colors.textMuted]);

  // Breakpoint markers
  const breakpointSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis || !showBreakpoints) return [];
    return analysis.breakpoints.map((bp) => ({
      start: Math.max(0, bp - 100),
      end: Math.min(sequence.length, bp + 100),
      label: `Breakpoint: ${bp.toLocaleString()}`,
      color: colors.warning,
      height: 30,
      data: { breakpoint: bp },
    }));
  }, [analysis, showBreakpoints, colors.warning, sequence.length]);

  // Handle track hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    if (!analysis || !info || (info.segment && !analysis.segments.some((seg) => seg === info.segment?.data))) {
      setHoverSnapshot(null);
      return;
    }
    setHoverSnapshot({ analysis, info });
  }, [analysis]);

  // Handle track click
  const handleClick = useCallback((info: GenomeTrackInteraction) => {
    if (!analysis) return;
    const segment = analysis.segments.find((seg) => seg === info.segment?.data);
    if (segment) setSelectedSnapshot({ analysis, segment });
  }, [analysis]);

  if (!isOpen('mosaicRadar')) return null;

  return (
    <Overlay
      id="mosaicRadar"
      title="MOSAIC / RECOMBINATION RADAR"
      hotkey="Alt+M"
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
            <strong style={{ color: colors.accent }}>Mosaic Detection</strong>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="Learn about mosaic phages"
                tooltip={
                  overlayHelp?.summary ??
                  'Phage genomes are often chimeric - assembled from pieces of different ancestral phages through recombination.'
                }
                onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'mosaic-genome')}
              />
            )}
          </div>
          <div>
            Detects mosaic/chimeric structure by comparing k-mer similarity against reference genomes.
            Different colors indicate regions most similar to different reference phages. Breakpoints
            mark where the closest reference changes.
          </div>
        </div>

        {loading ? (
          <OverlayLoadingState message="Loading sequence and references...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : !analysis ? (
          <OverlayEmptyState
            message={
              !sequence
                ? 'No sequence loaded'
                : references.length === 0
                  ? 'No reference genomes available'
                  : 'Analysis error'
            }
            hint={
              !sequence
                ? 'Select a phage to analyze.'
                : references.length === 0
                  ? 'Mosaic detection requires at least one reference genome in the database.'
                  : 'Try adjusting analysis parameters.'
            }
          />
        ) : (
          <>
            {/* Parameter controls */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.75rem',
                color: colors.textMuted,
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '4px',
              }}
            >
              <span>k={k}</span>
              <span>window={windowSize}bp</span>
              <span>minSim={minSimilarity}</span>
              <span style={{ color: colors.textDim }}>
                [+/-] window | [/] k | [b] breakpoints {showBreakpoints ? 'on' : 'off'} | [m/M]
                minSim
              </span>
            </div>

            {/* Mosaic Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <span>Mosaic Structure (click segment for details)</span>
                {beginnerModeEnabled && (
                  <InfoButton
                    size="sm"
                    label="What do colors mean?"
                    tooltip="Each color represents a different reference genome. Regions with the same color are most similar to the same reference."
                    onClick={() => showContextFor('mosaic-genome')}
                  />
                )}
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={mosaicSegments}
                width={540}
                height={50}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="Mosaic structure track"
              />
            </div>

            {/* Breakpoint Track */}
            {showBreakpoints && analysis.breakpoints.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: colors.textMuted,
                    marginBottom: '0.25rem',
                  }}
                >
                  Breakpoints ({analysis.breakpoints.length})
                </div>
                <GenomeTrack
                  genomeLength={sequence.length}
                  segments={breakpointSegments}
                  width={540}
                  height={30}
                  ariaLabel="Breakpoint markers"
                />
              </div>
            )}

            {/* Hover tooltip */}
            {hoverInfo && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                Position: {Math.round(hoverInfo.position).toLocaleString()} bp
                {hoverInfo.segment && (
                  <span style={{ marginLeft: '1rem', color: colors.textMuted }}>
                    {hoverInfo.segment.label}
                  </span>
                )}
              </div>
            )}

            {/* Selected segment details */}
            {selectedSegment && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${
                    selectedSegment.donor
                      ? donorColorMap.get(selectedSegment.donor) ?? colors.border
                      : colors.border
                  }`,
                  borderRadius: '4px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                      {selectedSegment.donor ?? 'Unknown donor'}
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
                      Position: {selectedSegment.start.toLocaleString()} -{' '}
                      {selectedSegment.end.toLocaleString()} bp
                    </div>
                    <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
                      Size: {(selectedSegment.end - selectedSegment.start).toLocaleString()} bp
                    </div>
                    <div style={{ color: colors.textDim, fontSize: '0.7rem' }}>
                      Mean Jaccard: {selectedSegment.meanScore.toFixed(3)}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedSnapshot(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.textMuted,
                      cursor: 'pointer',
                      fontSize: '1rem',
                    }}
                  >
                    x
                  </button>
                </div>
              </div>
            )}

            {/* Donor Legend */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.5rem',
                  fontWeight: 'bold',
                }}
              >
                Donor segments:
              </div>
              {donorStats.length === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>
                  No confident donors at current minSim threshold.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {donorStats.map((stat) => (
                    <div
                      key={stat.donor}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.75rem',
                      }}
                    >
                      <span
                        style={{
                          width: '12px',
                          height: '12px',
                          backgroundColor: stat.color,
                          borderRadius: '2px',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: stat.color, fontWeight: 500 }}>{stat.donor}</span>
                      <span style={{ color: colors.textMuted }}>
                        {(stat.coverage * 100).toFixed(1)}% coverage
                      </span>
                      <span style={{ color: colors.textDim }}>
                        J={stat.meanScore.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Breakpoint list */}
            {analysis.breakpoints.length > 0 && (
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                }}
              >
                <span style={{ color: colors.textDim }}>
                  Breakpoints: {analysis.breakpoints.map((b) => b.toLocaleString()).join(', ')}
                </span>
              </div>
            )}

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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                <strong>Interpretation:</strong>
                {beginnerModeEnabled && (
                  <InfoButton
                    size="sm"
                    label="Learn about mosaic interpretation"
                    tooltip="Mosaic structure reveals evolutionary history. Multi-colored genomes acquired genes from multiple ancestral phages."
                    onClick={() => showContextFor('mosaic-genome')}
                  />
                )}
              </span>{' '}
              Colors show which reference genome each region is most similar to. Breakpoints indicate
              recombination boundaries where the closest match changes. Multiple colors suggest a
              chimeric genome assembled from different phage lineages.
            </div>

            {/* Reference count */}
            <div
              style={{
                fontSize: '0.7rem',
                color: colors.textMuted,
                textAlign: 'right',
              }}
            >
              Compared against {references.length} reference{references.length !== 1 ? 's' : ''}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default MosaicRadarOverlay;
