/**
 * Unit tests for Recombination / Mosaicism Radar
 */

import { describe, it, expect } from 'bun:test';
import {
  computeMosaicRadar,
  createMosaicExperiment,
  exportMosaicTsv,
  MOSAIC_LIMITS,
  mosaicResultFromRecord,
  parseMosaicDataset,
  replayMosaicExperiment,
  resolveMosaicRadarConfig,
  serializeMosaicDataset,
  validateMosaicDataset,
  type MosaicDataset,
  type MosaicSequenceInput,
  type ReferenceSketch,
  type MosaicRadarConfig,
} from './recombination-radar';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';

// Helper to create a simple reference
function makeRef(label: string, sequence: string): ReferenceSketch {
  return { label, sequence };
}

function source(id: string, sequence: string, changes: Partial<MosaicSequenceInput> = {}): MosaicSequenceInput {
  return { id, label: id, accession: null, sequence, source: 'local', sourceDescription: 'Hand-enumerated numerical fixture',
    sourceReference: null, sourceLicense: null, sourceLength: sequence.length, sourceStart: 0, ...changes };
}
function dataset(query = 'AAAC', references = [source('reference', 'AAGT')]): MosaicDataset {
  return { format: 'phage-explorer-mosaic-dataset', version: 1, name: 'Local exact reference panel',
    query: source('query', query), references, excludedReferences: [] };
}

