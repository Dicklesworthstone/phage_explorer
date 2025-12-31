/**
 * DotPlot Worker - Self-similarity matrix computation
 *
 * Computes dot plot comparing genome against itself to reveal
 * repeats, palindromes, and internal duplications.
 */

import { computeDotPlot } from '@phage-explorer/core';
import type { DotPlotJob, DotPlotWorkerResponse, SequenceBytesRef } from './types';
import { getWasmCompute } from '../lib/wasm-loader';

let activeJobId = 0;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function decodeAsciiBytes(bytes: Uint8Array): string {
  if (textDecoder) return textDecoder.decode(bytes);

  const CHUNK = 0x2000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

function getSequenceBytesView(ref: SequenceBytesRef): Uint8Array {
  const view = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
  return ref.length < view.length ? view.subarray(0, ref.length) : view;
}

function getSequenceBytesForWasm(job: DotPlotJob): Uint8Array | null {
  if ('sequenceRef' in job && job.sequenceRef) {
    // WASM kernel expects ASCII bytes.
    if (job.sequenceRef.encoding !== 'ascii') return null;
    return getSequenceBytesView(job.sequenceRef);
  }

  if ('sequence' in job) {
    if (!textEncoder) return null;
    return textEncoder.encode(job.sequence);
  }

  return null;
}

/**
 * Fallback: compute dotplot using dotplot_self_buffers (one-shot, no handle reuse).
 */
async function tryComputeDotPlotWasm(
  job: DotPlotJob,
  bins: number,
  window: number
): Promise<{ directValues: Float32Array; invertedValues: Float32Array; bins: number; window: number } | null> {
  const wasm = await getWasmCompute();
  if (!wasm || typeof wasm.dotplot_self_buffers !== 'function') return null;

  const seqBytes = getSequenceBytesForWasm(job);
  if (!seqBytes) return null;

  const result = wasm.dotplot_self_buffers(seqBytes, bins, window);
  try {
    return {
      directValues: result.direct,
      invertedValues: result.inverted,
      bins: result.bins,
      window: result.window,
    };
  } finally {
    // wasm-bindgen object owns heap memory; always free.
    result.free();
  }
}

function decodeSequenceRef(ref: SequenceBytesRef): string {
  const view = getSequenceBytesView(ref);

  if (ref.encoding === 'ascii') {
    return decodeAsciiBytes(view);
  }

  // Temporary compatibility path for callers that already have encoded bases.
  // This still constructs a JS string because core `computeDotPlot` is string-based.
  const out = new Uint8Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const code = view[i] ?? 4;
    out[i] =
      code === 0 ? 65 : // A
      code === 1 ? 67 : // C
      code === 2 ? 71 : // G
      code === 3 ? 84 : // T
      78;              // N
  }
  return decodeAsciiBytes(out);
}

