/** Native access to the browser's exact aligned-DNA site compatibility method. */
import { createHash } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { Worker } from 'node:worker_threads';
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import {
  COMPATIBILITY_LIMITS, COMPATIBILITY_METHOD, createCompatibilityExperiment,
  replayCompatibilityExperiment, validateCompatibilityInput, validateCompatibilityExperiment, resolveCompatibilityOptions,
  exportCompatibilityPairsTsv, exportCompatibilitySitesTsv,
  type CompatibilityInput, type CompatibilityOptions, type CompatibilityExperiment,
} from '../../../core/src/analysis/alignment-compatibility';
import { parseAlignedDNA } from '../../../core/src/analysis/aligned-phylogeny';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const TIMEOUT_MS = 120_000;
type OutputFormat = 'json' | 'sites' | 'pairs';
type Metadata = Omit<CompatibilityInput, 'format' | 'version' | 'alignment'> & {
  alignment: Omit<CompatibilityInput['alignment'], 'fasta'>;
};
export type CompatibilityCommand =
  | { operation: 'prepare'; input: string; metadata: Metadata; output?: string }
  | { operation: 'inspect'; input: string; output?: string }
  | { operation: 'analyze'; input: string; options?: CompatibilityOptions; format: OutputFormat; output?: string }
  | { operation: 'replay'; input: string; format: OutputFormat; output?: string };
export type CompatibilityJob =
  | { operation: 'prepare'; content: string; metadata: Metadata }
  | { operation: 'inspect'; content: string }
  | { operation: 'analyze'; content: string; options?: CompatibilityOptions; format: OutputFormat }
  | { operation: 'replay'; content: string; format: OutputFormat };
export interface CompatibilityInspection {
  format: 'phage-explorer-alignment-compatibility-inspection'; version: 1;
  name: string; source: CompatibilityInput['source'];
  alignment: Omit<CompatibilityInput['alignment'], 'fasta'>;
  taxa: string[]; columns: number; inputSha256: string; analysisPerformed: false;
}
export interface CompatibilityJobResult {
  operation: CompatibilityJob['operation']; requestSha256: string; content: string;
  /** Complete evidence also accompanies table exports, so publication can bind
   * the table to the submitted source and interval without rerunning the method. */
  recordJson: string | null; verified: boolean;
}
export type CompatibilityJobMessage = { kind: 'result'; result: CompatibilityJobResult }
  | { kind: 'error'; message: string };
export interface CompatibilityIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  execute?: typeof runCompatibilityJob;
}

export const ALIGNMENT_COMPATIBILITY_HELP = `Exact aligned-DNA site compatibility (local files; no catalog required)

  phage-explorer alignment-compatibility prepare ALIGNED_FASTA
    --name NAME --source-kind local|external|demo --source-reference DESCRIPTION
    --source-version VERSION --alignment-method METHOD --alignment-reference EVIDENCE
    --homologous [--license LICENSE] [--output NEW_FILE]
  phage-explorer alignment-compatibility inspect INPUT_JSON [--output NEW_FILE]
  phage-explorer alignment-compatibility analyze INPUT_JSON
    [--start COLUMN --end COLUMN] [--format json|sites|pairs] [--output NEW_FILE]
  phage-explorer alignment-compatibility replay SAVED_ANALYSIS
    [--format json|sites|pairs] [--output NEW_FILE]

prepare retains the exact aligned FASTA and explicit source/alignment declarations.
The UTF-8 reader removes an initial byte-order mark; casing and line endings remain.
--homologous declares intended column homology; the program does not infer or
validate it. External provenance never downloads data. inspect validates inputs
and reports dimensions/source identity without calculating site pairs or printing
sequences. analyze accepts the prepared version-1 input JSON. replay recomputes
the entire saved browser/native experiment and rejects changed evidence.

--start and --end must appear together: zero-based, half-open ORIGINAL alignment
columns. Omitting both selects the complete alignment. Exclusions never renumber
columns. Replay accepts no interval or source overrides. sites/pairs emit complete
TSV tables with 1-based original columns; JSON retains the replayable experiment.

Inputs require 4–${COMPATIBILITY_LIMITS.taxa} equal-length DNA sequences, at most ${COMPATIBILITY_LIMITS.columns.toLocaleString('en-US')} columns and ${COMPATIBILITY_LIMITS.inputBytes / (1024 * 1024)} MiB
including metadata. Gaps or ambiguity exclude whole columns. All pairs among at
most ${COMPATIBILITY_LIMITS.eligibleSites} eligible biallelic non-singleton sites are counted; nothing is sampled.
The full experiment must fit ${COMPATIBILITY_LIMITS.recordBytes / (1024 * 1024)} MiB. Four haplotypes are observed evidence, not
event counts, donors, breakpoints or p-values; recurrent mutation and alignment
errors are alternatives to recombination. No incompatibility does not prove its
absence. Use the source's own permissions; no biology or authorship is verified.

Use - for stdin. Output goes to stdout unless --output names a NEW file; files
are private and never overwritten. Ctrl-C cancels reads, workers and blocked
output. An interrupted write can leave a partial new file. Progress/errors go
to stderr. No sequences or metadata are uploaded.
`;

