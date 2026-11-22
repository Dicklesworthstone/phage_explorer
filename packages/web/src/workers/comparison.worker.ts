import { createGenomeComparisonExperiment, replayGenomeComparisonExperiment } from '@phage-explorer/comparison';
import type { ComparisonJob, ComparisonWorkerMessage, SequenceBytesRef } from './types';

const textDecoder = new TextDecoder();

function decodeSequenceRef(ref: SequenceBytesRef): string {
  const view = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
  if (!Number.isSafeInteger(ref.length) || ref.length < 0 || ref.length > view.length) {
    throw new Error('Comparison sequence byte length does not match its buffer.');
  }
  const bytes = view.subarray(0, ref.length);
  if (ref.encoding === 'ascii') {
    // TextDecoder rejects SharedArrayBuffer views; copy only that transport.
    return textDecoder.decode(typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
      ? new Uint8Array(bytes) : bytes);
  }
  if (ref.encoding !== 'acgt05') throw new Error('Unsupported comparison sequence encoding.');
  const out = new Uint8Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const code = bytes[i];
    out[i] = code === 0 ? 65 : code === 1 ? 67 : code === 2 ? 71 : code === 3 ? 84 : 78;
  }
  return textDecoder.decode(out);
}

/** Same producer used by actual workers and transport regression tests. */
export async function executeComparisonJob(job: ComparisonJob): Promise<ComparisonWorkerMessage> {
  const message: ComparisonWorkerMessage = { ok: false, jobId: job?.jobId };
  try {
    if (!job || typeof job !== 'object') throw new Error('Invalid comparison job: missing required sequences');
    if (job.kind === 'replay') {
      const experiment = await replayGenomeComparisonExperiment(job.content.replace(/^\uFEFF/, ''));
      return { ok: true, jobId: job.jobId, experiment };
    }
    if (job.kind !== 'analyze') throw new Error('Unsupported comparison operation.');
    const sequenceA = 'sequenceA' in job ? job.sequenceA : decodeSequenceRef(job.sequenceARef);
    const sequenceB = 'sequenceB' in job ? job.sequenceB : decodeSequenceRef(job.sequenceBRef);
    if (typeof sequenceA !== 'string' || typeof sequenceB !== 'string' || !sequenceA || !sequenceB) {
      throw new Error('Invalid comparison job: missing required sequences');
    }
    const experiment = await createGenomeComparisonExperiment(
      { phage: job.phageA, source: job.sourceA, sequence: sequenceA, genes: job.genesA, codonUsage: job.codonUsageA },
      { phage: job.phageB, source: job.sourceB, sequence: sequenceB, genes: job.genesB, codonUsage: job.codonUsageB },
      job.options);
    // Numerical comparisons remain useful when an exact base-by-base alignment
    // exceeds its budget. Diff availability is separate, never partial success.
    return { ok: true, jobId: job.jobId, experiment };
  } catch (cause) {
    message.error = cause instanceof Error ? cause.message : 'Comparison failed';
    return message;
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = async (event: MessageEvent<ComparisonJob>) => {
    const message = await executeComparisonJob(event.data);
    const transfers: Transferable[] = [];
    const diff = message.experiment?.result.sequenceDiff;
    if (diff?.status === 'complete' && diff.mask.byteLength) {
      transfers.push(diff.mask.buffer as ArrayBuffer);
    }
    self.postMessage(message, { transfer: transfers });
  };
}
