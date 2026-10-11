import { executeAlignedPhylogenyRequest, type AlignedPhylogenyMessage, type AlignedPhylogenyRequest } from './AlignedPhylogenySession';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AlignedPhylogenyRequest>) => void) | null;
  postMessage(message: AlignedPhylogenyMessage): void;
};
scope.onmessage = event => {
  void executeAlignedPhylogenyRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(experiment => scope.postMessage({ kind: 'result', experiment, verified: event.data.kind === 'replay' }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
