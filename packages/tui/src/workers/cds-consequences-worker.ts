import { parentPort } from 'node:worker_threads';
import { executeCdsConsequencesJob, type CdsConsequencesJob, type CdsConsequencesJobMessage } from '../commands/cds-consequences';

if (parentPort) {
  const port = parentPort;
  port.on('message', (job: CdsConsequencesJob) => {
    void executeCdsConsequencesJob(job, message =>
      port.postMessage({ kind: 'progress', message } satisfies CdsConsequencesJobMessage))
      .then(result => port.postMessage({ kind: 'result', result } satisfies CdsConsequencesJobMessage))
      .catch(cause => port.postMessage({ kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause) } satisfies CdsConsequencesJobMessage));
  });
}
