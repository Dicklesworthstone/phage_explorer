/**
 * TranscriptionFlowOverlay - Transcription Flux Analysis
 *
 * Displays predicted transcription flow based on promoter and terminator motifs.
 * Uses canvas for the flux profile visualization.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { simulateTranscriptionFlow } from '@phage-explorer/core';

interface TranscriptionFlowOverlayProps {
  sequence?: string;
  genomeLength?: number;
}

export function TranscriptionFlowOverlay({ sequence = '', genomeLength = 0 }: TranscriptionFlowOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Calculate transcription flow data
  const { values, peaks } = useMemo(() => {
    return simulateTranscriptionFlow(sequence);
  }, [sequence]);

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'y' || e.key === 'Y') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        toggle('transcriptionFlow');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  // Draw the flux profile
  useEffect(() => {
    if (!isOpen('transcriptionFlow') || !canvasRef.current || values.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Canvas size should match the container or be fixed
    const rect = canvas.getBoundingClientRect();
    // If rect is zero (hidden), use default
    const width = rect.width || 600;
    const height = rect.height || 200;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid/axis lines
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    
    // Baseline
    ctx.beginPath();
    ctx.moveTo(0, height - 20);
    ctx.lineTo(width, height - 20);
    ctx.stroke();

    const maxVal = Math.max(...values, 1);

    // Draw flux bars
    const barWidth = width / values.length;
    
    ctx.fillStyle = colors.accent;
    
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      const barHeight = (val / maxVal) * (height - 40);
      const x = i * barWidth;
      const y = height - 20 - barHeight;
      
      ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
    }

  }, [isOpen, values, colors]);

  if (!isOpen('transcriptionFlow')) {
    return null;
  }

  return (
    <Overlay
      id="transcriptionFlow"
      title="TRANSCRIPTION FLOW"
      icon="🧪"
      hotkey="y"
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
          <strong style={{ color: colors.accent }}>Flux Profile</strong>: Estimated transcription strength along the genome based on promoter (seed) and terminator (attenuation) motifs.
        </div>

        {/* Stats */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '1rem',
        }}>
          <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Genome Length</div>
            <div style={{ color: colors.text, fontFamily: 'monospace' }}>{genomeLength.toLocaleString()} bp</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Flux Bins</div>
            <div style={{ color: colors.text, fontFamily: 'monospace' }}>{values.length}</div>
          </div>
        </div>

        {/* Canvas for graph */}
        <div style={{
          border: `1px solid ${colors.borderLight}`,
          borderRadius: '4px',
          overflow: 'hidden',
          height: '200px', 
          position: 'relative'
        }}>
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: '100%',
              display: 'block',
            }}
          />
        </div>

        {/* Top Peaks */}
        <div>
          <h3 style={{ color: colors.primary, fontSize: '1rem', marginBottom: '0.5rem' }}>Top Flow Regions</h3>
          {peaks.length === 0 ? (
            <div style={{ color: colors.textDim }}>No prominent peaks detected.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {peaks.map((p, i) => (
                <div key={i} style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between',
                  padding: '0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  borderLeft: `3px solid ${colors.accent}`,
                  borderRadius: '0 4px 4px 0'
                }}>
                  <span style={{ fontFamily: 'monospace', color: colors.text }}>
                    {p.start.toLocaleString()} - {p.end.toLocaleString()} bp
                  </span>
                  <span style={{ color: colors.textDim }}>
                    Flux: <span style={{ color: colors.accent }}>{p.flux.toFixed(2)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginTop: '0.5rem' }}>
          Heuristic model: promoters seed flow, palindromic repeats attenuate. Future: σ-factor presets, terminator prediction.
        </div>
      </div>
    </Overlay>
  );
}

export default TranscriptionFlowOverlay;
