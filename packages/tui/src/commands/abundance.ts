/** Headless abundance workflows use the same data, method and replay contracts as the browser. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { open, lstat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import {
  parseAbundanceDataset, importAbundanceMetadata, analyzeAbundanceDataset,
  createAbundanceAnalysisRecord, replayAbundanceAnalysis, serializeAbundanceDataset,
  type AbundanceDataset, type AbundanceOptions,
} from '../../../core/src/analysis/abundance';
import { serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';

export const ABUNDANCE_COMMAND_HELP = `Abundance analysis (local files only; no catalog or network required)

  phage-explorer abundance inspect INPUT [--metadata FILE] [--output NEW_FILE]
  phage-explorer abundance analyze INPUT [--metadata FILE] [--params FILE] [--output NEW_FILE]
  phage-explorer abundance replay SAVED_ANALYSIS [--output NEW_FILE]

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
  operation: AbundanceOperation;
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
  if (!job || !['inspect', 'analyze', 'replay'].includes(job.operation) || !job.input || typeof job.input.name !== 'string') {
    throw new Error('Unsupported abundance job.');
  }
  requireText(job.input.text, job.operation === 'replay' ? RECORD_LIMIT : INPUT_LIMIT, 'Input');
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
