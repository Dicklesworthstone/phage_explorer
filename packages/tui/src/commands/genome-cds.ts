/** Database-free annotated CDS/proteome exports from exact supplied genome sources. */
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { basename, resolve } from 'node:path';
import { lstat, writeFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import {
  GENOME_CDS_LIMITS, createGenomeCdsExperiment, replayGenomeCdsExperiment,
  exportGenomeCdsFasta, exportGenomeCdsTable, type GenomeCdsExperiment,
} from '../../../core/src/genome-cds-export';
import { readAbundanceFile, readAbundanceStdin } from './abundance';

export const GENOME_CDS_HELP = `Annotated CDS and proteome export (local files only; no catalog or network required)

  phage-explorer genome-cds inspect INPUT
  phage-explorer genome-cds export INPUT [--record ACCESSION_OR_CONTENT_ID] [--genes ID,ID]
  phage-explorer genome-cds replay SAVED_ANALYSIS

Common options:
  --format json|tsv|cds-fasta|protein-fasta   export/replay format (default json)
  --output NEW_FILE                         write a new file instead of stdout
  -                                         read INPUT from stdin

INPUT accepts local GenBank, FASTA, portable genome bundles and captured catalog
genome snapshots. inspect lists record content IDs, mapped CDS IDs and import
warnings. Multi-record inputs require --record; a duplicate accession requires
the full content ID. --genes selects distinct mapped CDS IDs in that record.

export reconstructs annotated transcripts on both strands, including joins and
codon_start, using each CDS's explicit supported translation table. JSON retains
the exact source, every selected row, checksums and unavailable reasons. TSV also
reports every selected row. FASTA contains only available sequences with unique
source-bound IDs; protein FASTA retains terminal stop symbols (*). Check the JSON
or TSV report for unavailable rows. No missing genes or exceptional recoding are
inferred. Unannotated FASTA therefore has no CDS/proteome sequences to export.

replay reparses the embedded source and recomputes all selected CDS before output;
saved selection and source cannot be overridden. Existing files are never replaced.
Input, saved records and output are bounded to 10 MiB. At most 12,000 CDS and
8,000,000 extracted bases are accepted in one result. Ctrl-C cancels before output.
`;

export type GenomeCdsOperation = 'inspect' | 'export' | 'replay';
export type GenomeCdsFormat = 'json' | 'tsv' | 'cds-fasta' | 'protein-fasta';
export interface GenomeCdsCommand {
  operation: GenomeCdsOperation;
  input: string;
  output?: string;
  format: GenomeCdsFormat;
  record?: string;
  geneIds?: number[];
}
export interface GenomeCdsCommandIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Genome CDS export cancelled.', 'AbortError');
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

export function parseGenomeCdsCommand(args: string[]): GenomeCdsCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    record: { type: 'string' }, genes: { type: 'string' }, format: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['inspect', 'export', 'replay'].includes(operation)) {
    throw new Error('Expected genome-cds inspect|export|replay INPUT. See genome-cds --help.');
  }
  if (!input.trim() || [values.record, values.genes, values.output].some(value => value !== undefined && !value.trim())) {
    throw new Error('File paths and selections must not be empty.');
  }
  const format = values.format ?? 'json';
  if (!['json', 'tsv', 'cds-fasta', 'protein-fasta'].includes(format)) {
    throw new Error('--format must be json, tsv, cds-fasta or protein-fasta.');
  }
  if (operation !== 'export' && (values.record !== undefined || values.genes !== undefined)) {
    throw new Error('--record and --genes apply only to export; replay retains the exact saved selection.');
  }
  if (operation === 'inspect' && format !== 'json') throw new Error('inspect lists genome records as JSON; sequence and table formats require export or replay.');
  let geneIds: number[] | undefined;
  if (values.genes !== undefined) {
    if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(values.genes)) throw new Error('--genes must contain comma-separated positive mapped CDS IDs.');
    geneIds = values.genes.split(',').map(Number);
    if (geneIds.length > GENOME_CDS_LIMITS.rows || geneIds.some(id => !Number.isSafeInteger(id)) || new Set(geneIds).size !== geneIds.length) {
      throw new Error('--genes requires at most 12,000 distinct safe integer CDS IDs.');
    }
  }
  return { operation: operation as GenomeCdsOperation, input, format: format as GenomeCdsFormat,
    record: values.record, geneIds, output: values.output === '-' ? undefined : values.output };
}

function exportResult(experiment: GenomeCdsExperiment, format: GenomeCdsFormat): string {
  if (format === 'tsv') return exportGenomeCdsTable(experiment);
  if (format === 'cds-fasta') return exportGenomeCdsFasta(experiment, 'cds');
  if (format === 'protein-fasta') return exportGenomeCdsFasta(experiment, 'protein');
  return serializeAnalysisRecord(experiment.record) + '\n';
}

export async function runGenomeCdsCommand(args: string[], io: GenomeCdsCommandIO): Promise<number> {
  let command: GenomeCdsCommand | null;
  try { command = parseGenomeCdsCommand(args); }
  catch (cause) { await writeStream(io.stderr, 'Genome CDS: ' + cleanError(cause) + '\n'); return 2; }
  if (!command) { await writeStream(io.stdout, GENOME_CDS_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await assertNewOutput(destination);
    const limit = command.operation === 'replay' ? GENOME_CDS_LIMITS.recordBytes : GENOME_CDS_LIMITS.inputBytes;
    const text = command.input === '-'
      ? await readAbundanceStdin(io.stdin, limit, io.signal)
      : await readAbundanceFile(command.input, limit, io.signal);
    check(io.signal);
    let output: string;
    if (command.operation === 'replay') {
      output = exportResult(await replayGenomeCdsExperiment(text.replace(/^\uFEFF/, ''), io.signal), command.format);
    } else {
      const input = { name: command.input === '-' ? 'stdin genome' : basename(command.input), text };
      if (command.operation === 'inspect') {
        const { genomes } = await importLocalGenomes(input);
        check(io.signal);
        output = JSON.stringify({ records: genomes.map(genome => ({
          name: genome.phage.name, accession: genome.phage.accession, contentId: genome.phage.localGenome!.contentId,
          sequenceSha256: genome.phage.localGenome!.sequenceSha256, genomeLength: genome.sequence.length,
          format: genome.phage.localGenome!.format, warnings: genome.warnings,
          cds: genome.phage.genes.filter(gene => gene.type?.toUpperCase() === 'CDS').map(gene => ({
            id: gene.id, name: gene.name, locusTag: gene.locusTag, product: gene.product,
          })),
        })) }, null, 2) + '\n';
      } else {
        const experiment = await createGenomeCdsExperiment(input, { record: command.record, geneIds: command.geneIds }, io.signal);
        output = exportResult(experiment, command.format);
      }
    }
    check(io.signal);
    if (new TextEncoder().encode(output).length > GENOME_CDS_LIMITS.outputBytes) throw new Error('Genome CDS output exceeds 10 MiB.');
    if (destination) await writeFile(destination, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    else await writeStream(io.stdout, output);
    return 0;
  } catch (cause) {
    await writeStream(io.stderr, 'Genome CDS: ' + cleanError(cause) + '\n');
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

export async function runGenomeCdsProcess(args: string[]): Promise<void> {
  const controller = new AbortController();
  let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runGenomeCdsCommand(args, {
      stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal,
    });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause();
  }
}
