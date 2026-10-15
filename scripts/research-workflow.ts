#!/usr/bin/env bun
/** Headless replay of browser research tapes, with interruptible private computation. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS, parseCommandTape, parseCommandPlan, commandValuesEqual, type CommandPlan } from '../packages/core/src/command-session';
import { analysisJson, parseAnalysisRecord } from '../packages/core/src/analysis-result';
import { WORKFLOW_RESULTS_LIMITS, parseWorkflowResults, workflowResultIndex, type WorkflowResults } from '../packages/core/src/workflow-results';
import { resolveGCSkewOptions } from '../packages/core/src/analysis/gc-skew';
import { resolveExactRepeatOptions } from '../packages/core/src/analysis/exact-repeat-pairs';
import { validateTerminalResearchRequest, validateTerminalAnalysis, isTerminalGenomeSummary, terminalAnalysisRequestSha256, terminalAnalysisParametersMatch, terminalSequenceSummary,
  terminalResultsInspection, terminalResultExtraction,
  type TerminalAnalysis, type TerminalResearchRequest, type TerminalResearchResult,
  type TerminalResearchMessage } from '../packages/tui/src/research-replay.worker';
import type { ReplayProgress } from '../packages/tui/src/research-replay';

// Build-time path only; never supplied by an input file or environment variable.
declare const PHAGE_RESEARCH_WORKER: string | undefined;

export const RESEARCH_WORKFLOW_HELP = `Replay recorded research locally, without a database or browser

bun run workflow growth-template [--version 1|2]
bun run workflow fit-growth --input plates.json [--output NEW_FILE]
bun run workflow fit-pfu-growth --input corrected-pfu.json [--output NEW_FILE]
  [--format json|tsv] [--timeout-ms 300000]
bun run workflow inspect --input workflow.json [--timeout-ms 300000]
bun run workflow record --input plan.json --output NEW_WORKFLOW.json
  [--results] [--timeout-ms 300000] [--progress]
bun run workflow replay --input workflow.json [--repetitions 1] [--output analysis.json]
  [--results] [--timeout-ms 300000] [--progress]
bun run workflow replay-results --input complete-results.json [--output NEW_RESULTS.json]
  [--timeout-ms 300000] [--progress]
bun run workflow inspect-results --input complete-results.json [--timeout-ms 300000]
bun run workflow extract-result --input complete-results.json --execution 2
  --output NEW_ANALYSIS.json [--timeout-ms 300000]
bun run workflow replay-experiment --input experiment.json [--output NEW_FILE]
  [--format json|tsv] [--timeout-ms 300000]
bun run workflow inspect-genomes --input genomes.fa
bun run workflow list-enzymes
bun run workflow analyze-experiment --input genomes.fa --method dot-plot
  [--record CONTENT_ID] [--bins 120] [--window BP] [--output NEW_FILE]
  [--format json|tsv] [--timeout-ms 300000]
bun run workflow analyze-experiment --input genomes.fa --method pairwise-dot-plot
  --record ROW_CONTENT_ID --compare-record COLUMN_CONTENT_ID
  [--bins 120] [--window BP] [--output NEW_FILE] [--format json|tsv]
  [--timeout-ms 300000]
bun run workflow analyze-experiment --input genome.gb --method restriction-digest
  --enzymes EcoRI,BamHI --topology linear|circular [--record CONTENT_ID]
  [--output NEW_FILE] [--format json|tsv] [--timeout-ms 300000]
bun run workflow analyze-experiment --input genome.fa --method gc-skew
  [--window BP] [--step BP] [--record CONTENT_ID] [--output NEW_FILE]
  [--format json|tsv] [--timeout-ms 300000]
bun run workflow analyze-experiment --input genome.fa --method exact-repeats
  --topology linear|circular [--arm-length BP] [--max-gap BP] [--max-pairs COUNT]
  [--record CONTENT_ID] [--output NEW_FILE] [--format json|tsv] [--timeout-ms 300000]

--results changes the record/replay output to a complete workflow-results JSON
archive, preserving the exact tape and every distinct analysis in first-execution
order. It requires --output. Identical records are stored once; every repeated
execution keeps its own step number. Navigation is not an analysis. Default
record/replay output remains the command tape / last analysis respectively.
replay-results validates the whole archive then recomputes every original command
using the saved repetition count; it never regenerates failed expected results.
All archive records and their execution bindings are checked before file creation.
Only complete archives may use the 32 MiB input/output limit; the 10 MiB individual
tape/analysis limits remain unchanged. Archives contain private genomes and
annotations and are not anonymized. No partial archive is returned on computation
failure, retention-limit failure or cancellation.
inspect-results lists all ordered executions and record identities without running
methods or printing raw sequences. extract-result copies the selected 1-based
execution's AnalysisRecord JSON; navigation steps have no analysis to extract.
Both check complete-archive integrity, but neither claims numerical replay or
method availability. Extracted records retain their original private inputs and
can be used with the existing compatible analysis viewers/replay-experiment.

fit-pfu-growth accepts the existing one-step-growth-v1 corrected extracellular
PFU/mL experiment JSON, with explicit provenance, observations, denominator,
bootstrapSamples and seed. It uses equal-row least squares, not plate-count
likelihood. Legacy exports with a result field are numerically checked; a changed
saved result fails rather than being silently regenerated. Output is the shared
AnalysisRecord format (or --format tsv), and replay-experiment recomputes its
complete fit and conditional residual-bootstrap intervals. Bootstrap work runs
in the isolated worker; no raw counts or exposures are inferred from PFU/mL.

fit-growth accepts version-1 or version-2 phage-explorer-plaque-growth-input JSON with an
explicit extracellular-plaque-counts assay, title, source provenance, embedded
CSV and options. growth-template prints a SYNTHETIC format example; no files are
read or written by that operation. CSV columns are time_min,plaque_count,
dilution_fraction,volume_ml. Version 2 adds the required count_status column:
exact (N=k), at-most (N<=k), or at-least (N>=k). Bounds are inclusive; thresholds
are not exact counts. Bare TNTC without an explicit numeric bound is rejected.
A finite-upper observation at one of the last two times is required to bound
every candidate plateau. growth-template --version 2 prints a bounded example.
Use integer counts or thresholds, dilution FRACTIONS
and explicit plated mL; zero counts are real data, not missing values. Supply
6–2048 independent plates at 6–32 distinct times, at most 1,000,000 UTF-8 bytes.
options requires supportDeviance and infectedCentersPerMl (null when unmeasured).
The fit maximizes a Poisson exposure likelihood over observed-time ramps, retains
plate-level residuals and profiles increase over all candidate knots. A constant
curve in the support set withholds rise timing; grid-boundary support is flagged.
This is descriptive population growth, not single-cell latency or mechanistic
burst size. Likelihood support is NOT a calibrated confidence interval. Yield is
conditional on an independent infected-center denominator; its error is not
propagated. Dilution uncertainty, overdispersion, correlated plates, unknown
censoring mechanisms, secondary infection and phage loss are not modeled. JSON
retains original inputs and fits; replay-experiment recomputes and checks them.
Growth TSV distinguishes exact counts from inclusive bounds. Bound-plate residuals
are unavailable, not zero; their likelihood contributions are retained instead.
Neither export anonymizes measurements. Existing PFU curve fits
and demonstration growth methods are not silently reinterpreted as plate counts.

inspect-genomes accepts DNA FASTA, GenBank or a version-1 local genome bundle.
It reports unique record content IDs, sequence hashes, lengths, topology and
annotation/ambiguity coverage without computing an analysis or printing bases.
analyze-experiment uses the same importer and numerical methods as the browser.
For multiple unique records, --record must select the complete content ID from
inspect-genomes; neither file order nor a bundle's saved view selects implicitly.
Bins must be 1–200; an omitted window uses the core default, while an explicit
window must fit the selected sequence. Dot plots sample LINEAR windows even for
circular records. Input whitespace/case are normalized by the shared importer.
JSON can be restored in the browser or checked with replay-experiment. TSV is
coordinate/score output only, not a replayable experiment. No catalog is needed.

Pairwise analysis selects BOTH axes explicitly from the same multi-record input
or local-genome bundle. --record is row/Y; --compare-record is column/X. Both
require complete content IDs, not accessions or record positions. An explicit
window must fit both sequences; automatic windows use the shorter length.
The same ID on both axes is an explicit self-control, not an implicit fallback.
The two selected sequences together must fit the 5,000,000-base experiment limit.
JSON includes both full sequences. Comparisons count resolved matches, not
alignments, structural variants or biological validation.

Restriction digests require explicit --enzymes and --topology. list-enzymes reports
the actual bundled enzyme definitions; names are exact and comma-separated.
--enzymes none requests the uncut control. No enzyme or topology is guessed.
Known source topology must agree; for unknown topology the explicit choice is
reported as an assumption. This command does not simulate topology changes.
Circular cut products retain their origin-crossing coordinates. Results describe
ideal complete digestion, not methylation, partial digestion or measured mobility.

GC skew uses the portable counted-window method (v2). --window and --step resolve
through the shared core defaults (500 and one quarter of the chosen window).
Only complete linear windows are sampled. No-GC ratios are null (empty TSV cells),
not zero; a short sequence can have no windows. The report counts informative
windows. More than 20,000 windows fails rather than silently reducing resolution.

Exact repeats enumerate fixed-length, non-overlapping direct/inverted pairs with
resolved A/C/G/T arms. --arm-length, --max-gap and --max-pairs use shared defaults
8, 5000 and 2000; a zero gap is valid. Explicit topology must agree with known
source metadata, otherwise it is a reported assumption. Circular search wraps
the origin, uses shortest spacer arcs and exports traversal-ordered arm segments.
The report and TSV distinguish complete searches from truncated output prefixes.
Comparison-budget exhaustion fails the job. These are not maximal repeat families
or biological structure predictions. Neither new method changes the input bases.

inspect reparses embedded inputs and reports action support; no analyses run.
record creates a NEW recording from a version-1 phage-explorer-command-plan.
Plans contain name, context: {bundle: ORIGINAL_GENOME_BUNDLE_JSON}, and ordered
commands with only actionId and parameters. Use the existing canonical action IDs
and explicit content IDs/settings; expected results, file paths, shell commands,
implicit genome selection and nested execution are not supported. The whole plan
is validated before any computation. Recorded tapes cannot be used as plans.
Each command is computed through the same adapters as browser recording/replay;
new output identities are recorded, not supplied by the plan. The output is a
normal portable command tape that the browser and replay command can verify.
This is fresh authoring, not replay verification. All commands must finish before
the output is created; a failed command produces no partial tape or success report.
Plans and the completed tape must each fit 10 MiB; allow room for recorded outputs.

replay recomputes every supported command and checks its recorded output identity.
Supported: saved navigation, reference-backed and legacy illustrative codon analysis,
pangenome/CDS experiments, portable GC-skew counts, exact-pairs repeats, self/pairwise
dot plots and restriction digests. Source-corpus references are freshly
reparsed and recounted. Legacy browser-bound repeats and unknown actions are
rejected before any command executes. Navigation is headless, not a TUI rendering.

replay-experiment accepts self/pairwise dot-plot, restriction-digest, portable
GC-skew v2, linear/circular exact-repeat-pairs, plaque-count-growth and corrected-PFU growth JSON. Legacy accelerated GC-skew
v1 and sampled-repeat overview records are not relabeled as portable methods.
These records may be produced by the terminal or
exported by the browser. Pairwise replay preserves both ordered row/Y and column/X
inputs, sampled coordinates and independent coverage. It recomputes embedded inputs/settings with the same core
methods and verifies all saved evidence, not just file checksums. No catalog,
external source lookup or current browser selection is needed. Unsupported
methods/versions and changed outputs are rejected. This is numerical reproducibility,
not source authentication or biological validation. --format requires --output;
json (default) retains full source sequences, while tsv contains coordinates and
scores/cut products without source bases. The report never includes raw sequences.

The JSON report goes to stdout only on success. --output exclusively creates the
command tape for record, or the freshly computed/successfully replayed analysis
for other commands; it never writes the report.
Command-tape replay retains the last analysis's real step identity even when later
navigation occurs. Existing files/symlinks are never
replaced. No analysis output is written if computation/verification fails.
A failed or interrupted final disk write may leave a partial NEW file.

Inputs are regular UTF-8 files of at most 10 MiB, with 128 commands, 10 repetitions
and 256 executions maximum. Timeout is 1–3600000 ms (default 300000), including
input reading and final output handling. --progress emits metadata-only JSON lines
to stderr. Exit codes: 0 success, 1 failure, 124 timeout, 130 SIGINT, 143 SIGTERM.
Exported analysis JSON contains private sequences. No network or shell commands.
`;
export type WorkflowCommand = { type: 'help' } | { type: 'list-enzymes' } | { type: 'growth-template'; version: 1 | 2 } |
  { type: 'fit-growth'; input: string; output?: string; outputFormat: 'json' | 'tsv'; timeoutMs: number } |
  { type: 'fit-pfu-growth'; input: string; output?: string; outputFormat: 'json' | 'tsv'; timeoutMs: number } |
  { type: 'record'; input: string; output: string; timeoutMs: number; progress: boolean; allResults?: boolean } |
  { type: 'replay-results'; input: string; output?: string; timeoutMs: number; progress: boolean } |
  { type: 'inspect-results'; input: string; timeoutMs: number } |
  { type: 'extract-result'; input: string; output: string; execution: number; timeoutMs: number } |
  { type: 'inspect'; input: string; timeoutMs: number } |
  { type: 'inspect-genomes'; input: string; timeoutMs: number } |
  { type: 'analyze-experiment'; input: string; contentId: string | null; analysis: TerminalAnalysis;
    output?: string; outputFormat: 'json' | 'tsv'; timeoutMs: number } |
  { type: 'replay'; input: string; repetitions: number; output?: string; timeoutMs: number; progress: boolean; allResults?: boolean } |
  { type: 'replay-experiment'; input: string; output?: string; outputFormat: 'json' | 'tsv'; timeoutMs: number };
export function parseWorkflowCommand(args: readonly string[]): WorkflowCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  if (args.length === 1 && args[0] === 'list-enzymes') return { type: 'list-enzymes' };
  if (args[0] === 'growth-template') {
    if (args.length === 1) return { type: 'growth-template', version: 1 };
    if (args.length === 3 && args[1] === '--version' && (args[2] === '1' || args[2] === '2')) {
      return { type: 'growth-template', version: args[2] === '1' ? 1 : 2 };
    }
    throw new Error('Use growth-template with no options or exactly --version 1|2.');
  }
  const [type, ...rest] = args;
  if (type !== 'inspect' && type !== 'record' && type !== 'replay' && type !== 'replay-results' && type !== 'inspect-results' && type !== 'extract-result' && type !== 'replay-experiment' && type !== 'inspect-genomes' && type !== 'analyze-experiment' && type !== 'fit-growth' && type !== 'fit-pfu-growth') {
    throw new Error('Choose record, inspect, replay, replay-results, inspect-results, extract-result, replay-experiment, inspect-genomes, analyze-experiment, fit-growth or fit-pfu-growth; see --help.');
  }
  const allowed = type === 'extract-result' ? ['--input', '--output', '--execution', '--timeout-ms']
    : type === 'record' || type === 'replay-results' ? ['--input', '--timeout-ms', '--output'] : type === 'inspect' || type === 'inspect-genomes' || type === 'inspect-results' ? ['--input', '--timeout-ms'] : type === 'analyze-experiment'
    ? ['--input', '--timeout-ms', '--output', '--format', '--method', '--record', '--compare-record', '--bins', '--window', '--enzymes', '--topology', '--step', '--arm-length', '--max-gap', '--max-pairs'] : type === 'replay-experiment' || type === 'fit-growth' || type === 'fit-pfu-growth'
    ? ['--input', '--timeout-ms', '--output', '--format'] : ['--input', '--timeout-ms', '--output', '--repetitions'];
  const values = new Map<string, string>(); let progress = false, allResults = false;
  for (let i = 0; i < rest.length;) {
    const key = rest[i++];
    if (key === '--progress' && (type === 'replay' || type === 'record' || type === 'replay-results')) {
      if (progress) throw new Error('Repeated --progress flag.'); progress = true; continue;
    }
    if (key === '--results' && (type === 'record' || type === 'replay')) {
      if (allResults) throw new Error('Repeated --results flag.'); allResults = true; continue;
    }
    if (!allowed.includes(key) || values.has(key)) throw new Error(`Unsupported or repeated option: ${key}`);
    const value = rest[i++];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a value for ${key}.`);
    values.set(key, value);
  }
  const input = values.get('--input'); if (!input) throw new Error('Missing --input.');
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = values.get(key); if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    return Number(value);
  };
  const timeoutMs = integer('--timeout-ms', 300000, 3600000);
  if (allResults && !values.has('--output')) throw new Error('--results requires --output NEW_RESULTS.json.');
  if (type === 'replay-results') return { type, input, timeoutMs, progress,
    ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
  if (type === 'extract-result') {
    const output = values.get('--output');
    if (!output || !values.has('--execution')) throw new Error('extract-result requires --execution NUMBER and --output NEW_ANALYSIS.json.');
    return { type, input, output, timeoutMs, execution: integer('--execution', 1, COMMAND_LIMITS.executions) };
  }
  if (type === 'record') {
    const output = values.get('--output');
    if (!output) throw new Error('record requires --output NEW_WORKFLOW.json; authoring never replaces the plan.');
    return { type, input, output, timeoutMs, progress, ...(allResults ? { allResults: true } : {}) };
  }
  if (type === 'inspect' || type === 'inspect-genomes' || type === 'inspect-results') return { type, input, timeoutMs };
  if (type === 'replay-experiment' || type === 'analyze-experiment' || type === 'fit-growth' || type === 'fit-pfu-growth') {
    const outputFormat = values.get('--format') ?? 'json';
    if (outputFormat !== 'json' && outputFormat !== 'tsv') throw new Error('--format must be json or tsv.');
    if (values.has('--format') && !values.has('--output')) throw new Error('--format requires --output NEW_FILE.');
    if (type === 'analyze-experiment') {
      const method = values.get('--method');
      if (method !== 'dot-plot' && method !== 'pairwise-dot-plot' && method !== 'restriction-digest' && method !== 'gc-skew' && method !== 'exact-repeats') {
        throw new Error('Choose --method dot-plot, pairwise-dot-plot, restriction-digest, gc-skew or exact-repeats.');
      }
      const contentId = values.get('--record') ?? null;
      if (contentId !== null && !/^[a-f0-9]{64}$/.test(contentId)) throw new Error('--record requires a complete content ID from inspect-genomes.');
      let analysis: TerminalAnalysis;
      const methodFlags: Record<TerminalAnalysis['method'], readonly string[]> = {
        'dot-plot': ['--bins', '--window'], 'pairwise-dot-plot': ['--compare-record', '--bins', '--window'],
        'restriction-digest': ['--enzymes', '--topology'], 'gc-skew': ['--window', '--step'],
        'exact-repeats': ['--arm-length', '--max-gap', '--max-pairs', '--topology'],
      };
      for (const key of ['--compare-record', '--bins', '--window', '--enzymes', '--topology', '--step', '--arm-length', '--max-gap', '--max-pairs']) {
        if (values.has(key) && !methodFlags[method].includes(key)) throw new Error(`${key} is not an option for ${method}.`);
      }
      if (method !== 'pairwise-dot-plot' && values.has('--compare-record')) throw new Error('--compare-record is only valid for pairwise-dot-plot.');
      if (method === 'pairwise-dot-plot') {
        if (values.has('--enzymes') || values.has('--topology')) throw new Error('Enzymes and topology are restriction-digest options, not dot-plot options.');
        const columnContentId = values.get('--compare-record');
        if (contentId === null || typeof columnContentId !== 'string' || !/^[a-f0-9]{64}$/.test(columnContentId)) {
          throw new Error('Pairwise analysis requires --record ROW_CONTENT_ID and --compare-record COLUMN_CONTENT_ID from inspect-genomes.');
        }
        analysis = { method, columnContentId, bins: integer('--bins', 120, 200),
          window: values.has('--window') ? integer('--window', 1, 5000000) : null };
      } else if (method === 'dot-plot') {
        if (values.has('--enzymes') || values.has('--topology')) throw new Error('Enzymes and topology are restriction-digest options, not dot-plot options.');
        analysis = { method, bins: integer('--bins', 120, 200), window: values.has('--window') ? integer('--window', 1, 5000000) : null };
      } else if (method === 'gc-skew') {
        analysis = { method, ...resolveGCSkewOptions({
          ...(values.has('--window') ? { windowSize: integer('--window', 500, 1000000) } : {}),
          ...(values.has('--step') ? { stepSize: integer('--step', 1, 5000000) } : {}),
        }) };
      } else if (method === 'exact-repeats') {
        const topology = values.get('--topology');
        if (topology !== 'linear' && topology !== 'circular') throw new Error('Exact repeats require --topology linear|circular.');
        const gap = values.get('--max-gap');
        if (gap !== undefined && (!/^(0|[1-9]\d*)$/.test(gap) || !Number.isSafeInteger(Number(gap)) || Number(gap) > 100000)) {
          throw new Error('--max-gap must be an integer from 0 to 100000.');
        }
        analysis = { method, ...resolveExactRepeatOptions({
          ...(values.has('--arm-length') ? { armLength: integer('--arm-length', 8, 256) } : {}),
          ...(gap === undefined ? {} : { maxGap: Number(gap) }),
          ...(values.has('--max-pairs') ? { maxPairs: integer('--max-pairs', 2000, 20000) } : {}), topology,
        }), topology };
      } else {
        if (values.has('--bins') || values.has('--window')) throw new Error('Bins and window are dot-plot options, not restriction-digest options.');
        const enzymes = values.get('--enzymes'), topology = values.get('--topology');
        if (enzymes === undefined || (topology !== 'linear' && topology !== 'circular')) {
          throw new Error('Restriction analysis requires --enzymes NAMES|none and --topology linear|circular.');
        }
        analysis = { method, enzymes: enzymes === 'none' ? [] : enzymes.split(',').map(name => name.trim()), topology };
      }
      validateTerminalAnalysis(analysis);
      return { type, input, timeoutMs, contentId, analysis, outputFormat,
        ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
    }
    return { type, input, timeoutMs, outputFormat, ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
  }
  return { type, input, timeoutMs, progress, repetitions: integer('--repetitions', 1, COMMAND_LIMITS.repetitions),
    ...(allResults ? { allResults: true } : {}),
    ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
}
function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Research workflow cancelled.', 'AbortError');
}
export type TerminalWorker = Pick<Worker, 'on' | 'once' | 'off' | 'postMessage' | 'terminate'>;
export interface WorkflowRuntime {
  signal?: AbortSignal;
  onProgress?: (progress: ReplayProgress) => void;
  createWorker?: () => TerminalWorker;
}

/** Bind a newly authored tape to every submitted command and reported output.
 * This is transport/identity validation, not another numerical executor.
 */
