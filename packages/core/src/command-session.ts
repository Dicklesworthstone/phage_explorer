/** Declarative command recording and replay. Hosts supply adapters for their existing action IDs. */
export type CommandValue = null | boolean | number | string | CommandValue[] | { [key: string]: CommandValue };
export interface RecordedCommand {
  actionId: string;
  parameters: CommandValue;
  /** The independently recomputed output must match before the host applies a replayed command. */
  expected: CommandValue;
}
export interface CommandTape {
  format: 'phage-explorer-commands';
  version: 1;
  name: string;
  context: CommandValue;
  commands: RecordedCommand[];
}
export const COMMAND_LIMITS = { bytes: 10 * 1024 * 1024, commands: 128, repetitions: 10, executions: 256, depth: 48 } as const;

/** Canonical snapshots reject executable/nonfinite values, including inside arrays. */
function snapshot(value: unknown, depth = 0): CommandValue {
  if (depth > COMMAND_LIMITS.depth) throw new Error('Command data exceeds the nesting limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, item => snapshot(item, depth + 1));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, snapshot(Reflect.get(value, key), depth + 1)]));
  }
  throw new Error('Commands require finite numbers and plain JSON values.');
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join('|') !== expected.sort().join('|')) throw new Error('Unsupported command fields.');
}
function bounded(value: unknown): CommandValue {
  const copy = snapshot(value);
  if (new TextEncoder().encode(JSON.stringify(copy)).length > COMMAND_LIMITS.bytes) throw new Error('Command session exceeds the 10 MiB limit.');
  return copy;
}
export function parseCommandTape(content: string): CommandTape {
  if (new TextEncoder().encode(content).length > COMMAND_LIMITS.bytes) throw new Error('Command session exceeds the 10 MiB limit.');
  return validateCommandTape(JSON.parse(content));
}
export function validateCommandTape(input: unknown): CommandTape {
  const value = bounded(input);
  if (!object(value)) throw new Error('Invalid command session.');
  keys(value, ['format', 'version', 'name', 'context', 'commands']);
  if (value.format !== 'phage-explorer-commands' || value.version !== 1) throw new Error('Unsupported command session format/version.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new Error('Session name must contain 1–120 printable characters.');
  if (!Array.isArray(value.commands) || value.commands.length > COMMAND_LIMITS.commands) throw new Error('Command session exceeds the 128-command limit.');
  for (const command of value.commands) {
    if (!object(command)) throw new Error('Invalid recorded command.');
    keys(command, ['actionId', 'parameters', 'expected']);
    if (typeof command.actionId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.]{0,99}$/.test(command.actionId)) throw new Error('Invalid command action ID.');
  }
  return value as unknown as CommandTape;
}
export function serializeCommandTape(tape: CommandTape): string {
  // Compact output has the same limit as the accepted input, including embedded source bundles.
  return JSON.stringify(validateCommandTape(tape));
}
export function commandValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(snapshot(a)) === JSON.stringify(snapshot(b));
}
export interface PreparedCommand {
  output: CommandValue;
  /** Apply only after output verification. Async apply must honor the supplied signal. */
  apply: (signal: AbortSignal) => void | Promise<void>;
}
export interface CommandAdapter {
  validate: (parameters: CommandValue) => void;
  prepare: (parameters: CommandValue, signal: AbortSignal) => Promise<PreparedCommand>;
}
export interface CommandSessionSnapshot {
  mode: 'idle' | 'recording' | 'executing' | 'replaying' | 'paused';
  tape: CommandTape;
  completed: number;
  total: number;
  error: string | null;
  notice: string | null;
}
function aborted(): Error { return new DOMException('Command session cancelled.', 'AbortError'); }
function check(signal: AbortSignal): void { if (signal.aborted) throw aborted(); }
/** Settle promptly even when a provider ignores abort; its late value can never be applied. */
function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
interface Operation { controller: AbortController; paused: boolean; wake: (() => void) | null }

