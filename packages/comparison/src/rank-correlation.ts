/**
 * Rank Correlation Metrics Module
 *
 * Implements Spearman's rho, Kendall's tau, and Hoeffding's D
 * for comparing frequency distributions (e.g., codon usage).
 *
 * These non-parametric measures are robust to outliers and
 * can detect monotonic (Spearman, Kendall) and non-linear (Hoeffding)
 * relationships between variables.
 *
 * References:
 * - Spearman (1904) "The Proof and Measurement of Association"
 * - Kendall (1938) "A New Measure of Rank Correlation"
 * - Hoeffding (1948) "A Non-Parametric Test of Independence"
 */

import type { RankCorrelationMetrics, CorrelationStrength } from './types';

/**
 * Compute ranks for an array of values.
 * Handles ties using average rank method.
 */
export function computeRanks(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ value: v, index: i }));

  // Sort by value
  indexed.sort((a, b) => a.value - b.value);

  // Assign ranks (handling ties with average)
  const ranks = new Array<number>(n);
  let i = 0;

  while (i < n) {
    let j = i;
    // Find all tied values
    while (j < n && indexed[j].value === indexed[i].value) {
      j++;
    }

    // Average rank for tied group
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = avgRank;
    }

    i = j;
  }

  return ranks;
}

/**
 * Compute Spearman's rank correlation coefficient (rho).
 *
 * ρ = 1 - (6 * Σd²) / (n * (n² - 1))
 *
 * where d is the difference between ranks.
 * Handles ties using Pearson correlation on ranks.
 *
 * Range: [-1, 1] where 1 = perfect positive correlation
 */
export function spearmanRho(x: number[], y: number[]): number {
  if (x.length !== y.length) {
    throw new Error('Arrays must have same length');
  }

  const n = x.length;
  if (n < 2) return 0;

  const ranksX = computeRanks(x);
  const ranksY = computeRanks(y);

  // Check for ties - if no ties, use simplified formula
  const hasTiesX = new Set(ranksX).size !== n;
  const hasTiesY = new Set(ranksY).size !== n;

  if (!hasTiesX && !hasTiesY) {
    // No ties: use classic formula
    let sumD2 = 0;
    for (let i = 0; i < n; i++) {
      const d = ranksX[i] - ranksY[i];
      sumD2 += d * d;
    }
    return 1 - (6 * sumD2) / (n * (n * n - 1));
  }

  // With ties: compute Pearson correlation on ranks
  return pearsonCorrelation(ranksX, ranksY);
}

/**
 * Compute Pearson correlation coefficient.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  // Compute means
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  // Compute covariance and standard deviations
  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Compute Kendall's tau-b correlation coefficient.
 *
 * τ = (nc - nd) / sqrt((n0 - n1) * (n0 - n2))
 *
 * where:
 * - nc = number of concordant pairs
 * - nd = number of discordant pairs
 * - n0 = n(n-1)/2 (total pairs)
 * - n1, n2 = ties in x, y
 *
 * Range: [-1, 1] where 1 = perfect agreement in rankings
 */
export function kendallTau(x: number[], y: number[]): number {
  if (x.length !== y.length) {
    throw new Error('Arrays must have same length');
  }

  const n = x.length;
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  let tiesBoth = 0;

  // Compare all pairs
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];

      if (dx === 0 && dy === 0) {
        tiesBoth++;
      } else if (dx === 0) {
        tiesX++;
      } else if (dy === 0) {
        tiesY++;
      } else if ((dx > 0 && dy > 0) || (dx < 0 && dy < 0)) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }

  const n0 = (n * (n - 1)) / 2;
  const denom = Math.sqrt((n0 - tiesX - tiesBoth) * (n0 - tiesY - tiesBoth));

  return denom > 0 ? (concordant - discordant) / denom : 0;
}

/**
 * Compute Hoeffding's D statistic.
 *
 * Hoeffding's D measures the difference between the joint distribution
 * and the product of marginal distributions. Unlike Spearman/Kendall,
 * it can detect non-monotonic dependence.
 *
 * Range: [-0.5, 1] where:
 * - 1 = perfect dependence
 * - 0 = independence
 * - Negative values are rare, indicate certain joint ranks
 */
export function hoeffdingD(x: number[], y: number[]): number {
  if (x.length !== y.length) {
    throw new Error('Arrays must have same length');
  }

  const n = x.length;
  if (n < 5) return 0; // Need at least 5 observations

  // Compute ranks
  const ranksX = computeRanks(x);
  const ranksY = computeRanks(y);

  // Compute Q, R (bivariate rank)
  let D1 = 0;
  let D2 = 0;
  let D3 = 0;

  for (let i = 0; i < n; i++) {
    // Count pairs with both ranks <= current observation's ranks
    let qi = 0;
    for (let j = 0; j < n; j++) {
      if (ranksX[j] < ranksX[i] && ranksY[j] < ranksY[i]) {
        qi++;
      }
    }

    // Adjusted ranks
    const ri = ranksX[i];
    const si = ranksY[i];

    D1 += qi * (qi - 1);
    D2 += (ri - 1) * (ri - 2) * (si - 1) * (si - 2);
    D3 += (ri - 2) * (si - 2) * qi;
  }

  // Hoeffding's D formula (simplified)
  const n1 = n - 1;
  const n2 = n - 2;
  const n3 = n - 3;
  const n4 = n - 4;

  const A = D1 - (2 * (n - 2) * D3 + D2) / n1;
  const B = n * n1 * n2 * n3 * n4 / 120;

  return B > 0 ? (A + n * n2 * n3) / B : 0;
}

