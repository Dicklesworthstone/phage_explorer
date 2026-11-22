import { describe, expect, it } from 'bun:test';
import { createAnalysisRecord, serializeAnalysisRecord, type AnalysisJson, type AnalysisRecord } from '@phage-explorer/core';
import {
  createGenomeComparisonExperiment, genomeComparisonResultData, replayGenomeComparisonExperiment,
  resolveGenomeComparisonOptions, type ComparisonGenomeInput,
} from './comparison-experiment';

function genome(sequence: string, name = 'same'): ComparisonGenomeInput {
  return { phage: { id: -1, name, accession: name }, source: 'local', sequence,
    genes: [{ id: 1, name: 'capsid', locusTag: null, startPos: 0, endPos: sequence.length,
      strand: '+', product: 'annotated capsid', type: 'CDS', qualifiers: { note: 'original annotation' } }],
    codonUsage: null };
}
async function rehash(record: AnalysisRecord): Promise<string> {
  const { format: _format, version: _version, resultId: _resultId, cacheKey: _cacheKey, ...value } = record;
  return serializeAnalysisRecord(await createAnalysisRecord(value));
}

describe('complete portable genome comparison', () => {
  it('recomputes exact sequences, annotations, settings and all results despite identical numeric source IDs', async () => {
    const a = genome('AAAACCCC'), b = genome('AAAAGCCCC');
    b.genes[0].name = 'query-feature';
    const experiment = await createGenomeComparisonExperiment(a, b, {
      kmerSizes: [2, 3], maxEditDistanceLength: 4, editDistanceWindowSize: 2, editDistanceWindowCount: 2,
    });
    const result = experiment.result;
    expect(result.kmerAnalysis.map(row => row.k)).toEqual([2, 3]);
    expect(result.biological).toMatchObject({ lengthA: 8, lengthB: 9, gcContentA: 50, gcResolvedBasesA: 8, gcResolvedBasesB: 9 });
    expect(result.geneContent).toMatchObject({ genesA: 1, genesB: 1, sharedGeneNames: 0 });
    expect(result.editDistance.isApproximate).toBe(true);
    expect(result.sequenceDiff?.status).toBe('complete');
    if (result.sequenceDiff?.status === 'complete') {
      expect(result.sequenceDiff.stats).toMatchObject({ distance: 1, insertions: 1, deletions: 0, substitutions: 0, matches: 8 });
      expect(result.sequenceDiff.runs.find(run => run.operation === 'insertion')).toEqual({ operation: 'insertion', startA: 4, endA: 4, startB: 4, endB: 5 });
    }
    const json = serializeAnalysisRecord(experiment.record);
    const reopened = await replayGenomeComparisonExperiment(json);
    expect(reopened.record).toEqual(experiment.record);
    expect(reopened.genomeA).toEqual(a); expect(reopened.genomeB).toEqual(b);
    expect(genomeComparisonResultData(reopened.result)).toEqual(genomeComparisonResultData(result));
    expect(reopened.result.sequenceDiff?.status === 'complete' && reopened.result.sequenceDiff.mask).toBeInstanceOf(Uint8Array);
    expect(json).not.toContain('computedAt'); expect(json).not.toContain('computeTimeMs');
    expect((experiment.record.inputs[1].data as unknown as ComparisonGenomeInput).genes[0].qualifiers?.note).toBe('original annotation');
  });

  it('retains supplied codon counts and binds annotations/counts even with the same genome bases', async () => {
    const a = genome('ATGAAATAA'), b = genome('ATGAAATAA');
    const original = await createGenomeComparisonExperiment(a, b);
    a.codonUsage = { aaCounts: { A: 3, X: 2 }, codonCounts: { GCT: 3, ACN: 2 } };
    const counted = await createGenomeComparisonExperiment(a, b);
    expect(counted.result.codonUsage.resolvedCodonsA).toBe(3);
    expect(counted.result.codonUsage.excludedCodonsA).toBe(2);
    expect(counted.record.cacheKey).not.toBe(original.record.cacheKey);
    expect(counted.record.resultId).not.toBe(original.record.resultId);
    a.genes[0].qualifiers = { note: 'edited source annotation' };
    const annotated = await createGenomeComparisonExperiment(a, b);
    expect(annotated.record.cacheKey).not.toBe(counted.record.cacheKey);
    const replay = await replayGenomeComparisonExperiment(serializeAnalysisRecord(annotated.record));
    expect(replay.record.resultId).toBe(annotated.record.resultId);
    expect(replay.genomeA.codonUsage).toEqual(a.codonUsage);
  });

  it('snapshots labels, annotations and settings before asynchronous hashing', async () => {
    const a = genome('ACGTACGT'), b = genome('ACGTACGA');
    const options = { kmerSizes: [2, 4] };
    const pending = createGenomeComparisonExperiment(a, b, options);
    a.phage.name = 'changed'; a.sequence = 'TTTTTTTT'; a.genes[0].qualifiers!.note = 'changed'; options.kmerSizes[0] = 6;
    const accepted = await pending;
    expect(accepted.genomeA.phage.name).toBe('same'); expect(accepted.genomeA.sequence).toBe('ACGTACGT');
    expect(accepted.genomeA.genes[0].qualifiers?.note).toBe('original annotation');
    expect(accepted.options.kmerSizes).toEqual([2, 4]);
    expect((await replayGenomeComparisonExperiment(serializeAnalysisRecord(accepted.record))).record).toEqual(accepted.record);
  });

  it('retains explicit unavailable exact alignment alongside useful metrics', async () => {
    const accepted = await createGenomeComparisonExperiment(genome('A'.repeat(3000)), genome('C'.repeat(3001)),
      { maxEditDistanceLength: 0, editDistanceWindowSize: 10, editDistanceWindowCount: 1 });
    expect(accepted.result.sequenceDiff?.status).toBe('unavailable');
    expect(accepted.result.structuralVariants).toMatchObject({ status: 'unavailable', counts: null, calls: [] });
    const replay = await replayGenomeComparisonExperiment(serializeAnalysisRecord(accepted.record));
    expect(replay.record.resultId).toBe(accepted.record.resultId);
    expect(replay.result.biological).toMatchObject({ gcContentA: 0, gcContentB: 100 });
    expect(replay.result.sequenceDiff).not.toHaveProperty('stats');
  });

  it('accepts a same-input control and preserves ambiguous IUPAC bases without inventing resolved evidence', async () => {
    const a = genome('ACGTRYN'); a.genes = [];
    const same = await createGenomeComparisonExperiment(a, a);
    expect(same.result.sequenceDiff?.status === 'complete' && same.result.sequenceDiff.stats.distance).toBe(0);
    expect(same.record.fields.comparison.coverage).toEqual({ available: 8, total: 14, unit: 'bases' });
    expect((await replayGenomeComparisonExperiment(serializeAnalysisRecord(same.record))).record.resultId).toBe(same.record.resultId);
  });
});


