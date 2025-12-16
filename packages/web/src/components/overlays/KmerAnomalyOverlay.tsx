/**
 * KmerAnomalyOverlay - K-mer Anomaly Cartography
 *
 * High-resolution k-mer frequency deviation analysis.
 * Shows regions with unusual k-mer composition.
 */

import React, { useEffect, useRef, useMemo, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { ColorLegend, createLinearColorScale } from './primitives';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

interface KmerAnomalyOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface KmerResult {
  position: number;
  deviation: number;
  topKmers: Array<{ kmer: string; count: number; expected: number }>;
}

// Calculate k-mer frequencies for a window
function getKmerCounts(seq: string, k: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.slice(i, i + k);
    if (!/[^ACGT]/.test(kmer)) {
      counts.set(kmer, (counts.get(kmer) || 0) + 1);
    }
  }
  return counts;
}

// Calculate deviation from expected k-mer distribution
function calculateKmerAnomalies(
  sequence: string,
  k = 4,
  windowSize = 500,
  stepSize = 100
): KmerResult[] {
  const seq = sequence.toUpperCase();
  const results: KmerResult[] = [];

  // Calculate global k-mer frequencies
  const globalCounts = getKmerCounts(seq, k);
  const totalGlobal = Array.from(globalCounts.values()).reduce((a, b) => a + b, 0);

  for (let i = 0; i < seq.length - windowSize; i += stepSize) {
    const window = seq.slice(i, i + windowSize);
    const windowCounts = getKmerCounts(window, k);
    const totalWindow = Array.from(windowCounts.values()).reduce((a, b) => a + b, 0);

    if (totalWindow === 0) continue;

    // Calculate chi-squared-like deviation
    let deviation = 0;
    const kmerDeviations: Array<{ kmer: string; count: number; expected: number; dev: number }> = [];

    for (const [kmer, count] of windowCounts) {
      const globalFreq = (globalCounts.get(kmer) || 0) / totalGlobal;
      const expected = globalFreq * totalWindow;
      if (expected > 0) {
        const d = Math.pow(count - expected, 2) / expected;
        deviation += d;
        kmerDeviations.push({ kmer, count, expected, dev: d });
      }
    }

    // Normalize by degrees of freedom
    deviation = deviation / Math.max(1, windowCounts.size);

    // Get top anomalous k-mers
    kmerDeviations.sort((a, b) => b.dev - a.dev);
    const topKmers = kmerDeviations.slice(0, 5).map(({ kmer, count, expected }) => ({
      kmer,
      count,
      expected: Math.round(expected * 100) / 100,
    }));

    results.push({
      position: i + windowSize / 2,
      deviation,
      topKmers,
    });
  }

  return results;
}

