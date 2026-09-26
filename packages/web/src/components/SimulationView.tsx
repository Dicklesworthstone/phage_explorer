import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Overlay } from './overlays/Overlay';
import { Badge, ErrorBadge, SuccessBadge } from './ui/Badge';
import { useOverlay } from './overlays/OverlayProvider';
import { useTheme } from '../hooks/useTheme';
import { TimeControls, ParameterPanel } from './simulations';
import { useSimulation } from '../hooks/useSimulation';
import { downloadString } from '../utils/export';
import type { SimulationId, SimState } from '../workers/types';
import {
  LysogenyVisualizer,
  PlaqueVisualizer,
  RibosomeVisualizer,
  EvolutionVisualizer,
  InfectionKineticsVisualizer,
  PackagingMotorVisualizer,
  ResistanceVisualizer,
} from './simulations';

const SIM_ID_MAP: Record<string, SimulationId> = {
  'lysogeny-circuit': 'lysogeny-circuit',
  'lysogenic-switch': 'lysogeny-circuit',
  'lytic-cycle': 'infection-kinetics',
  'population-dynamics': 'infection-kinetics',
  coinfection: 'infection-kinetics',
  'infection-kinetics': 'infection-kinetics',
  'dna-packaging': 'packaging-motor',
  'packaging-motor': 'packaging-motor',
  transcription: 'ribosome-traffic',
  'ribosome-traffic': 'ribosome-traffic',
  'receptor-binding': 'ribosome-traffic',
  'burst-size': 'plaque-automata',
  'plaque-automata': 'plaque-automata',
  'evolution-replay': 'evolution-replay',
  'resistance-evolution': 'evolution-replay',
  'resistance-cocktail': 'resistance-cocktail',
};

function normalizeSimId(simId: string | undefined): SimulationId {
  if (simId && SIM_ID_MAP[simId]) return SIM_ID_MAP[simId];
  return 'lysogeny-circuit';
}

function VisualizerRouter({
  simId,
  state,
  width,
  height,
}: { simId: SimulationId; state: SimState; width: number; height: number }): React.ReactElement | null {
  switch (simId) {
    case 'lysogeny-circuit':
      return <LysogenyVisualizer state={state as any} width={width} height={height} />;
    case 'plaque-automata':
      return <PlaqueVisualizer state={state as any} size={Math.min(width, height * 1.1)} />;
    case 'ribosome-traffic':
      return <RibosomeVisualizer state={state as any} width={width} height={height} />;
    case 'evolution-replay':
      return <EvolutionVisualizer state={state as any} width={width} height={height} />;
    case 'infection-kinetics':
      return <InfectionKineticsVisualizer state={state as any} width={width} height={height} />;
    case 'packaging-motor':
      return <PackagingMotorVisualizer state={state as any} width={width} height={height} />;
    case 'resistance-cocktail':
      return <ResistanceVisualizer state={state as any} width={width} height={height} />;
    default:
      return (
        <pre
          style={{
            maxHeight: 260,
            overflow: 'auto',
            background: '#0b1021',
            padding: '0.75rem',
            borderRadius: '4px',
            fontSize: '0.85rem',
          }}
        >
          {JSON.stringify(state, null, 2)}
        </pre>
      );
  }
}

