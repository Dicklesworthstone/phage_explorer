/**
 * CGROverlay - Chaos Game Representation (CGR) visualization
 *
 * Renders a CGR density map for the current phage genome with a small
 * set of controls (k-mer depth, hotkey toggle) and basic stats.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { PhageFull } from '@phage-explorer/core';
import { computeCGR } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import type { ThemePalette } from '../../theme/types';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { getWasmCompute } from '../../lib/wasm-loader';
import type { CgrWorkerResult, HilbertWorkerAPI } from '../../workers/hilbert.worker';

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

interface CgrRenderResult {
  grid: Uint32Array | Float32Array;
  resolution: number;
  k: number;
  maxCount: number;
  totalPoints: number;
  entropy: number;
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

async function computeCgrWasm(sequence: string, k: number): Promise<CgrWorkerResult> {
  const wasm = await getWasmCompute();
  const cgrCounts = (wasm as unknown as { cgr_counts?: (seq: Uint8Array, k: number) => unknown } | null)?.cgr_counts;
  if (!wasm || typeof cgrCounts !== 'function') {
    throw new Error('cgr_counts not available');
  }

  // Keep allocations bounded (2048^2 u32 = 16MB).
  const kInt = Math.max(0, Math.min(11, Math.floor(k)));
  const seqBytes = textEncoder
    ? textEncoder.encode(sequence)
    : Uint8Array.from(sequence, (c) => c.charCodeAt(0) & 255);

  const result = cgrCounts(seqBytes, kInt);
  try {
    const r = result as {
      readonly counts: Uint32Array;
      readonly resolution: number;
      readonly k: number;
      readonly max_count: number;
      readonly total_points: number;
      readonly entropy: number;
    };

    if (!r.counts || r.counts.byteLength === 0 || r.resolution <= 0) {
      throw new Error('Empty result from cgr_counts');
    }

    return {
      grid: r.counts,
      resolution: r.resolution,
      k: r.k,
      maxCount: r.max_count,
      totalPoints: r.total_points,
      entropy: r.entropy,
    };
  } finally {
    (result as { free?: () => void } | null)?.free?.();
  }
}

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
  // Numeric IDs are meaningful only within the repository that supplied them.
  const sequenceCache = useMemo(() => new Map<number, string>(), [repository]);
  const workerRef = useRef<Worker | null>(null);
  const workerApiRef = useRef<Comlink.Remote<HilbertWorkerAPI> | null>(null);
  const [loaded, setLoaded] = useState<{ repository: PhageRepository; phageId: number; sequence: string } | null>(null);
  const sequence = loaded?.repository === repository && loaded?.phageId === currentPhage?.id ? loaded.sequence : '';
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [computeLoading, setComputeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [k, setK] = useState<number>(DEFAULT_K);
  const [computed, setComputed] = useState<{ input: typeof loaded; k: number; result: CgrRenderResult } | null>(null);
  const cgrResult = sequence && computed?.input === loaded && computed.k === k ? computed.result : null;

  const loading = sequenceLoading || computeLoading;

  // Hotkey to toggle overlay (Alt+Shift+C)
  useHotkey(
    ActionIds.OverlayCGR,
    () => toggle('cgr'),
    { modes: ['NORMAL'] }
  );

  // Initialize worker (module worker when available; fallback to main thread compute)
  useEffect(() => {
    if (workerRef.current) return () => undefined;

    let worker: Worker;
    try {
      worker = new Worker(new URL('../../workers/hilbert.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      try {
        worker = new Worker(new URL('../../workers/hilbert.worker.ts', import.meta.url));
      } catch {
        workerRef.current = null;
        workerApiRef.current = null;
        return () => undefined;
      }
    }

    workerRef.current = worker;
    workerApiRef.current = Comlink.wrap<HilbertWorkerAPI>(worker);

    return () => {
      if (workerApiRef.current && 'releaseProxy' in workerApiRef.current) {
        // @ts-expect-error Comlink runtime helper
        workerApiRef.current.releaseProxy?.();
      }
      workerRef.current?.terminate();
      workerRef.current = null;
      workerApiRef.current = null;
    };
  }, []);

  // Fetch full genome when overlay opens or phage changes
  useEffect(() => {
    if (!isOpen('cgr')) return;
    if (!repository || !currentPhage) {
      setLoaded(null);
      setSequenceLoading(false);
      return;
    }

    let cancelled = false;
    const phageId = currentPhage.id;
    const cached = sequenceCache.get(phageId);
    if (cached !== undefined) {
      setLoaded({ repository, phageId, sequence: cached });
      setSequenceLoading(false);
      return;
    }

    setSequenceLoading(true);
    setError(null);
    void (async () => {
      try {
        const length = await repository.getFullGenomeLength(phageId);
        if (cancelled) return;
        const seq = await repository.getSequenceWindow(phageId, 0, length);
        if (!cancelled) {
          sequenceCache.set(phageId, seq);
          setLoaded({ repository, phageId, sequence: seq });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load sequence';
        if (!cancelled) {
          setError(message);
          setLoaded(null);
        }
      } finally {
        if (!cancelled) {
          setSequenceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, repository, currentPhage, sequenceCache]);

  // Compute CGR (worker preferred, WASM fallback, JS fallback)
  useEffect(() => {
    if (!isOpen('cgr') || !sequence) {
      setComputed(null);
      setComputeLoading(false);
      return;
    }

    let cancelled = false;
    setComputeLoading(true);
    setError(null);

    void (async () => {
      try {
        let result: CgrRenderResult;
        if (workerApiRef.current) {
          result = await workerApiRef.current.renderCgr(sequence, k);
        } else {
          result = await computeCgrWasm(sequence, k).catch(() => computeCGR(sequence, k));
        }
        if (!cancelled) {
          setComputed({ input: loaded, k, result });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to compute CGR';
        if (!cancelled) {
          setError(message);
          setComputed(null);
        }
      } finally {
        if (!cancelled) {
          setComputeLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, sequence, loaded, k]);

  // Draw density map when data changes
  useEffect(() => {
    if (!isOpen('cgr') || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The canvas survives input changes; discard the old image while a new
    // repository or parameter choice is waiting for its own result.
    if (!cgrResult) {
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

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

        {loading && (
          <OverlayLoadingState message="Computing Chaos Game Representation...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        )}
        {!loading && statusMessage && (
          <OverlayEmptyState
            message={statusMessage}
            hint="The CGR visualization requires a loaded genome sequence."
          />
        )}
        {!loading && error && (
          <OverlayErrorState
            message="CGR computation failed"
            details={error}
          />
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
                role="img"
                aria-label="Chaos Game Representation showing nucleotide sequence patterns"
                style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block', visibility: cgrResult ? 'visible' : 'hidden' }}
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
              <StatCard label="GC content" value={sequence ? `${gcContent.toFixed(2)}%` : '—'} colors={colors} />
              <StatCard label="Resolution" value={`${resolution} × ${resolution}`} colors={colors} />
              <StatCard label="Shannon entropy" value={cgrResult ? entropy.toFixed(3) : '—'} colors={colors} />
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
