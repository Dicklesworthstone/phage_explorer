/** One selected simulation's lifecycle, independent of React render timing. */
import { serializeAnalysisRecord, type PhageFull } from '@phage-explorer/core';
import type { ComputeOrchestrator } from '../workers/ComputeOrchestrator';
import type { SimParameter, SimState, SimulationId } from '../workers/types';
import { getSimulationRandomState, createSimulationExperimentRecord, parseSimulationExperiment,
  simulationStateJson, MAX_SIMULATION_EXPERIMENT_STEPS } from '../workers/simulation-runtime';

type Parameters = Record<string, number | boolean | string>;
type Backend = Pick<ComputeOrchestrator, 'initSimulation' | 'stepSimulation' | 'getSimulationMetadata'>;
type Operation = { controller: AbortController; kind: 'init' | 'step' | 'replay' };

export interface SimulationSnapshot {
  state: SimState | null;
  isRunning: boolean;
  speed: number;
  avgStepMs: number;
  parameters: SimParameter[];
  parameterValues: Parameters;
  metadata: { name: string; description: string } | null;
  isLoading: boolean;
  isStepping: boolean;
  error: string | null;
  seed: number;
  completedSteps: number;
  replayProgress: { current: number; total: number } | null;
  replayMessage: string | null;
}

