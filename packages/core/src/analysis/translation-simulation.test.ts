import { describe, expect, it } from 'bun:test';
import { ribosomeTrafficSimulation, RIBOSOME_TRAFFIC_LIMITS, selectRibosomeTrafficGene } from './translation-simulation';
import type { GeneInfo, PhageFull } from '../types';

const gene = (length: number, overrides: Partial<GeneInfo> = {}): GeneInfo => ({
  id: 1, name: 'coding', locusTag: 'cds1', startPos: 0, endPos: length, strand: '+',
  product: 'annotated protein', type: 'CDS', ...overrides,
});
const phage = (sequence: string, genes: GeneInfo[] = [gene(sequence.length)]): PhageFull => ({
  id: 1, name: 'Exact input', accession: 'TEST', slug: null, family: null, host: null,
  genomeLength: sequence.length, gcContent: null, morphology: null, lifecycle: null,
  description: null, baltimoreGroup: null, genomeType: null, pdbIds: [], genes,
  codonUsage: null, hasModel: false,
});

describe('Ribosome traffic simulation', () => {
  it('init > builds a synthetic mRNA when no phage is provided', () => {
    const state = ribosomeTrafficSimulation.init(null, {}, () => 0);
    expect(state.type).toBe('ribosome-traffic');
    expect(state.mRnaId).toBe('Synthetic');
    expect(state.codonRates).toHaveLength(200);
    expect(new Set(state.codonRates)).toEqual(new Set([0.1]));
    expect(state.ribosomes).toEqual([]);
    expect(state.proteinsProduced).toBe(0);
    expect(state.stallEvents).toBe(0);
    expect(state.params.initiationRate).toBeGreaterThan(0);
    expect(state.params.terminationRate).toBeGreaterThan(0);
    expect(state.params.footprint).toBeGreaterThan(0);
  });

  it('step > deterministic stepping with rng=0 initiates one ribosome and advances it', () => {
    const rng = () => 0;
    const s0 = ribosomeTrafficSimulation.init(null, {}, rng);
    const s1 = ribosomeTrafficSimulation.step(s0, 1, rng);
    expect(s1.time).toBeCloseTo(1, 6);
    expect(s1.ribosomes).toEqual([0]);
    expect(s1.proteinsProduced).toBe(0);
    expect(s1.stallEvents).toBe(0);

    const s2 = ribosomeTrafficSimulation.step(s1, 1, rng);
    expect(s2.time).toBeCloseTo(2, 6);
    expect(s2.ribosomes).toEqual([1]);
  });

  it('step > termination removes ribosome at stop codon and increments proteinsProduced', () => {
    const rng = () => 0;
    const base = ribosomeTrafficSimulation.init(null, {}, rng);
    const endPos = base.codonRates.length - 1;
    const state = {
      ...base,
      ribosomes: [endPos],
      params: { ...base.params, initiationRate: 0 },
    };

    const next = ribosomeTrafficSimulation.step(state, 1, rng);
    expect(next.ribosomes).toEqual([]);
    expect(next.proteinsProduced).toBe(1);
  });

  it('step > correctly handles TASEP update order (leader moves freely)', () => {
    const rng = () => 0; // Always move
    const base = ribosomeTrafficSimulation.init(null, {}, rng);
    // Setup state: [10, 0]. Footprint 9.
    // Leader at 10 should move to 11. Follower at 0 should move to 1.
    const state = {
      ...base,
      ribosomes: [10, 0],
      params: { ...base.params, initiationRate: 0 }, // No new initiation
    };

    const next = ribosomeTrafficSimulation.step(state, 1, rng);
    expect(next.ribosomes).toEqual([11, 1]);
  });

  it('uses the exact codon order and same-code synonymous census without randomizing it', () => {
    // Lysine AAA occurs three times, AAG once: their teaching probabilities are
    // 1 and 0.1 + 0.9/3 = 0.4. A stop is an exit site, not a decoded amino acid.
    const genomeSequence = 'ATGAAAAAGAAAAAATAA';
    const selected = phage(genomeSequence);
    selected.codonUsage = { codonCounts: { AAG: 100000 }, aaCounts: { K: 100000 } };
    let randomCalls = 0;
    const state = ribosomeTrafficSimulation.init(selected, {}, () => { randomCalls++; return 0.9; }, { genomeSequence });
    expect(randomCalls).toBe(0);
    expect(state.source).toBe('annotated-cds');
    expect(state.rateModel).toBe('selected-cds-synonymous-frequency-v1');
    expect(state.transcript?.cds).toBe(genomeSequence);
    expect(state.transcript?.protein).toBe('MKKKK*');
    expect(state.codonRates).toEqual([1, 1, 0.4, 1, 1, 1]);
    expect(state.codonRates).toHaveLength(6); // No invented 100-codon minimum.
    const reordered = 'ATGAAAAAAAAAAAGTAA';
    const changed = ribosomeTrafficSimulation.init(selected, {}, () => 0.9, { genomeSequence: reordered });
    expect(changed.codonRates).toEqual([1, 1, 1, 1, 0.4, 1]);
  });

  it('reconstructs reverse joined codons, codon_start and a reassigned genetic code', () => {
    // Reverse transcript AATGTAGTAA skips its leading A. Table 15 reads TAG as Q.
    const genomeSequence = 'TTACTACGGGGATT';
    const selected = phage(genomeSequence, [gene(14, { strand: '-', qualifiers: {
      _segments: [{ start: 11, end: 14, strand: '-' }, { start: 0, end: 7, strand: '-' }],
      codon_start: '2', transl_table: '15', translation: 'MQ',
    } })]);
    const state = ribosomeTrafficSimulation.init(selected, {}, undefined, { genomeSequence, geneId: 1 });
    expect(state.transcript?.cds).toBe('ATGTAGTAA');
    expect(state.transcript?.protein).toBe('MQ*');
    expect(state.transcript?.codonStart).toBe(2);
    expect(state.transcript?.geneticCode).toBe(15);
    expect(state.transcript?.segments).toEqual([
      { start: 11, end: 13, strand: '-' }, { start: 0, end: 7, strand: '-' },
    ]);
    expect(state.codonRates).toEqual([1, 1, 1]);
  });

  it('groups reassigned TGA with TGG under table 4 and preserves circular-origin transcript order', () => {
    const genomeSequence = 'TGATGGTGGTAAATG';
    const selected = phage(genomeSequence, [gene(15, { qualifiers: {
      transl_table: 4, _segments: [{ start: 12, end: 15, strand: '+' }, { start: 0, end: 12, strand: '+' }],
    } })]);
    const state = ribosomeTrafficSimulation.init(selected, {}, undefined, { genomeSequence });
    expect(state.transcript?.cds).toBe('ATGTGATGGTGGTAA');
    expect(state.transcript?.protein).toBe('MWWW*');
    expect(state.codonRates).toEqual([1, 0.55, 1, 1, 1]);
  });

  it('selects mapped CDS length rather than genomic envelope, and honors an explicit shorter selection', () => {
    const genomeSequence = 'ATG'.repeat(10);
    const shortJoined = gene(30, { id: 2, qualifiers: {
      _segments: [{ start: 0, end: 3, strand: '+' }, { start: 27, end: 30, strand: '+' }],
    } });
    const longer = gene(9, { id: 1 });
    const nonCoding = gene(30, { id: 3, type: 'gene' });
    const selected = phage(genomeSequence, [shortJoined, nonCoding, longer]);
    expect(selectRibosomeTrafficGene(selected).id).toBe(1);
    const state = ribosomeTrafficSimulation.init(selected, {}, undefined, { genomeSequence, geneId: 2 });
    expect(state.transcript?.geneId).toBe(2);
    expect(state.codonRates).toHaveLength(2);
    expect(() => ribosomeTrafficSimulation.init(selected, {}, undefined, { genomeSequence, geneId: 3 })).toThrow('exactly one annotated CDS');
    expect(selectRibosomeTrafficGene(phage(genomeSequence, [gene(9, { id: 5 }), longer])).id).toBe(1);
  });

  it('does not truncate a long valid CDS to 1000 codons', () => {
    const genomeSequence = 'ATG'.repeat(1200) + 'TAA';
    const state = ribosomeTrafficSimulation.init(phage(genomeSequence), {}, undefined, { genomeSequence });
    expect(state.codonRates).toHaveLength(1201);
    expect(state.transcript?.cds).toBe(genomeSequence);
  });

  it('rejects missing, unsupported or mismatched exact inputs instead of labeling random data as a phage', () => {
    const genomeSequence = 'ATGAAATAA';
    expect(() => ribosomeTrafficSimulation.init(phage(genomeSequence))).toThrow('complete genome sequence');
    expect(() => ribosomeTrafficSimulation.init(phage(genomeSequence, []), {}, undefined, { genomeSequence })).toThrow('No annotated CDS');
    expect(() => ribosomeTrafficSimulation.init(phage(genomeSequence), {}, undefined, { genomeSequence: 'ATGAAA' })).toThrow('sequence length');
    for (const qualifiers of [{ pseudo: '' }, { transl_table: 2 }, { codon_start: 4 }, { translation: 'MW' },
      { transl_except: '(pos:1..3,aa:Sec)' },
      { _segments: [{ start: 0, end: 6, strand: '+' }, { start: 3, end: 9, strand: '+' }] }]) {
      expect(() => ribosomeTrafficSimulation.init(phage(genomeSequence, [gene(9, { qualifiers })]), {}, undefined, { genomeSequence })).toThrow('Selected CDS is unavailable');
    }
    for (const invalid of ['ATGNNNTAA', 'ATGTGATAA', 'ATGAAATA']) {
      expect(() => ribosomeTrafficSimulation.init(phage(invalid), {}, undefined, { genomeSequence: invalid })).toThrow('Selected CDS is unavailable');
    }
    expect(() => ribosomeTrafficSimulation.init(null, {}, undefined, { genomeSequence })).toThrow('matching annotated phage');
    const oversized = 'ATG'.repeat(RIBOSOME_TRAFFIC_LIMITS.codons + 1);
    expect(() => ribosomeTrafficSimulation.init(phage(oversized), {}, undefined, { genomeSequence: oversized })).toThrow('20,000-codon');
  });

  it('keeps a following ribosome outside a stationary leader footprint', () => {
    const base = ribosomeTrafficSimulation.init(null, { initiationRate: 0, footprint: 9 }, () => 0);
    const rates = Array(20).fill(1); rates[9] = 0;
    const state = { ...base, codonRates: rates, ribosomes: [9, 0] };
    const next = ribosomeTrafficSimulation.step(state, 1, () => 0);
    expect(next.ribosomes).toEqual([9, 0]);
    expect(next.stallEvents).toBe(1);
    expect(state.ribosomes).toEqual([9, 0]);
  });

  it('preserves zero elongation, entry and exit probabilities', () => {
    const base = ribosomeTrafficSimulation.init(null, { initiationRate: 0, terminationRate: 0, footprint: 1 }, () => 0);
    const state = { ...base, codonRates: [0, 1, 1], ribosomes: [2, 0] };
    const next = ribosomeTrafficSimulation.step(state, 5, () => 0);
    expect(next.ribosomes).toEqual([2, 0]);
    expect(next.proteinsProduced).toBe(0);
  });

  it('accumulates fractional time without resampling biological progress or consuming extra random draws', () => {
    const base = ribosomeTrafficSimulation.init(null, { footprint: 1 }, () => 0.5);
    let fractional = structuredClone(base), batchedCalls = 0, splitCalls = 0;
    const nextRandom = (index: number) => ((index * 13) % 97) / 97;
    const batched = ribosomeTrafficSimulation.step(base, 8, () => nextRandom(batchedCalls++));
    for (let step = 0; step < 32; step++) fractional = ribosomeTrafficSimulation.step(fractional, 0.25, () => nextRandom(splitCalls++));
    expect(splitCalls).toBe(batchedCalls);
    expect(fractional.time).toBe(batched.time);
    expect(fractional.pendingSteps).toBe(0);
    expect(fractional.ribosomes).toEqual(batched.ribosomes);
    expect(fractional.proteinsProduced).toBe(batched.proteinsProduced);
    expect(fractional.stallEvents).toBe(batched.stallEvents);
    expect(ribosomeTrafficSimulation.step(base, 0.25, () => { throw new Error('Unexpected draw'); }).ribosomes).toEqual([]);
  });

  for (const { count, delta } of [{ count: 10, delta: 0.1 }, { count: 100, delta: 0.01 }]) {
    it(`completes one discrete step after ${count} decimal partitions of ${delta}`, () => {
      const base = ribosomeTrafficSimulation.init(null, { initiationRate: 1, footprint: 1 }, () => 0.5);
      let fractional = structuredClone(base), batchedCalls = 0, splitCalls = 0;
      const batched = ribosomeTrafficSimulation.step(base, 1, () => { batchedCalls++; return 0.5; });
      for (let step = 0; step < count; step++) {
        fractional = ribosomeTrafficSimulation.step(fractional, delta, () => { splitCalls++; return 0.5; });
      }
      expect(fractional.ribosomes).toEqual([0]);
      expect(fractional.ribosomes).toEqual(batched.ribosomes);
      expect(fractional.proteinsProduced).toBe(batched.proteinsProduced);
      expect(fractional.stallEvents).toBe(batched.stallEvents);
      expect(fractional.pendingSteps).toBe(0);
      expect(splitCalls).toBe(batchedCalls);
      expect(splitCalls).toBe(1);
    });
  }

  it('does not advance an unfinished step or erase a tiny positive delta', () => {
    const base = ribosomeTrafficSimulation.init(null, { initiationRate: 1 }, () => 0.5);
    const noDraw = () => { throw new Error('An unfinished step must not draw randomness'); };
    const pending = ribosomeTrafficSimulation.step(base, 0.999999999, noDraw);
    expect(pending.pendingSteps).toBe(0.999999999);
    expect(pending.ribosomes).toEqual([]);
    expect(pending.proteinsProduced).toBe(0);
    expect(pending.stallEvents).toBe(0);
    const tiny = ribosomeTrafficSimulation.step(base, Number.EPSILON / 4, noDraw);
    expect(tiny.pendingSteps).toBe(Number.EPSILON / 4);
    expect(tiny.ribosomes).toEqual([]);
  });

  it('conserves entered particles through exit and keeps every footprint disjoint', () => {
    // With all transition probabilities one, 4 sites and footprint two:
    // entries occur on odd steps and the first exit is at step five.
    let state = { ...ribosomeTrafficSimulation.init(null, { initiationRate: 1, terminationRate: 1, footprint: 2 }, () => 0),
      codonRates: [1, 1, 1, 1] };
    for (let step = 1; step <= 20; step++) {
      state = ribosomeTrafficSimulation.step(state, 1, () => 0);
      expect(state.ribosomes.length + state.proteinsProduced).toBe(Math.ceil(step / 2));
      expect(state.proteinsProduced).toBe(Math.max(0, Math.ceil((step - 4) / 2)));
      for (let index = 1; index < state.ribosomes.length; index++) {
        expect(state.ribosomes[index - 1] - state.ribosomes[index]).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('rejects invalid probability, footprint, delta and occupancy domains', () => {
    for (const params of [{ initiationRate: -1 }, { terminationRate: Infinity }, { footprint: 1.5 }, { footprint: 0 }]) {
      expect(() => ribosomeTrafficSimulation.init(null, params)).toThrow();
    }
    const base = ribosomeTrafficSimulation.init(null, {}, () => 0);
    for (const dt of [-1, Infinity, NaN, 10001]) expect(() => ribosomeTrafficSimulation.step(base, dt)).toThrow('Time delta');
    expect(() => ribosomeTrafficSimulation.step({ ...base, ribosomes: [9, 1] }, 1)).toThrow('separated by their footprint');
    expect(() => ribosomeTrafficSimulation.step({ ...base, codonRates: [NaN] }, 1)).toThrow('finite departure probabilities');
  });
});

