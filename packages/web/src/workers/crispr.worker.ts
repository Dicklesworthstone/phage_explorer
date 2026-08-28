/// <reference lib="webworker" />

import type { GeneInfo, CRISPRAnalysisResult } from '@phage-explorer/core';
import { analyzeCRISPRPressure } from '@phage-explorer/core';

interface CRISPRWorkerRequest {
  jobId?: string;
  sequence: string;
  genes: GeneInfo[];
}

interface CRISPRWorkerResponse {
  ok: boolean;
  jobId?: string;
  result?: CRISPRAnalysisResult;
  error?: string;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<CRISPRWorkerRequest>) => {
  const { jobId, sequence, genes } = event.data;
  try {
    if (!sequence || sequence.length === 0) {
      ctx.postMessage({
        ok: false,
        jobId,
        error: 'No sequence provided',
      } satisfies CRISPRWorkerResponse);
      return;
    }

    const result = analyzeCRISPRPressure(sequence, genes);

    ctx.postMessage({
      ok: true,
      jobId,
      result,
    } satisfies CRISPRWorkerResponse);
  } catch (error) {
    ctx.postMessage({
      ok: false,
      jobId,
      error: error instanceof Error ? error.message : 'CRISPR analysis failed',
    } satisfies CRISPRWorkerResponse);
  }
};

export {};

