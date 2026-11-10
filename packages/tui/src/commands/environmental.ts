/** Local environmental evidence through the same producer and verified session as the browser. */
import { Worker } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { EnvironmentalSession, type EnvironmentalWorker } from '../../../web/src/workers/EnvironmentalSession';
import { ENVIRONMENTAL_FILE_LIMIT, type EnvironmentalRequest, type EnvironmentalWorkResult,
  type EnvironmentalWorkerMessage } from '../../../web/src/workers/environmental-runtime';
import { parseEnvironmentalDataset, serializeEnvironmentalDataset, environmentalEvidenceTsv } from '../../../core/src/analysis/environmental-evidence';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';

declare const PHAGE_ENVIRONMENTAL_WORKER: string | undefined;

export const ENVIRONMENTAL_COMMAND_HELP = `Environmental sample evidence (local files; no catalog or network required)

  phage-explorer environment inspect INPUT [--output NEW_FILE]
  phage-explorer environment analyze INPUT [--format json|tsv] [--output NEW_FILE]
  phage-explorer environment replay SAVED_ANALYSIS [--format json|tsv] [--output NEW_FILE]
  phage-explorer environment from-abundance INPUT --taxon EXACT_ID [--output NEW_FILE]

INPUT for inspect/analyze is a version-1 phage-explorer-environmental JSON dataset.
inspect validates and exports the complete dataset without claiming a result.
analyze computes the browser's sample/biome summaries and portable evidence record.
replay recomputes a saved browser or terminal record and rejects changed evidence.
from-abundance converts exactly one supplied taxon from a CSV/TSV, abundance dataset
or verified abundance analysis; join metadata first with abundance inspect --metadata.
It exports a source dataset for review, not an environmental analysis. Metadata is
joined by sample ID; locations, dates, unassayed records and zeros keep their meaning.

Use '-' for stdin. JSON goes to stdout unless --output names a NEW file.
--format tsv is available for analyze/replay and retains every sample; empty cells
mean unavailable. TSV is a table, not a replayable experiment. JSON preserves source
attribution, measurement units, supplied date/location precision and private inputs.
--timeout-ms defaults to 300000 (1–3600000). Ctrl-C cancels before publication.
Existing outputs are never overwritten. Progress/errors go to stderr.
Assay-specific detection is not environmental prevalence or proof of absence.
`;

export interface EnvironmentalCommand {
  operation: 'inspect' | 'analyze' | 'replay' | 'from-abundance';
  input: string;
  output?: string;
  taxon?: string;
  format: 'json' | 'tsv';
  timeoutMs: number;
}
function path(value: string): void {
  if (!value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Provide a file path without control characters (at most 8192 characters).');
}
export function parseEnvironmentalCommand(args: readonly string[]): EnvironmentalCommand | null {
  if (!args.length || args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  const [operation, input, ...options] = args;
  if (!['inspect', 'analyze', 'replay', 'from-abundance'].includes(operation) || !input || input.startsWith('--')) {
    throw new Error('Expected environment inspect|analyze|replay|from-abundance INPUT. See environment --help.');
  }
  path(input);
  const values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i], value = options[i + 1];
    if (!['--output', '--taxon', '--format', '--timeout-ms'].includes(key) || values.has(key)) throw new Error(`Unsupported or repeated option: ${key}`);
    if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(`Provide a value for ${key}.`);
    values.set(key, value);
  }
  const taxon = values.get('--taxon');
  if ((operation === 'from-abundance') !== (taxon !== undefined)) throw new Error('--taxon EXACT_ID is required only for from-abundance.');
  if (taxon !== undefined && (taxon.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(taxon))) throw new Error('Provide one exact taxon ID without control characters.');
  const format = values.get('--format') ?? 'json';
  if (!['json', 'tsv'].includes(format) || format === 'tsv' && operation !== 'analyze' && operation !== 'replay') throw new Error('--format tsv requires analyze or replay; use json for a source dataset.');
  const timeout = values.get('--timeout-ms') ?? '300000';
  if (!/^[1-9]\d*$/.test(timeout) || !Number.isSafeInteger(Number(timeout)) || Number(timeout) > 3600000) throw new Error('--timeout-ms must be an integer from 1 to 3600000.');
  const output = values.get('--output');
  if (output !== undefined) path(output);
  return { operation: operation as EnvironmentalCommand['operation'], input, format: format as 'json' | 'tsv',
    timeoutMs: Number(timeout), ...(output === undefined || output === '-' ? {} : { output }), ...(taxon === undefined ? {} : { taxon }) };
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Environmental operation cancelled.', 'AbortError');
}