function recordingMatches(value: Extract<TerminalResearchResult, { type: 'recorded' }>,
  plan: CommandPlan, planSha256: string, completed: number): boolean {
  const report = value.report, total = plan.commands.length;
  if (!report || report.format !== 'phage-explorer-workflow-recording' || report.version !== 1
    || report.headless !== true || 'verified' in report || report.name !== plan.name || report.planSha256 !== planSha256
    || completed !== total || total < 1 || report.completed !== total || !Array.isArray(report.steps)
    || report.steps.length !== total || typeof value.tapeJson !== 'string'
    || report.tapeSha256 !== createHash('sha256').update(value.tapeJson, 'utf8').digest('hex')) return false;
  const tape = parseCommandTape(value.tapeJson);
  if (tape.name !== plan.name || !commandValuesEqual(tape.context, plan.context) || tape.commands.length !== total) return false;
  for (let i = 0; i < total; i++) {
    const command = tape.commands[i], planned = plan.commands[i], step = report.steps[i];
    if (!step || command.actionId !== planned.actionId || !commandValuesEqual(command.parameters, planned.parameters)
      || step.execution !== i + 1 || step.step !== i + 1 || step.iteration !== 1 || step.actionId !== planned.actionId) return false;
    if (step.analysis !== null) {
      if (!step.analysis || !/^[a-f0-9]{64}$/.test(step.analysis.cacheKey) || !/^[a-f0-9]{64}$/.test(step.analysis.resultId)
        || !commandValuesEqual(command.expected, step.analysis)) return false;
    } else {
      const expected = command.expected;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || Object.keys(expected).sort().join('|') !== 'sequenceSha256|view'
        || typeof expected.sequenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sequenceSha256)
        || !commandValuesEqual(expected.view, step.view)) return false;
    }
  }
  let last: number | null = null;
  for (const step of report.steps) if (step.analysis !== null) last = step.execution;
  return report.lastAnalysisExecution === last && commandValuesEqual(report.finalView, report.steps[total - 1].view);
}

