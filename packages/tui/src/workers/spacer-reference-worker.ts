import { parentPort } from 'node:worker_threads';
import { executeSpacerRequest, type SpacerRequest, type SpacerMessage } from '../../../web/src/workers/SpacerReferenceSession';
import { executeTerminalAcrHeuristic, type TerminalAcrRequest, type TerminalAcrMessage } from '../commands/acr-heuristic';

if (!parentPort) throw new Error('Spacer references must run in a worker thread.');
const port = parentPort;
port.once('message', (request: SpacerRequest | TerminalAcrRequest) => {
  const send = (message: SpacerMessage | TerminalAcrMessage) => port.postMessage(message);
  if (request.kind === 'acr') {
    send({ kind: 'progress', phase: 'Checking annotations and scoring the optional size/charge heuristic' });
    try { send({ kind: 'acr-result', value: executeTerminalAcrHeuristic(request) }); }
    catch (cause) { send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { port.close(); }
    return;
  }
  void executeSpacerRequest(request, phase => send({ kind: 'progress', phase })).then(
    value => send({ kind: 'result', value }),
    cause => send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
  ).finally(() => port.close());
});
