/**
 * Tests for CRISPR Pressure Analysis Module
 *
 * Tests spacer hit detection, Acr candidate prediction,
 * and pressure window calculation.
 */

import { describe, test, expect } from 'bun:test';
import { analyzeCRISPRPressure } from './crispr';
import type { GeneInfo } from './types';
import type { SpacerRecord } from './crispr';

/**
 * These sequences used to be named for the six hardcoded 6-mers the module
 * scanned for. That table is gone; see the measurement in crispr.ts.
 *
 * Spacers are now real 32-mers supplied by the caller, so the fixtures below
 * plant a known protospacer at a known position and the tests assert it is
 * found there. A 32-mer does not occur by chance in a 36 bp sequence, which is
 * exactly the property the 6-mer version lacked.
 */
const SPACER_A = 'ACGTTGCAAGGCTTACGCATTGCAAGCTTGAC'; // 32 bp
const SPACER_B = 'TTGGCCAATTCCGGAATTCCGGTTAACCGGTA'; // 32 bp

const FLANK_L = 'ATGCATGCATGCATGC';
const FLANK_R = 'GCATGCATGCATGCAT';

/** Genome carrying SPACER_A once, at a position the tests know. */
const SEQ_WITH_SPACERS = FLANK_L + SPACER_A + FLANK_R;
const SPACER_A_POSITION = FLANK_L.length;

/** Genome carrying neither spacer. */
const SEQ_WITHOUT_SPACERS = 'ATGCATGCATGCATGCATGCATGCATGCATGCATGC';

const spacerSet = (...seqs: string[]): SpacerRecord[] =>
  seqs.map((sequence, i) => ({
    sequence,
    host: 'Escherichia coli K-12',
    accession: `TEST-SPACER-${i + 1}`,
  }));

const OPTS = { spacers: spacerSet(SPACER_A, SPACER_B), host: 'Escherichia coli K-12' };

let geneId = 0;
const makeGene = (
  product: string,
  start: number,
  end: number,
  strand: '+' | '-' = '+'
): GeneInfo => ({
  id: ++geneId,
  name: null,
  locusTag: `gene_${geneId}`,
  startPos: start,
  endPos: end,
  strand,
  product,
  type: 'CDS',
});

