/// <reference lib="webworker" />

import * as Comlink from 'comlink';
import {
  scanForAnomalies,
  computeDinucleotideFrequencies,
  computeCodonFrequencies,
} from '@phage-explorer/core';

type MetricName =
  | 'gcContent'
  | 'gcSkew'
  | 'atSkew'
  | 'entropy'
  | 'klDivergence'
  | 'compressionRatio'
  | 'dinucDeviation'
  | 'codonBias';

interface MetricSeries {
  gcContent: number[];
  gcSkew: number[];
  atSkew: number[];
  entropy: number[];
  klDivergence: number[];
  compressionRatio: number[];
  dinucDeviation: number[];
  codonBias: number[];
}

export interface AnomalyDriver {
  metric: MetricName;
  z: number;
}

export interface AnomalyWindow {
  start: number;
  end: number;
  score: number;
  type: 'composition' | 'low-complexity' | 'coding' | 'mixed';
  zScores: Record<MetricName, number>;
  drivers: AnomalyDriver[];
}

export interface AnomalyHeatmap {
  rows: number;
  cols: number;
  values: Float32Array;
  min: number;
  max: number;
  metricLabels: MetricName[];
}

export interface AnomalyScatterPoint {
  x: number;
  y: number;
  score: number;
  windowIndex: number;
}

export interface AnomalyScatter {
  points: AnomalyScatterPoint[];
  explained: [number, number];
}

export interface AnomalySummary {
  threshold: number;
  anomalies: number;
  metrics: MetricName[];
  windowSize: number;
  stepSize: number;
  genomeLength: number;
  topRegions: AnomalyWindow[];
}

export interface AnomalyWorkerResult {
  windows: AnomalyWindow[];
  heatmap: AnomalyHeatmap;
  scatter: AnomalyScatter;
  summary: AnomalySummary;
}

export interface AnomalyWorkerAPI {
  analyze(
    sequence: string,
    options?: { windowSize?: number; stepSize?: number }
  ): Promise<AnomalyWorkerResult>;
}

const METRICS: MetricName[] = [
  'gcContent',
  'gcSkew',
  'atSkew',
  'entropy',
  'klDivergence',
  'compressionRatio',
  'dinucDeviation',
  'codonBias',
];

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function std(values: number[], avg: number): number {
  if (values.length < 2) return 1;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 1e-9));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

function entropy(seq: string): number {
  if (!seq.length) return 0;
  const counts: Record<string, number> = { A: 0, C: 0, G: 0, T: 0 };
  for (const ch of seq) {
    if (counts[ch] !== undefined) counts[ch] += 1;
  }
  const total = seq.length || 1;
  let h = 0;
  for (const value of Object.values(counts)) {
    const p = value / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h; // 0..2 for DNA alphabet
}

function skews(seq: string): { gc: number; at: number } {
  let g = 0, c = 0, a = 0, t = 0;
  for (const ch of seq) {
    if (ch === 'G') g++;
    else if (ch === 'C') c++;
    else if (ch === 'A') a++;
    else if (ch === 'T') t++;
  }
  const gcTotal = g + c || 1;
  const atTotal = a + t || 1;
  return {
    gc: (g - c) / gcTotal,
    at: (a - t) / atTotal,
  };
}

function l2Distance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum / Math.max(1, len));
}

