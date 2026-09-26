/** One selected simulation's lifecycle, independent of React render timing. */
import type { PhageFull } from '@phage-explorer/core';
import type { ComputeOrchestrator } from '../workers/ComputeOrchestrator';
import type { SimParameter, SimState, SimulationId } from '../workers/types';
import { getSimulationRandomState } from '../workers/simulation-runtime';

type Parameters = Record<string, number | boolean | string>;
type Backend = Pick<ComputeOrchestrator, 'initSimulation' | 'stepSimulation' | 'getSimulationMetadata'>;
type Operation = { controller: AbortController; kind: 'init' | 'step' };

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
    this.stopTimer();
    this.invalidate();
    this.publish({ isRunning: false, isLoading: false, isStepping: false });
  };

  init = async (params: Parameters = {}): Promise<void> => {
    if (!this.active) return;
    this.stopTimer();
    this.invalidate();
    const operation: Operation = { controller: new AbortController(), kind: 'init' };
    this.operation = operation;
    const submitted = structuredClone(params);
    const seed = this.snapshot.seed;
    this.publish({ state: null, isRunning: false, isLoading: true, isStepping: false, error: null, avgStepMs: 0, completedSteps: 0 });
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
      this.publish({ state: next, error: null, completedSteps: this.snapshot.completedSteps + 1,
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
}
