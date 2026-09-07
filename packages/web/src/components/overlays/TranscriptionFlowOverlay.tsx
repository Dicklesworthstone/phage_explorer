/**
 * TranscriptionFlowOverlay - Transcription Flux Analysis
 *
 * Displays predicted transcription flow based on promoter and terminator motifs.
 * Uses canvas for the flux profile visualization.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { TranscriptionFlowResult } from '../../workers/types';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayErrorState,
  OverlayEmptyState,
} from './primitives';

interface TranscriptionFlowOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function TranscriptionFlowOverlay({
  repository,
  currentPhage,
}: TranscriptionFlowOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [snapshot, setSnapshot] = useState<{
    repository: PhageRepository;
    phage: PhageFull;
    data: TranscriptionFlowResult | null;
    stage: 'sequence' | 'analysis' | null;
    error: string | null;
  } | null>(null);
  const current = snapshot?.repository === repository && snapshot?.phage === currentPhage ? snapshot : null;
  const sequenceLoading = Boolean(repository && currentPhage && (!current || current.stage === 'sequence'));
  const analysisLoading = current?.stage === 'analysis';
  const error = current?.error ?? null;

  // Keep the read and worker result in one selection-scoped operation.
  useEffect(() => {
    if (!isOpen('transcriptionFlow')) return;
    setSnapshot(null);
    if (!repository || !currentPhage) {
      return;
    }

    let cancelled = false;
    const input = { repository, phage: currentPhage };
    setSnapshot({ ...input, data: null, stage: 'sequence', error: null });
    const runAnalysis = async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (cancelled) return;
        const sequence = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (cancelled) return;
        if (!sequence) {
          setSnapshot({ ...input, data: null, stage: null, error: null });
          return;
        }
        setSnapshot({ ...input, data: null, stage: 'analysis', error: null });
        const result = await getOrchestrator().runAnalysis({
          type: 'transcription-flow',
          sequence,
        }) as TranscriptionFlowResult;

        if (!cancelled) {
          setSnapshot({ ...input, data: result, stage: null, error: null });
        }
      } catch (err) {
        if (cancelled) return;
        setSnapshot({ ...input, data: null, stage: null, error: err instanceof Error ? err.message : 'Transcription flow analysis failed' });
      }
    };

    void runAnalysis();

    return () => {
      cancelled = true;
    };
  }, [currentPhage, isOpen, repository]);

  const values = current?.data?.values ?? [];
  const peaks = current?.data?.peaks ?? [];

  // Register hotkey
  useHotkey(
    ActionIds.OverlayTranscriptionFlow,
    () => toggle('transcriptionFlow'),
    { modes: ['NORMAL'] }
  );

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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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

  const genomeLengthLabel =
    currentPhage?.genomeLength ? `${currentPhage.genomeLength.toLocaleString()} bp` : '—';
  const loading = sequenceLoading || analysisLoading;
  const loadingMessage = sequenceLoading ? 'Loading genome sequence…' : 'Computing transcription flow...';

  return (
    <Overlay
      id="transcriptionFlow"
      title="TRANSCRIPTION FLOW"
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
            <div style={{ color: colors.text, fontFamily: 'monospace' }}>{genomeLengthLabel}</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.5rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.75rem' }}>Flux Bins</div>
            <div style={{ color: colors.text, fontFamily: 'monospace' }}>{values.length}</div>
          </div>
        </div>

        {/* Canvas for graph */}
        {loading ? (
          <OverlayLoadingState message={loadingMessage}>
            <AnalysisPanelSkeleton rows={3} />
          </OverlayLoadingState>
        ) : error ? (
          <OverlayErrorState
            message="Transcription flow analysis failed"
            details={error}
          />
        ) : values.length === 0 ? (
          <OverlayEmptyState message="No sequence loaded" hint="Select a phage to analyze." />
        ) : (
          <div style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '4px',
            overflow: 'hidden',
            height: '200px',
            position: 'relative'
          }}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="Heuristic transcription flow profile from sequence motifs"
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
              }}
            />
          </div>
        )}

        {/* Top Peaks */}
        {!loading && !error && values.length > 0 && <div>
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
        </div>}

        <div style={{ fontSize: '0.8rem', color: colors.textMuted, marginTop: '0.5rem' }}>
          Heuristic model: promoters seed flow, palindromic repeats attenuate. Future: σ-factor presets, terminator prediction.
        </div>
      </div>
    </Overlay>
  );
}

export default TranscriptionFlowOverlay;
