/** Database-free inspection, analysis and replay for user-supplied aligned protein FASTA. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import {
  parseProteinAlignmentFasta, validateProteinAlignmentInput, PROTEIN_ALIGNMENT_LIMITS,
  type ProteinAlignmentInput,
} from '../../../core/src/protein-reference';
import {
  createProteinAlignmentExperiment, replayProteinAlignmentExperiment, exportProteinAlignmentTsv,
} from '../../../core/src/analysis/tail-fiber-structure';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

const RECORD_LIMIT = 10 * 1024 * 1024;

export const PROTEIN_ALIGNMENT_HELP = `Protein alignment evidence (local files only; no catalog or network required)

  phage-explorer protein-alignment inspect INPUT [--name NAME] [--source TEXT] [--reference TEXT] [--demo]
  phage-explorer protein-alignment analyze INPUT [--target RECORD_ID] [--name NAME] [--source TEXT] [--reference TEXT] [--demo]
  phage-explorer protein-alignment replay SAVED_ANALYSIS

Common options:
  --format json|tsv    analyze/replay output format (default json)
  --output NEW_FILE    write a new file instead of stdout; existing files are never replaced
  -                    read INPUT from stdin

INPUT for inspect/analyze is either already-aligned protein FASTA or a canonical
phage-explorer-protein-alignment JSON document. FASTA requires 2-256 records
already aligned to equal column count. X/B/Z/J are unknown residues; - is a gap.
Source flags apply only while importing FASTA. Canonical JSON retains its embedded
source attribution and cannot be relabeled by command options.

analyze computes per-target-position observed amino-acid counts and entropy using
the same producer as the browser. replay recomputes a saved experiment and rejects
changed inputs, parameters or results. TSV contains every ungapped target residue.
No structure, binding affinity, host range or genomic CDS mapping is inferred.
`;

export type ProteinAlignmentOperation = 'inspect' | 'analyze' | 'replay';
export interface ProteinAlignmentCommand {
  operation: ProteinAlignmentOperation;
  input: string;
  output?: string;
  format: 'json' | 'tsv';
  target?: string;
  name?: string;
  source?: string;
  reference?: string;
  demo: boolean;
}
export interface ProteinAlignmentCommandIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Protein alignment operation cancelled.', 'AbortError');
}
function writeStream(stream: Writable, content: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const fail = (error: Error) => { stream.off('error', fail); reject(error); };
    stream.once('error', fail);
    stream.write(content, error => {
      if (error) { reject(error); return; }
      stream.off('error', fail);
      resolveWrite();
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
function cleanError(cause: unknown): string {
  return stripVTControlCharacters(cause instanceof Error ? cause.message : String(cause))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
function hasSourceOverrides(command: ProteinAlignmentCommand): boolean {
  return command.name !== undefined || command.source !== undefined || command.reference !== undefined || command.demo;
}

export function parseProteinAlignmentCommand(args: string[]): ProteinAlignmentCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    output: { type: 'string' }, format: { type: 'string' }, target: { type: 'string' },
    name: { type: 'string' }, source: { type: 'string' }, reference: { type: 'string' },
    demo: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['inspect', 'analyze', 'replay'].includes(operation)) {
    throw new Error('Expected protein-alignment inspect|analyze|replay INPUT. See protein-alignment --help.');
  }
  if (!input.trim() || [values.output, values.target, values.name, values.source, values.reference]
    .some(value => value !== undefined && !value.trim())) throw new Error('File paths, names and identifiers must not be empty.');
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'tsv') throw new Error('--format must be json or tsv.');
  if (operation === 'inspect' && format !== 'json') throw new Error('inspect emits canonical alignment JSON; --format tsv requires analyze or replay.');
  if (operation === 'inspect' && values.target !== undefined) throw new Error('--target requires analyze.');
  if (operation === 'replay' && (values.target !== undefined || values.name !== undefined || values.source !== undefined
    || values.reference !== undefined || values.demo)) throw new Error('Replay cannot override saved target or source attribution.');
  return { operation: operation as ProteinAlignmentOperation, input, format, target: values.target,
    name: values.name, source: values.source, reference: values.reference, demo: values.demo,
    output: values.output === '-' ? undefined : values.output };
}

function parseInput(content: string, command: ProteinAlignmentCommand): ProteinAlignmentInput {
  const text = content.replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('{')) {
    if (hasSourceOverrides(command)) throw new Error('Canonical alignment JSON retains embedded attribution; source flags apply only to FASTA import.');
    return validateProteinAlignmentInput(JSON.parse(text));
  }
  const fallbackName = command.input === '-' ? 'stdin protein alignment' : basename(command.input);
  const name = command.name ?? fallbackName;
  return parseProteinAlignmentFasta(text, name, {
    kind: command.demo ? 'demo' : 'local',
    description: command.source ?? name,
    reference: command.reference ?? null,
  });
}

export async function runProteinAlignmentCommand(args: string[], io: ProteinAlignmentCommandIO): Promise<number> {
  let command: ProteinAlignmentCommand | null;
  try { command = parseProteinAlignmentCommand(args); }
  catch (cause) { await writeStream(io.stderr, 'Protein alignment: ' + cleanError(cause) + '\n'); return 2; }
  if (!command) { await writeStream(io.stdout, PROTEIN_ALIGNMENT_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    const limit = command.operation === 'replay' ? RECORD_LIMIT : PROTEIN_ALIGNMENT_LIMITS.bytes;
    const content = command.input === '-'
      ? await readAbundanceStdin(io.stdin, limit, io.signal)
      : await readAbundanceFile(command.input, limit, io.signal);
    check(io.signal);

    let output: string;
    if (command.operation === 'replay') {
      const experiment = await replayProteinAlignmentExperiment(content.replace(/^\uFEFF/, ''), io.signal);
      check(io.signal);
      output = command.format === 'tsv' ? exportProteinAlignmentTsv(experiment.record) : serializeAnalysisRecord(experiment.record) + '\n';
    } else {
      const input = parseInput(content, command);
      if (command.operation === 'inspect') output = JSON.stringify(input, null, 2) + '\n';
      else {
        const experiment = await createProteinAlignmentExperiment(input,
          command.target === undefined ? {} : { proteinId: command.target }, io.signal);
        check(io.signal);
        output = command.format === 'tsv' ? exportProteinAlignmentTsv(experiment.record) : serializeAnalysisRecord(experiment.record) + '\n';
      }
    }
    check(io.signal);
    if (destination) await writeFile(destination, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    else await writeStream(io.stdout, output);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr, 'Protein alignment: ' + cleanError(cause) + '\n');
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

export async function runProteinAlignmentProcess(args: string[]): Promise<void> {
  const controller = new AbortController();
  let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runProteinAlignmentCommand(args, {
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
    });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause();
  }
}
