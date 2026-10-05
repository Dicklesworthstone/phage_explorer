/** One isolated terminal request. No filenames, shell commands or network inputs
 * cross this boundary. The parent terminates CPU work on cancellation/timeout.
 */
import { isMainThread, parentPort } from 'node:worker_threads';
import { COMMAND_LIMITS } from '../../core/src/command-session';
import { serializeAnalysisRecord } from '../../core/src/analysis-result';
import { inspectResearchTape, replayResearchTape,
  type ReplayProgress, type ResearchTapeInspection, type ResearchReplayResult } from './research-replay';

export type TerminalResearchRequest = { type: 'inspect'; content: string } |
  { type: 'replay'; content: string; repetitions: number; exportAnalysis: boolean };
export type TerminalResearchResult = { type: 'inspection'; inspection: ResearchTapeInspection } |
  { type: 'replayed'; report: ResearchReplayResult['report']; analysisJson: string | null };
export type TerminalResearchMessage = TerminalResearchResult | { type: 'progress'; progress: ReplayProgress } | { type: 'error'; message: string };

export function validateTerminalResearchRequest(value: unknown): asserts value is TerminalResearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal research request.');
  const request = value as Record<string, unknown>;
  const allowed = request.type === 'inspect' ? ['type', 'content'] : ['type', 'content', 'repetitions', 'exportAnalysis'];
  if (!['inspect', 'replay'].includes(String(request.type)) || Object.keys(request).sort().join('|') !== allowed.sort().join('|') ||
    typeof request.content !== 'string' || request.content.length > COMMAND_LIMITS.bytes || new TextEncoder().encode(request.content).length > COMMAND_LIMITS.bytes) {
    throw new Error('Expected a supported terminal operation and a command tape of at most 10 MiB.');
  }
  if (request.type === 'replay' && (typeof request.exportAnalysis !== 'boolean' || !Number.isSafeInteger(request.repetitions) ||
    Number(request.repetitions) < 1 || Number(request.repetitions) > COMMAND_LIMITS.repetitions)) throw new Error('Invalid replay export/repetition options.');
}
export async function executeTerminalResearchRequest(request: TerminalResearchRequest,
  progress: (value: ReplayProgress) => void = () => {}): Promise<TerminalResearchResult> {
  validateTerminalResearchRequest(request);
  request = structuredClone(request);
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