type CompleteResultReply = Extract<TerminalResearchResult, { type: 'recorded' | 'replayed' | 'results-replayed' }>;
/** Validate every returned record and execution before opening an output file.
 * Numerical recomputation belongs to the isolated worker, not this transport check.
 */
async function checkCompleteResults(value: CompleteResultReply, tapeJson: string, repetitions: number,
  signal: AbortSignal, saved?: WorkflowResults): Promise<void> {
  const text = value.type === 'results-replayed' ? value.archiveJson : value.allResultsJson;
  if (typeof text !== 'string') throw new Error('The complete workflow results were not returned.');
  const archive = await parseWorkflowResults(text, signal);
  abort(signal);
  if (archive.tapeJson !== tapeJson || archive.repetitions !== repetitions
    || saved !== undefined && !commandValuesEqual(archive, saved)) throw new Error('Complete results differ from the submitted workflow.');
  const index = workflowResultIndex(tapeJson, repetitions), tape = parseCommandTape(tapeJson), report = value.report;
  if (!report || report.version !== 1 || report.headless !== true || report.name !== tape.name
    || report.tapeSha256 !== createHash('sha256').update(tapeJson, 'utf8').digest('hex')
    || report.completed !== index.length || !Array.isArray(report.steps) || report.steps.length !== index.length) {
    throw new Error('Complete results differ from their execution report.');
  }
  let lastAnalysisExecution: number | null = null;
  for (let i = 0; i < index.length; i++) {
    const step = report.steps[i], expected = index[i];
    if (!step || !commandValuesEqual({ execution: step.execution, iteration: step.iteration,
      step: step.step, actionId: step.actionId, analysis: step.analysis }, expected)) {
      throw new Error(`Complete result execution ${i + 1} differs from the recorded analysis.`);
    }
    if (expected.analysis) lastAnalysisExecution = i + 1;
    else {
      const output = tape.commands[expected.step - 1].expected as { view: unknown };
      if (!commandValuesEqual(step.view, output.view)) throw new Error('Navigation output differs from the recorded view.');
    }
  }
  if (report.lastAnalysisExecution !== lastAnalysisExecution
    || !commandValuesEqual(report.finalView, report.steps[index.length - 1].view)) {
    throw new Error('Complete workflow results have an incorrect final analysis or view.');
  }
}

