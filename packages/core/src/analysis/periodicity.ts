export type PeriodicityEncoding = 'gc' | 'purine';

export interface PeriodicitySpectrum {
  encoding: PeriodicityEncoding;
  genomeLength: number;
  windowSize: number;
  stepSize: number;
  minPeriod: number;
  maxPeriod: number;
  /** Row labels (period in bp) */
  periods: number[];
  /** Column labels (window start in bp) */
  windowStarts: number[];
  /** Row-major values, length = rows * cols, in [0..1] */
  values: Float32Array;
  rows: number;
  cols: number;
  min: number;
  max: number;
}

export interface PeriodicitySummaryPeriod {
  period: number;
  meanScore: number;
  maxScore: number;
  label?: string;
}

export interface PeriodicityRepeatCandidate {
  period: number;
  start: number;
  end: number;
  peakScore: number;
  label?: string;
}

export interface PeriodicityAnalysis {
  spectrum: PeriodicitySpectrum;
  topPeriods: PeriodicitySummaryPeriod[];
  candidates: PeriodicityRepeatCandidate[];
}

export interface PeriodicityConfig {
  encoding?: PeriodicityEncoding;
  windowSize?: number;
  stepSize?: number;
  minPeriod?: number;
  maxPeriod?: number;
  /** Correlations with fewer than this many valid (non-ambiguous) pairs become 0. */
  minValidPairs?: number;
  /** Window peak score threshold for repeat candidate extraction. */
  candidateThreshold?: number;
  maxTopPeriods?: number;
  maxCandidates?: number;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function periodLabel(period: number): string | undefined {
  if (period === 3) return 'Codon periodicity (3 bp)';
  if (period >= 10 && period <= 11) return 'DNA helix pitch (~10–11 bp)';
  if (period >= 33 && period <= 38) return 'Promoter spacing-ish (~35 bp)';
  if (period >= 2 && period <= 6) return 'Short tandem repeat';
  if (period >= 15 && period <= 20) return 'Protein-binding spacing-ish (~15–20 bp)';
  return undefined;
}

function encodeSequence(sequenceUpper: string, encoding: PeriodicityEncoding): Int8Array {
  const out = new Int8Array(sequenceUpper.length);
  for (let i = 0; i < sequenceUpper.length; i++) {
    const c = sequenceUpper[i] ?? '';
    switch (encoding) {
      case 'gc': {
        if (c === 'G' || c === 'C') out[i] = 1;
        else if (c === 'A' || c === 'T' || c === 'U') out[i] = -1;
        else out[i] = 0;
        break;
      }
      case 'purine': {
        if (c === 'A' || c === 'G') out[i] = 1;
        else if (c === 'C' || c === 'T' || c === 'U') out[i] = -1;
        else out[i] = 0;
        break;
      }
    }
  }
  return out;
}

export function analyzePeriodicity(sequence: string, config: PeriodicityConfig = {}): PeriodicityAnalysis {
  const seq = (sequence ?? '').toUpperCase();
  const genomeLength = seq.length;

  const encoding = config.encoding ?? 'purine';
  const requestedWindowSize = config.windowSize ?? 2048;
  const windowSize = genomeLength > 0 ? clampInt(requestedWindowSize, 64, genomeLength) : 0;
  const stepSize = windowSize > 0
    ? clampInt(config.stepSize ?? Math.max(1, Math.floor(windowSize / 4)), 1, windowSize)
    : 0;
  const minPeriod = clampInt(config.minPeriod ?? 2, 1, 1_000_000);
  const maxPeriodRequested = clampInt(config.maxPeriod ?? 80, minPeriod, 1_000_000);
  const minValidPairs = clampInt(config.minValidPairs ?? 128, 1, 1_000_000);
  const candidateThreshold = Math.max(0, Math.min(1, config.candidateThreshold ?? 0.65));
  const maxTopPeriods = clampInt(config.maxTopPeriods ?? 10, 1, 1000);
  const maxCandidates = clampInt(config.maxCandidates ?? 12, 0, 1000);

  if (genomeLength === 0 || windowSize === 0 || stepSize === 0) {
    const emptySpectrum: PeriodicitySpectrum = {
      encoding,
      genomeLength,
      windowSize: 0,
      stepSize: 0,
      minPeriod,
      maxPeriod: maxPeriodRequested,
      periods: [],
      windowStarts: [],
      values: new Float32Array(),
      rows: 0,
      cols: 0,
      min: 0,
      max: 1,
    };
    return { spectrum: emptySpectrum, topPeriods: [], candidates: [] };
  }

  const maxPeriod = Math.min(maxPeriodRequested, Math.max(minPeriod, windowSize - 1));
  const rows = Math.max(0, maxPeriod - minPeriod + 1);

  const windowStarts: number[] = [];
  const maxStart = Math.max(0, genomeLength - windowSize);
  for (let start = 0; start <= maxStart; start += stepSize) {
    windowStarts.push(start);
  }
  if (windowStarts.length === 0) windowStarts.push(0);
  const cols = windowStarts.length;

  const periods: number[] = Array.from({ length: rows }, (_, i) => minPeriod + i);
  const values = new Float32Array(rows * cols);
  const perPeriodSum = new Float64Array(rows);
  const perPeriodMax = new Float32Array(rows);
  const bestPeriodByWindow = new Int32Array(cols);
  const bestScoreByWindow = new Float32Array(cols);

  const encoded = encodeSequence(seq, encoding);

  for (let w = 0; w < cols; w++) {
    const start = windowStarts[w] ?? 0;
    let bestScore = 0;
    let bestPeriod = minPeriod;

    for (let r = 0; r < rows; r++) {
      const lag = minPeriod + r;
      const end = start + windowSize - lag;
      let sum = 0;
      let count = 0;

      for (let i = start; i < end; i++) {
        const a = encoded[i] ?? 0;
        const b = encoded[i + lag] ?? 0;
        if (a === 0 || b === 0) continue;
        sum += a * b;
        count++;
      }

      let score = count >= minValidPairs ? sum / count : 0;
      if (score < 0) score = 0;

      const idx = r * cols + w;
      values[idx] = score;
      perPeriodSum[r] += score;
      if (score > perPeriodMax[r]) perPeriodMax[r] = score;

      if (score > bestScore || (score === bestScore && lag < bestPeriod)) {
        bestScore = score;
        bestPeriod = lag;
      }
    }

    bestPeriodByWindow[w] = bestPeriod;
    bestScoreByWindow[w] = bestScore;
  }

  const topPeriodsAll: PeriodicitySummaryPeriod[] = periods.map((period, idx) => {
    const meanScore = cols > 0 ? perPeriodSum[idx] / cols : 0;
    const maxScore = perPeriodMax[idx] ?? 0;
    return {
      period,
      meanScore,
      maxScore,
      label: periodLabel(period),
    };
  });

  topPeriodsAll.sort((a, b) => {
    const scoreA = a.meanScore * 0.7 + a.maxScore * 0.3;
    const scoreB = b.meanScore * 0.7 + b.maxScore * 0.3;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.period - b.period;
  });

  const topPeriods = topPeriodsAll.slice(0, maxTopPeriods);

  const rawCandidates: PeriodicityRepeatCandidate[] = [];
  if (maxCandidates > 0) {
    for (let w = 0; w < cols; w++) {
      const peakScore = bestScoreByWindow[w] ?? 0;
      if (peakScore < candidateThreshold) continue;
      const period = bestPeriodByWindow[w] ?? minPeriod;
      const start = windowStarts[w] ?? 0;
      rawCandidates.push({
        period,
        start,
        end: Math.min(genomeLength, start + windowSize),
        peakScore,
        label: periodLabel(period),
      });
    }
  }

  rawCandidates.sort((a, b) => (a.start - b.start) || (b.peakScore - a.peakScore));

  const candidates: PeriodicityRepeatCandidate[] = [];
  for (const cand of rawCandidates) {
    const last = candidates[candidates.length - 1];
    if (!last) {
      candidates.push({ ...cand });
      continue;
    }

    const overlaps = cand.start <= last.end;
    const similarPeriod = Math.abs(cand.period - last.period) <= 1;
    if (overlaps && similarPeriod) {
      // Merge into last
      const mergedEnd = Math.max(last.end, cand.end);
      const mergedPeak = Math.max(last.peakScore, cand.peakScore);
      const mergedPeriod = cand.peakScore > last.peakScore ? cand.period : last.period;
      last.end = mergedEnd;
      last.peakScore = mergedPeak;
      last.period = mergedPeriod;
      last.label = periodLabel(mergedPeriod);
      continue;
    }

    candidates.push({ ...cand });
    if (candidates.length >= maxCandidates) break;
  }

  const spectrum: PeriodicitySpectrum = {
    encoding,
    genomeLength,
    windowSize,
    stepSize,
    minPeriod,
    maxPeriod,
    periods,
    windowStarts,
    values,
    rows,
    cols,
    min: 0,
    max: 1,
  };

  return { spectrum, topPeriods, candidates };
}

