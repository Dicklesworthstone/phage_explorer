import { executeHostMetabolismRequest, type HostMetabolismRequest, type HostMetabolismMessage } from './HostMetabolismSession';
const scope = self as unknown as { onmessage: ((event: MessageEvent<HostMetabolismRequest>) => void) | null; postMessage: (message: HostMetabolismMessage) => void };
scope.onmessage = event => {
  void executeHostMetabolismRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(value => scope.postMessage({ kind: 'result', value }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
