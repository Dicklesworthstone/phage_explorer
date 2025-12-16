/**
 * NonBDNAOverlay - Non-B-form DNA Structure Detection
 *
 * Detects and visualizes G-quadruplexes, Z-DNA propensity regions,
 * and cruciform-forming inverted repeats in phage genomes.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { GenomeTrack } from './primitives/GenomeTrack';
import type { GenomeTrackSegment, GenomeTrackInteraction } from './primitives/types';

// Non-B-DNA structure types
type StructureType = 'g4' | 'zdna' | 'cruciform';

interface NonBDNAStructure {
  type: StructureType;
  start: number;
  end: number;
  score: number;
  sequence: string;
  details: string;
}

// Z-DNA propensity scores (dinucleotide based, Ho et al. 1986)
const ZDNA_PROPENSITY: Record<string, number> = {
  CG: 125, GC: 125,
  CA: 85, AC: 85, TG: 85, GT: 85,
  TA: 70, AT: 70,
  CC: 50, GG: 50,
  CT: 40, TC: 40, AG: 40, GA: 40,
  AA: 25, TT: 25,
};

// G-quadruplex detection
function findGQuadruplexes(sequence: string): NonBDNAStructure[] {
  const results: NonBDNAStructure[] = [];
  const upper = sequence.toUpperCase();

  // Pattern: G{3,}N{1,7}G{3,}N{1,7}G{3,}N{1,7}G{3,}
  // Simplified: look for regions with 4 G-runs of 3+ Gs separated by 1-7 nt
  const g4Pattern = /G{3,}.{1,7}G{3,}.{1,7}G{3,}.{1,7}G{3,}/gi;

  let match: RegExpExecArray | null;
  while ((match = g4Pattern.exec(upper)) !== null) {
    const seq = match[0];
    const start = match.index;
    const end = start + seq.length;

    // Count G-tetrads (number of consecutive Gs in shortest run)
    const gRuns = seq.match(/G+/g) || [];
    const minGRun = Math.min(...gRuns.map(r => r.length));

    // Score based on G-run length and compactness
    const loopLengths = seq.split(/G+/).filter(s => s.length > 0);
    const avgLoop = loopLengths.reduce((a, b) => a + b.length, 0) / loopLengths.length;
    const score = Math.min(100, (minGRun * 20) + (50 / (1 + avgLoop)));

    if (score >= 40) {
      results.push({
        type: 'g4',
        start,
        end,
        score,
        sequence: seq,
        details: `${minGRun} G-tetrads, loops: ${loopLengths.map(l => l.length).join('-')} nt`,
      });
    }

    // Prevent overlapping matches
    g4Pattern.lastIndex = end;
  }

  return results;
}

// Z-DNA propensity calculation
function findZDNARegions(sequence: string, windowSize: number = 100, threshold: number = 70): NonBDNAStructure[] {
  const results: NonBDNAStructure[] = [];
  const upper = sequence.toUpperCase();

  if (upper.length < windowSize) return results;

  // Sliding window Z-score calculation
  const scores: number[] = [];
  for (let i = 0; i < upper.length - 1; i++) {
    const di = upper.slice(i, i + 2);
    scores.push(ZDNA_PROPENSITY[di] || 0);
  }

  // Find regions with high cumulative Z-propensity
  let inRegion = false;
  let regionStart = 0;
  let regionScore = 0;
  let regionSeq = '';

  for (let i = 0; i <= upper.length - windowSize; i++) {
    // Calculate window score
    let windowScore = 0;
    for (let j = 0; j < windowSize - 1; j++) {
      windowScore += scores[i + j] || 0;
    }
    const avgScore = windowScore / (windowSize - 1);

    if (avgScore >= threshold) {
      if (!inRegion) {
        inRegion = true;
        regionStart = i;
        regionScore = avgScore;
        regionSeq = upper.slice(i, i + windowSize);
      } else {
        regionScore = Math.max(regionScore, avgScore);
      }
    } else {
      if (inRegion) {
        const end = i + windowSize;
        results.push({
          type: 'zdna',
          start: regionStart,
          end,
          score: Math.min(100, regionScore),
          sequence: regionSeq.length > 50 ? regionSeq.slice(0, 47) + '...' : regionSeq,
          details: `Z-propensity: ${regionScore.toFixed(1)}, length: ${end - regionStart} bp`,
        });
        inRegion = false;
      }
    }
  }

  // Close final region
  if (inRegion) {
    const end = upper.length;
    results.push({
      type: 'zdna',
      start: regionStart,
      end,
      score: Math.min(100, regionScore),
      sequence: regionSeq.length > 50 ? regionSeq.slice(0, 47) + '...' : regionSeq,
      details: `Z-propensity: ${regionScore.toFixed(1)}, length: ${end - regionStart} bp`,
    });
  }

  return results;
}

// Cruciform detection (inverted repeats/palindromes)
function findCruciforms(sequence: string, minStem: number = 6, maxLoop: number = 10): NonBDNAStructure[] {
  const results: NonBDNAStructure[] = [];
  const upper = sequence.toUpperCase();
  const complement: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

  // Search for inverted repeats
  for (let i = 0; i < upper.length - (2 * minStem + 1); i++) {
    // Try different loop sizes
    for (let loopSize = 0; loopSize <= maxLoop; loopSize++) {
      // Try different stem sizes
      for (let stemSize = minStem; stemSize <= 20 && (i + 2 * stemSize + loopSize <= upper.length); stemSize++) {
        const leftStem = upper.slice(i, i + stemSize);
        const loopStart = i + stemSize;
        const rightStart = loopStart + loopSize;
        const rightStem = upper.slice(rightStart, rightStart + stemSize);

        // Check if it's a perfect inverted repeat
        let matches = 0;
        for (let j = 0; j < stemSize; j++) {
          if (complement[leftStem[j]] === rightStem[stemSize - 1 - j]) {
            matches++;
          }
        }

        // Allow 1 mismatch per 6 bp
        const allowedMismatches = Math.floor(stemSize / 6);
        if (matches >= stemSize - allowedMismatches && matches >= minStem) {
          const end = rightStart + stemSize;
          const fullSeq = upper.slice(i, end);

          // Calculate GC content of stem (affects stability)
          const gcCount = leftStem.split('').filter(c => c === 'G' || c === 'C').length;
          const gcPercent = (gcCount / stemSize) * 100;

          // Score based on stem length, GC%, and loop size
          const score = Math.min(100, (matches * 4) + (gcPercent * 0.3) - (loopSize * 2));

          if (score >= 40) {
            results.push({
              type: 'cruciform',
              start: i,
              end,
              score,
              sequence: fullSeq.length > 50 ? fullSeq.slice(0, 47) + '...' : fullSeq,
              details: `Stem: ${stemSize} bp (${matches}/${stemSize} match), Loop: ${loopSize} nt, GC: ${gcPercent.toFixed(0)}%`,
            });
          }

          // Skip overlapping structures
          break;
        }
      }
    }
  }

  // Remove duplicates/overlaps (keep highest scoring)
  const filtered: NonBDNAStructure[] = [];
  const sorted = results.sort((a, b) => b.score - a.score);
  for (const struct of sorted) {
    const overlaps = filtered.some(
      s => (struct.start >= s.start && struct.start < s.end) ||
           (struct.end > s.start && struct.end <= s.end)
    );
    if (!overlaps) {
      filtered.push(struct);
    }
  }

  return filtered.sort((a, b) => a.start - b.start);
}

// Convert structures to track segments
function structuresToSegments(
  structures: NonBDNAStructure[],
  type: StructureType,
  color: string
): GenomeTrackSegment[] {
  return structures
    .filter(s => s.type === type)
    .map(s => ({
      start: s.start,
      end: s.end,
      color,
      height: Math.max(6, s.score / 5),
      label: s.details,
      data: s,
    }));
}

interface NonBDNAOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

// Tooltip component
function StructureTooltip({
  structure,
  colors,
}: {
  structure: NonBDNAStructure;
  colors: { textMuted: string; textDim: string; text: string };
}): React.ReactElement {
  const typeLabels: Record<StructureType, string> = {
    g4: 'G-Quadruplex',
    zdna: 'Z-DNA',
    cruciform: 'Cruciform',
  };

  return (
    <>
      <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
        {typeLabels[structure.type]}
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        {structure.start.toLocaleString()} - {structure.end.toLocaleString()} bp
      </div>
      <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>
        Score: {structure.score.toFixed(1)}
      </div>
      <div style={{ marginTop: '0.25rem', color: colors.textDim, fontSize: '0.65rem' }}>
        {structure.details}
      </div>
      <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', fontSize: '0.6rem', color: colors.text, wordBreak: 'break-all' }}>
        {structure.sequence.slice(0, 40)}{structure.sequence.length > 40 ? '...' : ''}
      </div>
    </>
  );
}

export function NonBDNAOverlay({
  repository,
  currentPhage,
}: NonBDNAOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Toggle states for structure types
  const [showG4, setShowG4] = useState(true);
  const [showZDNA, setShowZDNA] = useState(true);
  const [showCruciform, setShowCruciform] = useState(true);

  // Sensitivity thresholds
  const [g4Threshold, setG4Threshold] = useState(40);
  const [zdnaThreshold, setZdnaThreshold] = useState(70);

  // Hover state
  const [hoverInfo, setHoverInfo] = useState<GenomeTrackInteraction | null>(null);

  // Hotkey to toggle overlay (Alt+N)
  useHotkey(
    { key: 'n', modifiers: { alt: true } },
    'Non-B-DNA Structures (G4, Z-DNA, Cruciform)',
    () => toggle('nonBDNA'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'power' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('nonBDNA')) return;
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

  // Detect non-B-DNA structures
  const analysis = useMemo(() => {
    if (!sequence || sequence.length < 100) return null;

    const g4s = findGQuadruplexes(sequence).filter(s => s.score >= g4Threshold);
    const zdnas = findZDNARegions(sequence, 100, zdnaThreshold);
    const cruciforms = findCruciforms(sequence);

    return {
      g4s,
      zdnas,
      cruciforms,
      total: g4s.length + zdnas.length + cruciforms.length,
    };
  }, [sequence, g4Threshold, zdnaThreshold]);

  // Build track segments
  const g4Segments = useMemo(() => {
    if (!analysis || !showG4) return [];
    return structuresToSegments(analysis.g4s, 'g4', '#22c55e'); // Green
  }, [analysis, showG4]);

  const zdnaSegments = useMemo(() => {
    if (!analysis || !showZDNA) return [];
    return structuresToSegments(analysis.zdnas, 'zdna', '#3b82f6'); // Blue
  }, [analysis, showZDNA]);

  const cruciformSegments = useMemo(() => {
    if (!analysis || !showCruciform) return [];
    return structuresToSegments(analysis.cruciforms, 'cruciform', '#ef4444'); // Red
  }, [analysis, showCruciform]);

  // Handle hover
  const handleHover = useCallback((info: GenomeTrackInteraction | null) => {
    setHoverInfo(info);
  }, []);

  if (!isOpen('nonBDNA')) return null;

  return (
    <Overlay id="nonBDNA" title="NON-B-DNA STRUCTURES" hotkey="Alt+N" size="lg">
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
          <strong style={{ color: colors.accent }}>Non-B-DNA</strong>: Detects alternative DNA
          structures including G-quadruplexes (gene regulation), Z-DNA (torsional stress),
          and cruciform structures (recombination hotspots).
        </div>

        {loading ? (
          <AnalysisPanelSkeleton />
        ) : !sequence ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            No sequence loaded
          </div>
        ) : !analysis ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
            Sequence too short for analysis
          </div>
        ) : (
          <>
            {/* Toggle controls */}
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                <input
                  type="checkbox"
                  checked={showG4}
                  onChange={(e) => setShowG4(e.target.checked)}
                />
                <span style={{ color: '#22c55e' }}>G-Quadruplexes</span>
                <span style={{ color: colors.textMuted }}>({analysis.g4s.length})</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                <input
                  type="checkbox"
                  checked={showZDNA}
                  onChange={(e) => setShowZDNA(e.target.checked)}
                />
                <span style={{ color: '#3b82f6' }}>Z-DNA</span>
                <span style={{ color: colors.textMuted }}>({analysis.zdnas.length})</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}>
                <input
                  type="checkbox"
                  checked={showCruciform}
                  onChange={(e) => setShowCruciform(e.target.checked)}
                />
                <span style={{ color: '#ef4444' }}>Cruciforms</span>
                <span style={{ color: colors.textMuted }}>({analysis.cruciforms.length})</span>
              </label>
            </div>

            {/* Sensitivity controls */}
            <div
              style={{
                display: 'flex',
                gap: '1.5rem',
                fontSize: '0.75rem',
                color: colors.textMuted,
              }}
            >
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                G4 min score:
                <input
                  type="range"
                  min={20}
                  max={80}
                  value={g4Threshold}
                  onChange={(e) => setG4Threshold(Number(e.target.value))}
                  style={{ width: '80px' }}
                />
                <span>{g4Threshold}</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Z-DNA propensity:
                <input
                  type="range"
                  min={50}
                  max={100}
                  value={zdnaThreshold}
                  onChange={(e) => setZdnaThreshold(Number(e.target.value))}
                  style={{ width: '80px' }}
                />
                <span>{zdnaThreshold}</span>
              </label>
            </div>

            {/* Track visualizations */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                position: 'relative',
              }}
            >
              {/* G-Quadruplex track */}
              {showG4 && (
                <div>
                  <div style={{ fontSize: '0.7rem', color: '#22c55e', marginBottom: '0.25rem' }}>
                    G-Quadruplexes
                  </div>
                  <GenomeTrack
                    genomeLength={sequence.length}
                    segments={g4Segments}
                    width={520}
                    height={40}
                    onHover={handleHover}
                    ariaLabel="G-quadruplex predictions track"
                  />
                </div>
              )}

              {/* Z-DNA track */}
              {showZDNA && (
                <div>
                  <div style={{ fontSize: '0.7rem', color: '#3b82f6', marginBottom: '0.25rem' }}>
                    Z-DNA Propensity
                  </div>
                  <GenomeTrack
                    genomeLength={sequence.length}
                    segments={zdnaSegments}
                    width={520}
                    height={40}
                    onHover={handleHover}
                    ariaLabel="Z-DNA propensity track"
                  />
                </div>
              )}

              {/* Cruciform track */}
              {showCruciform && (
                <div>
                  <div style={{ fontSize: '0.7rem', color: '#ef4444', marginBottom: '0.25rem' }}>
                    Cruciform Structures
                  </div>
                  <GenomeTrack
                    genomeLength={sequence.length}
                    segments={cruciformSegments}
                    width={520}
                    height={40}
                    onHover={handleHover}
                    ariaLabel="Cruciform structures track"
                  />
                </div>
              )}

              {/* Hover tooltip */}
              {hoverInfo?.segment?.data ? (() => {
                const structure = hoverInfo.segment.data as NonBDNAStructure;
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: Math.min(hoverInfo.clientX - 280, 250),
                      top: 0,
                      backgroundColor: colors.backgroundAlt,
                      border: `1px solid ${colors.borderLight}`,
                      borderRadius: '4px',
                      padding: '0.5rem',
                      fontSize: '0.75rem',
                      color: colors.text,
                      pointerEvents: 'none',
                      zIndex: 10,
                      maxWidth: '250px',
                    }}
                  >
                    <StructureTooltip structure={structure} colors={colors} />
                  </div>
                );
              })() : null}
            </div>

            {/* Summary stats */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '0.5rem',
                fontSize: '0.75rem',
              }}
            >
              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  borderLeft: '3px solid #22c55e',
                }}
              >
                <div style={{ color: '#22c55e', fontWeight: 'bold' }}>G-Quadruplexes</div>
                <div style={{ color: colors.textMuted }}>
                  {analysis.g4s.length} found
                  {analysis.g4s.length > 0 && (
                    <span> (avg score: {(analysis.g4s.reduce((a, b) => a + b.score, 0) / analysis.g4s.length).toFixed(1)})</span>
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  borderLeft: '3px solid #3b82f6',
                }}
              >
                <div style={{ color: '#3b82f6', fontWeight: 'bold' }}>Z-DNA Regions</div>
                <div style={{ color: colors.textMuted }}>
                  {analysis.zdnas.length} found
                  {analysis.zdnas.length > 0 && (
                    <span> ({analysis.zdnas.reduce((a, b) => a + (b.end - b.start), 0).toLocaleString()} bp total)</span>
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  borderLeft: '3px solid #ef4444',
                }}
              >
                <div style={{ color: '#ef4444', fontWeight: 'bold' }}>Cruciforms</div>
                <div style={{ color: colors.textMuted }}>
                  {analysis.cruciforms.length} found
                  {analysis.cruciforms.length > 0 && (
                    <span> (max score: {Math.max(...analysis.cruciforms.map(c => c.score)).toFixed(1)})</span>
                  )}
                </div>
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
              <strong>Biological Roles:</strong>{' '}
              <span style={{ color: '#22c55e' }}>G4s</span> regulate transcription and replication.{' '}
              <span style={{ color: '#3b82f6' }}>Z-DNA</span> forms under torsional stress during packaging.{' '}
              <span style={{ color: '#ef4444' }}>Cruciforms</span> mark recombination hotspots and genome boundaries.
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

export default NonBDNAOverlay;
