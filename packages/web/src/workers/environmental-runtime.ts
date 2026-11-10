/** Local environmental evidence protocol; imports never trigger a network lookup. */
import {
  analyzeEnvironmentalDataset, createDemoEnvironmentalDataset, createEnvironmentalAnalysisRecord,
  environmentalDatasetFromAbundance, parseEnvironmentalDataset, replayEnvironmentalAnalysisRecord,
  validateEnvironmentalDataset, type EnvironmentalAnalysis, type EnvironmentalDataset,
} from '../../../core/src/analysis/environmental-evidence';
import { parseAbundanceDataset, replayAbundanceAnalysis } from '../../../core/src/analysis/abundance';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export const ENVIRONMENTAL_FILE_LIMIT = 10 * 1024 * 1024;
export type EnvironmentalRequest =
  | { kind: 'import' | 'replay'; content: string }
  | { kind: 'analyze'; dataset: EnvironmentalDataset }
  | { kind: 'abundance'; content: string; taxon: string }
  | { kind: 'demo' };
export interface EnvironmentalWorkResult {
  dataset: EnvironmentalDataset;
  analysis: EnvironmentalAnalysis | null;
  record: AnalysisRecord | null;
  verified: boolean;
}
export type EnvironmentalWorkerMessage =
  | { kind: 'progress'; phase: string }
  | { kind: 'result'; result: EnvironmentalWorkResult }
  | { kind: 'error'; message: string };

export function environmentalInputText(content: unknown): string {
  if (typeof content !== 'string' || content.length > ENVIRONMENTAL_FILE_LIMIT
    || new TextEncoder().encode(content).length > ENVIRONMENTAL_FILE_LIMIT) {
    throw new Error('Environmental input exceeds the 10 MiB experiment limit (datasets are limited to 4 MiB).');
  }
  return content.replace(/^\uFEFF/, '');
}

/** Source-only imports stop for review. Saved experiments must be recomputed first. */
export async function executeEnvironmentalRequest(request: EnvironmentalRequest,
  progress: (phase: string) => void = () => {}): Promise<EnvironmentalWorkResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported environmental operation.');
  let dataset: EnvironmentalDataset;
  if (request.kind === 'import' || request.kind === 'replay') {
    const text = environmentalInputText(request.content);
    progress('Validating environmental inputs and source attribution');
    const value: unknown = JSON.parse(text);
    if (request.kind === 'replay' || value && typeof value === 'object' && 'format' in value && value.format === 'phage-explorer-analysis') {
      progress('Recomputing sample summaries and verifying the complete saved experiment');
      const replay = await replayEnvironmentalAnalysisRecord(text);
      return { ...replay, verified: true };
    }
    dataset = parseEnvironmentalDataset(text);
  } else if (request.kind === 'abundance') {
    const text = environmentalInputText(request.content);
    progress('Joining the explicitly selected taxon to sample metadata by identifier');
    const value: unknown = text.trimStart().startsWith('{') ? JSON.parse(text) : null;
    // An abundance analysis is useful input too, but its producer must verify it
    // before its measurements enter a different scientific view.
    const abundance = value && typeof value === 'object' && 'format' in value && value.format === 'phage-explorer-analysis'
      ? (await replayAbundanceAnalysis(text)).dataset : parseAbundanceDataset(text);
    dataset = environmentalDatasetFromAbundance(abundance, request.taxon);
  } else if (request.kind === 'demo') {
    dataset = createDemoEnvironmentalDataset();
  } else if (request.kind === 'analyze') {
    dataset = validateEnvironmentalDataset(request.dataset);
    progress('Summarizing assayed, detected and missing observations without imputation');
    const analysis = analyzeEnvironmentalDataset(dataset);
    progress('Binding source, date and location precision to the result');
    const record = await createEnvironmentalAnalysisRecord(dataset, analysis);
    return { dataset, analysis, record, verified: false };
  } else throw new Error('Unsupported environmental operation.');
  return { dataset, analysis: null, record: null, verified: false };
}
