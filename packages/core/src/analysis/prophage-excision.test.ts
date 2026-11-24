/**
 * Unit tests for Prophage Excision Precision Mapper
 */

import { describe, it, expect } from 'bun:test';
import {
  findIntegrases,
  findDirectRepeats,
  analyzeProphageExcision,
  isLikelyTemperate,
  ATTACHMENT_LIMITS, parseAttachmentDna, validateAttachmentInput, resolveAttachmentOptions,
  reconstructAttachment, createAttachmentExperimentRecord, replayAttachmentExperiment,
  type AttachmentReconstructionInput, type AttachmentReconstructionResult,
  PROPHAGE_EXCISION_METHOD, parseProphageExcisionDna, validateProphageExcisionInput,
  reconstructProphageExcision, createProphageExcisionRecord, replayProphageExcisionRecord,
  type ProphageExcisionInput, type ProphageExcisionResult,
} from './prophage-excision';
import type { GeneInfo } from '../types';
import { analysisJson, createAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';

// Helper to create gene info objects
function makeGene(overrides: Partial<GeneInfo> & { id: number }): GeneInfo {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    locusTag: overrides.locusTag ?? null,
    startPos: overrides.startPos ?? 0,
    endPos: overrides.endPos ?? 100,
    strand: overrides.strand ?? '+',
    product: overrides.product ?? null,
    type: overrides.type ?? 'CDS',
  };
}

describe('resolved attachment-repeat evidence', () => {
  it('does not infer attachment sites from unknown sequence', () => {
    const result = analyzeProphageExcision('N'.repeat(208), []);
    expect(result.directRepeats).toEqual([]);
    expect(result.attachmentSites).toEqual([]);
    expect(result.bestPrediction.excisionProduct).toBeNull();
  });

  it('rejects unresolved bases on either side even within the mismatch allowance', () => {
    const repeat = 'ACGTACGTTAGCTAC';
    for (const unknown of ['N', 'R', 'Y']) {
      const unresolved = repeat.slice(0, -1) + unknown;
      expect(findDirectRepeats(repeat + unresolved, 15, 15, 1)).toEqual([]);
      expect(findDirectRepeats(unresolved + repeat, 15, 15, 1)).toEqual([]);
    }
  });

  it('preserves resolved imperfect repeats and their coordinates across unknown gaps', () => {
    const left = 'ACGTACGTTAGCTAC';
    const right = 'ACGTACGTTAGCTAT';
    expect(findDirectRepeats((left + 'NNNNN' + right).toLowerCase(), 15, 15, 1)).toEqual([
      { pos1: 0, pos2: 20, sequence: left, mismatches: 1, hammingDistance: 1 },
    ]);
  });
});

describe('findIntegrases', () => {
  it('returns empty array for empty gene list', () => {
    expect(findIntegrases([])).toEqual([]);
  });

  it('returns empty array when no integrase genes present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'capsid', product: 'Major capsid protein' }),
      makeGene({ id: 2, name: 'tail', product: 'Tail fiber protein' }),
    ];
    expect(findIntegrases(genes)).toEqual([]);
  });

  it('finds integrase gene by name', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Phage integrase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].gene.id).toBe(1);
    expect(result[0].matchedKeywords).toContain('int');
    expect(result[0].matchedKeywords).toContain('integrase');
  });

  it('finds integrase gene by product annotation', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'gp15', product: 'Site-specific recombinase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].matchedKeywords).toContain('site-specific recombinase');
  });

  it('finds excisionase gene', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'xis', product: 'Excisionase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].matchedKeywords).toContain('xis');
    expect(result[0].matchedKeywords).toContain('excisionase');
  });

  it('classifies tyrosine recombinase correctly', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Tyrosine recombinase XerD' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].integraseClass).toBe('tyrosine');
  });

  it('classifies serine recombinase correctly', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Serine recombinase family protein' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
    expect(result[0].integraseClass).toBe('serine');
  });

  it('returns unknown class when type not specified', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Integrase' }),
    ];
    const result = findIntegrases(genes);
    expect(result[0].integraseClass).toBe('unknown');
  });

  it('sorts by confidence descending', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int' }),
      makeGene({ id: 2, name: 'integrase', product: 'Site-specific recombinase' }),
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(2);
    expect(result[0].gene.id).toBe(2);
    expect(result[0].confidence).toBeGreaterThan(result[1].confidence);
  });

  it('confidence is capped at 1.0', () => {
    const genes: GeneInfo[] = [
      makeGene({
        id: 1,
        name: 'integrase',
        locusTag: 'int1',
        product: 'Tyrosine recombinase site-specific integrase',
      }),
    ];
    const result = findIntegrases(genes);
    expect(result[0].confidence).toBeLessThanOrEqual(1.0);
  });
});