/**
 * Approximate p-value for Spearman's rho using t-distribution.
 *
 * t = ρ * sqrt((n-2) / (1-ρ²))
 *
 * For large n (>20), this is quite accurate.
 */
export function spearmanPValue(rho: number, n: number): number {
  if (n < 3) return 1;
  if (Math.abs(rho) >= 1) return 0;

  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  const df = n - 2;

  // Approximate using Student's t CDF
  return 2 * studentTCdf(-Math.abs(t), df);
}

/**
 * Approximate p-value for Kendall's tau using normal approximation.
 *
 * Z = τ * sqrt(9 * n * (n-1) / (2 * (2n + 5)))
 */
export function kendallPValue(tau: number, n: number): number {
  if (n < 3) return 1;
  if (Math.abs(tau) >= 1) return 0;

  const variance = (2 * (2 * n + 5)) / (9 * n * (n - 1));
  const z = tau / Math.sqrt(variance);

  // Two-tailed p-value using normal CDF
  return 2 * normalCdf(-Math.abs(z));
}

/**
 * Student's t cumulative distribution function (approximation).
 */
function studentTCdf(t: number, df: number): number {
  // Use normal approximation for large df
  if (df > 100) {
    return normalCdf(t);
  }

  // Regularized incomplete beta function approximation
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

/**
 * Standard normal CDF (approximation).
 */
function normalCdf(z: number): number {
  // Abramowitz and Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

/**
 * Incomplete beta function (approximation).
 */
function incompleteBeta(x: number, a: number, b: number): number {
  // Simple approximation using continued fraction
  if (x < 0 || x > 1) return 0;

  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta);

  if (x < (a + 1) / (a + b + 2)) {
    return bt * betaCf(x, a, b) / a;
  } else {
    return 1 - bt * betaCf(1 - x, b, a) / b;
  }
}

/**
 * Continued fraction for incomplete beta.
 */
function betaCf(x: number, a: number, b: number): number {
  const maxIterations = 100;
  const epsilon = 1e-10;

  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < epsilon) d = epsilon;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;

    // Even step
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < epsilon) d = epsilon;
    c = 1 + aa / c;
    if (Math.abs(c) < epsilon) c = epsilon;
    d = 1 / d;
    h *= d * c;

    // Odd step
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < epsilon) d = epsilon;
    c = 1 + aa / c;
    if (Math.abs(c) < epsilon) c = epsilon;
    d = 1 / d;
    const del = d * c;
    h *= del;

    if (Math.abs(del - 1) < epsilon) break;
  }

  return h;
}

/**
 * Log gamma function (Stirling's approximation).
 */
function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953
  ];

  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);

  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    ser += c[j] / ++y;
  }

  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/**
 * Interpret correlation strength.
 */
export function interpretCorrelation(r: number): CorrelationStrength {
  const abs = Math.abs(r);
  if (abs >= 0.9999) return 'perfect';
  if (abs >= 0.9) return 'very_strong';
  if (abs >= 0.7) return 'strong';
  if (abs >= 0.5) return 'moderate';
  if (abs >= 0.3) return 'weak';
  return 'negligible';
}

/**
 * Perform complete rank correlation analysis.
 */
export function analyzeRankCorrelation(
  x: number[],
  y: number[]
): RankCorrelationMetrics {
  const n = x.length;

  const rho = spearmanRho(x, y);
  const tau = kendallTau(x, y);
  const d = hoeffdingD(x, y);

  return {
    spearmanRho: rho,
    spearmanPValue: spearmanPValue(rho, n),
    kendallTau: tau,
    kendallPValue: kendallPValue(tau, n),
    hoeffdingD: d,
    spearmanStrength: interpretCorrelation(rho),
    kendallStrength: interpretCorrelation(tau),
  };
}

/**
 * Compare two frequency distributions using all rank correlation metrics.
 * Useful for comparing codon usage, k-mer frequencies, etc.
 */
export function compareFrequencyDistributions(
  freqsA: Map<string, number>,
  freqsB: Map<string, number>
): RankCorrelationMetrics {
  // Get union of all keys
  const allKeys = new Set([...freqsA.keys(), ...freqsB.keys()]);
  const keys = Array.from(allKeys);

  // Build paired arrays
  const x = keys.map(k => freqsA.get(k) ?? 0);
  const y = keys.map(k => freqsB.get(k) ?? 0);

  return analyzeRankCorrelation(x, y);
}
