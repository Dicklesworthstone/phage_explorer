import { executeMosaicRequest, type MosaicMessage, type MosaicRequest } from './MosaicSession';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MosaicRequest>) => void) | null;
  postMessage(message: MosaicMessage): void;
};
scope.onmessage = event => {
  void executeMosaicRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(experiment => scope.postMessage({ kind: 'result', experiment, verified: event.data.kind === 'replay' }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
