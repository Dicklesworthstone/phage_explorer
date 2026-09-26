/** Headless abundance workflows use the same data, method and replay contracts as the browser. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { open, lstat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import {
  parseAbundanceDataset, importAbundanceMetadata, analyzeAbundanceDataset,
  createAbundanceAnalysisRecord, replayAbundanceAnalysis, serializeAbundanceDataset,
  resolveAbundanceOptions, validateAbundanceDataset, type AbundanceDataset, type AbundanceOptions,
} from '../../../core/src/analysis/abundance';
import { serializeAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';

export const ABUNDANCE_COMMAND_HELP = `Abundance analysis (local files only; no catalog or network required)

  phage-explorer abundance view [INPUT]
  phage-explorer abundance inspect INPUT [--metadata FILE] [--output NEW_FILE]
  phage-explorer abundance analyze INPUT [--metadata FILE] [--params FILE] [--output NEW_FILE]
  phage-explorer abundance replay SAVED_ANALYSIS [--output NEW_FILE]

view opens an interactive terminal workspace (requires a TTY).
INPUT is a taxa-by-sample CSV/TSV or a version-1 abundance dataset JSON.
--metadata joins sampleId-keyed CSV/TSV/JSON to the dataset, not by row order.
--params is a JSON object of the browser's analysis parameters (including seed).
inspect emits a validated dataset; analyze emits a portable analysis record.
replay recomputes a saved browser/terminal result and rejects differing evidence.
JSON goes to stdout unless --output names a NEW file. Existing files are never
replaced. Use '-' for one input stream (INPUT, --metadata or --params).
Progress/errors go to stderr. Ctrl-C cancels computation before output publication.
CLR associations and NMF factors are exploratory, not ecological interactions.
`;

export type AbundanceOperation = 'inspect' | 'analyze' | 'replay';
export interface AbundanceCommand {
  operation: AbundanceOperation;
  input: string;
  metadata?: string;
  parameters?: string;
  output?: string;
}
export interface AbundanceJob {
  operation: AbundanceOperation | 'open';
  input: { name: string; text: string };
  metadata?: string;
  parameters?: string;
}
export interface AbundanceJobResult {
  content: string;
  identity: string | null;
  verified: boolean;
}
export type AbundanceProgress = 'reading-inputs' | 'validating-inputs' | 'computing' | 'binding-result' | 'verifying-replay' | 'publishing';
export type AbundanceJobMessage =
  | { kind: 'progress'; phase: AbundanceProgress }
  | { kind: 'result'; result: AbundanceJobResult }
  | { kind: 'error'; message: string };
const INPUT_LIMIT = 4 * 1024 * 1024;
const RECORD_LIMIT = 10 * 1024 * 1024;
const PARAMETER_LIMIT = 64 * 1024;

export function parseAbundanceCommand(args: string[]): AbundanceCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    metadata: { type: 'string' }, params: { type: 'string' }, output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['inspect', 'analyze', 'replay'].includes(operation)) {
    throw new Error('Expected abundance inspect|analyze|replay INPUT. See abundance --help.');
  }
  if (!input.trim() || [values.metadata, values.params, values.output].some(value => value !== undefined && !value.trim())) {
    throw new Error('File paths must not be empty.');
  }
  if (operation === 'replay' && (values.metadata !== undefined || values.params !== undefined)) {
    throw new Error('Replay cannot override saved metadata or parameters. Analyze a dataset to start a changed experiment.');
  }
  if (operation === 'inspect' && values.params !== undefined) throw new Error('inspect does not run an analysis; --params requires analyze.');
  if ([input, values.metadata, values.params].filter(value => value === '-').length > 1) {
    throw new Error('Only one input may read from stdin (-).');
  }
  return { operation: operation as AbundanceOperation, input, metadata: values.metadata,
    parameters: values.params, output: values.output === '-' ? undefined : values.output };
}

function abortError(): Error { return new DOMException('Abundance operation cancelled.', 'AbortError'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function requireText(value: unknown, limit: number, context: string): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) throw new Error(`${context} exceeds its supported byte limit.`);
}

/** Worker boundary. Deliberate replay never accepts a stored output without recomputation. */
export async function executeAbundanceJob(job: AbundanceJob, progress: (phase: AbundanceProgress) => void = () => {}): Promise<AbundanceJobResult> {
  if (!job || !['inspect', 'analyze', 'replay', 'open'].includes(job.operation) || !job.input || typeof job.input.name !== 'string') {
    throw new Error('Unsupported abundance job.');
  }
  requireText(job.input.text, job.operation === 'replay' || job.operation === 'open' ? RECORD_LIMIT : INPUT_LIMIT, 'Input');
  if (job.operation === 'open') {
    if (job.metadata !== undefined || job.parameters !== undefined) throw new Error('Opening a file does not accept overrides.');
    const text = job.input.text.replace(/^\uFEFF/, '');
    const isRecord = text.trimStart().startsWith('{') && JSON.parse(text).format === 'phage-explorer-analysis';
    return executeAbundanceJob({ ...job, operation: isRecord ? 'replay' : 'inspect' }, progress);
  }
  if (job.operation === 'replay') {
    if (job.metadata !== undefined || job.parameters !== undefined) throw new Error('Replay does not accept input overrides.');
    progress('verifying-replay');
    const replay = await replayAbundanceAnalysis(job.input.text.replace(/^\uFEFF/, ''));
    return { content: serializeAnalysisRecord(replay.record), identity: replay.record.resultId, verified: true };
  }
  progress('validating-inputs');
  let dataset: AbundanceDataset = parseAbundanceDataset(job.input.text, job.input.name);
  if (job.metadata !== undefined) {
    requireText(job.metadata, INPUT_LIMIT, 'Metadata');
    dataset = importAbundanceMetadata(job.metadata, dataset);
  }
  if (job.operation === 'inspect') {
    if (job.parameters !== undefined) throw new Error('Inspection does not accept analysis parameters.');
    return { content: serializeAbundanceDataset(dataset), identity: null, verified: false };
  }
  let parameters: Partial<AbundanceOptions> = {};
  if (job.parameters !== undefined) {
    requireText(job.parameters, PARAMETER_LIMIT, 'Parameters');
    const parsed: unknown = JSON.parse(job.parameters.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Analysis parameters must be a JSON object.');
    parameters = parsed as Partial<AbundanceOptions>;
  }
  progress('computing');
  const analysis = analyzeAbundanceDataset(dataset, parameters);
  progress('binding-result');
  const record: AnalysisRecord = await createAbundanceAnalysisRecord(dataset, analysis);
  return { content: serializeAnalysisRecord(record), identity: record.resultId, verified: false };
}

/** Read a regular file without unbounded allocation, including a file growing during the read. */
export async function readAbundanceFile(filename: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const initial = await lstat(filename);
  // Do not block forever opening a FIFO or follow a link into an unexpected input.
  if (!initial.isFile()) throw new Error('Abundance inputs must be regular files (not directories, links or pipes); use - for stdin.');
  if (initial.size > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte limit.`);
  checkAbort(signal);
  const file = await open(filename, 'r');
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > maxBytes) throw new Error(`Input is not a regular file within the ${maxBytes}-byte limit.`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      checkAbort(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      checkAbort(signal);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte limit.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally { await file.close(); }
}

export function readAbundanceStdin(stream: Readable, maxBytes: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveText, reject) => {
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      stream.off('data', data); stream.off('end', end); stream.off('error', fail); stream.off('close', closed);
      signal?.removeEventListener('abort', abort);
      if (error) { reject(error); return; }
      try { resolveText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch (cause) { reject(cause); }
    };
    const data = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) { finish(new Error(`stdin exceeds the ${maxBytes}-byte limit.`)); return; }
      chunks.push(buffer);
    };
    const end = () => finish();
    const fail = (error: Error) => finish(error);
    const closed = () => finish(new Error('stdin closed before the complete input was read.'));
    const abort = () => finish(abortError());
    if (signal?.aborted) { abort(); return; }
    if (stream.readableEnded || stream.destroyed) { finish(new Error('stdin is no longer readable.')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    stream.on('data', data); stream.once('end', end); stream.once('error', fail); stream.once('close', closed);
  });
}

// The two-stage binary build substitutes a sibling JS bundle; source runs use TS.
declare const PHAGE_ABUNDANCE_WORKER: string | undefined;
export function runAbundanceJob(job: AbundanceJob, signal?: AbortSignal,
  progress: (phase: AbundanceProgress) => void = () => {}): Promise<AbundanceJobResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const url = typeof PHAGE_ABUNDANCE_WORKER === 'string'
      ? new URL(PHAGE_ABUNDANCE_WORKER, import.meta.url)
      : new URL('../workers/abundance-worker.ts', import.meta.url);
    const worker = new Worker(url);
    const finish = (error: Error | null, result?: AbundanceJobResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      // Keep the error listener until termination: an aborted worker can still
      // emit an error. No stale event may settle the job a second time.
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolveResult(result!);
    };
    const abort = () => finish(abortError());
    worker.on('message', (message: AbundanceJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message.kind === 'progress') {
        try { progress(message.phase); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
      } else if (message.kind === 'result') finish(null, message.result);
      else finish(new Error(message.kind === 'error' ? message.message : 'Invalid abundance worker response.'));
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => finish(new Error(`Abundance worker exited before returning a result (code ${code}).`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

async function assertNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error('Output already exists; choose a new file. Existing inputs and results are never overwritten.');
}
function writeStream(stream: Writable, content: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const error = (cause: Error) => { stream.off('error', error); reject(cause); };
    stream.once('error', error);
    stream.write(content, cause => {
      // Writable emits error after a failed write callback. Keep the once
      // listener until that event so a broken pipe cannot become unhandled.
      if (cause) { reject(cause); return; }
      stream.off('error', error);
      resolveWrite();
    });
  });
}
export interface AbundanceCommandIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
  /** Dependency injection also lets an interactive terminal use the same worker. */
  execute?: typeof runAbundanceJob;
}

/** No process.exit, terminal rendering or catalog opening: safe to call from a pipeline or a TUI. */
export async function runAbundanceCommand(args: string[], io: AbundanceCommandIO): Promise<number> {
  let command: AbundanceCommand | null;
  const reportError = async (cause: unknown) => {
    const message = stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    await writeStream(io.stderr, `Abundance: ${message}\n`);
  };
  try { command = parseAbundanceCommand(args); }
  catch (cause) { await reportError(cause); return 2; }
  if (!command) { await writeStream(io.stdout, ABUNDANCE_COMMAND_HELP); return 0; }
  try {
    checkAbort(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    const writes: Promise<void>[] = [];
    const progress = (phase: AbundanceProgress) => {
      // Structured phases contain no input contents or taxon/sample identifiers.
      const writing = writeStream(io.stderr, `${JSON.stringify({ operation: command.operation, phase })}\n`);
      void writing.catch(() => {}); // observed again before publication
      writes.push(writing);
    };
    progress('reading-inputs');
    const read = (filename: string, limit: number) => filename === '-'
      ? readAbundanceStdin(io.stdin, limit, io.signal) : readAbundanceFile(filename, limit, io.signal);
    const input = await read(command.input, command.operation === 'replay' ? RECORD_LIMIT : INPUT_LIMIT);
    const metadata = command.metadata === undefined ? undefined : await read(command.metadata, INPUT_LIMIT);
    const parameters = command.parameters === undefined ? undefined : await read(command.parameters, PARAMETER_LIMIT);
    checkAbort(io.signal);
    const result = await (io.execute ?? runAbundanceJob)({ operation: command.operation,
      input: { name: command.input === '-' ? 'stdin abundance data' : basename(command.input), text: input }, metadata, parameters }, io.signal, progress);
    checkAbort(io.signal);
    // Publication is the commit point. An interrupt before it writes no result;
    // once writing starts, finish the validated output rather than cancel midway.
    progress('publishing');
    await Promise.all(writes);
    checkAbort(io.signal);
    if (destination) await writeFile(destination, result.content + '\n', { encoding: 'utf8', flag: 'wx' });
    else await writeStream(io.stdout, result.content + '\n');
    return 0;
  } catch (cause) {
    await reportError(cause);
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

/** CLI lifecycle: signals cancel input/worker work without abruptly truncating a published record. */
export async function runAbundanceProcess(args: string[]): Promise<void> {
  const controller = new AbortController();
  let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runAbundanceCommand(args, { stdin: process.stdin, stdout: process.stdout,
      stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    process.stdin.pause();
  }
}

export interface AbundanceWorkspaceSnapshot {
  accepted: { dataset: AbundanceDataset; record: AnalysisRecord | null } | null;
  options: AbundanceOptions | null;
  busy: boolean;
  publishing: boolean;
  phase: string;
  error: string | null;
  notice: string | null;
}

/** File-aware interactive state. Replacements are transactional; stale replies never replace accepted data. */
export class AbundanceWorkspace {
  private active = true;
  private operation: { controller: AbortController; committed: boolean } | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: AbundanceWorkspaceSnapshot = { accepted: null, options: null,
    busy: false, publishing: false, phase: 'Ready', error: null, notice: null };
  constructor(private readonly execute: typeof runAbundanceJob = runAbundanceJob,
    private readonly read: typeof readAbundanceFile = readAbundanceFile) {}
  getSnapshot = (): AbundanceWorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<AbundanceWorkspaceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    if (this.operation?.committed) return; // Finish the already-authorized exclusive write.
    const previous = this.operation;
    this.operation = null;
    previous?.controller.abort();
    this.publish({ busy: false, publishing: false, phase: 'Ready',
      ...(previous ? { notice: 'Cancelled; the last accepted dataset and result were preserved.' } : {}) });
  };
  private async task(work: (signal: AbortSignal, report: (phase: AbundanceProgress) => void,
    commit: () => void) => Promise<Partial<AbundanceWorkspaceSnapshot>>): Promise<void> {
    if (!this.active || this.operation?.committed) return;
    this.cancel();
    const operation = { controller: new AbortController(), committed: false };
    this.operation = operation;
    const current = () => this.active && this.operation === operation && !operation.controller.signal.aborted;
    this.publish({ busy: true, publishing: false, phase: 'reading-inputs', error: null, notice: null });
    try {
      const update = await work(operation.controller.signal, phase => {
        if (current()) this.publish({ phase });
      }, () => {
        checkAbort(operation.controller.signal);
        operation.committed = true;
        if (current()) this.publish({ publishing: true, phase: 'publishing' });
      });
      if (current()) this.publish(update);
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (this.operation === operation) {
        this.operation = null;
        this.publish({ busy: false, publishing: false, phase: 'Ready' });
      }
    }
  }
  private async accepted(result: AbundanceJobResult): Promise<Partial<AbundanceWorkspaceSnapshot>> {
    if (result.identity === null) {
      const dataset = parseAbundanceDataset(result.content);
      return { accepted: { dataset, record: null }, options: resolveAbundanceOptions(dataset), notice: 'Dataset loaded. Press Enter to analyze.' };
    }
    const record = await parseAnalysisRecord(result.content, { methodId: 'abundance-clr-nmf', methodVersion: '1' });
    if (record.resultId !== result.identity) throw new Error('Worker result identity differs from its record.');
    const dataset = validateAbundanceDataset(record.inputs[0].data);
    return { accepted: { dataset, record }, options: resolveAbundanceOptions(dataset, record.parameters as Partial<AbundanceOptions>),
      notice: result.verified ? 'Verified replay: freshly recomputed result and evidence match.' : 'Analysis complete. Exports use these submitted parameters.' };
  }
  load = (filename: string): Promise<void> => this.task(async (signal, report) => {
    const text = await this.read(filename, RECORD_LIMIT, signal);
    checkAbort(signal);
    const result = await this.execute({ operation: 'open', input: { name: basename(filename), text } }, signal, report);
    checkAbort(signal);
    return this.accepted(result);
  });
  attachMetadata = (filename: string): Promise<void> => {
    const prior = this.snapshot.accepted;
    if (!prior) { this.publish({ error: 'Load a dataset before attaching metadata.' }); return Promise.resolve(); }
    const text = serializeAbundanceDataset(prior.dataset);
    return this.task(async (signal, report) => {
      const metadata = await this.read(filename, INPUT_LIMIT, signal);
      checkAbort(signal);
      const result = await this.execute({ operation: 'inspect', input: { name: prior.dataset.name, text }, metadata }, signal, report);
      checkAbort(signal);
      const update = await this.accepted(result);
      // Keep explicit parameter choices, but discard the old result whose metadata changed.
      return { ...update, options: this.snapshot.options, notice: 'Metadata attached by sample ID. Run again to update the analysis.' };
    });
  };
  setParameters = (text: string): void => {
    if (!this.active || this.operation?.committed) return;
    try {
      if (!this.snapshot.accepted) throw new Error('Load a dataset before editing parameters.');
      requireText(text, PARAMETER_LIMIT, 'Parameters');
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Parameters must be a JSON object.');
      const options = resolveAbundanceOptions(this.snapshot.accepted.dataset, { ...this.snapshot.options, ...value });
      this.cancel();
      this.publish({ options, error: null, notice: 'Parameters edited. Press Enter to apply; existing exports still describe the accepted result.' });
    } catch (cause) { this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); }
  };
  analyze = (): Promise<void> => {
    const prior = this.snapshot.accepted, options = this.snapshot.options;
    if (!prior || !options) { this.publish({ error: 'Load a dataset before running an analysis.' }); return Promise.resolve(); }
    const job: AbundanceJob = { operation: 'analyze', input: { name: prior.dataset.name, text: serializeAbundanceDataset(prior.dataset) },
      parameters: JSON.stringify(options) };
    return this.task(async (signal, report) => {
      const result = await this.execute(job, signal, report);
      checkAbort(signal);
      return this.accepted(result);
    });
  };
  save = (filename: string, kind: 'dataset' | 'analysis'): Promise<void> => {
    if (this.snapshot.busy) return Promise.resolve();
    const prior = this.snapshot.accepted;
    if (!prior || kind === 'analysis' && !prior.record) {
      this.publish({ error: kind === 'analysis' ? 'Run an analysis before exporting its record.' : 'Load a dataset before exporting.' });
      return Promise.resolve();
    }
    const content = kind === 'analysis' ? serializeAnalysisRecord(prior.record!) : serializeAbundanceDataset(prior.dataset);
    return this.task(async (signal, _report, commit) => {
      if (!filename.trim() || filename === '-') throw new Error('Choose a new file path for an interactive export.');
      const destination = resolve(filename);
      await assertNewOutput(destination);
      checkAbort(signal);
      commit();
      await writeFile(destination, content + '\n', { encoding: 'utf8', flag: 'wx' });
      return { notice: `Saved ${kind} to ${destination}` };
    });
  };
}

/** Sanitize display only. The exact original labels remain in checksummed exports. */
export function abundanceTerminalLabel(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
}
