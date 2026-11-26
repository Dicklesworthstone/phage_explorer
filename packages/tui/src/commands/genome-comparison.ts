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
  createRegionComparisonExperiment, replayRegionComparisonExperiment,
  exportRegionComparisonTsv, exportRegionComparisonFasta, REGION_COMPARISON_METHOD,
  type RegionComparisonOptions, type RegionComparisonExperiment, type RegionInterval,
} from '@phage-explorer/comparison';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;
const PARAMETER_LIMIT = 64 * 1024;
const WORKER_TIMEOUT_MS = 120_000;

export const GENOME_COMPARISON_HELP = `Portable genome comparison (local files; no catalog required)

  phage-explorer comparison inspect GENOME
  phage-explorer comparison run GENOME_A GENOME_B [--params FILE]
  phage-explorer comparison regions GENOME_A GENOME_B
    --region-a START:END --region-b START:END
    [--strand-a +|-] [--strand-b +|-]
    [--record-a ACCESSION_OR_CONTENT_ID] [--record-b ACCESSION_OR_CONTENT_ID]
  phage-explorer comparison replay SAVED_ANALYSIS

  --output NEW_FILE     otherwise write the complete analysis JSON to stdout
  --format json|tsv|fasta   regions/replay output (default json)
  -                     read one input or parameter file from stdin

run requires one accepted DNA genome per file: FASTA, GenBank or a local genome
bundle, up to 1 million bases and 20,000 annotations. The complete portable
record must fit within 10 MiB. GenBank annotations are retained; FASTA does not acquire
inferred genes. The comparison uses the same complete sequences, annotations and
method as the browser. Its frame-zero sequence composition is not CDS translation
or evidence of expression, and resemblance does not establish homology or function.

--params accepts kmerSizes, maxEditDistanceLength, editDistanceWindowSize and
editDistanceWindowCount. Exact sequence diff has a separate bounded algorithm;
an unavailable diff does not invalidate the other descriptive metrics.

regions compares explicit source intervals using the exact global unit-edit
aligner. CLI coordinates are one-based inclusive (1:100 selects bases 1–100).
Strands default to +; - reverse-complements the selected interval. No wrapping
intervals or automatic strand/origin guesses are accepted. Each selected interval
is limited to 250,000 bases; source imports support up to 5 million total bases
and 50,000 features, retaining the original source and annotations. The combined
portable record must still fit in 10 MiB. Alignment budget exhaustion produces
no partial result. An interval may be compared with another interval in the same
source; no external derivative FASTA or inferred homology is required.

inspect lists genome record content IDs, lengths and import warnings. A multi-record
input requires --record-a/--record-b; duplicate accessions need a full content ID.
The region JSON retains both original source files, exact selections and mapped
source coordinates. TSV includes every alignment run, including zero-width gap
boundaries; coordinates in JSON/TSV are zero-based half-open. FASTA exports both
complete aligned rows, with original source/range/strand identities. TSV/FASTA
formats apply only to region comparisons; JSON is needed for standalone replay.

The portable record embeds both accepted genomes, parameters, complete results
and content fingerprints. replay recomputes all evidence and rejects differences;
it cannot override saved parameters. Existing files are never overwritten.
Progress/errors go to stderr. Ctrl-C cancels; an interrupted output write can leave
a partial new file. No input is uploaded.
`;

export type GenomeComparisonFormat = 'json' | 'tsv' | 'fasta';
export type GenomeComparisonCommand =
  | { operation: 'inspect'; input: string; output?: string }
  | { operation: 'run'; inputA: string; inputB: string; parameters?: string; output?: string }
  | { operation: 'regions'; inputA: string; inputB: string; options: RegionComparisonOptions; format: GenomeComparisonFormat; output?: string }
  | { operation: 'replay'; input: string; output?: string; format: GenomeComparisonFormat };
export type GenomeComparisonJob =
  | { operation: 'inspect'; genome: GenomeInput }
  | { operation: 'run'; genomeA: GenomeInput; genomeB: GenomeInput; parameters?: string }
  | { operation: 'regions'; genomeA: GenomeInput; genomeB: GenomeInput; options: RegionComparisonOptions; format?: GenomeComparisonFormat }
  | { operation: 'replay'; content: string; format?: GenomeComparisonFormat };
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
function writeStream(stream: Writable, content: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((yes, no) => {
    let settled = false;
    const finish = (cause?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (cause) no(cause); else yes();
    };
    const abort = () => finish(cancelled());
    const fail = (cause: Error) => { stream.off('error', fail); finish(cause); };
    stream.once('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      stream.write(content, cause => {
        // Keep the error listener until an in-flight write completes or fails,
        // even when cancellation has already settled the command.
        if (cause) { finish(cause); return; }
        stream.off('error', fail); finish();
      });
    } catch (cause) {
      stream.off('error', fail);
      finish(cause instanceof Error ? cause : new Error(String(cause)));
    }
    if (signal?.aborted) abort();
  });
}
function requireText(value: unknown, limit: number, label: string): asserts value is string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) {
    throw new Error(`${label} exceeds its supported byte limit.`);
  }
}

