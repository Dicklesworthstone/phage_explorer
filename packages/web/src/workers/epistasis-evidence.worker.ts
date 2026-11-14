import { executeEpistasisEvidenceRequest, type EpistasisEvidenceRequest, type EpistasisEvidenceMessage } from './EpistasisEvidenceSession';

const send = (message: EpistasisEvidenceMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<EpistasisEvidenceRequest>) => {
  void executeEpistasisEvidenceRequest(event.data, phase => send({ kind: 'progress', phase }))
    .then(result => send({ kind: 'result', result }))
    .catch((cause: unknown) => send({ kind: 'error', message: cause instanceof Error ? cause.message : 'Epistasis analysis failed.' }));
};
