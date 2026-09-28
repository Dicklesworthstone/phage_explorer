/** Headless host-model workflows share the browser's numerical and replay contracts. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { analyzeHostMetabolism, createHostFluxRecord, replayHostFluxRecord, resolveHostFluxOptions,
  validateHostModelInput, HOST_FLUX_LIMITS } from '../../../core/src/analysis/host-metabolism';
import { fetchHostMetabolismReference, getHostMetabolismReference } from '../../../core/src/analysis/host-metabolism-reference';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
// Reuse the established bounded, fatal-UTF8, abortable local-file/stdin readers.
import { readAbundanceFile as readLocalFile, readAbundanceStdin as readLocalStdin } from './abundance';

export const HOST_METABOLISM_HELP = `Host metabolism (explicit models and assumptions, not measured phage fitness)

  phage-explorer host-metabolism reference e-coli-core [--output NEW_FILE]
  phage-explorer host-metabolism inspect INPUT [--source FILE --medium FILE] [--output NEW_FILE]
  phage-explorer host-metabolism analyze INPUT [--source FILE --medium FILE] [--params FILE] [--output NEW_FILE]
  phage-explorer host-metabolism replay SAVED_ANALYSIS [--output NEW_FILE]

reference explicitly downloads the checksum-pinned published BiGG model, with its
source/license and unchanged medium bounds. Only this command uses the network.
The BiGG license permits educational, research and nonprofit use; commercial use
requires permission from the publisher. Inspect the saved source.license field.
inspect/analyze accept a portable host-model dataset, or raw COBRA JSON together
with BOTH --source and --medium JSON objects matching the browser import fields.
--params is the browser's JSON object: changes, variability, objectiveLoss.
All changes apply simultaneously. No gene/host/capacity mapping is guessed.
replay verifies and recomputes a saved browser/terminal experiment; overrides
are forbidden. A valid computation can contain infeasible solver statuses.
JSON goes to stdout unless --output names a NEW file; existing files are never
replaced. Use '-' for at most one input stream. Progress/errors go to stderr.
Ctrl-C cancels a worker before output publication. No catalog or TTY is needed.
`;
export type HostMetabolismOperation = 'reference' | 'inspect' | 'analyze' | 'replay';
export interface HostMetabolismCommand {
  operation: HostMetabolismOperation; input: string; source?: string; medium?: string; parameters?: string; output?: string;
}
export interface HostMetabolismJob {
  operation: HostMetabolismOperation; input: string; source?: string; medium?: string; parameters?: string;
}
export interface HostMetabolismJobResult { content: string; resultId: string | null; verified: boolean }
export type HostMetabolismProgress = 'reading-inputs' | 'downloading-reference' | 'validating-inputs' | 'computing' | 'binding-result' | 'verifying-replay' | 'publishing';
export type HostMetabolismJobMessage = { kind: 'progress'; phase: HostMetabolismProgress }
  | { kind: 'result'; result: HostMetabolismJobResult } | { kind: 'error'; message: string };
const RECORD_LIMIT = 10 * 1024 * 1024, SETTINGS_LIMIT = 128 * 1024;

export function parseHostMetabolismCommand(args: string[]): HostMetabolismCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    source: { type: 'string' }, medium: { type: 'string' }, params: { type: 'string' }, output: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['reference', 'inspect', 'analyze', 'replay'].includes(operation)) {
    throw new Error('Expected host-metabolism reference|inspect|analyze|replay INPUT. See --help.');
  }
  if (![input, values.source, values.medium, values.params, values.output].every(value => value === undefined || value.trim().length > 0)) throw new Error('File paths must not be empty.');
  if ((values.source === undefined) !== (values.medium === undefined)) throw new Error('Raw COBRA import requires both --source and --medium.');
  if ((operation === 'reference' || operation === 'replay') && [values.source, values.medium, values.params].some(value => value !== undefined)) throw new Error('Reference/replay commands cannot override recorded inputs or settings.');
  if (operation === 'inspect' && values.params !== undefined) throw new Error('--params requires analyze.');
  if ([input, values.source, values.medium, values.params].filter(value => value === '-').length > 1) throw new Error('Only one input may read from stdin (-).');
  if (operation === 'reference') getHostMetabolismReference(input);
  return { operation: operation as HostMetabolismOperation, input, source: values.source, medium: values.medium,
    parameters: values.params, output: values.output === '-' ? undefined : values.output };
}
const abortError = () => new DOMException('Host-model operation cancelled.', 'AbortError');
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
function parseJson(content: unknown, limit: number, label: string): unknown {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > limit) throw new Error(`${label} exceeds its supported byte limit.`);
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

/** All local operations are offline; only the explicit reference operation downloads data. */
export async function executeHostMetabolismJob(job: HostMetabolismJob,
  progress: (phase: HostMetabolismProgress) => void = () => {}): Promise<HostMetabolismJobResult> {
  if (!job || !['reference', 'inspect', 'analyze', 'replay'].includes(job.operation) || typeof job.input !== 'string') throw new Error('Unsupported host-model job.');
  if (job.operation === 'reference' || job.operation === 'replay') {
    if ([job.source, job.medium, job.parameters].some(value => value !== undefined)) throw new Error('Reference/replay cannot override inputs or settings.');
    if (job.operation === 'reference') {
      getHostMetabolismReference(job.input); progress('downloading-reference');
      const input = await fetchHostMetabolismReference(job.input);
      return { content: JSON.stringify(input, null, 2), resultId: null, verified: false };
    }
    parseJson(job.input, RECORD_LIMIT, 'Saved experiment');
    progress('verifying-replay');
    const replay = await replayHostFluxRecord(job.input.replace(/^\uFEFF/, ''));
    return { content: serializeAnalysisRecord(replay.record), resultId: replay.record.resultId, verified: true };
  }
  if ((job.source === undefined) !== (job.medium === undefined)) throw new Error('Raw COBRA import requires source and medium.');
  progress('validating-inputs');
  const decoded = parseJson(job.input, HOST_FLUX_LIMITS.bytes, 'Host model');
  const input = validateHostModelInput(job.source === undefined ? decoded : {
    format: 'phage-explorer-host-model', version: 1, cobra: decoded,
    source: parseJson(job.source, SETTINGS_LIMIT, 'Source metadata'), medium: parseJson(job.medium, SETTINGS_LIMIT, 'Medium metadata'),
  });
  if (job.operation === 'inspect') {
    if (job.parameters !== undefined) throw new Error('Inspection does not accept analysis settings.');
    return { content: JSON.stringify(input, null, 2), resultId: null, verified: false };
  }
  const options = resolveHostFluxOptions(job.parameters === undefined ? {} : parseJson(job.parameters, SETTINGS_LIMIT, 'Analysis settings'));
  progress('computing');
  const result = analyzeHostMetabolism(input, options);
  progress('binding-result');
  const record = await createHostFluxRecord(input, result);
  return { content: serializeAnalysisRecord(record), resultId: record.resultId, verified: false };
}

