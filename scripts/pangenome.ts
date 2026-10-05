#!/usr/bin/env bun
/** Database-free sequence graphs. Shared algorithms and experiment identities with the web workspace. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { ALIGNMENT_GRAPH_LIMITS, buildAlignmentPangenome, createAlignmentPangenomeRecord, exportAlignmentGfa,
  exportPangenomeAlignment, parsePangenomeInput, replayAlignmentPangenome, serializePangenomeInput,
  type AlignmentGraphOptions, type AlignmentPangenome } from '../packages/core/src/analysis/alignment-pangenome';
import { serializeAnalysisRecord, type AnalysisRecord } from '../packages/core/src/analysis-result';

export const PANGENOME_HELP = `Local pangenome graphs and verified exports

bun scripts/pangenome.ts inspect --input genomes.fasta
bun scripts/pangenome.ts build --input genomes.fasta --reference SEQUENCE_ID
  --alignment provided|global|wavefront --output experiment.json [--terminal-gaps missing|alleles]
bun scripts/pangenome.ts verify --experiment experiment.json [--output verified-copy.json]
bun scripts/pangenome.ts export --experiment experiment.json --format gfa|fasta|dataset --output PATH

Input: 2-24 DNA sequences in FASTA or pangenome dataset JSON (not GenBank).
provided: use an existing multiple-sequence alignment; equal lengths alone do not establish homology.
global: exact quadratic unit-edit locus alignment, capped at 12 million DP cells.
wavefront: exact unit-edit alignment for closely related collinear genomes with bounded work.
All computed modes use the supplied strand and origin, without rearrangement inference.
Terminal gaps default to missing coverage. Use alleles only for complete sequence ends.

verify and export recompute the saved graph and compare full result identities before writing.
Output files are created exclusively, with owner-only permissions; existing files and symlinks
are never overwritten. A failed disk write can leave a partial new file; use a new destination.
Summaries contain metadata and counts, not genome bases or variant alleles. No network or database.
`;
export type PangenomeCommand = { type: 'help' }
  | { type: 'inspect'; inputPath: string }
  | { type: 'build'; inputPath: string; outputPath: string; options: AlignmentGraphOptions }
  | { type: 'verify'; experimentPath: string; outputPath?: string }
  | { type: 'export'; experimentPath: string; outputPath: string; format: 'gfa' | 'fasta' | 'dataset' };

export function parsePangenomeCommand(args: readonly string[]): PangenomeCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'build', 'verify', 'export'].includes(type)) throw new Error('Choose inspect, build, verify or export. Use --help for usage.');
  const allowed = type === 'inspect' ? ['--input'] : type === 'build'
    ? ['--input', '--reference', '--alignment', '--output', '--terminal-gaps']
    : type === 'verify' ? ['--experiment', '--output'] : ['--experiment', '--format', '--output'];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.includes(key)) throw new Error(`Unsupported ${type} option: ${key}`);
    if (values.has(key)) throw new Error(`Repeated option: ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a value for ${key}.`);
    values.set(key, value);
  }
  const required = (name: string): string => {
    const value = values.get(name); if (!value) throw new Error(`Missing required option ${name}.`); return value;
  };
  if (type === 'inspect') return { type, inputPath: required('--input') };
  if (type === 'verify') return { type, experimentPath: required('--experiment'),
    ...(values.has('--output') ? { outputPath: values.get('--output')! } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (format !== 'gfa' && format !== 'fasta' && format !== 'dataset') throw new Error('--format must be gfa, fasta or dataset.');
    return { type, experimentPath: required('--experiment'), outputPath: required('--output'), format };
  }
  const alignment = required('--alignment'), terminalGaps = values.get('--terminal-gaps') ?? 'missing';
  if (alignment !== 'provided' && alignment !== 'global' && alignment !== 'wavefront') throw new Error('--alignment must be provided, global or wavefront.');
  if (terminalGaps !== 'missing' && terminalGaps !== 'alleles') throw new Error('--terminal-gaps must be missing or alleles.');
  return { type: 'build', inputPath: required('--input'), outputPath: required('--output'),
    options: { referenceId: required('--reference'), alignment, terminalGaps } };
}

/** Bound the read even if the file grows; nonblocking open permits rejecting FIFO/device inputs. */
async function readInput(path: string, maximum: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Pangenome input must be a regular file.');
    if (stat.size > maximum) throw new Error(`Pangenome input exceeds the ${maximum}-byte limit.`);
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error(`Pangenome input exceeds the ${maximum}-byte limit.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}
async function writeNew(path: string, content: string): Promise<void> {
  // All scientific computation/serialization completes BEFORE creating a file.
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
}
function summarize(graph: AlignmentPangenome, record: AnalysisRecord, verified: boolean): Record<string, unknown> {
  return { method: record.method, resultId: record.resultId, cacheKey: record.cacheKey, verified,
    options: graph.options, sequences: graph.paths.length, referenceLength: graph.referenceLength,
    columns: graph.diagnostics.columns, nodes: graph.nodes.length, edges: graph.edges.length, variants: graph.variants.length,
    ...(graph.diagnostics.wavefront ? { wavefront: graph.diagnostics.wavefront } : {}),
    interpretation: 'Exact sequence differences conditional on the alignment, not inferred biological rearrangements or donor assignments.' };
}
export async function executePangenomeCommand(command: Exclude<PangenomeCommand, { type: 'help' }>): Promise<Record<string, unknown>> {
  if (command.type === 'verify' || command.type === 'export') {
    const saved = await readInput(command.experimentPath, 10 * 1024 * 1024);
    const { input, graph, record } = await replayAlignmentPangenome(saved);
    if (command.type === 'export') {
      const content = command.format === 'gfa' ? exportAlignmentGfa(graph)
        : command.format === 'fasta' ? exportPangenomeAlignment(graph) : serializePangenomeInput(input);
      await writeNew(command.outputPath, content);
    } else if (command.outputPath) await writeNew(command.outputPath, serializeAnalysisRecord(record));
    return { ...summarize(graph, record, true), ...(command.type === 'export' ? { exportedFormat: command.format } : {}) };
  }
  const content = await readInput(command.inputPath, ALIGNMENT_GRAPH_LIMITS.bytes);
  const input = parsePangenomeInput(content, basename(command.inputPath));
  if (command.type === 'inspect') return { name: input.name, source: input.source,
    sequences: input.sequences.map(row => ({ id: row.id, description: row.description, columns: row.sequence.length,
      ungappedLength: row.sequence.replaceAll('-', '').length, ambiguousBases: row.sequence.replace(/[ACGT-]/g, '').length })),
    hasGaps: input.sequences.some(row => row.sequence.includes('-')),
    equalColumnCounts: input.sequences.every(row => row.sequence.length === input.sequences[0].sequence.length),
    interpretation: 'Equal column counts alone do not establish an alignment. Choose --alignment explicitly.' };
  const graph = buildAlignmentPangenome(input, command.options);
  const record = await createAlignmentPangenomeRecord(input, graph);
  await writeNew(command.outputPath, serializeAnalysisRecord(record));
  return summarize(graph, record, false);
}
export async function pangenomeMain(args: readonly string[], output: (text: string) => void, error: (text: string) => void): Promise<number> {
  try {
    const command = parsePangenomeCommand(args);
    output(command.type === 'help' ? PANGENOME_HELP : JSON.stringify(await executePangenomeCommand(command), null, 2) + '\n');
    return 0;
  } catch (cause) {
    error((cause instanceof Error ? cause.message : 'Pangenome operation failed.').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n');
    return 1;
  }
}
if (import.meta.main) {
  void pangenomeMain(process.argv.slice(2), text => { process.stdout.write(text); }, text => { process.stderr.write(text); })
    .then(code => { process.exitCode = code; });
}
