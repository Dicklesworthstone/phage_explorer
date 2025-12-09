import React, { useEffect, useMemo } from 'react';
import { Overlay } from './overlays/Overlay';
import { useOverlay } from './overlays/OverlayProvider';
import { useTheme } from '../hooks/useTheme';
import { TimeControls, ParameterPanel } from './simulations';
import { useSimulation } from '../hooks/useSimulation';
import type { SimulationId, SimState } from '../workers/types';
import {
  LysogenyVisualizer,
  PlaqueVisualizer,
  RibosomeVisualizer,
  EvolutionVisualizer,
  InfectionKineticsVisualizer,
  PackagingMotorVisualizer,
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
};

function normalizeSimId(simId: string | undefined): SimulationId {
  if (simId && SIM_ID_MAP[simId]) return SIM_ID_MAP[simId];
  return 'lysogeny-circuit';
}

function VisualizerRouter({ simId, state }: { simId: SimulationId; state: SimState }): React.ReactElement | null {
  switch (simId) {
    case 'lysogeny-circuit':
      return <LysogenyVisualizer state={state as any} width={540} height={260} />;
    case 'plaque-automata':
      return <PlaqueVisualizer state={state as any} width={540} height={260} />;
    case 'ribosome-traffic':
      return <RibosomeVisualizer state={state as any} width={540} height={260} />;
    case 'evolution-replay':
      return <EvolutionVisualizer state={state as any} width={540} height={260} />;
    case 'infection-kinetics':
      return <InfectionKineticsVisualizer state={state as any} width={540} height={260} />;
    case 'packaging-motor':
      return <PackagingMotorVisualizer state={state as any} width={540} height={260} />;
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

  if (!isOpen('simulationView')) {
    return null;
  }

  const simId = useMemo(() => {
    const fromOverlay = overlayData['simulationView.simId'] as string | undefined;
    return normalizeSimId(fromOverlay);
  }, [overlayData]);

  const {
    state,
    isRunning,
    speed,
    avgStepMs,
    parameters,
    metadata,
    controls,
    isLoading,
    error,
  } = useSimulation(simId);

  // Auto-init when opened and no state yet
  useEffect(() => {
    if (!isLoading && !state) {
      void controls.init();
    }
  }, [controls, isLoading, state]);

  const paramValues = (state as any)?.params ?? {};
  const simTime = (state as any)?.time ?? 0;

  return (
    <Overlay
      id="simulationView"
      title={`SIMULATION: ${metadata?.name ?? simId}`}
      icon="🧪"
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
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={{ color: colors.text, fontWeight: 600 }}>
              {metadata?.name ?? simId}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {isLoading && <span className="badge">Loading</span>}
              {error && <span className="badge badge-error">Error</span>}
              {isRunning && <span className="badge badge-success">Running</span>}
              {!!avgStepMs && (
                <span className="badge">
                  {avgStepMs.toFixed(1)} ms/step
                </span>
              )}
            </div>
          </div>
          {metadata?.description && (
            <div style={{ color: colors.textDim, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              {metadata.description}
            </div>
          )}
          {state ? (
            <VisualizerRouter simId={simId} state={state} />
          ) : (
            <div style={{ color: colors.textDim, padding: '1rem 0.5rem' }}>
              {isLoading ? 'Initializing simulation…' : 'No simulation state yet.'}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <TimeControls
            controls={controls}
            isRunning={isRunning}
            speed={speed}
            time={simTime}
            disabled={isLoading}
            statusText={error ?? undefined}
          />

          <ParameterPanel
            parameters={parameters}
            values={paramValues}
            onChange={(id, value) => controls.setParam(id, value)}
            disabled={isLoading}
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
            <div style={{ fontWeight: 600, marginBottom: '0.25rem', color: colors.text }}>
              State Snapshot
            </div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {state ? JSON.stringify(state, null, 2) : '—'}
            </pre>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