describe('findDirectRepeats', () => {
  it('returns empty array for short sequence', () => {
    expect(findDirectRepeats('ACGT')).toEqual([]);
  });

  it('finds perfect direct repeat with small search region', () => {
    const repeat = 'ACGTACGTACGTACGT'; // 16bp
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat;
    // Use small search region to speed up test
    const result = findDirectRepeats(seq, 15, 20, 0, 100);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].hammingDistance).toBe(0);
  });

  it('finds repeat with allowed mismatches', () => {
    const repeat1 = 'ACGTACGTACGTACGT';
    const repeat2 = 'ACGTACGTACGTACGA'; // 1 mismatch
    const middle = 'G'.repeat(200);
    const seq = repeat1 + middle + repeat2;
    const result = findDirectRepeats(seq, 15, 20, 2, 100);
    expect(result.length).toBeGreaterThan(0);
    const match = result.find(r => r.sequence.startsWith('ACGT'));
    expect(match).toBeDefined();
  });

  it('respects minimum length parameter', () => {
    const repeat = 'ACGTACGT'; // 8bp (too short)
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat;
    const result = findDirectRepeats(seq, 15, 25, 0, 50);
    // 8bp repeat won't match 15bp minimum
    const terminalRepeats = result.filter(r =>
      r.pos1 < 10 && r.pos2 > seq.length - 10
    );
    expect(terminalRepeats).toEqual([]);
  });

  it('handles case insensitivity', () => {
    const repeat = 'acgtacgtacgtacgt';
    const middle = 'G'.repeat(200);
    const seq = repeat + middle + repeat.toUpperCase();
    const result = findDirectRepeats(seq, 15, 20, 0, 100);
    const matches = result.filter(r => r.sequence.toUpperCase().includes('ACGT'));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('limits results to 20 candidates', () => {
    const result = findDirectRepeats('ACGT'.repeat(1000), 15, 20, 1, 500);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

describe('analyzeProphageExcision', () => {
  it('returns valid analysis for empty inputs', () => {
    const result = analyzeProphageExcision('', []);
    expect(result.integrases).toEqual([]);
    expect(result.directRepeats).toEqual([]);
    expect(result.attachmentSites).toEqual([]);
    expect(result.isTemperate).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('identifies temperate phage with integrase', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, name: 'int', product: 'Phage integrase' }),
    ];
    const result = analyzeProphageExcision('ACGT'.repeat(100), genes);
    expect(result.integrases.length).toBe(1);
  });

  it('generates diagnostics for each analysis step', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase' }),
    ];
    const result = analyzeProphageExcision('ACGT'.repeat(100), genes);
    expect(result.diagnostics.some(d => d.includes('integrase'))).toBe(true);
  });

  it('finds known att core motifs', () => {
    // Embed Lambda-like att core
    const seq = 'A'.repeat(100) + 'TTTTCTTT' + 'G'.repeat(100);
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase', startPos: 50, endPos: 200 }),
    ];
    const result = analyzeProphageExcision(seq, genes);
    expect(result.integrationHotspots.length).toBeGreaterThan(0);
    expect(result.integrationHotspots[0].motif).toBe('TTTTCTTT');
  });

  it('handles tRNA genes for hotspot scoring', () => {
    const seq = 'TTTTCTTT' + 'A'.repeat(200) + 'G'.repeat(100);
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Integrase', startPos: 10, endPos: 100 }),
      makeGene({ id: 2, type: 'tRNA', product: 'tRNA-Arg', startPos: 20, endPos: 80 }),
    ];
    const result = analyzeProphageExcision(seq, genes);
    const hotspotsNearTrna = result.integrationHotspots.filter(h => h.distanceFromTrna < 100);
    if (hotspotsNearTrna.length > 0) {
      expect(hotspotsNearTrna[0].score).toBeGreaterThan(0.4);
    }
  });
});

describe('isLikelyTemperate', () => {
  it('returns false for empty gene list', () => {
    expect(isLikelyTemperate([])).toBe(false);
  });

  it('returns false when no integrase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Capsid protein' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(false);
  });

  it('returns true when integrase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Phage integrase' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(true);
  });

  it('returns true when recombinase present', () => {
    const genes: GeneInfo[] = [
      makeGene({ id: 1, product: 'Site-specific recombinase' }),
    ];
    expect(isLikelyTemperate(genes)).toBe(true);
  });
});

describe('edge cases', () => {
  it('handles sequence with only Ns', () => {
    const result = analyzeProphageExcision('N'.repeat(100), []);
    expect(result.isTemperate).toBe(false);
  });

  it('handles gene with null fields', () => {
    const genes: GeneInfo[] = [
      {
        id: 1,
        name: null,
        locusTag: null,
        startPos: 0,
        endPos: 100,
        strand: '+',
        product: 'integrase',
        type: null,
      },
    ];
    const result = findIntegrases(genes);
    expect(result.length).toBe(1);
  });

  it('processes sequence without error', () => {
    // Test that analysis completes without throwing
    const seq = 'ACGT'.repeat(100);
    const result = analyzeProphageExcision(seq, []);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.isTemperate).toBe(false);
  });
});