function cancelled(): DOMException { return new DOMException('Aligned-site compatibility cancelled.', 'AbortError'); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }
function plain(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || new TextEncoder().encode(value).length > maximum) {
    throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
  }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(analysisJson(value))).digest('hex'); }
function requestDigest(job: CompatibilityJob): string {
  // Optional undefined means the same whole-alignment default as omission.
  return digest(job.operation === 'analyze' && job.options === undefined
    ? { operation: job.operation, content: job.content, format: job.format } : job);
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right)); }
function writeStream(stream: Writable, content: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((yes, no) => {
    let settled = false;
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (cause) no(cause); else yes();
    };
    const abort = () => finish(cancelled());
    const fail = (cause: Error) => { stream.off('error', fail); finish(cause); };
    stream.once('error', fail); signal?.addEventListener('abort', abort, { once: true });
    try {
      stream.write(content, cause => {
        // Keep the error observer until an in-flight write settles after abort.
        if (cause) { finish(cause); return; }
        stream.off('error', fail); finish();
      });
    } catch (cause) { stream.off('error', fail); finish(cause instanceof Error ? cause : new Error(String(cause))); }
    if (signal?.aborted) abort();
  });
}

export function parseCompatibilityCommand(args: string[]): CompatibilityCommand | null {
  const { values, positionals, tokens } = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
    name: { type: 'string' }, 'source-kind': { type: 'string' }, 'source-reference': { type: 'string' },
    'source-version': { type: 'string' }, license: { type: 'string' }, 'alignment-method': { type: 'string' },
    'alignment-reference': { type: 'string' }, homologous: { type: 'boolean' },
    start: { type: 'string' }, end: { type: 'string' }, format: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !args.length) return null;
  const options = tokens.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(options).size !== options.length) throw new Error('Options must be supplied once; duplicate values are ambiguous.');
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['prepare', 'inspect', 'analyze', 'replay'].includes(operation)) {
    throw new Error('Expected alignment-compatibility prepare|inspect|analyze|replay INPUT. See --help.');
  }
  if (!input.trim() || Object.values(values).some(value => typeof value === 'string' && !value.trim())) throw new Error('Paths and option values must not be empty.');
  const output = values.output === '-' ? undefined : values.output;
  const sourceKeys = ['name', 'source-kind', 'source-reference', 'source-version', 'license', 'alignment-method', 'alignment-reference', 'homologous'];
  const allowed = operation === 'prepare' ? [...sourceKeys, 'output'] : operation === 'analyze'
    ? ['start', 'end', 'format', 'output'] : operation === 'replay' ? ['format', 'output'] : ['output'];
  if (options.some(key => !allowed.includes(key))) {
    throw new Error(operation === 'replay' ? 'Replay cannot override saved source or interval settings.' : `Unsupported option for ${operation}.`);
  }
  if (operation === 'prepare') {
    for (const key of sourceKeys.filter(key => key !== 'license')) if (values[key as keyof typeof values] === undefined) {
      throw new Error(`prepare requires --${key}.`);
    }
    if (!['local', 'external', 'demo'].includes(values['source-kind']!)) throw new Error('--source-kind must be local, external or demo.');
    return { operation, input, output, metadata: { name: values.name!,
      source: { kind: values['source-kind'] as CompatibilityInput['source']['kind'], reference: values['source-reference']!,
        version: values['source-version']!, license: values.license ?? null },
      alignment: { homologous: true, method: values['alignment-method']!, reference: values['alignment-reference']! } } };
  }
  if (operation === 'inspect') return { operation, input, output };
  const format = values.format ?? 'json';
  if (!['json', 'sites', 'pairs'].includes(format)) throw new Error('--format must be json, sites or pairs.');
  if (operation === 'replay') return { operation, input, output, format: format as OutputFormat };
  if ((values.start === undefined) !== (values.end === undefined)) throw new Error('Supply both --start and --end or neither.');
  let interval: CompatibilityOptions | undefined;
  if (values.start !== undefined && values.end !== undefined) {
    if (!/^\d+$/.test(values.start) || !/^\d+$/.test(values.end)) throw new Error('Alignment interval requires integer columns.');
    interval = resolveCompatibilityOptions({ start: Number(values.start), end: Number(values.end) }, COMPATIBILITY_LIMITS.columns);
  }
  return { operation: 'analyze', input, output, format: format as OutputFormat, ...(interval ? { options: interval } : {}) };
}

