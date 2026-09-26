/** The parent stays responsive to cancellation while all numerical work runs here. */
import { parentPort } from 'node:worker_threads';
import { executeAbundanceJob, type AbundanceJob } from '../commands/abundance';

if (!parentPort) throw new Error('Abundance worker requires a parent message port.');
const port = parentPort;
port.once('message', (job: AbundanceJob) => {
  void executeAbundanceJob(job, phase => port.postMessage({ kind: 'progress', phase }))
    .then(result => port.postMessage({ kind: 'result', result }))
    .catch((cause: unknown) => port.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : 'Abundance computation failed.' }))
    .finally(() => port.close());
});
