/**
 * Unit tests for RNA Structure & Packaging Signal Explorer
 *
 * Note: These tests use minimal sequences to avoid memory issues with
 * the computationally intensive folding algorithms.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeRNAWindows,
  foldRnaPairing,
  analyzeGeneRNAStructure,
  RNA_STRUCTURE_LIMITS,
  resolveRNAStructureOptions,
  computeSynonymousStress,
  findHighStressRegions,
  detectRegulatoryElements,
  analyzeRNAStructure,
  type CodonStress,
} from './rna-structure';

describe('analyzeRNAWindows', () => {
  it('returns empty array for sequence shorter than window', () => {
    const result = analyzeRNAWindows('ACGT', 120, 30);
    expect(result).toEqual([]);
  });

  it('creates windows with correct positions', () => {
    const seq = 'ACGT'.repeat(20); // 80bp
    const result = analyzeRNAWindows(seq, 40, 20);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].start).toBe(0);
    expect(result[0].end).toBe(40);
    expect(result[0].sequence.length).toBe(40);
  });

  it('calculates GC content correctly', () => {
    const gcSeq = 'GCGCGCGC'.repeat(8); // 64bp
    const result = analyzeRNAWindows(gcSeq, 40, 20);
    expect(result[0].gcContent).toBe(1);
  });

  it('calculates GC content for AT-only sequence', () => {
    const atSeq = 'ATATAT'.repeat(12); // 72bp
    const result = analyzeRNAWindows(atSeq, 40, 20);
    expect(result[0].gcContent).toBe(0);
  });

  it('returns mfe and pairingDensity for each window', () => {
    const seq = 'ACGT'.repeat(15); // 60bp
    const result = analyzeRNAWindows(seq, 40, 20);

    expect(result[0]).toHaveProperty('pairingScore');
    expect(result[0]).toHaveProperty('pairingDensity');
    // null is a valid value: it means no stem was found, which is different
    // from a structure that scored zero.
    expect(['number', 'object']).toContain(typeof result[0].pairingScore);
    expect(result[0].pairingDensity).toBeGreaterThanOrEqual(0);
    expect(result[0].pairingDensity).toBeLessThanOrEqual(1);
  });
});

describe('computeSynonymousStress', () => {
  it('returns empty array for empty sequence', () => {
    const result = computeSynonymousStress('');
    expect(result).toEqual([]);
  });

  it('returns empty array for sequence shorter than one codon', () => {
    const result = computeSynonymousStress('AC');
    expect(result).toEqual([]);
  });

  it('processes valid coding sequence', () => {
    const seq = 'ATGGCTAGC'; // Met-Ala-Ser
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
    expect(result[0].position).toBe(0);
    expect(result[0].codon).toBe('ATG');
    expect(result[0].aminoAcid).toBe('M');
  });

  it('skips stop codons', () => {
    const seq = 'ATGTAATGA'; // Met-Stop-Stop
    const result = computeSynonymousStress(seq);
    expect(result.length).toBe(1);
    expect(result[0].aminoAcid).toBe('M');
  });

  it('calculates synonymous variants', () => {
    const seq = 'TTA'; // Leucine (has 6 synonymous codons)
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(1);
    expect(result[0].variants.length).toBeGreaterThan(0);
    for (const variant of result[0].variants) {
      expect(variant.aminoAcid).toBe('L');
    }
  });

  it('respects frame parameter', () => {
    const seq = 'AATGGCTAGC'; // A + Met-Ala-Ser (offset by 1)
    const result = computeSynonymousStress(seq, 1);

    expect(result[0].codon).toBe('ATG');
    expect(result[0].aminoAcid).toBe('M');
  });
});

describe('findHighStressRegions', () => {
  it('returns empty array for empty input', () => {
    const result = findHighStressRegions([]);
    expect(result).toEqual([]);
  });

  it('returns empty array when no high stress codons', () => {
    const stressData: CodonStress[] = [
      { position: 0, codon: 'ATG', aminoAcid: 'M', wildTypeDeltaG: 0, variants: [], stress: 0.1, stressPercentile: 0.2, isConstrained: false },
      { position: 1, codon: 'GCT', aminoAcid: 'A', wildTypeDeltaG: 0, variants: [], stress: 0.2, stressPercentile: 0.3, isConstrained: false },
    ];
    const result = findHighStressRegions(stressData);
    expect(result).toEqual([]);
  });

  it('finds contiguous high-stress region', () => {
    const stressData: CodonStress[] = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      codon: 'GCT',
      aminoAcid: 'A',
      wildTypeDeltaG: 0,
      variants: [],
      stress: i < 5 ? 0.2 : 0.8,
      stressPercentile: i < 5 ? 0.3 : 0.9,
      isConstrained: i >= 5,
    }));

    const result = findHighStressRegions(stressData);
    expect(result.length).toBe(1);
    expect(result[0].start).toBe(15); // Position 5 * 3
  });

  it('respects minLength parameter', () => {
    const stressData: CodonStress[] = Array.from({ length: 10 }, (_, i) => ({
      position: i,
      codon: 'GCT',
      aminoAcid: 'A',
      wildTypeDeltaG: 0,
      variants: [],
      stress: i >= 2 && i <= 4 ? 0.8 : 0.2,
      stressPercentile: i >= 2 && i <= 4 ? 0.9 : 0.3,
      isConstrained: i >= 2 && i <= 4,
    }));

    const result = findHighStressRegions(stressData, 5); // Require at least 5
    expect(result).toEqual([]);
  });
});

describe('detectRegulatoryElements', () => {
  it('returns empty array for empty sequence', () => {
    const result = detectRegulatoryElements('', []);
    expect(result).toEqual([]);
  });

  it('detects slippery sites', () => {
    // Include UUUAAAC slippery site (TTTAAAC in DNA)
    const seq = 'ACGTTTTTAAACGCGT';
    const result = detectRegulatoryElements(seq, []);

    const slipperySites = result.filter(h => h.type === 'slippery-site');
    expect(slipperySites.length).toBeGreaterThan(0);
    expect(slipperySites[0].sequence).toBe('UUUAAAC');
  });

  it('detects riboswitch motifs', () => {
    // Include GGCGU riboswitch fragment
    const seq = 'ACGTGGCGUACGTACGT';
    const result = detectRegulatoryElements(seq, []);

    const riboswitches = result.filter(h => h.type === 'riboswitch');
    expect(riboswitches.length).toBeGreaterThan(0);
  });

  it('sorts results by confidence descending', () => {
    const seq = 'TTTAAAC' + 'GGCGU'; // Multiple hits
    const result = detectRegulatoryElements(seq, []);

    // Scored hypotheses come first in descending confidence; unscored ones
    // (exact motif matches, which carry no computable confidence) follow.
    const scored = result.filter(r => r.confidence !== null);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].confidence!).toBeGreaterThanOrEqual(scored[i].confidence!);
    }
    const firstUnscored = result.findIndex(r => r.confidence === null);
    if (firstUnscored !== -1) {
      expect(result.slice(firstUnscored).every(r => r.confidence === null)).toBe(true);
    }
  });
});

describe('analyzeRNAStructure', () => {
  it('handles empty sequence', () => {
    const result = analyzeRNAStructure('');

    expect(result.windows).toEqual([]);
    expect(result.codonStress).toEqual([]);
    expect(result.highStressRegions).toEqual([]);
    // Null, not 0: an empty sequence forms no stems, and reporting 0 made
    // "nothing found" indistinguishable from "a perfectly neutral structure".
    expect(result.globalPairingScore).toBeNull();
  });

  it('returns complete analysis structure for small sequence', () => {
    const seq = 'ATGGCTAGC'; // 9bp - 3 codons
    const result = analyzeRNAStructure(seq, { windowSize: 9, stepSize: 3 });

    expect(result).toHaveProperty('windows');
    expect(result).toHaveProperty('codonStress');
    expect(result).toHaveProperty('highStressRegions');
    expect(result).toHaveProperty('regulatoryHypotheses');
    expect(result).toHaveProperty('globalPairingScore');
    expect(result).toHaveProperty('avgSynonymousStress');
  });
});

describe('edge cases', () => {
  it('handles lowercase input', () => {
    const seq = 'atggctagc'; // lowercase
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
    expect(result[0].aminoAcid).toBe('M');
  });

  it('handles mixed case input', () => {
    const seq = 'AtGgCtAgC';
    const result = computeSynonymousStress(seq);

    expect(result.length).toBe(3);
  });

  it('handles sequence with only Ns', () => {
    const seq = 'NNNNNNNNN'; // 3 codons of Ns
    const result = computeSynonymousStress(seq);
    // Should handle gracefully (no valid amino acids)
    expect(Array.isArray(result)).toBe(true);
  });
});

/**
 * The metric is a score, not a free energy.
 *
 * The overlay reported this as "Global MFE ... kcal/mol". A minimum free energy
 * cannot be positive, and this number could be, which is the tell that no
 * energy model was involved: the implementation is a greedy stem scan with toy
 * constants. It was also exactly 0 when no stem was found, so "nothing
 * detected" and "perfectly neutral structure" rendered identically.
 */