/** Validate aligned input without enumerating pairs; inspect is not an analysis. */
function inspect(input: CompatibilityInput): CompatibilityInspection {
  const taxa = parseAlignedDNA(input.alignment.fasta);
  if (taxa.length < 4) throw new Error('Four-gamete evidence requires at least four aligned taxa.');
  return { format: 'phage-explorer-alignment-compatibility-inspection', version: 1,
    name: input.name, source: input.source,
    alignment: { homologous: true, method: input.alignment.method, reference: input.alignment.reference },
    taxa: taxa.map(taxon => taxon.id), columns: taxa[0].sequence.length,
    inputSha256: digest(input), analysisPerformed: false };
}
function prepared(job: Extract<CompatibilityJob, { operation: 'prepare' }>): CompatibilityInput {
  return validateCompatibilityInput({ format: 'phage-explorer-alignment-compatibility', version: 1,
    ...job.metadata, alignment: { ...job.metadata.alignment, fasta: job.content } });
}
function parsed(content: string): CompatibilityInput {
  return validateCompatibilityInput(JSON.parse(content.replace(/^\uFEFF/, '')));
}
function exported(experiment: CompatibilityExperiment, format: OutputFormat): string {
  if (format === 'json') return serializeAnalysisRecord(experiment.record) + '\n';
  if (format === 'sites') return exportCompatibilitySitesTsv(experiment);
  if (format === 'pairs') return exportCompatibilityPairsTsv(experiment);
  throw new Error('Unsupported compatibility output format.');
}

/** The numerical producer and replay remain in core; native isolation adds no
 * second interpretation of site eligibility, haplotypes or result identity. */