/** Each invocation owns exactly one worker; a late message cannot settle it twice.
 * Worker exit without a result is an error, including a zero exit code.
 */
export async function runTerminalResearchWorker(request: TerminalResearchRequest, signal: AbortSignal,
  onProgress: (progress: ReplayProgress) => void = () => {},
  createWorker: () => TerminalWorker = () => new Worker(new URL(
    typeof PHAGE_RESEARCH_WORKER === 'string' ? PHAGE_RESEARCH_WORKER : '../packages/tui/src/research-replay.worker.ts', import.meta.url))): Promise<TerminalResearchResult> {
  abort(signal);
  validateTerminalResearchRequest(request);
  const submitted = structuredClone(request);
  const plan = submitted.type === 'record' ? parseCommandPlan(submitted.content) : null;
  const saved = submitted.type === 'replay-experiment' ? await parseAnalysisRecord(submitted.content) : null;
  const archive = submitted.type === 'replay-results' || submitted.type === 'inspect-results' || submitted.type === 'extract-result'
    ? await parseWorkflowResults(submitted.content, signal)
    .catch(cause => { abort(signal); throw cause; }) : null;
  // Resolve extraction before allocation so navigation and invalid selection
  // cannot accidentally fall back to the last analysis in a worker response.
  const extracted = archive && submitted.type === 'extract-result'
    ? terminalResultExtraction(archive, createHash('sha256').update(submitted.content, 'utf8').digest('hex'), submitted.execution) : null;
  abort(signal);
  return new Promise((resolve, reject) => {
    abort(signal);
    const tape = archive ? parseCommandTape(archive.tapeJson)
      : submitted.type === 'inspect' || submitted.type === 'replay' ? parseCommandTape(submitted.content) : null;
    const total = archive ? tape!.commands.length * archive.repetitions
      : submitted.type === 'replay' ? tape!.commands.length * submitted.repetitions : plan?.commands.length ?? 0;
    const tapeSha256 = createHash('sha256').update(submitted.content, 'utf8').digest('hex');
    const worker = createWorker();
    let completed = 0;
    let done = false, validating = false;
    const finish = (result?: TerminalResearchResult, cause?: unknown) => {
      if (done) return; done = true;
      signal.removeEventListener('abort', cancelled);
      worker.off('message', message); worker.off('messageerror', messageError);
      // Keep error/exit handlers until actual exit, avoiding unhandled late errors.
      try { void worker.terminate().catch(() => {}); } catch { /* Settlement must not depend on teardown. */ }
      if (cause !== undefined) reject(cause); else resolve(result!);
    };
    const cancelled = () => {
      try { abort(signal); } catch (cause) { finish(undefined, cause); }
    };
    const error = (cause: Error) => finish(undefined, cause);
    const messageError = () => finish(undefined, new Error('Terminal research response could not be decoded.'));
    const exit = (code: number) => {
      // The one-shot worker closes its port after sending. Hash validation can
      // outlive that normal exit; it still obeys the parent's cancellation timer.
      if (code !== 0 || !validating) finish(undefined, new Error(`Terminal research worker exited (${code}) before returning a result.`));
      worker.off('error', error);
    };
    const acceptComplete = (value: CompleteResultReply, tapeJson: string, repetitions: number, savedResults?: WorkflowResults) => {
      validating = true;
      void checkCompleteResults(value, tapeJson, repetitions, signal, savedResults)
        .then(() => { abort(signal); finish(value); })
        .catch(cause => finish(undefined, cause));
    };
    const message = (value: TerminalResearchMessage) => {
      if (done || validating) return;
      try {
        abort(signal);
        if (value?.type === 'progress' && (submitted.type === 'replay' || submitted.type === 'record' || submitted.type === 'replay-results')) {
          const p = value.progress;
          if (!p || !['inputs', 'commands'].includes(p.phase) || !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total)
            || p.total !== total || p.total > COMMAND_LIMITS.executions || p.completed < completed || p.completed > completed + 1 || p.completed > p.total
            || !(p.actionId === null || typeof p.actionId === 'string')) throw new Error('Invalid terminal replay progress.');
          completed = p.completed;
          onProgress({ phase: p.phase, completed, total, actionId: p.actionId }); abort(signal); return;
        }
        if (value?.type === 'error' && typeof value.message === 'string') { finish(undefined, new Error(value.message)); return; }
        if (value?.type === 'growth-fitted' && (submitted.type === 'fit-growth' || submitted.type === 'fit-pfu-growth') && value.inputFileSha256 === tapeSha256
          && typeof value.recordJson === 'string' && new TextEncoder().encode(value.recordJson).length <= COMMAND_LIMITS.bytes) finish(value);
        else if (value?.type === 'recorded' && submitted.type === 'record' && plan && recordingMatches(value, plan, tapeSha256, completed)) {
          if (submitted.captureResults) acceptComplete(value, value.tapeJson, 1);
          else if (value.allResultsJson !== undefined) throw new Error('Unrequested complete results were returned.');
          else finish(value);
        }
        else if (value?.type === 'results-replayed' && submitted.type === 'replay-results' && archive
          && value.inputArchiveSha256 === tapeSha256 && value.report?.format === 'phage-explorer-workflow-replay'
          && value.report.verified === true && value.report.repetitions === archive.repetitions && completed === total) {
          acceptComplete(value, archive.tapeJson, archive.repetitions, archive);
        }
        else if (value?.type === 'results-inspected' && submitted.type === 'inspect-results' && archive
          && commandValuesEqual(value.report, terminalResultsInspection(archive, tapeSha256))) finish(value);
        else if (value?.type === 'result-extracted' && submitted.type === 'extract-result' && extracted
          && commandValuesEqual(value.report, extracted.report) && value.recordJson === extracted.recordJson) finish(value);
        else if (value?.type === 'genomes-inspected' && submitted.type === 'inspect-genomes'
          && value.report?.format === 'phage-explorer-genome-inspection' && value.report.version === 1 && value.report.headless === true
          && value.report.inputFileSha256 === tapeSha256 && Array.isArray(value.report.genomes)
          && value.report.genomes.length > 0 && value.report.genomes.length <= 100 && value.report.genomes.every(isTerminalGenomeSummary)
          && new Set(value.report.genomes.map(row => row.contentId)).size === value.report.genomes.length) finish(value);
        else if (value?.type === 'experiment-analyzed' && submitted.type === 'analyze-experiment'
          && value.report?.format === 'phage-explorer-experiment-analysis' && value.report.version === 1 && value.report.headless === true
          && value.report.inputFileSha256 === tapeSha256 && value.report.requestSha256 === terminalAnalysisRequestSha256(submitted)
          && isTerminalGenomeSummary(value.report.genome)
          && (submitted.contentId === null || value.report.genome.contentId === submitted.contentId)
          && terminalAnalysisParametersMatch(submitted.analysis, value.report)
          && /^[a-f0-9]{64}$/.test(value.report.cacheKey) && /^[a-f0-9]{64}$/.test(value.report.resultId)
          && (submitted.outputFormat === 'none' ? value.exportText === null
            : typeof value.exportText === 'string' && new TextEncoder().encode(value.exportText).length <= COMMAND_LIMITS.bytes)) finish(value);
        else if (value?.type === 'experiment-replayed' && submitted.type === 'replay-experiment' && saved
          && value.report?.format === 'phage-explorer-experiment-replay' && value.report.version === 1
          && value.report.headless === true && value.report.verified === true && value.report.inputRecordSha256 === tapeSha256
          && value.report.cacheKey === saved.cacheKey && value.report.resultId === saved.resultId
          && JSON.stringify(analysisJson(value.report.method)) === JSON.stringify(analysisJson(saved.method))
          && JSON.stringify(analysisJson(value.report.inputs)) === JSON.stringify(analysisJson(saved.inputs.map(
            ({ id, accession, source, sha256 }) => ({ id, accession, source, sha256 }))))
          && (submitted.outputFormat === 'none' ? value.exportText === null
            : typeof value.exportText === 'string' && new TextEncoder().encode(value.exportText).length <= COMMAND_LIMITS.bytes)) finish(value);
        else if (value?.type === 'inspection' && submitted.type === 'inspect' && tape && value.inspection?.format === 'phage-explorer-workflow-inspection'
          && value.inspection.tapeSha256 === tapeSha256 && value.inspection.name === tape.name) finish(value);
        else if (value?.type === 'replayed' && submitted.type === 'replay' && tape && value.report?.format === 'phage-explorer-workflow-replay'
          && value.report.tapeSha256 === tapeSha256 && value.report.name === tape.name && value.report.version === 1
          && value.report.verified === true && value.report.headless === true && value.report.repetitions === submitted.repetitions
          && value.report.completed === total && completed === total && total > 0 && total <= COMMAND_LIMITS.executions
          && Array.isArray(value.report.steps) && value.report.steps.length === total
          && value.report.steps.every((step, i) => step.execution === i + 1 && step.step === i % tape.commands.length + 1
            && step.iteration === Math.floor(i / tape.commands.length) + 1 && step.actionId === tape.commands[i % tape.commands.length].actionId)
          && (submitted.exportAnalysis ? typeof value.analysisJson === 'string' : value.analysisJson === null)) {
          if (submitted.captureResults) acceptComplete(value, submitted.content, submitted.repetitions);
          else if (value.allResultsJson !== undefined) throw new Error('Unrequested complete results were returned.');
          else finish(value);
        }
        else throw new Error('Unexpected terminal research response.');
      } catch (cause) { finish(undefined, cause); }
    };
    worker.on('message', message); worker.on('messageerror', messageError); worker.on('error', error); worker.once('exit', exit);
    signal.addEventListener('abort', cancelled, { once: true });
    try { abort(signal); worker.postMessage(submitted); } catch (cause) { finish(undefined, cause); }
  });
}
async function readInput(path: string, signal: AbortSignal, limit = COMMAND_LIMITS.bytes): Promise<string> {
  abort(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    abort(signal);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Workflow input must be a regular file.');
    if (stat.size > limit) throw new Error(`Workflow input exceeds ${limit / 1024 / 1024} MiB.`);
    const bytes = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > limit) throw new Error(`Workflow input exceeds ${limit / 1024 / 1024} MiB.`);
    abort(signal); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}
