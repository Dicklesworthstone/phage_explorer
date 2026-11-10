import { describe, expect, it } from 'bun:test';
import { executeComparisonJob } from './comparison.worker';
import type { ComparisonJob, ComparisonWorkerMessage, SequenceBytesRef } from './types';

const metadata = { jobId: 'literal-alignment', phageA: { id: 1, name: 'A', accession: 'A' },
  phageB: { id: 2, name: 'B', accession: 'B' }, genesA: [], genesB: [] };

function bytes(sequence: string, shared = false): SequenceBytesRef {
  const buffer = shared ? new SharedArrayBuffer(sequence.length + 4) : new ArrayBuffer(sequence.length + 4);
  new Uint8Array(buffer, 2, sequence.length).set(new TextEncoder().encode(sequence));
  return { buffer, byteOffset: 2, byteLength: sequence.length, length: sequence.length, encoding: 'ascii' };
}

describe('comparison worker exact diff transport', () => {
  it('carries the same exact indel alignment through strings and offset/shared bytes', async () => {
    const string = await executeComparisonJob({ ...metadata, sequenceA: 'ACGT', sequenceB: 'CGTA' });
    const shared = await executeComparisonJob({ ...metadata, sequenceARef: bytes('ACGT', true), sequenceBRef: bytes('CGTA') });
    expect(string.ok).toBe(true); expect(shared.ok).toBe(true);
    expect(string.diff).toEqual(shared.diff);
    expect(string.diff?.status).toBe('complete');
    if (string.diff?.status === 'complete') expect(string.diff.stats).toMatchObject({ distance: 2, insertions: 1, deletions: 1, substitutions: 0 });
  });

  it('preserves other comparison metrics when the exact diff exceeds its budget', async () => {
    const output = await executeComparisonJob({ ...metadata, sequenceA: 'A'.repeat(3000), sequenceB: 'C'.repeat(3001) });
    expect(output.ok).toBe(true);
    expect(output.result?.biological).toMatchObject({ lengthA: 3000, lengthB: 3001, gcContentA: 0, gcContentB: 100 });
    expect(output.diff?.status).toBe('unavailable');
    expect(output.diff).not.toHaveProperty('stats'); expect(output.diff).not.toHaveProperty('positions');
  });

  it('returns an error for malformed byte transport rather than padding missing bases', async () => {
    const ref = bytes('ACGT'); ref.length = 5;
    const output = await executeComparisonJob({ ...metadata, sequenceARef: ref, sequenceBRef: bytes('ACGT') });
    expect(output.ok).toBe(false); expect(output.error).toContain('byte length'); expect(output.diff).toBeUndefined();
  });

  it('runs the actual worker entrypoint and transfers a complete mask', async () => {
    const worker = new Worker(new URL('./comparison.worker.ts', import.meta.url).href);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await new Promise<ComparisonWorkerMessage>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Comparison worker did not respond')), 10000);
        worker.onmessage = event => resolve(event.data as ComparisonWorkerMessage);
        worker.onerror = event => reject(new Error(event.message));
        const job: ComparisonJob = { ...metadata, sequenceA: 'ACGT', sequenceB: 'ACGGT' };
        worker.postMessage(job);
      });
      expect(output.ok).toBe(true); expect(output.jobId).toBe(metadata.jobId);
      expect(output.diff?.status).toBe('complete');
      if (output.diff?.status === 'complete') {
        expect(output.diff.mask).toBeInstanceOf(Uint8Array);
        expect(output.diff.stats).toMatchObject({ distance: 1, insertions: 1, deletions: 0, substitutions: 0, matches: 4 });
        expect(output.diff.positions).toHaveLength(1);
      }
    } finally { if (timeout) clearTimeout(timeout); worker.terminate(); }
  });
});
