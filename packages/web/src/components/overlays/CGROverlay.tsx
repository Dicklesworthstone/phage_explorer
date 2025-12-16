/**
 * CGROverlay - Chaos Game Representation (CGR) visualization
 *
 * Renders a CGR density map for the current phage genome with a small
 * set of controls (k-mer depth, hotkey toggle) and basic stats.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import { computeCGR } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import type { ThemePalette } from '../../theme/types';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';

interface CGROverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const DEFAULT_K = 7;
const K_OPTIONS = [6, 7, 8];

function hexToRgb(hex: string): RgbColor {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (normalized.length !== 6) {
    return { r: 255, g: 255, b: 255 };
  }
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function lerpColor(a: RgbColor, b: RgbColor, t: number): RgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * clamped),
    g: Math.round(a.g + (b.g - a.g) * clamped),
    b: Math.round(a.b + (b.b - a.b) * clamped),
  };
}

function computeGCContent(sequence: string): number {
  if (!sequence) return 0;
  const gc = sequence.match(/[GC]/gi)?.length ?? 0;
  return (gc / sequence.length) * 100;
}

export function CGROverlay({ repository, currentPhage }: CGROverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [k, setK] = useState<number>(DEFAULT_K);

  // Hotkey to toggle overlay (Alt+Shift+C)
  useHotkey(
    { key: 'c', modifiers: { alt: true, shift: true } },
    'Chaos Game Representation',
    () => toggle('cgr'),
    { modes: ['NORMAL'], category: 'Analysis', minLevel: 'intermediate' }
  );

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('cgr')) return;
    if (!repository || !currentPhage) {
      setSequence('');
      return;
    }

    let cancelled = false;
    const phageId = currentPhage.id;
    const cached = sequenceCache.current.get(phageId);
    if (cached) {
      setSequence(cached);
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const length = await repository.getFullGenomeLength(phageId);
        const seq = await repository.getSequenceWindow(phageId, 0, length);
        if (!cancelled) {
          sequenceCache.current.set(phageId, seq);
          setSequence(seq);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load sequence';
        if (!cancelled) {
          setError(message);
          setSequence('');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage]);

  const cgrResult = useMemo(() => {
    if (!sequence) return null;
    return computeCGR(sequence, k);
  }, [sequence, k]);

  // Draw density map when data changes
  useEffect(() => {
    if (!isOpen('cgr') || !canvasRef.current || !cgrResult) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const displaySize = canvas.clientWidth || 420;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displaySize * dpr;
    canvas.height = displaySize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = displaySize;
    const height = displaySize;
    const { grid, resolution, maxCount } = cgrResult;

    const imgData = ctx.createImageData(width, height);
    const base = hexToRgb(colors.background);
    const mid = hexToRgb(colors.accent);
    const high = hexToRgb(colors.primary);
    const logMax = Math.log1p(maxCount || 1);
    const xRatio = resolution / width;
    const yRatio = resolution / height;

    for (let y = 0; y < height; y++) {
      const gy = Math.min(resolution - 1, Math.floor(y * yRatio));
      for (let x = 0; x < width; x++) {
        const gx = Math.min(resolution - 1, Math.floor(x * xRatio));
        const count = grid[gy * resolution + gx];
        const normalized = logMax > 0 ? Math.log1p(count) / logMax : 0;
        // Two-stage ramp: background -> accent -> primary
        const midColor = lerpColor(base, mid, normalized);
        const finalColor = lerpColor(midColor, high, Math.max(0, normalized - 0.6) / 0.4);
        const idx = (y * width + x) * 4;
        imgData.data[idx] = finalColor.r;
        imgData.data[idx + 1] = finalColor.g;
        imgData.data[idx + 2] = finalColor.b;
        imgData.data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }, [cgrResult, colors, isOpen]);

  if (!isOpen('cgr')) {
    return null;
  }

  const gcContent = sequence ? computeGCContent(sequence) : 0;
  const length = currentPhage?.genomeLength ?? sequence.length ?? 0;
  const entropy = cgrResult?.entropy ?? 0;
  const resolution = cgrResult?.resolution ?? Math.pow(2, k);
  const statusMessage = !repository
    ? 'Database not loaded yet.'
    : !currentPhage
      ? 'Select a phage to view its CGR.'
      : null;

  return (
    <Overlay
      id="cgr"
      title="CHAOS GAME REPRESENTATION"
      hotkey="Alt+Shift+C"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            color: colors.textDim,
            lineHeight: 1.5,
          }}
        >
          CGR maps the genome into a fractal fingerprint where each corner represents a base
          (A, T, G, C). Density patterns reveal k-mer biases, compositional shifts, and potential
          horizontal transfer regions.
        </div>

        {loading && <AnalysisPanelSkeleton />}
        {!loading && statusMessage && (
          <div style={{ color: colors.textDim }}>
            {statusMessage}
          </div>
        )}
        {error && (
          <div style={{ color: colors.error }}>
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1rem',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: '1 1 320px', minWidth: '320px' }}>
            <div
              style={{
                position: 'relative',
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '8px',
                padding: '0.5rem',
                backgroundColor: colors.backgroundAlt,
              }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block' }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '0.5rem',
                  left: '0.75rem',
                  color: colors.textMuted,
                  fontWeight: 600,
                }}
              >
                A
              </div>
              <div
                style={{
                  position: 'absolute',
                  top: '0.5rem',
                  right: '0.75rem',
                  color: colors.textMuted,
                  fontWeight: 600,
                }}
              >
                T
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: '0.5rem',
                  left: '0.75rem',
                  color: colors.textMuted,
                  fontWeight: 600,
                }}
              >
                C
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: '0.5rem',
                  right: '0.75rem',
                  color: colors.textMuted,
                  fontWeight: 600,
                }}
              >
                G
              </div>
            </div>
          </div>

          <div style={{ flex: '1 1 260px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <label style={{ color: colors.textDim, fontSize: '0.9rem' }}>
                k-mer depth:
              </label>
              <select
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
                style={{
                  padding: '0.35rem 0.6rem',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '6px',
                  background: colors.background,
                  color: colors.text,
                }}
              >
                {K_OPTIONS.map(option => (
                  <option key={option} value={option}>
                    k = {option} (resolution {Math.pow(2, option)}²)
                  </option>
                ))}
              </select>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '0.75rem',
              }}
            >
              <StatCard label="Genome length" value={`${length.toLocaleString()} bp`} colors={colors} />
              <StatCard label="GC content" value={`${gcContent.toFixed(2)}%`} colors={colors} />
              <StatCard label="Resolution" value={`${resolution} × ${resolution}`} colors={colors} />
              <StatCard label="Shannon entropy" value={entropy.toFixed(3)} colors={colors} />
            </div>

            <div
              style={{
                padding: '0.75rem',
                backgroundColor: colors.backgroundAlt,
                borderRadius: '6px',
                color: colors.textDim,
                lineHeight: 1.5,
                fontSize: '0.9rem',
              }}
            >
              <div style={{ color: colors.primary, marginBottom: '0.35rem', fontWeight: 600 }}>
                How to read
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
                <li>Top vs bottom halves indicate GC vs AT richness.</li>
                <li>Sub-quadrants reveal higher-order k-mers as you increase k.</li>
                <li>Empty or bright regions can flag repeats, bias, or HGT segments.</li>
              </ul>
            </div>
          </div>
        </div>

        {sequence && !loading && (
          <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>
            Rendering {sequence.length.toLocaleString()} bp | Hotkey: Alt+Shift+C
          </div>
        )}
      </div>
    </Overlay>
  );
}

function StatCard({
  label,
  value,
  colors,
}: {
  label: string;
  value: string;
  colors: ThemePalette;
}): React.ReactElement {
  return (
    <div
      style={{
        padding: '0.65rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '6px',
        border: `1px solid ${colors.borderLight}`,
      }}
    >
      <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>{label}</div>
      <div style={{ color: colors.text, fontWeight: 600, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

export default CGROverlay;