export function parseGenomeComparisonCommand(args: string[]): GenomeComparisonCommand | null {
  const { values, positionals, tokens } = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
    params: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    format: { type: 'string' }, 'region-a': { type: 'string' }, 'region-b': { type: 'string' },
    'strand-a': { type: 'string' }, 'strand-b': { type: 'string' },
    'record-a': { type: 'string' }, 'record-b': { type: 'string' },
  } });
  if (values.help || args.length === 0) return null;
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Repeated option --${token.name}.`);
    seen.add(token.name);
  }
  if (positionals.some(value => !value.trim()) || Object.values(values).some(value => typeof value === 'string' && !value.trim())) {
    throw new Error('Input and output paths must not be empty.');
  }
  const [operation, first, second] = positionals;
  const output = values.output === '-' ? undefined : values.output;
  const format = values.format ?? 'json';
  if (!['json', 'tsv', 'fasta'].includes(format)) throw new Error('--format must be json, tsv or fasta.');
  const regionOptions = ['region-a', 'region-b', 'strand-a', 'strand-b', 'record-a', 'record-b'] as const;
  if (operation !== 'regions' && regionOptions.some(name => values[name] !== undefined)) {
    throw new Error('Region, strand and record selections apply only to regions; replay cannot override saved selections.');
  }
  if (operation === 'replay' && positionals.length === 2) {
    if (values.params !== undefined) throw new Error('Replay cannot override saved comparison parameters.');
    return { operation, input: first, output, format: format as GenomeComparisonFormat };
  }
  if (operation === 'inspect' && positionals.length === 2) {
    if (values.params !== undefined || format !== 'json') throw new Error('inspect accepts one genome source and returns record metadata as JSON.');
    return { operation, input: first, output };
  }
  if (operation === 'regions' && positionals.length === 3) {
    if (values.params !== undefined) throw new Error('regions uses explicit interval/strand selections; --params applies only to run.');
    if (first === '-' && second === '-') throw new Error('Only one input may read from stdin (-).');
    const interval = (side: 'a' | 'b'): RegionInterval => {
      const value = values[side === 'a' ? 'region-a' : 'region-b'];
      if (value === undefined || !/^[1-9]\d*:[1-9]\d*$/.test(value)) {
        throw new Error(`--region-${side} requires START:END in one-based inclusive coordinates.`);
      }
      const [start, end] = value.split(':').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        throw new Error(`--region-${side} requires safe integer coordinates with END >= START; wrapping regions are not accepted.`);
      }
      const strand = values[side === 'a' ? 'strand-a' : 'strand-b'] ?? '+';
      if (strand !== '+' && strand !== '-') throw new Error(`--strand-${side} must be + or -.`);
      return { start: start - 1, end, strand };
    };
    return { operation, inputA: first, inputB: second, output, format: format as GenomeComparisonFormat,
      options: { regionA: interval('a'), regionB: interval('b'), recordA: values['record-a'], recordB: values['record-b'] } };
  }
  if (operation !== 'run' || positionals.length !== 3) {
    throw new Error('Expected comparison inspect GENOME, run|regions GENOME_A GENOME_B, or replay SAVED_ANALYSIS.');
  }
  if (format !== 'json') throw new Error('Whole-genome run exports JSON; TSV/FASTA require regions or a saved region comparison.');
  if ([first, second, values.params].filter(value => value === '-').length > 1) {
    throw new Error('Only one input may read from stdin (-).');
  }
  return { operation, inputA: first, inputB: second, parameters: values.params, output };
}

function regionExport(experiment: RegionComparisonExperiment, format: GenomeComparisonFormat = 'json'): string {
  if (format === 'tsv') return exportRegionComparisonTsv(experiment);
  if (format === 'fasta') return exportRegionComparisonFasta(experiment);
  if (format !== 'json') throw new Error('Unsupported region comparison export format.');
  return serializeAnalysisRecord(experiment.record) + '\n';
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
  if (job.operation === 'inspect') {
    requireText(job.genome?.text, GENOME_IMPORT_LIMITS.bytes, 'Genome source');
    const imported = await importLocalGenomes(job.genome);
    return JSON.stringify({ records: imported.genomes.map(genome => ({
      name: genome.phage.name, accession: genome.phage.accession,
      contentId: genome.phage.localGenome!.contentId, sequenceSha256: genome.phage.localGenome!.sequenceSha256,
      genomeLength: genome.sequence.length, format: genome.phage.localGenome!.format,
      annotations: genome.phage.genes.length, warnings: genome.warnings,
    })) }, null, 2) + '\n';
  }
  if (job.operation === 'regions') {
    const region = await createRegionComparisonExperiment(job.genomeA, job.genomeB, job.options);
    const content = regionExport(region, job.format);
    requireText(content, RECORD_LIMIT, 'Complete region comparison export');
    return content;
  }
  if (job.operation === 'replay') {
    requireText(job.content, RECORD_LIMIT, 'Saved comparison');
    if ('parameters' in job || 'options' in job || 'genomeA' in job || 'genomeB' in job) throw new Error('Replay cannot override saved comparison parameters or sources.');
    const content = job.content.replace(/^\uFEFF/, '');
    const saved = await parseAnalysisRecord(content);
    if (saved.method.id === REGION_COMPARISON_METHOD.id) {
      const output = regionExport(await replayRegionComparisonExperiment(content), job.format);
      requireText(output, RECORD_LIMIT, 'Complete region comparison export');
      return output;
    }
    if (job.format !== undefined && job.format !== 'json') throw new Error('TSV/FASTA exports require a saved region comparison.');
    experiment = await replayGenomeComparisonExperiment(content);
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
  catch (cause) {
    await writeStream(io.stderr, `Comparison: ${plain(cause)}\n`, io.signal).catch(() => {});
    return io.signal?.aborted ? 130 : 2;
  }
  if (!command) {
    try { await writeStream(io.stdout, GENOME_COMPARISON_HELP, io.signal); check(io.signal); return 0; }
    catch (cause) {
      await writeStream(io.stderr, `Comparison: ${plain(cause)}\n`, io.signal).catch(() => {});
      return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
    }
  }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    await writeStream(io.stderr, 'Comparison: reading inputs\n', io.signal);
    const read = (path: string, limit: number) => path === '-'
      ? readAbundanceStdin(io.stdin, limit, io.signal) : readAbundanceFile(path, limit, io.signal);
    let job: GenomeComparisonJob;
    if (command.operation === 'replay') job = { operation: 'replay', content: await read(command.input, RECORD_LIMIT), format: command.format };
    else if (command.operation === 'inspect') job = { operation: 'inspect',
      genome: { name: command.input === '-' ? 'stdin-genome' : basename(command.input), text: await read(command.input, GENOME_IMPORT_LIMITS.bytes) } };
    else if (command.operation === 'regions') job = { operation: 'regions',
      genomeA: { name: command.inputA === '-' ? 'stdin-genome-a' : basename(command.inputA), text: await read(command.inputA, GENOME_IMPORT_LIMITS.bytes) },
      genomeB: { name: command.inputB === '-' ? 'stdin-genome-b' : basename(command.inputB), text: await read(command.inputB, GENOME_IMPORT_LIMITS.bytes) },
      options: command.options, format: command.format };
    else job = { operation: 'run',
      genomeA: { name: command.inputA === '-' ? 'stdin-genome-a' : basename(command.inputA), text: await read(command.inputA, GENOME_IMPORT_LIMITS.bytes) },
      genomeB: { name: command.inputB === '-' ? 'stdin-genome-b' : basename(command.inputB), text: await read(command.inputB, GENOME_IMPORT_LIMITS.bytes) },
      parameters: command.parameters === undefined ? undefined : await read(command.parameters, PARAMETER_LIMIT) };
    check(io.signal);
    await writeStream(io.stderr, `Comparison: ${command.operation === 'replay' ? 'recomputing saved evidence' : 'computing complete evidence'}\n`, io.signal);
    const content = await (io.execute ?? runGenomeComparisonJob)(job, io.signal);
    check(io.signal);
    requireText(content, RECORD_LIMIT, 'Comparison output');
    const format = 'format' in command ? command.format : 'json';
    if (command.operation !== 'inspect' && format === 'json') {
      const record = await parseAnalysisRecord(content);
      const method = record.method.id === REGION_COMPARISON_METHOD.id ? REGION_COMPARISON_METHOD : GENOME_COMPARISON_METHOD;
      if (record.method.id !== method.id || record.method.version !== method.version || record.method.implementation !== method.implementation ||
          (command.operation === 'run' && method !== GENOME_COMPARISON_METHOD) || (command.operation === 'regions' && method !== REGION_COMPARISON_METHOD)) {
        throw new Error('Unexpected comparison method or implementation in worker output.');
      }
    }
    check(io.signal);
    if (destination) await writeFile(destination, content, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: io.signal });
    else await writeStream(io.stdout, content, io.signal);
    check(io.signal);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr, `Comparison: ${plain(cause)}\n`, io.signal).catch(() => {});
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
  // An outstanding pipe write can keep the event loop alive after cancellation.
  // Only the process entry point owns shutdown; injected command streams stay open.
  if (controller.signal.aborted) process.exit(terminated ? 143 : 130);
}
