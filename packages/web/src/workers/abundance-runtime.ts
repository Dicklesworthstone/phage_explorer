/** Data-only worker protocol. No network service receives imported sample data. */
import { parseAbundanceDataset, validateAbundanceDataset, importAbundanceMetadata, resolveAbundanceOptions,
  analyzeAbundanceDataset, createAbundanceAnalysisRecord, replayAbundanceAnalysis,
  type AbundanceDataset, type AbundanceOptions, type AbundanceAnalysis } from '../../../core/src/analysis/abundance';
import { createSeededRng, generateDemoAbundanceTable } from '../../../core/src/analysis/metagenomic-niche';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type AbundanceRequest =
  | { kind: 'import'; content: string; filename: string }
  | { kind: 'metadata'; content: string; dataset: AbundanceDataset; options: Partial<AbundanceOptions> }
  | { kind: 'analyze'; dataset: AbundanceDataset; options: Partial<AbundanceOptions> }
  | { kind: 'demo'; seed: number };
export interface AbundanceWorkResult {
  dataset: AbundanceDataset;
  options: AbundanceOptions;
  analysis: AbundanceAnalysis | null;
  record: AnalysisRecord | null;
  verified: boolean;
}
export type AbundanceWorkerMessage =
  | { kind: 'progress'; phase: string }
  | { kind: 'result'; result: AbundanceWorkResult }
  | { kind: 'error'; message: string };

export async function executeAbundanceRequest(request: AbundanceRequest, progress: (phase: string) => void = () => {}): Promise<AbundanceWorkResult> {
  let dataset: AbundanceDataset;
  let options: Partial<AbundanceOptions> = {};
  if (request.kind === 'import' || request.kind === 'metadata') {
    progress('Reading and validating local data');
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) {
      throw new Error('Abundance file exceeds the 10 MiB analysis-record limit (datasets are limited to 4 MiB).');
    }
  }
  if (request.kind === 'import') {
    const text = request.content.replace(/^\uFEFF/, '');
    if (text.trimStart().startsWith('{') && JSON.parse(text).format === 'phage-explorer-analysis') {
      progress('Validating and recomputing saved abundance analysis');
      const replay = await replayAbundanceAnalysis(text);
      return { dataset: replay.dataset, options: replay.result.options, analysis: replay.result, record: replay.record, verified: true };
    }
    dataset = parseAbundanceDataset(text, request.filename);
  } else if (request.kind === 'metadata') {
    dataset = importAbundanceMetadata(request.content, request.dataset);
    options = request.options;
  } else if (request.kind === 'demo') {
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff) throw new Error('Example seed must be a uint32.');
    dataset = validateAbundanceDataset({ format: 'phage-explorer-abundance', version: 1,
      name: `Synthetic community (seed ${request.seed})`, units: 'counts',
      source: { kind: 'demo', description: 'Explicitly selected synthetic community; not measurements of the selected phage.', reference: null },
      table: generateDemoAbundanceTable(12, 16, 3, createSeededRng(`abundance-example:${request.seed}`)), metadata: [] });
    options = { seed: request.seed };
  } else if (request.kind === 'analyze') {
    dataset = validateAbundanceDataset(request.dataset);
    progress('Computing sample-wise CLR, permutation tests and NMF factors');
    const analysis = analyzeAbundanceDataset(dataset, request.options);
    progress('Binding exact inputs and method parameters to the result');
    const record = await createAbundanceAnalysisRecord(dataset, analysis);
    return { dataset, options: analysis.options, analysis, record, verified: false };
  } else throw new Error('Unsupported abundance operation.');
  // Loading and computing are separate actions so parameters can be inspected
  // and reduced even for an input whose default analysis would exceed the budget.
  return { dataset, options: resolveAbundanceOptions(dataset, options), analysis: null, record: null, verified: false };
}
