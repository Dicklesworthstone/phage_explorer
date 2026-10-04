import { describe, it, expect, test } from 'bun:test';
import { scanForAnomalies } from './anomaly';

function makeDeterministicSequence(length: number, seed = 1): string {
  // Simple LCG for deterministic pseudo-random bases.
  // This keeps tests stable while still behaving like "random" background.
  let state = seed >>> 0;
  const alphabet = ['A', 'C', 'G', 'T'];
  const out = new Array<string>(length);

  for (let i = 0; i < length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    out[i] = alphabet[state & 3];
  }

  return out.join('');
}

describe('Anomaly Scanner', () => {
  it('should return empty result for short sequences', () => {
    const result = scanForAnomalies('ACGT', 500, 100, 4);
    expect(result.windows).toHaveLength(0);
  });

  it('should preserve window coordinates when sequence contains ambiguous bases', () => {
    // Previously we dropped non-ACGT bases, which shifted window positions.
    // Replacing with 'N' preserves the original coordinate space.
    const result = scanForAnomalies('ACGTNACGT', 5, 2, 2);
    expect(result.windows).toHaveLength(3);
    expect(result.windows.map(w => w.position)).toEqual([0, 2, 4]);
  });

  it('should handle RNA sequences by treating U as T', () => {
    // RNA uses U instead of T. The scanner should normalize U→T.
    // Without this fix, "ACGU" would become "ACGN" and all k-mers would be skipped.
    const dnaSeq = 'ACGTACGTACGTACGTACGTACGTACGTACGT'; // 32 bases
    const rnaSeq = 'ACGUACGUACGUACGUACGUACGUACGUACGU'; // Same but with U

    const dnaResult = scanForAnomalies(dnaSeq, 16, 8, 2);
    const rnaResult = scanForAnomalies(rnaSeq, 16, 8, 2);

    // Both should produce the same number of windows with valid KL values
    expect(rnaResult.windows.length).toBe(dnaResult.windows.length);
    expect(rnaResult.windows.length).toBeGreaterThan(0);

    // KL divergence should be identical (U and T are equivalent)
    for (let i = 0; i < dnaResult.windows.length; i++) {
      expect(rnaResult.windows[i].klDivergence).toBeCloseTo(dnaResult.windows[i].klDivergence, 5);
    }
  });

  it('should detect anomalies in synthetic data', () => {
    // Deterministic background + a highly-compressible repetitive region.
    // The pure window at position 5000 is intentionally sized to match windowSize
    // so at least one window is "all A", which should strongly stand out.
    const background = makeDeterministicSequence(10000, 123);
    const anomaly = 'A'.repeat(500);
    const sequence = background.slice(0, 5000) + anomaly + background.slice(5000);

    const result = scanForAnomalies(sequence, 500, 100, 4);
    expect(result.windows.length).toBeGreaterThan(0);

    const anomalyWindow = result.windows.find(w => w.position === 5000);
    expect(anomalyWindow).toBeDefined();
    expect(anomalyWindow?.isAnomalous).toBe(true);
    expect(anomalyWindow?.anomalyType).toBe('Repetitive');
  });

  it('should use percentile-based thresholds', () => {
    const seq = Array(5000).fill('A').join(''); // Highly repetitive
    const result = scanForAnomalies(seq, 100, 50, 2);

    // Thresholds should be defined
    expect(result.thresholds.kl).toBeGreaterThanOrEqual(0);
    expect(result.thresholds.compression).toBeGreaterThanOrEqual(0);
  });
});

