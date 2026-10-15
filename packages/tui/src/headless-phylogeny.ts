/** Private, database-free aligned phylogeny jobs. Numerical work runs in a terminable worker. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { ALIGNED_PHYLOGENY_METHOD, PHYLOGENY_LIMITS, createAlignedPhylogenyExperiment, parseAlignedDNA,
  replayAlignedPhylogenyExperiment, resolvePhylogenyOptions, type AlignedPhylogenyExperiment,
  type PhylogenyOptions, type PhylogenySource } from '../../core/src/analysis/aligned-phylogeny';
import { exportPhylogeny, PHYLOGENY_EXPORT_FORMATS, type PhylogenyExportFormat } from '../../core/src/analysis/phylogeny-export';
import { serializeAnalysisRecord } from '../../core/src/analysis-result';

export const PHYLOGENY_HELP = `Aligned DNA phylogeny, private computation and verified exports

bun run phylogeny inspect --input aligned.fa
bun run phylogeny infer --input aligned.fa --alignment provided
  --name NAME --reference ALIGNMENT_PROVENANCE --output NEW_EXPERIMENT.json
  [--source local|demo] [--distance p-distance|jc69] [--bootstrap 0|20..200]
  [--seed 1] [--timeout-ms 300000]
bun run phylogeny verify --experiment experiment.json [--output NEW_COPY.json]
  [--timeout-ms 300000]
bun run phylogeny export --experiment experiment.json --format FORMAT --output NEW_FILE
  [--timeout-ms 300000]
  FORMAT: newick|distances-tsv|splits-tsv|alignment-fasta

Input is an ALREADY ALIGNED homologous DNA FASTA, not raw genomes or proteins.
--alignment provided is a declaration, not an automatic alignment or homology test.
3-64 unique taxa, at most 100000 columns and 2 MiB; the shared computation budget
also applies. Complete deletion removes a column when any taxon has a gap,
ambiguous base or missing value. No usable columns and saturated JC69 fail.
Defaults are observed p-distance, no bootstrap, and seed 1. Bootstrap resamples
retained columns; any saturated replicate withholds ALL support, not just that
replicate. Linked sites and recombination limit its interpretation.

This is an unrooted neighbor-joining tree, not a molecular clock, ancestry,
transmission, host-range or population-size inference. Signed NJ branch lengths
are preserved. Newick starts with [&U]; internal labels are bootstrap PERCENTAGES
when available, never clade probabilities. The arbitrary serialization root has
no support label. Splits TSV reports fractions and counts; unavailable values
are empty, not zero. Distance TSV is a square matrix with # metadata comments.
The full experiment JSON retains all inputs, settings, masks and limitations and
can be restored in the browser. Newick/TSV are views, not replayable experiments.
alignment-fasta exports the exact original input, including its descriptions.

verify and EVERY export recompute the saved analysis and compare full identities,
not just checksums. No catalog, database or network is used. Inputs/exports contain
private sequences and are not anonymized. Stdout summaries omit sequence bases.
Output is created exclusively with owner-only permissions; existing files and
symlinks are never overwritten. Failed disk writes may leave a partial new file.
Timeout or interruption terminates computation before output creation. Use a new
output path for each run. inspect validates shape, not biological homology.
`;

interface JobOptions { timeoutMs: number }
export type PhylogenyCommand = { type: 'help' }
  | ({ type: 'inspect'; inputPath: string } & JobOptions)
  | ({ type: 'infer'; inputPath: string; outputPath: string; source: Omit<PhylogenySource, 'fasta'>; options: PhylogenyOptions } & JobOptions)
  | ({ type: 'verify'; experimentPath: string; outputPath?: string } & JobOptions)
  | ({ type: 'export'; experimentPath: string; outputPath: string; format: PhylogenyExportFormat } & JobOptions);
export type PhylogenyTask = { type: 'inspect'; content: string }
  | { type: 'infer'; content: string; source: Omit<PhylogenySource, 'fasta'>; options: PhylogenyOptions }
  | { type: 'verify'; content: string }
  | { type: 'export'; content: string; format: PhylogenyExportFormat };
export interface PhylogenyTaskResult { summary: Record<string, unknown>; output?: string }
export type PhylogenyWorkerReply = { ok: true; value: PhylogenyTaskResult } | { ok: false; error: string };
const RECORD_BYTES = 10 * 1024 * 1024;

export function parsePhylogenyCommand(args: readonly string[]): PhylogenyCommand {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'infer', 'verify', 'export'].includes(type)) throw new Error('Choose inspect, infer, verify or export. Use --help for usage.');
  const allowed = type === 'inspect' ? ['--input', '--timeout-ms'] : type === 'infer'
    ? ['--input', '--alignment', '--name', '--reference', '--source', '--distance', '--bootstrap', '--seed', '--output', '--timeout-ms']
    : type === 'verify' ? ['--experiment', '--output', '--timeout-ms'] : ['--experiment', '--format', '--output', '--timeout-ms'];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.includes(key)) throw new Error(`Unsupported ${type} option: ${key}`);
    if (flags.has(key)) throw new Error(`Repeated option: ${key}`);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a value for ${key}.`);
    flags.set(key, value);
  }
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`Missing required option ${key}.`); return value; };
  const integer = (key: string, fallback: number) => {
    const value = flags.get(key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} must be a safe nonnegative integer.`);
    return Number(value);
  };
  const timeoutMs = integer('--timeout-ms', 300000);
  if (timeoutMs < 1 || timeoutMs > 3600000) throw new Error('--timeout-ms must be from 1 to 3600000.');
  if (type === 'inspect') return { type, inputPath: required('--input'), timeoutMs };
  if (type === 'verify') return { type, experimentPath: required('--experiment'), timeoutMs,
    ...(flags.has('--output') ? { outputPath: required('--output') } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (!(PHYLOGENY_EXPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`--format must be ${PHYLOGENY_EXPORT_FORMATS.join(', ')}.`);
    return { type, experimentPath: required('--experiment'), outputPath: required('--output'), format: format as PhylogenyExportFormat, timeoutMs };
  }
  if (required('--alignment') !== 'provided') throw new Error('--alignment must be provided: this command does not align sequences.');
  const kind = flags.get('--source') ?? 'local';
  if (kind !== 'local' && kind !== 'demo') throw new Error('--source must be local or demo.');
  const distance = flags.get('--distance') ?? 'p-distance';
  if (distance !== 'p-distance' && distance !== 'jc69') throw new Error('--distance must be p-distance or jc69.');
  return { type: 'infer', inputPath: required('--input'), outputPath: required('--output'), timeoutMs,
    source: { name: required('--name'), reference: required('--reference'), kind },
    options: resolvePhylogenyOptions({ distance, bootstrap: integer('--bootstrap', 0), seed: integer('--seed', 1) }) };
}

function summarize(experiment: AlignedPhylogenyExperiment): Record<string, unknown> {
  const { result, record, source, options } = experiment;
  return { method: ALIGNED_PHYLOGENY_METHOD, resultId: record.resultId, cacheKey: record.cacheKey, sourceKind: source.kind,
    taxa: result.taxa.length, alignmentSites: result.alignmentSites, usedSites: result.usedSites,
    variableSites: result.variableSites, negativeEdges: result.negativeEdges, options,
    bootstrap: result.bootstrap, warnings: result.warnings };
}

/** Shared by the isolated worker and deterministic numerical tests. */
export async function performPhylogenyTask(task: PhylogenyTask): Promise<PhylogenyTaskResult> {
  if (task.type === 'inspect') {
    const taxa = parseAlignedDNA(task.content), columns = taxa[0].sequence.length;
    let completeColumns = 0;
    for (let i = 0; i < columns; i++) if (taxa.every(taxon => 'ACGT'.includes(taxon.sequence[i]))) completeColumns++;
    return { summary: { taxa: taxa.map(taxon => taxon.id), alignmentSites: columns, completeColumns,
      excludedColumns: columns - completeColumns, homologyVerified: false } };
  }
  const experiment = task.type === 'infer'
    ? await createAlignedPhylogenyExperiment({ ...task.source, fasta: task.content }, task.options)
    : await replayAlignedPhylogenyExperiment(task.content);
  return { summary: summarize(experiment), output: task.type === 'export'
    ? exportPhylogeny(experiment, task.format) : serializeAnalysisRecord(experiment.record) };
}

