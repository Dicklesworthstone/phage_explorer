/** Dot-plot computation with optional acceleration, explicit evidence semantics and latest-job ownership. */
import { computeDotPlot } from '@phage-explorer/core';
import type { DotPlotJob, DotPlotWorkerResponse, SequenceBytesRef } from './types';
import { getWasmCompute } from '../lib/wasm-loader';

interface NativeBuffers {
  readonly direct: Float32Array;
  readonly inverted: Float32Array;
  readonly bins: number;
  readonly window: number;
  free(): void;
}
interface NativeHandle {
  dotplot_self(bins: number, window: number): NativeBuffers;
  free(): void;
}
interface DotPlotBackend {
  dotplot_self_buffers?: (sequence: Uint8Array, bins: number, window: number) => NativeBuffers;
  SequenceHandle?: new (sequence: Uint8Array) => NativeHandle;
}
interface DotPlotRuntime {
  postMessage: (response: DotPlotWorkerResponse, transfer: Transferable[]) => void;
  loadWasm?: () => Promise<DotPlotBackend | null>;
  yieldControl?: () => Promise<void>;
}

function decodeSequenceRef(ref: SequenceBytesRef): string {
  if (!ref || (ref.encoding !== 'ascii' && ref.encoding !== 'acgt05')) {
    throw new Error('Unsupported dot plot sequence encoding');
  }
  const bufferValid = ref.buffer instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && ref.buffer instanceof SharedArrayBuffer);
  if (!bufferValid || ![ref.byteOffset, ref.byteLength, ref.length].every(n => Number.isSafeInteger(n) && n >= 0)
      || ref.byteOffset > ref.buffer.byteLength - ref.byteLength || ref.length > ref.byteLength) {
    throw new Error('Invalid or truncated dot plot sequence reference');
  }
  const bytes = new Uint8Array(ref.buffer, ref.byteOffset, ref.length);
  // Decode one byte per base; UTF-8 decoding would silently move coordinates.
  const ascii = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (ref.encoding === 'ascii') {
      if (value > 127) throw new Error('Non-ASCII byte in dot plot ASCII sequence');
      ascii[i] = value;
    } else {
      if (value > 4) throw new Error('Invalid acgt05 base in dot plot sequence');
      ascii[i] = 'ACGTN'.charCodeAt(value);
    }
  }
  const chunks: string[] = [];
  for (let i = 0; i < ascii.length; i += 8192) chunks.push(String.fromCharCode(...ascii.subarray(i, i + 8192)));
  return chunks.join('');
}

function release(resource: { free(): void } | null): void {
  // Optional native teardown must not turn a valid JS fallback into an error.
  try { resource?.free(); } catch { /* Do not replace a computation outcome with a cleanup error. */ }
}