describe('case-independent comparison evidence', () => {
  for (const exactLimit of [8, 0]) {
    it(`keeps DNA distances consistent with the exact diff (edit limit ${exactLimit})`, async () => {
      const a = genome('ACGTACGT'), b = genome('acgtacgt');
      const accepted = await createGenomeComparisonExperiment(a, b, {
        kmerSizes: [2, 3], maxEditDistanceLength: exactLimit,
        editDistanceWindowSize: 4, editDistanceWindowCount: 2,
      });
      expect(accepted.result.editDistance).toMatchObject({
        levenshteinDistance: 0, normalizedLevenshtein: 0, levenshteinSimilarity: 1,
        substitutions: 0, insertions: 0, deletions: 0, isApproximate: exactLimit === 0,
      });
      const diff = accepted.result.sequenceDiff;
      expect(diff?.status).toBe('complete');
      if (!diff || diff.status !== 'complete') throw new Error('Expected a complete exact diff.');
      expect(diff.stats.distance).toBe(0);
      expect(Array.from(diff.mask)).toEqual(new Array(a.sequence.length).fill(0));
      expect(accepted.genomeA.sequence).toBe(a.sequence);
      expect(accepted.genomeB.sequence).toBe(b.sequence);
      expect((accepted.record.inputs[1].data as unknown as ComparisonGenomeInput).sequence).toBe(b.sequence);
      expect(accepted.record.inputs[0].sha256).not.toBe(accepted.record.inputs[1].sha256);
      expect(accepted.record.method.version).toBe('2');
      expect((await replayGenomeComparisonExperiment(serializeAnalysisRecord(accepted.record))).record).toEqual(accepted.record);
    });
  }

  it('rejects records declaring the former case-dependent method', async () => {
    const current = (await createGenomeComparisonExperiment(genome('ACGTACGT'), genome('acgtacgt'))).record;
    const previous = structuredClone(current);
    previous.method.version = '1';
    await expect(replayGenomeComparisonExperiment(await rehash(previous))).rejects.toThrow('incompatible');
  });
});

