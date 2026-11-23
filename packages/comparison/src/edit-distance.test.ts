import { expect, test, describe } from "bun:test";
import {
  levenshteinDistance,
  approximateLevenshtein,
  levenshteinWithOperations,
  normalizedLevenshtein,
  levenshteinSimilarity,
  hammingDistance,
  percentIdentity,
  longestCommonSubsequence,
  lcsSimilarity,
  analyzeEditDistance,
  quickSimilarityEstimate,
} from "./edit-distance";

describe("levenshteinDistance", () => {
  test("calculates distance correctly", () => {
    expect(levenshteinDistance("kitten", "sitting").distance).toBe(3);
    expect(levenshteinDistance("flaw", "lawn").distance).toBe(2);
    expect(levenshteinDistance("", "abc").distance).toBe(3);
    expect(levenshteinDistance("abc", "").distance).toBe(3);
  });

  test("handles identical strings", () => {
    expect(levenshteinDistance("hello", "hello").distance).toBe(0);
  });

  test("handles long strings (likely Rust path)", () => {
    const a = "A".repeat(1000) + "C";
    const b = "A".repeat(1000) + "G";
    expect(levenshteinDistance(a, b).distance).toBe(1);
  });

  test("handles empty strings", () => {
    expect(levenshteinDistance("", "").distance).toBe(0);
  });

  test("handles single character differences", () => {
    expect(levenshteinDistance("a", "b").distance).toBe(1);
    expect(levenshteinDistance("a", "").distance).toBe(1);
    expect(levenshteinDistance("", "a").distance).toBe(1);
  });

  test("swaps shorter string for optimization", () => {
    // Should produce same result regardless of order
    const a = "short";
    const b = "this is much longer";
    expect(levenshteinDistance(a, b).distance).toBe(levenshteinDistance(b, a).distance);
  });
});

describe("approximateLevenshtein", () => {
  test("returns approximate result for long sequences", () => {
    const a = "ACGT".repeat(5000);
    const b = "ACGT".repeat(5000);
    const result = approximateLevenshtein(a, b, 1000, 20);

    expect(result.isApproximate).toBe(true);
    expect(result.windowSize).toBe(1000);
    expect(result.windowCount).toBeGreaterThan(0);
  });

  test("handles sequences with differences", () => {
    const a = "ACGT".repeat(3000);
    const b = "TGCA".repeat(3000);
    const result = approximateLevenshtein(a, b, 1000, 10);

    expect(result.isApproximate).toBe(true);
    expect(result.distance).toBeGreaterThan(0);
  });

  test("handles length differences", () => {
    const a = "A".repeat(5000);
    const b = "A".repeat(6000);
    const result = approximateLevenshtein(a, b, 1000, 10);

    // Distance should include the length difference
    expect(result.distance).toBeGreaterThanOrEqual(1000);
  });

  test("handles invalid windowSize", () => {
    const a = "ACGT".repeat(1000);
    const b = "ACGT".repeat(1000);
    const result = approximateLevenshtein(a, b, 0, 10); // Invalid windowSize

    // Should default to 1000
    expect(result.windowSize).toBe(1000);
  });

  test("falls back to exact for short sequences", () => {
    const a = "ACGT";
    const b = "TGCA";
    const result = approximateLevenshtein(a, b, 1000, 10);

    // Short sequences trigger fallback
    expect(result.windowCount).toBe(1);
  });
});

