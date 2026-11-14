import { executeRNAStructureRequest, type RNAStructureRequest, type RNAStructureMessage } from './RNAStructureSession';

self.onmessage = (event: MessageEvent<RNAStructureRequest>) => {
  void executeRNAStructureRequest(event.data)
    .then(result => self.postMessage({ kind: 'result', result } satisfies RNAStructureMessage))
    .catch(cause => self.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) } satisfies RNAStructureMessage));
};