export async function executeCompatibilityJob(job: CompatibilityJob): Promise<CompatibilityJobResult> {
  if (!job || typeof job !== 'object' || !['prepare', 'inspect', 'analyze', 'replay'].includes(job.operation)) throw new Error('Invalid compatibility job.');
  text(job.content, job.operation === 'replay' ? COMPATIBILITY_LIMITS.recordBytes : COMPATIBILITY_LIMITS.inputBytes, 'Compatibility input');
  const allowed = job.operation === 'prepare' ? ['operation', 'content', 'metadata'] : job.operation === 'inspect'
    ? ['operation', 'content'] : job.operation === 'analyze' ? ['operation', 'content', 'options', 'format'] : ['operation', 'content', 'format'];
  if (Object.keys(job).some(key => !allowed.includes(key))) throw new Error('Unsupported compatibility job fields; replay cannot override input or interval.');
  let content: string, recordJson: string | null = null;
  if (job.operation === 'prepare') {
    const input = prepared(job); inspect(input);
    // Compact output obeys the same byte limit as the accepted input envelope.
    content = JSON.stringify(input) + '\n';
    text(content, COMPATIBILITY_LIMITS.inputBytes, 'Prepared compatibility input');
  } else if (job.operation === 'inspect') content = JSON.stringify(inspect(parsed(job.content)), null, 2) + '\n';
  else {
    if (!['json', 'sites', 'pairs'].includes(job.format)) throw new Error('Unsupported compatibility output format.');
    const experiment = job.operation === 'replay' ? await replayCompatibilityExperiment(job.content)
      : await createCompatibilityExperiment(parsed(job.content), job.options);
    recordJson = serializeAnalysisRecord(experiment.record);
    content = exported(experiment, job.format);
  }
  text(content, COMPATIBILITY_LIMITS.recordBytes, 'Complete compatibility export');
  return { operation: job.operation, requestSha256: requestDigest(job), content, recordJson, verified: job.operation === 'replay' };
}

/** Bind the worker's accepted evidence to the exact requested input, interval
 * and export. Identity checks do not claim independent numerical validation. */
async function checkedResult(job: CompatibilityJob, value: CompatibilityJobResult): Promise<string> {
  if (!value || value.operation !== job.operation || value.requestSha256 !== requestDigest(job)
    || value.verified !== (job.operation === 'replay')) throw new Error('Unbound compatibility worker response.');
  text(value.content, COMPATIBILITY_LIMITS.recordBytes, 'Compatibility worker output');
  if (job.operation === 'prepare' || job.operation === 'inspect') {
    if (value.recordJson !== null) throw new Error('Preparation and inspection must not report a calculated result.');
    const expected = job.operation === 'prepare' ? prepared(job) : inspect(parsed(job.content));
    if (!same(JSON.parse(value.content), expected)) throw new Error('Worker returned a different compatibility input or inspection.');
    return value.content;
  }
  text(value.recordJson, COMPATIBILITY_LIMITS.recordBytes, 'Compatibility evidence');
  const record = await parseAnalysisRecord(value.recordJson, { methodId: COMPATIBILITY_METHOD.id, methodVersion: COMPATIBILITY_METHOD.version });
  if (!same(record.method, COMPATIBILITY_METHOD) || record.seed !== null || record.inputs.length !== 1 || record.inputs[0].id !== 'alignment'
    || Object.keys(record.fields).join('|') !== 'compatibility') throw new Error('Unexpected compatibility method or evidence.');
  const input = validateCompatibilityInput(record.inputs[0].data), columns = inspect(input).columns;
  const options = resolveCompatibilityOptions(record.parameters, columns);
  if (job.operation === 'replay') {
    const saved = await parseAnalysisRecord(job.content.replace(/^\uFEFF/, ''));
    if (serializeAnalysisRecord(saved) !== serializeAnalysisRecord(record)) throw new Error('Compatibility worker returned a different saved experiment.');
  } else if (!same(parsed(job.content), input) || !same(resolveCompatibilityOptions(job.options, columns), options)) {
    throw new Error('Compatibility worker returned a different alignment or interval.');
  }
  const result = record.fields.compatibility.value as unknown as CompatibilityExperiment['result'];
  const experiment = validateCompatibilityExperiment({ input, options, result, record });
  if (value.content !== exported(experiment, job.format)) throw new Error('Compatibility export differs from its accepted evidence.');
  return value.content;
}