describe("levenshteinWithOperations", () => {
  test("counts operations correctly for simple cases", () => {
    // "kitten" -> "sitting": 3 operations (s->k, e->i, +g)
    const result = levenshteinWithOperations("kitten", "sitting");
    expect(result.distance).toBe(3);
    expect(result.insertions! + result.deletions! + result.substitutions!).toBe(3);
  });

  test("handles pure insertions", () => {
    const result = levenshteinWithOperations("", "abc");
    expect(result.distance).toBe(3);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(0);
    expect(result.substitutions).toBe(0);
  });

  test("handles pure deletions", () => {
    const result = levenshteinWithOperations("abc", "");
    expect(result.distance).toBe(3);
    expect(result.deletions).toBe(3);
    expect(result.insertions).toBe(0);
    expect(result.substitutions).toBe(0);
  });

  test("handles pure substitutions", () => {
    const result = levenshteinWithOperations("abc", "xyz");
    expect(result.distance).toBe(3);
    expect(result.substitutions).toBe(3);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
  });

  test("handles identical strings", () => {
    const result = levenshteinWithOperations("hello", "hello");
    expect(result.distance).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.substitutions).toBe(0);
  });

  test("uses approximate method for long sequences", () => {
    const a = "ACGT".repeat(2000);
    const b = "TGCA".repeat(2000);
    const result = levenshteinWithOperations(a, b, 1000);

    expect(result.distance).toBeGreaterThan(0);
    // Window distances cannot establish a whole-sequence operation breakdown.
    expect(result.insertions).toBeNull();
    expect(result.deletions).toBeNull();
    expect(result.substitutions).toBeNull();
    expect(result.operationsUnavailableReason).toContain('exact alignment');
  });

  test("rolling operation counts agree with an independent full-matrix traceback", () => {
    const strings = [''];
    for (let length = 1; length <= 4; length++) {
      for (let value = 0; value < 2 ** length; value++) {
        strings.push(value.toString(2).padStart(length, '0').replaceAll('0', 'A').replaceAll('1', 'C'));
      }
    }
    for (const a of strings) for (const b of strings) {
      const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
      }
      let i = a.length, j = b.length, insertions = 0, deletions = 0, substitutions = 0;
      while (i || j) {
        if (i && j && matrix[i][j] === matrix[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1])) {
          substitutions += Number(a[i - 1] !== b[j - 1]); i--; j--;
        } else if (j && matrix[i][j] === matrix[i][j - 1] + 1) { insertions++; j--; }
        else { deletions++; i--; }
      }
      const result = levenshteinWithOperations(a, b);
      expect(result).toEqual({ distance: matrix[a.length][b.length], insertions, deletions, substitutions,
        isApproximate: false, operationsUnavailableReason: null });
      expect(result.insertions! - result.deletions!).toBe(b.length - a.length);
      expect(result.insertions! + result.deletions! + result.substitutions!).toBe(result.distance);
    }
  });

  test("preserves exact operation counts across repeated rolling-row reuse", () => {
    // This uses the generic string path, independent of the DNA wavefront.
    // The answer follows from a single trailing insertion; the rolling rows
    // must still retain exact counts when repeatedly reusing their buffers.
    const a = 'ab'.repeat(2500), b = a + 'z';
    expect(levenshteinWithOperations(a, b, 6000)).toEqual({
      distance: 1, insertions: 1, deletions: 0, substitutions: 0,
      isApproximate: false, operationsUnavailableReason: null,
    });
  });
});

