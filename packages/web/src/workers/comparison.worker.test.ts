import { describe, expect, it } from 'bun:test';
import { serializeAnalysisRecord } from '@phage-explorer/core';
import { DEFAULT_GENOME_COMPARISON_OPTIONS, genomeComparisonResultData } from '@phage-explorer/comparison';
import { executeComparisonJob } from './comparison.worker';
import type { ComparisonJob, ComparisonWorkerMessage, SequenceBytesRef } from './types';

const metadata = { kind: 'analyze' as const, jobId: 'literal-alignment', phageA: { id: 1, name: 'A', accession: 'A' },
  phageB: { id: 2, name: 'B', accession: 'B' }, sourceA: 'local' as const, sourceB: 'catalog' as const,
  genesA: [], genesB: [], codonUsageA: null, codonUsageB: null, options: { ...DEFAULT_GENOME_COMPARISON_OPTIONS } };

function bytes(sequence: string, shared = false): SequenceBytesRef {
  const buffer = shared ? new SharedArrayBuffer(sequence.length + 4) : new ArrayBuffer(sequence.length + 4);
  new Uint8Array(buffer, 2, sequence.length).set(new TextEncoder().encode(sequence));
  return { buffer, byteOffset: 2, byteLength: sequence.length, length: sequence.length, encoding: 'ascii', isShared: shared };
}

describe('comparison worker exact diff transport', () => {
  it('carries the same exact indel alignment through strings and offset/shared bytes', async () => {
    const string = await executeComparisonJob({ ...metadata, sequenceA: 'ACGT', sequenceB: 'CGTA' });
    const shared = await executeComparisonJob({ ...metadata, sequenceARef: bytes('ACGT', true), sequenceBRef: bytes('CGTA') });
    expect(string.ok).toBe(true); expect(shared.ok).toBe(true);
    expect(string.experiment!.record).toEqual(shared.experiment!.record);
    const diff = string.experiment!.result.sequenceDiff;
    expect(diff).toEqual(shared.experiment!.result.sequenceDiff);
    expect(diff?.status).toBe('complete');
    if (diff?.status === 'complete') expect(diff.stats).toMatchObject({ distance: 2, insertions: 1, deletions: 1, substitutions: 0 });
    expect(string.experiment!.genomeA).toMatchObject({ source: 'local', sequence: 'ACGT' });
    expect(string.experiment!.genomeB).toMatchObject({ source: 'catalog', sequence: 'CGTA' });
  });

  it('preserves other comparison metrics when the exact diff exceeds its budget', async () => {
    const output = await executeComparisonJob({ ...metadata, sequenceA: 'A'.repeat(3000), sequenceB: 'C'.repeat(3001) });
    expect(output.ok).toBe(true);
    const result = output.experiment!.result, diff = result.sequenceDiff;
    expect(result.biological).toMatchObject({ lengthA: 3000, lengthB: 3001, gcContentA: 0, gcContentB: 100 });
    expect(diff?.status).toBe('unavailable');
    expect(result.structuralVariants).toMatchObject({ status: 'unavailable', counts: null, calls: [] });
    expect(result.structuralVariants?.reason).toContain('budget');
    expect(diff).not.toHaveProperty('stats'); expect(diff).not.toHaveProperty('positions');
    const replay = await executeComparisonJob({ kind: 'replay', jobId: 'reopen-unavailable', content: serializeAnalysisRecord(output.experiment!.record) });
    expect(replay.ok).toBe(true); expect(replay.experiment!.record).toEqual(output.experiment!.record);
  });

  it('shares one exact alignment between highlights and actual indels even without annotations', async () => {
    const sequenceA = 'CCGG', sequenceB = 'CC' + 'A'.repeat(60) + 'GG';
    const output = await executeComparisonJob({ ...metadata,
      sequenceARef: bytes(sequenceA, true), sequenceBRef: bytes(sequenceB) });
    expect(output.ok).toBe(true);
    const result = output.experiment!.result;
    expect(result.structuralVariants?.status).toBe('complete');
    expect(result.structuralVariants?.calls).toHaveLength(1);
    expect(result.structuralVariants?.calls[0]).toMatchObject({ type: 'insertion', startA: 2, endA: 2,
      startB: 2, endB: 62, alternateAllele: 'A'.repeat(60) });
    expect(output.experiment!.record.fields.comparison.value).toEqual(genomeComparisonResultData(result));
  });

  it('returns an error for malformed byte transport rather than padding missing bases', async () => {
    const ref = bytes('ACGT'); ref.length = 5;
    const output = await executeComparisonJob({ ...metadata, sequenceARef: ref, sequenceBRef: bytes('ACGT') });
    expect(output.ok).toBe(false); expect(output.error).toContain('byte length'); expect(output.experiment).toBeUndefined();
  });

  it('applies explicit settings and reopens the complete accepted experiment', async () => {
    const output = await executeComparisonJob({ ...metadata, sequenceA: 'ACGTAACG', sequenceB: 'ACGTGACG',
      options: { kmerSizes: [2, 4], maxEditDistanceLength: 0, editDistanceWindowSize: 3, editDistanceWindowCount: 2 } });
    expect(output.ok).toBe(true);
    const experiment = output.experiment!;
    expect(experiment.result.kmerAnalysis.map(row => row.k)).toEqual([2, 4]);
    expect(experiment.result.editDistance.isApproximate).toBe(true);
    expect(experiment.record.parameters).toEqual({ ...experiment.options });
    const replay = await executeComparisonJob({ kind: 'replay', jobId: 'saved', content: serializeAnalysisRecord(experiment.record) });
    expect(replay.ok).toBe(true); expect(replay.experiment!.record).toEqual(experiment.record);
    const changed = structuredClone(experiment.record); changed.fields.comparison.value = {};
    const rejected = await executeComparisonJob({ kind: 'replay', jobId: 'tampered', content: JSON.stringify(changed) });
    expect(rejected.ok).toBe(false); expect(rejected.experiment).toBeUndefined(); expect(rejected.error).toContain('checksum');
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
      const diff = output.experiment!.result.sequenceDiff;
      expect(diff?.status).toBe('complete');
      if (diff?.status === 'complete') {
        expect(diff.mask).toBeInstanceOf(Uint8Array);
        expect(diff.stats).toMatchObject({ distance: 1, insertions: 1, deletions: 0, substitutions: 0, matches: 4 });
        expect(diff.positions).toHaveLength(1);
      }
      expect(output.experiment!.record.fields.comparison.value).toEqual(genomeComparisonResultData(output.experiment!.result));
    } finally { if (timeout) clearTimeout(timeout); worker.terminate(); }
  });
});