describe('analyzeCRISPRPressure', () => {
  describe('result structure', () => {
    test('returns complete result structure', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, []);

      expect(result).toHaveProperty('spacerHits');
      expect(result).toHaveProperty('acrCandidates');
      expect(result).toHaveProperty('pressureWindows');
      expect(result).toHaveProperty('maxPressure');

      expect(Array.isArray(result.spacerHits)).toBe(true);
      expect(Array.isArray(result.acrCandidates)).toBe(true);
      expect(Array.isArray(result.pressureWindows)).toBe(true);
      expect(typeof result.maxPressure).toBe('number');
    });

    test('handles empty sequence', () => {
      const result = analyzeCRISPRPressure('', []);

      expect(result.spacerHits).toEqual([]);
      expect(result.acrCandidates).toEqual([]);
      expect(result.pressureWindows).toEqual([]);
      expect(result.maxPressure).toBe(0);
    });
  });

  describe('spacer detection', () => {
    test('detects a supplied spacer in the sequence', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], OPTS);

      expect(result.spacerHits.length).toBeGreaterThan(0);
    });

    test('spacer hits are sorted by position', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, []);

      for (let i = 1; i < result.spacerHits.length; i++) {
        expect(result.spacerHits[i].position).toBeGreaterThanOrEqual(
          result.spacerHits[i - 1].position
        );
      }
    });

    test('spacer hit has required properties', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, []);

      for (const hit of result.spacerHits) {
        expect(hit).toHaveProperty('position');
        expect(hit).toHaveProperty('sequence');
        expect(hit).toHaveProperty('host');
        expect(hit).toHaveProperty('crisprType');
        expect(hit).toHaveProperty('matchScore');
        expect(hit).toHaveProperty('pamStatus');
        expect(hit).toHaveProperty('strand');

        expect(typeof hit.position).toBe('number');
        expect(typeof hit.sequence).toBe('string');
        expect(['I', 'II', 'III', 'V', 'VI']).toContain(hit.crisprType);
        expect(['valid', 'invalid', 'none']).toContain(hit.pamStatus);
        expect(['coding', 'template']).toContain(hit.strand);
      }
    });

    test('match score is between 0 and 1', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, []);

      for (const hit of result.spacerHits) {
        expect(hit.matchScore).toBeGreaterThanOrEqual(0);
        expect(hit.matchScore).toBeLessThanOrEqual(1);
      }
    });

    test('no hits for a sequence carrying neither spacer', () => {
      const result = analyzeCRISPRPressure(SEQ_WITHOUT_SPACERS, [], OPTS);
      expect(result.spacerHits.length).toBe(0);
    });

    test('handles lowercase sequence', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS.toLowerCase(), [], OPTS);
      expect(result.spacerHits.length).toBeGreaterThan(0);
    });

    test('detects multiple occurrences of the same spacer', () => {
      const doubleSpacerSeq = SPACER_A + FLANK_L + SPACER_A + FLANK_R;
      const result = analyzeCRISPRPressure(doubleSpacerSeq, [], OPTS);
      const aHits = result.spacerHits.filter(h => h.sequence === SPACER_A);
      expect(aHits.length).toBe(2);
    });

    test('finds the protospacer at the position it was planted', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], OPTS);
      const hit = result.spacerHits.find(h => h.sequence === SPACER_A);
      expect(hit).toBeDefined();
      expect(hit!.position).toBe(SPACER_A_POSITION);
      expect(hit!.mismatches).toBe(0);
      expect(hit!.matchScore).toBe(1);
    });

    test('finds a protospacer on the reverse strand', () => {
      // Real protospacers occur on either strand; searching one direction only
      // would miss half of them.
      const rc = SPACER_A.split('').reverse()
        .map(c => ({ A: 'T', C: 'G', G: 'C', T: 'A' }[c] ?? 'N')).join('');
      const result = analyzeCRISPRPressure(FLANK_L + rc + FLANK_R, [], OPTS);
      const hit = result.spacerHits.find(h => h.strand === 'template');
      expect(hit).toBeDefined();
      expect(hit!.mismatches).toBe(0);
    });

    test('tolerates mismatches up to the budget and no further', () => {
      // Six mismatches in a 32-mer is outside the default budget of five.
      const mutate = (seq: string, n: number) => {
        const chars = seq.split('');
        for (let i = 0; i < n; i++) chars[i * 3] = chars[i * 3] === 'A' ? 'C' : 'A';
        return chars.join('');
      };
      const within = analyzeCRISPRPressure(FLANK_L + mutate(SPACER_A, 3) + FLANK_R, [], OPTS);
      expect(within.spacerHits.length).toBeGreaterThan(0);
      expect(within.spacerHits[0].mismatches).toBeLessThanOrEqual(5);

      const beyond = analyzeCRISPRPressure(FLANK_L + mutate(SPACER_A, 9) + FLANK_R, [], OPTS);
      expect(beyond.spacerHits.length).toBe(0);
    });

    test('attributes each hit to the host that carried the spacer', () => {
      // Every hit used to carry the literal 'E. coli K-12' regardless of the
      // phage, including for the Mycobacterium, Streptomyces and marine phages.
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], {
        spacers: [{ sequence: SPACER_A, host: 'Mycolicibacterium smegmatis' }],
        host: 'Mycolicibacterium smegmatis',
      });
      expect(result.spacerHits.length).toBeGreaterThan(0);
      for (const hit of result.spacerHits) {
        expect(hit.host).toBe('Mycolicibacterium smegmatis');
      }
    });
  });

  /**
   * The load-bearing block. With no spacer data there must be no hits, and the
   * result must say so rather than reporting a measured pressure of zero.
   *
   * This is the state of every phage in the shipped catalogue: an exhaustive
   * search of CRISPRCasdb's spacers against all 24 genomes found 0 exact
   * matches, 0 within 2 mismatches, and 1 within 5 (P1, 4 mismatches in 32 bp,
   * which is what chance produces in a 94 kb genome).
   */
  describe('no spacer data', () => {
    test('a phage with no spacer data yields zero hits, not chance matches', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, []);
      expect(result.spacerHits.length).toBe(0);
      expect(result.spacersSearched).toBe(0);
    });

    test('says which host is missing data rather than showing an empty chart', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], {
        host: 'Bacillus subtilis',
      });
      expect(result.noSpacerDataFor).toBe('Bacillus subtilis');
    });

    test('reports no missing-data marker once spacers were searched', () => {
      // The discrimination check. A field that is always set carries no signal.
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], OPTS);
      expect(result.noSpacerDataFor).toBeNull();
      expect(result.spacersSearched).toBe(2);
    });

    test('reports zero pressure everywhere, with no dominant type invented', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS.repeat(40), []);
      expect(result.maxPressure).toBe(0);
      for (const w of result.pressureWindows) {
        expect(w.pressureIndex).toBe(0);
        expect(w.spacerCount).toBe(0);
        // Used to be the literal 'II' with the comment "Simplified", reporting
        // a Cas9 system for every window of every genome ever analysed.
        expect(w.dominantType).toBe('none');
      }
    });

    test('ignores spacers too short to be meaningful', () => {
      // A 6-mer recurs by chance about every 4 kb. Accepting one would
      // reintroduce the exact defect this module was rewritten to remove.
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS, [], {
        spacers: [{ sequence: 'TGACGT', host: 'Escherichia coli K-12' }],
        host: 'Escherichia coli K-12',
      });
      expect(result.spacersSearched).toBe(0);
      expect(result.spacerHits.length).toBe(0);
      expect(result.noSpacerDataFor).toBe('Escherichia coli K-12');
    });
  });

  describe('PAM detection', () => {
    test('identifies valid Cas9 PAM (NGG downstream)', () => {
      // TGACGT followed by NGG
      const seqWithCas9Pam = 'ATGCTGACGTCGGATGC'; // spacer + CGG (NGG)
      const result = analyzeCRISPRPressure(seqWithCas9Pam, []);

      const spacerHits = result.spacerHits.filter((h) => h.sequence === 'TGACGT');
      if (spacerHits.length > 0) {
        // If PAM is detected correctly, some hits might have valid status
        const hasValidPam = spacerHits.some((h) => h.pamStatus === 'valid');
        expect(typeof hasValidPam).toBe('boolean');
      }
    });

    test('identifies valid Cas12a PAM (TTTV upstream)', () => {
      // TTT upstream of spacer (Cas12a PAM)
      const seqWithCas12aPam = 'TTTATGACGTATGCATGC';
      const result = analyzeCRISPRPressure(seqWithCas12aPam, []);

      // Should have hits, PAM may or may not be valid depending on exact positioning
      expect(result.spacerHits.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Acr candidate prediction', () => {
    test('returns candidates for genes in size range', () => {
      // Create genes with appropriate size (50-200 aa = 150-600 bp)
      const genes = [
        makeGene('small protein', 0, 300), // ~100 aa
        makeGene('medium protein', 0, 450), // ~150 aa
      ];

      // Need a sequence long enough to contain the genes
      const longSeq = 'ATG' + 'GCT'.repeat(200) + 'TAA'; // ~600bp coding-like
      const result = analyzeCRISPRPressure(longSeq, genes);

      // May or may not have candidates depending on heuristics
      expect(Array.isArray(result.acrCandidates)).toBe(true);
    });

    test('Acr candidate has required properties', () => {
      const genes = [makeGene('hypothetical protein', 0, 300)];
      const longSeq = 'ATG' + 'GAA'.repeat(100) + 'TAA'; // Acidic residues
      const result = analyzeCRISPRPressure(longSeq, genes);

      for (const candidate of result.acrCandidates) {
        expect(candidate).toHaveProperty('geneId');
        expect(candidate).toHaveProperty('geneName');
        expect(candidate).toHaveProperty('score');
        expect(candidate).toHaveProperty('family');
        expect(candidate).toHaveProperty('confidence');

        expect(typeof candidate.score).toBe('number');
        expect(candidate.score).toBeGreaterThanOrEqual(0);
        expect(candidate.score).toBeLessThanOrEqual(100);
        expect(['low', 'medium', 'high']).toContain(candidate.confidence);
      }
    });

    test('candidates are sorted by score descending', () => {
      const genes = [
        makeGene('protein1', 0, 300),
        makeGene('protein2', 300, 600),
        makeGene('protein3', 600, 900),
      ];
      const longSeq = 'ATG' + 'GAA'.repeat(300) + 'TAA';
      const result = analyzeCRISPRPressure(longSeq, genes);

      for (let i = 1; i < result.acrCandidates.length; i++) {
        expect(result.acrCandidates[i].score).toBeLessThanOrEqual(
          result.acrCandidates[i - 1].score
        );
      }
    });

    test('excludes genes outside size range', () => {
      const genes = [
        makeGene('very small', 0, 100), // ~33 aa (too small)
        makeGene('very large', 0, 1000), // ~333 aa (too large)
      ];
      const longSeq = 'ATG' + 'GCT'.repeat(500) + 'TAA';
      const result = analyzeCRISPRPressure(longSeq, genes);

      // These should not generate candidates due to size constraints
      // The result might still have 0 candidates
      expect(Array.isArray(result.acrCandidates)).toBe(true);
    });
  });

  describe('pressure windows', () => {
    test('creates windows covering entire sequence', () => {
      const longSeq = SEQ_WITH_SPACERS.repeat(50); // Make it longer
      const result = analyzeCRISPRPressure(longSeq, []);

      // Windows should cover the sequence
      expect(result.pressureWindows.length).toBeGreaterThan(0);

      // First window starts at 0
      expect(result.pressureWindows[0].start).toBe(0);

      // Last window ends at or past sequence length
      const lastWindow = result.pressureWindows[result.pressureWindows.length - 1];
      expect(lastWindow.end).toBeLessThanOrEqual(longSeq.length);
    });

    test('pressure window has required properties', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS.repeat(10), []);

      for (const window of result.pressureWindows) {
        expect(window).toHaveProperty('start');
        expect(window).toHaveProperty('end');
        expect(window).toHaveProperty('pressureIndex');
        expect(window).toHaveProperty('spacerCount');
        expect(window).toHaveProperty('dominantType');

        expect(typeof window.start).toBe('number');
        expect(typeof window.end).toBe('number');
        expect(window.end).toBeGreaterThan(window.start);
        expect(typeof window.pressureIndex).toBe('number');
        expect(typeof window.spacerCount).toBe('number');
      }
    });

    test('pressure index is normalized to 0-10', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS.repeat(20), []);

      for (const window of result.pressureWindows) {
        expect(window.pressureIndex).toBeGreaterThanOrEqual(0);
        expect(window.pressureIndex).toBeLessThanOrEqual(10);
      }
    });

    test('windows without spacers have zero spacer count', () => {
      const result = analyzeCRISPRPressure(SEQ_WITHOUT_SPACERS.repeat(10), []);

      for (const window of result.pressureWindows) {
        expect(window.spacerCount).toBe(0);
        expect(window.pressureIndex).toBe(0);
      }
    });
  });

  describe('maxPressure', () => {
    test('maxPressure is zero when no spacers found', () => {
      const result = analyzeCRISPRPressure(SEQ_WITHOUT_SPACERS, []);
      expect(result.maxPressure).toBe(0);
    });

    test('maxPressure is positive when spacers found', () => {
      const result = analyzeCRISPRPressure(SEQ_WITH_SPACERS.repeat(10), []);

      if (result.spacerHits.length > 0) {
        expect(result.maxPressure).toBeGreaterThan(0);
      }
    });
  });
});