// These deliberately tiny controls are hand-constructed sequence algebra,
// not observations of functional biological attachment sites.
function attachmentFixture(hostStrand: '+' | '-' = '+', phageStrand: '+' | '-' = '+'): AttachmentReconstructionInput {
  const source = { kind: 'local' as const, reference: 'Hand-constructed sequence-composition control; not experimental observations',
    version: '1', license: 'CC0-1.0' };
  return {
    format: 'phage-explorer-attachment-reconstruction', version: 1,
    host: { name: 'Control host locus', accession: null, sequence: hostStrand === '+' ? 'TTAGCC' : 'GGCTAA',
      topology: 'linear', source: { ...source } },
    phage: { name: 'Control phage substrate', accession: null, sequence: phageStrand === '+' ? 'CAAGTG' : 'CACTTG',
      topology: 'circular', source: { ...source } },
    attB: { start: 2, end: 4, strand: hostStrand, evidence: 'Declared synthetic shared AG core' },
    attP: { start: 2, end: 4, strand: phageStrand, evidence: 'Declared synthetic shared AG core' },
    circularization: 'already-circular',
  };
}
function independentReverse(sequence: string): string {
  const complements: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
  return [...sequence].reverse().map(base => complements[base]).join('');
}
function expectExactSourceMap(input: AttachmentReconstructionInput, result: AttachmentReconstructionResult): void {
  const used = { host: Array(input.host.sequence.length).fill(0), phage: Array(input.phage.sequence.length).fill(0) };
  let position = 0, rebuilt = '';
  for (const segment of result.segments) {
    expect(segment.productStart).toBe(position);
    expect(segment.sourceStart).toBeGreaterThanOrEqual(0);
    expect(segment.sourceEnd).toBeLessThanOrEqual(input[segment.source].sequence.length);
    expect(segment.sourceEnd).toBeGreaterThan(segment.sourceStart);
    const sequence = input[segment.source].sequence.slice(segment.sourceStart, segment.sourceEnd);
    rebuilt += segment.strand === '+' ? sequence : independentReverse(sequence);
    for (let index = segment.sourceStart; index < segment.sourceEnd; index++) used[segment.source][index]++;
    position += sequence.length;
    expect(segment.productEnd).toBe(position);
  }
  expect(rebuilt).toBe(result.integratedSequence);
  expect(used.host).toEqual(Array(input.host.sequence.length).fill(1));
  expect(used.phage).toEqual(Array(input.phage.sequence.length).fill(1));
  expect(position).toBe(input.host.sequence.length + input.phage.sequence.length);
  for (const junction of [result.attL, result.attR]) {
    const covered: number[] = [];
    const context = junction.integratedSegments.map(segment => {
      for (let index = segment.start; index < segment.end; index++) covered.push(index);
      return result.integratedSequence.slice(segment.start, segment.end);
    }).join('');
    expect(new Set(covered).size).toBe(covered.length);
    expect(junction.sequence).toBe(junction.strand === '+' ? context : independentReverse(context));
    expect(junction.sequence.slice(junction.core.start, junction.core.end)).toBe(result.sharedCore);
  }
}
function rehashAttachmentRecord(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method, inputs: record.inputs, parameters: record.parameters,
    seed: record.seed, references: record.references, fields: record.fields });
}

