import { analyzeSyntenyExperiment, replaySyntenyExperiment, type SyntenyExperiment,
  type SyntenyExperimentInput } from '../../../comparison/src/synteny-experiment';

export type SyntenyRequest =
  | { kind: 'analyze'; input: SyntenyExperimentInput }
  | { kind: 'replay'; content: string };
export type SyntenyWorkerJob = SyntenyRequest & { jobId: string };
export type SyntenyWorkerMessage =
  | { jobId: string; kind: 'progress'; phase: string }
  | { jobId: string; kind: 'result'; value: SyntenyExperiment }
  | { jobId: string; kind: 'error'; message: string };

export async function executeSyntenyRequest(request: SyntenyRequest,
  progress: (phase: string) => void = () => {}): Promise<SyntenyExperiment> {
  if (request?.kind === 'analyze') {
    progress('Comparing exact ordered annotations and binding the complete matrix');
    return analyzeSyntenyExperiment(request.input);
  }
  if (request?.kind === 'replay') {
    if (typeof request.content !== 'string') throw new Error('Saved synteny evidence must be JSON text.');
    progress('Verifying saved inputs and recomputing the complete annotation comparison');
    return replaySyntenyExperiment(request.content);
  }
  throw new Error('Unsupported synteny operation.');
}

if (typeof self !== 'undefined') self.onmessage = (event: MessageEvent<SyntenyWorkerJob>) => {
  const job = event.data, jobId = job?.jobId;
  if (typeof jobId !== 'string') return;
  void executeSyntenyRequest(job, phase => self.postMessage({ jobId, kind: 'progress', phase } satisfies SyntenyWorkerMessage))
    .then(value => self.postMessage({ jobId, kind: 'result', value } satisfies SyntenyWorkerMessage))
    .catch((cause: unknown) => self.postMessage({ jobId, kind: 'error',
      message: cause instanceof Error ? cause.message : 'Synteny computation failed.' } satisfies SyntenyWorkerMessage));
};
