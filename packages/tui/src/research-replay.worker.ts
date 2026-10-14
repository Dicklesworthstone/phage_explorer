/** One isolated terminal request. No filenames, shell commands or network inputs
 * cross this boundary. The parent terminates CPU work on cancellation/timeout.
 */
import { isMainThread, parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS } from '../../core/src/command-session';
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import type { ReplayProgress, ResearchTapeInspection, ResearchReplayResult, ResearchRecordingResult } from './research-replay';
import { GENOME_IMPORT_LIMITS, type LocalGenome } from '../../core/src/genome-import';
import { resolveRestrictionDigestOptions, type RestrictionDigestOptions } from '../../core/src/analysis/restriction-digest';
import { GC_SKEW_METHOD, GC_SKEW_LIMITS, resolveGCSkewOptions, type ResolvedGCSkewOptions, type GCSkewScan } from '../../core/src/analysis/gc-skew';
import { EXACT_REPEAT_METHOD, CIRCULAR_EXACT_REPEAT_METHOD, resolveExactRepeatOptions, type ExactRepeatScan } from '../../core/src/analysis/exact-repeat-pairs';

export interface TerminalGenomeSummary {
  contentId: string; sequenceSha256: string; accession: string | null;
  bases: number; resolvedBases: number; mappedFeatures: number; warningCount: number;
  format: 'fasta' | 'genbank'; topology: 'linear' | 'circular' | 'unknown';
}
export interface TerminalGenomeInspection {
  format: 'phage-explorer-genome-inspection'; version: 1; headless: true;
  inputFileSha256: string; genomes: TerminalGenomeSummary[];
}
export type TerminalAnalysis = { method: 'dot-plot'; bins: number; window: number | null } |
  { method: 'pairwise-dot-plot'; columnContentId: string; bins: number; window: number | null } |
  ({ method: 'gc-skew' } & ResolvedGCSkewOptions) |
  { method: 'exact-repeats'; armLength: number; maxGap: number; maxPairs: number; topology: 'linear' | 'circular' } |
  ({ method: 'restriction-digest' } & RestrictionDigestOptions);
export type TerminalSequenceSummary = { kind: 'gc-skew'; sampledWindows: number; definedSkewWindows: number } |
  { kind: 'exact-repeats'; pairCount: number; complete: boolean; stoppedAtRightStart: number | null };
export interface TerminalAnalysisReport {
  format: 'phage-explorer-experiment-analysis'; version: 1; headless: true;
  inputFileSha256: string; requestSha256: string; genome: TerminalGenomeSummary;
  /** Present only for pairwise analysis: genome is row/Y, comparison is column/X. */
  comparison?: TerminalGenomeSummary;
  /** Output coverage, not a biological inference or a replay verification flag. */
  summary?: TerminalSequenceSummary;
  method: AnalysisRecord['method']; parameters: AnalysisRecord['parameters'];
  cacheKey: string; resultId: string; interpretation: string;
}

