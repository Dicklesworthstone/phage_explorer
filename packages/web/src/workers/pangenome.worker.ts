import { executePangenomeRequest, type PangenomeRequest, type PangenomeMessage } from './PangenomeSession';

const send = (message: PangenomeMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<PangenomeRequest>) => {
  void executePangenomeRequest(event.data, phase => send({ kind: 'progress', phase }))
    .then(result => send({ kind: 'result', result }))
    .catch(cause => send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
