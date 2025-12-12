/**
 * DotPlot Worker - Self-similarity matrix computation
 *
 * Computes dot plot comparing genome against itself to reveal
 * repeats, palindromes, and internal duplications.
 */

import { computeDotPlot, type DotPlotResult, type DotPlotConfig } from '@phage-explorer/core';

interface DotPlotJob {
  sequence: string;
  config?: DotPlotConfig;
}

interface DotPlotWorkerResponse {
  ok: boolean;
  result?: DotPlotResult;
  // Pre-flattened for HeatmapCanvas
  directValues?: Float32Array;
  invertedValues?: Float32Array;
  bins?: number;
  window?: number;
  error?: string;
}

self.onmessage = (event: MessageEvent<DotPlotJob>) => {
  const job = event.data;
  const response: DotPlotWorkerResponse = { ok: false };

  try {
    if (!job || !job.sequence || job.sequence.length === 0) {
      throw new Error('No sequence provided for dot plot');
    }

    const result = computeDotPlot(job.sequence, job.config);

    // Flatten grids for HeatmapCanvas
    const bins = result.bins;
    const directValues = new Float32Array(bins * bins);
    const invertedValues = new Float32Array(bins * bins);

    for (let i = 0; i < bins; i++) {
      for (let j = 0; j < bins; j++) {
        const idx = i * bins + j;
        directValues[idx] = result.grid[i][j].direct;
        invertedValues[idx] = result.grid[i][j].inverted;
      }
    }

    response.ok = true;
    response.result = result;
    response.directValues = directValues;
    response.invertedValues = invertedValues;
    response.bins = bins;
    response.window = result.window;

    // Transfer ArrayBuffers for efficiency
    const transferList: Transferable[] = [directValues.buffer, invertedValues.buffer];
    (self as any).postMessage(response, transferList);
    return;
  } catch (err) {
    console.error('DotPlot worker error:', err);
    response.error = err instanceof Error ? err.message : 'Dot plot computation failed';
  }

  (self as any).postMessage(response);
};
