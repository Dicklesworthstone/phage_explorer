import { parentPort } from 'node:worker_threads';
import { executeHostMetabolismJob, type HostMetabolismJob, type HostMetabolismJobMessage } from '../commands/host-metabolism';
if (!parentPort) throw new Error('Host metabolism must run in a worker thread.');
const port = parentPort;
port.once('message', (job: HostMetabolismJob) => {
  const send = (message: HostMetabolismJobMessage) => port.postMessage(message);
  void executeHostMetabolismJob(job, phase => send({ kind: 'progress', phase })).then(
    result => send({ kind: 'result', result }),
    cause => send({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }),
  );
});