export function KmerAnomalyOverlay({
  repository,
  currentPhage,
}: KmerAnomalyOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<KmerResult | null>(null);
  const [kSize, setKSize] = useState(4);
  const colorScale = useMemo(
    () => createLinearColorScale(['#0b4dd8', '#22c55e', '#ef4444']),
    []
  );

  // Hotkey to toggle overlay
  useHotkey(
    { key: 'j' },
    'K-mer Anomaly Cartography',
    () => toggle('kmerAnomaly'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch sequence when overlay opens
  useEffect(() => {
    if (!isOpen('kmerAnomaly')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    const phageId = currentPhage.id;

    // Check cache
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

  const results = useMemo(() => calculateKmerAnomalies(sequence, kSize), [sequence, kSize]);

  // Draw heatmap
  useEffect(() => {
    // Need at least 2 data points to draw lines and avoid division by zero
    if (!isOpen('kmerAnomaly') || !canvasRef.current || results.length < 2) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Find range
    const maxDev = Math.max(...results.map(r => r.deviation));
    const minDev = Math.min(...results.map(r => r.deviation));
    const range = maxDev - minDev || 1;

    // Draw heatmap bars
    const barWidth = width / results.length;
    const padding = 10;

    for (let i = 0; i < results.length; i++) {
      const { deviation } = results[i];
      const normalized = (deviation - minDev) / range;
      const x = i * barWidth;

      ctx.fillStyle = colorScale(normalized);
      ctx.fillRect(x, padding, barWidth + 1, height - padding * 2);
    }

    // Draw line overlay
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;

    for (let i = 0; i < results.length; i++) {
      const x = (i / (results.length - 1)) * width;
      const normalized = (results[i].deviation - minDev) / range;
      const y = height - padding - normalized * (height - padding * 2);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [colorScale, colors, isOpen, results]);

  // Handle canvas click
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || results.length === 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.floor((x / rect.width) * results.length);
    if (idx >= 0 && idx < results.length) {
      setSelectedPoint(results[idx]);
    }
  };

  if (!isOpen('kmerAnomaly')) {
    return null;
  }

  const avgDeviation = results.length > 0
    ? results.reduce((a, b) => a + b.deviation, 0) / results.length
    : 0;
  const maxDeviation = results.length > 0 ? Math.max(...results.map(r => r.deviation)) : 0;
  const anomalyCount = results.filter(r => r.deviation > avgDeviation * 2).length;

  return (
    <Overlay
      id="kmerAnomaly"
      title="K-MER ANOMALY CARTOGRAPHY"
      hotkey="j"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Loading State */}
        {loading && (
          <AnalysisPanelSkeleton message="Loading sequence data..." rows={3} />
        )}

        {/* Description */}
        {!loading && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}>
            <strong style={{ color: colors.primary }}>K-mer Anomaly</strong> detects regions with
            unusual k-mer composition that may indicate horizontal gene transfer, mobile elements,
            or unusual sequence features.
          </div>
        )}

        {/* Controls */}
        {!loading && sequence.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
          }}>
            <label style={{ color: colors.textDim, fontSize: '0.85rem' }}>K-mer size:</label>
            <select
              value={kSize}
              onChange={(e) => setKSize(Number(e.target.value))}
              style={{
                padding: '0.3rem 0.5rem',
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                background: colors.backgroundAlt,
                color: colors.text,
              }}
            >
              <option value={3}>3-mers</option>
              <option value={4}>4-mers</option>
              <option value={5}>5-mers</option>
              <option value={6}>6-mers</option>
            </select>
          </div>
        )}

        {/* Stats */}
        {!loading && results.length > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1rem',
          }}>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Avg Deviation</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>
                {avgDeviation.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.error, fontSize: '0.75rem' }}>Max Deviation</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>
                {maxDeviation.toFixed(2)}
              </div>
            </div>
            <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.warning, fontSize: '0.75rem' }}>Anomaly Regions</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.25rem' }}>
                {anomalyCount}
              </div>
            </div>
          </div>
        )}

        {/* Heatmap */}
        {!loading && results.length >= 2 && (
          <div style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
            overflow: 'hidden',
          }}>
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              style={{ width: '100%', height: '120px', display: 'block', cursor: 'crosshair' }}
            />
          </div>
        )}

        {/* Selected point details */}
        {!loading && selectedPoint && (
          <div style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
          }}>
            <div style={{ color: colors.primary, marginBottom: '0.5rem' }}>
              Position: {selectedPoint.position.toLocaleString()} bp
              (Deviation: {selectedPoint.deviation.toFixed(2)})
            </div>
            <div style={{ fontSize: '0.85rem', color: colors.textDim }}>
              <strong>Top anomalous k-mers:</strong>
              <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '0.25rem', borderBottom: `1px solid ${colors.borderLight}` }}>K-mer</th>
                    <th style={{ textAlign: 'right', padding: '0.25rem', borderBottom: `1px solid ${colors.borderLight}` }}>Observed</th>
                    <th style={{ textAlign: 'right', padding: '0.25rem', borderBottom: `1px solid ${colors.borderLight}` }}>Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedPoint.topKmers.map((k, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'monospace', padding: '0.25rem', color: colors.accent }}>{k.kmer}</td>
                      <td style={{ textAlign: 'right', padding: '0.25rem' }}>{k.count}</td>
                      <td style={{ textAlign: 'right', padding: '0.25rem' }}>{k.expected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        {!loading && results.length >= 2 && (
          <div style={{ padding: '0.5rem' }}>
            <ColorLegend
              width={220}
              height={32}
              colorScale={colorScale}
              tickCount={4}
              minLabel="Low deviation"
              maxLabel="High deviation"
            />
          </div>
        )}

        {!loading && sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available. Select a phage to analyze.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default KmerAnomalyOverlay;
