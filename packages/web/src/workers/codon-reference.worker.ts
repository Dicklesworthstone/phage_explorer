/** Reference-input scoring and verification run locally, off the rendering thread. */
import { createReferenceCodonExperiment, replayReferenceCodonExperiment,
  createCodonReferenceCorpus, replayCodonReferenceCorpus, type CodonReferenceCorpus, type CodonCorpusOptions, type GenomeInput,
  type ReferenceCodonExperiment, type ReferenceCodonGenome, type ReferenceCodonOptions } from '@phage-explorer/core';

export type CodonScoreRequest =
  | { type: 'analyze'; genome: ReferenceCodonGenome; sequence: string; referenceText: string; options: ReferenceCodonOptions }
  | { type: 'verify'; content: string };
export type CodonCorpusRequest = { type: 'build-reference'; input: GenomeInput; options: CodonCorpusOptions } | { type: 'verify-reference'; content: string };
export type CodonReferenceRequest = CodonScoreRequest | CodonCorpusRequest;
export type CodonReferenceResult = ReferenceCodonExperiment | CodonReferenceCorpus;
export type CodonReferenceResponse =
  | { type: 'result'; experiment: CodonReferenceResult }
  | { type: 'error'; message: string };

export function executeCodonReferenceRequest(request: CodonCorpusRequest): Promise<CodonReferenceCorpus>;
export function executeCodonReferenceRequest(request: CodonScoreRequest): Promise<ReferenceCodonExperiment>;
export function executeCodonReferenceRequest(request: CodonReferenceRequest): Promise<CodonReferenceResult>;
export async function executeCodonReferenceRequest(request: CodonReferenceRequest): Promise<CodonReferenceResult> {
  if (!request || typeof request !== 'object') throw new Error('Missing codon-reference request.');
  if (request.type === 'analyze') return createReferenceCodonExperiment(request.genome, request.sequence, request.referenceText, request.options);
  if (request.type === 'verify') return replayReferenceCodonExperiment(request.content);
  if (request.type === 'build-reference') return createCodonReferenceCorpus(request.input, request.options);
  if (request.type === 'verify-reference') return replayCodonReferenceCorpus(request.content);
  throw new Error('Unsupported codon-reference request.');
}

export interface CodonReferenceWorkerPort {
  postMessage(request: CodonReferenceRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<CodonReferenceResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
/** Own one worker per explicit run. Abort rejects promptly and destroys all late work. */
export function runCodonReferenceTask(createWorker: () => CodonReferenceWorkerPort, request: CodonCorpusRequest, signal: AbortSignal): Promise<CodonReferenceCorpus>;
export function runCodonReferenceTask(createWorker: () => CodonReferenceWorkerPort, request: CodonScoreRequest, signal: AbortSignal): Promise<ReferenceCodonExperiment>;
export function runCodonReferenceTask(createWorker: () => CodonReferenceWorkerPort, request: CodonReferenceRequest, signal: AbortSignal): Promise<CodonReferenceResult>;
export function runCodonReferenceTask(createWorker: () => CodonReferenceWorkerPort, request: CodonReferenceRequest,
  signal: AbortSignal): Promise<CodonReferenceResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Analysis cancelled.', 'AbortError')); return; }
    let worker: CodonReferenceWorkerPort;
    try { worker = createWorker(); }
    catch { reject(new Error('The browser could not start the reference-analysis worker. Retry or use the terminal command.')); return; }
    let done = false;
    const finish = (experiment?: CodonReferenceResult, error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', cancel);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(experiment!);
    };
    const cancel = () => finish(undefined, new DOMException('Analysis cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      const response = event.data;
      if (response?.type === 'error') finish(undefined, new Error(response.message));
      else if (response?.type === 'result' && response.experiment?.record?.format === 'phage-explorer-analysis'
        && (request.type === 'build-reference' || request.type === 'verify-reference'
          ? 'reference' in response.experiment && response.experiment.reference?.format === 'phage-explorer-codon-reference' && Array.isArray(response.experiment.genes)
          : 'analysis' in response.experiment && Array.isArray(response.experiment.analysis?.genes))) finish(response.experiment);
      else finish(undefined, new Error('Invalid reference-analysis worker response.'));
    };
    worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('Reference-analysis worker failed. No result was applied.')); };
    worker.onmessageerror = () => finish(undefined, new Error('Reference-analysis worker response could not be decoded.'));
    try { if (signal.aborted) cancel(); else worker.postMessage(request); }
    catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event: MessageEvent<CodonReferenceRequest>) => {
    void executeCodonReferenceRequest(event.data)
      .then(experiment => self.postMessage({ type: 'result', experiment }))
      .catch((cause: unknown) => self.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Reference analysis failed.' }));
  };
}