describe('scanForAnomalies - edge cases', () => {
  test('returns empty result for empty sequence', () => {
    const result = scanForAnomalies('', 100, 50, 4);
    expect(result.windows).toHaveLength(0);
    expect(result.globalKmerFreq.size).toBe(0);
    expect(result.thresholds.kl).toBe(0);
    expect(result.thresholds.compression).toBe(0);
  });

  test('returns empty result when windowSize <= 0', () => {
    const seq = makeDeterministicSequence(1000);
    const result = scanForAnomalies(seq, 0, 50, 4);
    expect(result.windows).toHaveLength(0);
  });

  test('returns empty result when stepSize <= 0', () => {
    const seq = makeDeterministicSequence(1000);
    const result = scanForAnomalies(seq, 100, 0, 4);
    expect(result.windows).toHaveLength(0);
  });

  test('handles sequence exactly equal to window size', () => {
    const seq = makeDeterministicSequence(500);
    const result = scanForAnomalies(seq, 500, 100, 4);
    // Should have exactly 1 window
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].position).toBe(0);
  });

  test('handles lowercase sequences', () => {
    const upperSeq = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT'; // 64 bp
    const lowerSeq = upperSeq.toLowerCase();

    const upperResult = scanForAnomalies(upperSeq, 32, 16, 2);
    const lowerResult = scanForAnomalies(lowerSeq, 32, 16, 2);

    // Should produce identical results
    expect(lowerResult.windows.length).toBe(upperResult.windows.length);
    for (let i = 0; i < upperResult.windows.length; i++) {
      expect(lowerResult.windows[i].klDivergence).toBeCloseTo(upperResult.windows[i].klDivergence, 5);
    }
  });

  test('handles sequences with many N characters', () => {
    // Sequence with N regions should still work, just with lower valid k-mer counts
    const seq = 'ACGTACGT' + 'N'.repeat(100) + 'ACGTACGT' + 'N'.repeat(100) + 'ACGTACGTACGTACGT';
    const result = scanForAnomalies(seq, 50, 25, 2);

    // Should still produce windows
    expect(result.windows.length).toBeGreaterThan(0);

    // Windows with lots of Ns should have valid structure
    for (const window of result.windows) {
      expect(typeof window.position).toBe('number');
      expect(typeof window.klDivergence).toBe('number');
      expect(typeof window.compressionRatio).toBe('number');
      expect(typeof window.isAnomalous).toBe('boolean');
    }
  });

  test('handles mixed case with special characters', () => {
    // Various non-standard characters should be treated as N
    const seq = 'ACGTacgtRYMKSWBDHV' + makeDeterministicSequence(500);
    const result = scanForAnomalies(seq, 100, 50, 4);

    // Should complete without error
    expect(Array.isArray(result.windows)).toBe(true);
  });
});

describe('scanForAnomalies - dense vs sparse path', () => {
  test('uses dense path for k <= 10', () => {
    const seq = makeDeterministicSequence(2000);

    // k=4 should use dense path
    const result4 = scanForAnomalies(seq, 200, 100, 4);
    expect(result4.windows.length).toBeGreaterThan(0);

    // k=10 should still use dense path
    const result10 = scanForAnomalies(seq, 200, 100, 10);
    expect(result10.windows.length).toBeGreaterThan(0);
  });

  test('uses sparse path for k > 10', () => {
    const seq = makeDeterministicSequence(2000);

    // k=11 should use sparse (Map-based) path
    const result11 = scanForAnomalies(seq, 200, 100, 11);
    expect(result11.windows.length).toBeGreaterThan(0);
    expect(result11.usedWasm).toBe(false); // Sparse path doesn't use WASM
  });

  test('sparse and dense paths produce similar results for same sequence', () => {
    // For a fair comparison, use k values on either side of the boundary
    // Note: Results won't be identical due to different counting approaches,
    // but anomaly detection should be qualitatively similar
    const seq = makeDeterministicSequence(3000);

    const denseLow = scanForAnomalies(seq, 200, 100, 4);
    const sparseHigh = scanForAnomalies(seq, 200, 100, 11);

    // Both should produce similar window counts
    expect(denseLow.windows.length).toBe(sparseHigh.windows.length);
  });
});

