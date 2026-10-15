/** Isolated growth fitting with explicit observation models. No model inference. */
import { createPlaqueGrowthRecord, replayPlaqueGrowthRecord, PLAQUE_GROWTH_LIMITS } from '../../../core/src/analysis/plaque-growth';
import { createGrowthCurveRecord, replayGrowthCurveRecord } from '../../../core/src/analysis/one-step-growth';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

export type PlaqueGrowthRequest = { type: 'fit' | 'replay' | 'pfu-fit' | 'pfu-replay'; content: string };
export type PlaqueGrowthResponse = { type: 'result'; record: AnalysisRecord } | { type: 'error'; message: string };

export function validatePlaqueGrowthRequest(value: unknown): asserts value is PlaqueGrowthRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plaque-count request.');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join('|') !== 'content|type' || !['fit', 'replay', 'pfu-fit', 'pfu-replay'].includes(String(request.type))
    || typeof request.content !== 'string') throw new Error('Provide only a fit/replay operation and input JSON.');
  const fitting = request.type === 'fit' || request.type === 'pfu-fit';
  const limit = fitting ? PLAQUE_GROWTH_LIMITS.bytes : 10 * 1024 * 1024;
  if (request.content.length > limit || new TextEncoder().encode(request.content).length > limit) {
    throw new Error(fitting ? 'Growth input exceeds 1 MB.' : 'Saved growth evidence exceeds 10 MiB.');
  }
}
export async function executePlaqueGrowthRequest(request: PlaqueGrowthRequest): Promise<AnalysisRecord> {
  validatePlaqueGrowthRequest(request);
  const { type, content } = request;
  if (type === 'pfu-fit') return createGrowthCurveRecord(content);
  if (type === 'pfu-replay') return replayGrowthCurveRecord(content);
  return type === 'fit' ? createPlaqueGrowthRecord(content) : replayPlaqueGrowthRecord(content);
}

// Importable in tests without allocating a worker or requiring browser globals.
const scope = globalThis as unknown as {
  document?: unknown;
  postMessage?: (response: PlaqueGrowthResponse) => void;
  onmessage?: ((event: { data: PlaqueGrowthRequest }) => void) | null;
};
if (scope.document === undefined && typeof scope.postMessage === 'function') {
  const post = scope.postMessage.bind(scope);
  scope.onmessage = event => {
    void executePlaqueGrowthRequest(event.data).then(record => post({ type: 'result', record }))
      .catch((cause: unknown) => post({ type: 'error', message: cause instanceof Error ? cause.message : 'Plate-count computation failed.' }));
  };
}
