import { executeCodonSelectionRequest, type CodonSelectionRequest, type CodonSelectionMessage } from './CodonSelectionSession';
const send = (message: CodonSelectionMessage) => self.postMessage(message);
self.onmessage = (event: MessageEvent<CodonSelectionRequest>) => {
  void executeCodonSelectionRequest(event.data, phase => send({ kind: 'progress', phase })).then(
    value => send({ kind: 'result', value }),
    cause => send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
  );
};
