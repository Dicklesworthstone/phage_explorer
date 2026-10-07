/**
 * GCSkewOverlay - GC Skew Analysis Visualization
 *
 * Displays cumulative nucleotide bias and sampled composition candidates.
 * Uses canvas for the sparkline visualization.
 * Demonstrates the overlay chrome primitives pattern.
 */

import React, { useEffect, useRef, useState } from 'react';
import { serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import { GC_SKEW_METHOD, resolveGCSkewOptions, parseGCSkewRecord, type ResolvedGCSkewOptions, type GCSkewWindow } from '../../../../core/src/analysis/gc-skew';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayStatGrid,
  OverlayStatCard,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayLegend,
  OverlayLegendItem,
  HowDoIKnowThis,
} from './primitives';
import { ChartOverlaySkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { getOrchestrator } from '../../workers/ComputeOrchestrator';
import type { AnalysisResult } from '../../workers/types';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';
import { parseGCSkewReplay, compareGCSkewReplay, type GCSkewReplay, type RepeatReplayComparison } from '../../workers/analysis-evidence';

interface GCSkewParameters extends ResolvedGCSkewOptions {
  replay?: GCSkewReplay;
  portable?: { content: string; sequence: string };
}

interface GCSkewOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function GCSkewOverlay({
  repository,
  currentPhage,
}: GCSkewOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [windowInput, setWindowInput] = useState('500'), [stepInput, setStepInput] = useState('125');
  const [parameters, setParameters] = useState<GCSkewParameters>({ windowSize: 500, stepSize: 125 });
  const controllerRef = useRef<AbortController | null>(null), importGeneration = useRef(0);
  const [importLoading, setImportLoading] = useState(false), [importError, setImportError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [wasCancelled, setWasCancelled] = useState(false);
  const [resultSnapshot, setResultSnapshot] = useState<{ phage: PhageFull; sequence: string; repository: PhageRepository;
    parameters: GCSkewParameters; data: Extract<AnalysisResult, { type: 'gc-skew' }>; replay: RepeatReplayComparison | null } | null>(null);
  const currentSnapshot = resultSnapshot?.phage === currentPhage && resultSnapshot?.repository === repository && resultSnapshot?.parameters === parameters ? resultSnapshot : null;
  const result = currentSnapshot?.data ?? null, sequence = currentSnapshot?.sequence ?? '';
  const [exportError, setExportError] = useState<string | null>(null);
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('gcSkew');

  // Hotkey to toggle overlay
  useHotkey(
    ActionIds.OverlayGCSkew,
    () => toggle('gcSkew'),
    { modes: ['NORMAL'] }
  );

  // One operation owns both reading and computation. A changed repository,
  // selected genome, parameter set or cancellation invalidates every late value.
  useEffect(() => {
    if (!isOpen('gcSkew')) return () => { importGeneration.current++; };
    setResultSnapshot(null); setError(null); setExportError(null); setImportLoading(false); setImportError(null); setWasCancelled(false);
    setAnalysisLoading(false);
    if (!repository || !currentPhage) {
      setSequenceLoading(false);
      return () => { importGeneration.current++; };
    }
    const controller = new AbortController(); controllerRef.current = controller;
    setSequenceLoading(true);
    (async () => {
      try {
        const length = await repository.getFullGenomeLength(currentPhage.id);
        if (controller.signal.aborted) return;
        const sequence = await repository.getSequenceWindow(currentPhage.id, 0, length);
        if (controller.signal.aborted) return;
        const savedSequence = parameters.replay?.sequence ?? parameters.portable?.sequence;
        if (savedSequence !== undefined && sequence !== savedSequence) throw new Error('Saved experiment sequence does not match the selected genome. Load its exact source genome before replaying.');
        const count = sequence.length < parameters.windowSize ? 0 : Math.floor((sequence.length - parameters.windowSize) / parameters.stepSize) + 1;
        if (count > 20000 || sequence.length > 5000000) throw new Error('GC-skew input exceeds 5,000,000 bases or 20,000 sampled windows. Increase the step size for this genome.');
        setSequenceLoading(false); setAnalysisLoading(true);
        let data: AnalysisResult;
        let replay: RepeatReplayComparison | null = null;
        if (parameters.portable) {
          const { runResearchWorker } = await import('./ResearchWorkflowPanel');
          if (controller.signal.aborted) return;
          const response = await runResearchWorker({ type: 'gc-skew-replay', content: parameters.portable.content }, controller.signal);
          if (response.type !== 'analysis') throw new Error('Expected a recomputed GC-skew experiment.');
          const rows = response.record.fields.windows.value as unknown as GCSkewWindow[];
          const origin = response.record.fields.originPosition.value, terminus = response.record.fields.terminusPosition.value;
          data = { type: 'gc-skew', engine: 'js', skew: rows.map(row => row.skew ?? 0), cumulative: rows.map(row => row.cumulative),
            originPosition: typeof origin === 'number' ? origin : undefined,
            terminusPosition: typeof terminus === 'number' ? terminus : undefined, evidenceRecord: response.record };
          replay = { matches: true, differences: [], implementationMatches: true, exactRecord: true };
        } else {
          data = await getOrchestrator().runAnalysisWithSharedBuffer(currentPhage.id, sequence, 'gc-skew',
            { windowSize: parameters.windowSize, stepSize: parameters.stepSize },
            { accession: currentPhage.accession, source: currentPhage.localGenome ? 'local' : 'catalog' }, controller.signal);
          if (parameters.replay) replay = data.evidenceRecord ? compareGCSkewReplay(parameters.replay.record, data.evidenceRecord)
            : { matches: false, differences: ['fresh evidence is unavailable'], implementationMatches: false, exactRecord: false };
        }
        if (controller.signal.aborted) return;
        if (data.type !== 'gc-skew') throw new Error('Unexpected analysis result.');
        setResultSnapshot({ phage: currentPhage, sequence, repository, parameters, data, replay });
      } catch (cause) {
        if (!controller.signal.aborted) { setResultSnapshot(null); setError(cause instanceof Error ? cause.message : 'GC-skew computation failed.'); }
      } finally {
        if (!controller.signal.aborted) { setSequenceLoading(false); setAnalysisLoading(false); }
      }
    })();
    return () => {
      importGeneration.current++; controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [isOpen, currentPhage, repository, parameters]);

  const cancel = () => {
    importGeneration.current++; controllerRef.current?.abort(); setImportLoading(false);
    setSequenceLoading(false); setAnalysisLoading(false); setResultSnapshot(null); setError(null); setWasCancelled(true);
  };
  const restore = async (file: File) => {
    const generation = ++importGeneration.current;
    setImportLoading(true); setImportError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('GC-skew experiment exceeds 10 MiB.');
      const content = await file.text();
      const version = JSON.parse(content)?.method?.version;
      const parsed = version === GC_SKEW_METHOD.version ? await parseGCSkewRecord(content) : await parseGCSkewReplay(content);
      if (generation !== importGeneration.current) return;
      setWindowInput(String(parsed.options.windowSize)); setStepInput(String(parsed.options.stepSize));
      setParameters({ ...parsed.options, ...(version === GC_SKEW_METHOD.version ? { portable: { content, sequence: parsed.sequence } } : { replay: parsed as GCSkewReplay }) });
    } catch (cause) { if (generation === importGeneration.current) setImportError(cause instanceof Error ? cause.message : 'Could not read experiment.'); }
    finally { if (generation === importGeneration.current) setImportLoading(false); }
  };

  // Draw the sparkline
  useEffect(() => {
    // Need at least 2 data points to draw a line and avoid division by zero
    if (!isOpen('gcSkew') || !canvasRef.current || !result || result.cumulative.length < 2) return;

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

    // Draw grid
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;

    // Horizontal center line
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Find range for normalization
    const vals = result.cumulative;
    let min = Infinity;
    let max = -Infinity;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(Math.abs(min), Math.abs(max)) || 1;

    // Draw cumulative skew
    ctx.beginPath();
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;

    for (let i = 0; i < vals.length; i++) {
      const x = ((i * parameters.stepSize) / sequence.length) * width;
      const normalized = vals[i] / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Mark origin (minimum) and terminus (maximum)
    // Worker returns originPosition/terminusPosition in base pairs
    // We map BP to X coordinate: (bp / genomeLength) * width
    const len = sequence.length || 1;
    
    if (result.originPosition !== undefined) {
      const oriBp = result.originPosition;
      const x = (oriBp / len) * width;
      const idx = Math.round(oriBp / parameters.stepSize);
      const val = vals[idx] ?? 0;
      const normalized = val / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      drawMarker(ctx, x, y, colors.error, 'min');
    }

    if (result.terminusPosition !== undefined) {
      const terBp = result.terminusPosition;
      const x = (terBp / len) * width;
      const idx = Math.round(terBp / parameters.stepSize);
      const val = vals[idx] ?? 0;
      const normalized = val / range;
      const y = height / 2 - normalized * (height / 2 - 10);

      drawMarker(ctx, x, y, colors.success, 'max');
    }

  }, [isOpen, result, sequence.length, colors, parameters.stepSize]);

  function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string) {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.font = '12px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - 12);
  }

  if (!isOpen('gcSkew')) {
    return null;
  }

  const windowSize = parameters.windowSize;
  const genomeLength = sequence.length;
  let parameterError: string | null = null;
  try {
    if (!windowInput.trim() || !stepInput.trim()) throw new Error('Enter both window and step sizes.');
    resolveGCSkewOptions({ windowSize: Number(windowInput), stepSize: Number(stepInput) });
  } catch (cause) { parameterError = cause instanceof Error ? cause.message : 'Invalid GC-skew parameters.'; }

  const isLoading = sequenceLoading || analysisLoading;
  const hasGc = /[GC]/i.test(sequence);
  const hasData = result && result.cumulative.length >= 2 && hasGc;
  const isEmpty = !isLoading && !error && !wasCancelled && (sequence.length === 0 || !result || result.cumulative.length < 2 || !hasGc);

  return (
    <Overlay
      id="gcSkew"
      title="GC SKEW ANALYSIS"
      hotkey="g"
      size="lg"
    >
      <OverlayStack>
        <form aria-label="GC-skew parameters" onSubmit={event => {
          event.preventDefault();
          if (parameterError || !repository || !currentPhage) return;
          importGeneration.current++;
          setParameters(resolveGCSkewOptions({ windowSize: Number(windowInput), stepSize: Number(stepInput) }));
        }} style={{ display: 'flex', flexWrap: 'wrap', gap: '.75rem', alignItems: 'end' }}>
          <label>GC-skew window (bp) <input type="number" min={1} max={1000000} required value={windowInput} onChange={event => setWindowInput(event.target.value)} /></label>
          <label>GC-skew step (bp) <input type="number" min={1} max={5000000} required value={stepInput} onChange={event => setStepInput(event.target.value)} /></label>
          <button type="submit" disabled={!!parameterError || !repository || !currentPhage}>{isLoading ? 'Restart GC-skew analysis' : 'Run GC-skew analysis'}</button>
          {(isLoading || importLoading) && <button type="button" onClick={cancel}>Cancel GC-skew analysis</button>}
          {parameterError && <p role="alert">{parameterError}</p>}
        </form>
        <label>Restore GC-skew experiment (.json) <input type="file" accept=".json,application/json" disabled={!repository || !currentPhage} onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void restore(file);
        }} /></label>
        <p>Only complete linear windows are sampled, including for circular genomes. Settings become effective when you run an analysis.
          Restore requires the exact selected sequence and freshly recomputes the saved experiment. Portable workflow records retain per-window G/C counts and unavailable skew values.</p>
        {importLoading && <p role="status">Validating saved GC-skew experiment…</p>}
        {importError && <p role="alert">Could not restore GC-skew experiment: {importError}</p>}
        {error && <p role="alert">GC-skew analysis failed: {error}</p>}
        {wasCancelled && <p role="status">GC-skew analysis cancelled. Run the analysis to try again.</p>}
        {currentSnapshot?.replay && <div role={currentSnapshot.replay.matches ? 'status' : 'alert'}>
          {currentSnapshot.replay.matches ? 'Replay matched: freshly computed GC-skew values and evidence agree.'
            : `Replay differs: ${currentSnapshot.replay.differences.join('; ')}. Showing the newly computed result.`}
          {!currentSnapshot.replay.implementationMatches && <p>The execution backend differs from the saved record.</p>}
          {currentSnapshot.replay.matches && <p>{currentSnapshot.replay.exactRecord ? 'The complete result identity also matches.'
            : 'The full record identity differs because explicit defaults, transport, backend or input metadata changed.'}</p>}
          <p>Matching computation is not evidence of biological validity. Portable records retain their original source metadata.</p>
        </div>}
        {result?.evidenceRecord && <>
          <button type="button" onClick={() => {
            try {
              downloadString(serializeAnalysisRecord(result.evidenceRecord!), 'gc-skew-analysis.json', 'application/json');
              setExportError(null);
            } catch (error) { setExportError(error instanceof Error ? error.message : 'Could not export analysis.'); }
          }}>Export GC skew experiment</button>
          <AnalysisRecordDetails record={result.evidenceRecord} />
        </>}
        {(result?.evidenceError || exportError) && <p role="alert">{result?.evidenceError ?? exportError}</p>}
        {/* Loading State */}
        {isLoading && (
          <OverlayLoadingState message={sequenceLoading ? "Loading sequence data..." : "Computing GC skew..."}>
            <ChartOverlaySkeleton />
          </OverlayLoadingState>
        )}

        {/* Description */}
        {!isLoading && (
          <OverlayDescription
            title="Cumulative GC Skew"
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {hasData && currentPhage && (
                  <HowDoIKnowThis
                    title="GC Skew & Cumulative Minimum"
                    computation="Sliding-window nucleotide asymmetry (G - C) / (G + C), with inclusive per-base G-C prefix counts sampled at the same window starts. The first sampled minimum and maximum are composition candidates, not measured replication sites."
                    inputs={[
                      { label: 'Genome', value: `${currentPhage.name} (${currentPhage.accession ?? currentPhage.id})` },
                      { label: 'Length', value: `${genomeLength.toLocaleString()} bp` },
                      { label: 'Window Size', value: `${windowSize} bp` },
                      { label: 'Step Size', value: `${parameters.stepSize} bp` },
                    ]}
                    implementation={{
                      engine:
                        result?.engine === 'wasm-simd'
                          ? 'WASM (SIMD)'
                          : result?.engine === 'wasm-baseline'
                          ? 'WASM (Baseline)'
                          : 'JavaScript',
                      details: result?.engine?.startsWith('wasm')
                        ? 'Compiled Rust WebAssembly kernel compute_gc_skew'
                        : parameters.portable ? GC_SKEW_METHOD.implementation : 'TypeScript sliding-window fallback calculateGCSkewJS',
                    }}
                    citation={`GC skew was calculated across the ${currentPhage.name} genome using ${windowSize} bp complete linear windows (${parameters.stepSize} bp step) with the inclusive per-base G-C prefix sampled at window starts in Phage Explorer.`}
                  />
                )}
                {beginnerModeEnabled ? (
                  <InfoButton
                    size="sm"
                    label="Learn about GC skew"
                    tooltip={overlayHelp?.summary ?? 'GC skew compares the abundance of G vs C bases along the genome.'}
                    onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'gc-skew')}
                  />
                ) : null}
              </div>
            }
          >
            Shows nucleotide-composition asymmetry. Sampled minima and maxima can inform further
            investigation; they do not establish the origin or terminus of replication.
          </OverlayDescription>
        )}

        {/* Stats - only show when we have valid analysis data */}
        {!isLoading && hasData && genomeLength > 0 && (
          <OverlayStatGrid columns={4}>
            <OverlayStatCard label="Genome Length" value={`${genomeLength.toLocaleString()} bp`} />
            <OverlayStatCard label="Window Size" value={`${windowSize} bp`} />
            <OverlayStatCard label="Minimum candidate" value={result.originPosition === undefined ? 'Unavailable' : `${Math.round(result.originPosition).toLocaleString()} bp`} labelColor="var(--color-error)" />
            <OverlayStatCard label="Maximum candidate" value={result.terminusPosition === undefined ? 'Unavailable' : `${Math.round(result.terminusPosition).toLocaleString()} bp`} labelColor="var(--color-success)" />
          </OverlayStatGrid>
        )}

        {/* Canvas for sparkline */}
        {!isLoading && hasData && (
          <div style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="GC skew graph showing cumulative nucleotide bias across genome position"
              style={{
                width: '100%',
                height: '200px',
                display: 'block',
              }}
            />
          </div>
        )}

        {/* Legend */}
        {!isLoading && hasData && (
          <OverlayLegend>
            <OverlayLegendItem
              indicator="━"
              color={colors.primary}
              label="Cumulative GC Skew"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="What is GC skew?"
                  tooltip="GC skew highlights replication patterns by tracking G vs C imbalance along the genome."
                  onClick={() => showContextFor('gc-skew')}
                />
              ) : undefined}
            />
            <OverlayLegendItem
              indicator="●"
              color={colors.error}
              label="Minimum candidate"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="What can a cumulative minimum suggest?"
                  tooltip="A sampled composition minimum can guide further study; it does not establish a replication origin."
                  onClick={() => showContextFor('replication-origin')}
                />
              ) : undefined}
            />
            <OverlayLegendItem
              indicator="●"
              color={colors.success}
              label="Maximum candidate"
            />
          </OverlayLegend>
        )}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message={sequence.length === 0
              ? 'No sequence data available.'
              : !hasGc ? 'GC skew is undefined: this sequence has no G or C bases.'
              : `Two complete ${windowSize} bp windows at ${parameters.stepSize} bp spacing require at least ${windowSize + parameters.stepSize} bp.`}
            hint={sequence.length === 0 ? 'Select a phage to analyze.' : undefined}
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default GCSkewOverlay;