async function writeNewOutput(path: string, content: string, signal: AbortSignal): Promise<void> {
  abort(signal);
  const file = await open(path, 'wx', 0o600);
  try { abort(signal); await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  abort(signal);
}
export async function executeWorkflowCommand(command: Exclude<WorkflowCommand, { type: 'help' }>, runtime: WorkflowRuntime = {}): Promise<object> {
  if ((command.type === 'record' || command.type === 'replay') && command.allResults && command.output === undefined) {
    throw new Error('--results requires --output NEW_RESULTS.json.');
  }
  if (command.type === 'growth-template') {
    if (runtime.signal) abort(runtime.signal);
    return { format: 'phage-explorer-plaque-growth-input', version: command.version, measurement: 'extracellular-plaque-counts',
      title: 'Synthetic plate-count format example',
      provenance: { kind: 'synthetic', source: 'Hand-constructed format example, not experimental observations. Replace counts and provenance before using real data.' },
      csv: 'time_min,plaque_count,dilution_fraction,volume_ml' + (command.version === 2 ? ',count_status' : '') + '\n'
        + [10, 10, 10, 10, 60, 110, 110, 110, 110].map((count, t) => `${t},${count},1,1`
          + (command.version === 2 ? `,${t === 2 ? 'at-most' : t === 5 ? 'at-least' : 'exact'}` : '')).join('\n'),
      options: { infectedCentersPerMl: null, supportDeviance: 3.84 } };
  }
  if (command.type === 'list-enzymes') {
    if (runtime.signal) abort(runtime.signal);
    const { RESTRICTION_ENZYMES } = await import('../packages/core/src/data/restriction-enzymes');
    if (runtime.signal) abort(runtime.signal);
    return { format: 'phage-explorer-restriction-enzymes', version: 1,
      enzymes: RESTRICTION_ENZYMES.map(enzyme => ({ ...enzyme })),
      interpretation: 'Bundled recognition definitions for ideal complete digestion, not a claim of experimental activity.' };
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(runtime.signal?.reason ?? new DOMException('Research workflow cancelled.', 'AbortError'));
  runtime.signal?.addEventListener('abort', cancel, { once: true });
  if (runtime.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('Research workflow timed out.', 'TimeoutError')), command.timeoutMs);
  const signal = controller.signal;
  try {
    const archiveInput = command.type === 'replay-results' || command.type === 'inspect-results' || command.type === 'extract-result';
    const content = await readInput(command.input, signal, archiveInput ? WORKFLOW_RESULTS_LIMITS.bytes : COMMAND_LIMITS.bytes);
    const request: TerminalResearchRequest = command.type === 'inspect' || command.type === 'inspect-genomes' || command.type === 'replay-results' || command.type === 'inspect-results' || command.type === 'fit-growth' || command.type === 'fit-pfu-growth' ? { type: command.type, content }
      : command.type === 'extract-result' ? { type: 'extract-result', content, execution: command.execution }
      : command.type === 'record' ? { type: 'record', content, ...(command.allResults ? { captureResults: true } : {}) }
      : command.type === 'analyze-experiment' ? { type: 'analyze-experiment', content, contentId: command.contentId, analysis: command.analysis,
        outputFormat: command.output === undefined ? 'none' : command.outputFormat }
      : command.type === 'replay-experiment' ? { type: 'replay-experiment', content, outputFormat: command.output === undefined ? 'none' : command.outputFormat }
      : { type: 'replay', content, repetitions: command.repetitions, exportAnalysis: command.output !== undefined && !command.allResults,
        ...(command.allResults ? { captureResults: true } : {}) };
    const result = await runTerminalResearchWorker(request, signal, runtime.onProgress, runtime.createWorker);
    abort(signal);
    if (result.type === 'growth-fitted') {
      if (command.type !== 'fit-growth' && command.type !== 'fit-pfu-growth') throw new Error('Unexpected growth fit.');
      const { plaqueGrowthMethod, parsePlaqueGrowthInput, exportPlaqueGrowthTsv } = await import('../packages/core/src/analysis/plaque-growth');
      const { GROWTH_CURVE_RECORD_METHOD, parseGrowthCurveRecordInput, exportGrowthCurveTsv } = await import('../packages/core/src/analysis/one-step-growth');
      const corrected = command.type === 'fit-pfu-growth';
      const input = corrected ? parseGrowthCurveRecordInput(content) : parsePlaqueGrowthInput(content);
      const method = 'schemaVersion' in input ? GROWTH_CURVE_RECORD_METHOD : plaqueGrowthMethod(input.version);
      const record = await parseAnalysisRecord(result.recordJson, { methodId: method.id, methodVersion: method.version });
      abort(signal);
      if (!commandValuesEqual(record.method, method) || record.inputs.length !== 1
        || record.inputs[0].id !== 'experiment' || record.inputs[0].data !== content || record.inputs[0].accession !== null
        || record.inputs[0].source !== (input.provenance.kind === 'synthetic' ? 'demo' : 'local')
        || !commandValuesEqual(record.parameters, input.options) || record.seed !== ('seed' in input.options ? input.options.seed : null)) {
        throw new Error('Growth output differs from the submitted measurements, source or settings.');
      }
      // Only bounded formatting runs here; all fitting and profiling ran in the worker.
      const { fitted: _plates, ...summary } = record.fields.fit.value as unknown as import('../packages/core/src/analysis/plaque-growth').PlaqueGrowthResult | import('../packages/core/src/analysis/one-step-growth').GrowthCurveFit;
      if (command.output !== undefined) {
        const text = command.outputFormat === 'json' ? result.recordJson : corrected ? exportGrowthCurveTsv(record) : exportPlaqueGrowthTsv(record);
        await writeNewOutput(command.output, text, signal);
      }
      return { format: 'phage-explorer-growth-fit', version: 1, headless: true, inputFileSha256: result.inputFileSha256,
        method: record.method, parameters: record.parameters, cacheKey: record.cacheKey, resultId: record.resultId,
        provenance: input.provenance.kind, summary };
    }
    if (result.type === 'recorded') {
      if (command.type !== 'record') throw new Error('Unexpected recording result.');
      const text = command.allResults ? result.allResultsJson : result.tapeJson;
      if (typeof text !== 'string') throw new Error('The completed workflow output was not returned.');
      await writeNewOutput(command.output, text, signal);
      return { ...result.report, ...(command.allResults ? { outputKind: 'complete-workflow-results',
        archiveSha256: createHash('sha256').update(text, 'utf8').digest('hex') } : {}) };
    }
    if (result.type === 'results-replayed') {
      if (command.type !== 'replay-results') throw new Error('Unexpected complete-results replay.');
      if (command.output !== undefined) await writeNewOutput(command.output, result.archiveJson, signal);
      return { ...result.report, inputArchiveSha256: result.inputArchiveSha256,
        archiveSha256: createHash('sha256').update(result.archiveJson, 'utf8').digest('hex') };
    }
    if (result.type === 'results-inspected') return result.report;
    if (result.type === 'result-extracted') {
      if (command.type !== 'extract-result') throw new Error('Unexpected stored analysis extraction.');
      await writeNewOutput(command.output, result.recordJson, signal);
      return result.report;
    }
    if (result.type === 'inspection') return result.inspection;
    if (result.type === 'genomes-inspected') return result.report;
    if (result.type === 'experiment-analyzed') {
      if (command.type !== 'analyze-experiment') throw new Error('Unexpected fresh analysis result.');
      if (command.output !== undefined) {
        if (result.exportText === null) throw new Error('No experiment output was returned.');
        if (command.outputFormat === 'json') {
          const record = await parseAnalysisRecord(result.exportText);
          const pairwise = command.analysis.method === 'pairwise-dot-plot';
          const axes = pairwise ? [
            { input: record.inputs[0], id: 'rowSequence', genome: result.report.genome },
            { input: record.inputs[1], id: 'columnSequence', genome: result.report.comparison },
          ] : [{ input: record.inputs[0], id: 'sequence', genome: result.report.genome }];
          if (record.cacheKey !== result.report.cacheKey || record.resultId !== result.report.resultId
            || JSON.stringify(analysisJson(record.method)) !== JSON.stringify(analysisJson(result.report.method))
            || JSON.stringify(analysisJson(record.parameters)) !== JSON.stringify(analysisJson(result.report.parameters))
            || JSON.stringify(analysisJson(terminalSequenceSummary(record) ?? null)) !== JSON.stringify(analysisJson(result.report.summary ?? null))
            || pairwise && record.inputs.length !== 2
            || axes.some(({ input, id, genome }) => !input || !genome || input.id !== id || input.source !== 'local'
              || input.accession !== genome.accession || typeof input.data !== 'string' || input.data.length !== genome.bases
              || createHash('sha256').update(input.data).digest('hex') !== genome.sequenceSha256)) {
            throw new Error('Analysis output differs from the selected source or reported experiment.');
          }
        }
        await writeNewOutput(command.output, result.exportText, signal);
      }
      return result.report;
    }
    if (result.type === 'experiment-replayed') {
      if (command.type !== 'replay-experiment') throw new Error('Unexpected experiment result for a command tape.');
      if (command.output !== undefined) {
        if (result.exportText === null) throw new Error('No verified experiment output was returned.');
        if (command.outputFormat === 'json') {
          const record = await parseAnalysisRecord(result.exportText);
          if (record.cacheKey !== result.report.cacheKey || record.resultId !== result.report.resultId) throw new Error('Experiment output differs from the verified result.');
        }
        await writeNewOutput(command.output, result.exportText, signal);
      }
      return result.report;
    }
    if (command.type === 'replay' && command.output !== undefined) {
      if (command.allResults) {
        if (typeof result.allResultsJson !== 'string') throw new Error('No complete workflow results were returned.');
        await writeNewOutput(command.output, result.allResultsJson, signal);
        return { ...result.report, outputKind: 'complete-workflow-results',
          archiveSha256: createHash('sha256').update(result.allResultsJson, 'utf8').digest('hex') };
      }
      if (result.analysisJson === null) throw new Error('No verified analysis was returned.');
      const record = await parseAnalysisRecord(result.analysisJson);
      const index = result.report.lastAnalysisExecution;
      const identity = index === null ? null : result.report.steps[index - 1]?.analysis;
      if (!identity || record.cacheKey !== identity.cacheKey || record.resultId !== identity.resultId) throw new Error('Analysis output differs from the verified execution.');
      await writeNewOutput(command.output, result.analysisJson, signal);
    }
    return result.report;
  } finally {
    clearTimeout(timer); runtime.signal?.removeEventListener('abort', cancel);
  }
}
export async function researchWorkflowMain(args: readonly string[], output: (text: string) => void,
  error: (text: string) => void, runtime: WorkflowRuntime = {}, invocation = 'bun run workflow'): Promise<number> {
  try {
    const command = parseWorkflowCommand(args);
    if (command.type === 'help') output(RESEARCH_WORKFLOW_HELP.replaceAll('bun run workflow', invocation));
    else {
      const report = await executeWorkflowCommand(command, { ...runtime, onProgress: progress => {
        runtime.onProgress?.(progress);
        if ((command.type === 'replay' || command.type === 'record' || command.type === 'replay-results') && command.progress) error(JSON.stringify({ type: 'progress', ...progress }) + '\n');
      } });
      output(JSON.stringify(report, null, 2) + '\n');
    }
    return 0;
  } catch (cause) {
    error((cause instanceof Error ? cause.message : 'Research workflow failed.').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 2000) + '\n');
    return cause instanceof Error && cause.name === 'TimeoutError' ? 124 : cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}
export async function runResearchWorkflowCli(args = process.argv.slice(2), invocation = 'bun run workflow'): Promise<void> {
  const controller = new AbortController(); let interrupted = 0;
  const sigint = () => { interrupted = 130; controller.abort(new DOMException('Research workflow interrupted.', 'AbortError')); };
  const sigterm = () => { interrupted = 143; controller.abort(new DOMException('Research workflow terminated.', 'AbortError')); };
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    const code = await researchWorkflowMain(args, text => { process.stdout.write(text); }, text => { process.stderr.write(text); }, { signal: controller.signal }, invocation);
    process.exitCode = interrupted || code;
  } finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
}
if (import.meta.main) void runResearchWorkflowCli();
