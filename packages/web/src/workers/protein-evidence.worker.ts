import { executeProteinEvidenceRequest, type ProteinEvidenceMessage, type ProteinEvidenceRequest } from './ProteinEvidenceSession';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ProteinEvidenceRequest>) => void) | null;
  postMessage(message: ProteinEvidenceMessage): void;
};
scope.onmessage = event => {
  void executeProteinEvidenceRequest(event.data, phase => scope.postMessage({ kind: 'progress', phase }))
    .then(result => scope.postMessage(result))
    .catch(cause => scope.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
