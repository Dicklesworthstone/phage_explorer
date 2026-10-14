/**
 * DotPlotOverlay - Self-Similarity Matrix Visualization
 *
 * Explores sampled genome windows for direct and reverse-complement similarity.
 * Patterns nominate candidates; this is not an exhaustive repeat annotation.
 *
 * Features:
 * - Direct repeat detection (forward matches)
 * - Inverted repeat detection (reverse complement)
 * - Interactive hover for position details
 * - Toggle between direct and inverted views
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { getDotPlotWindowRange, type PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { getOverlayContext, useBeginnerMode } from '../../education';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import {
  OverlayStack,
  OverlayDescription,
  OverlayToolbar,
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import { InfoButton } from '../ui';
import { HeatmapCanvas } from '../primitives/HeatmapCanvas';
import type { HeatmapHover, ColorScale } from '../primitives/types';
import type { DotPlotJob, DotPlotWorkerResponse } from '../../workers/types';
import { SharedSequencePool } from '../../workers/SharedSequencePool';
import { AnalysisRecordDetails } from './primitives/OverlayProvenance';
import { downloadString } from '../../utils/export';

// Color scales for direct vs inverted
const directColorScale: ColorScale = (value: number): string => {
  if (value >= 0.95) return '#22c55e'; // Green - high identity
  if (value >= 0.8) return '#3b82f6'; // Blue
  if (value >= 0.6) return '#6366f1'; // Indigo
  if (value >= 0.4) return '#8b5cf6'; // Purple
  if (value >= 0.2) return '#4b5563'; // Gray
  return '#1e293b'; // Dark
};

const invertedColorScale: ColorScale = (value: number): string => {
  if (value >= 0.95) return '#ef4444'; // Red - high identity
  if (value >= 0.8) return '#f59e0b'; // Orange
  if (value >= 0.6) return '#eab308'; // Yellow
  if (value >= 0.4) return '#84cc16'; // Lime
  if (value >= 0.2) return '#4b5563'; // Gray
  return '#1e293b'; // Dark
};

type ViewMode = 'direct' | 'inverted' | 'combined';

interface DotPlotInput {
  repository: PhageRepository;
  phage: PhageFull;
  sequence: string;
}
type MatrixResponse = DotPlotWorkerResponse & {
  ok: true; bins: number; window: number; directValues: Float32Array; invertedValues: Float32Array;
};
type ExperimentResponse = MatrixResponse & Required<Pick<DotPlotWorkerResponse,
  'evidenceRecord' | 'experimentJson' | 'experimentTsv'>>;
interface DotPlotSettings {
  resolution: number;
  window: number; // Zero requests the automatic window; saved experiments use the effective positive size.
  restored?: { input: DotPlotInput; response: ExperimentResponse };
}

function createDotPlotWorker(): Worker {
  try {
    return new Worker(new URL('../../workers/dotplot.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return new Worker(new URL('../../workers/dotplot.worker.ts', import.meta.url));
  }
}

function hasMatrix(response: DotPlotWorkerResponse, sequenceLength: number): response is MatrixResponse {
  const bins = response.bins ?? 0, window = response.window ?? 0;
  return response.ok && Number.isSafeInteger(bins) && bins > 0 && bins <= 200
    && Number.isSafeInteger(window) && window > 0 && window <= sequenceLength
    && response.directValues instanceof Float32Array && response.invertedValues instanceof Float32Array
    && response.directValues.length === bins * bins && response.invertedValues.length === bins * bins
    && response.directValues.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && response.invertedValues.every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

function hasExperiment(response: DotPlotWorkerResponse, sequence: string): response is ExperimentResponse {
  const record = response.evidenceRecord;
  return hasMatrix(response, sequence.length) && record?.format === 'phage-explorer-analysis'
    && record.method?.id === 'sequence-dot-plot' && record.method.version === '1'
    && record.inputs?.length === 1 && record.inputs[0].data === sequence
    && record.parameters?.bins === response.bins && record.parameters.window === response.window
    && record.parameters.ambiguity === 'exclude'
    && typeof response.experimentJson === 'string' && typeof response.experimentTsv === 'string';
}

interface DotPlotOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function DotPlotOverlay({
  repository,
  currentPhage,
}: DotPlotOverlayProps): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const open = isOpen('dotPlot');
  const { isEnabled: beginnerModeEnabled, showContextFor } = useBeginnerMode();
  const overlayHelp = getOverlayContext('dotPlot');
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const cancelComputeRef = useRef<(() => void) | null>(null);
  const experimentWorkerRef = useRef<Worker | null>(null);
  const experimentGeneration = useRef(0);

  // State
  const [sequenceLoading, setSequenceLoading] = useState(false);
  const [computeLoading, setComputeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [loaded, setLoaded] = useState<DotPlotInput | null>(null);
  const input = loaded?.repository === repository && loaded?.phage === currentPhage ? loaded : null;
  const sequence = input?.sequence ?? '';
  const loading = sequenceLoading || computeLoading;
  const resolvedBaseCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < sequence.length; i++) {
      const code = sequence.charCodeAt(i) | 32;
      if (code === 97 || code === 99 || code === 103 || code === 116) count++;
    }
    return count;
  }, [sequence]);

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>('combined');
  const [settings, setSettings] = useState<DotPlotSettings>({ resolution: 80, window: 0 });
  const [windowInput, setWindowInput] = useState('0');
  const resolution = settings.resolution;
  const request = useMemo(() => ({ input, resolution: settings.resolution, window: settings.window, restored: settings.restored }), [input, settings]);
  // Updated during render, not just effect cleanup: a late worker reply cannot
  // apply settings in the gap between a new selection rendering and cleanup.
  const currentRequest = useRef({ request, open });
  currentRequest.current = { request, open };
  const [computed, setComputed] = useState<{ request: typeof request; response: MatrixResponse } | null>(null);
  const restored = settings.restored?.input === input ? settings.restored : null;
  const response = restored?.response ?? (computed?.request === request ? computed.response : null);
  const [prepared, setPrepared] = useState<{ request: typeof request; response: ExperimentResponse } | null>(null);
  const experiment = restored?.response ?? (prepared?.request === request ? prepared.response : null);
  const [experimentLoading, setExperimentLoading] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentNotice, setExperimentNotice] = useState<string | null>(null);
  const requestedWindow = Number(windowInput);
  const parameterError = !/^\d+$/.test(windowInput) || !Number.isSafeInteger(requestedWindow)
    || requestedWindow < 0 || (sequence.length > 0 && requestedWindow > sequence.length)
    ? 'Window must be a whole number from 0 (automatic) to the selected sequence length.' : null;
  const directValues = response?.directValues ?? null;
  const invertedValues = response?.invertedValues ?? null;
  const bins = response?.bins ?? 0;
  const windowSize = response?.window ?? 0;
  const [hovered, setHovered] = useState<{ response: DotPlotWorkerResponse; hover: HeatmapHover } | null>(null);
  // A preview's queued pointer event must not be reinterpreted on a newer matrix.
  const hoverInfo = hovered && hovered.response === response ? hovered.hover : null;
  const handleHover = useCallback((hover: HeatmapHover | null) => {
    setHovered(hover && response ? { response, hover } : null);
  }, [response]);
  const viewSelectId = 'dotplot-view';
  const resolutionSelectId = 'dotplot-resolution';

  // Hotkey to toggle overlay (Alt+O for dOt plot - Alt+D used by ProteinDomainOverlay)
  useHotkey(
    ActionIds.OverlayDotPlot,
    () => toggle('dotPlot'),
    { modes: ['NORMAL'] }
  );

  // Request IDs below isolate progressive replies.
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Fetch full genome when overlay opens
  useEffect(() => {
    if (!open) {
      setSequenceLoading(false);
      return;
    }
    setLoaded(null);
    setError(null);
    setHovered(null);
    if (!repository || !currentPhage) {
      setSequenceLoading(false);
      setComputeLoading(false);
      return;
    }

    const phageId = currentPhage.id;

    let cancelled = false;
    setSequenceLoading(true);

    repository
      .getFullGenomeLength(phageId)
      .then((length: number) => cancelled ? '' : repository.getSequenceWindow(phageId, 0, length))
      .then((seq: string) => {
        if (cancelled) return;
        setLoaded({ repository, phage: currentPhage, sequence: seq });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Do not swallow this. Setting an empty sequence rendered "No sequence
        // loaded", which tells the user this phage has no data when in fact the
        // database read failed. The overlay already renders OverlayErrorState.
        setError(
          `Could not load sequence: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        if (!cancelled) setSequenceLoading(false);
      });

    return () => {
      cancelled = true;
      setSequenceLoading(false);
    };
  }, [open, repository, currentPhage, retryCount]);

  // Run dot plot analysis when sequence or resolution changes
  useEffect(() => {
    setComputed(null);
    setHovered(null);
    if (!open) {
      setComputeLoading(false);
      return;
    }
    const selected = request.input;
    if (!selected || selected.sequence.length === 0) {
      setComputeLoading(false);
      return;
    }
    if (request.restored?.input === selected) {
      // This is the newly recomputed, verified reply, never the imported matrix.
      setComputeLoading(false);
      setError(null);
      return;
    }
    if (request.window > selected.sequence.length) {
      setComputeLoading(false);
      setError('The requested window exceeds this genome length. Choose a smaller window or automatic sizing.');
      return;
    }

    // One worker owns this request, including its preview and final pass.
    if (!workerRef.current) {
      try {
        workerRef.current = createDotPlotWorker();
      } catch {
        // Report creation failure below.
      }
    }
    const worker = workerRef.current;
    if (!worker) {
      setError('Dot plot worker unavailable');
      setComputeLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = ++requestIdRef.current;
    let running = true;
    const expectedWindow = request.window || Math.min(selected.sequence.length,
      Math.max(20, Math.floor(selected.sequence.length / request.resolution)));
    setComputeLoading(true);
    setError(null);

    const handleMessage = (event: MessageEvent<DotPlotWorkerResponse>) => {
      const response = event.data;
      if (cancelled || currentRequest.current.request !== request || !currentRequest.current.open
          || !response || response.requestId !== requestId) return;

      if (!response.ok) {
        failWorker(response.error ?? 'Dot plot computation failed');
        return;
      }

      const outBins = response.bins ?? 0;
      const expectedResolution = outBins === request.resolution || (request.resolution >= 80 && outBins === 40);
      if (expectedResolution && response.window === expectedWindow && hasMatrix(response, selected.sequence.length)) {
        running = outBins !== request.resolution;
        setComputeLoading(outBins !== request.resolution);
        setComputed({ request, response });
      } else {
        failWorker('Dot plot worker returned an invalid matrix');
      }
    };

    const failWorker = (message: string) => {
      if (cancelled || currentRequest.current.request !== request || !currentRequest.current.open) return;
      setComputed(null);
      setComputeLoading(false);
      setError(message);
      running = false;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.onmessage = handleMessage;
    worker.onerror = (event) => failWorker(event.message || 'Dot plot worker failed');
    worker.onmessageerror = () => failWorker('Could not decode dot plot worker response');
    const cancelCompute = () => {
      failWorker('Dot plot analysis cancelled. Run analysis to restart.');
      cancelled = true;
    };
    cancelComputeRef.current = cancelCompute;
    const config = { bins: request.resolution, window: request.window, ambiguity: 'exclude' as const };
    try {
      if (/^[ACGT]+$/i.test(selected.sequence)) {
        try {
          const { ref: sequenceRef, transfer } = SharedSequencePool.getInstance().getOrCreateRef(selected.phage.id, selected.sequence);
          worker.postMessage({ requestId, sequenceRef, config }, transfer);
        } catch {
          worker.postMessage({ requestId, sequence: selected.sequence, config });
        }
      } else {
        // Preserve unresolved symbols/coordinates rather than using a lossy base encoding.
        worker.postMessage({ requestId, sequence: selected.sequence, config });
      }
    } catch (cause: unknown) {
      failWorker(cause instanceof Error ? cause.message : String(cause));
    }

    return () => {
      cancelled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      // A synchronous kernel cannot receive a cancel message. Termination also
      // prevents new settings from queueing behind an abandoned full pass.
      if (running) {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
      // Completed workers may stay warm; only abandoned computation must die.
      if (cancelComputeRef.current === cancelCompute) cancelComputeRef.current = null;
      setComputeLoading(false);
    };
  }, [open, request]);

  useEffect(() => {
    setPrepared(null);
    setExperimentLoading(false);
    setExperimentError(null);
    setExperimentNotice(null);
    return () => {
      experimentGeneration.current++;
      experimentWorkerRef.current?.terminate();
      experimentWorkerRef.current = null;
    };
  }, [request, open]);

  const cancelExperiment = () => {
    experimentGeneration.current++;
    experimentWorkerRef.current?.terminate();
    experimentWorkerRef.current = null;
    setExperimentLoading(false);
    setExperimentError(null);
    setExperimentNotice('Experiment operation cancelled. Accepted settings and results are unchanged.');
  };

  const runExperiment = async (file?: File) => {
    const selected = request.input;
    if (!open || !selected || (!file && (!response || response.bins !== resolution))) return;
    const generation = ++experimentGeneration.current;
    experimentWorkerRef.current?.terminate();
    experimentWorkerRef.current = null;
    setExperimentLoading(true);
    setExperimentError(null);
    setExperimentNotice(null);
    const active = () => generation === experimentGeneration.current
      && currentRequest.current.request === request && currentRequest.current.open;
    let worker: Worker | null = null;
    const finish = () => {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
      if (experimentWorkerRef.current === worker) experimentWorkerRef.current = null;
      if (active()) setExperimentLoading(false);
    };
    const fail = (message: string) => {
      if (active()) setExperimentError(message);
      finish();
    };
    try {
      if (file && file.size > 10 * 1024 * 1024) throw new Error('Analysis record exceeds the 10 MiB limit.');
      const content = file ? await file.text() : null;
      if (!active()) return;
      worker = createDotPlotWorker();
      experimentWorkerRef.current = worker;
      const requestId = ++requestIdRef.current;
      worker.onmessage = (event: MessageEvent<DotPlotWorkerResponse>) => {
        const result = event.data;
        if (!active() || !result || result.requestId !== requestId) return;
        if (!result.ok) { fail(result.error ?? 'Dot plot experiment failed.'); return; }
        if (!hasExperiment(result, selected.sequence) || (file && typeof result.replayExactRecord !== 'boolean')) {
          fail('Dot plot worker returned an invalid experiment.');
          return;
        }
        finish();
        if (file) {
          // One state transition installs settings and the freshly computed
          // matrix. Failed parsing, mismatch or cancellation cannot get here.
          setWindowInput(String(result.window));
          setSettings({ resolution: result.bins, window: result.window, restored: { input: selected, response: result } });
          setError(null);
        } else {
          setPrepared({ request, response: result });
          setExperimentNotice('Experiment prepared: the exact recomputation matches the displayed final matrix.');
        }
      };
      worker.onerror = event => fail(event.message || 'Dot plot experiment worker failed.');
      worker.onmessageerror = () => fail('Could not decode the dot plot experiment response.');
      const context = { accession: selected.phage.accession, source: selected.phage.localGenome ? 'local' as const : 'catalog' as const };
      let job: DotPlotJob;
      if (content !== null) {
        job = { requestId, sequence: selected.sequence, experiment: { kind: 'replay', context, content } };
      } else {
        if (!response) throw new Error('No completed dot plot to export.');
        job = { requestId, sequence: selected.sequence,
          config: { bins: response.bins, window: response.window, ambiguity: 'exclude' },
          experiment: { kind: 'create', context, displayed: {
            bins: response.bins, window: response.window, directValues: response.directValues, invertedValues: response.invertedValues,
          } } };
      }
      // Clone the displayed arrays, never transfer/detach the live heatmap.
      // Exactly one auxiliary worker exists and is terminated on every outcome.
      worker.postMessage(job);
    } catch (cause: unknown) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const downloadExperiment = (format: 'json' | 'tsv') => {
    if (!experiment) return;
    try {
      const filename = `dot-plot-${experiment.evidenceRecord.resultId.slice(0, 12)}.${format}`;
      downloadString(format === 'json' ? experiment.experimentJson : experiment.experimentTsv,
        filename, format === 'json' ? 'application/json' : 'text/tab-separated-values');
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Combined values (max of direct and inverted)
  const combinedValues = useMemo(() => {
    if (!directValues || !invertedValues) return null;
    const combined = new Float32Array(directValues.length);
    for (let i = 0; i < directValues.length; i++) {
      combined[i] = Math.max(directValues[i], invertedValues[i]);
    }
    return combined;
  }, [directValues, invertedValues]);

  // Get current display values based on view mode
  const displayValues = useMemo(() => {
    switch (viewMode) {
      case 'direct':
        return directValues;
      case 'inverted':
        return invertedValues;
      case 'combined':
        return combinedValues;
      default:
        return combinedValues;
    }
  }, [viewMode, directValues, invertedValues, combinedValues]);

  // Combined color scale
  const combinedColorScale: ColorScale = useCallback(
    (value: number): string => {
      if (!directValues || !invertedValues || !hoverInfo) {
        // Default coloring when no hover
        if (value >= 0.95) return '#22c55e';
        if (value >= 0.8) return '#3b82f6';
        if (value >= 0.6) return '#6366f1';
        if (value >= 0.4) return '#8b5cf6';
        if (value >= 0.2) return '#4b5563';
        return '#1e293b';
      }
      return directColorScale(value);
    },
    [directValues, invertedValues, hoverInfo]
  );

  // Get color scale based on view mode
  const currentColorScale = useMemo((): ColorScale => {
    switch (viewMode) {
      case 'direct':
        return directColorScale;
      case 'inverted':
        return invertedColorScale;
      case 'combined':
        return combinedColorScale;
      default:
        return combinedColorScale;
    }
  }, [viewMode, combinedColorScale]);

  const hoverDetails = useMemo(() => {
    if (!hoverInfo || !directValues || !invertedValues || !sequence || bins < 1 || windowSize < 1) return null;
    const { row, col } = hoverInfo;
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0 || row >= bins || col >= bins) return null;
    return {
      x: getDotPlotWindowRange(sequence.length, bins, windowSize, col),
      y: getDotPlotWindowRange(sequence.length, bins, windowSize, row),
      direct: directValues[row * bins + col],
      inverted: invertedValues[row * bins + col],
      coverageX: directValues[col * bins + col],
      coverageY: directValues[row * bins + row],
    };
  }, [hoverInfo, directValues, invertedValues, sequence, bins, windowSize]);

  if (!open) return null;

  const hasData = displayValues && bins > 0;
  const isEmpty = !loading && !error && (!displayValues || bins === 0);

  return (
    <Overlay id="dotPlot" title="DOT PLOT ANALYSIS" hotkey="Alt+O" size="lg">
      <OverlayStack>
        {/* Description */}
        <OverlayDescription
          title="Dot Plot"
          action={beginnerModeEnabled ? (
            <InfoButton
              size="sm"
              label="Learn about dot plots"
              tooltip={overlayHelp?.summary ?? 'Dot plots are self-comparison matrices that reveal repeats and rearrangements.'}
              onClick={() => showContextFor(overlayHelp?.glossary?.[0] ?? 'dot-plot')}
            />
          ) : undefined}
        >
          Sampled windows are compared in direct and reverse-complement orientations.
          Scores count resolved A/C/G/T matches divided by the full window length;
          unknown and IUPAC ambiguity symbols never count as matching evidence.
          Combined view shows the larger of the two scores, not an average or an exact repeat call.
        </OverlayDescription>

        {/* Controls */}
        <OverlayToolbar>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor={viewSelectId} style={{ color: 'var(--color-text-muted)' }}>
              View:
            </label>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="What are direct vs inverted repeats?"
                tooltip="Switch between direct repeats, inverted repeats, or a combined view to interpret repeat structure."
                onClick={() => showContextFor('dot-plot')}
              />
            )}
            <select
              id={viewSelectId}
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value as ViewMode)}
              style={{
                padding: '0.25rem',
                backgroundColor: 'var(--color-background-alt)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <option value="combined">Combined</option>
              <option value="direct">Direct Repeats</option>
              <option value="inverted">Inverted Repeats</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label htmlFor={resolutionSelectId} style={{ color: 'var(--color-text-muted)' }}>
              Resolution:
            </label>
            {beginnerModeEnabled && (
              <InfoButton
                size="sm"
                label="What does resolution mean?"
                tooltip="Higher resolution samples more positions. Windows can overlap; preview and final views keep the same window size."
                onClick={() => showContextFor('sliding-window')}
              />
            )}
            <select
              id={resolutionSelectId}
              value={resolution}
              onChange={(e) => setSettings({ resolution: Number(e.target.value), window: settings.window })}
              style={{
                padding: '0.25rem',
                backgroundColor: 'var(--color-background-alt)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <option value={40}>Low (40x40)</option>
              <option value={80}>Medium (80x80)</option>
              <option value={120}>High (120x120)</option>
              <option value={200}>Very High (200x200)</option>
              {![40, 80, 120, 200].includes(resolution) && <option value={resolution}>Restored ({resolution}x{resolution})</option>}
            </select>
          </div>

          {currentPhage && (
            <span style={{ color: 'var(--color-text-dim)' }}>
              {currentPhage.name} ({sequence.length.toLocaleString()} bp)
            </span>
          )}
        </OverlayToolbar>

        <form aria-label="Dot plot window parameters" onSubmit={event => {
          event.preventDefault();
          if (parameterError || !input) return;
          setSettings({ resolution, window: requestedWindow });
        }} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '0.75rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            Window size (bp; 0 = automatic)
            <input type="number" min={0} max={sequence.length || undefined} step={1} required
              value={windowInput} onChange={event => {
                if (experimentLoading) cancelExperiment();
                setWindowInput(event.target.value);
              }} />
          </label>
          <button type="submit" disabled={!input || !!parameterError}>Run analysis</button>
          {computeLoading && <button type="button" onClick={() => cancelComputeRef.current?.()}>Cancel analysis</button>}
          {parameterError && <p role="alert" style={{ width: '100%' }}>{parameterError}</p>}
        </form>
        <p style={{ fontSize: '0.8rem', margin: 0 }}>
          Editing the window does not change a completed result until Run analysis is pressed.
          Changing resolution recomputes with the last accepted window setting.
        </p>

        <section aria-label="Dot plot experiment" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <button type="button" disabled={!response || response.bins !== resolution || computeLoading || experimentLoading}
              onClick={() => { void runExperiment(); }}>Prepare dot plot experiment</button>
            <button type="button" disabled={!experiment} onClick={() => downloadExperiment('json')}>Download dot plot experiment (JSON)</button>
            <button type="button" disabled={!experiment} onClick={() => downloadExperiment('tsv')}>Download dot plot matrix (TSV)</button>
            {experimentLoading && <button type="button" onClick={cancelExperiment}>Cancel experiment operation</button>}
          </div>
          <label>
            Restore dot plot experiment (.json)
            <input type="file" accept=".json,application/json" disabled={!input}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void runExperiment(file);
              }} />
          </label>
          <p style={{ fontSize: '0.8rem', margin: 0 }}>
            Preparation verifies the final displayed matrix against an exact recomputation.
            JSON includes the complete selected genome; sharing it shares those bases.
            TSV contains scores, coordinates and checksums, not the sequence.
            Preparation and replay run locally without uploading your input.
          </p>
          {experimentLoading && <p role="status">Computing and verifying the dot plot experiment...</p>}
          {experimentError && <p role="alert">Dot plot experiment unavailable: {experimentError} Accepted settings and results are unchanged.</p>}
          {experimentNotice && <p role="status">{experimentNotice}</p>}
          {restored && <p role="status">
            Replay matched: freshly computed matrices, sampled coordinates and evidence agree.
            {' '}{restored.response.replayExactRecord
              ? 'The complete record identity also matches.'
              : 'Input display metadata differs; the new record preserves the current source identity.'}
            {' '}Reproducibility does not establish biological accuracy.
          </p>}
          {experiment && <AnalysisRecordDetails record={experiment.evidenceRecord} />}
        </section>

        {/* Loading State */}
        {loading && !hasData && (
          <OverlayLoadingState message="Computing dot plot...">
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        )}

        {/* Error State */}
        {error && !loading && (
          <>
            <OverlayErrorState message={error} />
            <button type="button" className="btn btn-secondary" onClick={() => setRetryCount(count => count + 1)}>
              Retry analysis
            </button>
          </>
        )}

        {/* Empty State */}
        {isEmpty && (
          <OverlayEmptyState
            message={!sequence ? 'No sequence loaded' : 'No dot plot result available'}
            hint="Select a phage with sufficient sequence data."
          />
        )}

        {/* Main Content */}
        {hasData && !error && (
          <>
            {/* Dot Plot Matrix */}
            <div>
              <div
                style={{
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'flex-start',
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted)',
                      marginBottom: '0.25rem',
                    }}
                  >
                    {viewMode === 'direct'
                      ? 'Direct Repeats'
                      : viewMode === 'inverted'
                        ? 'Inverted Repeats'
                        : 'Combined View'}{' '}
                    ({bins}x{bins}, window: {windowSize} bp)
                  </div>
                  <div role="status" aria-live="polite" style={{ fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                    {bins < resolution ? `Preview; refining to ${resolution}x${resolution}. ` : 'Analysis complete. '}
                    Resolved bases: {resolvedBaseCount.toLocaleString()} / {sequence.length.toLocaleString()}
                    {' '}({((resolvedBaseCount / sequence.length) * 100).toFixed(1)}%).
                  </div>
                  <HeatmapCanvas
                    width={Math.min(450, bins * 4)}
                    height={Math.min(450, bins * 4)}
                    matrix={{
                      rows: bins,
                      cols: bins,
                      values: displayValues,
                      min: 0,
                      max: 1,
                    }}
                    colorScale={currentColorScale}
                    onHover={handleHover}
                    ariaLabel={`Dot plot ${viewMode} view, resolved matches per full window`}
                  />
                </div>

                {/* Color Legend (vertical swatch) */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    fontSize: '0.7rem',
                    marginTop: '1.5rem',
                  }}
                >
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: '0.25rem' }}>Score</div>
                  {viewMode === 'inverted' ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#ef4444' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#f59e0b' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#eab308' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>60-80%</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#22c55e' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>&gt;95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#3b82f6' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>80-95%</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: '12px', height: '12px', backgroundColor: '#6366f1' }} />
                        <span style={{ color: 'var(--color-text-muted)' }}>60-80%</span>
                      </div>
                    </>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#4b5563' }} />
                    <span style={{ color: 'var(--color-text-muted)' }}>20-40%</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <span style={{ width: '12px', height: '12px', backgroundColor: '#1e293b' }} />
                    <span style={{ color: 'var(--color-text-muted)' }}>&lt;20%</span>
                  </div>
                </div>
              </div>

              {/* Hover info */}
              {hoverDetails && (
                <div
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem',
                    backgroundColor: 'var(--color-background-alt)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                  }}
                >
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    Window X: {(hoverDetails.x.start + 1).toLocaleString()}–{hoverDetails.x.end.toLocaleString()} bp
                    {' | '}Window Y: {(hoverDetails.y.start + 1).toLocaleString()}–{hoverDetails.y.end.toLocaleString()} bp
                    {' '}(1-based, inclusive)
                  </span>
                  <span style={{ marginLeft: '1rem', fontWeight: 'bold' }}>
                    Direct score: {(hoverDetails.direct * 100).toFixed(1)}%
                    {' | '}Inverted score: {(hoverDetails.inverted * 100).toFixed(1)}%
                  </span>
                  <div style={{ marginTop: '0.25rem', color: 'var(--color-text-muted)' }}>
                    Resolved coverage: X {(hoverDetails.coverageX * 100).toFixed(1)}%
                    {' | '}Y {(hoverDetails.coverageY * 100).toFixed(1)}%.
                    {' '}Scores retain the full window denominator, not only the observed bases.
                  </div>
                </div>
              )}
            </div>

            {/* Interpretation guide */}
            <OverlayDescription
              title="Reading the plot:"
              action={beginnerModeEnabled ? (
                <InfoButton
                  size="sm"
                  label="Dot plot interpretation tips"
                  tooltip="Patterns suggest candidates. Confirm them with exact sequence alignment or repeat search."
                  onClick={() => showContextFor('dot-plot')}
                />
              ) : undefined}
              style={{ fontSize: '0.75rem' }}
            >
              <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0 }}>
                <li><strong>Direct main diagonal</strong>: Resolved-base coverage; unknown positions reduce brightness.</li>
                <li><strong>Parallel patterns</strong>: Candidates for direct repeats, not confirmed duplications.</li>
                <li><strong>Reverse-complement patterns</strong>: Candidates for inverted similarity or palindromes.</li>
                <li><strong>Sampling limits</strong>: Windows can overlap or skip positions. This is not an exhaustive repeat search or a packaging-mechanism prediction.</li>
              </ul>
            </OverlayDescription>
          </>
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default DotPlotOverlay;