/** Not a key registry: only an executor over the host's canonical, explicitly adapted actions. */
export class CommandSession {
  private operation: Operation | null = null;
  private recording = false;
  private listeners = new Set<() => void>();
  private state: CommandSessionSnapshot = {
    mode: 'idle', tape: { format: 'phage-explorer-commands', version: 1, name: 'Research workflow', context: null, commands: [] },
    completed: 0, total: 0, error: null, notice: null,
  };
  constructor(private readonly adapters: ReadonlyMap<string, CommandAdapter>,
    private readonly validateContext: (context: CommandValue, signal: AbortSignal) => Promise<void>) {}
  getSnapshot = (): CommandSessionSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<CommandSessionSnapshot>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private validate(tape: CommandTape): void {
    for (let i = 0; i < tape.commands.length; i++) {
      const command = tape.commands[i], adapter = this.adapters.get(command.actionId);
      if (!adapter) throw new Error(`Step ${i + 1}: unsupported action ${command.actionId}.`);
      try { adapter.validate(command.parameters); }
      catch (cause) { throw new Error(`Step ${i + 1} (${command.actionId}): ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
  }
  start = (name: string, context: CommandValue): void => {
    if (this.operation) throw new Error('Cancel the active command before starting a recording.');
    const tape = validateCommandTape({ format: 'phage-explorer-commands', version: 1, name, context, commands: [] });
    this.recording = true;
    this.publish({ mode: 'recording', tape, completed: 0, total: 0, error: null, notice: 'Recording supported workflow commands only.' });
  };
  stop = (): void => {
    if (this.operation) throw new Error('Wait for or cancel the active command before stopping the recording.');
    this.recording = false;
    this.publish({ mode: 'idle', notice: 'Recording stopped.' });
  };
  load = (content: string): void => {
    if (this.operation || this.recording) throw new Error('Stop recording or cancel replay before loading another session.');
    const tape = parseCommandTape(content);
    this.validate(tape);
    this.publish({ tape, completed: 0, total: tape.commands.length, error: null, notice: 'Session loaded; no commands have been executed.' });
  };
  export = (): string => {
    if (this.operation) throw new Error('Wait for or cancel the active command before exporting.');
    return serializeCommandTape(this.state.tape);
  };
  cancel = (): void => {
    const operation = this.operation;
    this.operation = null;
    operation?.controller.abort();
    operation?.wake?.();
    this.publish({ mode: this.recording ? 'recording' : 'idle', notice: 'Cancelled. Completed commands remain; no later command will run.' });
  };
  pause = (): void => {
    if (!this.operation || !['replaying', 'paused'].includes(this.state.mode)) return;
    this.operation.paused = true;
    this.publish({ mode: 'paused', notice: 'Pause requested; an active command may finish, but the next waits.' });
  };
  resume = (): void => {
    if (!this.operation || !this.operation.paused) return;
    this.operation.paused = false;
    this.operation.wake?.();
    this.operation.wake = null;
    this.publish({ mode: 'replaying', notice: null });
  };
  private async gate(operation: Operation): Promise<void> {
    check(operation.controller.signal);
    if (operation.paused) await cancellable(new Promise<void>(resolve => { operation.wake = resolve; }), operation.controller.signal);
    check(operation.controller.signal);
  }
  private async prepare(command: Pick<RecordedCommand, 'actionId' | 'parameters'>, operation: Operation): Promise<PreparedCommand> {
    check(operation.controller.signal);
    const adapter = this.adapters.get(command.actionId);
    if (!adapter) throw new Error(`Unsupported action ${command.actionId}.`);
    adapter.validate(command.parameters);
    const result = await cancellable(adapter.prepare(command.parameters, operation.controller.signal), operation.controller.signal);
    check(operation.controller.signal);
    return { output: bounded(result.output), apply: result.apply };
  }
  /** Explicit user commands supersede playback rather than queueing behind it. */
  dispatch = async (actionId: string, parameters: CommandValue): Promise<void> => {
    if (this.operation) {
      if (this.state.mode === 'executing') throw new Error('A command is already running. Cancel it before starting another.');
      this.cancel();
    }
    const command = { actionId, parameters: bounded(parameters) };
    if (this.recording && this.state.tape.commands.length >= COMMAND_LIMITS.commands) throw new Error('Recording has reached 128 commands.');
    const operation: Operation = { controller: new AbortController(), paused: false, wake: null };
    this.operation = operation;
    this.publish({ mode: 'executing', error: null, notice: null });
    try {
      const result = await this.prepare(command, operation);
      // Refuse an unexportable command before changing the host's visible state.
      const tape = this.recording ? validateCommandTape({ ...this.state.tape, commands: [...this.state.tape.commands, { ...command, expected: result.output }] }) : this.state.tape;
      check(operation.controller.signal);
      await cancellable(Promise.resolve(result.apply(operation.controller.signal)), operation.controller.signal);
      check(operation.controller.signal);
      if (this.recording) this.publish({ tape, total: tape.commands.length });
    } catch (cause) {
      if (this.operation === operation) this.publish({ error: `${actionId}: ${cause instanceof Error ? cause.message : String(cause)}` });
      throw cause;
    } finally {
      if (this.operation === operation) { this.operation = null; this.publish({ mode: this.recording ? 'recording' : 'idle' }); }
    }
  };
  replay = async (repetitions = 1): Promise<void> => {
    if (this.operation || this.recording) throw new Error('Stop recording or cancel the current operation before replaying.');
    const tape = validateCommandTape(this.state.tape);
    this.validate(tape); // Whole-tape validation precedes all side effects.
    if (!tape.commands.length) throw new Error('There are no recorded commands to replay.');
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > COMMAND_LIMITS.repetitions || tape.commands.length * repetitions > COMMAND_LIMITS.executions) throw new Error('Replay allows 1–10 repetitions and at most 256 executed commands.');
    const operation: Operation = { controller: new AbortController(), paused: false, wake: null };
    this.operation = operation;
    this.publish({ mode: 'replaying', completed: 0, total: tape.commands.length * repetitions, error: null, notice: null });
    let step = 0;
    try {
      check(operation.controller.signal);
      await cancellable(this.validateContext(tape.context, operation.controller.signal), operation.controller.signal);
      for (let iteration = 0; iteration < repetitions; iteration++) for (const command of tape.commands) {
        await this.gate(operation);
        const result = await this.prepare(command, operation);
        if (!commandValuesEqual(result.output, command.expected)) throw new Error('Recomputed output or input identity differs from the recording.');
        check(operation.controller.signal);
        await cancellable(Promise.resolve(result.apply(operation.controller.signal)), operation.controller.signal);
        check(operation.controller.signal);
        step++;
        this.publish({ completed: step });
      }
      check(operation.controller.signal);
      this.publish({ notice: `Verified ${step} commands against the recorded outputs.` });
    } catch (cause) {
      if (this.operation === operation) this.publish({ error: `Step ${step + 1} (${tape.commands[step % tape.commands.length].actionId}): ${cause instanceof Error ? cause.message : String(cause)}` });
      throw cause;
    } finally {
      if (this.operation === operation) { this.operation = null; this.publish({ mode: 'idle' }); }
    }
  };
}