declare const PHAGE_HOST_METABOLISM_WORKER: string | undefined;
export function runHostMetabolismJob(job: HostMetabolismJob, signal?: AbortSignal,
  progress: (phase: HostMetabolismProgress) => void = () => {}): Promise<HostMetabolismJobResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolveResult, reject) => {
    const url = typeof PHAGE_HOST_METABOLISM_WORKER === 'string'
      ? new URL(PHAGE_HOST_METABOLISM_WORKER, import.meta.url) : new URL('../workers/host-metabolism-worker.ts', import.meta.url);
    const worker = new Worker(url); let settled = false;
    const finish = (error: Error | null, result?: HostMetabolismJobResult) => {
      if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolveResult(result!);
    };
    const abort = () => finish(abortError());
    worker.on('message', (message: HostMetabolismJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message?.kind === 'progress') {
        try { progress(message.phase); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
      } else if (message?.kind === 'result' && typeof message.result?.content === 'string') finish(null, message.result);
      else finish(new Error(message?.kind === 'error' ? message.message : 'Invalid host-model worker response.'));
    });
    // Retain the error listener until termination, including after cancellation.
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => finish(new Error(`Host-model worker exited without a result (code ${code}).`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}
function writeStream(stream: Writable, content: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const fail = (error: Error) => { stream.off('error', fail); reject(error); };
    stream.once('error', fail);
    stream.write(content, error => {
      if (error) { reject(error); return; }
      stream.off('error', fail); resolveWrite();
    });
  });
}
export interface HostMetabolismCommandIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal; execute?: typeof runHostMetabolismJob;
}
export async function runHostMetabolismCommand(args: string[], io: HostMetabolismCommandIO): Promise<number> {
  const report = (cause: unknown) => writeStream(io.stderr, 'Host metabolism: ' + stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n');
  let command: HostMetabolismCommand | null;
  try { command = parseHostMetabolismCommand(args); } catch (cause) { await report(cause); return 2; }
  if (!command) { await writeStream(io.stdout, HOST_METABOLISM_HELP); return 0; }
  try {
    checkAbort(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) {
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) throw new Error('Output already exists; choose a new file. Inputs and results are never overwritten.');
    }
    const pending: Promise<void>[] = [];
    const progress = (phase: HostMetabolismProgress) => {
      const writing = writeStream(io.stderr, JSON.stringify({ operation: command.operation, phase }) + '\n');
      void writing.catch(() => {}); pending.push(writing);
    };
    progress('reading-inputs');
    const read = (filename: string, limit: number) => filename === '-' ? readLocalStdin(io.stdin, limit, io.signal) : readLocalFile(filename, limit, io.signal);
    const input = command.operation === 'reference' ? command.input : await read(command.input, command.operation === 'replay' ? RECORD_LIMIT : HOST_FLUX_LIMITS.bytes);
    const source = command.source === undefined ? undefined : await read(command.source, SETTINGS_LIMIT);
    const medium = command.medium === undefined ? undefined : await read(command.medium, SETTINGS_LIMIT);
    const parameters = command.parameters === undefined ? undefined : await read(command.parameters, SETTINGS_LIMIT);
    checkAbort(io.signal);
    const result = await (io.execute ?? runHostMetabolismJob)({ operation: command.operation, input, source, medium, parameters }, io.signal, progress);
    checkAbort(io.signal); progress('publishing'); await Promise.all(pending); checkAbort(io.signal);
    // Publication is the commit point: complete a validated write once begun.
    if (destination) await writeFile(destination, result.content + '\n', { encoding: 'utf8', flag: 'wx' });
    else await writeStream(io.stdout, result.content + '\n');
    return 0;
  } catch (cause) {
    await report(cause);
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}
export async function runHostMetabolismProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort(), terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runHostMetabolismCommand(args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

