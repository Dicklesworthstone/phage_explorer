/**
 * KmerAnomalyOverlay - K-mer Anomaly Cartography
 *
 * High-resolution k-mer frequency deviation analysis.
 * Shows regions with unusual k-mer composition.
 */

import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface KmerAnomalyOverlayProps {
  sequence?: string;
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

export function KmerAnomalyOverlay({ sequence = '' }: KmerAnomalyOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedPoint, setSelectedPoint] = useState<KmerResult | null>(null);
  const [kSize, setKSize] = useState(4);

  const results = useMemo(() => calculateKmerAnomalies(sequence, kSize), [sequence, kSize]);

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'j' || e.key === 'J') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        toggle('kmer-anomaly');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  // Draw heatmap
  useEffect(() => {
    if (!isOpen('kmer-anomaly') || !canvasRef.current || results.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

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

      // Color from blue (normal) through green to red (anomalous)
      let r = 0, g = 0, b = 0;
      if (normalized < 0.5) {
        // Blue to green
        const t = normalized * 2;
        r = 0;
        g = Math.round(t * 200);
        b = Math.round((1 - t) * 200);
      } else {
        // Green to red
        const t = (normalized - 0.5) * 2;
        r = Math.round(t * 255);
        g = Math.round((1 - t) * 200);
        b = 0;
      }

      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
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
  }, [isOpen, results, colors]);

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

  if (!isOpen('kmer-anomaly')) {
    return null;
  }

  const avgDeviation = results.length > 0
    ? results.reduce((a, b) => a + b.deviation, 0) / results.length
    : 0;
  const maxDeviation = results.length > 0 ? Math.max(...results.map(r => r.deviation)) : 0;
  const anomalyCount = results.filter(r => r.deviation > avgDeviation * 2).length;

  return (
    <Overlay
      id="kmer-anomaly"
      title="K-MER ANOMALY CARTOGRAPHY"
      icon="🔬"
      hotkey="j"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
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

        {/* Controls */}
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

        {/* Stats */}
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

        {/* Heatmap */}
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

        {/* Selected point details */}
        {selectedPoint && (
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
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.5rem',
        }}>
          <span style={{ color: 'rgb(0, 0, 200)', fontSize: '0.85rem' }}>Normal</span>
          <div style={{
            width: '200px',
            height: '12px',
            background: 'linear-gradient(to right, rgb(0, 0, 200), rgb(0, 200, 0), rgb(255, 0, 0))',
            borderRadius: '4px',
          }} />
          <span style={{ color: 'rgb(255, 0, 0)', fontSize: '0.85rem' }}>Anomalous</span>
        </div>

        {sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default KmerAnomalyOverlay;
