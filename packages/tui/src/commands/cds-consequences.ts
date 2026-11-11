/** Database-free exact GenBank-backed coding consequences for supplied aligned DNA haplotypes. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Readable, Writable } from 'node:stream';
import {
  CDS_CONSEQUENCE_LIMITS, validateCdsAlignment, createCdsConsequenceExperiment,
  replayCdsConsequenceExperiment, parseCdsGeneIds, exportCdsConsequenceTable,
  exportCdsConsequenceFasta, type CdsAlignment, type CdsConsequenceOptions,
} from '../../../core/src/analysis/cds-consequences';
import { GENOME_IMPORT_LIMITS, type GenomeInput } from '../../../core/src/genome-import';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;

export const CDS_CONSEQUENCES_HELP = `Aligned haplotype → annotated CDS consequences (local files only)

  phage-explorer cds-consequences prepare ALIGNMENT_FASTA --name NAME
    [--demo] [--output NEW_FILE]

  phage-explorer cds-consequences inspect ALIGNMENT_JSON

  phage-explorer cds-consequences analyze ALIGNMENT_JSON
    --genbank REFERENCE_GB --reference ID --terminal-gaps missing|alleles
    [--annotation-record ACCESSION_OR_CONTENT_ID] [--genes 1,2,3]
    [--format json|table|cds-fasta|protein-fasta] [--output NEW_FILE]

  phage-explorer cds-consequences replay SAVED_ANALYSIS
    [--format json|table|cds-fasta|protein-fasta] [--output NEW_FILE]

prepare only validates/canonicalizes an already-aligned DNA FASTA. Its first
whitespace-delimited header token is the sequence ID; the rest is a description.
Alignment equality or sequence names do NOT prove homology; all consequences
remain conditional on the supplied alignment.

analyze requires one exact GenBank record whose bases match the ungapped aligned
reference. Accession equality is insufficient. --annotation-record disambiguates
multi-record files by accession or imported content ID. --terminal-gaps is explicit:
missing treats uncovered terminal query gaps as missing evidence; alleles treats
them as deletion alleles. --genes blank is not accepted here; omit it for all CDS.

The method evaluates the complete query haplotype in each reference CDS, including
joined/complement locations, codon_start and supported genetic codes. It reports
frameshift/frame-restoration, in-frame indels, synonymous/amino-acid changes and
stop/start consequences while preserving unsupported annotations as unavailable.

These are alignment-conditional sequence consequences, NOT isolated-variant
attribution, gene-function, phenotype, pathogenicity, fitness or host-range predictions.
Replay reparses the original embedded GenBank bytes and recomputes the full result.
`;

export type CdsConsequencesOperation = 'prepare' | 'inspect' | 'analyze' | 'replay';
export type CdsConsequencesFormat = 'json' | 'table' | 'cds-fasta' | 'protein-fasta';
export interface CdsConsequencesCommand {
  operation: CdsConsequencesOperation;
  input: string;
  output?: string;
  name?: string;
  demo: boolean;
  genbank?: string;
  referenceId?: string;
  terminalGaps?: 'missing' | 'alleles';
  annotationRecord?: string;
  geneIds?: number[] | null;
  format: CdsConsequencesFormat;
}
export interface CdsConsequencesJob {
  operation: 'analyze' | 'replay';
  input: { name: string; text: string };
  annotation?: GenomeInput;
  options?: CdsConsequenceOptions;
  format: CdsConsequencesFormat;
}
export interface CdsConsequencesJobResult {
  output: string;
  identity: string;
  verified: boolean;
}
export type CdsConsequencesJobMessage =
  | { kind: 'progress'; message: string }
  | { kind: 'result'; result: CdsConsequencesJobResult }
  | { kind: 'error'; message: string };
export interface CdsConsequencesIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
  execute?: typeof runCdsConsequencesJob;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('CDS consequence operation cancelled.', 'AbortError');
}
function formatExperiment(experiment: Awaited<ReturnType<typeof createCdsConsequenceExperiment>>,
  format: CdsConsequencesFormat): string {
  if (format === 'json') return serializeAnalysisRecord(experiment.record) + '\n';
  if (format === 'table') return exportCdsConsequenceTable(experiment);
  return exportCdsConsequenceFasta(experiment, format === 'cds-fasta' ? 'cds' : 'protein');
}
export async function executeCdsConsequencesJob(job: CdsConsequencesJob,
  progress: (message: string) => void = () => {}): Promise<CdsConsequencesJobResult> {
  if (!job || !['analyze', 'replay'].includes(job.operation) || !job.input || typeof job.input.text !== 'string'
    || !['json', 'table', 'cds-fasta', 'protein-fasta'].includes(job.format)) {
    throw new Error('Unsupported CDS consequence job.');
  }
  const bytes = new TextEncoder().encode(job.input.text).length;
  if (bytes > (job.operation === 'replay' ? RECORD_LIMIT : GENOME_IMPORT_LIMITS.bytes)) {
    throw new Error(job.operation === 'replay' ? 'Saved CDS evidence exceeds 10 MiB.' : 'CDS alignment JSON exceeds 10 MiB.');
  }
  let experiment, verified = false;
  if (job.operation === 'replay') {
    if (job.annotation !== undefined || job.options !== undefined) throw new Error('Replay cannot override saved annotation or CDS settings.');
    progress('Reparsing embedded GenBank and recomputing whole-haplotype CDS consequences');
    experiment = await replayCdsConsequenceExperiment(job.input.text.replace(/^\uFEFF/, ''));
    verified = true;
  } else {
    if (!job.annotation || !job.options) throw new Error('CDS analysis requires exact GenBank annotation and explicit settings.');
    if (new TextEncoder().encode(job.annotation.text).length > GENOME_IMPORT_LIMITS.bytes) throw new Error('GenBank annotation exceeds 10 MiB.');
    progress('Validating aligned DNA and exact sequence-matched GenBank annotation');
    const alignment = validateCdsAlignment(JSON.parse(job.input.text.replace(/^\uFEFF/, '')));
    progress('Projecting complete query haplotypes through mapped reference CDS annotations');
    experiment = await createCdsConsequenceExperiment(alignment, job.annotation, job.options);
  }
  return { output: formatExperiment(experiment, job.format), identity: experiment.record.resultId, verified };
}

declare const PHAGE_CDS_CONSEQUENCES_WORKER: string | undefined;
export function runCdsConsequencesJob(job: CdsConsequencesJob, signal?: AbortSignal,
  progress: (message: string) => void = () => {}): Promise<CdsConsequencesJobResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('CDS consequence operation cancelled.', 'AbortError'));
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const url = typeof PHAGE_CDS_CONSEQUENCES_WORKER === 'string'
      ? new URL(PHAGE_CDS_CONSEQUENCES_WORKER, import.meta.url)
      : new URL('../workers/cds-consequences-worker.ts', import.meta.url);
    const worker = new Worker(url);
    const finish = (result?: CdsConsequencesJobResult, error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolveResult(result!);
    };
    const abort = () => finish(undefined, new DOMException('CDS consequence operation cancelled.', 'AbortError'));
    worker.on('message', (message: CdsConsequencesJobMessage) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      if (message.kind === 'progress') {
        try { progress(message.message); } catch (cause) {
          finish(undefined, cause instanceof Error ? cause : new Error(String(cause)));
        }
      } else if (message.kind === 'result') finish(message.result);
      else finish(undefined, new Error(message.kind === 'error' ? message.message : 'Invalid CDS consequence worker response.'));
    });
    worker.on('error', cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
    worker.on('exit', code => finish(undefined, new Error('CDS consequence worker exited before returning a result (code ' + code + ').')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(job); } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

function parseAlignedFasta(content: string, name: string, source: CdsAlignment['source']): CdsAlignment {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > GENOME_IMPORT_LIMITS.bytes) {
    throw new Error('Aligned FASTA exceeds 10 MiB.');
  }
  const sequences: CdsAlignment['sequences'] = [];
  let row: CdsAlignment['sequences'][number] | null = null;
  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      if (row) sequences.push(row);
      const header = line.slice(1).trim(), split = header.search(/\s/);
      const id = split < 0 ? header : header.slice(0, split);
      const description = split < 0 ? '' : header.slice(split).trim();
      if (!id) throw new Error('Aligned FASTA headers require a nonempty first-token sequence ID.');
      row = { id, description, sequence: '' };
    } else {
      if (!row) throw new Error('Aligned FASTA must begin with a header.');
      row.sequence += line;
    }
  }
  if (row) sequences.push(row);
  return validateCdsAlignment({ name, source, sequences });
}

export function parseCdsConsequencesCommand(args: string[]): CdsConsequencesCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    output: { type: 'string' }, name: { type: 'string' }, demo: { type: 'boolean', default: false },
    genbank: { type: 'string' }, reference: { type: 'string' }, 'terminal-gaps': { type: 'string' },
    'annotation-record': { type: 'string' }, genes: { type: 'string' }, format: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['prepare', 'inspect', 'analyze', 'replay'].includes(operation)) {
    throw new Error('Expected cds-consequences prepare|inspect|analyze|replay INPUT.');
  }
  if (!input.trim() || [values.output, values.name, values.genbank, values.reference, values['terminal-gaps'],
    values['annotation-record'], values.genes, values.format].some(value => value !== undefined && !value.trim())) {
    throw new Error('CDS consequence paths, IDs and options must not be empty.');
  }
  const format = values.format ?? 'json';
  if (!['json', 'table', 'cds-fasta', 'protein-fasta'].includes(format)) {
    throw new Error('--format must be json, table, cds-fasta or protein-fasta.');
  }
  const importFlags = values.name !== undefined || values.demo;
  const analysisFlags = values.genbank !== undefined || values.reference !== undefined || values['terminal-gaps'] !== undefined
    || values['annotation-record'] !== undefined || values.genes !== undefined;
  if (operation === 'prepare') {
    if (values.name === undefined) throw new Error('prepare requires --name.');
    if (analysisFlags || format !== 'json') throw new Error('prepare only canonicalizes aligned FASTA; analysis settings and derived exports require analyze.');
    return { operation, input, output: values.output === '-' ? undefined : values.output, name: values.name,
      demo: values.demo, format: 'json' };
  }
  if (importFlags) throw new Error('inspect/analyze/replay use canonical alignment provenance and cannot relabel it.');
  if (operation === 'inspect') {
    if (analysisFlags || format !== 'json') throw new Error('inspect validates canonical alignment JSON without annotation/settings.');
    return { operation, input, output: values.output === '-' ? undefined : values.output, demo: false, format: 'json' };
  }
  if (operation === 'replay') {
    if (analysisFlags) throw new Error('Replay cannot override saved GenBank annotation or CDS settings.');
    return { operation, input, output: values.output === '-' ? undefined : values.output, demo: false,
      format: format as CdsConsequencesFormat };
  }
  if (values.genbank === undefined || values.reference === undefined || values['terminal-gaps'] === undefined) {
    throw new Error('analyze requires --genbank, --reference and --terminal-gaps.');
  }
  if (values['terminal-gaps'] !== 'missing' && values['terminal-gaps'] !== 'alleles') {
    throw new Error('--terminal-gaps must be missing or alleles.');
  }
  if ([input, values.genbank].filter(value => value === '-').length > 1) throw new Error('Only one CDS consequence input may read from stdin (-).');
  return { operation, input, output: values.output === '-' ? undefined : values.output, demo: false,
    genbank: values.genbank, referenceId: values.reference, terminalGaps: values['terminal-gaps'],
    annotationRecord: values['annotation-record'], geneIds: values.genes === undefined ? null : parseCdsGeneIds(values.genes),
    format: format as CdsConsequencesFormat };
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
async function assertNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
function clean(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export async function runCdsConsequencesCommand(args: string[], io: CdsConsequencesIO): Promise<number> {
  let command: CdsConsequencesCommand | null;
  try { command = parseCdsConsequencesCommand(args); }
  catch (cause) { await writeStream(io.stderr, 'CDS consequences: ' + clean(cause) + '\n'); return 2; }
  if (!command) { await writeStream(io.stdout, CDS_CONSEQUENCES_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    const read = (filename: string, limit: number) => filename === '-'
      ? readAbundanceStdin(io.stdin, limit, io.signal) : readAbundanceFile(filename, limit, io.signal);
    let output: string;
    if (command.operation === 'prepare') {
      const fasta = await read(command.input, GENOME_IMPORT_LIMITS.bytes);
      output = JSON.stringify(parseAlignedFasta(fasta, command.name!, command.demo ? 'demo' : 'local'), null, 2) + '\n';
    } else if (command.operation === 'inspect') {
      const content = await read(command.input, GENOME_IMPORT_LIMITS.bytes);
      output = JSON.stringify(validateCdsAlignment(JSON.parse(content.replace(/^\uFEFF/, ''))), null, 2) + '\n';
    } else {
      const content = await read(command.input, command.operation === 'replay' ? RECORD_LIMIT : GENOME_IMPORT_LIMITS.bytes);
      const annotation = command.operation === 'analyze'
        ? { name: command.genbank === '-' ? 'stdin annotation.gb' : basename(command.genbank!),
            text: await read(command.genbank!, GENOME_IMPORT_LIMITS.bytes) } : undefined;
      const options = command.operation === 'analyze' ? {
        referenceId: command.referenceId!, terminalGaps: command.terminalGaps!,
        annotationRecord: command.annotationRecord ?? null, geneIds: command.geneIds ?? null,
      } satisfies CdsConsequenceOptions : undefined;
      const progress = (message: string) => {
        void writeStream(io.stderr, JSON.stringify({ operation: command!.operation, phase: clean(message) }) + '\n').catch(() => {});
      };
      const result = await (io.execute ?? runCdsConsequencesJob)({
        operation: command.operation, input: { name: basename(command.input), text: content },
        annotation, options, format: command.format,
      }, io.signal, progress);
      output = result.output;
    }
    check(io.signal);
    if (destination) await writeFile(destination, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    else await writeStream(io.stdout, output);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr, 'CDS consequences: ' + clean(cause) + '\n');
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

export async function runCdsConsequencesProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runCdsConsequencesCommand(args, {
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
    });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause();
  }
}