const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
/** One projection for worker reports and the parent's accepted JSON output. */
export function terminalSequenceSummary(record: AnalysisRecord): TerminalSequenceSummary | undefined {
  if (record.method.id === GC_SKEW_METHOD.id) {
    const windows = record.fields.windows.value as unknown as GCSkewScan['windows'];
    return { kind: 'gc-skew', sampledWindows: windows.length, definedSkewWindows: windows.filter(w => w.skew !== null).length };
  }
  if (record.method.id === EXACT_REPEAT_METHOD.id) {
    const search = record.fields.search.value as unknown as ExactRepeatScan['search'];
    const pairs = record.fields.pairs.value as unknown as ExactRepeatScan['pairs'];
    return { kind: 'exact-repeats', pairCount: pairs.length, complete: search.complete, stoppedAtRightStart: search.stoppedAtRightStart };
  }
  return undefined;
}
export function validateTerminalAnalysis(value: unknown): asserts value is TerminalAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Explicit analysis settings are required.');
  const settings = value as Record<string, unknown>;
  if (settings.method === 'gc-skew') {
    if (Object.keys(settings).sort().join('|') !== 'method|stepSize|windowSize'
      || typeof settings.windowSize !== 'number' || typeof settings.stepSize !== 'number') {
      throw new Error('GC skew requires explicit numeric windowSize and stepSize settings.');
    }
    resolveGCSkewOptions({ windowSize: settings.windowSize, stepSize: settings.stepSize });
    return;
  }
  if (settings.method === 'exact-repeats') {
    if (Object.keys(settings).sort().join('|') !== 'armLength|maxGap|maxPairs|method|topology'
      || typeof settings.armLength !== 'number' || typeof settings.maxGap !== 'number' || typeof settings.maxPairs !== 'number'
      || (settings.topology !== 'linear' && settings.topology !== 'circular')) {
      throw new Error('Exact repeats require numeric armLength, maxGap, maxPairs and explicit linear/circular topology.');
    }
    resolveExactRepeatOptions({ armLength: settings.armLength, maxGap: settings.maxGap, maxPairs: settings.maxPairs, topology: settings.topology });
    return;
  }
  if (settings.method === 'restriction-digest') {
    if (Object.keys(settings).sort().join('|') !== 'enzymes|method|topology') throw new Error('Specify only method, enzymes and topology for restriction analysis.');
    resolveRestrictionDigestOptions({ enzymes: settings.enzymes, topology: settings.topology });
    return;
  }
  const pairwise = settings.method === 'pairwise-dot-plot';
  if (pairwise && (typeof settings.columnContentId !== 'string' || !/^[a-f0-9]{64}$/.test(settings.columnContentId))) {
    throw new Error('Pairwise analysis requires a complete column content ID from inspect-genomes.');
  }
  if ((!pairwise && settings.method !== 'dot-plot')
    || Object.keys(settings).sort().join('|') !== (pairwise ? 'bins|columnContentId|method|window' : 'bins|method|window')
    || !Number.isSafeInteger(settings.bins) || Number(settings.bins) < 1 || Number(settings.bins) > 200
    || settings.window !== null && (!Number.isSafeInteger(settings.window) || Number(settings.window) < 1
      || Number(settings.window) > GENOME_IMPORT_LIMITS.bases)) {
    throw new Error('Dot-plot analysis requires 1–200 bins and a null (automatic) or positive bounded window.');
  }
}
export function isTerminalGenomeSummary(value: unknown): value is TerminalGenomeSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.contentId === 'string' && /^[a-f0-9]{64}$/.test(row.contentId)
    && typeof row.sequenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sequenceSha256)
    && (row.accession === null || typeof row.accession === 'string' && row.accession.length > 0 && row.accession.length <= 2000)
    && Number.isSafeInteger(row.bases) && Number(row.bases) > 0 && Number(row.bases) <= GENOME_IMPORT_LIMITS.bases
    && Number.isSafeInteger(row.resolvedBases) && Number(row.resolvedBases) >= 0 && Number(row.resolvedBases) <= Number(row.bases)
    && Number.isSafeInteger(row.mappedFeatures) && Number(row.mappedFeatures) >= 0 && Number(row.mappedFeatures) <= GENOME_IMPORT_LIMITS.features
    && Number.isSafeInteger(row.warningCount) && Number(row.warningCount) >= 0
    && ['fasta', 'genbank'].includes(String(row.format)) && ['linear', 'circular', 'unknown'].includes(String(row.topology));
}
function genomeSummary(genome: LocalGenome): TerminalGenomeSummary {
  const local = genome.phage.localGenome!;
  let resolvedBases = 0;
  for (const base of genome.sequence) if (base === 'A' || base === 'C' || base === 'G' || base === 'T') resolvedBases++;
  return { contentId: local.contentId, sequenceSha256: local.sequenceSha256, accession: genome.phage.accession,
    bases: genome.sequence.length, resolvedBases, mappedFeatures: genome.phage.genes.length,
    warningCount: genome.warnings.length, format: local.format, topology: local.topology };
}
/** Bind worker replies to the raw file, explicit selection and requested settings. */
export function terminalAnalysisRequestSha256(request: Extract<TerminalResearchRequest, { type: 'analyze-experiment' }>): string {
  return hashText(JSON.stringify([hashText(request.content), request.contentId, request.analysis.method,
    ...(request.analysis.method === 'dot-plot' ? [request.analysis.bins, request.analysis.window]
      : request.analysis.method === 'pairwise-dot-plot' ? [request.analysis.columnContentId, request.analysis.bins, request.analysis.window]
      : request.analysis.method === 'gc-skew' ? [request.analysis.windowSize, request.analysis.stepSize]
      : request.analysis.method === 'exact-repeats' ? [request.analysis.armLength, request.analysis.maxGap, request.analysis.maxPairs, request.analysis.topology]
      : [request.analysis.enzymes, request.analysis.topology])]));
}
/** Check effective result settings at the parent boundary without recomputing on the main thread. */
export function terminalAnalysisParametersMatch(analysis: TerminalAnalysis, report: TerminalAnalysisReport): boolean {
  const parameters = report.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
  if (analysis.method === 'gc-skew') {
    const summary = report.summary;
    const count = report.genome.bases < analysis.windowSize ? 0 : Math.floor((report.genome.bases - analysis.windowSize) / analysis.stepSize) + 1;
    return report.comparison === undefined && sameJson(report.method, GC_SKEW_METHOD)
      && sameJson(parameters, { windowSize: analysis.windowSize, stepSize: analysis.stepSize })
      && count <= GC_SKEW_LIMITS.windows && summary?.kind === 'gc-skew' && summary.sampledWindows === count
      && Number.isSafeInteger(summary.definedSkewWindows) && summary.definedSkewWindows >= 0
      && summary.definedSkewWindows <= count;
  }
  if (analysis.method === 'exact-repeats') {
    const summary = report.summary;
    const expected = resolveExactRepeatOptions({ armLength: analysis.armLength, maxGap: analysis.maxGap,
      maxPairs: analysis.maxPairs, topology: analysis.topology });
    return report.comparison === undefined && sameJson(parameters, expected)
      && sameJson(report.method, analysis.topology === 'circular' ? CIRCULAR_EXACT_REPEAT_METHOD : EXACT_REPEAT_METHOD)
      && (report.genome.topology === 'unknown' || report.genome.topology === analysis.topology)
      && summary?.kind === 'exact-repeats' && Number.isSafeInteger(summary.pairCount)
      && summary.pairCount >= 0 && summary.pairCount <= analysis.maxPairs
      && (summary.complete === true ? summary.stoppedAtRightStart === null
        : summary.complete === false && summary.pairCount === analysis.maxPairs
          && Number.isSafeInteger(summary.stoppedAtRightStart) && Number(summary.stoppedAtRightStart) >= 0
          && Number(summary.stoppedAtRightStart) < report.genome.bases);
  }
  if (report.summary !== undefined) return false;
  if (analysis.method === 'pairwise-dot-plot') {
    const comparison = report.comparison;
    if (!isTerminalGenomeSummary(comparison) || comparison.contentId !== analysis.columnContentId
      || report.genome.bases + comparison.bases > GENOME_IMPORT_LIMITS.bases) return false;
    const length = Math.min(report.genome.bases, comparison.bases);
    const window = analysis.window ?? Math.min(length, Math.max(20, Math.floor(length / analysis.bins)));
    return report.method?.id === 'sequence-pairwise-dot-plot' && report.method.version === '1'
      && Object.keys(parameters).sort().join('|') === 'ambiguity|bins|window'
      && parameters.bins === analysis.bins && parameters.ambiguity === 'exclude'
      && parameters.window === window && window <= length;
  }
  if (report.comparison !== undefined) return false;
  if (analysis.method === 'dot-plot') {
    return report.method?.id === 'sequence-dot-plot' && Object.keys(parameters).sort().join('|') === 'ambiguity|bins|window'
      && parameters.bins === analysis.bins && parameters.ambiguity === 'exclude' && Number.isSafeInteger(parameters.window)
      && Number(parameters.window) >= 1 && Number(parameters.window) <= report.genome.bases
      && (analysis.window === null || parameters.window === analysis.window);
  }
  const expected = resolveRestrictionDigestOptions({ enzymes: analysis.enzymes, topology: analysis.topology });
  return report.method?.id === 'restriction-digest' && Object.keys(parameters).sort().join('|') === 'enzymes|topology'
    && parameters.topology === expected.topology && JSON.stringify(parameters.enzymes) === JSON.stringify(expected.enzymes)
    && (report.genome.topology === 'unknown' || report.genome.topology === expected.topology);
}