declare const PHAGE_ALIGNMENT_COMPATIBILITY_WORKER: string | undefined;
export function runCompatibilityJob(job: CompatibilityJob, signal?: AbortSignal): Promise<CompatibilityJobResult> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((yes, no) => {
    const url = typeof PHAGE_ALIGNMENT_COMPATIBILITY_WORKER === 'string'
      ? new URL(PHAGE_ALIGNMENT_COMPATIBILITY_WORKER, import.meta.url)
      : new URL('../workers/alignment-compatibility-worker.ts', import.meta.url);
    const worker = new Worker(url);
    let settled = false;
    const finish = (cause?: Error, value?: CompatibilityJobResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (cause) no(cause); else yes(value!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Aligned-site worker exceeded two minutes; choose a smaller alignment interval.')), TIMEOUT_MS);
    worker.on('message', (message: CompatibilityJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message?.kind === 'result') finish(undefined, message.result);
      else if (message?.kind === 'error' && typeof message.message === 'string') finish(new Error(message.message));
      else finish(new Error('Unexpected compatibility worker response.'));
    });
    worker.on('error', cause => finish(cause instanceof Error ? cause : new Error(String(cause))));
    worker.on('exit', code => finish(new Error(`Compatibility worker exited before returning a result (code ${code}).`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

async function newOutput(path: string): Promise<void> {
  try { await lstat(path); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
export async function runCompatibilityCommand(args: string[], io: CompatibilityIO): Promise<number> {
  let command: CompatibilityCommand | null;
  try { command = parseCompatibilityCommand(args); }
  catch (cause) { await writeStream(io.stderr, `Alignment compatibility: ${plain(cause)}\n`, io.signal).catch(() => {}); return io.signal?.aborted ? 130 : 2; }
  try {
    check(io.signal);
    if (!command) { await writeStream(io.stdout, ALIGNMENT_COMPATIBILITY_HELP, io.signal); check(io.signal); return 0; }
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await newOutput(destination);
    await writeStream(io.stderr, 'Alignment compatibility: reading local input\n', io.signal);
    const maximum = command.operation === 'replay' ? COMPATIBILITY_LIMITS.recordBytes : COMPATIBILITY_LIMITS.inputBytes;
    const content = command.input === '-' ? await readAbundanceStdin(io.stdin, maximum, io.signal)
      : await readAbundanceFile(command.input, maximum, io.signal);
    check(io.signal);
    const job: CompatibilityJob = command.operation === 'prepare' ? { operation: 'prepare', content, metadata: command.metadata }
      : command.operation === 'inspect' ? { operation: 'inspect', content }
      : command.operation === 'analyze' ? { operation: 'analyze', content, ...(command.options ? { options: command.options } : {}), format: command.format }
      : { operation: 'replay', content, format: command.format };
    await writeStream(io.stderr, `Alignment compatibility: ${command.operation === 'replay' ? 'recomputing saved evidence' : command.operation === 'analyze' ? 'counting exact site-pair evidence' : 'validating the declared alignment'}\n`, io.signal);
    const result = await (io.execute ?? runCompatibilityJob)(job, io.signal);
    check(io.signal);
    const output = await checkedResult(job, result); check(io.signal);
    if (destination) await writeFile(destination, output, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: io.signal });
    else await writeStream(io.stdout, output, io.signal);
    check(io.signal); return 0;
  } catch (cause) {
    await writeStream(io.stderr, `Alignment compatibility: ${plain(cause)}\n`, io.signal).catch(() => {});
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}
export async function runCompatibilityProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort(), terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runCompatibilityCommand(args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause(); }
  if (controller.signal.aborted) process.exit(terminated ? 143 : 130);
}