/** Parameter changes rebuild initial conditions, rather than relabel an old state. */
export function validateSimulationParameter(parameter: SimParameter | undefined, value: unknown): void {
  if (!parameter) throw new Error('Unknown simulation parameter.');
  if (parameter.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
      parameter.min !== undefined && value < parameter.min || parameter.max !== undefined && value > parameter.max) {
      throw new Error(`${parameter.label} must be a finite number within its supported range.`);
    }
  } else if (parameter.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${parameter.label} must be a boolean.`);
  } else if (!parameter.options?.some(option => option.value === value)) {
    throw new Error(`${parameter.label} must be one of the supported options.`);
  }
}

export class SimulationSession {
  private active = false;
  private operation: Operation | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly phage: PhageFull | null;
  private overrides: Parameters = {};
  private initialState: SimState | null = null;
  private initialParameters: Parameters = {};
  private acceptedDeltas: number[] = [];
  private snapshot: SimulationSnapshot;

  constructor(
    readonly simId: SimulationId,
    phage: PhageFull | null,
    private readonly backend: () => Backend,
    private readonly derivedDefaults: Parameters = {},
    seed = Date.now() >>> 0,
  ) {
    this.phage = structuredClone(phage);
    this.snapshot = {
      state: null, isRunning: false, speed: 1, avgStepMs: 0, parameters: [], parameterValues: {},
      metadata: null, isLoading: false, isStepping: false, error: null, seed, completedSteps: 0,
      replayProgress: null, replayMessage: null,
    };
  }

  getSnapshot = (): SimulationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(update: Partial<SimulationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  private invalidate(): void {
    const previous = this.operation;
    this.operation = null;
    previous?.controller.abort();
  }
  private current(operation: Operation): boolean {
    return this.active && this.operation === operation && !operation.controller.signal.aborted;
  }

  /** Re-activatable for React StrictMode's setup/cleanup/setup cycle. */
  activate = async (): Promise<void> => {
    if (this.active) return;
    this.active = true;
    if (!this.snapshot.state) await this.init();
  };
  deactivate = (): void => {
    this.active = false;
    this.cancel();
  };
  cancel = (): void => {
    const replaying = this.operation?.kind === 'replay';
    this.stopTimer();
    this.invalidate();
    this.publish({ isRunning: false, isLoading: false, isStepping: false, replayProgress: null,
      ...(replaying ? { replayMessage: 'Replay cancelled; the last accepted run was preserved.' } : {}) });
  };

  init = async (params: Parameters = {}): Promise<void> => {
    if (!this.active) return;
    this.stopTimer();
    this.invalidate();
    const operation: Operation = { controller: new AbortController(), kind: 'init' };
    this.operation = operation;
    const submitted = structuredClone(params);
    const seed = this.snapshot.seed;
    this.initialState = null;
    this.initialParameters = {};
    this.acceptedDeltas = [];
    this.publish({ state: null, isRunning: false, isLoading: true, isStepping: false, error: null, avgStepMs: 0, completedSteps: 0,
      replayProgress: null, replayMessage: null });
    try {
      if (!this.current(operation)) return;
      const backend = this.backend();
      if (!this.snapshot.metadata) {
        const metadata = await backend.getSimulationMetadata(this.simId, operation.controller.signal);
        if (!this.current(operation)) return;
        this.publish({ metadata: { name: metadata.name, description: metadata.description }, parameters: metadata.parameters });
      }
      if (!this.current(operation)) return;
      for (const [id, value] of Object.entries(submitted)) {
        validateSimulationParameter(this.snapshot.parameters.find(parameter => parameter.id === id), value);
      }
      this.overrides = { ...this.overrides, ...submitted };
      const defaults = Object.fromEntries(this.snapshot.parameters.map(parameter => [parameter.id, parameter.defaultValue]));
      const values = { ...defaults, ...this.derivedDefaults, ...this.overrides };
      this.publish({ parameterValues: values });
      if (!this.current(operation)) return;
      const next = await backend.initSimulation({ simId: this.simId, params: values, seed, phage: this.phage }, operation.controller.signal);
      if (!this.current(operation)) return;
      if (next.type !== this.simId) throw new Error('Simulation returned a different state type.');
      const random = getSimulationRandomState(next);
      this.initialParameters = structuredClone(values);
      this.initialState = structuredClone(next);
      this.publish({ state: next, parameterValues: { ...next.params }, seed: random.seed });
    } catch (cause) {
      if (this.current(operation)) this.publish({ error: `Failed to initialize simulation: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      if (this.current(operation)) {
        this.operation = null;
        this.publish({ isLoading: false });
      }
    }
  };

  step = async (): Promise<void> => {
    if (!this.active || !this.snapshot.state || this.operation) return;
    if (this.acceptedDeltas.length >= MAX_SIMULATION_EXPERIMENT_STEPS) {
      this.pause();
      this.publish({ error: `Run reached ${MAX_SIMULATION_EXPERIMENT_STEPS} recorded steps. Export it, then reset to start another run.` });
      return;
    }
    const operation: Operation = { controller: new AbortController(), kind: 'step' };
    this.operation = operation;
    const state = this.snapshot.state;
    const dt = this.snapshot.speed;
    const start = performance.now();
    this.publish({ isStepping: true });
    try {
      if (!this.current(operation)) return;
      const next = await this.backend().stepSimulation(state, dt, operation.controller.signal);
      if (!this.current(operation)) return;
      if (next.type !== this.simId) throw new Error('Simulation returned a different state type.');
      getSimulationRandomState(next);
      const elapsed = performance.now() - start;
      this.acceptedDeltas.push(dt);
      this.publish({ state: next, error: null, replayMessage: null, completedSteps: this.acceptedDeltas.length,
        avgStepMs: this.snapshot.avgStepMs === 0 ? elapsed : this.snapshot.avgStepMs * 0.8 + elapsed * 0.2 });
    } catch (cause) {
      if (this.current(operation)) {
        this.stopTimer();
        this.publish({ isRunning: false, error: `Simulation step failed: ${cause instanceof Error ? cause.message : String(cause)}` });
      }
    } finally {
      // An obsolete promise must never unlock a newer request.
      if (this.current(operation)) {
        this.operation = null;
        this.publish({ isStepping: false });
      }
    }
  };
  play = (): void => {
    if (!this.active || !this.snapshot.state || this.snapshot.isLoading || this.timer !== null) return;
    this.publish({ isRunning: true, error: null });
    this.timer = setInterval(() => { void this.step(); }, 50);
  };
  pause = (): void => {
    this.stopTimer();
    if (this.operation?.kind === 'step') this.invalidate();
    this.publish({ isRunning: false, isStepping: false });
  };
  toggle = (): void => { if (this.snapshot.isRunning) this.pause(); else this.play(); };
  reset = async (): Promise<void> => { await this.init(); };
  setSpeed = (speed: number): void => {
    if (!this.active) return;
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 8) {
      this.publish({ error: 'Simulation speed must be between 0.25 and 8.' });
      return;
    }
    this.publish({ speed });
  };
  setSeed = async (seed: number): Promise<void> => {
    if (!this.active) return;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      this.publish({ error: 'Simulation seed must be an integer from 0 to 4294967295.' });
      return;
    }
    this.publish({ seed });
    await this.init();
  };
  setParam = async (id: string, value: number | boolean | string): Promise<void> => {
    if (!this.active) return;
    try {
      validateSimulationParameter(this.snapshot.parameters.find(parameter => parameter.id === id), value);
      await this.init({ [id]: value });
    } catch (cause) {
      this.publish({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  /** Capture the accepted run before hashing. No in-flight step can enter this export. */
  exportExperiment = async (): Promise<string> => {
    if (!this.active || !this.snapshot.state || !this.initialState || this.operation || this.snapshot.isRunning) {
      throw new Error('Pause an initialized simulation before exporting its experiment.');
    }
    const record = await createSimulationExperimentRecord({ simId: this.simId, phage: this.phage,
      seed: this.snapshot.seed, parameters: this.initialParameters, stepDeltas: this.acceptedDeltas,
      initialState: this.initialState, finalState: this.snapshot.state });
    return serializeAnalysisRecord(record);
  };

  /** Replay in scratch state and commit only a fully verified result. Failure/cancel preserves the current run. */
  replayExperiment = async (content: string | Promise<string>): Promise<void> => {
    if (!this.active) return;
    this.cancel();
    const operation: Operation = { controller: new AbortController(), kind: 'replay' };
    this.operation = operation;
    this.publish({ isLoading: true, error: null, replayMessage: null, replayProgress: { current: 0, total: 0 } });
    let phase = 'read saved experiment';
    try {
      const text = await content;
      if (!this.current(operation)) return;
      phase = 'validate saved experiment';
      const saved = await parseSimulationExperiment(text, this.simId, this.phage);
      if (!this.current(operation)) return;
      const backend = this.backend();
      const metadata = await backend.getSimulationMetadata(this.simId, operation.controller.signal);
      if (!this.current(operation)) return;
      // Recorded initialization parameters are complete. Only a value derived
      // from this exact phage may fall outside an interactive control's range.
      for (const parameter of metadata.parameters) {
        if (!Object.hasOwn(saved.parameters, parameter.id)) throw new Error(`Missing simulation parameter: ${parameter.id}`);
      }
      for (const [id, value] of Object.entries(saved.parameters)) {
        if (Object.hasOwn(this.derivedDefaults, id) && this.derivedDefaults[id] === value) continue;
        validateSimulationParameter(metadata.parameters.find(parameter => parameter.id === id), value);
      }
      if (!this.current(operation)) return;
      phase = 'initialize replay';
      const initial = await backend.initSimulation({ simId: this.simId, params: saved.parameters,
        seed: saved.seed, phage: this.phage }, operation.controller.signal);
      if (!this.current(operation)) return;
      if (JSON.stringify(simulationStateJson(initial)) !== JSON.stringify(simulationStateJson(saved.record.fields.initialState.value))) {
        throw new Error('Fresh initial simulation state differs from the saved experiment.');
      }
      let state = initial;
      this.publish({ replayProgress: { current: 0, total: saved.stepDeltas.length } });
      for (let i = 0; i < saved.stepDeltas.length; i++) {
        if (!this.current(operation)) return;
        phase = `replay step ${i + 1}`;
        state = await backend.stepSimulation(state, saved.stepDeltas[i], operation.controller.signal);
        if (!this.current(operation)) return;
        if (state.type !== this.simId || getSimulationRandomState(state).seed !== saved.seed) {
          throw new Error('Replayed state has a different model or seed.');
        }
        this.publish({ replayProgress: { current: i + 1, total: saved.stepDeltas.length } });
      }
      phase = 'verify replayed result';
      const fresh = await createSimulationExperimentRecord({ simId: this.simId, phage: this.phage, seed: saved.seed,
        parameters: saved.parameters, stepDeltas: saved.stepDeltas, initialState: initial, finalState: state });
      if (!this.current(operation)) return;
      if (fresh.resultId !== saved.record.resultId) throw new Error('Fresh simulation result or evidence differs from the saved experiment.');
      this.initialState = structuredClone(initial);
      this.initialParameters = structuredClone(saved.parameters);
      this.overrides = { ...saved.parameters };
      this.acceptedDeltas = [...saved.stepDeltas];
      this.publish({ state, seed: saved.seed, parameterValues: { ...state.params }, parameters: metadata.parameters,
        metadata: { name: metadata.name, description: metadata.description }, avgStepMs: 0,
        completedSteps: saved.stepDeltas.length,
        replayMessage: `Verified replay of ${saved.stepDeltas.length} accepted steps: initial state, final state and complete record identity match. This is reproducibility, not biological validation.` });
    } catch (cause) {
      if (this.current(operation)) this.publish({ error: `Could not ${phase}: ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      if (this.current(operation)) {
        this.operation = null;
        this.publish({ isLoading: false, replayProgress: null });
      }
    }
  };
}