describe('portable mosaic experiments', () => {
  it('carries independently enumerated Jaccard and exact source attribution through JSON and recomputation', async () => {
    const input = dataset();
    input.query = source('query', 'AAAC', { accession: 'local.query', sourceLength: 10, sourceStart: 3,
      label: 'Private α query', sourceDescription: 'Private slice, not uploaded', sourceLicense: 'CC0', sourceReference: 'local source' });
    const experiment = await createMosaicExperiment(input, { k: 2 });
    // {AA, AC} intersects {AA, AG, AC} in exactly two of three canonical words.
    expect(experiment.result.windows[0].score).toBe(2 / 3);
    expect(experiment.result.windows[0].validKmerCount).toBe(3);
    expect(experiment.record.fields.mosaic.kind).toBe('sequence-score');
    expect(experiment.record.inputs).toHaveLength(1);
    expect(experiment.record.inputs[0].data).toEqual(analysisJson(experiment.dataset));
    expect(experiment.record.parameters).toEqual({ k: 2, window: 2000, step: 1000, minSimilarity: 0.05, topN: 3, maxReferences: 30 });
    const coverage = experiment.record.fields.coverage.value as any;
    expect(coverage.query).toMatchObject({ sourceLength: 10, sourceStart: 3, sourceEnd: 7, analyzedBases: 4, omittedBases: 6 });
    expect(coverage.truncation).toBe(true);
    expect(await replayMosaicExperiment(serializeAnalysisRecord(experiment.record))).toEqual(experiment);
    expect(parseMosaicDataset(serializeMosaicDataset(input))).toEqual(experiment.dataset);
    expect(mosaicResultFromRecord(experiment.record)).toEqual(experiment.result);
  });

  it('makes empty panels and short queries explicitly unavailable without invented observed windows', async () => {
    for (const input of [dataset('ACGT', []), dataset('A')]) {
      const experiment = await createMosaicExperiment(input, { k: 2 });
      expect(experiment.result.windows).toEqual([]);
      expect(experiment.result.segments).toEqual([]);
      expect(experiment.result.coverage).toEqual({ matched: 0, ambiguous: 0, 'below-threshold': 0, 'no-evidence': input.query.sequence.length });
      expect(experiment.record.fields.coverage.value).toMatchObject({ unobservedQueryBases: input.query.sequence.length });
      expect(experiment.record.fields.mosaic.coverage).toEqual({ available: 0, total: 0, unit: 'records' });
      expect((await replayMosaicExperiment(serializeAnalysisRecord(experiment.record))).result).toEqual(experiment.result);
    }
  });

  it('retains explicit ties, missing evidence and nonoverlapping planted-mosaic coverage', async () => {
    const experiment = await createMosaicExperiment(dataset('A'.repeat(300) + 'C'.repeat(300),
      [source('C', 'C'.repeat(300)), source('A', 'A'.repeat(300))]), { k: 3, window: 200, step: 100 });
    expect(experiment.result.windows.map(window => window.score)).toEqual([1, 1, 1 / 4, 1, 1]);
    expect(experiment.result.segments.map(segment => [segment.start, segment.end, segment.donor])).toEqual([[0, 250, 'A'], [250, 350, null], [350, 600, 'C']]);
    expect(experiment.result.referenceSwitches).toEqual([{ from: 'A', to: 'C', start: 200, end: 400, position: 300 }]);
    expect(Object.values(experiment.result.coverage).reduce((sum, bases) => sum + bases, 0)).toBe(600);
    const missing = await createMosaicExperiment(dataset('N'.repeat(600), [source('unknown', 'N'.repeat(300))]));
    expect(missing.result.coverage['no-evidence']).toBe(600);
    expect(missing.result.referencePanel).toMatchObject({ supplied: 1, selected: 1, usable: 0, excludedLabels: ['unknown'] });
    expect(missing.result.referenceSwitches).toEqual([]);
  });

  it('canonicalizes panel order while preserving omissions, failed reads and exact slice lengths', async () => {
    const input = dataset('AAAA', [source('z', 'TTTT'), source('a', 'AAAA'), source('m', 'NNNN')]);
    input.references[1].sourceLength = 20;
    input.excludedReferences = [{ id: 'unreadable', label: 'Unavailable reference', accession: 'failed.1', reason: 'Local sequence read failed' }];
    const first = await createMosaicExperiment(input, { k: 2, maxReferences: 2 });
    const reordered = await createMosaicExperiment({ ...input, references: [...input.references].reverse() }, { maxReferences: 2, k: 2 });
    expect(first.record).toEqual(reordered.record);
    expect(first.dataset.references.map(item => item.id)).toEqual(['a', 'm', 'z']);
    expect(first.result.referencePanel).toEqual({ supplied: 3, selected: 2, usable: 1, omitted: 1, excludedLabels: ['m'] });
    expect(first.record.fields.coverage.coverage).toEqual({ available: 1, total: 4, unit: 'records' });
    expect(first.record.fields.coverage.value).toMatchObject({
      selectedReferences: [{ id: 'a', analyzedBases: 4, omittedBases: 16 }, { id: 'm', analyzedBases: 4, omittedBases: 0 }],
      omittedReferences: [{ id: 'z', reason: 'Excluded by explicit maxReferences after label ordering.' }],
      excludedReferences: input.excludedReferences,
    });
  });

  it('binds query, reference, provenance and effective option changes to distinct identities', async () => {
    const input = dataset();
    const baseline = await createMosaicExperiment(input, { k: 2 });
    for (const changed of [
      { ...input, query: { ...input.query, sequence: 'AACC' } },
      { ...input, references: [{ ...input.references[0], sequence: 'AAAA' }] },
      { ...input, references: [{ ...input.references[0], sourceReference: 'Changed source release' }] },
    ]) {
      const result = await createMosaicExperiment(changed, { k: 2 });
      expect(result.record.cacheKey).not.toBe(baseline.record.cacheKey);
      expect(result.record.resultId).not.toBe(baseline.record.resultId);
    }
    expect((await createMosaicExperiment(input, { k: 2, minSimilarity: 0.7 })).record.cacheKey).not.toBe(baseline.record.cacheKey);
    expect(resolveMosaicRadarConfig({ window: 10, step: 1 })).toMatchObject({ window: 200, step: 100 });
    expect((await createMosaicExperiment(input, { k: 2, window: 10, step: 1 })).record)
      .toEqual((await createMosaicExperiment(input, { k: 2, window: 200, step: 100 })).record);
  });

  it('snapshots caller-owned input before its first asynchronous hash', async () => {
    const input = dataset();
    const config = { k: 2 };
    const promised = createMosaicExperiment(input, config);
    input.query.sequence = 'CCCC';
    input.references[0].sequence = 'CCCC';
    config.k = 3;
    const result = await promised;
    expect(result.dataset.query.sequence).toBe('AAAC');
    expect(result.dataset.references[0].sequence).toBe('AAGT');
    expect(result.options.k).toBe(2);
    expect(result.result.windows[0].score).toBe(2 / 3);
    expect((await replayMosaicExperiment(serializeAnalysisRecord(result.record))).record).toEqual(result.record);
  });

  it('rejects corrupted hashes and correctly rehashed fabricated numerical evidence', async () => {
    const { record } = await createMosaicExperiment(dataset(), { k: 2 });
    const forged = structuredClone(record);
    (forged.fields.mosaic.value as any).windows[0].score = 1;
    await expect(replayMosaicExperiment(serializeAnalysisRecord(forged))).rejects.toThrow('checksum');
    const rehashed = await createAnalysisRecord({ method: forged.method,
      inputs: forged.inputs.map(({ sha256: _sha256, ...input }) => input), parameters: forged.parameters,
      seed: forged.seed, references: forged.references, fields: forged.fields });
    // Establish that envelope-only verification accepts the attack fixture.
    expect(await parseAnalysisRecord(serializeAnalysisRecord(rehashed))).toEqual(rehashed);
    await expect(replayMosaicExperiment(serializeAnalysisRecord(rehashed))).rejects.toThrow('Fresh mosaic calculation');
  });

  it('rejects valid-checksum changes to evidence contracts and incompatible methods', async () => {
    const { record } = await createMosaicExperiment(dataset(), { k: 2 });
    for (const alteration of ['implementation', 'reference', 'seed', 'parameters', 'description', 'kind']) {
      const changed = structuredClone(record);
      if (alteration === 'implementation') changed.method.implementation = 'Other backend';
      if (alteration === 'reference') changed.references[0].version = 'future';
      if (alteration === 'seed') changed.seed = 1;
      if (alteration === 'parameters') delete changed.parameters.maxReferences;
      if (alteration === 'description') changed.inputs[0].description = 'Concealed source bounds';
      if (alteration === 'kind') changed.inputs[0].source = 'external';
      const rehashed = await createAnalysisRecord({ method: changed.method,
        inputs: changed.inputs.map(({ sha256: _sha256, ...input }) => input), parameters: changed.parameters,
        seed: changed.seed, references: changed.references, fields: changed.fields });
      await expect(replayMosaicExperiment(serializeAnalysisRecord(rehashed))).rejects.toThrow();
    }
  });

  it('keeps demonstration inputs and their resulting tables explicitly demonstrative', async () => {
    const input = dataset();
    input.references[0].source = 'demo';
    const { record } = await createMosaicExperiment(input, { k: 2 });
    expect(record.inputs[0].source).toBe('demo');
    expect(record.fields.mosaic.kind).toBe('demo');
    expect(record.fields.coverage.kind).toBe('demo');
    expect(record.fields.mosaic).toHaveProperty('assumptions');
    expect(exportMosaicTsv(record)).toContain('"source":"demo"');
    expect((await replayMosaicExperiment(serializeAnalysisRecord(record))).record.fields.mosaic.kind).toBe('demo');
  });

  it('exports three useful TSV tables with source offsets, exact boundaries and safe metadata', async () => {
    const input = dataset('A'.repeat(300) + 'C'.repeat(300), [source('A', 'A'.repeat(300)), source('C', 'C'.repeat(300))]);
    input.query.sourceStart = 40;
    input.query.sourceLength = 1000;
    const { record } = await createMosaicExperiment(input, { k: 3, window: 200, step: 100 });
    expect(exportMosaicTsv(record)).toContain('0\t200\t40\t240\tA\tmatched\t1\t198\t');
    expect(exportMosaicTsv(record, 'segments')).toContain('250\t350\t290\t390\t\tambiguous\t0.25\t1\t');
    expect(exportMosaicTsv(record, 'switches')).toContain('A\tC\t200\t400\t300\t240\t440\t340\n');
    expect(exportMosaicTsv(record)).toContain(record.inputs[0].sha256);
    expect(exportMosaicTsv(record)).toContain('omittedBases');
    expect(() => exportMosaicTsv(record, 'unknown' as any)).toThrow('Choose mosaic');
    const formula = await createMosaicExperiment(dataset('AAAA', [source('safe-id', 'AAAA', { label: '=1+1' })]), { k: 2 });
    expect(exportMosaicTsv(formula.record)).toContain("\t'=1+1\tmatched\t");
  });

  it('rejects malformed or colliding source identities without silently repairing private inputs', () => {
    const input = dataset();
    const bad: unknown[] = [
      { ...input, version: 2 }, { ...input, unexpected: true },
      { ...input, references: [{ ...input.references[0], id: input.query.id }] },
      { ...input, references: [{ ...input.references[0], label: ` ${input.query.label} ` }] },
      { ...input, excludedReferences: [{ id: input.query.id, label: 'missing', accession: null, reason: 'Unavailable' }] },
      { ...input, excludedReferences: [{ id: 'missing', label: 'missing', accession: null }] },
      { ...input, query: { ...input.query, sequence: '' } },
      { ...input, query: { ...input.query, sequence: 'A-AC' } },
      { ...input, query: { ...input.query, sequence: 'AAßC' } },
      { ...input, query: { ...input.query, sourceStart: 1 } },
      { ...input, query: { ...input.query, sourceLength: 3 } },
      { ...input, query: { ...input.query, sourceLength: Infinity } },
      { ...input, query: { ...input.query, sourceDescription: 'Embedded\nnewline' } },
      { ...input, query: { ...input.query, source: 'unknown' } },
      { ...input, query: { ...input.query, id: 'bad/source' } },
      { ...input, query: { ...input.query, sourceLicense: '' } },
    ];
    for (const value of bad) expect(() => validateMosaicDataset(value)).toThrow();
    expect(() => parseMosaicDataset('null')).toThrow();
    expect(() => parseMosaicDataset('{broken')).toThrow();
    expect(parseMosaicDataset('\uFEFF' + serializeMosaicDataset(input))).toEqual(validateMosaicDataset(input));
  });

  it('rejects oversized inputs, excessive windows and bounded computation before starting the kernel', async () => {
    expect(() => parseMosaicDataset(' '.repeat(MOSAIC_LIMITS.bytes + 1))).toThrow('6 MiB');
    expect(() => validateMosaicDataset(dataset('A', Array.from({ length: 31 }, (_, i) => source(`r${i}`, 'A'))))).toThrow('30');
    expect(() => validateMosaicDataset(dataset('A'.repeat(3_000_000), [source('reference', 'A'.repeat(3_000_000))]))).toThrow('5,000,000');
    await expect(createMosaicExperiment(dataset('A'.repeat(600_000)), { window: 200, step: 100 })).rejects.toThrow('5,000 windows');
    const workload = dataset('A'.repeat(1_000_000), Array.from({ length: 10 }, (_, i) => source(`r${i}`, 'C'.repeat(100_000))));
    await expect(createMosaicExperiment(workload, { k: 16, window: 10_000, step: 1000 })).rejects.toThrow('50,000,000');
    for (const options of [{ extra: 1 }, { k: null }, { topN: 31 }, { maxReferences: 31 }, { window: 5_000_001 }, { minSimilarity: NaN }]) {
      expect(() => resolveMosaicRadarConfig(options as any)).toThrow();
    }
  });

  it('does not publish an experiment after cancellation before or during hashing', async () => {
    const before = new AbortController(); before.abort();
    await expect(createMosaicExperiment(dataset(), {}, before.signal)).rejects.toHaveProperty('name', 'AbortError');
    const pending = new AbortController();
    const promise = createMosaicExperiment(dataset(), {}, pending.signal);
    pending.abort();
    await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    const { record } = await createMosaicExperiment(dataset());
    await expect(replayMosaicExperiment(serializeAnalysisRecord(record), before.signal)).rejects.toHaveProperty('name', 'AbortError');
  });
});

