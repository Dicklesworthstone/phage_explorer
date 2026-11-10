import { executeEnvironmentalRequest, type EnvironmentalRequest, type EnvironmentalWorkerMessage } from './environmental-runtime';

const send = (message: EnvironmentalWorkerMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<EnvironmentalRequest>) => {
  void executeEnvironmentalRequest(event.data, phase => send({ kind: 'progress', phase }))
    .then(result => send({ kind: 'result', result }))
    .catch((error: unknown) => send({ kind: 'error', message: error instanceof Error ? error.message : 'Environmental analysis failed.' }));
};
