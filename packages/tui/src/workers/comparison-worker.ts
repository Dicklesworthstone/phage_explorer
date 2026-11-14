import { parentPort } from 'node:worker_threads';
import { compareGenomes } from '@phage-explorer/comparison';
import type { GeneInfo, CodonUsageData } from '@phage-explorer/core';

export interface CompareJob {
  phageA: { id: number; name: string; accession: string };
  phageB: { id: number; name: string; accession: string };
  sequenceA: string;
  sequenceB: string;
  genesA: GeneInfo[];
  genesB: GeneInfo[];
  codonUsageA?: CodonUsageData | null;
  codonUsageB?: CodonUsageData | null;
}

if (!parentPort) {
  throw new Error('comparison-worker must be run as a worker');
}

parentPort.on('message', async (job: CompareJob) => {
  try {
    const result = await compareGenomes(
      job.phageA,
      job.phageB,
      job.sequenceA,
      job.sequenceB,
      job.genesA,
      job.genesB,
      job.codonUsageA,
      job.codonUsageB
    );
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

