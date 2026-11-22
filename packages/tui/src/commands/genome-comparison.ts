/** Complete portable genome comparisons using the same producer as the browser. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import { importLocalGenomes, GENOME_IMPORT_LIMITS, type GenomeInput } from '../../../core/src/genome-import';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import {
  createGenomeComparisonExperiment, replayGenomeComparisonExperiment,
  resolveGenomeComparisonOptions, GENOME_COMPARISON_METHOD, type ComparisonGenomeInput,
} from '@phage-explorer/comparison';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;
const PARAMETER_LIMIT = 64 * 1024;
const WORKER_TIMEOUT_MS = 120_000;

export const GENOME_COMPARISON_HELP = `Portable genome comparison (local files; no catalog required)

  phage-explorer comparison run GENOME_A GENOME_B [--params FILE]
  phage-explorer comparison replay SAVED_ANALYSIS

  --output NEW_FILE     otherwise write the complete analysis JSON to stdout
  -                     read one input or parameter file from stdin

Each genome file must contain one accepted DNA genome: FASTA, GenBank or a local
genome bundle, up to 1 million bases and 20,000 annotations. The complete portable
record must fit within 10 MiB. GenBank annotations are retained; FASTA does not acquire
inferred genes. The comparison uses the same complete sequences, annotations and
method as the browser. Its frame-zero sequence composition is not CDS translation
or evidence of expression, and resemblance does not establish homology or function.

--params accepts kmerSizes, maxEditDistanceLength, editDistanceWindowSize and
editDistanceWindowCount. Exact sequence diff has a separate bounded algorithm;
an unavailable diff does not invalidate the other descriptive metrics.

The portable record embeds both accepted genomes, parameters, complete results
and content fingerprints. replay recomputes all evidence and rejects differences;
it cannot override saved parameters. Existing files are never overwritten.
Progress/errors go to stderr. Ctrl-C cancels; an interrupted output write can leave
a partial new file. No input is uploaded.
`;

export type GenomeComparisonCommand =
  | { operation: 'run'; inputA: string; inputB: string; parameters?: string; output?: string }
  | { operation: 'replay'; input: string; output?: string };
export type GenomeComparisonJob =
  | { operation: 'run'; genomeA: GenomeInput; genomeB: GenomeInput; parameters?: string }
  | { operation: 'replay'; content: string };
export type GenomeComparisonJobMessage =
  | { kind: 'experiment'; ok: true; content: string }
  | { kind: 'experiment'; ok: false; error: string };
export interface GenomeComparisonIO {
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  execute?: typeof runGenomeComparisonJob;
}

function cancelled(): DOMException { return new DOMException('Genome comparison cancelled.', 'AbortError'); }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }
function plain(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
function writeStream(stream: Writable, content: string): Promise<void> {
  return new Promise((yes, no) => {
    const fail = (cause: Error) => { stream.off('error', fail); no(cause); };
    stream.once('error', fail);
    stream.write(content, cause => {
      // A failed callback is followed by an error event; keep its listener alive.
      if (cause) { no(cause); return; }
      stream.off('error', fail); yes();
    });
  });
}
function requireText(value: unknown, limit: number, label: string): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) {
    throw new Error(`${label} exceeds its supported byte limit.`);
  }
}

export function parseGenomeComparisonCommand(args: string[]): GenomeComparisonCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    params: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  if (positionals.some(value => !value.trim()) || [values.params, values.output].some(value => value !== undefined && !value.trim())) {
    throw new Error('Input and output paths must not be empty.');
  }
  const [operation, first, second] = positionals;
  const output = values.output === '-' ? undefined : values.output;
  if (operation === 'replay' && positionals.length === 2) {
    if (values.params !== undefined) throw new Error('Replay cannot override saved comparison parameters.');
    return { operation, input: first, output };
  }
  if (operation !== 'run' || positionals.length !== 3) {
    throw new Error('Expected comparison run GENOME_A GENOME_B or comparison replay SAVED_ANALYSIS.');
  }
  if ([first, second, values.params].filter(value => value === '-').length > 1) {
    throw new Error('Only one input may read from stdin (-).');
  }
  return { operation, inputA: first, inputB: second, parameters: values.params, output };
}

async function importedGenome(input: GenomeInput, label: string): Promise<ComparisonGenomeInput> {
  if (!input || typeof input.name !== 'string') throw new Error(`${label} requires a named genome input.`);
  requireText(input.text, GENOME_IMPORT_LIMITS.bytes, label);
  const imported = await importLocalGenomes(input);
  if (imported.genomes.length !== 1) throw new Error(`${label} must contain exactly one accepted genome.`);
  const { phage, sequence } = imported.genomes[0];
  return { phage: { id: phage.id, name: phage.name, accession: phage.accession },
    source: 'local', sequence, genes: phage.genes, codonUsage: null };
}

/** Runs inside the existing native comparison worker, away from terminal input. */
export async function executeGenomeComparisonJob(job: GenomeComparisonJob): Promise<string> {
  if (!job || typeof job !== 'object') throw new Error('Invalid genome comparison job.');
  let experiment;
  if (job.operation === 'replay') {
    requireText(job.content, RECORD_LIMIT, 'Saved comparison');
    if ('parameters' in job) throw new Error('Replay cannot override saved comparison parameters.');
    experiment = await replayGenomeComparisonExperiment(job.content.replace(/^\uFEFF/, ''));
  } else if (job.operation === 'run') {
    let parameters: unknown;
    if (job.parameters !== undefined) {
      requireText(job.parameters, PARAMETER_LIMIT, 'Comparison parameters');
      parameters = JSON.parse(job.parameters.replace(/^\uFEFF/, ''));
    }
    const options = resolveGenomeComparisonOptions(parameters);
    const genomeA = await importedGenome(job.genomeA, 'Genome A');
    const genomeB = await importedGenome(job.genomeB, 'Genome B');
    experiment = await createGenomeComparisonExperiment(genomeA, genomeB, options);
  } else throw new Error('Unsupported genome comparison operation.');
  const content = serializeAnalysisRecord(experiment.record) + '\n';
  requireText(content, RECORD_LIMIT, 'Complete comparison export');
  return content;
}

