/**
 * HilbertOverlay - Space-filling curve visualization
 *
 * Maps the linear genome sequence onto a Hilbert curve to preserve local
 * proximity while exposing large-scale compositional domains. Useful for
 * spotting GC/AT domains, repeats, and abrupt transitions.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as Comlink from 'comlink';
import type { PhageFull, Theme } from '@phage-explorer/core';
import { getNucleotideColor } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import type { HilbertWorkerAPI, HilbertWorkerResult } from '../../workers/hilbert.worker';
import type { HudTheme } from '@phage-explorer/core/src/themes';

interface HilbertOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

interface HilbertRender {
  order: number;
  size: number;
  image: ImageData;
  coverage: number;
}

type ColorMode = 'nucleotide' | 'gc-bias';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  const padded = normalized.length === 3
    ? normalized.split('').map(c => c + c).join('')
    : normalized.padStart(6, '0');
  const int = parseInt(padded.slice(0, 6), 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

function rot(n: number, x: number, y: number, rx: number, ry: number): { x: number; y: number } {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return { x: y, y: x };
  }
  return { x, y };
}

function d2xy(size: number, d: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < size; s <<= 1) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    const rotated = rot(s, x, y, rx, ry);
    x = rotated.x + s * rx;
    y = rotated.y + s * ry;
    t >>= 2;
  }
  return { x, y };
}

function calculateOrder(length: number): number {
  const order = Math.ceil(Math.log(Math.max(length, 1)) / Math.log(4));
  // Clamp to avoid enormous canvases; phage genomes stay well within this.
  return Math.min(Math.max(order, 4), 12);
}

function buildHilbertImage(sequence: string, theme: Theme): HilbertRender {
  const order = calculateOrder(sequence.length);
  const size = 1 << order;
  const totalPixels = size * size;
  const bg = hexToRgb(theme.colors.backgroundAlt);
  const buffer = new Uint8ClampedArray(totalPixels * 4);

  // Pre-fill background
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    buffer[idx] = bg.r;
    buffer[idx + 1] = bg.g;
    buffer[idx + 2] = bg.b;
    buffer[idx + 3] = 255;
  }

  // Paint sequence along Hilbert curve
  const maxIdx = Math.min(sequence.length, totalPixels);
  for (let i = 0; i < maxIdx; i++) {
    const { x, y } = d2xy(size, i);
    const nucleotide = sequence[i] ?? 'N';
    const color = getNucleotideColor(theme, nucleotide).bg;
    const rgb = hexToRgb(color);
    const idx = (y * size + x) * 4;
    buffer[idx] = rgb.r;
    buffer[idx + 1] = rgb.g;
    buffer[idx + 2] = rgb.b;
    buffer[idx + 3] = 255;
  }

  return {
    order,
    size,
    image: new ImageData(buffer, size, size),
    coverage: maxIdx / totalPixels,
  };
}

export function HilbertOverlay({ repository, currentPhage }: HilbertOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sequenceCache = useRef<Map<number, string>>(new Map());
const workerRef = useRef<Worker | null>(null);
const workerApiRef = useRef<Comlink.Remote<HilbertWorkerAPI> | null>(null);
  const [sequence, setSequence] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
const [renderResult, setRenderResult] = useState<HilbertRender | null>(null);
const [colorMode, setColorMode] = useState<ColorMode>('nucleotide');

  useHotkey(
    { key: 'h', modifiers: { alt: true, shift: true } },
    'Hilbert Curve',
    () => toggle('hilbert'),
    { modes: ['NORMAL'], category: 'Analysis' }
  );

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (workerRef.current) return () => undefined;

    const worker = new Worker(new URL('../../workers/hilbert.worker.ts', import.meta.url), {
      type: 'module',
    });
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

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (!isOpen('hilbert')) return;
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

  // Compute Hilbert render (worker preferred, fallback to main thread)
  useEffect(() => {
    if (!isOpen('hilbert') || !sequence) {
      setRenderResult(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const colorMap = buildColorMap(theme.colors, colorMode);

    const run = async () => {
      try {
        let result: HilbertWorkerResult;
        if (workerApiRef.current) {
          result = await workerApiRef.current.render(sequence, colorMap);
        } else {
          const fallback = buildHilbertImage(sequence, theme);
          result = {
            order: fallback.order,
            size: fallback.size,
            buffer: fallback.image.data,
            coverage: fallback.coverage,
          };
        }

        if (cancelled) return;
        const image = new ImageData(new Uint8ClampedArray(result.buffer), result.size, result.size);
        setRenderResult({
          order: result.order,
          size: result.size,
          coverage: result.coverage,
          image,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to compute Hilbert curve';
        setError(message);
        setRenderResult(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isOpen, sequence, theme, colorMode]);

  useEffect(() => {
    if (!isOpen('hilbert') || !renderResult || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const displaySize = canvas.clientWidth || 420;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displaySize * dpr;
    canvas.height = displaySize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const temp = document.createElement('canvas');
    temp.width = renderResult.image.width;
    temp.height = renderResult.image.height;
    const tempCtx = temp.getContext('2d');
    if (!tempCtx) return;
    tempCtx.putImageData(renderResult.image, 0, 0);

    ctx.clearRect(0, 0, displaySize, displaySize);
    ctx.drawImage(temp, 0, 0, displaySize, displaySize);
  }, [renderResult, isOpen]);

  if (!isOpen('hilbert')) {
    return null;
  }

  const length = currentPhage?.genomeLength ?? sequence.length ?? 0;
  const statusMessage = !repository
    ? 'Database not loaded yet.'
    : !currentPhage
      ? 'Select a phage to view its Hilbert curve.'
      : null;

  return (
    <Overlay
      id="hilbert"
      title="HILBERT CURVE"
      icon="🌀"
      hotkey="Alt+Shift+H"
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
          Maps the genome onto a space-filling curve so nearby pixels stay adjacent along the sequence.
          Blocks and color shifts surface compositional domains, repeats, and abrupt transitions.
        </div>

        {(loading || statusMessage) && (
          <div style={{ color: colors.textDim }}>
            {statusMessage ?? 'Loading genome sequence…'}
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
                Start
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
                End
              </div>
            </div>
          </div>

          <div style={{ flex: '1 1 260px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '0.75rem',
              }}
            >
              <StatCard label="Genome length" value={`${length.toLocaleString()} bp`} colors={colors} />
              <StatCard
                label="Curve order"
                value={renderResult ? `${renderResult.order} (grid ${renderResult.size}²)` : '—'}
                colors={colors}
              />
              <StatCard
                label="Pixel coverage"
                value={renderResult ? `${(renderResult.coverage * 100).toFixed(1)}%` : '—'}
                colors={colors}
              />
              <StatCard
                label="Hotkey"
                value="Alt+Shift+H"
                colors={colors}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <label style={{ color: colors.textDim, fontSize: '0.9rem' }}>Color mode:</label>
              <select
                value={colorMode}
                onChange={(e) => setColorMode(e.target.value as ColorMode)}
                style={{
                  padding: '0.35rem 0.6rem',
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '6px',
                  background: colors.background,
                  color: colors.text,
                }}
              >
                <option value="nucleotide">Nucleotide palette</option>
                <option value="gc-bias">GC vs AT emphasis</option>
              </select>
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
                Reading tips
              </div>
              <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
                <li>Uniform colors → balanced composition; blocks → domains or modules.</li>
                <li>Sharp color edges often flag HGT boundaries or repeats.</li>
                <li>Coverage &lt; 100% means unused pixels (padding to next 2^n grid).</li>
              </ul>
            </div>
          </div>
        </div>

        {sequence && !loading && (
          <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>
            Rendering {sequence.length.toLocaleString()} bp | Hilbert order {renderResult?.order ?? '—'}
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
  colors: Record<string, string>;
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

function buildColorMap(themeColors: HudTheme, mode: ColorMode): Record<string, { r: number; g: number; b: number }> {
  if (mode === 'gc-bias') {
    const low = hexToRgb(themeColors.gradientLow);
    const high = hexToRgb(themeColors.gradientHigh);
    return {
      A: low,
      T: low,
      C: high,
      G: high,
      N: hexToRgb(themeColors.backgroundAlt),
    };
  }

  const map: Record<string, { r: number; g: number; b: number }> = {};
  for (const n of ['A', 'C', 'G', 'T', 'N']) {
    const pair = getNucleotideColor({ colors: themeColors } as unknown as Theme, n);
    map[n] = hexToRgb(pair.bg);
  }
  return map;
}

export default HilbertOverlay;

