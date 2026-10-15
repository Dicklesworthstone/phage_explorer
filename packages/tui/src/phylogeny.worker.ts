/** Static worker entry point. No executable paths or code are taken from input data. */
import { parentPort } from 'node:worker_threads';
import { performPhylogenyTask, type PhylogenyTask, type PhylogenyWorkerReply } from './headless-phylogeny';

if (parentPort) {
  const port = parentPort;
  port.once('message', async (task: PhylogenyTask) => {
    let reply: PhylogenyWorkerReply;
    try { reply = { ok: true, value: await performPhylogenyTask(task) }; }
    catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    port.postMessage(reply);
  });
}