declare const PHAGE_COMPARISON_WORKER: string | undefined;
export function runGenomeComparisonJob(job: GenomeComparisonJob, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((yes, no) => {
    const url = typeof PHAGE_COMPARISON_WORKER === 'string'
      ? new URL(PHAGE_COMPARISON_WORKER, import.meta.url)
      : new URL('../workers/comparison-worker.ts', import.meta.url);
    const worker = new Worker(url);
    let settled = false;
    const finish = (error?: Error, content?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (error) no(error); else yes(content!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Genome comparison exceeded two minutes; use smaller inputs or less costly parameters.')), WORKER_TIMEOUT_MS);
    worker.on('message', (message: GenomeComparisonJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (!message || message.kind !== 'experiment' || typeof message.ok !== 'boolean') {
        finish(new Error('Unexpected comparison worker response.')); return;
      }
      if (!message.ok) { finish(new Error(typeof message.error === 'string' ? message.error : 'Comparison failed.')); return; }
      try { requireText(message.content, RECORD_LIMIT, 'Comparison worker output'); finish(undefined, message.content); }
      catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    });
    worker.on('error', cause => finish(cause instanceof Error ? cause : new Error(String(cause))));
    worker.on('exit', code => finish(new Error(`Comparison worker exited before returning evidence (code ${code}).`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

async function assertNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
export async function runGenomeComparisonCommand(args: string[], io: GenomeComparisonIO): Promise<number> {
  let command: GenomeComparisonCommand | null;
  try { command = parseGenomeComparisonCommand(args); }
  catch (cause) { await writeStream(io.stderr, `Comparison: ${plain(cause)}\n`); return 2; }
  if (!command) { await writeStream(io.stdout, GENOME_COMPARISON_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    await writeStream(io.stderr, 'Comparison: reading inputs\n');
    const read = (path: string, limit: number) => path === '-'
      ? readAbundanceStdin(io.stdin, limit, io.signal) : readAbundanceFile(path, limit, io.signal);
    let job: GenomeComparisonJob;
    if (command.operation === 'replay') job = { operation: 'replay', content: await read(command.input, RECORD_LIMIT) };
    else job = { operation: 'run',
      genomeA: { name: command.inputA === '-' ? 'stdin-genome-a' : basename(command.inputA), text: await read(command.inputA, GENOME_IMPORT_LIMITS.bytes) },
      genomeB: { name: command.inputB === '-' ? 'stdin-genome-b' : basename(command.inputB), text: await read(command.inputB, GENOME_IMPORT_LIMITS.bytes) },
      parameters: command.parameters === undefined ? undefined : await read(command.parameters, PARAMETER_LIMIT) };
    check(io.signal);
    await writeStream(io.stderr, `Comparison: ${command.operation === 'replay' ? 'recomputing saved evidence' : 'computing complete evidence'}\n`);
    const content = await (io.execute ?? runGenomeComparisonJob)(job, io.signal);
    check(io.signal);
    requireText(content, RECORD_LIMIT, 'Comparison output');
    const record = await parseAnalysisRecord(content, {
      methodId: GENOME_COMPARISON_METHOD.id, methodVersion: GENOME_COMPARISON_METHOD.version,
    });
    if (record.method.implementation !== GENOME_COMPARISON_METHOD.implementation) throw new Error('Unexpected comparison implementation in worker output.');
    check(io.signal);
    if (destination) await writeFile(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: io.signal });
    else await writeStream(io.stdout, content);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr, `Comparison: ${plain(cause)}\n`);
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}
export async function runGenomeComparisonProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runGenomeComparisonCommand(args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause(); }
}
