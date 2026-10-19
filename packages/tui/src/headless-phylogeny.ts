/** Private, database-free aligned phylogeny jobs. Numerical work runs in a terminable worker. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { ALIGNED_PHYLOGENY_METHOD, PHYLOGENY_LIMITS, createAlignedPhylogenyExperiment, parseAlignedDNA,
  replayAlignedPhylogenyExperiment, resolvePhylogenyOptions, type AlignedPhylogenyExperiment,
  type PhylogenyOptions, type PhylogenySource } from '../../core/src/analysis/aligned-phylogeny';
import { exportPhylogeny, PHYLOGENY_EXPORT_FORMATS, type PhylogenyExportFormat } from '../../core/src/analysis/phylogeny-export';
import { ROOTED_PHYLOGENY_METHOD, rootAlignedPhylogenyExperiment, replayRootedPhylogenyExperiment,
  type RootedPhylogenyExperiment } from '../../core/src/analysis/phylogeny-rooting';
import { serializeAnalysisRecord } from '../../core/src/analysis-result';
import type { RootedTemporalExperiment, RootedDatingExperiment, RootedTemporalMetadata } from '../../core/src/analysis/phylogeny-temporal';

export const HEADLESS_PHYLOGENY_FORMATS = [...PHYLOGENY_EXPORT_FORMATS, 'unrooted-newick', 'rooting-json',
  'dated-newick', 'temporal-tsv', 'dates-tsv', 'samples-table'] as const;
export type HeadlessPhylogenyFormat = typeof HEADLESS_PHYLOGENY_FORMATS[number];
export const PHYLOGENY_HELP = `Aligned DNA phylogeny, private computation and verified exports

bun run phylogeny inspect --input aligned.fa
bun run phylogeny infer --input aligned.fa --alignment provided
  --name NAME --reference ALIGNMENT_PROVENANCE --output NEW_EXPERIMENT.json
  [--source local|demo] [--distance p-distance|jc69] [--bootstrap 0|20..200]
  [--seed 1] [--timeout-ms 300000]
bun run phylogeny root --experiment unrooted.json --rooting decision.json
  --output NEW_ROOTED_EXPERIMENT.json [--timeout-ms 300000]
bun run phylogeny temporal --experiment rooted.json --metadata cohort.json
  --samples dates.tsv [--options temporal-options.json] --output NEW_TEMPORAL.json
  [--timeout-ms 300000]
bun run phylogeny date --experiment temporal.json [--options dating-options.json]
  --output NEW_DATING.json [--timeout-ms 300000]
bun run phylogeny verify --experiment experiment.json [--output NEW_COPY.json]
  [--timeout-ms 300000]
bun run phylogeny export --experiment experiment.json --format FORMAT --output NEW_FILE
  [--timeout-ms 300000]
  FORMAT: newick|unrooted-newick|distances-tsv|splits-tsv|alignment-fasta|rooting-json
          dated-newick|temporal-tsv|dates-tsv|samples-table

Input is an ALREADY ALIGNED homologous DNA FASTA, not raw genomes or proteins.
--alignment provided is a declaration, not an automatic alignment or homology test.
3-64 unique taxa, at most 100000 columns and 2 MiB; the shared computation budget
also applies. Complete deletion removes a column when any taxon has a gap,
ambiguous base or missing value. No usable columns and saturated JC69 fail.
Defaults are observed p-distance, no bootstrap, and seed 1. Bootstrap resamples
retained columns; any saturated replicate withholds ALL support, not just that
replicate. Linked sites and recombination limit its interpretation.

infer creates an unrooted neighbor-joining tree. root requires an explicit JSON
decision with exactly: outgroup (array of sample IDs), fractionFromOutgroup
(number strictly between 0 and 1), evidence (nonempty text), dateIndependent
(true). No outgroup, midpoint or scientific justification is assumed. The
separating edge must be positive and all original branches nonnegative; the
existing core rejects unsuitable trees rather than clipping or rearranging them.
Rooting retains every taxon, the original alignment, settings and pairwise paths.
It is a user-conditioned root hypothesis, not an independently inferred ancestor.
Decision files are limited to 64 KiB and decoded as strict UTF-8.

temporal joins collection dates to a VERIFIED JC69 rooted experiment. cohort.json
requires exactly name, kind (local|demo), description, reference (text|null),
license and dateIndependent (true: dates did not guide cohort/alignment selection
or rooting). --samples supplies the ORIGINAL CSV/TSV; do not embed sampleTable
in metadata. Required headers: sampleId,collectionDate,dateSource; optional
accession,permutationGroup. IDs join exactly, never by row order. Bare YYYY and
YYYY-MM remain uncertain; only exact dates enter diagnostics. Demo provenance
from either source is retained. Samples are limited to 2 MiB; metadata/settings
to 64 KiB. Settings use the existing core JSON option names, not executable code.
Temporal defaults: permutations=999, seed=42, permutationScheme=unrestricted,
excludedSamples=[]. A settings file can override any of these fields.

date fits the ORIGINAL branch lengths from a linked temporal experiment under a
conditional strict clock, retaining the alignment and all parent evidence. Its
settings are rateMode (estimate|fixed), fixedRate, rateSource, minimumRate,
maximumRate and maxIterations. Defaults: estimate, null, null, 1e-10, 1, 10000.
Fixed mode requires an explicit rate and source. Diagnostic exclusions DO NOT
prune the clock fit. All tips need sourced dates/intervals. No clock validation,
confidence intervals or population inference is claimed. Boundary/unresolved
fits retain a replayable record and explicit status, but publish no node dates.

verify and export recognize unrooted, rooted, linked temporal and linked dating
experiment JSON, including browser downloads. newick exports the recorded tree: [&U] for unrooted or [&R]
for an explicit root. Rooted Newick does not invent root or clade support labels;
splits-tsv and unrooted-newick retain the ORIGINAL unrooted bootstrap evidence.
unrooted-newick explicitly exports the parent tree, with internal support labels
as bootstrap PERCENTAGES when available, never clade probabilities. Splits TSV
reports fractions and counts; unavailable values are empty, not zero. Distance
TSV is a square matrix with # metadata comments. Root-derived table exports
identify both the parent inference and the selected rooted experiment.
rooting-json exports the exact resolved decision, and requires a rooted record.
The full experiment JSON retains all inputs, settings, masks and limitations and
can be restored in the browser. Newick/TSV are views, not replayable experiments.
alignment-fasta exports the exact original input, including its descriptions.
For linked records, newick is always the original rooted substitutions/site
phylogram, NEVER the time-scaled tree. dated-newick requires a fitted dating
record and explicitly exports durations in YEARS. Verification of a linked record
recomputes every stage; a successful replay is not evidence of clock adequacy.
temporal-tsv exports every tip, date bounds, exclusions and regression residuals;
missing numerical estimates are empty fields, not zero. dates-tsv requires a
fitted linked dating record and exports every node, original/fitted branch lengths,
calendar dates and durations, with original observations in substitutions/site
and durations in years. Both tables include method, parent and selected result
identities. Free-text columns ending in _json are JSON strings (or literal null),
not ordinary unquoted text; parse them as JSON to recover quotes and backslashes.
Formula-marker characters in text are Unicode-escaped inside JSON strings.
Numbers are not rounded. These are data tables,
not complete experiment records or confidence intervals. samples-table recovers
the exact original CSV/TSV bytes, including a BOM and line endings when supplied.
All three formats require a linked temporal or dating experiment.

verify and EVERY export recompute the saved analysis and compare full identities,
not just checksums. No catalog, database or network is used. Inputs/exports contain
private sequences and are not anonymized. Stdout summaries omit sequence bases
and free-text provenance. Only date performs conditional clock fitting.
Output is created exclusively with owner-only permissions; existing files and
symlinks are never overwritten. Failed disk writes may leave a partial new file.
Timeout or interruption terminates computation before output creation. Use a new
output path for each run. inspect validates shape, not biological homology.
`;

interface JobOptions { timeoutMs: number }
export type PhylogenyCommand = { type: 'help' }
  | ({ type: 'inspect'; inputPath: string } & JobOptions)
  | ({ type: 'infer'; inputPath: string; outputPath: string; source: Omit<PhylogenySource, 'fasta'>; options: PhylogenyOptions } & JobOptions)
  | ({ type: 'root'; experimentPath: string; rootingPath: string; outputPath: string } & JobOptions)
  | ({ type: 'temporal'; experimentPath: string; metadataPath: string; samplesPath: string; optionsPath?: string; outputPath: string } & JobOptions)
  | ({ type: 'date'; experimentPath: string; optionsPath?: string; outputPath: string } & JobOptions)
  | ({ type: 'verify'; experimentPath: string; outputPath?: string } & JobOptions)
  | ({ type: 'export'; experimentPath: string; outputPath: string; format: HeadlessPhylogenyFormat } & JobOptions);
export type PhylogenyTask = { type: 'inspect'; content: string }
  | { type: 'infer'; content: string; source: Omit<PhylogenySource, 'fasta'>; options: PhylogenyOptions }
  | { type: 'root'; content: string; rootingContent: string }
  | { type: 'temporal'; content: string; metadataContent: string; sampleTable: string; optionsContent?: string }
  | { type: 'date'; content: string; optionsContent?: string }
  | { type: 'verify'; content: string }
  | { type: 'export'; content: string; format: HeadlessPhylogenyFormat };
export interface PhylogenyTaskResult { summary: Record<string, unknown>; output?: string }
export type PhylogenyWorkerReply = { ok: true; value: PhylogenyTaskResult } | { ok: false; error: string };
const RECORD_BYTES = 10 * 1024 * 1024;
const ROOTING_BYTES = 64 * 1024;

export function parsePhylogenyCommand(args: readonly string[]): PhylogenyCommand {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (!['inspect', 'infer', 'root', 'temporal', 'date', 'verify', 'export'].includes(type)) throw new Error('Choose inspect, infer, root, temporal, date, verify or export. Use --help for usage.');
  const allowed = type === 'inspect' ? ['--input', '--timeout-ms'] : type === 'infer'
    ? ['--input', '--alignment', '--name', '--reference', '--source', '--distance', '--bootstrap', '--seed', '--output', '--timeout-ms']
    : type === 'root' ? ['--experiment', '--rooting', '--output', '--timeout-ms']
    : type === 'temporal' ? ['--experiment', '--metadata', '--samples', '--options', '--output', '--timeout-ms']
    : type === 'date' ? ['--experiment', '--options', '--output', '--timeout-ms']
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
  if (type === 'root') return { type, experimentPath: required('--experiment'), rootingPath: required('--rooting'), outputPath: required('--output'), timeoutMs };
  if (type === 'temporal' || type === 'date') {
    const common = { experimentPath: required('--experiment'), outputPath: required('--output'), timeoutMs,
      ...(flags.has('--options') ? { optionsPath: required('--options') } : {}) };
    return type === 'temporal' ? { type, ...common, metadataPath: required('--metadata'), samplesPath: required('--samples') }
      : { type, ...common };
  }
  if (type === 'verify') return { type, experimentPath: required('--experiment'), timeoutMs,
    ...(flags.has('--output') ? { outputPath: required('--output') } : {}) };
  if (type === 'export') {
    const format = required('--format');
    if (!(HEADLESS_PHYLOGENY_FORMATS as readonly string[]).includes(format)) throw new Error(`--format must be ${HEADLESS_PHYLOGENY_FORMATS.join(', ')}.`);
    return { type, experimentPath: required('--experiment'), outputPath: required('--output'), format: format as HeadlessPhylogenyFormat, timeoutMs };
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
function summarizeRooted(experiment: RootedPhylogenyExperiment): Record<string, unknown> {
  return { ...summarize(experiment.unrooted), method: ROOTED_PHYLOGENY_METHOD,
    resultId: experiment.record.resultId, cacheKey: experiment.record.cacheKey,
    unrootedResultId: experiment.unrooted.record.resultId, rooted: true,
    outgroupTaxa: experiment.result.rooting.outgroup.length,
    fractionFromOutgroup: experiment.result.rooting.fractionFromOutgroup,
    distancePreservation: experiment.result.distancePreservation,
    warnings: [...experiment.unrooted.result.warnings, ...experiment.result.warnings] };
}
function exportRooted(experiment: RootedPhylogenyExperiment, format: HeadlessPhylogenyFormat): string {
  if (format === 'newick') return `[&R]${experiment.result.newick}\n`;
  if (format === 'rooting-json') return JSON.stringify(experiment.result.rooting, null, 2) + '\n';
  if (format === 'dated-newick' || format === 'dates-tsv') throw new Error(`${format} requires a fitted linked dating experiment.`);
  if (format === 'temporal-tsv' || format === 'samples-table') throw new Error(`${format} requires a linked temporal or dating experiment.`);
  const parentFormat: PhylogenyExportFormat = format === 'unrooted-newick' ? 'newick' : format;
  const content = exportPhylogeny(experiment.unrooted, parentFormat);
  return format === 'distances-tsv' || format === 'splits-tsv'
    ? `# rooted_result_id\t${experiment.record.resultId}\n` + content : content;
}

function parseJobObject(content: string, context: string): Record<string, unknown> {
  if (typeof content !== 'string' || Buffer.byteLength(content) > ROOTING_BYTES) throw new Error(`${context} exceeds 64 KiB.`);
  const value: unknown = JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be a JSON object.`);
  return value as Record<string, unknown>;
}

/** Summaries deliberately omit sample IDs, sequence bases and free-text provenance. */
function summarizeLinked(experiment: RootedTemporalExperiment | RootedDatingExperiment): Record<string, unknown> {
  const { result, record, dataset } = experiment;
  const summary = { method: record.method, resultId: record.resultId, cacheKey: record.cacheKey,
    sourceKind: dataset.source.kind, rootedResultId: experiment.rootedResultId, unrootedResultId: experiment.unrootedResultId,
    taxa: result.tips.length, retainedTips: result.tips.filter(tip => !tip.exclusion).length,
    temporal: { permutations: result.options.permutations, seed: result.options.seed,
      permutationScheme: result.options.permutationScheme, excludedSamples: result.options.excludedSamples.length,
      slope: result.regression?.slope ?? null, r2: result.regression?.r2 ?? null,
      randomization: result.randomization, unavailableReason: result.unavailableReason,
      randomizationUnavailableReason: result.randomizationUnavailableReason }, warnings: result.warnings };
  if (!('datingRecord' in experiment)) return summary;
  const { dating, datingRecord } = experiment;
  return { ...summary, method: datingRecord.method, resultId: datingRecord.resultId, cacheKey: datingRecord.cacheKey,
    temporalResultId: record.resultId,
    dating: { status: dating.status, reason: dating.reason, rateMode: dating.options.rateMode,
      rate: dating.status === 'fitted' ? dating.rate : null, candidateRate: dating.rate,
      rootDate: dating.rootDate, exactTips: dating.exactTips, intervalTips: dating.intervalTips,
      sumSquaredResiduals: dating.sumSquaredResiduals, certificate: dating.certificate,
      clockValidated: dating.clockValidated, uncertainty: dating.uncertainty },
    warnings: [...result.warnings, ...dating.warnings] };
}

