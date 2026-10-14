/** One isolated terminal request. No filenames, shell commands or network inputs
 * cross this boundary. The parent terminates CPU work on cancellation/timeout.
 */
import { isMainThread, parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS } from '../../core/src/command-session';
import { parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import type { ReplayProgress, ResearchTapeInspection, ResearchReplayResult } from './research-replay';

export interface TerminalExperimentReport {
  format: 'phage-explorer-experiment-replay'; version: 1; verified: true; headless: true;
  inputRecordSha256: string;
  method: AnalysisRecord['method']; cacheKey: string; resultId: string;
  inputs: Array<Pick<AnalysisRecord['inputs'][number], 'id' | 'accession' | 'source' | 'sha256'>>;
  interpretation: string;
}

export type TerminalResearchRequest = { type: 'inspect'; content: string } |
  { type: 'replay'; content: string; repetitions: number; exportAnalysis: boolean } |
  { type: 'replay-experiment'; content: string; outputFormat: 'none' | 'json' | 'tsv' };
export type TerminalResearchResult = { type: 'inspection'; inspection: ResearchTapeInspection } |
  { type: 'replayed'; report: ResearchReplayResult['report']; analysisJson: string | null } |
  { type: 'experiment-replayed'; report: TerminalExperimentReport; exportText: string | null };
export type TerminalResearchMessage = TerminalResearchResult | { type: 'progress'; progress: ReplayProgress } | { type: 'error'; message: string };

export function validateTerminalResearchRequest(value: unknown): asserts value is TerminalResearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal research request.');
  const request = value as Record<string, unknown>;
  const allowed = request.type === 'inspect' ? ['type', 'content'] : request.type === 'replay-experiment'
    ? ['type', 'content', 'outputFormat'] : ['type', 'content', 'repetitions', 'exportAnalysis'];
  if (!['inspect', 'replay', 'replay-experiment'].includes(String(request.type)) || Object.keys(request).sort().join('|') !== allowed.sort().join('|') ||
    typeof request.content !== 'string' || request.content.length > COMMAND_LIMITS.bytes || new TextEncoder().encode(request.content).length > COMMAND_LIMITS.bytes) {
    throw new Error('Expected a supported terminal operation and UTF-8 JSON of at most 10 MiB.');
  }
  if (request.type === 'replay' && (typeof request.exportAnalysis !== 'boolean' || !Number.isSafeInteger(request.repetitions) ||
    Number(request.repetitions) < 1 || Number(request.repetitions) > COMMAND_LIMITS.repetitions)) throw new Error('Invalid replay export/repetition options.');
  if (request.type === 'replay-experiment' && !['none', 'json', 'tsv'].includes(String(request.outputFormat))) {
    throw new Error('Experiment output must be none, json or tsv.');
  }
}
export async function executeTerminalResearchRequest(request: TerminalResearchRequest,
  progress: (value: ReplayProgress) => void = () => {}): Promise<TerminalResearchResult> {
  validateTerminalResearchRequest(request);
  request = structuredClone(request);
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
    } else if (saved.method.id === 'restriction-digest') {
      const { replayRestrictionDigestRecord, exportRestrictionDigestTsv } = await import('../../core/src/analysis/restriction-digest');
      fresh = await replayRestrictionDigestRecord(request.content);
      table = exportRestrictionDigestTsv;
    } else {
      throw new Error('Experiment replay supports sequence-dot-plot and restriction-digest records only.');
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
  const { inspectResearchTape, replayResearchTape } = await import('./research-replay');
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