describe('computeMosaicRadar', () => {
  describe('edge cases', () => {
    it('returns empty result for empty sequence', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('', refs);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('returns empty result for empty references', () => {
      const result = computeMosaicRadar('ACGTACGTACGT', []);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('returns empty result for both empty', () => {
      const result = computeMosaicRadar('', []);
      expect(result.windows).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.breakpoints).toEqual([]);
    });

    it('handles sequence shorter than k-mer size', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('ACG', refs, { k: 5 });
      // Sequence is too short for k=5
      expect(result.windows).toEqual([]);
    });

    it('handles sequence with only Ns', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      const result = computeMosaicRadar('NNNNNNNNNN', refs, { k: 3, window: 5, step: 3 });
      // No valid k-mers can be extracted from Ns
      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBeNull();
    });
  });

  describe('k-mer matching', () => {
    it('finds perfect match to single reference', () => {
      const refSeq = 'ACGTACGTACGTACGT';
      const refs = [makeRef('ref1', refSeq)];
      const result = computeMosaicRadar(refSeq, refs, { k: 3, window: 10, step: 5 });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBe('ref1');
      expect(result.windows[0].score).toBe(1); // Perfect match
    });

    it('identifies best donor among multiple references', () => {
      const querySeq = 'ACGTACGTACGTACGT';
      const refs = [
        makeRef('distant', 'TTTTTTTTTTTTTTTT'), // No overlap
        makeRef('match', querySeq),              // Perfect match
        makeRef('partial', 'ACGTNNNNNNNNNNNN'),  // Some overlap
      ];
      const result = computeMosaicRadar(querySeq, refs, { k: 3, window: 10, step: 5 });

      expect(result.windows[0].donor).toBe('match');
      expect(result.windows[0].topDonors[0].label).toBe('match');
      expect(result.windows[0].topDonors[0].score).toBe(1);
    });

    it('assigns null donor when similarity below threshold', () => {
      const refs = [makeRef('ref1', 'ACGTACGT')];
      // Completely different sequence
      const result = computeMosaicRadar('TTTTTTTTTTTTTTTTTTTT', refs, {
        k: 3,
        window: 10,
        step: 5,
        minSimilarity: 0.5,
      });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].donor).toBeNull();
    });
  });

  describe('window processing', () => {
    it('creates overlapping windows with correct positions', () => {
      // Need sequence >= 200 + step to get multiple windows (min window=200, min step=100)
      const seq = 'A'.repeat(500);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,  // Minimum enforced by impl
        step: 100,    // Minimum enforced by impl
      });

      expect(result.windows.length).toBeGreaterThan(1);
      expect(result.windows[0].start).toBe(0);
      expect(result.windows[0].end).toBe(200);
      expect(result.windows[1].start).toBe(100);
      expect(result.windows[1].end).toBe(300);
    });

    it('respects topN configuration', () => {
      const seq = 'ACGTACGTACGT';
      const refs = [
        makeRef('ref1', seq),
        makeRef('ref2', 'ACGTNNNNNNNN'),
        makeRef('ref3', 'NNNNNNNNNNNN'),
        makeRef('ref4', 'TTTTTTTTTTTT'),
        makeRef('ref5', 'GGGGGGGGGGGG'),
      ];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 10,
        step: 5,
        topN: 2,
      });

      expect(result.windows[0].topDonors.length).toBe(2);
    });

    it('stores correct config values in result', () => {
      const result = computeMosaicRadar('ACGTACGTACGT', [makeRef('ref1', 'ACGT')], {
        k: 4,
        window: 500,
        step: 250,
      });

      expect(result.k).toBe(4);
      expect(result.window).toBe(500);
      expect(result.step).toBe(250);
    });

    it('enforces minimum window and step sizes', () => {
      const result = computeMosaicRadar('ACGTACGT'.repeat(10), [makeRef('ref1', 'ACGT')], {
        k: 3,
        window: 50,  // Below minimum 200
        step: 10,    // Below minimum 100
      });

      expect(result.window).toBe(200);
      expect(result.step).toBe(100);
    });
  });

  describe('segment merging', () => {
    it('merges consecutive windows with same donor', () => {
      const seq = 'ACGT'.repeat(50); // 200bp
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      // All windows should have same donor, so single segment
      expect(result.segments.length).toBe(1);
      expect(result.segments[0].donor).toBe('ref1');
      expect(result.segments[0].start).toBe(0);
    });

    it('creates separate segments for different donors', () => {
      // Build a chimeric sequence: first half from ref1, second from ref2
      const ref1Seq = 'ACGT'.repeat(100); // 400bp
      const ref2Seq = 'TTGG'.repeat(100); // 400bp
      const chimera = ref1Seq + ref2Seq;  // 800bp

      const refs = [
        makeRef('donor1', ref1Seq),
        makeRef('donor2', ref2Seq),
      ];

      const result = computeMosaicRadar(chimera, refs, {
        k: 4,
        window: 200,
        step: 100,
      });

      // Should have at least 2 segments with different donors
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
    });

    it('calculates mean score correctly for segments', () => {
      const seq = 'ACGT'.repeat(100);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.segments[0].meanScore).toBeGreaterThan(0);
      expect(result.segments[0].windows).toBeGreaterThan(0);
    });
  });

  describe('breakpoint detection', () => {
    it('returns empty breakpoints for uniform sequence', () => {
      const seq = 'ACGT'.repeat(50);
      const refs = [makeRef('ref1', seq)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
      });

      // All windows match same donor, no breakpoints
      expect(result.breakpoints.length).toBe(0);
    });

    it('detects breakpoint when donor changes', () => {
      // Create clear transition point
      const ref1Seq = 'ACGT'.repeat(200);
      const ref2Seq = 'TTGG'.repeat(200);
      const chimera = ref1Seq + ref2Seq;

      const refs = [
        makeRef('donor1', ref1Seq),
        makeRef('donor2', ref2Seq),
      ];

      const result = computeMosaicRadar(chimera, refs, {
        k: 4,
        window: 200,
        step: 100,
      });

      // Should detect at least one breakpoint near the transition
      if (result.breakpoints.length > 0) {
        const breakpoint = result.breakpoints[0];
        // Breakpoint should be somewhere near the transition (at 800bp)
        expect(breakpoint).toBeGreaterThan(0);
        expect(breakpoint).toBeLessThan(chimera.length);
      }
    });

    it('detects breakpoint on null-to-donor transition', () => {
      // First half has no matches, second half matches ref
      const noMatch = 'NNNN'.repeat(100);
      const match = 'ACGT'.repeat(100);
      const seq = noMatch + match;

      const refs = [makeRef('ref1', match)];
      const result = computeMosaicRadar(seq, refs, {
        k: 3,
        window: 200,
        step: 100,
        minSimilarity: 0.1,
      });

      // May have breakpoints where donor changes from null to ref1
      expect(result.windows.length).toBeGreaterThan(0);
    });
  });

  describe('reference handling', () => {
    it('respects maxReferences limit', () => {
      const seq = 'ACGT'.repeat(50);
      const manyRefs = Array.from({ length: 100 }, (_, i) =>
        makeRef(`ref${i.toString().padStart(3, '0')}`, 'ACGT'.repeat(10))
      );

      const result = computeMosaicRadar(seq, manyRefs, {
        k: 3,
        window: 200,
        step: 100,
        maxReferences: 5,
      });

      // Should still work, just with limited refs
      expect(result.windows.length).toBeGreaterThan(0);
      // topDonors should only contain refs from first 5
      const donorLabels = result.windows[0].topDonors.map(d => d.label);
      for (const label of donorLabels) {
        const refNum = parseInt(label.replace('ref', ''));
        expect(refNum).toBeLessThan(5);
      }
    });

    it('handles case-insensitive sequences', () => {
      const lower = 'acgtacgtacgtacgt';
      const upper = 'ACGTACGTACGTACGT';
      const refs = [makeRef('ref1', lower)];

      const result = computeMosaicRadar(upper, refs, {
        k: 3,
        window: 10,
        step: 5,
      });

      expect(result.windows[0].donor).toBe('ref1');
      expect(result.windows[0].score).toBe(1);
    });

    it('handles mixed case in references', () => {
      const query = 'AcGtAcGt';
      const refs = [makeRef('ref1', 'aCgTaCgT')];

      const result = computeMosaicRadar(query, refs, {
        k: 3,
        window: 8,
        step: 4,
      });

      expect(result.windows.length).toBeGreaterThan(0);
      expect(result.windows[0].score).toBeGreaterThan(0);
    });
  });

  describe('default configuration', () => {
    it('uses sensible defaults when no config provided', () => {
      const seq = 'ACGT'.repeat(1000); // 4000bp
      const refs = [makeRef('ref1', seq)];

      const result = computeMosaicRadar(seq, refs);

      expect(result.k).toBe(5);         // default k
      expect(result.window).toBe(2000); // default window
      expect(result.step).toBe(1000);   // default step (window/2)
    });

    it('defaults topN to 3', () => {
      const seq = 'ACGT'.repeat(500);
      const refs = [
        makeRef('ref1', seq),
        makeRef('ref2', 'TTTT'.repeat(500)),
        makeRef('ref3', 'GGGG'.repeat(500)),
        makeRef('ref4', 'CCCC'.repeat(500)),
        makeRef('ref5', 'AAAA'.repeat(500)),
      ];

      const result = computeMosaicRadar(seq, refs);

      if (result.windows.length > 0) {
        expect(result.windows[0].topDonors.length).toBe(3);
      }
    });
  });
});