/** Lossless machine tables: numeric null is blank; free text is explicitly JSON encoded. */
function linkedTable(experiment: RootedTemporalExperiment | RootedDatingExperiment, format: 'temporal-tsv' | 'dates-tsv'): string {
  const record = 'datingRecord' in experiment ? experiment.datingRecord : experiment.record;
  const metadata = `# format\tphage-explorer-${format}\n# format_version\t1\n# method\t${record.method.id}\n# method_version\t${record.method.version}\n`
    + `# selected_result_id\t${record.resultId}\n# temporal_result_id\t${experiment.record.resultId}\n# rooted_result_id\t${experiment.rootedResultId}\n# unrooted_result_id\t${experiment.unrootedResultId}\n`
    + `# source_kind\t${experiment.dataset.source.kind}\n# date_unit\tdecimal_calendar_year\n# distance_unit\tsubstitutions/site\n# missing_numeric\tempty\n# text_encoding\tJSON_string_or_null_in_columns_ending_in_json\n`
    + '# clock_validated\tfalse\n# uncertainty\tnot-estimated\n';
  // Preserve exact strings while avoiding raw spreadsheet formula markers,
  // even when a TSV reader strips the JSON string's outer quotation marks.
  const jsonText = (value: string | null): string => JSON.stringify(value).replace(/[=+@-]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const row = (values: Array<string | number | boolean | null | undefined>) => values.map(value => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Cannot export a nonfinite numerical result.');
    const text = String(value);
    if (/[\t\r\n]/.test(text)) throw new Error('Table strings must be JSON encoded before export.');
    return text;
  }).join('\t');
  if (format === 'temporal-tsv') {
    const residuals = new Map(experiment.result.regression?.residuals.map(value => [value.id, value]));
    const header = 'sample_id\taccession_json\texact_collection_year\tcollection_lower_year\tcollection_upper_year\troot_to_tip_distance\tincluded\texclusion_json\tpredicted_distance\tresidual\tleverage\tleave_one_out_slope\tdate_source_json\tpermutation_group_json';
    return metadata + '# analysis\tfixed-root exploratory diagnostics; not clock validation\n' + header + '\n'
      + experiment.result.tips.map(tip => {
        const fit = residuals.get(tip.id);
        return row([tip.id, jsonText(tip.accession), tip.date, tip.dateRange?.lower, tip.dateRange?.upper,
          tip.distance, tip.exclusion === null, jsonText(tip.exclusion), fit?.predicted, fit?.residual,
          fit?.leverage, fit?.leaveOneOutSlope, jsonText(tip.dateSource), jsonText(tip.group)]);
      }).join('\n') + '\n';
  }
  if (!('dating' in experiment) || experiment.dating.status !== 'fitted' || !experiment.dating.nodes.length) {
    throw new Error('dates-tsv requires a fitted linked dating experiment; unavailable node dates are not exported as zeros.');
  }
  const { dating } = experiment;
  const header = 'node_id\tparent_id\tlabel_json\tis_tip\tcalendar_year\tcollection_lower_year\tcollection_upper_year\tduration_years\tsource_length\tfitted_length\tresidual\tat_date_bound\tdate_source_json';
  return metadata + `# analysis\tconditional fixed-root strict-clock fit\n# rate_mode\t${dating.options.rateMode}\n# rate_substitutions_per_site_per_year\t${dating.rate}\n`
    + header + '\n' + dating.nodes.map(node => row([node.id, node.parentId, jsonText(node.label), node.isTip, node.date,
      node.dateRange?.lower, node.dateRange?.upper, node.duration, node.sourceLength, node.fittedLength,
      node.residual, node.atDateBound, jsonText(node.dateSource)])).join('\n') + '\n';
}