describe('conditional attachment sequence reconstruction', () => {
  for (const hostStrand of ['+', '-'] as const) for (const phageStrand of ['+', '-'] as const) {
    it('preserves exact source coverage and oriented junctions for attB ' + hostStrand + ' / attP ' + phageStrand, () => {
      const input = attachmentFixture(hostStrand, phageStrand), before = structuredClone(input);
      const result = reconstructAttachment(input, { flankLength: 2 });
      // Independent literal expectations, not assembled using the production algorithm.
      expect(result.integratedSequence).toBe(hostStrand === '+' ? 'TTAGTGCAAGCC' : 'GGCTTGCACTAA');
      expect(result.sharedCore).toBe('AG');
      expect(result.attL.sequence).toBe('TTAGTG');
      expect(result.attR.sequence).toBe('CAAGCC');
      expect(result.attL.core).toEqual({ start: 2, end: 4 });
      expect(result.attR.core).toEqual({ start: 2, end: 4 });
      expect(result.attL.strand).toBe(hostStrand);
      expect(result.attR.strand).toBe(hostStrand);
      expect(result.insertionStrand).toBe(hostStrand === phageStrand ? '+' : '-');
      expect(result.hostCut).toBe(2);
      expect(result.phageCut).toBe(hostStrand === phageStrand ? 2 : 4);
      expect(result.integratedTopology).toBe('linear');
      expect(result.conservation).toEqual({ hostBases: 6, phageBases: 6, integratedBases: 12, expectedBases: 12, conserved: true });
      expectExactSourceMap(input, result);
      expect(input).toEqual(before);
    });
  }

  it('splices boundary cores without fabricated bases or empty map segments', () => {
    const first = attachmentFixture();
    first.host.sequence = 'AGCC'; first.phage.sequence = 'AGTG';
    first.attB = { ...first.attB, start: 0, end: 2 }; first.attP = { ...first.attP, start: 0, end: 2 };
    const firstResult = reconstructAttachment(first, { flankLength: 3 });
    expect(firstResult.integratedSequence).toBe('AGTGAGCC');
    expect(firstResult.attL.leftFlankBases).toBe(0);
    expectExactSourceMap(first, firstResult);
    const last = attachmentFixture();
    last.host.sequence = 'TTAG'; last.phage.sequence = 'CAAG';
    const lastResult = reconstructAttachment(last, { flankLength: 3 });
    expect(lastResult.integratedSequence).toBe('TTAGCAAG');
    expect(lastResult.attR.rightFlankBases).toBe(0);
    expectExactSourceMap(last, lastResult);
  });

  it('wraps circular host junction context exactly once and records its coordinate slices', () => {
    const input = attachmentFixture();
    input.host.sequence = 'TTAG'; input.host.topology = 'circular'; input.phage.sequence = 'CAAG';
    const result = reconstructAttachment(input, { flankLength: 1000 });
    expect(result.integratedTopology).toBe('circular');
    expect(result.integratedSequence).toBe('TTAGCAAG');
    expect(result.attL.sequence).toBe('GTTAGCAA');
    expect(result.attR.sequence).toBe('GCAAGTTA');
    expect(result.attL.integratedSegments).toEqual([{ start: 7, end: 8 }, { start: 0, end: 7 }]);
    expect(result.attR.integratedSegments).toEqual([{ start: 3, end: 8 }, { start: 0, end: 3 }]);
    expect(result.attL.core).toEqual({ start: 3, end: 5 });
    expect(result.attR.core).toEqual({ start: 3, end: 5 });
    expectExactSourceMap(input, result);
  });

  it('supports core-only previews and records an explicit circularization assumption', () => {
    const input = attachmentFixture();
    input.phage.topology = 'linear'; input.circularization = 'assumed-circularized';
    const result = reconstructAttachment(input, { flankLength: 0 });
    expect(result.attL.sequence).toBe('AG'); expect(result.attR.sequence).toBe('AG');
    expect(result.warnings.some(item => item.includes('explicit modeling assumption'))).toBe(true);
    expect(input.phage.topology).toBe('linear');
  });

  it('parses one FASTA record or raw unambiguous DNA without joining distinct records', () => {
    expect(parseAttachmentDna('\uFEFF>host locus\n tt ag \r\ncc\n')).toBe('TTAGCC');
    expect(parseAttachmentDna('tt\t ag\ncc')).toBe('TTAGCC');
    for (const content of ['', '>empty\n', '>\nACGT', '>one\nAG\n>two\nAG', 'ACNGT', 'ACRGT', 'AC-GT', 'ACGT12']) {
      expect(() => parseAttachmentDna(content)).toThrow();
    }
    expect(() => parseAttachmentDna(' '.repeat(ATTACHMENT_LIMITS.inputBytes + 1))).toThrow(/4 MiB/);
  });

  it('normalizes bases without mutating source metadata or input coordinates', () => {
    const input = attachmentFixture();
    input.host.sequence = 'tt ag\ncc'; input.phage.sequence = 'caagtg';
    const valid = validateAttachmentInput(input);
    expect(valid.host.sequence).toBe('TTAGCC');
    expect(valid.phage.sequence).toBe('CAAGTG');
    expect(valid.attB).toEqual(input.attB);
    expect(input.host.sequence).toBe('tt ag\ncc');
  });

  it('rejects mismatching, differently oriented, unresolved or unequal cores', () => {
    const changes: Array<(input: AttachmentReconstructionInput) => void> = [
      input => { input.phage.sequence = 'CACGTG'; },
      input => { input.attP.strand = '-'; },
      input => { input.attP.end = 5; },
      input => { input.host.sequence = 'TNAGCC'; },
      input => { input.phage.sequence = 'CAAGTR'; },
    ];
    for (const change of changes) {
      const input = attachmentFixture(); change(input);
      expect(() => reconstructAttachment(input)).toThrow();
    }
  });

  it('rejects absent, wrapping, fractional and out-of-source coordinates', () => {
    const invalidSites = [
      { start: -1 }, { end: 7 }, { start: 4, end: 2 }, { start: 2, end: 2 }, { start: 2.5 },
      { start: NaN }, { end: Infinity }, { strand: '?' }, { strand: ['+'] }, { evidence: '' },
    ];
    for (const site of invalidSites) {
      const input = attachmentFixture();
      expect(() => validateAttachmentInput({ ...input, attB: { ...input.attB, ...site } })).toThrow();
      expect(() => validateAttachmentInput({ ...input, attP: { ...input.attP, ...site } })).toThrow();
    }
    const paired = attachmentFixture();
    expect(() => validateAttachmentInput({ ...paired, attB: { ...paired.attB, strand: ['+'] },
      attP: { ...paired.attP, strand: ['+'] } })).toThrow(/explicit strand/);
    const large = attachmentFixture();
    large.host.sequence = large.phage.sequence = 'A'.repeat(257);
    large.attB.start = large.attP.start = 0; large.attB.end = large.attP.end = 257;
    expect(() => reconstructAttachment(large)).toThrow(/1–256/);
  });

  it('requires explicit topology, source provenance, evidence and circularization semantics', () => {
    const original = attachmentFixture();
    for (const host of [
      { ...original.host, topology: 'unknown' }, { ...original.host, topology: ['linear'] },
      { ...original.host, source: { ...original.host.source, version: '' } },
      { ...original.host, source: { ...original.host.source, reference: 'bad\nreference' } },
      { ...original.host, source: { ...original.host.source, kind: ['local'] } },
      { ...original.host, unsupported: true },
    ]) expect(() => validateAttachmentInput({ ...original, host })).toThrow();
    for (const topology of ['linear', 'unknown'] as const) {
      const input = attachmentFixture(); input.phage.topology = topology;
      expect(() => reconstructAttachment(input)).toThrow(/circularization/);
      input.circularization = 'assumed-circularized';
      expect(reconstructAttachment(input).integratedSequence).toBe('TTAGTGCAAGCC');
    }
    expect(() => validateAttachmentInput({ ...original, circularization: ['already-circular'] })).toThrow();
    const missing = JSON.parse(JSON.stringify(original));
    delete missing.host.source.license;
    expect(() => validateAttachmentInput(missing)).toThrow();
  });

  it('enforces source/combined size limits and strict bounded context options', () => {
    const input = attachmentFixture();
    input.host.sequence = 'A'.repeat(ATTACHMENT_LIMITS.sequenceBases + 1);
    expect(() => validateAttachmentInput(input)).toThrow(/1,000,000/);
    input.host.sequence = 'A'.repeat(750001); input.phage.sequence = 'A'.repeat(750000);
    expect(() => validateAttachmentInput(input)).toThrow(/1,500,000/);
    expect(resolveAttachmentOptions()).toEqual({ flankLength: 50 });
    for (const flankLength of [-1, 0.1, NaN, Infinity, 1001, null, '2', undefined]) {
      expect(() => resolveAttachmentOptions({ flankLength })).toThrow();
    }
    for (const options of [null, [], { flankLength: 2, extra: true }]) {
      expect(() => resolveAttachmentOptions(options)).toThrow();
    }
  });
});

