/**
 * ResistanceEvolutionOverlay - Gillespie Stochastic Simulation
 *
 * Visualizes resistance emergence under mono vs cocktail phage therapy
 * using the core Gillespie tau-leaping simulation.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  makeResistanceSimulation,
  type ResistanceCocktailState,
} from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

const simulation = makeResistanceSimulation();

function formatExp(n: number): string {
  if (n < 1000) return n.toFixed(0);
  return n.toExponential(1);
}

function progressBar(
  fraction: number,
  color: string,
  label?: string
): React.ReactElement {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  return (
    <div style={{ marginBottom: '0.25rem' }}>
      {label && (
        <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)', marginBottom: '2px' }}>
          {label}
        </div>
      )}
      <div
        style={{
          width: '100%',
          height: '8px',
          backgroundColor: 'rgba(255,255,255,0.08)',
          borderRadius: '4px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 50ms linear',
          }}
        />
      </div>
    </div>
  );
}

export function ResistanceEvolutionOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const [state, setState] = useState<ResistanceCocktailState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [cocktailSize, setCocktailSize] = useState(3);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wasOpenRef = useRef(false);

  // Track overlay open state without causing dependency issues
  const overlayIsOpen = isOpen('resistanceEvolution');

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayResistanceEvolution,
    () => toggle('resistanceEvolution'),
    { modes: ['NORMAL'] }
  );

  // Initialize simulation
  const initSimulation = useCallback((size: number) => {
    const initial = simulation.init(null, { cocktailSize: size });
    setState(initial);
    setIsRunning(false);
    lastTimeRef.current = 0;
  }, []);

  // Initialize when overlay opens (not on every isOpen reference change)
  useEffect(() => {
    if (overlayIsOpen && !wasOpenRef.current) {
      // Overlay just opened - initialize
      initSimulation(cocktailSize);
    }
    wasOpenRef.current = overlayIsOpen;

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [overlayIsOpen, initSimulation]);

  // Reinitialize when cocktail size changes (while overlay is open)
  const prevCocktailSizeRef = useRef(cocktailSize);
  useEffect(() => {
    if (overlayIsOpen && cocktailSize !== prevCocktailSizeRef.current) {
      initSimulation(cocktailSize);
    }
    prevCocktailSizeRef.current = cocktailSize;
  }, [overlayIsOpen, cocktailSize, initSimulation]);

  // Track if state is initialized (to avoid putting state in deps)
  const hasStateRef = useRef(false);
  useEffect(() => {
    hasStateRef.current = state !== null;
    if (state && !state.running && isRunning) {
      setIsRunning(false);
    }
  }, [state, isRunning]);

  // Animation loop - only depends on isRunning to avoid re-running on every state update
  useEffect(() => {
    if (!isRunning || !hasStateRef.current) return;

    const animate = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const elapsed = timestamp - lastTimeRef.current;

      // Step simulation every 50ms of real time
      if (elapsed > 50) {
        setState((prev) => {
          if (!prev || !prev.running) return prev;
          const next = simulation.step(prev, 1, Math.random);
          if (simulation.isComplete?.(next)) {
            return { ...next, running: false };
          }
          return next;
        });
        lastTimeRef.current = timestamp;
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isRunning]);

  // Draw population history chart
  useEffect(() => {
    if (!canvasRef.current || !state) return;

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

    const history = state.history;
    if (history.length < 2) return;

    const padding = { left: 50, right: 20, top: 20, bottom: 30 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    // Find max values for scaling
    const maxPop = Math.max(
      ...history.map((h) => Math.max(h.sensitive, h.partialResistant, h.fullyResistant, 1))
    );
    const maxPhage = Math.max(...history.map((h) => h.totalPhage), 1);
    const maxT = Math.max(...history.map((h) => h.t), 1);

    const scaleX = (t: number) => padding.left + (t / maxT) * plotW;
    const scaleY = (v: number, max: number) => padding.top + plotH - (Math.log10(v + 1) / Math.log10(max + 1)) * plotH;

    // Axes
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = colors.textMuted;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('10^' + Math.log10(maxPop + 1).toFixed(0), padding.left - 5, padding.top + 4);
    ctx.fillText('1', padding.left - 5, height - padding.bottom);

    // X-axis label
    ctx.textAlign = 'center';
    ctx.fillText(`Time (${maxT.toFixed(1)}h)`, width / 2, height - 5);

    // Plot lines
    const drawLine = (
      data: { t: number; v: number }[],
      color: string,
      max: number
    ) => {
      if (data.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleX(data[0].t), scaleY(data[0].v, max));
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(scaleX(data[i].t), scaleY(data[i].v, max));
      }
      ctx.stroke();
    };

    // Sensitive bacteria (green)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.sensitive })),
      colors.success,
      maxPop
    );

    // Partial resistant (yellow)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.partialResistant })),
      colors.warning,
      maxPop
    );

    // Fully resistant (red)
    drawLine(
      history.map((h) => ({ t: h.t, v: h.fullyResistant })),
      colors.error,
      maxPop
    );

    // Phage (blue, dashed)
    ctx.setLineDash([4, 4]);
    drawLine(
      history.map((h) => ({ t: h.t, v: h.totalPhage })),
      colors.info,
      maxPhage
    );
    ctx.setLineDash([]);

    // Legend
    const legendY = padding.top + 10;
    const legendItems = [
      { label: 'Sensitive', color: colors.success },
      { label: 'Partial R', color: colors.warning },
      { label: 'Full R', color: colors.error },
      { label: 'Phage', color: colors.info },
    ];
    ctx.textAlign = 'left';
    legendItems.forEach((item, i) => {
      const x = padding.left + 10 + i * 80;
      ctx.fillStyle = item.color;
      ctx.fillRect(x, legendY - 4, 12, 4);
      ctx.fillStyle = colors.textDim;
      ctx.font = '9px sans-serif';
      ctx.fillText(item.label, x + 16, legendY);
    });

    // Resistance emergence marker
    if (state.resistanceTime !== null) {
      const markerX = scaleX(state.resistanceTime);
      ctx.strokeStyle = colors.error;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(markerX, padding.top);
      ctx.lineTo(markerX, height - padding.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.error;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('RESIST', markerX, padding.top - 5);
    }
  }, [state, colors]);

  if (!isOpen('resistanceEvolution')) {
    return null;
  }

  const totalResistant = state
    ? state.partialResistant.reduce((a, b) => a + b, 0) + state.fullyResistant
    : 0;
  const carryingCap = state ? Number(state.params.carryingCap ?? 1e9) : 1e9;
  const resistFraction = totalResistant / carryingCap;

  return (
    <Overlay
      id="resistanceEvolution"
      title="RESISTANCE EVOLUTION"
      hotkey="Shift+E"
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
            fontSize: '0.9rem',
          }}
        >
          <strong style={{ color: colors.primary }}>Gillespie Stochastic Simulation</strong>{' '}
          models resistance emergence under phage therapy. Cocktails require bacteria to become
          resistant to ALL phages, making full resistance exponentially less likely.
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ color: colors.textDim, fontSize: '0.85rem' }}>
            Cocktail size:
            <select
              value={cocktailSize}
              onChange={(e) => setCocktailSize(Number(e.target.value))}
              style={{
                marginLeft: '0.5rem',
                padding: '0.25rem 0.5rem',
                backgroundColor: colors.backgroundAlt,
                color: colors.text,
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
              }}
            >
              <option value={1}>1 (Mono)</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </label>

          <button
            onClick={() => {
              if (isRunning) {
                setIsRunning(false);
              } else {
                if (!state || simulation.isComplete?.(state)) {
                  initSimulation(cocktailSize);
                }
                setIsRunning(true);
              }
            }}
            style={{
              padding: '0.4rem 1rem',
              backgroundColor: isRunning ? colors.error : colors.success,
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {isRunning ? 'Pause' : state && simulation.isComplete?.(state) ? 'Restart' : 'Start'}
          </button>

          <button
            onClick={() => initSimulation(cocktailSize)}
            style={{
              padding: '0.4rem 1rem',
              backgroundColor: 'transparent',
              color: colors.textDim,
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Reset
          </button>
        </div>

        {/* Stats Grid */}
        {state && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Time</div>
              <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
                {state.simTime.toFixed(1)} hours
              </div>
            </div>
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.success, fontSize: '0.75rem' }}>Sensitive</div>
              <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
                {formatExp(state.sensitiveBacteria)}
              </div>
            </div>
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.warning, fontSize: '0.75rem' }}>Partial Resistant</div>
              <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
                {formatExp(state.partialResistant.reduce((a, b) => a + b, 0))}
              </div>
            </div>
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.error, fontSize: '0.75rem' }}>Fully Resistant</div>
              <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
                {formatExp(state.fullyResistant)}
              </div>
            </div>
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.info, fontSize: '0.75rem' }}>Total Phage</div>
              <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
                {formatExp(state.phageCounts.reduce((a, b) => a + b, 0))}
              </div>
            </div>
            <div style={{ padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Status</div>
              <div
                style={{
                  fontFamily: 'monospace',
                  fontSize: '1.1rem',
                  color: state.resistanceEmerged
                    ? colors.error
                    : state.sensitiveBacteria < 1
                      ? colors.success
                      : colors.text,
                }}
              >
                {state.resistanceEmerged
                  ? `RESIST @ ${state.resistanceTime?.toFixed(1)}h`
                  : state.sensitiveBacteria < 1
                    ? 'CLEARED'
                    : 'Active'}
              </div>
            </div>
          </div>
        )}

        {/* Resistance Risk Bar */}
        {state && (
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
              Resistance Risk (fraction of carrying capacity)
            </div>
            {progressBar(
              resistFraction,
              resistFraction > 0.1 ? colors.error : resistFraction > 0.01 ? colors.warning : colors.success
            )}
            <div style={{ fontSize: '0.75rem', color: colors.textDim, marginTop: '0.25rem' }}>
              {(resistFraction * 100).toFixed(2)}% resistant (threshold: 10%)
            </div>
          </div>
        )}

        {/* Population Dynamics Chart */}
        <div
          style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '0.5rem 0.75rem',
              backgroundColor: colors.backgroundAlt,
              borderBottom: `1px solid ${colors.borderLight}`,
              color: colors.primary,
              fontSize: '0.85rem',
              fontWeight: 600,
            }}
          >
            Population Dynamics (log scale)
          </div>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Population dynamics chart showing bacterial and phage counts over time on logarithmic scale"
            style={{
              width: '100%',
              height: '200px',
              display: 'block',
            }}
          />
        </div>

        {/* Per-Phage Details */}
        {state && state.cocktailSize > 1 && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {state.phageCounts.map((count, i) => (
              <div
                key={i}
                style={{
                  flex: '1 1 100px',
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderRadius: '4px',
                  textAlign: 'center',
                }}
              >
                <div style={{ color: colors.info, fontSize: '0.7rem' }}>Phage {i + 1}</div>
                <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '0.9rem' }}>
                  {formatExp(count)}
                </div>
                <div style={{ color: colors.warning, fontSize: '0.65rem' }}>
                  R: {formatExp(state.partialResistant[i])}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Events Log */}
        {state && state.events.length > 0 && (
          <div
            style={{
              maxHeight: '100px',
              overflowY: 'auto',
              padding: '0.5rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '4px',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              color: colors.textDim,
            }}
          >
            {state.events
              .slice(-10)
              .reverse()
              .map((e, i) => (
                <div key={i}>
                  [{e.t.toFixed(2)}h] {e.type}
                </div>
              ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default ResistanceEvolutionOverlay;