/** Native transport only: browser session validation and the shared producer own scientific results. */
export function createTerminalEnvironmentalWorker(): EnvironmentalWorker {
  const worker = new Worker(new URL(typeof PHAGE_ENVIRONMENTAL_WORKER === 'string'
    ? PHAGE_ENVIRONMENTAL_WORKER : '../workers/environmental-worker.ts', import.meta.url));
  let stopped = false, returned = false;
  const adapter: EnvironmentalWorker = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage: request => worker.postMessage(request),
    terminate: () => { if (!stopped) { stopped = true; void worker.terminate().catch(() => {}); } },
  };
  const fail = (message: string) => {
    if (!stopped) adapter.onmessage?.({ data: { kind: 'error', message } } as MessageEvent<EnvironmentalWorkerMessage>);
  };
  worker.on('message', (data: EnvironmentalWorkerMessage) => {
    if (stopped) return;
    if (data?.kind === 'result' || data?.kind === 'error') returned = true;
    adapter.onmessage?.({ data } as MessageEvent<EnvironmentalWorkerMessage>);
  });
  worker.on('error', error => fail(error instanceof Error ? error.message : 'Environmental worker failed.'));
  worker.on('messageerror', () => fail('Environmental worker response could not be decoded.'));
  worker.on('exit', code => { if (!returned) fail(`Environmental worker exited (${code}) before returning a result.`); });
  return adapter;
}

export async function runEnvironmentalRequest(request: EnvironmentalRequest, signal: AbortSignal,
  progress: (phase: string) => void = () => {}, factory: () => EnvironmentalWorker = createTerminalEnvironmentalWorker): Promise<EnvironmentalWorkResult> {
  check(signal);
  const session = new EnvironmentalSession(factory);
  session.activate();
  let phase: string | null = null;
  const unsubscribe = session.subscribe(() => {
    const next = session.getSnapshot().phase;
    if (next !== null && next !== phase) { phase = next; progress(next); }
  });
  const cancel = () => session.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check(signal);
    const accepted = await session.run(request);
    check(signal);
    if (!accepted || !session.getSnapshot().accepted) throw new Error(session.getSnapshot().error ?? 'No environmental result was accepted.');
    return session.getSnapshot().accepted!;
  } finally { signal.removeEventListener('abort', cancel); unsubscribe(); session.deactivate(); }
}

export async function readEnvironmentalInput(filename: string, signal: AbortSignal): Promise<string> {
  path(filename); check(signal);
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    check(signal);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Environmental input must be a regular UTF-8 file; use - for stdin.');
    if (stat.size > ENVIRONMENTAL_FILE_LIMIT) throw new Error('Environmental input exceeds the 10 MiB file limit.');
    const chunks: Buffer[] = []; let bytes = 0;
    for (;;) {
      check(signal);
      const chunk = Buffer.alloc(Math.min(65536, ENVIRONMENTAL_FILE_LIMIT + 1 - bytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      check(signal);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > ENVIRONMENTAL_FILE_LIMIT) throw new Error('Environmental input exceeds the 10 MiB file limit.');
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
      if (bytes > ENVIRONMENTAL_FILE_LIMIT) finish(new Error('Environmental stdin exceeds the 10 MiB limit.'));
      else chunks.push(value);
    };
    const end = () => finish();
    const closed = () => finish(new Error('Environmental stdin closed before the complete input was read.'));
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
export interface EnvironmentalCommandIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  factory?: () => EnvironmentalWorker;
}
export async function runEnvironmentalCommand(args: readonly string[], io: EnvironmentalCommandIO): Promise<number> {
  const error = (cause: unknown) => write(io.stderr, 'Environment: ' + stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 2000) + '\n');
  let command: EnvironmentalCommand | null;
  try { command = parseEnvironmentalCommand(args); } catch (cause) { await error(cause); return 2; }
  if (!command) { await write(io.stdout, ENVIRONMENTAL_COMMAND_HELP); return 0; }
  const controller = new AbortController();
  const cancel = () => controller.abort(io.signal?.reason ?? new DOMException('Environmental operation cancelled.', 'AbortError'));
  io.signal?.addEventListener('abort', cancel, { once: true });
  if (io.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('Environmental operation timed out.', 'TimeoutError')), command.timeoutMs);
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
    const text = (await (command.input === '-' ? readStdin(io.stdin, signal) : readEnvironmentalInput(command.input, signal))).replace(/^\uFEFF/, '');
    check(signal);
    const request: EnvironmentalRequest = command.operation === 'from-abundance' ? { kind: 'abundance', content: text, taxon: command.taxon! }
      : command.operation === 'replay' ? { kind: 'replay', content: text }
      : command.operation === 'analyze' ? { kind: 'analyze', dataset: parseEnvironmentalDataset(text) }
      : { kind: 'import', content: serializeEnvironmentalDataset(parseEnvironmentalDataset(text)) };
    const result = await runEnvironmentalRequest(request, signal, progress, io.factory);
    check(signal);
    const content = command.format === 'tsv' ? environmentalEvidenceTsv(result.dataset, result.analysis!)
      : result.record ? serializeAnalysisRecord(result.record) : serializeEnvironmentalDataset(result.dataset);
    progress('publishing'); await Promise.all(writes); check(signal);
    // After this commit point finish the complete write. Interrupts cannot truncate an accepted result.
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
export async function runEnvironmentalProcess(args: readonly string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runEnvironmentalCommand(args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause(); }
}
