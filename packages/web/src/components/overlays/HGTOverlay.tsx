/**
 * HGTOverlay - Horizontal Gene Transfer Island Detection
 *
 * Visualizes potential HGT islands using compositional analysis:
 * - GC% deviation from genome average
 * - Dinucleotide bias anomalies
 * - Composite HGT probability scoring
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';
import { computeDinucleotideFrequencies } from '@phage-explorer/core';

// HGT probability thresholds
const HGT_LOW = 30;
const HGT_MEDIUM = 50;
const HGT_HIGH = 70;

// Calculate GC content of a sequence
function calculateGC(seq: string): number {
  const upper = seq.toUpperCase();
  let gc = 0;
  let total = 0;
  for (const c of upper) {
    if ('ACGT'.includes(c)) {
      total++;
      if (c === 'G' || c === 'C') gc++;
    }
  }
  return total > 0 ? gc / total : 0.5;
}

// Calculate dinucleotide relative abundance (ρ-statistic / Karlin signature)
function calculateKarlinSignature(
  windowFreqs: number[],
  genomeFreqs: number[]
): number {
  let sumDiff = 0;
  for (let i = 0; i < windowFreqs.length; i++) {
    const expected = genomeFreqs[i];
    const observed = windowFreqs[i];
    if (expected > 0.001) {
      sumDiff += Math.abs(observed - expected);
    }
  }
  return sumDiff;
}

// HGT island detection result
interface HGTIsland {
  start: number;
  end: number;
  gcDeviation: number;
  karlinDeviation: number;
  hgtScore: number;
  features: string[];
}

// Window analysis result
interface WindowAnalysis {
  start: number;
  end: number;
  gc: number;
  gcDeviation: number;
  karlinDeviation: number;
}

// Analyze genome for HGT islands
function analyzeHGT(
  sequence: string,
  windowSize: number,
  stepSize: number
): { windows: WindowAnalysis[]; islands: HGTIsland[]; genomeGC: number } {
  if (sequence.length < windowSize * 2) {
    return { windows: [], islands: [], genomeGC: 0.5 };
  }

  const genomeGC = calculateGC(sequence);
  const genomeFreqs = computeDinucleotideFrequencies(sequence);

  // Sliding window analysis
  const windows: WindowAnalysis[] = [];
  for (let start = 0; start + windowSize <= sequence.length; start += stepSize) {
    const windowSeq = sequence.slice(start, start + windowSize);
    const gc = calculateGC(windowSeq);
    const gcDeviation = gc - genomeGC;
    const windowFreqs = computeDinucleotideFrequencies(windowSeq);
    const karlinDeviation = calculateKarlinSignature(windowFreqs, genomeFreqs);

    windows.push({
      start,
      end: start + windowSize,
      gc,
      gcDeviation,
      karlinDeviation,
    });
  }

  // Detect islands by finding runs of anomalous windows
  const islands: HGTIsland[] = [];
  let islandStart: number | null = null;
  let islandWindows: WindowAnalysis[] = [];

  // Compute thresholds (mean + 2*std)
  const gcDeviations = windows.map((w) => Math.abs(w.gcDeviation));
  const karlinDeviations = windows.map((w) => w.karlinDeviation);

  const gcMean = gcDeviations.reduce((a, b) => a + b, 0) / gcDeviations.length;
  const gcStd = Math.sqrt(
    gcDeviations.reduce((a, b) => a + Math.pow(b - gcMean, 2), 0) / gcDeviations.length
  );
  const gcThreshold = gcMean + 1.5 * gcStd;

  const karlinMean = karlinDeviations.reduce((a, b) => a + b, 0) / karlinDeviations.length;
  const karlinStd = Math.sqrt(
    karlinDeviations.reduce((a, b) => a + Math.pow(b - karlinMean, 2), 0) / karlinDeviations.length
  );
  const karlinThreshold = karlinMean + 1.5 * karlinStd;

  for (const w of windows) {
    const isAnomalous =
      Math.abs(w.gcDeviation) > gcThreshold || w.karlinDeviation > karlinThreshold;

    if (isAnomalous) {
      if (islandStart === null) {
        islandStart = w.start;
        islandWindows = [w];
      } else {
        islandWindows.push(w);
      }
    } else if (islandStart !== null) {
      // End of island
      const avgGcDev =
        islandWindows.reduce((a, b) => a + Math.abs(b.gcDeviation), 0) / islandWindows.length;
      const avgKarlin =
        islandWindows.reduce((a, b) => a + b.karlinDeviation, 0) / islandWindows.length;

      // Calculate HGT score (0-100)
      const gcScore = Math.min(100, (avgGcDev / 0.1) * 30); // 30% weight
      const karlinScore = Math.min(100, (avgKarlin / 0.5) * 30); // 30% weight
      const lengthBonus = Math.min(20, islandWindows.length * 2); // Length bonus
      const hgtScore = Math.min(100, gcScore + karlinScore + lengthBonus);

      if (hgtScore >= HGT_LOW) {
        islands.push({
          start: islandStart,
          end: islandWindows[islandWindows.length - 1].end,
          gcDeviation: avgGcDev,
          karlinDeviation: avgKarlin,
          hgtScore,
          features: [],
        });
      }

      islandStart = null;
      islandWindows = [];
    }
  }

  // Handle trailing island
  if (islandStart !== null && islandWindows.length > 0) {
    const avgGcDev =
      islandWindows.reduce((a, b) => a + Math.abs(b.gcDeviation), 0) / islandWindows.length;
    const avgKarlin =
      islandWindows.reduce((a, b) => a + b.karlinDeviation, 0) / islandWindows.length;
    const gcScore = Math.min(100, (avgGcDev / 0.1) * 30);
    const karlinScore = Math.min(100, (avgKarlin / 0.5) * 30);
    const lengthBonus = Math.min(20, islandWindows.length * 2);
    const hgtScore = Math.min(100, gcScore + karlinScore + lengthBonus);

    if (hgtScore >= HGT_LOW) {
      islands.push({
        start: islandStart,
        end: islandWindows[islandWindows.length - 1].end,
        gcDeviation: avgGcDev,
        karlinDeviation: avgKarlin,
        hgtScore,
        features: [],
      });
    }
  }

  return { windows, islands, genomeGC };
}

// Get color for HGT score
function hgtScoreColor(score: number): string {
  if (score >= HGT_HIGH) return '#ef4444'; // Red - high probability
  if (score >= HGT_MEDIUM) return '#f59e0b'; // Orange - medium
  return '#22c55e'; // Green - low
}

// Get color for GC deviation
function gcDeviationColor(deviation: number): string {
  const absDeviation = Math.abs(deviation);
  if (absDeviation > 0.08) return deviation > 0 ? '#3b82f6' : '#ef4444'; // Strong deviation
  if (absDeviation > 0.04) return deviation > 0 ? '#60a5fa' : '#f87171'; // Moderate
  return '#9ca3af'; // Normal
}

interface HGTOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component for island details
function IslandTooltip({
  island,
  colors,
}: {
  island: HGTIsland;
  colors: { textMuted: string; textDim: string };
}): React.ReactElement {
  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        Putative HGT Island
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        Position: {island.start.toLocaleString()} - {island.end.toLocaleString()} bp
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        Size: {(island.end - island.start).toLocaleString()} bp
      </div>
      <div
        style={{
          marginTop: '0.25rem',
          color: hgtScoreColor(island.hgtScore),
          fontWeight: 'bold',
        }}
      >
        HGT Score: {island.hgtScore.toFixed(0)}/100
      </div>
      <div style={{ color: colors.textDim, fontSize: '0.7rem' }}>
        GC deviation: {(island.gcDeviation * 100).toFixed(1)}%
      </div>
      <div style={{ color: colors.textDim, fontSize: '0.7rem' }}>
        Karlin σ: {island.karlinDeviation.toFixed(3)}
      </div>
    </>
  );
}

export function HGTOverlay({
  repository,
  currentPhage,
}: HGTOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Analysis parameters
  const [windowSize, setWindowSize] = useState(500);
  const [stepSize] = useState(250);

  // Selected island for details
  const [selectedIsland, setSelectedIsland] = useState<HGTIsland | null>(null);

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+H)
  useHotkey(
    { key: 'h', modifiers: { alt: true } },
    'HGT Island Detection',
    () => toggle('hgt'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('hgt')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    const phageId = currentPhage.id;

    // Check cache first
    if (sequenceCache.current.has(phageId)) {
      setSequence(sequenceCache.current.get(phageId) ?? '');
      return;
    }

    setLoading(true);
    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        sequenceCache.current.set(phageId, seq);
        setSequence(seq);
      })
      .catch(() => setSequence(''))
      .finally(() => setLoading(false));
  }, [isOpen, repository, currentPhage]);

  // Run HGT analysis
  const analysis = useMemo(() => {
    if (!sequence || sequence.length < windowSize * 2) return null;
    return analyzeHGT(sequence, windowSize, stepSize);
  }, [sequence, windowSize, stepSize]);

  // Convert islands to track segments
  const islandSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis) return [];
    return analysis.islands.map((island) => ({
      start: island.start,
      end: island.end,
      label: `HGT Score: ${island.hgtScore.toFixed(0)}`,
      color: hgtScoreColor(island.hgtScore),
      height: Math.max(10, Math.min(24, island.hgtScore / 4)),
      data: island,
    }));
  }, [analysis]);

  // Convert windows to GC deviation track
  const gcSegments = useMemo((): GenomeTrackSegment[] => {
    if (!analysis) return [];
    return analysis.windows.map((w) => ({
      start: w.start,
      end: w.end,
      label: `GC: ${(w.gc * 100).toFixed(1)}%`,
      color: gcDeviationColor(w.gcDeviation),
      height: Math.min(20, Math.abs(w.gcDeviation) * 200),
      data: w,
    }));
  }, [analysis]);

  // Handle track hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    setHoverInfo(info);
  }, []);

  // Handle track click
  const handleClick = useCallback((info: GenomeTrackInteraction) => {
    if (info.segment?.data) {
      const island = info.segment.data as HGTIsland;
      if ('hgtScore' in island) {
        setSelectedIsland(island);
      }
    }
  }, []);

  if (!isOpen('hgt')) return null;

  return (
    <Overlay
      id="hgt"
      title="HGT ISLAND DETECTION"
      icon="H"
      hotkey="Alt+H"
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
          <strong style={{ color: colors.accent }}>HGT Detection</strong>: Identifies
          putative horizontal gene transfer islands based on compositional anomalies.
          Regions with atypical GC content or dinucleotide bias may indicate recent
          acquisition from other organisms.
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Loading sequence...
          </div>
        ) : !analysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            {!sequence ? 'No sequence loaded' : 'Sequence too short for analysis'}
          </div>
        ) : (
          <>
            {/* Controls */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                fontSize: '0.8rem',
              }}
            >
              <label style={{ color: colors.textMuted }}>
                Window:
                <select
                  value={windowSize}
                  onChange={(e) => setWindowSize(Number(e.target.value))}
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.25rem',
                    backgroundColor: colors.backgroundAlt,
                    color: colors.text,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '3px',
                  }}
                >
                  <option value={250}>250 bp</option>
                  <option value={500}>500 bp</option>
                  <option value={1000}>1000 bp</option>
                  <option value={2000}>2000 bp</option>
                </select>
              </label>

              <span style={{ color: colors.textMuted }}>
                Genome GC: {(analysis.genomeGC * 100).toFixed(1)}% |{' '}
                {analysis.islands.length} island{analysis.islands.length !== 1 ? 's' : ''} detected
              </span>
            </div>

            {/* Island Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                }}
              >
                HGT Islands (click for details)
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={islandSegments}
                width={540}
                height={50}
                onHover={handleHover}
                onClick={handleClick}
                ariaLabel="HGT island track"
              />
            </div>

            {/* GC Deviation Track */}
            <div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: colors.textMuted,
                  marginBottom: '0.25rem',
                }}
              >
                GC% Deviation (blue = high GC, red = low GC)
              </div>
              <GenomeTrack
                genomeLength={sequence.length}
                segments={gcSegments}
                width={540}
                height={40}
                onHover={handleHover}
                ariaLabel="GC deviation track"
              />
            </div>

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

            {/* Selected island details */}
            {selectedIsland && (
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${hgtScoreColor(selectedIsland.hgtScore)}`,
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
                  <IslandTooltip island={selectedIsland} colors={colors} />
                  <button
                    onClick={() => setSelectedIsland(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.textMuted,
                      cursor: 'pointer',
                      fontSize: '1rem',
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            {/* Legend */}
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                fontSize: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#22c55e',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ color: colors.textMuted }}>Low (&lt;{HGT_MEDIUM})</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#f59e0b',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ color: colors.textMuted }}>Medium ({HGT_MEDIUM}-{HGT_HIGH})</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: '#ef4444',
                    borderRadius: '2px',
                  }}
                />
                <span style={{ color: colors.textMuted }}>High (&gt;{HGT_HIGH})</span>
              </div>
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
              <strong>Interpretation:</strong> High scores indicate regions with compositional
              signatures inconsistent with the bulk genome. These may represent recent horizontal
              transfer events, prophages, mobile elements, or regions under different selection
              pressures. Consider in context with gene annotations.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default HGTOverlay;
