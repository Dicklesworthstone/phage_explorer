#!/usr/bin/env bun
/** Database-free sequence graphs. Shared algorithms and experiment identities with the web workspace. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { ALIGNMENT_GRAPH_LIMITS, buildAlignmentPangenome, createAlignmentPangenomeRecord, exportAlignmentGfa,
  exportPangenomeAlignment, exportPangenomeOriginalFasta, parsePangenomeInput, replayAlignmentPangenome, serializePangenomeInput,
  createAnnotatedAlignmentPangenome, type PangenomeCdsSelection,
  type AlignmentGraphOptions, type AlignmentPangenome } from '../packages/core/src/analysis/alignment-pangenome';
import { serializeAnalysisRecord, type AnalysisRecord } from '../packages/core/src/analysis-result';
import { GENOME_IMPORT_LIMITS, importLocalGenomes, type GenomeInput } from '../packages/core/src/genome-import';
import { exportCdsConsequenceFasta, exportCdsConsequenceTable, parseCdsGeneIds,
  type CdsConsequenceExperiment } from '../packages/core/src/analysis/cds-consequences';

export const PANGENOME_HELP = `Local pangenome graphs, coding consequences and verified exports

bun scripts/pangenome.ts inspect --input genomes.fasta
bun scripts/pangenome.ts inspect-annotations --annotation reference.gb
bun scripts/pangenome.ts build --input genomes.fasta --reference SEQUENCE_ID
  --alignment provided|global|wavefront --output experiment.json [--terminal-gaps missing|alleles]
  [--normalization none|strand|circular] [--annotation reference.gb]
  [--annotation-record ACCESSION_OR_CONTENT_ID] [--gene-ids 1,2,3]
bun scripts/pangenome.ts annotate --experiment experiment.json --annotation reference.gb
  --output annotated.json [--annotation-record ACCESSION_OR_CONTENT_ID] [--gene-ids 1,2,3]
bun scripts/pangenome.ts verify --experiment experiment.json [--output verified-copy.json]
bun scripts/pangenome.ts export --experiment experiment.json --format FORMAT --output PATH
  FORMAT: gfa|fasta|original-fasta|dataset|consequences-tsv|cds-fasta|protein-fasta

Input: 2-24 DNA sequences in FASTA or pangenome dataset JSON (not GenBank).
provided: use an existing multiple-sequence alignment; equal lengths alone do not establish homology.
global: exact quadratic unit-edit locus alignment, capped at 12 million DP cells.
wavefront: exact unit-edit alignment for closely related collinear genomes with bounded work.
Computed modes retain supplied strands/origins unless wavefront normalization is requested.
strand: orient whole sequences; circular: normalize strand/origin of complete circular inputs.
Circular mode requires --terminal-gaps alleles. Anchor-based normalization is not exhaustive
circular optimization or internal inversion detection; weak/conflicting anchors are rejected.
FASTA exports use normalized aligned paths; original-fasta recovers the original input bases.
Terminal gaps default to missing coverage. Use alleles only for complete sequence ends.

Annotation input: GenBank or a local genome bundle. Bases/origin must exactly match the reference;
accession alone is insufficient. inspect-annotations lists mapped CDS IDs without printing bases.
annotate verifies the old experiment then rebuilds graph and CDS together from original inputs.
Omitting --gene-ids selects all mapped CDS, including when reannotating a prior subset.
Coding exports require an annotated experiment. TSV includes unavailable/deleted rows; FASTA
contains supported reference and nonempty available projected query sequences. Proteins retain
'*' stop symbols. Consequences are alignment-conditional, not functional or clinical predictions.

verify and export recompute the saved graph and compare full result identities before writing.
Output files are created exclusively, with owner-only permissions; existing files and symlinks
are never overwritten. A failed disk write can leave a partial new file; use a new destination.
Summaries contain metadata and counts, not genome bases or variant alleles. No network or database.
`;
interface AnnotationSource { annotationPath: string; selection: PangenomeCdsSelection }
export type PangenomeExportFormat = 'gfa' | 'fasta' | 'original-fasta' | 'dataset' | 'consequences-tsv' | 'cds-fasta' | 'protein-fasta';
export type PangenomeCommand = { type: 'help' }
  | { type: 'inspect'; inputPath: string }
  | { type: 'inspect-annotations'; annotationPath: string }
  | { type: 'build'; inputPath: string; outputPath: string; options: AlignmentGraphOptions; annotation?: AnnotationSource }
  | { type: 'annotate'; experimentPath: string; outputPath: string; annotation: AnnotationSource }
  | { type: 'verify'; experimentPath: string; outputPath?: string }
  | { type: 'export'; experimentPath: string; outputPath: string; format: PangenomeExportFormat };

export function parsePangenomeCommand(args: readonly string[]): PangenomeCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'inspect-annotations', 'build', 'annotate', 'verify', 'export'].includes(type)) throw new Error('Choose inspect, inspect-annotations, build, annotate, verify or export. Use --help for usage.');
  const annotationFlags = ['--annotation', '--annotation-record', '--gene-ids'];
  const allowed = type === 'inspect' ? ['--input'] : type === 'inspect-annotations' ? ['--annotation'] : type === 'build'
    ? ['--input', '--reference', '--alignment', '--output', '--terminal-gaps', '--normalization', ...annotationFlags]
    : type === 'annotate' ? ['--experiment', '--output', ...annotationFlags]
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
  const annotation = (): AnnotationSource => ({ annotationPath: required('--annotation'), selection: {
    annotationRecord: values.get('--annotation-record') ?? null, geneIds: parseCdsGeneIds(values.get('--gene-ids') ?? ''),
  } });
  if (type === 'inspect') return { type, inputPath: required('--input') };
  if (type === 'inspect-annotations') return { type, annotationPath: required('--annotation') };
  if (type === 'annotate') return { type, experimentPath: required('--experiment'), outputPath: required('--output'), annotation: annotation() };
  if (type === 'verify') return { type, experimentPath: required('--experiment'),
    ...(values.has('--output') ? { outputPath: values.get('--output')! } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (!['gfa', 'fasta', 'original-fasta', 'dataset', 'consequences-tsv', 'cds-fasta', 'protein-fasta'].includes(format)) {
      throw new Error('--format must be gfa, fasta, original-fasta, dataset, consequences-tsv, cds-fasta or protein-fasta.');
    }
    return { type, experimentPath: required('--experiment'), outputPath: required('--output'), format: format as PangenomeExportFormat };
  }
  if (!values.has('--annotation') && (values.has('--annotation-record') || values.has('--gene-ids'))) throw new Error('CDS selection requires --annotation.');
  const alignment = required('--alignment'), terminalGaps = values.get('--terminal-gaps') ?? 'missing';
  if (alignment !== 'provided' && alignment !== 'global' && alignment !== 'wavefront') throw new Error('--alignment must be provided, global or wavefront.');
  if (terminalGaps !== 'missing' && terminalGaps !== 'alleles') throw new Error('--terminal-gaps must be missing or alleles.');
  const rawNormalization = values.get('--normalization');
  const normalization = rawNormalization === 'none' ? undefined : rawNormalization;
  if (normalization !== undefined && normalization !== 'strand' && normalization !== 'circular') throw new Error('--normalization must be none, strand or circular.');
  if (normalization && alignment !== 'wavefront') throw new Error('Normalization requires --alignment wavefront.');
  if (normalization === 'circular' && terminalGaps !== 'alleles') throw new Error('Complete circular inputs require --terminal-gaps alleles.');
  return { type: 'build', inputPath: required('--input'), outputPath: required('--output'),
    options: { referenceId: required('--reference'), alignment, terminalGaps, ...(normalization ? { normalization } : {}) },
    ...(values.has('--annotation') ? { annotation: annotation() } : {}) };
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
async function readAnnotation(path: string): Promise<GenomeInput> {
  return { name: basename(path), text: await readInput(path, GENOME_IMPORT_LIMITS.bytes) };
}
function summarize(graph: AlignmentPangenome, record: AnalysisRecord, verified: boolean, cds?: CdsConsequenceExperiment): Record<string, unknown> {
  const effects = new Map<string, number>();
  for (const row of cds?.consequences ?? []) for (const effect of row.effects) effects.set(effect, (effects.get(effect) ?? 0) + 1);
  return { method: record.method, resultId: record.resultId, cacheKey: record.cacheKey, verified,
    options: graph.options, sequences: graph.paths.length, referenceLength: graph.referenceLength,
    columns: graph.diagnostics.columns, nodes: graph.nodes.length, edges: graph.edges.length, variants: graph.variants.length,
    ...(graph.diagnostics.wavefront ? { wavefront: graph.diagnostics.wavefront } : {}),
    ...(graph.diagnostics.normalization ? { normalization: graph.diagnostics.normalization } : {}),
    ...(cds ? { coding: { ...cds.summary, annotationAccession: cds.reference.accession, annotationContentId: cds.reference.contentId,
      cdsResultId: cds.record.resultId, effects: Object.fromEntries(effects), interpretation: 'Whole-CDS sequence consequences; effect labels may overlap. No functional or phenotype inference.' } } : {}),
    interpretation: 'Exact sequence differences conditional on the alignment, not inferred biological rearrangements or donor assignments.' };
}
export async function executePangenomeCommand(command: Exclude<PangenomeCommand, { type: 'help' }>): Promise<Record<string, unknown>> {
  if (command.type === 'inspect-annotations') {
    const parsed = await importLocalGenomes(await readAnnotation(command.annotationPath));
    const genomes = parsed.genomes.filter(genome => genome.phage.localGenome?.format === 'genbank');
    if (!genomes.length) throw new Error('Annotation input contains no GenBank records.');
    return { records: genomes.map(({ phage, warnings }) => ({ accession: phage.accession, contentId: phage.localGenome!.contentId,
      bases: phage.genomeLength, warnings, cds: phage.genes.filter(gene => gene.type === 'CDS').map(gene => ({
        id: gene.id, name: gene.locusTag ?? gene.name, product: gene.product, location: gene.qualifiers?._location ?? null,
      })) })), interpretation: 'Mapped reference CDS IDs, not a claim all annotations support translation.' };
  }
  if (command.type === 'verify' || command.type === 'export' || command.type === 'annotate') {
    const saved = await readInput(command.experimentPath, 10 * 1024 * 1024);
    const { input, graph, record, cds } = await replayAlignmentPangenome(saved);
    if (command.type === 'annotate') {
      const fresh = await createAnnotatedAlignmentPangenome(input, graph.options,
        await readAnnotation(command.annotation.annotationPath), command.annotation.selection);
      await writeNew(command.outputPath, serializeAnalysisRecord(fresh.record));
      return summarize(fresh.graph, fresh.record, false, fresh.cds);
    }
    if (command.type === 'export') {
      let content: string;
      if (command.format === 'consequences-tsv' || command.format === 'cds-fasta' || command.format === 'protein-fasta') {
        if (!cds) throw new Error('This experiment has no coding consequences. Run annotate with a matching GenBank reference first.');
        content = command.format === 'consequences-tsv' ? exportCdsConsequenceTable(cds)
          : exportCdsConsequenceFasta(cds, command.format === 'cds-fasta' ? 'cds' : 'protein');
      } else content = command.format === 'gfa' ? exportAlignmentGfa(graph)
        : command.format === 'fasta' ? exportPangenomeAlignment(graph)
          : command.format === 'original-fasta' ? exportPangenomeOriginalFasta(graph) : serializePangenomeInput(input);
      await writeNew(command.outputPath, content);
    } else if (command.outputPath) await writeNew(command.outputPath, serializeAnalysisRecord(record));
    return { ...summarize(graph, record, true, cds), ...(command.type === 'export' ? { exportedFormat: command.format } : {}) };
  }
  const content = await readInput(command.inputPath, ALIGNMENT_GRAPH_LIMITS.bytes);
  const input = parsePangenomeInput(content, basename(command.inputPath));
  if (command.type === 'inspect') return { name: input.name, source: input.source,
    sequences: input.sequences.map(row => ({ id: row.id, description: row.description, columns: row.sequence.length,
      ungappedLength: row.sequence.replaceAll('-', '').length, ambiguousBases: row.sequence.replace(/[ACGT-]/g, '').length })),
    hasGaps: input.sequences.some(row => row.sequence.includes('-')),
    equalColumnCounts: input.sequences.every(row => row.sequence.length === input.sequences[0].sequence.length),
    interpretation: 'Equal column counts alone do not establish an alignment. Choose --alignment explicitly.' };
  if (command.annotation) {
    const { graph, record, cds } = await createAnnotatedAlignmentPangenome(input, command.options,
      await readAnnotation(command.annotation.annotationPath), command.annotation.selection);
    await writeNew(command.outputPath, serializeAnalysisRecord(record));
    return summarize(graph, record, false, cds);
  }
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
