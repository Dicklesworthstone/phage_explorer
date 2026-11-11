import { parentPort } from 'node:worker_threads';
import { executeGrowthJob, type GrowthJob, type GrowthJobMessage } from '../commands/growth';

if (parentPort) {
  const port = parentPort;
  port.on('message', (job: GrowthJob) => {
    void executeGrowthJob(job, message => port.postMessage({ kind: 'progress', message } satisfies GrowthJobMessage))
      .then(result => port.postMessage({ kind: 'result', result } satisfies GrowthJobMessage))
      .catch(cause => port.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) } satisfies GrowthJobMessage));
  });
}
