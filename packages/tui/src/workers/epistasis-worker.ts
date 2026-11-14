/** Native transport for the exact browser assay evidence producer. */
import { parentPort } from 'node:worker_threads';
import { executeEpistasisEvidenceRequest, type EpistasisEvidenceRequest } from '../../../web/src/workers/EpistasisEvidenceSession';

if (!parentPort) throw new Error('Epistasis worker requires a parent message port.');
const port = parentPort;
port.once('message', (request: EpistasisEvidenceRequest) => {
  void executeEpistasisEvidenceRequest(request, phase => port.postMessage({ kind: 'progress', phase }))
    .then(result => port.postMessage({ kind: 'result', result }))
    .catch((cause: unknown) => port.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : 'Epistasis computation failed.' }))
    .finally(() => port.close());
});
