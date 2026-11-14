/** Native local assays use the same owned worker/session and evidence contract as the browser. */
import { Worker } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import {
  EpistasisEvidenceSession, EPISTASIS_FILE_LIMIT,
  type EpistasisEvidenceWorker, type EpistasisEvidenceMessage, type EpistasisEvidenceRequest, type EpistasisEvidenceResult,
} from '../../../web/src/workers/EpistasisEvidenceSession';
import {
  EPISTASIS_ASSAY_LIMITS, parseEpistasisAssayDataset, parseEpistasisAssayCsv, resolveEpistasisAssayOptions, exportEpistasisAssayTsv,
  type EpistasisAssayDataset, type EpistasisAssayOptions,
} from '../../../core/src/analysis/epistasis-evidence';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';

declare const PHAGE_EPISTASIS_WORKER: string | undefined;

export const EPISTASIS_COMMAND_HELP = `Measured epistasis assays (local input; no catalog or network required)

  phage-explorer epistasis inspect INPUT [--metadata METADATA_JSON] [--output NEW_FILE]
  phage-explorer epistasis analyze INPUT [--metadata METADATA_JSON]
    [--bootstrap-samples 0|200..2000] [--seed UINT32]
    [--format json|tsv] [--section pairs|observations] [--output NEW_FILE]
  phage-explorer epistasis replay SAVED_ANALYSIS
    [--format json|tsv] [--section pairs|observations] [--output NEW_FILE]

INPUT is a version-1 phage-explorer-epistasis-assay JSON dataset. With --metadata,
INPUT is a CSV/TSV table headed variant,replicate_id,value, and METADATA_JSON
contains all dataset fields except observations. Protein, source, assay units,
conditions, identity/natural-log scale and independent/paired design are explicit.
Metadata must be a regular file, not stdin; INPUT may be '-' for stdin.

inspect validates and exports a canonical dataset without computing a result.
analyze uses the same method as the browser. It requires WT, both singles and
the double for each contrast. Missing genotypes are unavailable, never imputed.
Bootstrap defaults: 1000 samples, seed 1; 0 samples disables intervals.
replay recomputes exact embedded inputs and rejects changed evidence; it does
not permit metadata, bootstrap or seed overrides.

JSON goes to stdout unless --output names a NEW file. --format tsv is available
for analyze/replay; --section selects complete pairs (default) or observations.
TSV uses NA for unavailable numbers and is not a replayable evidence record.
JSON preserves exact protein, measurements, source attribution and settings.
--timeout-ms defaults to 300000 (1–3600000). Ctrl-C cancels before publication.
Existing files are never overwritten. Progress/errors go to stderr.
The assay contrast does not predict fitness, binding, escape or significance.
`;