export default function SimulationView(): React.ReactElement | null {
  const { isOpen, close, overlayData } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;
  const vizContainerRef = useRef<HTMLDivElement | null>(null);
  const autoStartedRef = useRef(false);
  const [vizSize, setVizSize] = useState({ width: 540, height: 300 });
  const [seedInput, setSeedInput] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileActionRef = useRef(0);

  // ALL hooks must be called unconditionally before any early return.
  const simId = useMemo(() => {
    const fromOverlay = overlayData['simulationView.simId'] as string | undefined;
    return normalizeSimId(fromOverlay);
  }, [overlayData]);
  const isOpenSimView = isOpen('simulationView');
  const {
    state, isRunning, speed, avgStepMs, parameters, parameterValues,
    metadata, controls, isLoading, isStepping, error, seed, completedSteps, replayProgress, replayMessage,
  } = useSimulation(simId, isOpenSimView);
  const controlsRef = useRef(controls);
  const openRef = useRef(isOpenSimView);
  controlsRef.current = controls;
  openRef.current = isOpenSimView;

  useEffect(() => { fileActionRef.current++; setFileError(null); }, [controls, isOpenSimView]);

  useEffect(() => { setSeedInput(String(seed)); }, [seed]);

  // Resize observer to keep visualizer responsive.
  useLayoutEffect(() => {
    const el = vizContainerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(360, Math.min(780, rect.width));
      const height = Math.min(420, Math.max(220, Math.round(width * 0.52)));
      setVizSize({ width, height });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpenSimView]);

  // A new selection gets a fresh session. Parameter edits and same-seed resets
  // deliberately stay paused; errors/cancellation must not trigger retry loops.
  useEffect(() => { autoStartedRef.current = false; }, [controls, isOpenSimView]);
  useEffect(() => {
    if (replayMessage) { autoStartedRef.current = true; return; }
    if (isOpenSimView && state && !isRunning && !isLoading && !error && !autoStartedRef.current) {
      autoStartedRef.current = true;
      controls.play();
    }
  }, [controls, error, isLoading, isOpenSimView, isRunning, state, replayMessage]);

  if (!isOpenSimView) return null;
  const seedValue = Number(seedInput);
  const validSeed = seedInput.trim() !== '' && Number.isInteger(seedValue) && seedValue >= 0 && seedValue <= 0xffffffff;

  return (
    <Overlay
      id="simulationView"
      title={`SIMULATION: ${metadata?.name ?? simId}`}
      size="xl"
      onClose={() => close('simulationView')}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem' }}>
        <div
          style={{
            border: `1px solid ${colors.borderLight}`,
            borderRadius: '6px',
            padding: '0.75rem',
            background: colors.background,
            minHeight: 320,
          }}
          ref={vizContainerRef}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={{ color: colors.text, fontWeight: 600 }}>{metadata?.name ?? simId}</div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {isLoading && <Badge>Loading</Badge>}
              {error && <ErrorBadge>Error</ErrorBadge>}
              {isRunning && <SuccessBadge>Running</SuccessBadge>}
              {!!avgStepMs && <Badge>{avgStepMs.toFixed(1)} ms/step</Badge>}
            </div>
          </div>
          {metadata?.description && (
            <div style={{ color: colors.textDim, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              {metadata.description}
            </div>
          )}
          {state ? (
            <VisualizerRouter simId={simId} state={state} width={vizSize.width} height={vizSize.height} />
          ) : (
            <div style={{ color: colors.textDim, padding: '1rem 0.5rem' }}>
              {isLoading ? 'Initializing simulation…' : 'No simulation state yet. Use Initialize / Retry to start.'}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <TimeControls
            controls={controls}
            isRunning={isRunning}
            speed={speed}
            time={state?.time ?? 0}
            disabled={isLoading || !state}
            statusText={error ?? undefined}
          />
          <fieldset style={{ border: `1px solid ${colors.borderLight}`, padding: '0.75rem' }}>
            <legend>Reproducible run</legend>
            <label htmlFor="simulation-seed">Simulation seed</label>
            <input id="simulation-seed" type="number" min={0} max={0xffffffff} step={1}
              value={seedInput} onChange={event => setSeedInput(event.target.value)} disabled={isLoading} />
            <button type="button" disabled={isLoading || !validSeed} onClick={() => controls.setSeed(seedValue)}>
              Apply seed &amp; reset
            </button>
            <button type="button" disabled={!isLoading && !isStepping && !isRunning} onClick={controls.cancel}>
              Cancel simulation work
            </button>
            {(!state || error) && <button type="button" disabled={isLoading} onClick={() => void controls.init()}>
              Initialize / Retry
            </button>}
            <button type="button" disabled={!state || isLoading || isStepping || isRunning} onClick={async () => {
              const token = ++fileActionRef.current;
              const owner = controls;
              try {
                const content = await owner.exportExperiment();
                if (fileActionRef.current !== token || controlsRef.current !== owner || !openRef.current) return;
                downloadString(content, `simulation-${simId}.json`, 'application/json');
                setFileError(null);
              } catch (cause) {
                if (fileActionRef.current === token && controlsRef.current === owner && openRef.current) {
                  setFileError(cause instanceof Error ? cause.message : String(cause));
                }
              }
            }}>Export simulation experiment</button>
            <label htmlFor="simulation-experiment">Restore and verify simulation experiment (.json)</label>
            <input id="simulation-experiment" type="file" accept=".json,application/json" disabled={isLoading}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (!file) return;
                fileActionRef.current++;
                setFileError(null);
                void controls.replayExperiment(file.size > 10 * 1024 * 1024
                  ? Promise.reject(new Error('Simulation experiment exceeds the 10 MiB limit.')) : file.text());
              }} />
            {replayProgress && <p role="status">Replaying {replayProgress.current}/{replayProgress.total} accepted steps.
              The existing view is unchanged until verification succeeds.</p>}
            {replayMessage && <p role="status">{replayMessage}</p>}
            {fileError && <p role="alert">{fileError}</p>}
            <p style={{ color: colors.textDim, fontSize: '0.8rem' }}>
              Reset keeps seed {seed} and submitted parameters. Parameter edits rebuild the initial state.
              {' '}{completedSteps.toLocaleString()} accepted steps. Reproducibility does not establish biological accuracy.
            </p>
            {error && <p role="alert">{error}</p>}
          </fieldset>
          <ParameterPanel
            parameters={parameters}
            values={parameterValues}
            onChange={(id, value) => controls.setParam(id, value)}
            disabled={isLoading}
            compact={vizSize.width < 520}
          />
          <div
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              padding: '0.75rem',
              background: colors.backgroundAlt,
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              color: colors.textDim,
              maxHeight: 160,
              overflow: 'auto',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.25rem', color: colors.text }}>State Snapshot</div>
            <pre data-testid="simulation-state" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {state ? JSON.stringify(state, null, 2) : '—'}
            </pre>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
