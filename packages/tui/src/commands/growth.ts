/** Database-free mechanistic growth fitting and replay on user-supplied observations. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import {
  GROWTH_LIMITS, parseGrowthData, validateGrowthDataset, validateGrowthConditions,
  resolveGrowthOptions, fitGrowthDataset, createGrowthRecord, replayGrowthRecord,
  type GrowthConditions, type GrowthDataset, type GrowthFitOptions, type GrowthFitResult,
} from '../../../core/src/analysis/growth-inference';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;
const AUX_LIMIT = 64 * 1024;

export const GROWTH_COMMAND_HELP = `Mechanistic infection growth fitting (local files only; no catalog/network required)

  phage-explorer growth inspect INPUT [--conditions FILE] [--name NAME] [--source TEXT] [--reference TEXT] [--demo]
  phage-explorer growth fit INPUT [--conditions FILE] [--params FILE] [--name NAME] [--source TEXT] [--reference TEXT] [--demo]
  phage-explorer growth replay SAVED_ANALYSIS

Common options:
  --format json|residuals   fit/replay output (default json)
  --output NEW_FILE         write a new file; existing files are never replaced
  -                         use stdin for at most one of INPUT, --conditions or --params

Delimited INPUT uses header timeMin,type,value,sigma with optional censoring.
PFU/CFU are concentrations per mL with known log10 SD; OD uses ordinary SD.
CSV/TSV requires --conditions JSON with initialBacteria, initialPhage,
bacterialGrowthRate, phageDecayRate, odCellsPerMl and stages. Canonical
phage-explorer-growth JSON already embeds conditions/source and cannot be relabeled.

--params is a partial fit-options JSON object accepted by the core model. The fit
uses the same bounded multistart mechanistic producer as the browser. replay
recomputes the saved fit and rejects changed evidence. Residual export includes
observed/predicted values, censoring and standardized residual/deviance fields.
These conditional estimates do not by themselves establish biological latency,
adsorption, burst size, host range or model validity.
`;

export type GrowthOperation = 'inspect' | 'fit' | 'replay';
export interface GrowthCommand {
  operation: GrowthOperation; input: string; conditions?: string; parameters?: string; output?: string;
  format: 'json' | 'residuals'; name?: string; source?: string; reference?: string; demo: boolean;
}
export interface GrowthJob {
  operation: GrowthOperation;
  input: { name: string; text: string };
  conditions?: string;
  parameters?: string;
  source?: { name?: string; description?: string; reference?: string; demo: boolean };
}
export interface GrowthJobResult {
  content: string; residuals: string | null; identity: string | null; verified: boolean;
}
export type GrowthJobMessage =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; result: GrowthJobResult }
  | { kind: 'error'; message: string };
export interface GrowthCommandIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  execute?: typeof runGrowthJob;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Growth operation cancelled.', 'AbortError');
}
function requireText(value: unknown, limit: number, label: string): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) throw new Error(label + ' exceeds its byte limit.');
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function parseObject(text: string, label: string): Record<string, unknown> {
  requireText(text, AUX_LIMIT, label);
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!plainObject(value)) throw new Error(label + ' must be a JSON object.');
  return value;
}
function residualCsv(result: GrowthFitResult): string {
  const header = ['time_min','type','observed_value','sigma','censoring','predicted','standardized_residual','likelihood_deviance'];
  const cell = (value: string | number | null | undefined) => value === null || value === undefined ? '' : String(value);
  return [header.join(','), ...result.residuals.map(row => [
    row.timeMin, row.type, row.value, row.sigma, row.censoring ?? 'none', row.predicted,
    row.standardizedResidual, row.likelihoodDeviance,
  ].map(cell).join(','))].join('\n') + '\n';
}
function sourceOverrides(job: GrowthJob): boolean {
  return !!job.source && (job.source.name !== undefined || job.source.description !== undefined
    || job.source.reference !== undefined || job.source.demo);
}
function loadDataset(job: GrowthJob): GrowthDataset {
  const text = job.input.text.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{')) {
    if (job.conditions !== undefined) throw new Error('--conditions is only for CSV/TSV input; canonical growth JSON embeds conditions.');
    if (sourceOverrides(job)) throw new Error('Canonical growth JSON retains embedded source attribution; source flags apply only to CSV/TSV import.');
    return validateGrowthDataset(JSON.parse(text));
  }
  if (job.conditions === undefined) throw new Error('CSV/TSV growth input requires --conditions JSON with explicit experimental initial conditions.');
  const conditions = validateGrowthConditions(parseObject(job.conditions, 'Growth conditions'));
  const name = job.source?.name ?? job.input.name;
  const parsed = parseGrowthData(text, name, conditions);
  return validateGrowthDataset({ ...parsed, name,
    source: { kind: job.source?.demo ? 'demo' : 'local',
      description: job.source?.description ?? name, reference: job.source?.reference ?? null } });
}

export async function executeGrowthJob(job: GrowthJob, progress: (message: string) => void = () => {}): Promise<GrowthJobResult> {
  if (!job || !['inspect','fit','replay'].includes(job.operation) || !job.input || typeof job.input.name !== 'string') {
    throw new Error('Unsupported growth job.');
  }
  requireText(job.input.text, job.operation === 'replay' ? RECORD_LIMIT : GROWTH_LIMITS.bytes, 'Growth input');
  if (job.operation === 'replay') {
    if (job.conditions !== undefined || job.parameters !== undefined || sourceOverrides(job)) {
      throw new Error('Replay cannot override saved conditions, parameters or source attribution.');
    }
    progress('Recomputing saved growth fit');
    const replay = await replayGrowthRecord(job.input.text.replace(/^\uFEFF/, ''), progress);
    return { content: serializeAnalysisRecord(replay.record), residuals: residualCsv(replay.result),
      identity: replay.record.resultId, verified: true };
  }
  progress('Validating local growth observations');
  const dataset = loadDataset(job);
  if (job.operation === 'inspect') {
    if (job.parameters !== undefined) throw new Error('inspect does not fit parameters; --params requires fit.');
    return { content: JSON.stringify(dataset, null, 2), residuals: null, identity: null, verified: false };
  }
  const options: GrowthFitOptions = resolveGrowthOptions(job.parameters === undefined ? {} : parseObject(job.parameters, 'Growth fit parameters'));
  progress('Solving mechanistic infection model');
  const result = fitGrowthDataset(dataset, options, progress);
  progress('Binding observations, conditions and fit settings to the result');
  const record = await createGrowthRecord(dataset, options, result);
  return { content: serializeAnalysisRecord(record), residuals: residualCsv(result), identity: record.resultId, verified: false };
}

declare const PHAGE_GROWTH_WORKER: string | undefined;
export function runGrowthJob(job: GrowthJob, signal?: AbortSignal,
  progress: (message: string) => void = () => {}): Promise<GrowthJobResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('Growth operation cancelled.', 'AbortError'));
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const url = typeof PHAGE_GROWTH_WORKER === 'string'
      ? new URL(PHAGE_GROWTH_WORKER, import.meta.url)
      : new URL('../workers/growth-worker.ts', import.meta.url);
    const worker = new Worker(url);
    const finish = (error: Error | null, result?: GrowthJobResult) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolveResult(result!);
    };
    const abort = () => finish(new DOMException('Growth operation cancelled.', 'AbortError'));
    worker.on('message', (message: GrowthJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message.kind === 'progress') {
        try { progress(message.message); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
      } else if (message.kind === 'result') finish(null, message.result);
      else finish(new Error(message.kind === 'error' ? message.message : 'Invalid growth worker response.'));
    });
    worker.on('error', cause => finish(cause instanceof Error ? cause : new Error(String(cause))));
    worker.on('exit', code => finish(new Error('Growth worker exited before returning a result (code ' + code + ').')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

export function parseGrowthCommand(args: string[]): GrowthCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    conditions: { type: 'string' }, params: { type: 'string' }, output: { type: 'string' },
    format: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' },
    reference: { type: 'string' }, demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation,input] = positionals;
  if (positionals.length !== 2 || !['inspect','fit','replay'].includes(operation)) {
    throw new Error('Expected growth inspect|fit|replay INPUT. See growth --help.');
  }
  if (!input.trim() || [values.conditions,values.params,values.output,values.name,values.source,values.reference]
    .some(value => value !== undefined && !value.trim())) throw new Error('Paths, names and source fields must not be empty.');
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'residuals') throw new Error('--format must be json or residuals.');
  if (operation === 'inspect' && format !== 'json') throw new Error('inspect emits canonical dataset JSON; residuals require fit or replay.');
  if (operation === 'inspect' && values.params !== undefined) throw new Error('--params requires fit.');
  if (operation === 'replay' && (values.conditions !== undefined || values.params !== undefined || values.name !== undefined
    || values.source !== undefined || values.reference !== undefined || values.demo)) {
    throw new Error('Replay cannot override saved conditions, parameters or source attribution.');
  }
  if ([input,values.conditions,values.params].filter(value => value === '-').length > 1) throw new Error('Only one input may read from stdin (-).');
  return { operation: operation as GrowthOperation, input, conditions: values.conditions, parameters: values.params,
    output: values.output === '-' ? undefined : values.output, format: format as GrowthCommand['format'],
    name: values.name, source: values.source, reference: values.reference, demo: values.demo };
}

function writeStream(stream: Writable, content: string): Promise<void> {
  return new Promise((resolveWrite,reject) => {
    const fail = (error: Error) => { stream.off('error',fail); reject(error); };
    stream.once('error',fail);
    stream.write(content,error => {
      if (error) { reject(error); return; }
      stream.off('error',fail); resolveWrite();
    });
  });
}
async function assertNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error('Output already exists; choose a new file. Existing inputs and results are never overwritten.');
}
function clean(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
}

export async function runGrowthCommand(args: string[], io: GrowthCommandIO): Promise<number> {
  let command: GrowthCommand | null;
  try { command = parseGrowthCommand(args); }
  catch (cause) { await writeStream(io.stderr,'Growth: ' + clean(cause) + '\n'); return 2; }
  if (!command) { await writeStream(io.stdout,GROWTH_COMMAND_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    const read = (filename: string, limit: number) => filename === '-'
      ? readAbundanceStdin(io.stdin,limit,io.signal) : readAbundanceFile(filename,limit,io.signal);
    const input = await read(command.input, command.operation === 'replay' ? RECORD_LIMIT : GROWTH_LIMITS.bytes);
    const conditions = command.conditions === undefined ? undefined : await read(command.conditions,AUX_LIMIT);
    const parameters = command.parameters === undefined ? undefined : await read(command.parameters,AUX_LIMIT);
    check(io.signal);
    const progress = (message: string) => {
      const safe = clean(message);
      void writeStream(io.stderr,JSON.stringify({ operation: command!.operation, phase: safe }) + '\n').catch(() => {});
    };
    const result = await (io.execute ?? runGrowthJob)({ operation: command.operation,
      input: { name: command.name ?? (command.input === '-' ? 'stdin growth data' : basename(command.input)), text: input },
      conditions, parameters,
      source: { name: command.name, description: command.source, reference: command.reference, demo: command.demo } },
      io.signal, progress);
    check(io.signal);
    const output = command.format === 'residuals' ? result.residuals : result.content + '\n';
    if (output === null) throw new Error('Residual export requires a fitted or replayed growth result.');
    if (destination) await writeFile(destination,output,{encoding:'utf8',flag:'wx',mode:0o600});
    else await writeStream(io.stdout,output);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr,'Growth: ' + clean(cause) + '\n');
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

export async function runGrowthProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT',interrupt); process.on('SIGTERM',terminate);
  try {
    const code = await runGrowthCommand(args,{stdin:process.stdin,stdout:process.stdout,stderr:process.stderr,signal:controller.signal});
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT',interrupt); process.off('SIGTERM',terminate); process.stdin.pause(); }
}