export interface EpistasisCommand {
  operation: 'inspect' | 'analyze' | 'replay';
  input: string;
  metadata?: string;
  output?: string;
  format: 'json' | 'tsv';
  section: 'pairs' | 'observations';
  options: EpistasisAssayOptions | null;
  timeoutMs: number;
}
function path(value: string): void {
  if (!value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('Provide a file path without control characters (at most 8192 characters).');
  }
}
function whole(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(label + ' requires a nonnegative whole number.');
  return Number(value);
}
export function parseEpistasisCommand(args: readonly string[]): EpistasisCommand | null {
  if (!args.length || args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  const [operation, input, ...argsOptions] = args;
  if (!['inspect', 'analyze', 'replay'].includes(operation) || !input || input.startsWith('--')) {
    throw new Error('Expected epistasis inspect|analyze|replay INPUT. See epistasis --help.');
  }
  path(input);
  const values = new Map<string, string>();
  for (let i = 0; i < argsOptions.length; i += 2) {
    const key = argsOptions[i], value = argsOptions[i + 1];
    if (!['--output', '--metadata', '--format', '--section', '--bootstrap-samples', '--seed', '--timeout-ms'].includes(key) || values.has(key)) {
      throw new Error('Unsupported or repeated option: ' + key);
    }
    if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error('Provide a value for ' + key + '.');
    values.set(key, value);
  }
  const metadata = values.get('--metadata');
  if (metadata !== undefined) {
    path(metadata);
    if (metadata === '-' || operation === 'replay') throw new Error('--metadata requires a regular file and is available only for inspect/analyze.');
  }
  if (operation !== 'analyze' && (values.has('--bootstrap-samples') || values.has('--seed'))) {
    throw new Error('Bootstrap and seed settings are available only for analyze; replay uses the recorded settings.');
  }
  const options = operation === 'analyze' ? resolveEpistasisAssayOptions({
    bootstrapSamples: whole(values.get('--bootstrap-samples') ?? '1000', '--bootstrap-samples'),
    seed: whole(values.get('--seed') ?? '1', '--seed'),
  }) : null;
  const format = values.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'tsv' || format === 'tsv' && operation === 'inspect') {
    throw new Error('--format must be json, or tsv for analyze/replay.');
  }
  const section = values.get('--section') ?? 'pairs';
  if (section !== 'pairs' && section !== 'observations' || values.has('--section') && format !== 'tsv') {
    throw new Error('--section pairs|observations requires --format tsv.');
  }
  const timeoutMs = whole(values.get('--timeout-ms') ?? '300000', '--timeout-ms');
  if (timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeout-ms must be an integer from 1 to 3600000.');
  const output = values.get('--output'); if (output !== undefined) path(output);
  return { operation: operation as EpistasisCommand['operation'], input,
    format, section, options, timeoutMs,
    ...(metadata === undefined ? {} : { metadata }), ...(output === undefined || output === '-' ? {} : { output }) };
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Epistasis operation cancelled.', 'AbortError');
}

/** CSV never guesses a reference sequence, measurement scale or replicate design. */
export function parseEpistasisCommandInput(content: string, metadata?: string): EpistasisAssayDataset {
  if (metadata === undefined) return parseEpistasisAssayDataset(content);
  if (new TextEncoder().encode(metadata).length > EPISTASIS_ASSAY_LIMITS.bytes) throw new Error('Epistasis metadata exceeds the 2 MiB limit.');
  const parsed: unknown = JSON.parse(metadata.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || 'observations' in parsed) {
    throw new Error('Metadata must contain the complete dataset definitions without an observations field.');
  }
  return parseEpistasisAssayCsv(content, parsed as Omit<EpistasisAssayDataset, 'observations'>);
}

export function createTerminalEpistasisWorker(): EpistasisEvidenceWorker {
  const worker = new Worker(new URL(typeof PHAGE_EPISTASIS_WORKER === 'string'
    ? PHAGE_EPISTASIS_WORKER : '../workers/epistasis-worker.ts', import.meta.url));
  let stopped = false, returned = false;
  const adapter: EpistasisEvidenceWorker = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage: request => worker.postMessage(request),
    terminate: () => { if (!stopped) { stopped = true; void worker.terminate().catch(() => {}); } },
  };
  const fail = (message: string) => {
    if (!stopped) adapter.onmessage?.({ data: { kind: 'error', message } } as MessageEvent<EpistasisEvidenceMessage>);
  };
  worker.on('message', (data: EpistasisEvidenceMessage) => {
    if (stopped) return;
    if (data?.kind === 'result' || data?.kind === 'error') returned = true;
    adapter.onmessage?.({ data } as MessageEvent<EpistasisEvidenceMessage>);
  });
  worker.on('error', error => fail(error instanceof Error ? error.message : 'Epistasis worker failed.'));
  worker.on('messageerror', () => fail('Epistasis worker response could not be decoded.'));
  worker.on('exit', code => { if (!returned) fail('Epistasis worker exited (' + code + ') before returning a result.'); });
  return adapter;
}
export async function runEpistasisRequest(request: EpistasisEvidenceRequest, signal: AbortSignal,
  progress: (phase: string) => void = () => {}, factory: () => EpistasisEvidenceWorker = createTerminalEpistasisWorker): Promise<EpistasisEvidenceResult> {
  check(signal);
  const session = new EpistasisEvidenceSession(factory); session.activate();
  let phase: string | null = null;
  const unsubscribe = session.subscribe(() => {
    const next = session.getSnapshot().phase;
    if (next !== null && next !== phase) { phase = next; progress(next); }
  });
  const cancel = () => session.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check(signal);
    const accepted = await session.run(request); check(signal);
    if (!accepted || !session.getSnapshot().accepted) throw new Error(session.getSnapshot().error ?? 'No epistasis result was accepted.');
    return session.getSnapshot().accepted!;
  } finally { signal.removeEventListener('abort', cancel); unsubscribe(); session.deactivate(); }
}