function pca2d(matrix: number[][]): { coords: [number, number][]; explained: [number, number] } {
  if (!matrix.length || matrix[0]?.length === 0) {
    return { coords: [], explained: [0, 0] };
  }

  const rows = matrix.length;
  const dims = matrix[0].length;

  const means = Array(dims).fill(0);
  for (const row of matrix) {
    for (let i = 0; i < dims; i++) means[i] += row[i];
  }
  for (let i = 0; i < dims; i++) means[i] /= rows;

  const centered = matrix.map(row => row.map((v, i) => v - means[i]));

  const cov = Array.from({ length: dims }, () => Array(dims).fill(0));
  for (const row of centered) {
    for (let i = 0; i < dims; i++) {
      for (let j = 0; j < dims; j++) {
        cov[i][j] += row[i] * row[j];
      }
    }
  }
  const denom = Math.max(1, rows - 1);
  for (let i = 0; i < dims; i++) {
    for (let j = 0; j < dims; j++) {
      cov[i][j] /= denom;
    }
  }

  const powerIteration = (mat: number[][], iterations = 48): { vec: number[]; val: number } => {
    let v = Array(mat.length).fill(1 / Math.sqrt(Math.max(1, mat.length)));
    const multiply = (vec: number[]) =>
      mat.map(row => row.reduce((sum, val, idx) => sum + val * vec[idx], 0));

    for (let i = 0; i < iterations; i++) {
      const w = multiply(v);
      const norm = Math.hypot(...w) || 1;
      v = w.map(x => x / norm);
    }
    const Av = multiply(v);
    const val = v.reduce((sum, vi, idx) => sum + vi * Av[idx], 0);
    return { vec: v, val };
  };

  const { vec: pc1, val: val1 } = powerIteration(cov);
  const covDeflated = cov.map((row, i) =>
    row.map((c, j) => c - val1 * pc1[i] * pc1[j])
  );
  const { vec: pc2, val: val2 } = powerIteration(covDeflated);

  const coords = centered.map(row => {
    const x = row.reduce((s, v, i) => s + v * pc1[i], 0);
    const y = row.reduce((s, v, i) => s + v * pc2[i], 0);
    return [x, y] as [number, number];
  });

  const totalVar = cov.reduce((sum, row, i) => sum + row[i], 0) || 1;
  return {
    coords,
    explained: [Math.abs(val1) / totalVar, Math.abs(val2) / totalVar],
  };
}

function classifyWindow(z: Record<MetricName, number>): 'composition' | 'low-complexity' | 'coding' | 'mixed' {
  if ((z.compressionRatio ?? 0) > 2 || (z.entropy ?? 0) < -1) return 'low-complexity';
  if ((z.klDivergence ?? 0) > 2.2 || (z.dinucDeviation ?? 0) > 2) return 'composition';
  if ((z.codonBias ?? 0) > 1.8 || (z.gcSkew ?? 0) > 2) return 'coding';
  return 'mixed';
}