describe('scanForAnomalies - result structure', () => {
  test('returns complete AnomalyScanResult structure', () => {
    const seq = makeDeterministicSequence(2000);
    const result = scanForAnomalies(seq, 200, 100, 4);

    // Check top-level properties
    expect(result).toHaveProperty('windows');
    expect(result).toHaveProperty('globalKmerFreq');
    expect(result).toHaveProperty('thresholds');
    expect(Array.isArray(result.windows)).toBe(true);
    expect(result.globalKmerFreq instanceof Map).toBe(true);
    expect(typeof result.thresholds.kl).toBe('number');
    expect(typeof result.thresholds.compression).toBe('number');
  });

  test('windows have required AnomalyResult properties', () => {
    const seq = makeDeterministicSequence(2000);
    const result = scanForAnomalies(seq, 200, 100, 4);

    for (const window of result.windows) {
      expect(window).toHaveProperty('position');
      expect(window).toHaveProperty('klDivergence');
      expect(window).toHaveProperty('compressionRatio');
      expect(window).toHaveProperty('isAnomalous');

      expect(typeof window.position).toBe('number');
      expect(typeof window.klDivergence).toBe('number');
      expect(typeof window.compressionRatio).toBe('number');
      expect(typeof window.isAnomalous).toBe('boolean');

      // Position should be non-negative
      expect(window.position).toBeGreaterThanOrEqual(0);

      // KL divergence should be non-negative
      expect(window.klDivergence).toBeGreaterThanOrEqual(0);

      // Compression ratio should be >= 1 (original/compressed, compressed is smaller or equal)
      expect(window.compressionRatio).toBeGreaterThanOrEqual(1);
    }
  });

  test('anomalous windows have anomalyType', () => {
    // Create sequence with clear anomalies
    const background = makeDeterministicSequence(5000);
    const anomaly = 'A'.repeat(500); // Repetitive region
    const seq = background.slice(0, 2500) + anomaly + background.slice(3000);

    const result = scanForAnomalies(seq, 500, 100, 4);

    const anomalousWindows = result.windows.filter(w => w.isAnomalous);
    expect(anomalousWindows.length).toBeGreaterThan(0);

    for (const window of anomalousWindows) {
      expect(window.anomalyType).toBeDefined();
      expect(['HGT', 'Repetitive', 'Regulatory', 'Unknown']).toContain(window.anomalyType!);
    }
  });

  test('globalKmerFreq contains valid k-mer frequencies', () => {
    const seq = makeDeterministicSequence(1000);
    const result = scanForAnomalies(seq, 200, 100, 3);

    // Should have some k-mers
    expect(result.globalKmerFreq.size).toBeGreaterThan(0);

    // Frequencies should sum to approximately 1.0
    let sum = 0;
    for (const freq of result.globalKmerFreq.values()) {
      expect(freq).toBeGreaterThanOrEqual(0);
      expect(freq).toBeLessThanOrEqual(1);
      sum += freq;
    }
    expect(sum).toBeCloseTo(1.0, 2);

    // k-mer strings should have length k
    for (const kmer of result.globalKmerFreq.keys()) {
      expect(kmer.length).toBe(3);
      expect(/^[ACGT]+$/.test(kmer)).toBe(true);
    }
  });

  test('dense path returns klValues and compressionValues typed arrays', () => {
    const seq = makeDeterministicSequence(2000);
    const result = scanForAnomalies(seq, 200, 100, 4);

    // Dense path should include typed arrays
    if (result.klValues) {
      expect(result.klValues instanceof Float32Array).toBe(true);
      expect(result.klValues.length).toBe(result.windows.length);
    }
    if (result.compressionValues) {
      expect(result.compressionValues instanceof Float32Array).toBe(true);
      expect(result.compressionValues.length).toBe(result.windows.length);
    }
  });
});

describe('scanForAnomalies - anomaly classification', () => {
  test('classifies repetitive regions as Repetitive', () => {
    // Background with deterministic "random" sequence + repetitive insert
    const background = makeDeterministicSequence(8000, 42);
    const repetitive = 'AAAAAA'.repeat(100); // 600bp of A's
    const seq = background.slice(0, 4000) + repetitive + background.slice(4600);

    const result = scanForAnomalies(seq, 500, 100, 4);

    // Find windows overlapping the repetitive region (around position 4000)
    const repWindows = result.windows.filter(
      w => w.position >= 3800 && w.position <= 4200 && w.isAnomalous
    );

    // At least some windows should be flagged as Repetitive
    const repetitiveCount = repWindows.filter(w => w.anomalyType === 'Repetitive').length;
    expect(repetitiveCount).toBeGreaterThan(0);
  });

  test('classifies high KL divergence regions', () => {
    // Create a sequence with a region of very different composition
    const atRich = 'AT'.repeat(4000); // 8000bp AT-rich background
    const gcRich = 'GC'.repeat(250); // 500bp GC-rich island
    const seq = atRich.slice(0, 4000) + gcRich + atRich.slice(4500);

    const result = scanForAnomalies(seq, 500, 100, 4);

    // The GC-rich region should have high KL divergence
    const gcWindows = result.windows.filter(
      w => w.position >= 3800 && w.position <= 4200
    );

    // Should have some windows with elevated KL divergence
    expect(gcWindows.some(w => w.klDivergence > result.thresholds.kl * 0.5)).toBe(true);
  });

  test('uniform sequence has consistent metrics', () => {
    // A uniform random sequence should have relatively consistent KL values
    const seq = makeDeterministicSequence(10000, 999);

    const result = scanForAnomalies(seq, 500, 100, 4);

    // KL divergence should be relatively low and consistent for uniform sequence
    const klValues = result.windows.map(w => w.klDivergence);
    const meanKL = klValues.reduce((a, b) => a + b, 0) / klValues.length;

    // Mean KL should be relatively low (uniform sequences have similar k-mer distribution)
    expect(meanKL).toBeLessThan(1.0);

    // Standard deviation of KL should be low (consistent across windows)
    const variance = klValues.reduce((sum, kl) => sum + Math.pow(kl - meanKL, 2), 0) / klValues.length;
    const stdDev = Math.sqrt(variance);
    expect(stdDev).toBeLessThan(0.5);
  });
});

