import { CANONICAL_GROWTH_CURVES } from './packages/core/src/analysis/burst-kinetics';

function erf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function normalCdf(x: number, mean: number, std: number): number {
  return 0.5 * (1.0 + erf((x - mean) / (Math.max(0.1, std) * Math.SQRT2)));
}

const t4 = CANONICAL_GROWTH_CURVES.t4_ecoli;
const p0 = t4.defaultP0; // 1e7
const L = 24.0;
const sigma = 3.5;
const b = 138;

console.log('T4 Fit:');
let sse = 0;
for (const pt of t4.data) {
  // Sigmoidal rise centered at L + 1.5 * sigma
  const frac = normalCdf(pt.timeMin, L + 1.6 * sigma, sigma);
  const pred = p0 * (1 + (b - 1) * frac);
  const diff = Math.log10(pt.value) - Math.log10(pred);
  sse += diff * diff;
  console.log(`t=${pt.timeMin} obs=${pt.value} pred=${Math.round(pred)} diff=${diff.toFixed(3)}`);
}
console.log('Total Log-SSE:', sse, 'R2 approx:', 1 - sse / 15.0);

const pak = CANONICAL_GROWTH_CURVES.pseudomonas_pak_p1;
const od0 = pak.data[0].value;
const Lpak = 32.0;
const sigmapak = 6.0;
const mu = 0.015;
console.log('\nPAK P1 Fit:');
let ssePak = 0;
for (const pt of pak.data) {
  const frac = normalCdf(pt.timeMin, Lpak + 1.2 * sigmapak, sigmapak);
  const growth = Math.exp(mu * pt.timeMin);
  const unlysedFrac = Math.max(0.08, 1.0 - 0.92 * frac);
  const pred = od0 * growth * unlysedFrac;
  const diff = pt.value - pred;
  ssePak += diff * diff;
  console.log(`t=${pt.timeMin} obs=${pt.value} pred=${pred.toFixed(3)} diff=${diff.toFixed(3)}`);
}
console.log('PAK SSE:', ssePak);