async function linkedOutput(experiment: RootedTemporalExperiment | RootedDatingExperiment,
  format?: HeadlessPhylogenyFormat): Promise<PhylogenyTaskResult> {
  const record = 'datingRecord' in experiment ? experiment.datingRecord : experiment.record;
  const summary = summarizeLinked(experiment);
  if (!format) return { summary, output: serializeAnalysisRecord(record) };
  if (format === 'samples-table') return { summary, output: experiment.rootedSource.metadata.sampleTable };
  if (format === 'temporal-tsv' || format === 'dates-tsv') return { summary, output: linkedTable(experiment, format) };
  if (format === 'newick') return { summary, output: `[&R][&branch_units=substitutions/site]\n${experiment.dataset.tree.newick}\n` };
  if (format === 'dated-newick') {
    if (!('dating' in experiment)) throw new Error('dated-newick requires a fitted linked dating experiment.');
    const { exportDatedNewick } = await import('../../core/src/analysis/strict-clock');
    return { summary, output: exportDatedNewick(experiment.dating) };
  }
  // The verified temporal API retains the parent record, not the full parent
  // object. Replay it only when an original-inference export actually needs it.
  const rooted = await replayRootedPhylogenyExperiment(experiment.rootedSource.content);
  const output = exportRooted(rooted, format);
  return { summary, output: format === 'distances-tsv' || format === 'splits-tsv'
    ? `# selected_result_id\t${record.resultId}\n` + output : output };
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
  if (task.type === 'temporal' || task.type === 'date') {
    // These task fields are strings; capture them before a dynamic import yields.
    const request = { ...task };
    if (typeof request.content !== 'string' || Buffer.byteLength(request.content) > RECORD_BYTES) throw new Error('Saved phylogeny exceeds 10 MiB.');
    const options = parseJobObject(request.optionsContent === undefined ? '{}' : request.optionsContent, 'Analysis settings');
    const api = await import('../../core/src/analysis/phylogeny-temporal');
    if (request.type === 'date') return linkedOutput(await api.createRootedDatingExperiment(request.content, options));
    const metadata = parseJobObject(request.metadataContent, 'Cohort metadata');
    if (Object.keys(metadata).sort().join('|') !== 'dateIndependent|description|kind|license|name|reference') {
      throw new Error('Cohort metadata requires exactly name, kind, description, reference, license and dateIndependent. Supply the date table through --samples.');
    }
    const input = { ...metadata, sampleTable: request.sampleTable } as unknown as RootedTemporalMetadata;
    return linkedOutput(await api.createRootedTemporalExperiment(request.content.replace(/^\uFEFF/, ''), input, options));
  }
  if (task.type === 'root') {
    if (typeof task.rootingContent !== 'string' || Buffer.byteLength(task.rootingContent) > ROOTING_BYTES) throw new Error('Rooting decision exceeds 64 KiB.');
    const decision = JSON.parse(task.rootingContent.replace(/^\uFEFF/, ''));
    const experiment = await rootAlignedPhylogenyExperiment(task.content.replace(/^\uFEFF/, ''), decision);
    return { summary: summarizeRooted(experiment), output: serializeAnalysisRecord(experiment.record) };
  }
  if (task.type !== 'infer') {
    if (Buffer.byteLength(task.content) > RECORD_BYTES) throw new Error('Saved phylogeny exceeds 10 MiB.');
    const content = task.content.replace(/^\uFEFF/, ''), parsed: unknown = JSON.parse(content);
    const method = parsed && typeof parsed === 'object' && 'method' in parsed ? parsed.method : null;
    if (method && typeof method === 'object' && 'id' in method
      && (method.id === 'rooted-nj-temporal-signal' || method.id === 'rooted-nj-strict-clock-dating')) {
      const api = await import('../../core/src/analysis/phylogeny-temporal');
      const experiment = method.id === api.ROOTED_DATING_METHOD.id
        ? await api.replayRootedDatingExperiment(content) : await api.replayRootedTemporalExperiment(content);
      return linkedOutput(experiment, task.type === 'export' ? task.format : undefined);
    }
    if (method && typeof method === 'object' && 'id' in method && method.id === ROOTED_PHYLOGENY_METHOD.id) {
      const experiment = await replayRootedPhylogenyExperiment(content);
      return { summary: summarizeRooted(experiment), output: task.type === 'export'
        ? exportRooted(experiment, task.format) : serializeAnalysisRecord(experiment.record) };
    }
  }
  const experiment = task.type === 'infer'
    ? await createAlignedPhylogenyExperiment({ ...task.source, fasta: task.content }, task.options)
    : await replayAlignedPhylogenyExperiment(task.content.replace(/^\uFEFF/, ''));
  if (task.type === 'export' && (task.format === 'dated-newick' || task.format === 'dates-tsv')) throw new Error(`${task.format} requires a fitted linked dating experiment.`);
  if (task.type === 'export' && (task.format === 'temporal-tsv' || task.format === 'samples-table')) throw new Error(`${task.format} requires a linked temporal or dating experiment.`);
  if (task.type === 'export' && task.format === 'rooting-json') throw new Error('rooting-json requires an explicitly rooted experiment.');
  return { summary: summarize(experiment), output: task.type === 'export'
    ? exportPhylogeny(experiment, task.format === 'unrooted-newick' ? 'newick' : task.format as PhylogenyExportFormat)
    : serializeAnalysisRecord(experiment.record) };
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
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) { reject(new Error('Task timeout must be from 1 to 3600000 ms.')); return; }
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
    try { if (signal?.aborted) onAbort(); else worker.postMessage(task); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
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
    : command.type === 'root' ? { type: 'root', content, rootingContent: await readBounded(command.rootingPath, ROOTING_BYTES) }
    : command.type === 'temporal' ? { type: 'temporal', content,
      metadataContent: await readBounded(command.metadataPath, ROOTING_BYTES),
      sampleTable: await readBounded(command.samplesPath, PHYLOGENY_LIMITS.bytes, true),
      optionsContent: command.optionsPath ? await readBounded(command.optionsPath, ROOTING_BYTES) : '{}' }
    : command.type === 'date' ? { type: 'date', content,
      optionsContent: command.optionsPath ? await readBounded(command.optionsPath, ROOTING_BYTES) : '{}' }
    : command.type === 'export' ? { type: 'export', content, format: command.format } : { type: command.type, content };
  signal?.throwIfAborted();
  const result = await executePhylogenyTask(task, command.timeoutMs, signal);
  signal?.throwIfAborted();
  if ('outputPath' in command && command.outputPath !== undefined) {
    if (result.output === undefined) throw new Error('Phylogeny worker returned no export.');
    const file = await open(command.outputPath, 'wx', 0o600);
    try { await file.writeFile(result.output, 'utf8'); await file.sync(); } finally { await file.close(); }
  }
  return result.summary;
}