self.onmessage = async (event: MessageEvent<DotPlotJob>) => {
  const job = event.data as DotPlotJob | null | undefined;
  const jobId = ++activeJobId;

  try {
    if (!job || typeof job !== 'object') {
      const response: DotPlotWorkerResponse = { ok: false, error: 'Invalid dot plot job: missing data' };
      (self as any).postMessage(response);
      return;
    }

    const requestedBins = job.config?.bins;
    const configBins = typeof requestedBins === 'number' && Number.isFinite(requestedBins) ? requestedBins : 120;
    const targetBins = Math.max(1, Math.floor(configBins));
    const previewBins = targetBins >= 80 ? 40 : 0;
    const useProgressiveRefinement = previewBins > 0 && previewBins < targetBins;

    const requestedWindow = job.config?.window;
    const targetWindow = typeof requestedWindow === 'number' && Number.isFinite(requestedWindow) && requestedWindow > 0 ? Math.floor(requestedWindow) : 0;

    // Try using SequenceHandle for efficient progressive refinement.
    // This encodes the sequence once and reuses it for both preview and full resolution.
    if (useProgressiveRefinement) {
      const wasm = await getWasmCompute();
      const seqBytes = getSequenceBytesForWasm(job);

      if (wasm && seqBytes && typeof wasm.SequenceHandle === 'function') {
        const handle = new wasm.SequenceHandle(seqBytes);
        try {
          // Preview pass
          if (jobId === activeJobId) {
            const previewResult = handle.dotplot_self(previewBins, targetWindow);
            try {
              if (jobId === activeJobId) {
                const response: DotPlotWorkerResponse = {
                  ok: true,
                  directValues: previewResult.direct,
                  invertedValues: previewResult.inverted,
                  bins: previewResult.bins,
                  window: previewResult.window,
                };
                (self as any).postMessage(response, [previewResult.direct.buffer, previewResult.inverted.buffer]);
              }
            } finally {
              previewResult.free();
            }
          }

          // Full resolution pass
          if (jobId === activeJobId) {
            const fullResult = handle.dotplot_self(targetBins, targetWindow);
            try {
              if (jobId === activeJobId) {
                const response: DotPlotWorkerResponse = {
                  ok: true,
                  directValues: fullResult.direct,
                  invertedValues: fullResult.inverted,
                  bins: fullResult.bins,
                  window: fullResult.window,
                };
                (self as any).postMessage(response, [fullResult.direct.buffer, fullResult.inverted.buffer]);
              }
            } finally {
              fullResult.free();
            }
          }
          return; // Successfully used SequenceHandle path
        } finally {
          handle.free();
        }
      }
    }

    // Fallback: single-shot WASM or JS implementation
    const computeAndPost = async (bins: number): Promise<void> => {
      if (jobId !== activeJobId) return;

      const response: DotPlotWorkerResponse = { ok: false };
      const wasmResult = await tryComputeDotPlotWasm(job, bins, targetWindow);

      if (jobId !== activeJobId) return;

      if (wasmResult) {
        response.ok = true;
        response.directValues = wasmResult.directValues;
        response.invertedValues = wasmResult.invertedValues;
        response.bins = wasmResult.bins;
        response.window = wasmResult.window;

        const transferList: Transferable[] = [
          wasmResult.directValues.buffer,
          wasmResult.invertedValues.buffer,
        ];
        (self as any).postMessage(response, transferList);
        return;
      }

      // Fallback: existing JS implementation (string-based).
      const sequence =
        'sequence' in job
          ? job.sequence
          : job.sequenceRef
            ? decodeSequenceRef(job.sequenceRef)
            : '';

      if (!sequence || sequence.length === 0) {
        throw new Error('No sequence provided for dot plot');
      }

      const result = computeDotPlot(sequence, {
        ...(job.config ?? {}),
        bins,
        window: targetWindow > 0 ? targetWindow : undefined,
      });
      const outBins = result.bins;
      const directValues = new Float32Array(outBins * outBins);
      const invertedValues = new Float32Array(outBins * outBins);

      for (let i = 0; i < outBins; i++) {
        for (let j = 0; j < outBins; j++) {
          const idx = i * outBins + j;
          directValues[idx] = result.grid[i][j].direct;
          invertedValues[idx] = result.grid[i][j].inverted;
        }
      }

      response.ok = true;
      response.directValues = directValues;
      response.invertedValues = invertedValues;
      response.bins = outBins;
      response.window = result.window;

      const transferList: Transferable[] = [directValues.buffer, invertedValues.buffer];
      (self as any).postMessage(response, transferList);
    };

    // Progressive refinement fallback (non-SequenceHandle path)
    if (useProgressiveRefinement) {
      await computeAndPost(previewBins);
    }

    await computeAndPost(targetBins);
    return;
  } catch (err) {
    const response: DotPlotWorkerResponse = { ok: false };
    if (import.meta.env.DEV) {
      console.error('DotPlot worker error:', err);
    }
    response.error = err instanceof Error ? err.message : 'Dot plot computation failed';
    (self as any).postMessage(response);
    return;
  }
};