export interface TerminalExperimentReport {
  format: 'phage-explorer-experiment-replay'; version: 1; verified: true; headless: true;
  inputRecordSha256: string;
  method: AnalysisRecord['method']; cacheKey: string; resultId: string;
  inputs: Array<Pick<AnalysisRecord['inputs'][number], 'id' | 'accession' | 'source' | 'sha256'>>;
  interpretation: string;
}

export type TerminalResearchRequest = { type: 'fit-growth'; content: string } |
  { type: 'inspect'; content: string } |
  { type: 'record'; content: string } |
  { type: 'inspect-genomes'; content: string } |
  { type: 'analyze-experiment'; content: string; contentId: string | null; analysis: TerminalAnalysis; outputFormat: 'none' | 'json' | 'tsv' } |
  { type: 'replay'; content: string; repetitions: number; exportAnalysis: boolean } |
  { type: 'replay-experiment'; content: string; outputFormat: 'none' | 'json' | 'tsv' };
export type TerminalResearchResult = { type: 'growth-fitted'; inputFileSha256: string; recordJson: string } |
  { type: 'inspection'; inspection: ResearchTapeInspection } |
  ({ type: 'recorded' } & ResearchRecordingResult) |
  { type: 'genomes-inspected'; report: TerminalGenomeInspection } |
  { type: 'experiment-analyzed'; report: TerminalAnalysisReport; exportText: string | null } |
  { type: 'replayed'; report: ResearchReplayResult['report']; analysisJson: string | null } |
  { type: 'experiment-replayed'; report: TerminalExperimentReport; exportText: string | null };