async function analyze(
  sequence: string,
  windowSize = 500,
  stepSize = 250
): Promise<AnomalyWorkerResult> {
  const clean = sequence.toUpperCase().replace(/[^ACGT]/g, '');
  if (clean.length < windowSize) {
    const emptyValues = new Float32Array();
    const empty: AnomalyWorkerResult = {
      windows: [],
      heatmap: {
        rows: 0,
        cols: METRICS.length,
        values: emptyValues,
        min: -3,
        max: 3,
        metricLabels: METRICS,
      },
      scatter: { points: [], explained: [0, 0] },
      summary: {
        threshold: 0,
        anomalies: 0,
        metrics: METRICS,
        windowSize,
        stepSize,
        genomeLength: clean.length,
        topRegions: [],
      },
    };
    return empty;
  }

  const scan = scanForAnomalies(clean, windowSize, stepSize, 4);
  const globalDinuc = computeDinucleotideFrequencies(clean);
  const globalCodon = computeCodonFrequencies(clean);

  const metricSeries: MetricSeries = {
    gcContent: [],
    gcSkew: [],
    atSkew: [],
    entropy: [],
    klDivergence: [],
    compressionRatio: [],
    dinucDeviation: [],
    codonBias: [],
  };

  const windows: AnomalyWindow[] = [];
  const zMatrix: number[][] = [];

  const segments = scan.windows.map((w) => ({
    start: w.position,
    end: Math.min(clean.length, w.position + windowSize),
  }));

  for (let i = 0; i < segments.length; i++) {
    const { start, end } = segments[i];
    const windowSeq = clean.slice(start, end);
    const { gc, at } = skews(windowSeq);
    const gcContent = (windowSeq.match(/[GC]/g)?.length ?? 0) / Math.max(1, windowSeq.length);
    const dinuc = computeDinucleotideFrequencies(windowSeq);
    const codon = computeCodonFrequencies(windowSeq);

    metricSeries.gcContent.push(gcContent);
    metricSeries.gcSkew.push(gc);
    metricSeries.atSkew.push(at);
    metricSeries.entropy.push(entropy(windowSeq));
    metricSeries.klDivergence.push(scan.windows[i]?.klDivergence ?? 0);
    metricSeries.compressionRatio.push(scan.windows[i]?.compressionRatio ?? 0);
    metricSeries.dinucDeviation.push(l2Distance(dinuc, globalDinuc));
    metricSeries.codonBias.push(l2Distance(codon, globalCodon));
  }

  const stats: Record<MetricName, { mean: number; std: number }> = {} as never;
  const zScores: Record<MetricName, number[]> = {} as never;
  METRICS.forEach((metric) => {
    const avg = mean(metricSeries[metric]);
    const deviation = std(metricSeries[metric], avg);
    stats[metric] = { mean: avg, std: deviation };
    zScores[metric] = metricSeries[metric].map(v => (v - avg) / deviation);
  });

  const scores: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const zRecord: Record<MetricName, number> = {} as never;
    METRICS.forEach((metric) => {
      zRecord[metric] = zScores[metric][i] ?? 0;
    });
    const absMean =
      METRICS.reduce((sum, metric) => sum + Math.abs(zRecord[metric]), 0) / METRICS.length;
    const baseScore = (absMean / 3) * 100;

    // Add a small boost for windows that exceed IQR on multiple metrics
    const extremeCount = METRICS.filter(metric => Math.abs(zRecord[metric]) > 2.5).length;
    const score = clampScore(baseScore + extremeCount * 2);

    const drivers = METRICS
      .map(metric => ({ metric, z: zRecord[metric] }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .slice(0, 3);

    const windowEntry: AnomalyWindow = {
      start: segments[i].start,
      end: segments[i].end,
      score,
      type: classifyWindow(zRecord),
      zScores: zRecord,
      drivers,
    };
    scores.push(score);
    windows.push(windowEntry);
    zMatrix.push(METRICS.map(metric => zRecord[metric]));
  }

  const threshold = clampScore(Math.max(60, quantile(scores, 0.85)));
  const anomalies = windows.filter(w => w.score >= threshold).length;

  const heatValues = new Float32Array(windows.length * METRICS.length);
  for (let r = 0; r < windows.length; r++) {
    for (let c = 0; c < METRICS.length; c++) {
      const z = zMatrix[r]?.[c] ?? 0;
      heatValues[r * METRICS.length + c] = Math.max(-3, Math.min(3, z));
    }
  }

  const { coords, explained } = pca2d(zMatrix);
  const scatterPoints: AnomalyScatterPoint[] = coords.map((coord, idx) => ({
    x: coord[0],
    y: coord[1],
    score: scores[idx] ?? 0,
    windowIndex: idx,
  }));

  const topRegions = [...windows].sort((a, b) => b.score - a.score).slice(0, 5);

  const result: AnomalyWorkerResult = {
    windows,
    heatmap: {
      rows: windows.length,
      cols: METRICS.length,
      values: heatValues,
      min: -3,
      max: 3,
      metricLabels: METRICS,
    },
    scatter: {
      points: scatterPoints,
      explained,
    },
    summary: {
      threshold,
      anomalies,
      metrics: METRICS,
      windowSize,
      stepSize,
      genomeLength: clean.length,
      topRegions,
    },
  };

  return Comlink.transfer(result, [heatValues.buffer]);
}

const api: AnomalyWorkerAPI = {
  async analyze(sequence, options) {
    const windowSize = options?.windowSize ?? 500;
    const stepSize = options?.stepSize ?? 250;
    return analyze(sequence, windowSize, stepSize);
  },
};

Comlink.expose(api);


