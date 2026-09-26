import { executeAbundanceRequest, type AbundanceRequest, type AbundanceWorkerMessage } from './abundance-runtime';

const send = (message: AbundanceWorkerMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<AbundanceRequest>) => {
  void executeAbundanceRequest(event.data, phase => send({ kind: 'progress', phase }))
    .then(result => send({ kind: 'result', result }))
    .catch((error: unknown) => send({ kind: 'error', message: error instanceof Error ? error.message : 'Abundance analysis failed.' }));
};