describe('complete source-bound attachment experiment records', () => {
  it('exports exact inputs, coordinate conventions and assumptions, then recomputes an identical result', async () => {
    const input = attachmentFixture('-', '+'), result = reconstructAttachment(input, { flankLength: 2 });
    const record = await createAttachmentExperimentRecord(input, result);
    expect(record.method).toMatchObject({ id: 'attachment-reconstruction', version: '1' });
    expect(record.inputs.map(item => item.id)).toEqual(['hostLocus', 'phageGenome', 'attachmentSites']);
    expect(record.fields.reconstruction.kind).toBe('simulation');
    expect(record.fields.reconstruction.coverage).toEqual({ available: 12, total: 12, unit: 'bases' });
    expect(record.references[0].id).toBe('doi:10.1371/journal.pgen.1003490');
    const replayed = await replayAttachmentExperiment('\uFEFF' + serializeAnalysisRecord(record));
    expect(replayed.input).toEqual(input);
    expect(replayed.options).toEqual({ flankLength: 2 });
    expect(replayed.result).toEqual(result);
    expect(replayed.record.resultId).toBe(record.resultId);
  });

  it('optionally binds replay to the selected phage including provenance, while allowing self-contained replay', async () => {
    const input = attachmentFixture(), record = await createAttachmentExperimentRecord(input, reconstructAttachment(input));
    const content = serializeAnalysisRecord(record);
    expect((await replayAttachmentExperiment(content, input.phage)).input.phage).toEqual(input.phage);
    const changed = structuredClone(input.phage); changed.sequence = 'CAAGTA';
    await expect(replayAttachmentExperiment(content, changed)).rejects.toThrow(/Selected phage/);
    changed.sequence = input.phage.sequence; changed.source.version = 'different source revision';
    await expect(replayAttachmentExperiment(content, changed)).rejects.toThrow(/Selected phage/);
    expect((await replayAttachmentExperiment(content)).record.resultId).toBe(record.resultId);
  });

  it('rejects a newly checksummed but scientifically inconsistent product or changed output description', async () => {
    const input = attachmentFixture(), result = reconstructAttachment(input, { flankLength: 2 });
    const record = await createAttachmentExperimentRecord(input, result);
    const altered = structuredClone(result); altered.integratedSequence = 'TTAGTGCAAGCT';
    await expect(createAttachmentExperimentRecord(input, altered)).rejects.toThrow(/does not match/);
    const tampered = structuredClone(record);
    tampered.fields.reconstruction.value = analysisJson(altered);
    await expect(replayAttachmentExperiment(serializeAnalysisRecord(await rehashAttachmentRecord(tampered))))
      .rejects.toThrow(/Fresh attachment reconstruction differs/);
    const relabeled = structuredClone(record);
    relabeled.fields.reconstruction.label = 'Unjustified confirmed biological integration';
    await expect(replayAttachmentExperiment(serializeAnalysisRecord(await rehashAttachmentRecord(relabeled))))
      .rejects.toThrow(/Fresh attachment reconstruction differs/);
  });

  it('rejects rehashed method/reference/options drift, unsupported seeds and changed source roles', async () => {
    const input = attachmentFixture(), record = await createAttachmentExperimentRecord(input, reconstructAttachment(input, { flankLength: 2 }));
    const variants: Array<(changed: AnalysisRecord) => void> = [
      changed => { changed.method.version = '999'; },
      changed => { changed.method.implementation = 'unreviewed composition'; },
      changed => { changed.references[0].version = 'different'; },
      changed => { changed.parameters.flankLength = 0; },
      changed => { changed.parameters.unrecognized = true; },
      changed => { changed.seed = 17; },
      changed => { changed.inputs[0].id = 'differentHostRole'; },
    ];
    for (const alter of variants) {
      const changed = structuredClone(record); alter(changed);
      const rehashed = await rehashAttachmentRecord(changed);
      await expect(replayAttachmentExperiment(serializeAnalysisRecord(rehashed))).rejects.toThrow();
    }
    await expect(replayAttachmentExperiment(' '.repeat(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MiB/);
  });
});


// Declared tiny sequence controls, not inferred or experimentally functional sites.
function excisionFixture(sequence = 'CCGACGTTGATTAA', attL = 2, attR = 8,
  strand: '+' | '-' = '+', topology: 'linear' | 'circular' = 'linear'): ProphageExcisionInput {
  return { format: 'phage-explorer-prophage-excision', version: 1,
    locus: { name: 'Integrated synthetic locus', accession: null, sequence, topology,
      source: { kind: 'local', reference: 'Hand-derived sequence composition; no biological activity claim',
        version: '1', license: 'CC0-1.0' } },
    attL: { start: attL, end: attL + 2, strand, evidence: 'Explicit synthetic attL declaration' },
    attR: { start: attR, end: attR + 2, strand, evidence: 'Explicit synthetic attR declaration' } };
}
function expectExactExcisionMap(input: ProphageExcisionInput, result: ProphageExcisionResult): void {
  const used = Array(input.locus.sequence.length).fill(0);
  for (const [product, junction] of [[result.excisedPhage, result.attP], [result.restoredHost, result.attB]] as const) {
    let position = 0, rebuilt = '';
    expect(product.sourceOrigin).toBe(product.segments[0].sourceStart);
    for (const segment of product.segments) {
      expect(segment.productStart).toBe(position);
      expect(segment.sourceStart).toBeGreaterThanOrEqual(0);
      expect(segment.sourceEnd).toBeLessThanOrEqual(input.locus.sequence.length);
      expect(segment.sourceEnd).toBeGreaterThan(segment.sourceStart);
      expect(segment.strand).toBe('+');
      rebuilt += input.locus.sequence.slice(segment.sourceStart, segment.sourceEnd);
      for (let index = segment.sourceStart; index < segment.sourceEnd; index++) used[index]++;
      position += segment.sourceEnd - segment.sourceStart;
      expect(segment.productEnd).toBe(position);
    }
    expect(rebuilt).toBe(product.sequence);
    expect(position).toBe(product.sequence.length);
    const covered: number[] = [];
    const forward = junction.productSegments.map(part => {
      for (let index = part.start; index < part.end; index++) covered.push(index);
      return product.sequence.slice(part.start, part.end);
    }).join('');
    expect(new Set(covered).size).toBe(covered.length);
    expect(junction.sequence).toBe(junction.strand === '+' ? forward : independentReverse(forward));
    expect(junction.sequence.slice(junction.core.start, junction.core.end)).toBe(result.sharedCore);
  }
  expect(used).toEqual(Array(input.locus.sequence.length).fill(1));
  expect(result.excisedPhage.sequence.length + result.restoredHost.sequence.length).toBe(input.locus.sequence.length);
}

describe('exact declared prophage excision sequence reconstruction', () => {
  const controls = [
    { name: 'linear forward sites', input: excisionFixture(), phage: 'GACGTT', host: 'CCGATTAA', cuts: [2, 8], wraps: false, hostOrigin: 0 },
    { name: 'linear reverse sites', input: excisionFixture('CCTCAACGTCAA', 8, 2, '-'), phage: 'TCAACG', host: 'CCTCAA', cuts: [2, 8], wraps: false, hostOrigin: 0 },
    { name: 'circular forward arc crossing the stored origin', input: excisionFixture('TTGATTAACCGACG', 10, 2, '+', 'circular'),
      phage: 'GACGTT', host: 'GATTAACC', cuts: [10, 2], wraps: true, hostOrigin: 2 },
    { name: 'circular reverse arc crossing the stored origin', input: excisionFixture('CGTCAACCTCAA', 2, 8, '-', 'circular'),
      phage: 'TCAACG', host: 'TCAACC', cuts: [8, 2], wraps: true, hostOrigin: 2 },
  ];
  for (const control of controls) it('recovers independently written products for ' + control.name, () => {
    const before = structuredClone(control.input), result = reconstructProphageExcision(control.input, { flankLength: 2 });
    expect(result.excisedPhage.sequence).toBe(control.phage);
    expect(result.restoredHost.sequence).toBe(control.host);
    expect(result.excisedPhage.topology).toBe('circular');
    expect(result.restoredHost.topology).toBe(control.input.locus.topology);
    expect(result.excisedPhage.sourceOrigin).toBe(control.cuts[0]);
    expect(result.restoredHost.sourceOrigin).toBe(control.hostOrigin);
    expect(result.sourceCuts).toEqual({ start: control.cuts[0], end: control.cuts[1], wrapsOrigin: control.wraps });
    expect(result.sharedCore).toBe('GA');
    expect(result.attachmentStrand).toBe(control.input.attL.strand);
    expect(result.conservation).toEqual({ inputBases: control.input.locus.sequence.length, excisedBases: control.phage.length,
      restoredBases: control.host.length, recoveredBases: control.input.locus.sequence.length, conserved: true });
    expectExactExcisionMap(control.input, result);
    expect(control.input).toEqual(before);
  });

  it('reports exact forward source intervals and independent junction previews', () => {
    const result = reconstructProphageExcision(excisionFixture(), { flankLength: 2 });
    expect(result.excisedPhage.segments).toEqual([
      { sourceStart: 2, sourceEnd: 8, strand: '+', productStart: 0, productEnd: 6 },
    ]);
    expect(result.restoredHost.segments).toEqual([
      { sourceStart: 0, sourceEnd: 2, strand: '+', productStart: 0, productEnd: 2 },
      { sourceStart: 8, sourceEnd: 14, strand: '+', productStart: 2, productEnd: 8 },
    ]);
    expect(result.attP.sequence).toBe('TTGACG');
    expect(result.attB.sequence).toBe('CCGATT');
    expect(result.attP.core).toEqual({ start: 2, end: 4 });
    expect(result.attB.core).toEqual({ start: 2, end: 4 });
    const circular = reconstructProphageExcision(controls[2].input, { flankLength: 1000 });
    expect(circular.excisedPhage.segments).toEqual([
      { sourceStart: 10, sourceEnd: 14, strand: '+', productStart: 0, productEnd: 4 },
      { sourceStart: 0, sourceEnd: 2, strand: '+', productStart: 4, productEnd: 6 },
    ]);
    expect(circular.restoredHost.segments).toEqual([
      { sourceStart: 2, sourceEnd: 10, strand: '+', productStart: 0, productEnd: 8 },
    ]);
    expect(circular.attP.sequence.length).toBe(6);
    expect(circular.attB.sequence.length).toBe(8);
    expectExactExcisionMap(controls[2].input, circular);
  });

  it('supports adjacent boundary cores, core-only products and a removed source origin without zero-length segments', () => {
    const input = excisionFixture('GAGA', 0, 2), result = reconstructProphageExcision(input, { flankLength: 1000 });
    expect(result.excisedPhage.sequence).toBe('GA');
    expect(result.restoredHost.sequence).toBe('GA');
    expect(result.restoredHost.sourceOrigin).toBe(2);
    expect(result.attP.sequence).toBe('GA'); expect(result.attB.sequence).toBe('GA');
    expect(result.attP.leftFlankBases).toBe(0); expect(result.attP.rightFlankBases).toBe(0);
    expectExactExcisionMap(input, result);
    expect(result.warnings.some(warning => warning.includes('original stored origin'))).toBe(true);
    const noFlanks = reconstructProphageExcision(excisionFixture(), { flankLength: 0 });
    expect(noFlanks.attP.sequence).toBe('GA'); expect(noFlanks.attB.sequence).toBe('GA');
  });

  it('retains source base zero when a circular excision ends exactly at that boundary', () => {
    const input = excisionFixture('GAACGA', 4, 0, '+', 'circular');
    const result = reconstructProphageExcision(input, { flankLength: 1000 });
    expect(result.excisedPhage.sequence).toBe('GA');
    expect(result.restoredHost.sequence).toBe('GAAC');
    expect(result.restoredHost.sourceOrigin).toBe(0);
    expect(result.warnings.some(warning => warning.includes('original stored origin'))).toBe(false);
    expectExactExcisionMap(input, result);
  });

  for (const hostStrand of ['+', '-'] as const) for (const phageStrand of ['+', '-'] as const) {
    for (const topology of ['linear', 'circular'] as const) {
      it('inverts integration while conserving both sources for ' + hostStrand + '/' + phageStrand + ' on a ' + topology + ' host', () => {
        const original = attachmentFixture(hostStrand, phageStrand);
        original.host.topology = topology;
        const integrated = reconstructAttachment(original, { flankLength: 2 });
        const low = { start: 2, end: 4, strand: hostStrand, evidence: 'Declared integration core in synthetic control' };
        const high = { ...low, start: 8, end: 10 };
        const input: ProphageExcisionInput = { format: 'phage-explorer-prophage-excision', version: 1,
          locus: { ...original.host, name: 'Integrated control', sequence: integrated.integratedSequence },
          attL: hostStrand === '+' ? low : high, attR: hostStrand === '+' ? high : low };
        const result = reconstructProphageExcision(input, { flankLength: 2 });
        expect(result.restoredHost.sequence).toBe(original.host.sequence);
        expect(result.excisedPhage.sequence).toBe(hostStrand === '+' ? 'AGTGCA' : 'CTTGCA');
        const orientedPhage = hostStrand === phageStrand ? original.phage.sequence : independentReverse(original.phage.sequence);
        expect((orientedPhage + orientedPhage).includes(result.excisedPhage.sequence)).toBe(true);
        expectExactExcisionMap(input, result);
      });
    }
  }

  it('rejects opposite orientation, mismatching cores, overlapping declarations and invalid linear order', () => {
    const opposite = excisionFixture(); opposite.attR.strand = '-';
    expect(() => reconstructProphageExcision(opposite)).toThrow(/same orientation/);
    const mismatched = excisionFixture('CCGACGTTGCTTAA');
    expect(() => reconstructProphageExcision(mismatched)).toThrow(/match exactly/);
    const unequal = excisionFixture(); unequal.attR.end++;
    expect(() => reconstructProphageExcision(unequal)).toThrow(/match exactly/);
    const overlapping = excisionFixture('AAAAAA', 1, 2);
    expect(() => reconstructProphageExcision(overlapping)).toThrow(/non-overlapping/);
    const identical = excisionFixture('AAAAAA', 1, 1);
    expect(() => reconstructProphageExcision(identical)).toThrow(/non-overlapping/);
    expect(() => reconstructProphageExcision(excisionFixture('TTGATTAACCGACG', 10, 2))).toThrow(/linear locus/);
    expect(() => reconstructProphageExcision(excisionFixture('CCGACGTTGATTAA', 2, 8, '-'))).toThrow(/linear locus/);
  });

  it('requires exact complete input, topology, provenance and valid non-wrapping coordinates', () => {
    const input = excisionFixture();
    for (const locus of [
      { ...input.locus, sequence: 'CCGNCGTTGATTAA' }, { ...input.locus, topology: 'unknown' },
      { ...input.locus, source: { ...input.locus.source, reference: '' } },
      { ...input.locus, source: { ...input.locus.source, version: '' } },
    ]) expect(() => validateProphageExcisionInput({ ...input, locus })).toThrow();
    for (const changes of [{ start: -1 }, { start: 2.1 }, { end: 99 }, { start: 8, end: 2 },
      { strand: ['+'] }, { evidence: '' }, { extra: true }]) {
      expect(() => validateProphageExcisionInput({ ...input, attL: { ...input.attL, ...changes } })).toThrow();
    }
    expect(() => validateProphageExcisionInput({ ...input, version: 2 })).toThrow(/format\/version/);
    expect(() => validateProphageExcisionInput({ ...input, unsupported: true })).toThrow(/fields/);
    expect(() => reconstructProphageExcision(input, { flankLength: 1001 })).toThrow();
  });

  it('allows complete bounded integration products without widening the integration input limit', () => {
    const bases = 'A'.repeat(ATTACHMENT_LIMITS.totalBases);
    expect(parseProphageExcisionDna('>integrated locus\n' + bases).length).toBe(ATTACHMENT_LIMITS.totalBases);
    expect(() => parseAttachmentDna(bases)).toThrow(/1,000,000/);
    expect(() => parseProphageExcisionDna(bases + 'A')).toThrow(/1,500,000/);
    const input = excisionFixture(bases, 0, 2);
    expect(validateProphageExcisionInput(input).locus.sequence.length).toBe(ATTACHMENT_LIMITS.totalBases);
    expect(() => validateProphageExcisionInput({ ...input, locus: { ...input.locus, sequence: bases + 'A' } })).toThrow(/1,500,000/);
    expect(parseProphageExcisionDna('\uFEFF>one\n ccga cgtt \n gattaa\n')).toBe('CCGACGTTGATTAA');
    for (const bad of ['', '>one\nGA\n>two\nGA', 'CCGNCGTTGATTAA', 'CCGA12']) expect(() => parseProphageExcisionDna(bad)).toThrow();
  });

  it('describes composition assumptions without reporting measured recombination activity', () => {
    const result = reconstructProphageExcision(excisionFixture());
    expect(result.warnings.join(' ')).toContain('not discovery of a prophage');
    expect(result.warnings.join(' ')).toContain('not establish full-site recognition');
    expect(result.warnings.join(' ')).toContain('biochemical cleavage position');
    expect(result).not.toHaveProperty('efficiency');
    expect(result).not.toHaveProperty('probability');
  });
});

describe('portable source-bound excision experiments', () => {
  it('preserves both complete molecules and coordinate maps and recomputes a saved circular experiment', async () => {
    const input = excisionFixture('TTGATTAACCGACG', 10, 2, '+', 'circular');
    const result = reconstructProphageExcision(input, { flankLength: 2 });
    const record = await createProphageExcisionRecord(input, result);
    expect(record.method).toEqual(PROPHAGE_EXCISION_METHOD);
    expect(record.inputs.map(item => item.id)).toEqual(['integratedLocus', 'excisionSites']);
    expect(record.fields.reconstruction.kind).toBe('simulation');
    expect(record.fields.reconstruction.coverage).toEqual({ available: 14, total: 14, unit: 'bases' });
    expect(record.fields.reconstruction.value).toEqual(analysisJson(result));
    const replay = await replayProphageExcisionRecord('\uFEFF' + serializeAnalysisRecord(record));
    expect(replay.input).toEqual(input);
    expect(replay.result).toEqual(result);
    expect(replay.options).toEqual({ flankLength: 2 });
    expect(replay.record.resultId).toBe(record.resultId);
  });

  it('binds optional replay context to exact integrated bases, topology and source provenance', async () => {
    const input = excisionFixture(), record = await createProphageExcisionRecord(input, reconstructProphageExcision(input));
    const content = serializeAnalysisRecord(record);
    expect((await replayProphageExcisionRecord(content, input.locus)).input.locus).toEqual(input.locus);
    for (const alter of [
      (changed: ProphageExcisionInput) => { changed.locus.sequence = 'TCGACGTTGATTAA'; },
      (changed: ProphageExcisionInput) => { changed.locus.source.version = 'different'; },
      (changed: ProphageExcisionInput) => { changed.locus.topology = 'circular'; },
    ]) {
      const changed = structuredClone(input); alter(changed);
      await expect(replayProphageExcisionRecord(content, changed.locus)).rejects.toThrow(/Selected integrated bases or provenance/);
    }
  });

  it('rejects newly checksummed fabricated products, maps or biological claims', async () => {
    const input = excisionFixture(), result = reconstructProphageExcision(input);
    const record = await createProphageExcisionRecord(input, result);
    const altered = structuredClone(result); altered.excisedPhage.sequence = 'GACGTA';
    await expect(createProphageExcisionRecord(input, altered)).rejects.toThrow(/do not match/);
    const mapped = structuredClone(result); mapped.restoredHost.segments[1].sourceStart--;
    await expect(createProphageExcisionRecord(input, mapped)).rejects.toThrow(/do not match/);
    for (const alter of [
      (changed: AnalysisRecord) => { changed.fields.reconstruction.value = analysisJson(altered); },
      (changed: AnalysisRecord) => { changed.fields.reconstruction.value = analysisJson(mapped); },
      (changed: AnalysisRecord) => { changed.fields.reconstruction.label = 'Confirmed highly efficient biological excision'; },
    ]) {
      const changed = structuredClone(record); alter(changed);
      await expect(replayProphageExcisionRecord(serializeAnalysisRecord(await rehashAttachmentRecord(changed))))
        .rejects.toThrow(/Fresh excision reconstruction differs/);
    }
  });

  it('rejects changed method, source roles, declarations, options and unsupported seeds', async () => {
    const input = excisionFixture(), record = await createProphageExcisionRecord(input, reconstructProphageExcision(input, { flankLength: 2 }));
    for (const alter of [
      (changed: AnalysisRecord) => { changed.method.version = '999'; },
      (changed: AnalysisRecord) => { changed.method.implementation = 'different'; },
      (changed: AnalysisRecord) => { changed.references[0].version = 'different'; },
      (changed: AnalysisRecord) => { changed.inputs[0].id = 'differentSource'; },
      (changed: AnalysisRecord) => { changed.inputs[1].data = analysisJson({ format: input.format, version: input.version,
        attL: { ...input.attL, end: input.attL.end + 1 }, attR: input.attR }); },
      (changed: AnalysisRecord) => { changed.parameters.flankLength = 0; },
      (changed: AnalysisRecord) => { changed.parameters.extra = true; },
      (changed: AnalysisRecord) => { changed.seed = 17; },
    ]) {
      const changed = structuredClone(record); alter(changed);
      await expect(replayProphageExcisionRecord(serializeAnalysisRecord(await rehashAttachmentRecord(changed)))).rejects.toThrow();
    }
    await expect(replayProphageExcisionRecord(' '.repeat(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MiB/);
    const old = await createAttachmentExperimentRecord(attachmentFixture(), reconstructAttachment(attachmentFixture()));
    await expect(replayProphageExcisionRecord(serializeAnalysisRecord(old))).rejects.toThrow();
  });
});
