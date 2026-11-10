/** Native transport for the exact browser environmental evidence producer. */
import { parentPort } from 'node:worker_threads';
import { executeEnvironmentalRequest, type EnvironmentalRequest } from '../../../web/src/workers/environmental-runtime';

if (!parentPort) throw new Error('Environmental worker requires a parent message port.');
const port = parentPort;
port.once('message', (request: EnvironmentalRequest) => {
  void executeEnvironmentalRequest(request, phase => port.postMessage({ kind: 'progress', phase }))
    .then(result => port.postMessage({ kind: 'result', result }))
    .catch((cause: unknown) => port.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : 'Environmental computation failed.' }))
    .finally(() => port.close());
});