describe('pairing score is not presented as an energy', () => {
  it('reports null rather than zero when no stem is found', () => {
    // A homopolymer cannot pair with itself under the pairing rules.
    const result = analyzeRNAWindows('A'.repeat(80), 40, 20);
    expect(result.length).toBeGreaterThan(0);
    for (const w of result) expect(w.pairingScore).toBeNull();
  });

  it('reports a number when a stem really is present', () => {
    // The discrimination check. If pairingScore were always null the test above
    // would pass and the metric would be useless.
    const stem = 'GGGGGCCCCC';
    const seq = (stem + 'AAAAA').repeat(8);
    const result = analyzeRNAWindows(seq, 40, 20);
    expect(result.some(w => w.pairingScore !== null)).toBe(true);
  });

  it('carries no kcal/mol unit anywhere in the module', () => {
    // Source-level, because the defect was a unit on a label rather than a
    // value a test can observe.
    const src = readFileSync(join(import.meta.dir, 'rna-structure.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('kcal/mol');
  });

  it('averages the global score over windows that formed a stem', () => {
    // Including unstructured windows as zeroes dragged the mean toward zero in
    // proportion to how much UNSTRUCTURED sequence there was, which inverts the
    // meaning of the number.
    const stem = 'GGGGGCCCCC';
    const structured = analyzeRNAStructure((stem + 'AAAAA').repeat(12), {
      windowSize: 30,
      stepSize: 15,
    });
    if (structured.globalPairingScore !== null) {
      expect(structured.globalPairingScore).toBeLessThan(0);
    }
    const flat = analyzeRNAStructure('A'.repeat(200), { windowSize: 30, stepSize: 15 });
    expect(flat.globalPairingScore).toBeNull();
  });
});

describe('no constant is presented as a per-site confidence', () => {
  it('gives exact motif matches no confidence at all', () => {
    // Slippery sites carried 0.7 and riboswitch motifs 0.3, on every hit. Those
    // read as per-site probabilities and were nothing of the kind: the scan
    // cannot tell a functional signal from the same bases occurring by chance.
    const seq = ('UUUAAAC' + 'GCGCGCGCGC').repeat(6);
    const hits = detectRegulatoryElements(seq, []);
    const motifHits = hits.filter(
      h => h.type === 'slippery-site' || h.type === 'riboswitch'
    );
    expect(motifHits.length).toBeGreaterThan(0);
    for (const h of motifHits) expect(h.confidence).toBeNull();
  });

  it('retains concrete paired-motif evidence without pretending it is calibrated confidence', () => {
    const sequence = 'GCGCGCGCGCGCGCGCGCGC';
    const hits = detectRegulatoryElements(sequence, []);
    const paired = hits.find(hit => hit.type === 'packaging-signal');
    expect(paired).toBeDefined();
    expect(paired!.confidence).toBeNull();
    expect(paired!.sequence).toBe(sequence);
    expect(paired!.structure).toBe('((((((((....))))))))');
    expect(paired!.description).toContain('8 optimal pairs');
    expect(paired!.description).toContain('function is untested');
    expect(hits.every(hit => hit.confidence === null)).toBe(true);
  });
});

/**
 * Independent oracle: enumerate every matching by assigning each unused
 * position either no partner or any compatible unused partner, rejecting
 * crossing pairs directly. No interval recurrence, memoization or production
 * pairing helper is used.
 */
function enumeratePairings(sequence: string, minimumLoop: number, wobble: boolean): number {
  const allowed = new Set(wobble ? ['AU', 'UA', 'GC', 'CG', 'GU', 'UG'] : ['AU', 'UA', 'GC', 'CG']);
  const used = new Uint8Array(sequence.length);
  const pairs: Array<[number, number]> = [];
  let optimum = 0;
  function visit(index: number): void {
    while (index < sequence.length && used[index]) index++;
    if (index === sequence.length) { optimum = Math.max(optimum, pairs.length); return; }
    used[index] = 1;
    visit(index + 1);
    for (let other = index + minimumLoop + 1; other < sequence.length; other++) {
      if (used[other] || !allowed.has(sequence[index] + sequence[other])) continue;
      if (pairs.some(([a, b]) => (a < index && index < b && b < other) || (index < a && a < other && other < b))) continue;
      used[other] = 1;
      pairs.push([index, other]);
      visit(index + 1);
      pairs.pop();
      used[other] = 0;
    }
    used[index] = 0;
  }
  visit(0);
  return optimum;
}

function assertPairing(sequence: string, minLoopSize: number, allowWobble: boolean): void {
  const result = foldRnaPairing(sequence, { minLoopSize, allowWobble });
  expect(result.pairCount).toBe(enumeratePairings(sequence, minLoopSize, allowWobble));
  const used = new Set<number>();
  const stack: number[] = [];
  const bracketPairs: Array<[number, number]> = [];
  for (let index = 0; index < result.structure.length; index++) {
    if (result.structure[index] === '(') stack.push(index);
    if (result.structure[index] === ')') {
      const open = stack.pop();
      expect(open).toBeDefined();
      bracketPairs.push([open!, index]);
    }
  }
  expect(stack).toEqual([]);
  expect(bracketPairs.sort((a, b) => a[0] - b[0])).toEqual(result.pairs);
  for (const [i, j] of result.pairs) {
    expect(used.has(i) || used.has(j)).toBe(false);
    expect(j - i - 1).toBeGreaterThanOrEqual(minLoopSize);
    used.add(i); used.add(j);
    for (const [a, b] of result.pairs) expect(i < a && a < j && j < b).toBe(false);
  }
  expect(result.pairingScore).toBe(result.pairCount ? -result.pairCount : null);
  expect(result.pairingDensity).toBe(sequence.length ? 2 * result.pairCount / sequence.length : 0);
}

describe('exact bounded noncrossing RNA pairing', () => {
  it('replaces incompatible overlapping stems with one valid five-pair structure', () => {
    const result = foldRnaPairing('GGGGGAAAACCCCC');
    expect(result.pairs).toEqual([[0, 13], [1, 12], [2, 11], [3, 10], [4, 9]]);
    expect(result.structure).toBe('(((((....)))))');
    expect(result.pairCount).toBe(5);
    expect(result.pairingScore).toBe(-5);
    expect(result.pairingDensity).toBe(10 / 14);
  });

  it('agrees with exhaustive matching enumeration for every canonical input through length six', () => {
    let cases = 0;
    function enumerate(sequence: string, remaining: number): void {
      for (const minLoop of [0, 3]) {
        for (const wobble of [false, true]) { assertPairing(sequence, minLoop, wobble); cases++; }
      }
      if (remaining > 0) for (const base of 'ACGU') enumerate(sequence + base, remaining - 1);
    }
    enumerate('', 6);
    expect(cases).toBe(21844);
  }, 30000);

  it('matches the independent oracle on longer inputs and unknown bases', () => {
    let seed = 93411;
    for (let example = 0; example < 200; example++) {
      let sequence = '';
      for (let position = 0; position < 10; position++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        sequence += 'ACGUN'[seed % 5];
      }
      for (const minLoop of [0, 3]) for (const wobble of [false, true]) assertPairing(sequence, minLoop, wobble);
    }
  }, 30000);

  it('makes wobble and minimum-loop choices change the intended objective', () => {
    expect(foldRnaPairing('GAAAU', { allowWobble: true }).pairCount).toBe(1);
    expect(foldRnaPairing('GAAAU', { allowWobble: false }).pairCount).toBe(0);
    expect(foldRnaPairing('GAAAC', { minLoopSize: 3 }).pairCount).toBe(1);
    expect(foldRnaPairing('GAAAC', { minLoopSize: 4 }).pairCount).toBe(0);
    expect(foldRnaPairing('GRRRC').structure).toBe('(...)');
    expect(foldRnaPairing('NNNNN').pairCount).toBe(0);
    expect(foldRnaPairing('gaaac')).toEqual(foldRnaPairing('GAAAC'));
    expect(foldRnaPairing('GAAAT')).toEqual(foldRnaPairing('GAAAU'));
  });

  it('returns independent reproducible window traces and honest method metadata', () => {
    const result = analyzeRNAStructure('GGGGGAAAACCCCC', {
      windowSize: 14, stepSize: 7, includeSynonymousStress: false,
    });
    expect(result.windows[0].structure).toBe('(((((....)))))');
    expect(result.windows[0].pairCount).toBe(5);
    expect(result.codonStress).toEqual([]);
    expect(result.highStressRegions).toEqual([]);
    expect(result.method.id).toBe('rna-maximum-pairing');
    expect(result.method.limitations).toContain('no thermodynamic energy');
    expect(result.parameters).toEqual({
      windowSize: 14, stepSize: 7, frame: 0, includeSynonymousStress: false, minLoopSize: 3, allowWobble: true,
    });
    expect(result.coverage).toMatchObject({ sequenceBases: 14, windows: 1, analyzedCodons: 0, ambiguousBases: 0 });
    expect(result.coverage.dpCandidatesCharged).toBeGreaterThan(0);
  });

  it('rejects invalid input, loop, frame and window domains before nonadvancing loops', () => {
    for (const step of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => analyzeRNAWindows('ACGT', 4, step)).toThrow(/integer/);
    }
    for (const windowSize of [0, -1, 0.5, 241, NaN, Infinity]) {
      expect(() => analyzeRNAWindows('ACGT', windowSize, 1)).toThrow(/integer/);
    }
    for (const frame of [-1, 3, 0.5, NaN]) expect(() => computeSynonymousStress('ATGGCT', frame)).toThrow(/integer/);
    for (const minLoopSize of [-1, 31, 0.5]) expect(() => foldRnaPairing('GAAAC', { minLoopSize })).toThrow(/integer/);
    for (const sequence of ['AC-G', 'AC G', 'ACGX', 'ACG\n']) expect(() => foldRnaPairing(sequence)).toThrow(/IUPAC/);
    expect(() => foldRnaPairing('A'.repeat(RNA_STRUCTURE_LIMITS.foldBases + 1))).toThrow(/240/);
    expect(() => analyzeRNAStructure('A'.repeat(RNA_STRUCTURE_LIMITS.sequenceBases + 1))).toThrow(/6000/);
    expect(() => resolveRNAStructureOptions({ allowWobble: 1 as unknown as boolean })).toThrow(/wobble/);
  });

  it('enforces a whole-analysis candidate budget instead of returning a partial scan', () => {
    expect(() => analyzeRNAWindows('A'.repeat(6000), 240, 1)).toThrow(/candidate-work budget/);
  }, 30000);

  it('handles empty and one-to-nine-base genes without a zero-step loop', () => {
    for (let length = 0; length < 10; length++) {
      const result = analyzeGeneRNAStructure('A'.repeat(length), 0, length);
      expect(result.coverage.sequenceBases).toBe(length);
      expect(result.parameters.stepSize).toBeGreaterThan(0);
      expect(result.globalPairingScore).toBeNull();
    }
    expect(() => analyzeGeneRNAStructure('ACGT', -1, 3)).toThrow(/Gene interval/);
    expect(() => analyzeGeneRNAStructure('ACGT', 0, 5)).toThrow(/Gene interval/);
    expect(() => analyzeGeneRNAStructure('ACGT', 3, 2)).toThrow(/Gene interval/);
    expect(analyzeGeneRNAStructure('GTTTC', 0, 5, '-').windows[0].sequence).toBe('GAAAC');
  });

  it('substitutes at exact frame-one and frame-two nucleotide coordinates', () => {
    for (const frame of [1, 2]) {
      const sequence = 'A'.repeat(frame) + 'GGGGAAAACCCCC';
      const result = computeSynonymousStress(sequence, frame);
      expect(result.length).toBeGreaterThan(0);
      for (const codon of result) {
        const start = frame + codon.position * 3;
        expect(codon.nucleotideStart).toBe(start);
        expect(codon.nucleotideEnd).toBe(start + 3);
        expect(codon.codon).toBe(sequence.slice(start, start + 3));
        const expectedWild = -enumeratePairings(sequence.replace(/T/g, 'U'), 3, true);
        expect(codon.wildTypeDeltaG).toBe(expectedWild);
        for (const alternative of codon.variants) {
          const changed = sequence.slice(0, start) + alternative.codon + sequence.slice(start + 3);
          const expected = -enumeratePairings(changed.replace(/T/g, 'U'), 3, true);
          expect(alternative.deltaG).toBe(expected - expectedWild);
        }
      }
    }
  });

  it('gives all equal zero-sensitivity codons equal rank and no constraint claim', () => {
    const codons = computeSynonymousStress('A'.repeat(60));
    expect(codons.length).toBe(20);
    expect(codons.every(codon => codon.stress === 0 && codon.stressPercentile === 0.5 && !codon.isConstrained)).toBe(true);
    expect(computeSynonymousStress('AUGGCU')).toEqual(computeSynonymousStress('ATGGCT'));
  });

  it('keeps sensitive intervals frame-correct and splits across skipped codons', () => {
    const codon = (position: number): CodonStress => ({
      position, nucleotideStart: 1 + position * 3, nucleotideEnd: 4 + position * 3,
      codon: 'GCT', aminoAcid: 'A', wildTypeDeltaG: -2, variants: [], stress: 0.8,
      stressPercentile: 0.9, isConstrained: true,
    });
    expect(findHighStressRegions([codon(0), codon(1)], 2)).toEqual([{ start: 1, end: 7, avgStress: 0.8 }]);
    expect(findHighStressRegions([codon(0), codon(2), codon(3)], 3)).toEqual([]);
    expect(findHighStressRegions([codon(0), codon(2), codon(3)], 2)).toEqual([{ start: 7, end: 13, avgStress: 0.8 }]);
  });

  it('keeps motif coordinates within the exact supplied sequence and omits unsupported probabilities', () => {
    for (const sequence of ['GGCGU', 'GGGGGAAAACCCCCUUUUU', 'AGGAGGAAAAAAUG']) {
      const result = analyzeRNAStructure(sequence, { windowSize: Math.min(14, sequence.length), stepSize: 3, includeSynonymousStress: false });
      for (const hypothesis of result.regulatoryHypotheses) {
        expect(hypothesis.confidence).toBeNull();
        expect(hypothesis.start).toBeGreaterThanOrEqual(0);
        expect(hypothesis.end).toBeLessThanOrEqual(sequence.length);
        expect(hypothesis.sequence).toBe(sequence.slice(hypothesis.start, hypothesis.end));
        if (hypothesis.structure) expect(hypothesis.structure.length).toBe(hypothesis.sequence.length);
      }
    }
    const results = analyzeRNAStructure('GGGGGAAAACCCCCUUUUU', {
      windowSize: 14, stepSize: 4, includeSynonymousStress: false,
    });
    expect(results.regulatoryHypotheses.some(item => item.type === 'terminator')).toBe(true);
  });
});
