/// <reference lib="webworker" />

import type { GeneInfo, CRISPRAnalysisResult } from '@phage-explorer/core';
import { analyzeCRISPRPressure } from '@phage-explorer/core';

interface CRISPRWorkerRequest {
  jobId?: string;
  sequence: string;
  genes: GeneInfo[];
  /**
   * The phage's real host. Carried so the analysis can name whose spacer data
   * is missing rather than returning an unexplained empty result.
   */
  host?: string;
}

interface CRISPRWorkerResponse {
  ok: boolean;
  jobId?: string;
  result?: CRISPRAnalysisResult;
  error?: string;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<CRISPRWorkerRequest>) => {
  const { jobId, sequence, genes, host } = event.data;
  try {
    if (!sequence || sequence.length === 0) {
      ctx.postMessage({
        ok: false,
        jobId,
        error: 'No sequence provided',
      } satisfies CRISPRWorkerResponse);
      return;
    }

    // No `spacers` argument: the catalogue has no spacer data for any of its
    // hosts. Measured, not assumed -- see the header of packages/core/src/crispr.ts.
    const result = analyzeCRISPRPressure(sequence, genes, { host });

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