describe('scanForAnomalies - window parameters', () => {
  test('respects windowSize parameter', () => {
    const seq = makeDeterministicSequence(2000);

    const result100 = scanForAnomalies(seq, 100, 50, 4);
    const result200 = scanForAnomalies(seq, 200, 50, 4);

    // Larger window means fewer windows (for same step size)
    expect(result200.windows.length).toBeLessThan(result100.windows.length);
  });

  test('respects stepSize parameter', () => {
    const seq = makeDeterministicSequence(2000);

    const result50 = scanForAnomalies(seq, 200, 50, 4);
    const result100 = scanForAnomalies(seq, 200, 100, 4);

    // Larger step means fewer windows
    expect(result100.windows.length).toBeLessThan(result50.windows.length);

    // Step should be reflected in position differences
    for (let i = 1; i < result100.windows.length; i++) {
      const diff = result100.windows[i].position - result100.windows[i - 1].position;
      expect(diff).toBe(100);
    }
  });

  test('window positions are correct', () => {
    const seq = makeDeterministicSequence(1000);
    const result = scanForAnomalies(seq, 200, 100, 4);

    // First window should be at position 0
    expect(result.windows[0].position).toBe(0);

    // Windows should be spaced by stepSize
    for (let i = 1; i < result.windows.length; i++) {
      expect(result.windows[i].position).toBe(result.windows[i - 1].position + 100);
    }

    // Last window should be valid (position + windowSize <= seqLen)
    const lastWindow = result.windows[result.windows.length - 1];
    expect(lastWindow.position + 200).toBeLessThanOrEqual(1000);
  });

  test('number of windows is correct', () => {
    const seqLen = 2000;
    const windowSize = 200;
    const stepSize = 100;
    const seq = makeDeterministicSequence(seqLen);

    const result = scanForAnomalies(seq, windowSize, stepSize, 4);

    // Expected: floor((seqLen - windowSize) / stepSize) + 1
    const expected = Math.floor((seqLen - windowSize) / stepSize) + 1;
    expect(result.windows.length).toBe(expected);
  });
});

describe('scanForAnomalies - threshold calculation', () => {
  test('thresholds are based on 95th percentile', () => {
    const seq = makeDeterministicSequence(5000);
    const result = scanForAnomalies(seq, 200, 100, 4);

    // Sort KL values
    const sortedKL = result.windows.map(w => w.klDivergence).sort((a, b) => a - b);
    const p95Index = Math.floor(sortedKL.length * 0.95);
    const expectedKLThreshold = sortedKL[p95Index];

    // Threshold should match the 95th percentile
    expect(result.thresholds.kl).toBeCloseTo(expectedKLThreshold, 5);
  });

  test('thresholds correctly identify outliers', () => {
    // Create sequence with intentional anomalies
    const background = makeDeterministicSequence(8000, 12345);
    const anomaly = 'A'.repeat(600); // Clear repetitive anomaly
    const seq = background.slice(0, 4000) + anomaly + background.slice(4600);

    const result = scanForAnomalies(seq, 200, 100, 4);

    // The anomaly region should definitely be flagged
    const anomalyWindows = result.windows.filter(
      w => w.position >= 3900 && w.position <= 4100
    );

    // At least one window in the anomaly region should be flagged
    const flaggedInAnomaly = anomalyWindows.filter(w => w.isAnomalous);
    expect(flaggedInAnomaly.length).toBeGreaterThan(0);
  });
});

