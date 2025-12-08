import { describe, it, expect } from 'bun:test';
import { scanForAnomalies } from './anomaly';

describe('Anomaly Scanner', () => {
  it('should return empty result for short sequences', () => {
    const result = scanForAnomalies('ACGT', 500, 100, 4);
    expect(result.windows).toHaveLength(0);
  });

  it('should detect anomalies in synthetic data', () => {
    // Generate a sequence with a distinct anomaly
    // Background: random ACGT
    const bg = Array(10000).fill(0).map(() => 'ACGT'[Math.floor(Math.random() * 4)]).join('');
    
    // Anomaly: GC-rich region (should have high KL vs uniform background)
    const anomaly = Array(500).fill(0).map(() => 'GC'[Math.floor(Math.random() * 2)]).join('');
    
    const sequence = bg.slice(0, 5000) + anomaly + bg.slice(5000);
    
    const result = scanForAnomalies(sequence, 500, 100, 3);
    
    expect(result.windows.length).toBeGreaterThan(0);
    
    // Find the window corresponding to the anomaly (approx index 50)
    // 5000 / 100 = 50
    const anomalousWindow = result.windows.find(w => w.position >= 5000 && w.position < 5500);
    
    // It should have higher KL than average
    const avgKL = result.windows.reduce((sum, w) => sum + w.klDivergence, 0) / result.windows.length;
    
    // Note: Random background isn't perfectly uniform, but GC block is very different
    // We expect the anomaly to be flagged
    const anomalies = result.windows.filter(w => w.isAnomalous);
    expect(anomalies.length).toBeGreaterThan(0);
    
    if (anomalousWindow) {
      expect(anomalousWindow.klDivergence).toBeGreaterThan(avgKL);
    }
  });

  it('should use percentile-based thresholds', () => {
    const seq = Array(5000).fill('A').join(''); // Highly repetitive
    const result = scanForAnomalies(seq, 100, 50, 2);
    
    // Thresholds should be defined
    expect(result.thresholds.kl).toBeGreaterThanOrEqual(0);
    expect(result.thresholds.compression).toBeGreaterThanOrEqual(0);
  });
});