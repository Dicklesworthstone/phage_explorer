#!/usr/bin/env bun
/** Database-free reference analysis. All computation shares the browser's core implementation. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { GENOME_IMPORT_LIMITS, importLocalGenomes } from '../packages/core/src/genome-import';
import { serializeAnalysisRecord } from '../packages/core/src/analysis-result';
import { CODON_REFERENCE_LIMITS, createReferenceCodonExperiment, referenceGenomeFromPhage,
  replayReferenceCodonExperiment, type ReferenceCodonExperiment, type ZeroCountReplacement } from '../packages/core/src/analysis/codon-reference';

export const CODON_REFERENCE_HELP = `Reference-backed codon adaptation (local files only)

bun scripts/codon-reference.ts analyze --genome query.gb --reference counts.json --output experiment.json
  [--record ACCESSION_OR_CONTENT_ID] [--gene-ids 1,2] [--zero-count 0|0.5]
bun scripts/codon-reference.ts verify --experiment experiment.json [--output verified-copy.json]
bun scripts/codon-reference.ts inspect --genome query.gb

analyze: import annotated GenBank/local bundle and calculate reference-relative CDS scores.
verify: validate identities and independently recompute all saved numerical outputs.
inspect: list record selectors and CDS IDs without printing genome sequences.

For a multi-record input, analyze requires --record; matching accessions must be unique,
otherwise select the full content ID shown by inspect. --gene-ids selects internal CDS IDs.
The default zero-count replacement is 0.5; omitted reference counts are never zeros.
New output files use exclusive creation and owner-only permissions. Existing files are
never overwritten. JSON summaries go to stdout; errors go to stderr. No network or DB.
CAI is a reference-relative sequence score, not expression, host range or infectivity.
`;
export type CodonReferenceCommand = { type: 'help' }
  | { type: 'inspect'; genomePath: string }
  | { type: 'verify'; experimentPath: string; outputPath?: string }
  | { type: 'analyze'; genomePath: string; referencePath: string; outputPath: string; record?: string; geneIds: number[] | null; zeroCountReplacement: ZeroCountReplacement };

export function parseCodonReferenceCommand(args: readonly string[]): CodonReferenceCommand {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['analyze', 'verify', 'inspect'].includes(type)) throw new Error('Choose analyze, verify or inspect. Use --help for usage.');
  const allowed = type === 'analyze' ? ['--genome', '--reference', '--output', '--record', '--gene-ids', '--zero-count']
    : type === 'verify' ? ['--experiment', '--output'] : ['--genome'];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.includes(key)) throw new Error(`Unsupported ${type} option: ${key}`);
    if (options.has(key)) throw new Error(`Repeated option: ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Provide a value for ${key}.`);
    options.set(key, value);
  }
  const required = (name: string): string => {
    const value = options.get(name);
    if (!value) throw new Error(`Missing required option ${name}.`);
    return value;
  };
  if (type === 'inspect') return { type, genomePath: required('--genome') };
  if (type === 'verify') return { type, experimentPath: required('--experiment'), ...(options.has('--output') ? { outputPath: options.get('--output')! } : {}) };
  let geneIds: number[] | null = null;
  if (options.has('--gene-ids')) {
    const value = options.get('--gene-ids')!;
    if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(value)) throw new Error('--gene-ids requires comma-separated positive integer IDs.');
    geneIds = value.split(',').map(Number);
    if (geneIds.length > CODON_REFERENCE_LIMITS.genes || !geneIds.every(Number.isSafeInteger) || new Set(geneIds).size !== geneIds.length) throw new Error('Invalid or duplicate CDS IDs.');
  }
  const zero = options.get('--zero-count') ?? '0.5';
  if (zero !== '0' && zero !== '0.5') throw new Error('--zero-count must be 0 or 0.5.');
  return { type: 'analyze', genomePath: required('--genome'), referencePath: required('--reference'), outputPath: required('--output'),
    ...(options.has('--record') ? { record: options.get('--record')! } : {}), geneIds, zeroCountReplacement: Number(zero) as ZeroCountReplacement };
}

/** Read at most the limit plus one byte, including when a file grows during reading. */
export async function readCodonInput(path: string, maximum: number): Promise<string> {
  // A blocking open would hang on a FIFO before stat() can reject it.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Inputs must be regular files.');
    if (stat.size > maximum) throw new Error(`Input exceeds the ${maximum}-byte limit.`);
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error(`Input exceeds the ${maximum}-byte limit.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}

async function writeExperiment(path: string, experiment: ReferenceCodonExperiment): Promise<void> {
  // Serialize/validate before creating a destination. O_EXCL also refuses existing symlinks.
  const content = serializeAnalysisRecord(experiment.record);
  const output = await open(path, 'wx', 0o600);
  try { await output.writeFile(content, 'utf8'); await output.sync(); }
  finally { await output.close(); }
}
function summarize(experiment: ReferenceCodonExperiment, verified: boolean): Record<string, unknown> {
  return { method: experiment.record.method.id, resultId: experiment.record.resultId, verified,
    reference: { name: experiment.analysis.reference.name, version: experiment.analysis.reference.source.version },
    ...experiment.analysis.summary,
    interpretation: 'Reference-relative sequence score; not expression, host range or infectivity.' };
}
/** Returns a safe summary; private sequence/reference data are written only to the chosen file. */
export async function executeCodonReferenceCommand(command: Exclude<CodonReferenceCommand, { type: 'help' }>): Promise<Record<string, unknown>> {
  if (command.type === 'verify') {
    const content = await readCodonInput(command.experimentPath, GENOME_IMPORT_LIMITS.bytes);
    const experiment = await replayReferenceCodonExperiment(content);
    if (command.outputPath) await writeExperiment(command.outputPath, experiment);
    return summarize(experiment, true);
  }
  const content = await readCodonInput(command.genomePath, GENOME_IMPORT_LIMITS.bytes);
  const { genomes } = await importLocalGenomes({ name: basename(command.genomePath), text: content });
  if (command.type === 'inspect') return { records: genomes.map(({ phage }) => ({ name: phage.name, accession: phage.accession,
    contentId: phage.localGenome!.contentId, genomeLength: phage.genomeLength, cds: phage.genes.filter(gene => !gene.type || gene.type === 'CDS').map(gene => ({
      id: gene.id, name: gene.locusTag ?? gene.name ?? `CDS ${gene.id}`, start: gene.startPos, end: gene.endPos, strand: gene.strand,
    })) })), coordinates: '0-based, half-open; joined transcript segments remain in the original annotations.' };
  const matching = command.record ? genomes.filter(genome => genome.phage.accession === command.record || genome.phage.localGenome?.contentId === command.record) : genomes;
  if (matching.length !== 1) throw new Error('Select exactly one record with --record. Run inspect to find a unique accession or full content ID.');
  const genome = matching[0];
  const referenceText = await readCodonInput(command.referencePath, CODON_REFERENCE_LIMITS.bytes);
  const experiment = await createReferenceCodonExperiment(referenceGenomeFromPhage(genome.phage), genome.sequence, referenceText,
    { geneIds: command.geneIds, zeroCountReplacement: command.zeroCountReplacement });
  await writeExperiment(command.outputPath, experiment);
  return summarize(experiment, false);
}
export async function codonReferenceMain(args: readonly string[], output: (text: string) => void, error: (text: string) => void,
  invocation = 'bun scripts/codon-reference.ts'): Promise<number> {
  try {
    const command = parseCodonReferenceCommand(args);
    if (command.type === 'help') output(CODON_REFERENCE_HELP.replaceAll('bun scripts/codon-reference.ts', invocation));
    else output(JSON.stringify(await executeCodonReferenceCommand(command), null, 2) + '\n');
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Reference analysis failed.';
    error(message.replace(/[\u0000-\u001f\u007f]/g, ' ') + '\n');
    return 1;
  }
}
if (import.meta.main) {
  void codonReferenceMain(process.argv.slice(2), text => { process.stdout.write(text); }, text => { process.stderr.write(text); })
    .then(code => { process.exitCode = code; });
}
