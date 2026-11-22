import { executeAttachmentRequest, type ProphageAttachmentRequest, type ProphageAttachmentMessage } from './ProphageAttachmentSession';
const scope = self as unknown as { onmessage: ((event: MessageEvent<ProphageAttachmentRequest>) => void) | null; postMessage: (message: ProphageAttachmentMessage) => void };
scope.onmessage = event => {
  void executeAttachmentRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(value => scope.postMessage({ kind: 'result', value }))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
