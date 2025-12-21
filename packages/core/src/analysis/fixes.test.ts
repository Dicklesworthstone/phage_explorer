import { describe, expect, test } from "bun:test";
import { calculateSelectionPressure } from '../selection-pressure';
import { detectPromoters } from '../transcription';

describe("Fresh Eyes Fixes Verification", () => {
  describe("dN/dS Calculation", () => {
    test("Identifies synonymous mutation correctly", () => {
      // AAA (Lys) -> AAG (Lys)
      const res = calculateSelectionPressure("AAA", "AAG", 3);
      expect(res.windows[0].dS).toBeGreaterThan(0);
      expect(res.windows[0].dN).toBeCloseTo(0);
    });

    test("Identifies non-synonymous mutation correctly", () => {
      // AAA (Lys) -> AGA (Arg)
      const res = calculateSelectionPressure("AAA", "AGA", 3);
      expect(res.windows[0].dN).toBeGreaterThan(0);
      expect(res.windows[0].dS).toBeCloseTo(0); // Only nonsyn sites might be counted, but dS should be 0 or undefined if no S sites diff
    });

    test("Handles multi-mutation codon correctly", () => {
      // AAA (Lys) -> AGG (Arg)
      // Path 1: AAA -> AGA (Arg, NonSyn) -> AGG (Arg, Syn)
      // Path 2: AAA -> AAG (Lys, Syn) -> AGG (Arg, NonSyn)
      // Our simplified logic checks each position independently.
      // Pos 1: A->G (AAA->GAA Glu, NonSyn) -- Wait, AAA->GAA is Lys->Glu.
      // Pos 2: A->G (AAA->AGA Arg, NonSyn)
      // Pos 3: A->G (AAA->AAG Lys, Syn)
      
      // Target is AGG.
      // Ref is AAA.
      // Pos 1 change: A->A (No change) -- Wait, AGG vs AAA.
      // Pos 0: A vs A (Same)
      // Pos 1: A vs G. Mutant: AGA (Arg). AAA (Lys). Differs -> NonSyn.
      // Pos 2: A vs G. Mutant: AAG (Lys). AAA (Lys). Same -> Syn.
      
      // So we expect 1 NonSyn and 1 Syn count.
      
      const res = calculateSelectionPressure("AAA", "AGG", 3);
      // dN and dS should both be > 0 (after JC correction)
      // Raw counts: Nd=1, Sd=1.
      expect(res.windows[0].dN).toBeGreaterThan(0);
      expect(res.windows[0].dS).toBeGreaterThan(0);
    });
  });

  describe("Promoter Detection", () => {
    test("Detects Sigma70 with valid spacing", () => {
      // -35 (TTGACA) ... 17bp ... -10 (TATAAT)
      const seq = "NNNNTTGACANNNNNNNNNNNNNNNNNTATAATNNNNNN";
      const hits = detectPromoters(seq);
      const sigma70 = hits.find(h => h.motif === 'σ70');
      expect(sigma70).toBeDefined();
    });

    test("Rejects Sigma70 with invalid spacing", () => {
      // -35 ... 10bp ... -10 (Too close)
      const seq = "NNNNTTGACANNNNNNNNNNTATAATNNNNNN";
      const hits = detectPromoters(seq);
      const sigma70 = hits.find(h => h.motif === 'σ70');
      // Might find 'σ70 (-10 only)' if score is high enough, but not combined
      if (sigma70) {
          expect(sigma70.motif).not.toBe('σ70'); // Should be -10 only or different
      }
    });
  });
});