describe("normalizedLevenshtein", () => {
  test("returns 0 for identical strings", () => {
    expect(normalizedLevenshtein("hello", "hello")).toBe(0);
  });

  test("returns 1 for completely different equal-length strings", () => {
    expect(normalizedLevenshtein("abc", "xyz")).toBe(1);
  });

  test("handles empty strings", () => {
    expect(normalizedLevenshtein("", "")).toBe(0);
    expect(normalizedLevenshtein("abc", "")).toBe(1);
    expect(normalizedLevenshtein("", "abc")).toBe(1);
  });

  test("returns value between 0 and 1", () => {
    const result = normalizedLevenshtein("kitten", "sitting");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("is symmetric", () => {
    const a = "hello";
    const b = "world";
    expect(normalizedLevenshtein(a, b)).toBe(normalizedLevenshtein(b, a));
  });
});

describe("levenshteinSimilarity", () => {
  test("returns 1 for identical strings", () => {
    expect(levenshteinSimilarity("hello", "hello")).toBe(1);
  });

  test("returns 0 for completely different equal-length strings", () => {
    expect(levenshteinSimilarity("abc", "xyz")).toBe(0);
  });

  test("is inverse of normalizedLevenshtein", () => {
    const a = "kitten";
    const b = "sitting";
    const normalized = normalizedLevenshtein(a, b);
    const similarity = levenshteinSimilarity(a, b);
    expect(similarity).toBeCloseTo(1 - normalized, 10);
  });
});

describe("hammingDistance", () => {
  test("counts character differences", () => {
    expect(hammingDistance("karolin", "kathrin")).toBe(3);
    expect(hammingDistance("1011101", "1001001")).toBe(2);
  });

  test("returns 0 for identical strings", () => {
    expect(hammingDistance("hello", "hello")).toBe(0);
  });

  test("throws error for unequal length strings", () => {
    expect(() => hammingDistance("abc", "abcd")).toThrow("Hamming distance requires equal-length strings");
  });

  test("handles empty strings", () => {
    expect(hammingDistance("", "")).toBe(0);
  });
});

describe("percentIdentity", () => {
  test("returns 100 for identical strings", () => {
    expect(percentIdentity("hello", "hello")).toBe(100);
  });

  test("returns 0 for completely different strings", () => {
    expect(percentIdentity("abc", "xyz")).toBe(0);
  });

  test("handles different lengths", () => {
    // "abc" vs "abcd": 3 matches out of 4 positions
    const result = percentIdentity("abc", "abcd");
    expect(result).toBe(75);
  });

  test("is case insensitive", () => {
    expect(percentIdentity("ABC", "abc")).toBe(100);
    expect(percentIdentity("Hello", "HELLO")).toBe(100);
  });

  test("handles empty strings", () => {
    expect(percentIdentity("", "")).toBe(100);
    expect(percentIdentity("abc", "")).toBe(0);
    expect(percentIdentity("", "abc")).toBe(0);
  });

  test("penalizes length difference", () => {
    // "ab" vs "abcd": 2 matches out of 4 max length = 50%
    expect(percentIdentity("ab", "abcd")).toBe(50);
  });
});

describe("longestCommonSubsequence", () => {
  test("finds LCS for simple cases", () => {
    expect(longestCommonSubsequence("ABCDGH", "AEDFHR")).toBe(3); // ADH
    expect(longestCommonSubsequence("AGGTAB", "GXTXAYB")).toBe(4); // GTAB
  });

  test("returns 0 for no common characters", () => {
    expect(longestCommonSubsequence("ABC", "XYZ")).toBe(0);
  });

  test("returns full length for identical strings", () => {
    expect(longestCommonSubsequence("hello", "hello")).toBe(5);
  });

  test("handles empty strings", () => {
    expect(longestCommonSubsequence("", "abc")).toBe(0);
    expect(longestCommonSubsequence("abc", "")).toBe(0);
    expect(longestCommonSubsequence("", "")).toBe(0);
  });

  test("handles single characters", () => {
    expect(longestCommonSubsequence("A", "A")).toBe(1);
    expect(longestCommonSubsequence("A", "B")).toBe(0);
  });

  test("uses approximation for long sequences", () => {
    const a = "ACGT".repeat(3000);
    const b = "ACGT".repeat(3000);
    const result = longestCommonSubsequence(a, b, 1000);

    // Should find common subsequence
    expect(result).toBeGreaterThan(0);
  });
});

describe("lcsSimilarity", () => {
  test("returns 1 for identical strings", () => {
    expect(lcsSimilarity("hello", "hello")).toBe(1);
  });

  test("returns 0 for no common characters", () => {
    expect(lcsSimilarity("ABC", "XYZ")).toBe(0);
  });

  test("handles empty strings", () => {
    expect(lcsSimilarity("", "")).toBe(1);
  });

  test("returns value between 0 and 1", () => {
    const result = lcsSimilarity("ABCDGH", "AEDFHR");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("analyzeEditDistance", () => {
  test("returns complete metrics structure", () => {
    const result = analyzeEditDistance("kitten", "sitting");

    expect(result).toHaveProperty("levenshteinDistance");
    expect(result).toHaveProperty("normalizedLevenshtein");
    expect(result).toHaveProperty("levenshteinSimilarity");
    expect(result).toHaveProperty("insertions");
    expect(result).toHaveProperty("deletions");
    expect(result).toHaveProperty("substitutions");
    expect(result).toHaveProperty("isApproximate");
  });

  test("calculates correct values for short sequences", () => {
    const result = analyzeEditDistance("abc", "xyz");

    expect(result.levenshteinDistance).toBe(3);
    expect(result.normalizedLevenshtein).toBe(1);
    expect(result.levenshteinSimilarity).toBe(0);
    expect(result.isApproximate).toBe(false);
  });

  test("uses approximate method for long sequences", () => {
    const a = "ACGT".repeat(3000);
    const b = "TGCA".repeat(3000);
    const result = analyzeEditDistance(a, b, { maxExactLength: 1000 });

    expect(result.isApproximate).toBe(true);
    expect(result.windowSize).toBeDefined();
    expect(result.windowCount).toBeDefined();
  });

  test("handles identical sequences", () => {
    const result = analyzeEditDistance("hello", "hello");

    expect(result.levenshteinDistance).toBe(0);
    expect(result.normalizedLevenshtein).toBe(0);
    expect(result.levenshteinSimilarity).toBe(1);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.substitutions).toBe(0);
  });

  test("respects config options", () => {
    const a = "ACGT".repeat(3000);
    const b = "ACGT".repeat(3000);
    const result = analyzeEditDistance(a, b, {
      maxExactLength: 5000,
      windowSize: 500,
      windowCount: 5,
    });

    expect(result.isApproximate).toBe(true);
  });

  test("never fabricates operation counts from sampled distance or violates its length lower bound", () => {
    const a = 'A'.repeat(12000), b = 'A'.repeat(16000);
    for (const [reference, query] of [[a, b], [b, a]]) {
      const result = analyzeEditDistance(reference, query, { windowSize: 100, windowCount: 3 });
      expect(result.levenshteinDistance).toBe(4000);
      expect(result.levenshteinDistance).toBeGreaterThanOrEqual(Math.abs(reference.length - query.length));
      expect(result).toMatchObject({ insertions: null, deletions: null, substitutions: null, isApproximate: true });
      expect(result.operationsUnavailableReason).toContain('total distance only');
    }
  });

  test("sampling a short query does not silently expand into an unbounded full comparison", () => {
    const result = approximateLevenshtein('A'.repeat(900), 'A'.repeat(100000), 1000, 20);
    expect(result).toEqual({ distance: 99100, isApproximate: true, windowSize: 900, windowCount: 1 });
    expect(approximateLevenshtein('', 'A'.repeat(100000))).toMatchObject({ distance: 100000, windowCount: 0 });
  });

  test("changing the exact limit preserves explicit sampling and exposes counts only for exact work", () => {
    for (const maxExactLength of [0, 4, 8, 9, 10]) {
      const result = analyzeEditDistance('AAAACCCC', 'AAAAGCCCC', { maxExactLength, windowSize: 2, windowCount: 2 });
      expect(result.isApproximate).toBe(maxExactLength < 9);
      if (maxExactLength < 9) {
        expect(result.insertions).toBeNull(); expect(result.deletions).toBeNull(); expect(result.substitutions).toBeNull();
        expect(result.levenshteinDistance).toBeGreaterThanOrEqual(1);
      } else {
        expect(result).toMatchObject({ levenshteinDistance: 1, insertions: 1, deletions: 0, substitutions: 0,
          operationsUnavailableReason: null });
      }
    }
  });
});

describe("quickSimilarityEstimate", () => {
  test("returns 1 for identical strings", () => {
    const result = quickSimilarityEstimate("hello", "hello");
    expect(result).toBeCloseTo(1, 1);
  });

  test("returns low value for very different length strings", () => {
    const result = quickSimilarityEstimate("a", "abcdefghij");
    expect(result).toBeLessThan(0.5);
  });

  test("handles short strings with percentIdentity", () => {
    const a = "abc";
    const b = "abc";
    const result = quickSimilarityEstimate(a, b, 1000, 10);
    expect(result).toBe(1);
  });

  test("returns value between 0 and 1", () => {
    const result = quickSimilarityEstimate("ACGTACGT", "TGCATGCA");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("uses sampling for long sequences", () => {
    const a = "ACGT".repeat(500);
    const b = "ACGT".repeat(500);
    const result = quickSimilarityEstimate(a, b, 100, 5);

    // Similar sequences should have high similarity
    expect(result).toBeGreaterThan(0.8);
  });
});
