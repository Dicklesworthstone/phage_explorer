import { executeGenomeCdsRequest, type GenomeCdsRequest, type GenomeCdsMessage } from './GenomeCdsSession';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GenomeCdsRequest>) => void) | null;
  postMessage(message: GenomeCdsMessage): void;
};
scope.onmessage = event => {
  void executeGenomeCdsRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(value => scope.postMessage({ kind: 'result', value }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