/** Each instance owns its request generation; tests use the same handler as the worker. */
export function createDotPlotHandler(runtime: DotPlotRuntime) {
  let activeJobId = 0;
  const loadWasm = runtime.loadWasm ?? getWasmCompute;
  const yieldControl = runtime.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));

  return async (event: Pick<MessageEvent<DotPlotJob>, 'data'>): Promise<void> => {
    const job = event.data as DotPlotJob | null | undefined;
    const jobId = ++activeJobId;
    let handle: NativeHandle | null = null;
    try {
      if (!job || typeof job !== 'object') throw new Error('Invalid dot plot job: missing data');
      if (('sequence' in job) === ('sequenceRef' in job)) throw new Error('Provide exactly one dot plot sequence source');
      const sequence = 'sequence' in job ? job.sequence : decodeSequenceRef(job.sequenceRef);
      if (typeof sequence !== 'string' || sequence.length === 0) throw new Error('No sequence provided for dot plot');

      const targetBins = job.config?.bins ?? 120;
      if (!Number.isSafeInteger(targetBins) || targetBins < 1 || targetBins > 1024) {
        throw new RangeError('Dot plot bins must be an integer between 1 and 1024');
      }
      // The worker's established window=0 sentinel still means automatic.
      const requestedWindow = job.config?.window ?? 0;
      if (!Number.isSafeInteger(requestedWindow) || requestedWindow < 0) {
        throw new RangeError('Dot plot window must be a non-negative integer');
      }
      const ambiguity = job.config?.ambiguity ?? 'exclude';
      if (ambiguity !== 'exclude' && ambiguity !== 'literal') throw new Error('Unsupported dot plot ambiguity policy');
      if (ambiguity === 'exclude' && !/[ACGT]/i.test(sequence)) throw new Error('No resolved A/C/G/T bases available for dot plot');
      const length = ambiguity === 'literal' ? sequence.toUpperCase().length : sequence.length;
      // Preview and final results must differ only in resolution, not window size.
      const window = Math.min(length, requestedWindow || Math.max(20, Math.floor(length / targetBins) || length));
      const passes = targetBins >= 80 ? [40, targetBins] : [targetBins];

      // The native literal-symbol kernel and SequenceHandle only agree with
      // resolved scoring on A/C/G/T input. Never send ambiguities through a
      // lossy native encoding or treat a successful load as semantic parity.
      let wasm: DotPlotBackend | null = null;
      let bytes: Uint8Array | null = null;
      if (/^[ACGT]+$/i.test(sequence)) {
        bytes = new Uint8Array(sequence.length);
        for (let i = 0; i < sequence.length; i++) bytes[i] = sequence.charCodeAt(i);
        try { wasm = await loadWasm(); } catch { /* Optional acceleration; compute in JS below. */ }
        if (jobId !== activeJobId) return;
        if (passes.length > 1 && wasm?.SequenceHandle) {
          try { handle = new wasm.SequenceHandle(bytes); } catch { /* One-shot/JS fallback remains available. */ }
        }
      }

      for (let pass = 0; pass < passes.length; pass++) {
        if (jobId !== activeJobId) return;
        const bins = passes[pass];
        let response: DotPlotWorkerResponse | null = null;
        if (wasm && bytes) {
          let result: NativeBuffers | null = null;
          try {
            result = handle ? handle.dotplot_self(bins, window) : wasm.dotplot_self_buffers?.(bytes, bins, window) ?? null;
            if (result) {
              // wasm-bindgen getters COPY. Read once, then transfer those exact arrays.
              const directValues = result.direct;
              const invertedValues = result.inverted;
              if (result.bins !== bins || result.window !== window
                  || !(directValues instanceof Float32Array) || !(invertedValues instanceof Float32Array)
                  || directValues.length !== bins * bins || invertedValues.length !== bins * bins
                  || !(directValues.buffer instanceof ArrayBuffer) || !(invertedValues.buffer instanceof ArrayBuffer)
                  || !directValues.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
                  || !invertedValues.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) {
                throw new Error('Invalid native dot plot result');
              }
              response = { requestId: job.requestId, ok: true, directValues, invertedValues, bins, window };
            }
          } catch {
            release(handle);
            handle = null;
            wasm = null;
          } finally {
            release(result);
          }
        }
        if (!response) {
          const result = computeDotPlot(sequence, { bins, window, ambiguity });
          const directValues = new Float32Array(bins * bins);
          const invertedValues = new Float32Array(bins * bins);
          for (let i = 0; i < bins; i++) {
            for (let j = 0; j < bins; j++) {
              directValues[i * bins + j] = result.grid[i][j].direct;
              invertedValues[i * bins + j] = result.grid[i][j].inverted;
            }
          }
          response = { requestId: job.requestId, ok: true, directValues, invertedValues, bins, window };
        }
        if (jobId !== activeJobId) return;
        const transfer = [...new Set([response.directValues!.buffer, response.invertedValues!.buffer])] as ArrayBuffer[];
        runtime.postMessage(response, transfer);
        if (pass + 1 < passes.length) {
          // A microtask-only await cannot admit incoming worker messages.
          await yieldControl();
        }
      }
    } catch (cause) {
      if (jobId === activeJobId) runtime.postMessage({
        requestId: job?.requestId, ok: false,
        error: cause instanceof Error ? cause.message : 'Dot plot computation failed',
      }, []);
    } finally {
      release(handle);
    }
  };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = createDotPlotHandler({ postMessage: (response, transfer) => self.postMessage(response, { transfer }) });
}
