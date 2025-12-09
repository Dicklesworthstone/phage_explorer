/**
 * PlaqueVisualizer - Visualization for Plaque Automata Simulation
 *
 * Displays the cellular automaton grid with bacteria, phage, and infections.
 */

import React, { useRef, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { PlaqueAutomataState } from '../../workers/types';

interface PlaqueVisualizerProps {
  state: PlaqueAutomataState;
  size?: number;
}

// Cell state colors
const CELL_COLORS = {
  0: '#1a1a2e', // Empty (dark)
  1: '#2ecc71', // Bacteria (green)
  2: '#e74c3c', // Infected (red)
  3: '#34495e', // Lysed (gray)
  4: '#9b59b6', // Phage (purple)
  5: '#3498db', // Lysogen (blue)
};

export function PlaqueVisualizer({
  state,
  size = 300,
}: PlaqueVisualizerProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const gridSize = state.gridSize;
    const cellSize = size / gridSize;

    // Draw cells
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const idx = y * gridSize + x;
        const cellState = state.grid[idx];
        ctx.fillStyle = CELL_COLORS[cellState as keyof typeof CELL_COLORS] || CELL_COLORS[0];
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }

    // Draw grid lines (subtle)
    if (cellSize > 8) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= gridSize; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cellSize, 0);
        ctx.lineTo(i * cellSize, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * cellSize);
        ctx.lineTo(size, i * cellSize);
        ctx.stroke();
      }
    }
  }, [state, size]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* Stats */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          padding: '0.5rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
        }}
      >
        <span style={{ color: '#2ecc71' }}>Bacteria: {state.bacteriaCount}</span>
        <span style={{ color: '#e74c3c' }}>Infected: {state.infectionCount}</span>
        <span style={{ color: '#9b59b6' }}>Phage: {state.phageCount}</span>
      </div>

      {/* Grid */}
      <canvas
        ref={canvasRef}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '4px',
          border: `1px solid ${colors.borderLight}`,
        }}
      />

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          justifyContent: 'center',
          fontSize: '0.75rem',
          color: colors.textMuted,
        }}
      >
        {Object.entries(CELL_COLORS).map(([key, color]) => {
          const labels = ['Empty', 'Bacteria', 'Infected', 'Lysed', 'Phage', 'Lysogen'];
          return (
            <span key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span
                style={{
                  width: '10px',
                  height: '10px',
                  backgroundColor: color,
                  borderRadius: '2px',
                }}
              />
              {labels[parseInt(key)]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default PlaqueVisualizer;
