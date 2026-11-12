#!/usr/bin/env bun
/** Offline aligned-DNA inference; the browser uses the same core and experiment format. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { serializeAnalysisRecord, type AnalysisRecord } from '../packages/core/src/analysis-result';
import { PHYLOGENY_LIMITS, parseAlignedDNA, resolvePhylogenyOptions, createAlignedPhylogenyExperiment,
  replayAlignedPhylogenyExperiment, type PhylogenyOptions, type AlignedPhylogenyExperiment } from '../packages/core/src/analysis/aligned-phylogeny';
import { ROOTED_PHYLOGENY_METHOD, resolveOutgroupRooting, rootAlignedPhylogenyExperiment,
  replayRootedPhylogenyExperiment, type OutgroupRooting, type RootedPhylogenyExperiment } from '../packages/core/src/analysis/phylogeny-rooting';
import { resolveTemporalOptions, type TemporalOptions } from '../packages/core/src/analysis/temporal-signal';
import { resolveDatingOptions, exportDatedNewick, type DatingOptions } from '../packages/core/src/analysis/strict-clock';
import { ROOTED_TEMPORAL_METHOD, ROOTED_DATING_METHOD, createRootedTemporalExperiment,
  replayRootedTemporalExperiment, createRootedDatingExperiment, replayRootedDatingExperiment,
  type RootedTemporalMetadata, type RootedTemporalExperiment, type RootedDatingExperiment } from '../packages/core/src/analysis/phylogeny-temporal';

export const PHYLOGENY_HELP = `Aligned DNA neighbor joining (offline, unrooted)

bun scripts/phylogeny.ts inspect --alignment aligned.fasta
bun scripts/phylogeny.ts infer --alignment aligned.fasta --source CITATION --output experiment.json
  [--name NAME] [--distance p-distance|jc69|k80] [--bootstrap 0|20..200] [--seed UINT32] [--demo]
bun scripts/phylogeny.ts root --experiment experiment.json --outgroup A,B --fraction 0.25
  --rooting-evidence 'Outgroup and branch-placement rationale' --date-independent --output rooted.json
bun scripts/phylogeny.ts temporal --experiment rooted.json --dates samples.csv --name COHORT
  --source DESCRIPTION --license LICENSE --date-independent --output temporal.json
  [--reference CITATION] [--demo-dates] [--permutations 19..9999] [--seed UINT32]
  [--scheme unrestricted|within-groups] [--exclude SAMPLE1,SAMPLE2]
bun scripts/phylogeny.ts date --experiment temporal.json --output dated.json
  [--rate-mode estimate|fixed] [--fixed-rate RATE --rate-source CITATION]
  [--minimum-rate RATE] [--maximum-rate RATE] [--iterations 1..20000]
bun scripts/phylogeny.ts replay --experiment experiment.json [--output verified.json]
bun scripts/phylogeny.ts export --experiment experiment.json --format newick|distances|splits --output NEW_FILE

Input must already be aligned DNA: 3–64 unique taxa, equal nonzero lengths,
up to 100000 sites and 2 MiB UTF-8. Gaps and ambiguity exclude the entire column
from every pair. All retained columns, including invariant ones, are resampled.
Inference defaults: observed p-distance, complete deletion, bootstrap 0, seed 1.
JC69 and K80 reject saturated distances; any saturated bootstrap withholds all support.
K80 distinguishes transitions from transversions under equal equilibrium base frequencies.

The inferred tree is unrooted: its Newick serialization root is not an ancestor
or date. Negative NJ limbs are retained, not repaired silently. Bootstrap
proportions refer to positive-length unrooted splits, not rooted clade labels.
Homology and submitted provenance are not independently verified. --demo marks
synthetic input; never label demonstration data as a measured reference.

root records a USER-SPECIFIED outgroup and branch-position hypothesis. --fraction
is strictly between 0 and 1, measured from the outgroup-side endpoint; there is
no midpoint default. --date-independent asserts that neither decision used
collection dates. Both the outgroup and the placement need supplied rationale.
At least two ingroup taxa must remain. The outgroup must be separated by one
positive-length edge; any negative original limb is rejected, never clipped.
Rooting retains every taxon and pairwise tree path. It does not estimate or
validate a biological root or molecular clock. Original split support gives
no root support. The original alignment and settings remain in rooted.json.

Temporal analysis accepts only a verified JC69 or K80 rooted experiment and an exact
collection-date table. The user must declare that dates did not guide alignment,
cohort selection, tree inference or rooting. The temporal record retains and
recomputes the complete alignment/root/date lineage. Strict-clock dating consumes
that verified temporal record and preserves its diagnostic settings; date-based
diagnostic exclusions are not silently reused as clock-fit pruning.

Replay accepts original, rooted, temporal OR dated experiment JSON and verifies
hashes AND recomputes the complete result. Newick from a rooted record uses the
specified root; distance and split exports remain the original UNROOTED results.
root requires the original unrooted record; rerooting is an explicit new operation
on that original, not an accumulated edit to a previous root. Analysis options
cannot override replay. Experiments are limited to 10 MiB. Outputs use exclusive
creation with owner-only permissions; existing files are never replaced.
Summaries go to stdout, errors to stderr. No network, database or terminal UI.
`;
export type PhylogenyCommand = { type: 'help' }
  | { type: 'inspect'; alignment: string }
  | { type: 'infer'; alignment: string; output: string; source: string; name?: string; demo: boolean; options: PhylogenyOptions }
  | { type: 'root'; experiment: string; output: string; rooting: OutgroupRooting }
  | { type: 'temporal'; experiment: string; dates: string; output: string; metadata: Omit<RootedTemporalMetadata, 'sampleTable'>; options: TemporalOptions }
  | { type: 'date'; experiment: string; output: string; options: DatingOptions }
  | { type: 'replay'; experiment: string; output?: string }
  | { type: 'export'; experiment: string; output: string; format: 'newick' | 'distances' | 'splits' | 'dated-newick' };
export function parsePhylogenyCommand(args: readonly string[]): PhylogenyCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'infer', 'root', 'temporal', 'date', 'replay', 'export'].includes(type)) throw new Error('Choose inspect, infer, root, temporal, date, replay or export; use --help for usage.');
  const allowed = type === 'infer' ? ['--alignment', '--output', '--source', '--name', '--distance', '--bootstrap', '--seed', '--demo']
    : type === 'root' ? ['--experiment', '--output', '--outgroup', '--fraction', '--rooting-evidence', '--date-independent']
    : type === 'temporal' ? ['--experiment', '--dates', '--output', '--name', '--source', '--reference', '--license', '--date-independent', '--demo-dates', '--permutations', '--seed', '--scheme', '--exclude']
    : type === 'date' ? ['--experiment', '--output', '--rate-mode', '--fixed-rate', '--rate-source', '--minimum-rate', '--maximum-rate', '--iterations']
    : type === 'inspect' ? ['--alignment'] : type === 'export' ? ['--experiment', '--output', '--format'] : ['--experiment', '--output'];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!allowed.includes(key) || values.has(key)) throw new Error(`Unsupported or repeated option: ${key}`);
    if (key === '--demo' || key === '--date-independent' || key === '--demo-dates') { values.set(key, 'true'); continue; }
    const value = rest[++i];
    if (!value || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a printable value for ${key}.`);
    values.set(key, value);
  }
  const required = (key: string): string => { const value = values.get(key); if (!value) throw new Error(`Missing ${key}.`); return value; };
  if (type === 'inspect') return { type, alignment: required('--alignment') };
  if (type === 'root') {
    if (!values.has('--date-independent')) throw new Error('Declare --date-independent for both outgroup choice and branch placement.');
    const fraction = required('--fraction');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(fraction)) throw new Error('--fraction requires an explicit decimal between 0 and 1.');
    const rooting = resolveOutgroupRooting({ outgroup: required('--outgroup').split(','), fractionFromOutgroup: Number(fraction),
      evidence: required('--rooting-evidence'), dateIndependent: true });
    return { type, experiment: required('--experiment'), output: required('--output'), rooting };
  }
  if (type === 'temporal') {
    if (!values.has('--date-independent')) throw new Error('Declare --date-independent for alignment/cohort selection, inference and rooting.');
    const number = (key: string, fallback: number): number => {
      const value = values.get(key); if (value === undefined) return fallback;
      if (!/^\d+$/.test(value)) throw new Error(`${key} requires a nonnegative decimal integer.`);
      return Number(value);
    };
    const scheme = values.get('--scheme') ?? 'unrestricted';
    if (scheme !== 'unrestricted' && scheme !== 'within-groups') throw new Error('--scheme must be unrestricted or within-groups.');
    const options = resolveTemporalOptions({ permutations: number('--permutations', 999), seed: number('--seed', 42),
      permutationScheme: scheme, excludedSamples: values.has('--exclude')
        ? values.get('--exclude')!.split(',').map(value => value.trim()).filter(Boolean) : [] });
    return { type, experiment: required('--experiment'), dates: required('--dates'), output: required('--output'),
      metadata: { name: required('--name'), kind: values.has('--demo-dates') ? 'demo' : 'local',
        description: required('--source'), reference: values.get('--reference') ?? null, license: required('--license'), dateIndependent: true },
      options };
  }
  if (type === 'date') {
    const decimal = (key: string, fallback: number): number => {
      const value = values.get(key); if (value === undefined) return fallback;
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw new Error(`${key} requires a positive decimal number.`);
      return Number(value);
    };
    const rateMode = (values.get('--rate-mode') ?? 'estimate') as DatingOptions['rateMode'];
    if (rateMode !== 'estimate' && rateMode !== 'fixed') throw new Error('--rate-mode must be estimate or fixed.');
    const iterations = values.get('--iterations');
    if (iterations !== undefined && !/^\d+$/.test(iterations)) throw new Error('--iterations requires a positive decimal integer.');
    const options = resolveDatingOptions({ rateMode,
      fixedRate: values.has('--fixed-rate') ? decimal('--fixed-rate', 0) : null,
      rateSource: values.get('--rate-source') ?? null,
      minimumRate: decimal('--minimum-rate', 1e-10), maximumRate: decimal('--maximum-rate', 1),
      maxIterations: iterations === undefined ? 10000 : Number(iterations) });
    return { type, experiment: required('--experiment'), output: required('--output'), options };
  }
  if (type === 'replay') return { type, experiment: required('--experiment'), ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (format !== 'newick' && format !== 'distances' && format !== 'splits' && format !== 'dated-newick') throw new Error('Export format must be newick, distances, splits or dated-newick.');
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
type ReplayablePhylogeny = AlignedPhylogenyExperiment | RootedPhylogenyExperiment | RootedTemporalExperiment | RootedDatingExperiment;
function summary(experiment: ReplayablePhylogeny, verified: boolean): Record<string, unknown> {
  if ('datingRecord' in experiment) return { resultId: experiment.datingRecord.resultId, method: experiment.datingRecord.method, verified,
    temporalResultId: experiment.record.resultId, status: experiment.dating.status, rate: experiment.dating.rate,
    rootDate: experiment.dating.rootDate, exactTips: experiment.dating.exactTips, intervalTips: experiment.dating.intervalTips,
    residualRMSE: experiment.dating.rootMeanSquaredResidual, certificate: experiment.dating.certificate,
    clockValidated: experiment.dating.clockValidated, uncertainty: experiment.dating.uncertainty, warnings: experiment.dating.warnings };
  if ('rootedSource' in experiment) return { resultId: experiment.record.resultId, method: experiment.record.method, verified,
    rootedResultId: experiment.rootedResultId, unrootedResultId: experiment.unrootedResultId,
    tips: experiment.result.tips.length, regression: experiment.result.regression, randomization: experiment.result.randomization,
    clockCalibrated: experiment.result.clockCalibrated, warnings: experiment.result.warnings };
  const original = 'unrooted' in experiment ? experiment.unrooted : experiment;
  const { result, source, options } = original;
  return { resultId: experiment.record.resultId, method: experiment.record.method, verified, source: { name: source.name, kind: source.kind }, options,
    taxa: result.taxa, alignmentSites: result.alignmentSites, usedSites: result.usedSites, variableSites: result.variableSites,
    excludedColumns: result.excludedColumns.length, negativeEdges: result.negativeEdges, bootstrap: result.bootstrap,
    distanceResidualRMSE: result.distanceResidualRMSE, warnings: 'unrooted' in experiment ? [...result.warnings, ...experiment.result.warnings] : result.warnings,
    ...('unrooted' in experiment ? { sourceResultId: experiment.result.sourceResultId, rooting: experiment.result.rooting,
      distancePreservation: experiment.result.distancePreservation } : {}) };
}
/** Inspect only the method selector here; the selected replay verifies all inputs AND outputs. */
async function replay(content: string): Promise<ReplayablePhylogeny> {
  const value: unknown = JSON.parse(content);
  const method = value && typeof value === 'object' && 'method' in value ? value.method : null;
  const id = method && typeof method === 'object' && 'id' in method ? method.id : null;
  if (id === ROOTED_DATING_METHOD.id) return replayRootedDatingExperiment(content);
  if (id === ROOTED_TEMPORAL_METHOD.id) return replayRootedTemporalExperiment(content);
  if (id === ROOTED_PHYLOGENY_METHOD.id) return replayRootedPhylogenyExperiment(content);
  return replayAlignedPhylogenyExperiment(content);
}
function replayRecord(experiment: ReplayablePhylogeny): AnalysisRecord {
  return 'datingRecord' in experiment ? experiment.datingRecord : experiment.record;
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
  if (command.type === 'root') {
    const rooted = await rootAlignedPhylogenyExperiment(await readPhylogenyInput(command.experiment, 10 * 1024 * 1024), command.rooting);
    await writeOutput(command.output, serializeAnalysisRecord(rooted.record));
    return summary(rooted, false);
  }
  if (command.type === 'temporal') {
    const sampleTable = await readPhylogenyInput(command.dates, 2 * 1024 * 1024);
    const experiment = await createRootedTemporalExperiment(await readPhylogenyInput(command.experiment, 10 * 1024 * 1024),
      { ...command.metadata, sampleTable }, command.options);
    await writeOutput(command.output, serializeAnalysisRecord(experiment.record));
    return summary(experiment, false);
  }
  if (command.type === 'date') {
    const experiment = await createRootedDatingExperiment(await readPhylogenyInput(command.experiment, 10 * 1024 * 1024), command.options);
    await writeOutput(command.output, serializeAnalysisRecord(experiment.datingRecord));
    return summary(experiment, false);
  }
  const experiment = await replay(await readPhylogenyInput(command.experiment, 10 * 1024 * 1024));
  if (command.type === 'replay') {
    if (command.output) await writeOutput(command.output, serializeAnalysisRecord(replayRecord(experiment)));
  } else {
    if (command.format === 'dated-newick') {
      if (!('datingRecord' in experiment)) throw new Error('dated-newick export requires a verified strict-clock dating record.');
      await writeOutput(command.output, exportDatedNewick(experiment.dating) + '\n');
      return summary(experiment, true);
    }
    if ('rootedSource' in experiment) throw new Error('Temporal/dating records support dated-newick only after strict-clock fitting; use their JSON record for diagnostics.');
    const original = 'unrooted' in experiment ? experiment.unrooted : experiment;
    const { result } = original;
    const content = command.format === 'newick' ? experiment.result.newick + '\n' : command.format === 'splits'
      ? JSON.stringify({ resultId: experiment.record.resultId, bootstrap: result.bootstrap, splits: result.splits, warnings: result.warnings,
        ...('unrooted' in experiment ? { sourceResultId: original.record.resultId, rooting: experiment.result.rooting,
          rootingWarnings: experiment.result.warnings, supportScope: 'Original unrooted splits; no root-placement support.' } : {}) }, null, 2) + '\n'
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