describe('portable comparison verification', () => {
  it('rejects checksum edits before accepting an input or output', async () => {
    const original = await createGenomeComparisonExperiment(genome('AAACCC'), genome('AAAGCC'));
    const edited = structuredClone(original.record);
    (edited.inputs[0].data as unknown as ComparisonGenomeInput).sequence = 'GGGCCC';
    await expect(replayGenomeComparisonExperiment(JSON.stringify(edited))).rejects.toThrow('checksum');
  });

  it('rejects plausible but rehashed stale metrics, exact mask bytes, options and source metadata', async () => {
    const original = (await createGenomeComparisonExperiment(genome('AAACCC'), genome('AAAGCC'))).record;
    for (const change of ['metrics', 'mask', 'settings', 'metadata']) {
      const edited = structuredClone(original);
      const data = edited.fields.comparison.value as Record<string, AnalysisJson>;
      if (change === 'metrics') (data.biological as Record<string, AnalysisJson>).gcContentA = 75;
      if (change === 'mask') ((data.sequenceDiff as Record<string, AnalysisJson>).mask as AnalysisJson[])[0] = 3;
      if (change === 'settings') edited.parameters.kmerSizes = [2];
      if (change === 'metadata') edited.inputs[0].description = 'A different provenance claim';
      await expect(replayGenomeComparisonExperiment(await rehash(edited))).rejects.toThrow('fresh computation');
    }
  });

  it('rejects unsupported method/version, input roles and unknown options', async () => {
    const original = (await createGenomeComparisonExperiment(genome('AAACCC'), genome('AAAGCC'))).record;
    const version = structuredClone(original); version.method.version = 'future';
    await expect(replayGenomeComparisonExperiment(await rehash(version))).rejects.toThrow('incompatible');
    const roles = structuredClone(original); roles.inputs.reverse();
    await expect(replayGenomeComparisonExperiment(await rehash(roles))).rejects.toThrow('input roles');
    for (const value of [{ kmerSizes: [] }, { kmerSizes: [3, 3] }, { kmerSizes: [0] }, { kmerSizes: [32] },
      { maxEditDistanceLength: 10001 }, { editDistanceWindowSize: 0 }, { editDistanceWindowCount: 101 },
      { includeGeneComparison: false }, { windowSize: 20 }, { editDistanceWindowCount: Number.NaN }]) {
      expect(() => resolveGenomeComparisonOptions(value)).toThrow();
    }
  });

  it('rejects malformed sources rather than silently dropping or rewriting data', async () => {
    const b = genome('ATGAAATAA');
    for (const sequence of ['', 'ATG-AAA', 'ATGßAAA']) {
      await expect(createGenomeComparisonExperiment(genome(sequence), b)).rejects.toThrow('IUPAC');
    }
    const coordinates = genome('ATGAAATAA'); coordinates.genes[0].endPos = 10;
    await expect(createGenomeComparisonExperiment(coordinates, b)).rejects.toThrow('annotations');
    const count = genome('ATGAAATAA'); count.codonUsage = { aaCounts: {}, codonCounts: { ATG: -1 } };
    await expect(createGenomeComparisonExperiment(count, b)).rejects.toThrow('counts');
    count.codonUsage = { aaCounts: {}, codonCounts: { imaginary: 1 } };
    await expect(createGenomeComparisonExperiment(count, b)).rejects.toThrow('counts');
    const strand = genome('ATGAAATAA'); strand.genes[0].strand = 'unknown';
    await expect(createGenomeComparisonExperiment(strand, b)).rejects.toThrow('annotations');
    const missing = genome('ATGAAATAA'); (missing as unknown as Record<string, unknown>).codonUsage = undefined;
    await expect(createGenomeComparisonExperiment(missing, b)).rejects.toThrow('counts');
  });
});
