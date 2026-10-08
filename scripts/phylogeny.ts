#!/usr/bin/env bun
/** Offline aligned-DNA inference; the browser uses the same core and experiment format. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { serializeAnalysisRecord } from '../packages/core/src/analysis-result';
import { PHYLOGENY_LIMITS, parseAlignedDNA, resolvePhylogenyOptions, createAlignedPhylogenyExperiment,
  replayAlignedPhylogenyExperiment, type PhylogenyOptions, type AlignedPhylogenyExperiment } from '../packages/core/src/analysis/aligned-phylogeny';

export const PHYLOGENY_HELP = `Aligned DNA neighbor joining (offline, unrooted)

bun scripts/phylogeny.ts inspect --alignment aligned.fasta
bun scripts/phylogeny.ts infer --alignment aligned.fasta --source CITATION --output experiment.json
  [--name NAME] [--distance p-distance|jc69] [--bootstrap 0|20..200] [--seed UINT32] [--demo]
bun scripts/phylogeny.ts replay --experiment experiment.json [--output verified.json]
bun scripts/phylogeny.ts export --experiment experiment.json --format newick|distances|splits --output NEW_FILE

Input must already be aligned DNA: 3–64 unique taxa, equal nonzero lengths,
up to 100000 sites and 2 MiB UTF-8. Gaps and ambiguity exclude the entire column
from every pair. All retained columns, including invariant ones, are resampled.
Inference defaults: observed p-distance, complete deletion, bootstrap 0, seed 1.
JC69 rejects saturated distances; any saturated bootstrap withholds all support.

The tree is unrooted: the Newick serialization root is not an ancestor or date.
Negative NJ limbs are retained, not repaired silently. Bootstrap proportions
refer to positive-length unrooted splits; split supports are exported separately,
not encoded as rooted clade labels in Newick. No molecular clock is inferred.
Homology and submitted provenance are not independently verified. --demo marks
synthetic input; never label demonstration data as a measured reference.

Replay and all exports verify hashes AND recompute the saved result. Analysis
options cannot override replay. Experiments are limited to 10 MiB. Outputs use
exclusive creation with owner-only permissions; existing files are never replaced.
Summaries go to stdout, errors to stderr. No network, database or terminal UI.
`;
export type PhylogenyCommand = { type: 'help' }
  | { type: 'inspect'; alignment: string }
  | { type: 'infer'; alignment: string; output: string; source: string; name?: string; demo: boolean; options: PhylogenyOptions }
  | { type: 'replay'; experiment: string; output?: string }
  | { type: 'export'; experiment: string; output: string; format: 'newick' | 'distances' | 'splits' };
export function parsePhylogenyCommand(args: readonly string[]): PhylogenyCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'infer', 'replay', 'export'].includes(type)) throw new Error('Choose inspect, infer, replay or export; use --help for usage.');
  const allowed = type === 'infer' ? ['--alignment', '--output', '--source', '--name', '--distance', '--bootstrap', '--seed', '--demo']
    : type === 'inspect' ? ['--alignment'] : type === 'export' ? ['--experiment', '--output', '--format'] : ['--experiment', '--output'];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!allowed.includes(key) || values.has(key)) throw new Error(`Unsupported or repeated option: ${key}`);
    if (key === '--demo') { values.set(key, 'true'); continue; }
    const value = rest[++i];
    if (!value || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a printable value for ${key}.`);
    values.set(key, value);
  }
  const required = (key: string): string => { const value = values.get(key); if (!value) throw new Error(`Missing ${key}.`); return value; };
  if (type === 'inspect') return { type, alignment: required('--alignment') };
  if (type === 'replay') return { type, experiment: required('--experiment'), ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (format !== 'newick' && format !== 'distances' && format !== 'splits') throw new Error('Export format must be newick, distances or splits.');
    return { type, experiment: required('--experiment'), output: required('--output'), format };
  }
  const number = (key: string, fallback: number): number => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`${key} requires a nonnegative decimal integer.`);
    return Number(value);
  };
  const options = resolvePhylogenyOptions({ distance: (values.get('--distance') ?? 'p-distance') as PhylogenyOptions['distance'],
    deletion: 'complete', bootstrap: number('--bootstrap', 0), seed: number('--seed', 1) });
  return { type: 'infer', alignment: required('--alignment'), output: required('--output'), source: required('--source'),
    ...(values.has('--name') ? { name: values.get('--name')! } : {}), demo: values.has('--demo'), options };
}
/** Nonblocking open rejects FIFOs without hanging; bounded reads also handle growing files. */
export async function readPhylogenyInput(path: string, maximum: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Phylogeny input must be a regular file.');
    if (stat.size > maximum) throw new Error(`Input exceeds the ${maximum}-byte limit.`);
    const bytes = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new Error(`Input exceeds the ${maximum}-byte limit.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}
async function writeOutput(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
function summary(experiment: AlignedPhylogenyExperiment, verified: boolean): Record<string, unknown> {
  const { result, record, source, options } = experiment;
  return { resultId: record.resultId, method: record.method, verified, source: { name: source.name, kind: source.kind }, options,
    taxa: result.taxa, alignmentSites: result.alignmentSites, usedSites: result.usedSites, variableSites: result.variableSites,
    excludedColumns: result.excludedColumns.length, negativeEdges: result.negativeEdges, bootstrap: result.bootstrap,
    distanceResidualRMSE: result.distanceResidualRMSE, warnings: result.warnings };
}
export async function executePhylogenyCommand(command: Exclude<PhylogenyCommand, { type: 'help' }>): Promise<Record<string, unknown>> {
  if (command.type === 'inspect') {
    const taxa = parseAlignedDNA(await readPhylogenyInput(command.alignment, PHYLOGENY_LIMITS.bytes));
    return { taxa: taxa.map(taxon => taxon.id), alignmentSites: taxa[0].sequence.length,
      interpretation: 'Submitted alignment dimensions only; homology and usable-column coverage have not been validated.' };
  }
  if (command.type === 'infer') {
    const experiment = await createAlignedPhylogenyExperiment({ name: command.name ?? basename(command.alignment),
      fasta: await readPhylogenyInput(command.alignment, PHYLOGENY_LIMITS.bytes), kind: command.demo ? 'demo' : 'local', reference: command.source }, command.options);
    await writeOutput(command.output, serializeAnalysisRecord(experiment.record));
    return summary(experiment, false);
  }
  const experiment = await replayAlignedPhylogenyExperiment(await readPhylogenyInput(command.experiment, 10 * 1024 * 1024));
  if (command.type === 'replay') {
    if (command.output) await writeOutput(command.output, serializeAnalysisRecord(experiment.record));
  } else {
    const { result } = experiment;
    const content = command.format === 'newick' ? result.newick + '\n' : command.format === 'splits'
      ? JSON.stringify({ resultId: experiment.record.resultId, bootstrap: result.bootstrap, splits: result.splits, warnings: result.warnings }, null, 2) + '\n'
      : ['taxon\t' + result.taxa.join('\t'), ...result.taxa.map((id, i) => id + '\t' + result.distances[i].join('\t'))].join('\n') + '\n';
    await writeOutput(command.output, content);
  }
  return summary(experiment, true);
}
export async function phylogenyMain(args: readonly string[], output: (text: string) => void, error: (text: string) => void,
  invocation = 'bun scripts/phylogeny.ts'): Promise<number> {
  try {
    const command = parsePhylogenyCommand(args);
    if (command.type === 'help') output(PHYLOGENY_HELP.replaceAll('bun scripts/phylogeny.ts', invocation));
    else output(JSON.stringify(await executePhylogenyCommand(command), null, 2) + '\n');
    return 0;
  } catch (cause) {
    error((cause instanceof Error ? cause.message : 'Phylogeny command failed.').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') + '\n');
    return 1;
  }
}
if (import.meta.main) {
  void phylogenyMain(process.argv.slice(2), text => { process.stdout.write(text); }, text => { process.stderr.write(text); })
    .then(code => { process.exitCode = code; });
}