async function readBounded(path: string, maximum: number, preserveBom = false): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Phylogeny input must be a regular file.');
    if (stat.size > maximum) throw new Error(`Phylogeny input exceeds ${maximum} bytes.`);
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error(`Phylogeny input exceeds ${maximum} bytes.`);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}

/** A synchronous bootstrap cannot handle message cancellation; terminate the whole worker. */
export function executePhylogenyTask(task: PhylogenyTask, timeoutMs: number, signal?: AbortSignal): Promise<PhylogenyTaskResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Phylogeny cancelled.', 'AbortError')); return; }
    const worker = new Worker(new URL('./phylogeny.worker.ts', import.meta.url));
    let settled = false;
    const finish = (error: Error | null, value?: PhylogenyTaskResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => finish(new DOMException('Phylogeny cancelled; no output was written.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error(`Phylogeny exceeded ${timeoutMs} ms; no output was written.`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => finish(new Error(`Phylogeny worker exited before returning a result (code ${code}).`)));
    worker.on('message', (reply: PhylogenyWorkerReply) => {
      if (!reply || typeof reply.ok !== 'boolean') { finish(new Error('Invalid phylogeny worker reply.')); return; }
      if (!reply.ok) { finish(new Error(reply.error)); return; }
      if (!reply.value || typeof reply.value.summary !== 'object' || reply.value.summary === null ||
        reply.value.output !== undefined && (typeof reply.value.output !== 'string' || Buffer.byteLength(reply.value.output) > RECORD_BYTES)) {
        finish(new Error('Invalid or oversized phylogeny output.')); return;
      }
      finish(null, reply.value);
    });
    try { worker.postMessage(task); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function runPhylogenyCommand(args: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown> | string> {
  const command = parsePhylogenyCommand(args);
  if (command.type === 'help') return PHYLOGENY_HELP;
  signal?.throwIfAborted();
  const raw = command.type === 'infer' || command.type === 'inspect';
  const content = await readBounded(raw ? command.inputPath : command.experimentPath, raw ? PHYLOGENY_LIMITS.bytes : RECORD_BYTES, raw);
  signal?.throwIfAborted();
  const task: PhylogenyTask = command.type === 'infer'
    ? { type: 'infer', content, source: command.source, options: command.options }
    : command.type === 'export' ? { type: 'export', content, format: command.format } : { type: command.type, content };
  const result = await executePhylogenyTask(task, command.timeoutMs, signal);
  signal?.throwIfAborted();
  if ('outputPath' in command && command.outputPath !== undefined) {
    if (result.output === undefined) throw new Error('Phylogeny worker returned no export.');
    const file = await open(command.outputPath, 'wx', 0o600);
    try { await file.writeFile(result.output, 'utf8'); await file.sync(); } finally { await file.close(); }
  }
  return result.summary;
}
