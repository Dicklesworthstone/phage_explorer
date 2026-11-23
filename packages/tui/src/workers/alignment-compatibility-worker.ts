import { parentPort } from 'node:worker_threads';
import { executeCompatibilityJob, type CompatibilityJob } from '../commands/alignment-compatibility';

if (!parentPort) throw new Error('alignment-compatibility-worker must be run as a worker');
parentPort.on('message', async (job: CompatibilityJob) => {
  try { parentPort?.postMessage({ kind: 'result', result: await executeCompatibilityJob(job) }); }
  catch (cause) { parentPort?.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) }); }
});