export async function readEpistasisInput(filename: string, signal: AbortSignal): Promise<string> {
  path(filename); check(signal);
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    check(signal);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Epistasis input must be a regular UTF-8 file; use - for stdin.');
    if (stat.size > EPISTASIS_FILE_LIMIT) throw new Error('Epistasis input exceeds the 10 MiB file limit.');
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      check(signal);
      const chunk = Buffer.alloc(Math.min(65536, EPISTASIS_FILE_LIMIT + 1 - bytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null); check(signal);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > EPISTASIS_FILE_LIMIT) throw new Error('Epistasis input exceeds the 10 MiB file limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally { await file.close(); }
}
function readStdin(stream: Readable, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0; const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      stream.pause(); stream.off('data', data); stream.off('end', end); stream.off('close', closed); stream.off('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); } catch (cause) { reject(cause); }
    };
    const data = (chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk; bytes += value.length;
      if (bytes > EPISTASIS_FILE_LIMIT) finish(new Error('Epistasis stdin exceeds the 10 MiB limit.'));
      else chunks.push(value);
    };
    const end = () => finish();
    const closed = () => finish(new Error('Epistasis stdin closed before the complete input was read.'));
    const failed = (cause: Error) => finish(cause);
    const aborted = () => { try { check(signal); } catch (cause) { finish(cause as Error); } };
    if (signal.aborted) { aborted(); return; }
    if (stream.destroyed || stream.readableEnded) { finish(new Error('stdin is no longer readable.')); return; }
    signal.addEventListener('abort', aborted, { once: true });
    stream.on('data', data); stream.once('end', end); stream.once('close', closed); stream.once('error', failed);
  });
}
function write(stream: Writable, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (cause: Error) => reject(cause);
    stream.once('error', failed);
    stream.write(content, cause => {
      if (cause) { reject(cause); return; }
      stream.off('error', failed); resolve();
    });
  });
}
export interface EpistasisCommandIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  factory?: () => EpistasisEvidenceWorker;
}
export async function runEpistasisCommand(args: readonly string[], io: EpistasisCommandIO): Promise<number> {
  const error = (cause: unknown) => write(io.stderr, 'Epistasis: ' + stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 2000) + '\n');
  let command: EpistasisCommand | null;
  try { command = parseEpistasisCommand(args); } catch (cause) { await error(cause); return 2; }
  if (!command) { await write(io.stdout, EPISTASIS_COMMAND_HELP); return 0; }
  const controller = new AbortController();
  const cancel = () => controller.abort(io.signal?.reason ?? new DOMException('Epistasis operation cancelled.', 'AbortError'));
  io.signal?.addEventListener('abort', cancel, { once: true }); if (io.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('Epistasis operation timed out.', 'TimeoutError')), command.timeoutMs);
  const signal = controller.signal;
  try {
    check(signal);
    if (command.output) {
      const existing = await lstat(command.output).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return null; throw cause; });
      if (existing) throw new Error('Output already exists; choose a new file.');
    }
    const writes: Promise<void>[] = [];
    const progress = (phase: string) => {
      const pending = write(io.stderr, JSON.stringify({ operation: command.operation, phase }) + '\n');
      void pending.catch(() => {}); writes.push(pending);
    };
    progress('reading-inputs');
    const text = await (command.input === '-' ? readStdin(io.stdin, signal) : readEpistasisInput(command.input, signal));
    const metadata = command.metadata ? await readEpistasisInput(command.metadata, signal) : undefined;
    check(signal);
    const request: EpistasisEvidenceRequest = command.operation === 'replay' ? { kind: 'replay', content: text }
      : command.operation === 'analyze' ? { kind: 'analyze', dataset: parseEpistasisCommandInput(text, metadata), options: command.options! }
      : { kind: 'import', content: JSON.stringify(parseEpistasisCommandInput(text, metadata)) };
    const result = await runEpistasisRequest(request, signal, progress, io.factory);
    check(signal);
    const content = command.format === 'tsv' ? exportEpistasisAssayTsv(result.record!, command.section)
      : result.record ? serializeAnalysisRecord(result.record) : JSON.stringify(result.dataset, null, 2);
    progress('publishing'); await Promise.all(writes); check(signal);
    // After this commit point finish the complete write; cancellation cannot truncate an accepted result.
    if (command.output) {
      const file = await open(command.output, 'wx', 0o600);
      try { await file.writeFile(content + (content.endsWith('\n') ? '' : '\n'), 'utf8'); await file.sync(); }
      finally { await file.close(); }
    } else await write(io.stdout, content + (content.endsWith('\n') ? '' : '\n'));
    return 0;
  } catch (cause) {
    await error(cause);
    return signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 124 : signal.aborted ? 130 : 1;
  } finally { clearTimeout(timer); io.signal?.removeEventListener('abort', cancel); }
}
export async function runEpistasisProcess(args: readonly string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runEpistasisCommand(args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause(); }
}