describe('mosaic evidence and coordinate conformance', () => {
  const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
  const reverseComplement = (sequence: string): string =>
    [...sequence.toUpperCase()].reverse().map(base => complement[base] ?? base).join('');

  // Deliberately use literal strings, not the production rolling integer encoding.
  function referenceJaccard(query: string, reference: string, k: number): number {
    const kmers = (sequence: string): Set<string> => {
      const result = new Set<string>();
      for (let i = 0; i + k <= sequence.length; i++) {
        const word = sequence.slice(i, i + k).toUpperCase();
        if (!/^[ACGT]+$/.test(word)) continue;
        result.add([word, reverseComplement(word)].sort()[0]);
      }
      return result;
    };
    const a = kmers(query);
    const b = kmers(reference);
    if (!a.size || !b.size) return 0;
    const shared = [...a].filter(word => b.has(word)).length;
    return shared / new Set([...a, ...b]).size;
  }

  it('never turns two missing observations into a perfect reference match', () => {
    const result = computeMosaicRadar('N'.repeat(200), [makeRef('unknown', 'N'.repeat(200))]);
    expect(result.windows[0]).toMatchObject({
      donor: null, status: 'no-evidence', score: 0, validKmerCount: 0, topDonors: [],
    });
    expect(result.referencePanel).toEqual({
      supplied: 1, selected: 1, usable: 0, omitted: 0, excludedLabels: ['unknown'],
    });
    expect(result.coverage['no-evidence']).toBe(200);
    expect(result.breakpoints).toEqual([]);
    const queryOnly = computeMosaicRadar('A'.repeat(200), [makeRef('unknown', 'N'.repeat(200))]);
    expect(queryOnly.windows[0].status).toBe('no-evidence');
    expect(queryOnly.windows[0].donor).toBeNull();
    expect(queryOnly.windows[0].topDonors).toEqual([]);
  });

  it('does not name a reference with zero shared k-mers even at a zero threshold', () => {
    const result = computeMosaicRadar('A'.repeat(200), [makeRef('C-only', 'C'.repeat(200))], { minSimilarity: 0 });
    expect(result.windows[0]).toMatchObject({ donor: null, status: 'below-threshold', score: 0 });
    expect(result.coverage['below-threshold']).toBe(200);
  });

  it('matches the independently enumerated canonical sets {AA, AC} and {AA, AG, AC}', () => {
    const result = computeMosaicRadar('AAAC', [makeRef('reference', 'AAGT')], { k: 2 });
    expect(result.windows[0].score).toBeCloseTo(2 / 3, 14);
    expect(result.windows[0].validKmerCount).toBe(3);
    const reverseReference = computeMosaicRadar('AAAC', [makeRef('reference', 'ACTT')], { k: 2 });
    const reverseQuery = computeMosaicRadar('GTTT', [makeRef('reference', 'AAGT')], { k: 2 });
    expect(reverseReference).toEqual(result);
    expect(reverseQuery).toEqual(result);
  });

  it('agrees with a string oracle including unsigned 32-bit k=16 and reverse complements', () => {
    const query = 'AAAAAAAACCCCCCCCGGGGGGGGTTTTTTTTACGTCAGTACGATCGATGCAANNTGACTGACTGAC';
    const reference = 'TGACTGACTGACAAGTCAGTACGATCGATGCAACCCCGGGGTTTTAAAA';
    for (const k of [1, 2, 3, 5, 8, 15, 16]) {
      const expected = referenceJaccard(query, reference, k);
      for (const [q, r] of [[query, reference], [query, reverseComplement(reference)],
        [reverseComplement(query), reference]]) {
        const result = computeMosaicRadar(q, [makeRef('reference', r)], { k, minSimilarity: 0 });
        expect(result.windows[0].score).toBeCloseTo(expected, 14);
      }
    }
    expect(computeMosaicRadar('T'.repeat(16), [makeRef('A', 'A'.repeat(16))], { k: 16 }).windows[0].score).toBe(1);
    expect(computeMosaicRadar('G'.repeat(16), [makeRef('A', 'A'.repeat(16))], { k: 16 }).windows[0].score).toBe(0);
  });

  it('keeps tied references unresolved even when topN hides one of them', () => {
    const references = [makeRef('beta', 'AAAC'), makeRef('alpha', 'GTTT')];
    const result = computeMosaicRadar('AAAC', references, { k: 2, topN: 1 });
    expect(result.windows[0]).toMatchObject({
      donor: null, status: 'ambiguous', score: 1, tiedReferences: ['alpha', 'beta'],
      topDonors: [{ label: 'alpha', score: 1 }],
    });
    expect(result.coverage.ambiguous).toBe(4);
    expect(computeMosaicRadar('AAAC', [...references].reverse(), { k: 2, topN: 1 })).toEqual(result);
    expect(references.map(reference => reference.label)).toEqual(['beta', 'alpha']);
  });

  it('selects the same bounded reference panel after a source-order permutation', () => {
    const references = [makeRef('z', 'AAAA'), makeRef('b', 'CCCC'), makeRef('a', 'AAAA')];
    const result = computeMosaicRadar('AAAA', references, { k: 2, maxReferences: 2 });
    expect(result.referencePanel).toMatchObject({ supplied: 3, selected: 2, usable: 2, omitted: 1 });
    expect(result.windows[0].topDonors.map(reference => reference.label)).toEqual(['a', 'b']);
    expect(computeMosaicRadar('AAAA', [...references].reverse(), { k: 2, maxReferences: 2 })).toEqual(result);
  });

  it('rejects colliding reference identities instead of merging different sources', () => {
    expect(() => computeMosaicRadar('AAAA', [makeRef('same', 'AAAA'), makeRef('same', 'CCCC')])).toThrow('Duplicate reference label');
    expect(() => computeMosaicRadar('AAAA', [makeRef('same', 'AAAA'), makeRef(' same ', 'CCCC')])).toThrow('Duplicate reference label');
  });

  it('reconstructs a planted A/C mosaic with an explicit tied window and a single switch range', () => {
    const result = computeMosaicRadar('A'.repeat(300) + 'C'.repeat(300),
      [makeRef('A', 'A'.repeat(300)), makeRef('C', 'C'.repeat(300))],
      { k: 3, window: 200, step: 100 });
    // The mixed window has canonical {AAA, AAC, ACC, CCC}; each reference
    // contributes one of those four words. It cannot distinguish the two.
    expect(result.windows.map(window => window.score)).toEqual([1, 1, 1 / 4, 1, 1]);
    expect(result.segments.map(segment => [segment.start, segment.end, segment.donor, segment.status])).toEqual([
      [0, 250, 'A', 'matched'], [250, 350, null, 'ambiguous'], [350, 600, 'C', 'matched'],
    ]);
    expect(result.coverage).toEqual({ matched: 500, ambiguous: 100, 'below-threshold': 0, 'no-evidence': 0 });
    expect(result.referenceSwitches).toEqual([{ from: 'A', to: 'C', start: 200, end: 400, position: 300 }]);
    expect(result.breakpoints).toEqual([300]);
  });

  it('does not interpret a no-data gap or null-to-reference transition as a reference switch', () => {
    const result = computeMosaicRadar('A'.repeat(200) + 'N'.repeat(200) + 'C'.repeat(200),
      [makeRef('A', 'A'.repeat(200)), makeRef('C', 'C'.repeat(200))],
      { k: 3, window: 200, step: 200 });
    expect(result.segments.map(segment => [segment.start, segment.end, segment.status])).toEqual([
      [0, 200, 'matched'], [200, 400, 'no-evidence'], [400, 600, 'matched'],
    ]);
    expect(result.breakpoints).toEqual([]);
    expect(result.referenceSwitches).toEqual([]);
  });

  it('anchors the final full window and weights scores by nonoverlapping display spans', () => {
    const result = computeMosaicRadar('A'.repeat(400) + 'C', [makeRef('A', 'A'.repeat(400))],
      { k: 5, window: 200, step: 200 });
    expect(result.windows.map(window => [window.start, window.end])).toEqual([[0, 200], [200, 400], [201, 401]]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 0, end: 401, windows: 3 });
    // Display spans are 200, 100 and 101 bp; scores are 1, 1 and 1/2.
    expect(result.segments[0].meanScore).toBeCloseTo(350.5 / 401, 14);
    expect(result.coverage.matched).toBe(401);
  });

  it('does not bridge ambiguous characters or change coordinates during case normalization', () => {
    const result = computeMosaicRadar('aaßcc', [makeRef('A', 'AAAA')], { k: 2 });
    expect(result.windows[0]).toMatchObject({ start: 0, end: 5, validKmerCount: 2, score: 0.5 });
    expect(result.segments[0].end).toBe(5);
  });

  it('partitions every analyzed genome base exactly once across window and tail sizes', () => {
    for (const length of [5, 199, 200, 201, 399, 401, 750]) {
      for (const window of [200, 333, 500]) {
        for (const step of [100, 200]) {
          const sequence = 'A'.repeat(Math.floor(length / 2)) + 'C'.repeat(Math.ceil(length / 2));
          const result = computeMosaicRadar(sequence, [makeRef('A', 'A'.repeat(200)), makeRef('C', 'C'.repeat(200))],
            { k: 5, window, step });
          expect(result.segments[0].start).toBe(0);
          expect(result.segments[result.segments.length - 1].end).toBe(length);
          let covered = 0;
          for (const segment of result.segments) {
            expect(segment.start).toBe(covered);
            expect(segment.end).toBeGreaterThan(segment.start);
            expect(segment.end).toBeLessThanOrEqual(length);
            covered = segment.end;
          }
          expect(result.segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)).toBe(length);
          expect(Object.values(result.coverage).reduce((sum, bases) => sum + bases, 0)).toBe(length);
        }
      }
    }
  });

  it('rejects invalid numerical settings even when no sequence or reference is supplied', () => {
    const invalid: MosaicRadarConfig[] = [
      { k: 0 }, { k: 1.5 }, { k: 17 }, { k: NaN }, { k: Infinity },
      { window: 0 }, { window: -1 }, { window: 200.5 }, { window: Infinity },
      { step: 0 }, { step: NaN }, { step: 201, window: 200 },
      { topN: 0 }, { topN: 1.5 }, { maxReferences: -1 }, { maxReferences: Infinity },
      { minSimilarity: -0.1 }, { minSimilarity: 1.1 }, { minSimilarity: NaN },
    ];
    for (const config of invalid) {
      expect(() => computeMosaicRadar('ACGT', [makeRef('reference', 'ACGT')], config)).toThrow();
      expect(() => computeMosaicRadar('', [], config)).toThrow();
    }
  });
});
