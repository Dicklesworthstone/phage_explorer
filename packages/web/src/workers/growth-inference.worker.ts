/** No network access: local observation import, mechanistic fitting and verified replay. */
import { parseGrowthData, resolveGrowthOptions, validateGrowthDataset, fitGrowthDataset, createGrowthRecord, replayGrowthRecord,
  type GrowthConditions, type GrowthDataset, type GrowthFitOptions, type GrowthFitResult } from '../../../core/src/analysis/growth-inference';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type GrowthRequest =
  | { kind: 'load'; content: string; name: string; conditions: GrowthConditions }
  | { kind: 'fit'; dataset: GrowthDataset; options: GrowthFitOptions };
export interface GrowthWorkResult {
  dataset: GrowthDataset;
  options: GrowthFitOptions;
  result: GrowthFitResult | null;
  record: AnalysisRecord | null;
  verified: boolean;
}
export type GrowthMessage = { kind: 'progress'; message: string } | { kind: 'result'; value: GrowthWorkResult } | { kind: 'error'; message: string };
export async function executeGrowthRequest(request: GrowthRequest, report: (message: string) => void = () => {}): Promise<GrowthWorkResult> {
  if (request.kind === 'load') {
    report('Validating local growth data');
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) throw new Error('Growth input exceeds the 10 MiB saved-record limit. Datasets are limited to 2 MiB.');
    const content = request.content.replace(/^\uFEFF/, '').trim();
    if (content.startsWith('{') && JSON.parse(content).format === 'phage-explorer-analysis') {
      report('Recomputing and verifying saved growth fit');
      return { ...await replayGrowthRecord(content, report), verified: true };
    }
    return { dataset: parseGrowthData(content, request.name, request.conditions), options: resolveGrowthOptions(), result: null, record: null, verified: false };
  }
  if (request.kind !== 'fit') throw new Error('Unsupported growth operation.');
  const dataset = validateGrowthDataset(request.dataset), options = resolveGrowthOptions(request.options);
  report('Solving mechanistic infection model');
  const result = fitGrowthDataset(dataset, options, report);
  report('Binding observations, fixed conditions and uncertainty assumptions to the fit');
  const record = await createGrowthRecord(dataset, options, result);
  return { dataset, options, result, record, verified: false };
}

// The exported runtime also runs in unit tests without booting a worker.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<GrowthRequest>) => {
    void executeGrowthRequest(event.data, message => self.postMessage({ kind: 'progress', message } satisfies GrowthMessage))
      .then(value => self.postMessage({ kind: 'result', value } satisfies GrowthMessage))
      .catch(cause => self.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) } satisfies GrowthMessage));
  };
}
