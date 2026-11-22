import { executeCompatibilityRequest, type AlignmentCompatibilityRequest, type AlignmentCompatibilityMessage } from './AlignmentCompatibilitySession';
const scope = self as unknown as { onmessage: ((event: MessageEvent<AlignmentCompatibilityRequest>) => void) | null; postMessage: (message: AlignmentCompatibilityMessage) => void };
scope.onmessage = event => {
  void executeCompatibilityRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(value => scope.postMessage({ kind: 'result', value }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