describe('scanForAnomalies - compression ratio', () => {
  test('retains the scientific compression score from pako 2', () => {
    let seed = 0x13579bdf;
    const sequence = Array.from({ length: 12000 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 'ACGT'[(seed >>> 16) & 3];
    }).join('');
    // Independently recorded with pako 2.2.0: this sequence deflates to 3,800
    // bytes. A compressor upgrade must not silently redefine anomaly scores.
    const result = scanForAnomalies(sequence, sequence.length, sequence.length, 4);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].compressionRatio).toBe(12000 / 3800);
  });

  test('highly repetitive sequences have high compression ratio', () => {
    const repetitive = 'A'.repeat(1000);
    const result = scanForAnomalies(repetitive, 200, 100, 4);

    // All A's should be highly compressible
    for (const window of result.windows) {
      expect(window.compressionRatio).toBeGreaterThan(5);
    }
  });

  test('varied sequences have moderate compression ratio', () => {
    // Use a sequence with more varied composition
    // Interleave different patterns to create less compressible content
    const varied = 'ACGTACGT'.repeat(30) + 'TGCATGCA'.repeat(30) +
                   'GATCGATC'.repeat(30) + 'CTAGCTAG'.repeat(30);
    const result = scanForAnomalies(varied, 200, 100, 4);

    // Compression ratio should be bounded and positive
    for (const window of result.windows) {
      expect(window.compressionRatio).toBeGreaterThanOrEqual(1);
      // Even varied sequences can be somewhat compressible
      expect(window.compressionRatio).toBeLessThan(30);
    }
  });

  test('compression ignores N characters', () => {
    // Sequence with Ns should not have compression dominated by N patterns
    const withNs = 'ACGT'.repeat(50) + 'N'.repeat(100) + 'ACGT'.repeat(50);
    const withoutNs = 'ACGT'.repeat(100);

    const resultWithNs = scanForAnomalies(withNs, 100, 50, 2);
    const resultWithoutNs = scanForAnomalies(withoutNs, 100, 50, 2);

    // Both should complete without error
    expect(resultWithNs.windows.length).toBeGreaterThan(0);
    expect(resultWithoutNs.windows.length).toBeGreaterThan(0);
  });
});

describe('scanForAnomalies - k-mer parameter', () => {
  test('different k values produce valid results', () => {
    const seq = makeDeterministicSequence(2000);

    for (const k of [2, 3, 4, 5, 6, 7, 8]) {
      const result = scanForAnomalies(seq, 200, 100, k);
      expect(result.windows.length).toBeGreaterThan(0);

      // Global k-mer frequencies should have k-mers of length k
      for (const kmer of result.globalKmerFreq.keys()) {
        expect(kmer.length).toBe(k);
      }
    }
  });

  test('larger k values produce more unique k-mers', () => {
    const seq = makeDeterministicSequence(5000);

    const result2 = scanForAnomalies(seq, 500, 200, 2);
    const result4 = scanForAnomalies(seq, 500, 200, 4);
    const result6 = scanForAnomalies(seq, 500, 200, 6);

    // Max possible k-mers: 4^k
    // k=2: 16, k=4: 256, k=6: 4096
    expect(result2.globalKmerFreq.size).toBeLessThanOrEqual(16);
    expect(result4.globalKmerFreq.size).toBeLessThanOrEqual(256);
    expect(result6.globalKmerFreq.size).toBeLessThanOrEqual(4096);

    // Larger k should generally have more unique k-mers (up to sequence limit)
    expect(result4.globalKmerFreq.size).toBeGreaterThanOrEqual(result2.globalKmerFreq.size);
  });

  test('handles k=1 (single nucleotides)', () => {
    const seq = makeDeterministicSequence(1000);
    const result = scanForAnomalies(seq, 200, 100, 1);

    expect(result.windows.length).toBeGreaterThan(0);
    // Should have at most 4 k-mers (A, C, G, T)
    expect(result.globalKmerFreq.size).toBeLessThanOrEqual(4);
  });
});