export type TerminalResearchMessage = TerminalResearchResult | { type: 'progress'; progress: ReplayProgress } | { type: 'error'; message: string };

export function validateTerminalResearchRequest(value: unknown): asserts value is TerminalResearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal research request.');
  const request = value as Record<string, unknown>;
  const allowed = request.type === 'inspect' || request.type === 'inspect-genomes' || request.type === 'record' || request.type === 'fit-growth' ? ['type', 'content'] : request.type === 'analyze-experiment'
    ? ['type', 'content', 'contentId', 'analysis', 'outputFormat'] : request.type === 'replay-experiment'
    ? ['type', 'content', 'outputFormat'] : ['type', 'content', 'repetitions', 'exportAnalysis'];
  if (!['inspect', 'record', 'replay', 'replay-experiment', 'inspect-genomes', 'analyze-experiment', 'fit-growth'].includes(String(request.type)) || Object.keys(request).sort().join('|') !== allowed.sort().join('|') ||
    typeof request.content !== 'string' || request.content.length > COMMAND_LIMITS.bytes || new TextEncoder().encode(request.content).length > COMMAND_LIMITS.bytes) {
    throw new Error('Expected a supported terminal operation and UTF-8 input of at most 10 MiB.');
  }
  if (request.type === 'fit-growth' && new TextEncoder().encode(request.content as string).length > 1_000_000) throw new Error('Plaque input exceeds 1,000,000 UTF-8 bytes.');
  if (request.type === 'replay' && (typeof request.exportAnalysis !== 'boolean' || !Number.isSafeInteger(request.repetitions) ||
    Number(request.repetitions) < 1 || Number(request.repetitions) > COMMAND_LIMITS.repetitions)) throw new Error('Invalid replay export/repetition options.');
  if ((request.type === 'replay-experiment' || request.type === 'analyze-experiment') && !['none', 'json', 'tsv'].includes(String(request.outputFormat))) {
    throw new Error('Experiment output must be none, json or tsv.');
  }
  if (request.type === 'analyze-experiment') {
    if (request.contentId !== null && (typeof request.contentId !== 'string' || !/^[a-f0-9]{64}$/.test(request.contentId))) {
      throw new Error('Select a complete genome content ID from inspect-genomes, or null for a single-record input.');
    }
    validateTerminalAnalysis(request.analysis);
    if (request.analysis.method === 'pairwise-dot-plot' && request.contentId === null) {
      throw new Error('Pairwise analysis requires explicit row and column content IDs; file order never chooses axes.');
    }
  }
}
export async function executeTerminalResearchRequest(request: TerminalResearchRequest,
  progress: (value: ReplayProgress) => void = () => {}): Promise<TerminalResearchResult> {
  validateTerminalResearchRequest(request);
  request = structuredClone(request);
  if (request.type === 'fit-growth') {
    const { createPlaqueGrowthRecord } = await import('../../core/src/analysis/plaque-growth');
    const record = await createPlaqueGrowthRecord(request.content);
    return { type: 'growth-fitted', inputFileSha256: hashText(request.content), recordJson: serializeAnalysisRecord(record) };
  }
  if (request.type === 'inspect-genomes' || request.type === 'analyze-experiment') {
    const { importLocalGenomes } = await import('../../core/src/genome-import');
    // Same normalization, annotation parsing and content IDs as browser import.
    // The input is text, never a path to be opened by the worker.
    const { genomes } = await importLocalGenomes({ name: 'workflow-input', text: request.content });
    const inputFileSha256 = hashText(request.content);
    if (request.type === 'inspect-genomes') return { type: 'genomes-inspected', report: {
      format: 'phage-explorer-genome-inspection', version: 1, headless: true,
      inputFileSha256, genomes: genomes.map(genomeSummary),
    } };
    const selectedId = request.contentId;
    const matches = selectedId === null ? genomes : genomes.filter(g => g.phage.localGenome!.contentId === selectedId);
    if (matches.length !== 1) throw new Error('Select exactly one genome with --record CONTENT_ID from inspect-genomes; missing, stale or ambiguous selections are not analyzed.');
    const genome = matches[0];
    const columnId = request.analysis.method === 'pairwise-dot-plot' ? request.analysis.columnContentId : null;
    const comparison = columnId === null ? undefined : genomes.find(g => g.phage.localGenome!.contentId === columnId);
    if (request.analysis.method === 'pairwise-dot-plot' && !comparison) {
      throw new Error('The selected comparison genome is missing or changed. Select its full content ID from inspect-genomes.');
    }
    let record: AnalysisRecord;
    let table: (record: AnalysisRecord) => string;
    let interpretation: string;
    let summary: TerminalSequenceSummary | undefined;
    if (request.analysis.method === 'dot-plot') {
      const { createDotPlotExperiment, exportDotPlotExperimentTsv } = await import('../../core/src/analysis/dot-plot');
      record = (await createDotPlotExperiment({ sequence: genome.sequence, accession: genome.phage.accession, source: 'local' },
        { bins: request.analysis.bins, ...(request.analysis.window === null ? {} : { window: request.analysis.window }) })).record;
      table = exportDotPlotExperimentTsv;
      interpretation = 'Dot plots sample linear windows, including for circular records; no origin wrapping.';
    } else if (request.analysis.method === 'pairwise-dot-plot') {
      const { createPairwiseDotPlotExperiment, exportPairwiseDotPlotExperimentTsv } = await import('../../core/src/analysis/dot-plot');
      record = (await createPairwiseDotPlotExperiment(
        { sequence: genome.sequence, accession: genome.phage.accession, source: 'local' },
        { sequence: comparison!.sequence, accession: comparison!.phage.accession, source: 'local' },
        { bins: request.analysis.bins, ...(request.analysis.window === null ? {} : { window: request.analysis.window }) })).record;
      table = exportPairwiseDotPlotExperimentTsv;
      interpretation = 'The selected record is row/Y and the comparison record is column/X. Linear sampled windows use a common length fitting both genomes, even for circular records; no origin wrapping. Coverage is counted independently for each axis, not inferred from the cross-genome diagonal. Scores are not alignments or variant calls.';
    } else if (request.analysis.method === 'gc-skew') {
      const { createGCSkewRecord, exportGCSkewTsv } = await import('../../core/src/analysis/gc-skew');
      record = await createGCSkewRecord(genome.sequence,
        { windowSize: request.analysis.windowSize, stepSize: request.analysis.stepSize }, { accession: genome.phage.accession, source: 'local' });
      table = exportGCSkewTsv;
      summary = terminalSequenceSummary(record);
      interpretation = 'Complete linear windows only, including for circular inputs. Zero-GC windows have unavailable (null) skew, not a measured zero. Cumulative values are inclusive per-base G-minus-C counts, not a sum of ratios. Extrema are composition candidates, not experimentally established replication locations.';
    } else if (request.analysis.method === 'exact-repeats') {
      const declared = genome.phage.localGenome!.topology;
      if (declared !== 'unknown' && declared !== request.analysis.topology) {
        throw new Error('Requested repeat topology conflicts with the selected source metadata. No topology change is inferred.');
      }
      const { createExactRepeatRecord, exportExactRepeatPairsTsv } = await import('../../core/src/analysis/exact-repeat-pairs');
      record = await createExactRepeatRecord(genome.sequence,
        { armLength: request.analysis.armLength, maxGap: request.analysis.maxGap, maxPairs: request.analysis.maxPairs,
          topology: request.analysis.topology }, { accession: genome.phage.accession, source: 'local' });
      table = exportExactRepeatPairsTsv;
      const search = record.fields.search.value as unknown as ExactRepeatScan['search'];
      summary = terminalSequenceSummary(record);
      interpretation = `Unsampled fixed-length non-overlapping direct and inverted pairs; not maximal repeats or biological structure predictions. ${declared === 'unknown'
        ? 'Source topology was unknown; the explicit requested topology is an assumption.' : 'Explicit topology agrees with source metadata.'} ${search.complete
        ? 'Search completed for these parameters.' : 'Output is a truncated ordered prefix; it is not an exhaustive result.'} Circular ends may exceed genome length; TSV retains the wrapped arm segments.`;
    } else {
      const declared = genome.phage.localGenome!.topology;
      if (declared !== 'unknown' && declared !== request.analysis.topology) {
        throw new Error('Requested digest topology conflicts with the selected source metadata. This command does not simulate topology changes.');
      }
      const { createRestrictionDigestRecord, exportRestrictionDigestTsv } = await import('../../core/src/analysis/restriction-digest');
      record = await createRestrictionDigestRecord(genome.sequence,
        { enzymes: request.analysis.enzymes, topology: request.analysis.topology }, { accession: genome.phage.accession, source: 'local' });
      table = exportRestrictionDigestTsv;
      interpretation = `Ideal complete digestion, not measured gel mobility. ${declared === 'unknown'
        ? 'Source topology was unknown; the explicit requested topology is an assumption.'
        : 'Explicit topology agrees with the source annotation.'} Empty enzyme selection is an uncut control; unresolved bases are not cut evidence.`;
    }
    return { type: 'experiment-analyzed', report: {
      format: 'phage-explorer-experiment-analysis', version: 1, headless: true,
      inputFileSha256, requestSha256: terminalAnalysisRequestSha256(request), genome: genomeSummary(genome),
      ...(comparison ? { comparison: genomeSummary(comparison) } : {}),
      ...(summary ? { summary } : {}),
      method: record.method, parameters: record.parameters, cacheKey: record.cacheKey, resultId: record.resultId,
      interpretation: `Fresh computation from locally parsed DNA, not replay verification or biological validation. Whitespace/case normalization follows the shared importer. ${interpretation}`,
    }, exportText: request.outputFormat === 'json' ? serializeAnalysisRecord(record)
      : request.outputFormat === 'tsv' ? table(record) : null };
  }
  if (request.type === 'replay-experiment') {
    const saved = await parseAnalysisRecord(request.content);
    let fresh: AnalysisRecord;
    let table: (record: AnalysisRecord) => string;
    if (saved.method.id === 'sequence-dot-plot') {
      const { replayDotPlotExperiment, exportDotPlotExperimentTsv } = await import('../../core/src/analysis/dot-plot');
      const source = saved.inputs[0];
      if (typeof source.data !== 'string' || (source.source !== 'local' && source.source !== 'catalog')) {
        throw new Error('Dot plot replay requires an embedded exact local or catalog sequence.');
      }
      fresh = (await replayDotPlotExperiment(request.content, {
        sequence: source.data, accession: source.accession, source: source.source,
      })).record;
      table = exportDotPlotExperimentTsv;
    } else if (saved.method.id === 'sequence-pairwise-dot-plot') {
      const { replayPairwiseDotPlotExperiment, exportPairwiseDotPlotExperimentTsv } = await import('../../core/src/analysis/dot-plot');
      const row = saved.inputs[0], column = saved.inputs[1];
      if (saved.inputs.length !== 2 || row.id !== 'rowSequence' || column.id !== 'columnSequence'
        || typeof row.data !== 'string' || typeof column.data !== 'string'
        || (row.source !== 'local' && row.source !== 'catalog')
        || (column.source !== 'local' && column.source !== 'catalog')) {
        throw new Error('Pairwise replay requires ordered row/Y and column/X local or catalog sequences.');
      }
      fresh = (await replayPairwiseDotPlotExperiment(request.content,
        { sequence: row.data, accession: row.accession, source: row.source },
        { sequence: column.data, accession: column.accession, source: column.source })).record;
      table = exportPairwiseDotPlotExperimentTsv;
    } else if (saved.method.id === 'plaque-count-growth') {
      const { replayPlaqueGrowthRecord, exportPlaqueGrowthTsv } = await import('../../core/src/analysis/plaque-growth');
      fresh = await replayPlaqueGrowthRecord(request.content); table = exportPlaqueGrowthTsv;
    } else if (saved.method.id === 'restriction-digest') {
      const { replayRestrictionDigestRecord, exportRestrictionDigestTsv } = await import('../../core/src/analysis/restriction-digest');
      fresh = await replayRestrictionDigestRecord(request.content);
      table = exportRestrictionDigestTsv;
    } else if (saved.method.id === GC_SKEW_METHOD.id) {
      const { replayGCSkewRecord, exportGCSkewTsv } = await import('../../core/src/analysis/gc-skew');
      fresh = await replayGCSkewRecord(request.content);
      table = exportGCSkewTsv;
    } else if (saved.method.id === EXACT_REPEAT_METHOD.id) {
      const { replayExactRepeatRecord, exportExactRepeatPairsTsv } = await import('../../core/src/analysis/exact-repeat-pairs');
      fresh = await replayExactRepeatRecord(request.content);
      table = exportExactRepeatPairsTsv;
    } else {
      throw new Error('Unsupported experiment method. Supported: self/pairwise dot plots, restriction digests, portable GC skew, exact repeat pairs and plaque-count growth.');
    }
    // The native path reuses embedded metadata too, so a complete match is
    // required. Never call a merely valid checksum a numerical verification.
    if (fresh.resultId !== saved.resultId || fresh.cacheKey !== saved.cacheKey) {
      throw new Error('Recomputed experiment identity differs from the saved record.');
    }
    return { type: 'experiment-replayed', report: {
      format: 'phage-explorer-experiment-replay', version: 1, verified: true, headless: true,
      inputRecordSha256: createHash('sha256').update(request.content, 'utf8').digest('hex'),
      method: fresh.method, cacheKey: fresh.cacheKey, resultId: fresh.resultId,
      inputs: fresh.inputs.map(({ id, accession, source, sha256 }) => ({ id, accession, source, sha256 })),
      interpretation: 'Fresh numerical replay of the embedded inputs, parameters and reference definitions; not independent source authentication or biological validation.',
    }, exportText: request.outputFormat === 'json' ? serializeAnalysisRecord(fresh)
      : request.outputFormat === 'tsv' ? table(fresh) : null };
  }
  // A standalone sequence experiment does not initialize command adapters,
  // genome imports or unrelated scientific methods.
  const { inspectResearchTape, replayResearchTape, recordResearchPlan } = await import('./research-replay');
  if (request.type === 'record') return { type: 'recorded', ...await recordResearchPlan(request.content, { onProgress: progress }) };
  if (request.type === 'inspect') return { type: 'inspection', inspection: await inspectResearchTape(request.content) };
  const result = await replayResearchTape(request.content, { repetitions: request.repetitions, onProgress: progress });
  if (request.exportAnalysis && !result.lastAnalysis) throw new Error('The verified workflow contains no analysis to export; omit --output for navigation-only replay.');
  return { type: 'replayed', report: result.report,
    analysisJson: request.exportAnalysis ? serializeAnalysisRecord(result.lastAnalysis!) : null };
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.once('message', (request: TerminalResearchRequest) => {
    void executeTerminalResearchRequest(request, progress => port.postMessage({ type: 'progress', progress } satisfies TerminalResearchMessage))
      .then(result => port.postMessage(result))
      .catch(cause => port.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Terminal research worker failed.' } satisfies TerminalResearchMessage))
      .finally(() => port.close());
  });
}
