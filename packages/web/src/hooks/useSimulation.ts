/**
 * useSimulation - React hook for running simulations
 *
 * Provides a clean interface for initializing, running, and controlling
 * simulations that run in Web Workers.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { getOrchestrator } from '../workers';
import type {
  SimulationId,
  SimState,
  SimParameter,
} from '../workers/types';

export interface SimulationControls {
  /** Initialize or reset the simulation */
  init: (params?: Record<string, number | boolean | string>) => Promise<void>;
  /** Start/resume the simulation */
  play: () => void;
  /** Pause the simulation */
  pause: () => void;
  /** Toggle play/pause */
  toggle: () => void;
  /** Step forward by one frame */
  step: () => Promise<void>;
  /** Reset simulation with current params */
  reset: () => Promise<void>;
  /** Increase simulation speed */
  speedUp: () => void;
  /** Decrease simulation speed */
  speedDown: () => void;
  /** Set simulation speed directly */
  setSpeed: (speed: number) => void;
  /** Update a parameter value */
  setParam: (id: string, value: number | boolean | string) => void;
}

export interface UseSimulationResult {
  /** Current simulation state */
  state: SimState | null;
  /** Whether simulation is running */
  isRunning: boolean;
  /** Current speed multiplier */
  speed: number;
  /** Rolling average step time (ms) */
  avgStepMs: number;
  /** Available parameters */
  parameters: SimParameter[];
  /** Simulation metadata */
  metadata: { name: string; description: string } | null;
  /** Controls object */
  controls: SimulationControls;
  /** Whether simulation is loading/initializing */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const DEFAULT_DT = 1;
const FRAME_INTERVAL = 50; // 20 fps for simulation updates

export function useSimulation(simId: SimulationId): UseSimulationResult {
  const [state, setState] = useState<SimState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [parameters, setParameters] = useState<SimParameter[]>([]);
  const [metadata, setMetadata] = useState<{ name: string; description: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avgStepMs, setAvgStepMs] = useState(0);

  const paramsRef = useRef<Record<string, number | boolean | string>>({});
  const animationRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<SimState | null>(null);
  const speedRef = useRef<number>(1);
  const mountedRef = useRef(true);

  // Keep stateRef in sync
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Keep speedRef in sync for interval callbacks
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // Load metadata on mount
  useEffect(() => {
    const orchestrator = getOrchestrator();
    orchestrator.getSimulationMetadata(simId)
      .then(meta => {
        setMetadata({ name: meta.name, description: meta.description });
        setParameters(meta.parameters);
        // Initialize default params
        const defaults: Record<string, number | boolean | string> = {};
        for (const p of meta.parameters) {
          defaults[p.id] = p.defaultValue;
        }
        paramsRef.current = defaults;
      })
      .catch(err => {
        setError(`Failed to load simulation metadata: ${err.message}`);
      });

    // Cleanup on unmount
    return () => {
      mountedRef.current = false;
      if (animationRef.current) {
        clearInterval(animationRef.current);
      }
    };
  }, [simId]);

  // Initialize simulation
  const init = useCallback(async (params?: Record<string, number | boolean | string>) => {
    setIsLoading(true);
    setError(null);
    try {
      const orchestrator = getOrchestrator();
      const mergedParams = { ...paramsRef.current, ...params };
      paramsRef.current = mergedParams;

      const newState = await orchestrator.initSimulation({
        simId,
        params: mergedParams,
        seed: Date.now(),
      });
      setState(newState);
      setIsRunning(false);
      if (animationRef.current) {
        clearInterval(animationRef.current);
        animationRef.current = null;
      }
    } catch (err) {
      setError(`Failed to initialize simulation: ${(err as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  }, [simId]);

  // Step simulation
  const step = useCallback(async () => {
    if (!stateRef.current) return;
    try {
      const orchestrator = getOrchestrator();
      const start = performance.now();
      const newState = await orchestrator.stepSimulation(
        stateRef.current,
        DEFAULT_DT * speedRef.current
      );
      if (!mountedRef.current) return;
      setState(newState);
      const elapsed = performance.now() - start;
      setAvgStepMs(prev => (prev === 0 ? elapsed : prev * 0.8 + elapsed * 0.2));
    } catch (err) {
      setError(`Simulation step failed: ${(err as Error).message}`);
      setIsRunning(false);
    }
  }, []);

  // Play simulation
  const play = useCallback(() => {
    if (!stateRef.current || animationRef.current) return;
    setIsRunning(true);

    animationRef.current = setInterval(async () => {
      if (!stateRef.current) return;
      try {
        const orchestrator = getOrchestrator();
        const start = performance.now();
        const newState = await orchestrator.stepSimulation(
          stateRef.current,
          DEFAULT_DT * speedRef.current
        );
        if (!mountedRef.current) return;
        setState(newState);
        const elapsed = performance.now() - start;
        setAvgStepMs(prev => (prev === 0 ? elapsed : prev * 0.8 + elapsed * 0.2));
      } catch (err) {
        setError(`Simulation failed: ${(err as Error).message}`);
        if (animationRef.current) {
          clearInterval(animationRef.current);
          animationRef.current = null;
        }
        setIsRunning(false);
      }
    }, FRAME_INTERVAL);
  }, [speed]);

  // Pause simulation
  const pause = useCallback(() => {
    if (animationRef.current) {
      clearInterval(animationRef.current);
      animationRef.current = null;
    }
    setIsRunning(false);
  }, []);

  // Toggle play/pause
  const toggle = useCallback(() => {
    if (isRunning) {
      pause();
    } else {
      play();
    }
  }, [isRunning, play, pause]);

  // Speed control
  const speedUp = useCallback(() => {
    setSpeed(prev => {
      const idx = SPEEDS.findIndex(s => s >= prev);
      if (idx === -1 || idx === SPEEDS.length - 1) return SPEEDS[SPEEDS.length - 1];
      return SPEEDS[idx + 1];
    });
  }, []);

  const speedDown = useCallback(() => {
    setSpeed(prev => {
      const idx = SPEEDS.findIndex(s => s >= prev);
      if (idx <= 0) return SPEEDS[0];
      return SPEEDS[idx - 1];
    });
  }, []);

  // Set parameter
  const setParam = useCallback((id: string, value: number | boolean | string) => {
    paramsRef.current = { ...paramsRef.current, [id]: value };
    // If simulation is already initialized, reinitialize with new params
    if (stateRef.current) {
      setState(prev => prev ? { ...prev, params: { ...prev.params, [id]: value } } : null);
    }
  }, []);

  const reset = useCallback(async () => {
    await init();
  }, [init]);

  const controls: SimulationControls = {
    init,
    play,
    pause,
    toggle,
    step,
    reset,
    speedUp,
    speedDown,
    setSpeed,
    setParam,
  };

  return {
    state,
    isRunning,
    speed,
    avgStepMs,
    parameters,
    metadata,
    controls,
    isLoading,
    error,
  };
}
