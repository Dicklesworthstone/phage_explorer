/** React binding for a selection-scoped, cancellable simulation session. */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { derivePhageSimDefaults, nextSpeed, prevSpeed } from '@phage-explorer/core';
import { getOrchestrator } from '../workers';
import type { SimulationId } from '../workers/types';
import { SimulationSession, type SimulationSnapshot } from './SimulationSession';

export interface SimulationControls {
  init: (params?: Record<string, number | boolean | string>) => Promise<void>;
  play: () => void;
  pause: () => void;
  cancel: () => void;
  toggle: () => void;
  step: () => Promise<void>;
  /** Restart with the same seed and submitted parameters. */
  reset: () => Promise<void>;
  speedUp: () => void;
  speedDown: () => void;
  setSpeed: (speed: number) => void;
  /** Change the seed and rebuild the initial state. */
  setSeed: (seed: number) => void;
  /** Validate and rebuild initial conditions with the changed parameter. */
  setParam: (id: string, value: number | boolean | string) => void;
  exportExperiment: () => Promise<string>;
  replayExperiment: (content: string | Promise<string>) => Promise<void>;
}

export interface UseSimulationResult extends SimulationSnapshot {
  controls: SimulationControls;
}

export function useSimulation(simId: SimulationId, enabled = true): UseSimulationResult {
  const currentPhage = usePhageStore(state => state.currentPhage);
  const session = useMemo(() => new SimulationSession(
    simId, currentPhage, getOrchestrator, derivePhageSimDefaults(simId, currentPhage),
  ), [simId, currentPhage]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    if (enabled) void session.activate();
    else session.deactivate();
    return session.deactivate;
  }, [session, enabled]);
  const controls = useMemo<SimulationControls>(() => ({
    init: session.init, play: session.play, pause: session.pause, cancel: session.cancel,
    toggle: session.toggle, step: session.step, reset: session.reset, setParam: session.setParam,
    setSeed: session.setSeed, setSpeed: session.setSpeed,
    exportExperiment: session.exportExperiment, replayExperiment: session.replayExperiment,
    speedUp: () => session.setSpeed(nextSpeed(session.getSnapshot().speed)),
    speedDown: () => session.setSpeed(prevSpeed(session.getSnapshot().speed)),
  }), [session]);
  return { ...snapshot, controls };
}
