/**
 * GpuWasmBenchmarkOverlay (dev-only)
 *
 * Small in-browser benchmark harness to compare WebGPU compute vs WASM compute
 * on real genome windows.
 *
 * This is intentionally hidden from production builds by only being surfaced in
 * dev UI entry points (hotkey + AnalysisMenu dev section).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DENSE_KMER_MAX_K,
  countKmersDenseJS,
  denseKmerMemoryCostHuman,
  type PhageFull,
} from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { useHotkey } from '../../hooks/useHotkey';
import { ActionIds } from '../../keyboard';
import { detectWebGPU } from '../../utils';
import { gpuCompute } from '../../workers/gpu/GPUCompute';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import type * as WasmComputeTypes from '@phage/wasm-compute';

type BenchBackend = 'gpu' | 'wasm' | 'js';
type BenchOp = 'dense-kmer' | 'minhash' | 'gc-skew';
type WasmComputeModule = typeof WasmComputeTypes;

interface BenchRow {
  backend: BenchBackend;
  op: BenchOp;
  supported: boolean;
  warmupMs?: number;
  medianMs?: number;
  runs?: number;
  notes?: string;
  error?: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${Math.round(value * 100) / 100} ms`;
}

async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

async function benchAsync(args: {
  warmup: () => Promise<void>;
  run: () => Promise<void>;
  runs: number;
}): Promise<{ warmupMs: number; medianMs: number; samples: number[] }> {
  const { warmup, run, runs } = args;
  const samples: number[] = [];

  const t0 = performance.now();
  await warmup();
  const warmupMs = performance.now() - t0;

  for (let i = 0; i < runs; i++) {
    await yieldToUi();
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }

  return { warmupMs, medianMs: median(samples), samples };
}

interface GpuWasmBenchmarkOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

export function GpuWasmBenchmarkOverlay({
  repository,
  currentPhage,
}: GpuWasmBenchmarkOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, isMobile } = useOverlay();

  const [sampleBp, setSampleBp] = useState(100_000);
  const [k, setK] = useState(6);
  const [canonical, setCanonical] = useState(true);
  const [minhashHashes, setMinhashHashes] = useState(256);
  const [gcWindow, setGcWindow] = useState(1000);
  const [gcStep, setGcStep] = useState(250);
  const [runs, setRuns] = useState(7);

  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    phageName: string;
    genomeBp: number;
    sampleBp: number;
    webgpu: Awaited<ReturnType<typeof detectWebGPU>> | null;
  } | null>(null);

  const runIdRef = useRef(0);

  // Hotkey: Alt+Shift+B
  useHotkey(
    ActionIds.OverlayGpuWasmBenchmark,
    () => toggle('gpuWasmBenchmark'),
    { modes: ['NORMAL'] }
  );

  // Reset state when closing
  useEffect(() => {
    if (isOpen('gpuWasmBenchmark')) return;
    setRunning(false);
    setRows([]);
    setError(null);
    setMeta(null);
  }, [isOpen]);

  const canRun = useMemo(() => {
    return Boolean(repository && currentPhage && !running);
  }, [repository, currentPhage, running]);

  async function runBenchmark(): Promise<void> {
    if (!repository || !currentPhage) {
      setError('Select a phage first.');
      return;
    }

    const runId = ++runIdRef.current;
    setRunning(true);
    setError(null);
    setRows([]);
    setMeta(null);

    try {
      const tryLoadWasm = async (): Promise<{
        ok: boolean;
        module?: WasmComputeModule;
        error?: string;
      }> => {
        try {
          const wasm = await import('@phage/wasm-compute');
          // Some builds auto-init; calling init() again should be a no-op, but keep it best-effort.
          try {
            const init = (wasm as unknown as { default?: () => Promise<void> }).default;
            if (typeof init === 'function') await init();
          } catch {
            // Ignore init errors; the functions may still be usable depending on bundler output.
          }
          return { ok: true, module: wasm };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const [webgpuInfo, wasm] = await Promise.all([detectWebGPU(), tryLoadWasm()]);
      if (runIdRef.current !== runId) return;

      const genomeBp = await repository.getFullGenomeLength(currentPhage.id);
      const usedSampleBp = Math.max(1, Math.min(genomeBp, sampleBp));
      const sequence = await repository.getSequenceWindow(currentPhage.id, 0, usedSampleBp);
      const seq = sequence.toUpperCase();
      const seqBytes = textEncoder ? textEncoder.encode(seq) : null;

      setMeta({
        phageName: currentPhage.name,
        genomeBp,
        sampleBp: usedSampleBp,
        webgpu: webgpuInfo,
      });

      const nextRows: BenchRow[] = [];

      // ---------------------------------------------------------------------
      // GPU benchmarks
      // ---------------------------------------------------------------------
      const gpuSupported = webgpuInfo.supported && (await gpuCompute.ready());

      if (!gpuSupported) {
        nextRows.push({
          backend: 'gpu',
          op: 'dense-kmer',
          supported: false,
          notes: webgpuInfo.supported ? 'GPU init failed' : webgpuInfo.reason,
        });
        nextRows.push({
          backend: 'gpu',
          op: 'minhash',
          supported: false,
          notes: webgpuInfo.supported ? 'MinHash not implemented on GPU' : webgpuInfo.reason,
        });
        nextRows.push({
          backend: 'gpu',
          op: 'gc-skew',
          supported: false,
          notes: webgpuInfo.supported ? 'GPU init failed' : webgpuInfo.reason,
        });
      } else {
        // Dense k-mer counts (GPU)
        if (k > DENSE_KMER_MAX_K) {
          nextRows.push({
            backend: 'gpu',
            op: 'dense-kmer',
            supported: false,
            notes: `k=${k} exceeds dense cap (max=${DENSE_KMER_MAX_K}, ${denseKmerMemoryCostHuman(k)}) · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        } else {
          try {
            const measured = await benchAsync({
              warmup: async () => {
                const result = await gpuCompute.countKmersDense(seq, k);
                if (!result) throw new Error('GPU dense k-mer returned null');
              },
              run: async () => {
                const result = await gpuCompute.countKmersDense(seq, k);
                if (!result) throw new Error('GPU dense k-mer returned null');
              },
              runs,
            });
            nextRows.push({
              backend: 'gpu',
              op: 'dense-kmer',
              supported: true,
              warmupMs: measured.warmupMs,
              medianMs: measured.medianMs,
              runs,
              notes: `k=${k} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          } catch (err) {
            nextRows.push({
              backend: 'gpu',
              op: 'dense-kmer',
              supported: false,
              error: err instanceof Error ? err.message : String(err),
              notes: `k=${k} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          }
        }

        // MinHash (GPU) - not implemented
        nextRows.push({
          backend: 'gpu',
          op: 'minhash',
          supported: false,
          notes: `not implemented · sample=${usedSampleBp.toLocaleString()}bp`,
        });

        // GC skew (GPU)
        try {
          const measured = await benchAsync({
            warmup: async () => {
              const result = await gpuCompute.computeGCSkew(seq, gcWindow, gcStep);
              if (!result) throw new Error('GPU GC skew returned null');
            },
            run: async () => {
              const result = await gpuCompute.computeGCSkew(seq, gcWindow, gcStep);
              if (!result) throw new Error('GPU GC skew returned null');
            },
            runs,
          });
          nextRows.push({
            backend: 'gpu',
            op: 'gc-skew',
            supported: true,
            warmupMs: measured.warmupMs,
            medianMs: measured.medianMs,
            runs,
            notes: `window=${gcWindow}, step=${gcStep} · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        } catch (err) {
          nextRows.push({
            backend: 'gpu',
            op: 'gc-skew',
            supported: false,
            error: err instanceof Error ? err.message : String(err),
            notes: `window=${gcWindow}, step=${gcStep} · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        }
      }

      // ---------------------------------------------------------------------
      // WASM benchmarks
      // ---------------------------------------------------------------------
      if (!wasm.ok || !wasm.module) {
        nextRows.push({
          backend: 'wasm',
          op: 'dense-kmer',
          supported: false,
          notes: wasm.error ?? 'WASM module failed to load',
        });
        nextRows.push({
          backend: 'wasm',
          op: 'minhash',
          supported: false,
          notes: wasm.error ?? 'WASM module failed to load',
        });
        nextRows.push({
          backend: 'wasm',
          op: 'gc-skew',
          supported: false,
          notes: wasm.error ?? 'WASM module failed to load',
        });
      } else {
        // Dense k-mer counts (WASM)
        if (!seqBytes) {
          nextRows.push({
            backend: 'wasm',
            op: 'dense-kmer',
            supported: false,
            notes: 'TextEncoder unavailable (cannot build ASCII bytes)',
          });
        } else if (k > DENSE_KMER_MAX_K) {
          nextRows.push({
            backend: 'wasm',
            op: 'dense-kmer',
            supported: false,
            notes: `k=${k} exceeds dense cap (max=${DENSE_KMER_MAX_K}, ${denseKmerMemoryCostHuman(k)}) · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        } else if (
          canonical
            ? typeof wasm.module!.count_kmers_dense_canonical !== 'function'
            : typeof wasm.module!.count_kmers_dense !== 'function'
        ) {
          nextRows.push({
            backend: 'wasm',
            op: 'dense-kmer',
            supported: false,
            notes: 'WASM dense k-mer kernel not available in this build',
          });
        } else {
          try {
            const fn = canonical ? wasm.module!.count_kmers_dense_canonical : wasm.module!.count_kmers_dense;
            const measured = await benchAsync({
              warmup: async () => {
                const r = fn(seqBytes, k);
                try {
                  void r.total_valid;
                  void r.unique_count;
                  void r.counts;
                } finally {
                  r.free();
                }
              },
              run: async () => {
                const r = fn(seqBytes, k);
                try {
                  void r.total_valid;
                  void r.unique_count;
                  void r.counts;
                } finally {
                  r.free();
                }
              },
              runs,
            });
            nextRows.push({
              backend: 'wasm',
              op: 'dense-kmer',
              supported: true,
              warmupMs: measured.warmupMs,
              medianMs: measured.medianMs,
              runs,
              notes: `k=${k} · canonical=${canonical ? 'yes' : 'no'} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          } catch (err) {
            nextRows.push({
              backend: 'wasm',
              op: 'dense-kmer',
              supported: false,
              error: err instanceof Error ? err.message : String(err),
              notes: `k=${k} · canonical=${canonical ? 'yes' : 'no'} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          }
        }

        // MinHash signature (WASM)
        if (!seqBytes) {
          nextRows.push({
            backend: 'wasm',
            op: 'minhash',
            supported: false,
            notes: 'TextEncoder unavailable (cannot build ASCII bytes)',
          });
        } else if (minhashHashes <= 0 || !Number.isFinite(minhashHashes)) {
          nextRows.push({
            backend: 'wasm',
            op: 'minhash',
            supported: false,
            notes: 'Invalid num_hashes',
          });
        } else if (
          canonical
            ? typeof wasm.module!.minhash_signature_canonical !== 'function'
            : typeof wasm.module!.minhash_signature !== 'function'
        ) {
          nextRows.push({
            backend: 'wasm',
            op: 'minhash',
            supported: false,
            notes: 'WASM MinHash kernel not available in this build',
          });
        } else {
          try {
            const fn = canonical ? wasm.module!.minhash_signature_canonical : wasm.module!.minhash_signature;
            const measured = await benchAsync({
              warmup: async () => {
                const sig = fn(seqBytes, k, minhashHashes);
                try {
                  void sig.num_hashes;
                  void sig.signature;
                } finally {
                  sig.free();
                }
              },
              run: async () => {
                const sig = fn(seqBytes, k, minhashHashes);
                try {
                  void sig.num_hashes;
                  void sig.signature;
                } finally {
                  sig.free();
                }
              },
              runs,
            });
            nextRows.push({
              backend: 'wasm',
              op: 'minhash',
              supported: true,
              warmupMs: measured.warmupMs,
              medianMs: measured.medianMs,
              runs,
              notes: `k=${k} · hashes=${minhashHashes} · canonical=${canonical ? 'yes' : 'no'} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          } catch (err) {
            nextRows.push({
              backend: 'wasm',
              op: 'minhash',
              supported: false,
              error: err instanceof Error ? err.message : String(err),
              notes: `k=${k} · hashes=${minhashHashes} · canonical=${canonical ? 'yes' : 'no'} · sample=${usedSampleBp.toLocaleString()}bp`,
            });
          }
        }

        // GC skew (WASM)
        try {
          const measured = await benchAsync({
            warmup: async () => {
              void wasm.module!.compute_gc_skew(seq, gcWindow, gcStep);
            },
            run: async () => {
              void wasm.module!.compute_gc_skew(seq, gcWindow, gcStep);
            },
            runs,
          });
          nextRows.push({
            backend: 'wasm',
            op: 'gc-skew',
            supported: true,
            warmupMs: measured.warmupMs,
            medianMs: measured.medianMs,
            runs,
            notes: `compute_gc_skew(window=${gcWindow}, step=${gcStep}) · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        } catch (err) {
          nextRows.push({
            backend: 'wasm',
            op: 'gc-skew',
            supported: false,
            error: err instanceof Error ? err.message : String(err),
            notes: `window=${gcWindow}, step=${gcStep} · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        }
      }

      // ---------------------------------------------------------------------
      // JS benchmarks (baseline)
      // ---------------------------------------------------------------------
      if (k > DENSE_KMER_MAX_K) {
        nextRows.push({
          backend: 'js',
          op: 'dense-kmer',
          supported: false,
          notes: `k=${k} exceeds dense cap (max=${DENSE_KMER_MAX_K}, ${denseKmerMemoryCostHuman(k)}) · sample=${usedSampleBp.toLocaleString()}bp`,
        });
      } else {
        try {
          const measured = await benchAsync({
            warmup: async () => {
              const out = countKmersDenseJS(seqBytes ?? seq, k);
              void out.totalValid;
              void out.uniqueCount;
              void out.counts;
            },
            run: async () => {
              const out = countKmersDenseJS(seqBytes ?? seq, k);
              void out.totalValid;
              void out.uniqueCount;
              void out.counts;
            },
            runs,
          });
          nextRows.push({
            backend: 'js',
            op: 'dense-kmer',
            supported: true,
            warmupMs: measured.warmupMs,
            medianMs: measured.medianMs,
            runs,
            notes: `k=${k} · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        } catch (err) {
          nextRows.push({
            backend: 'js',
            op: 'dense-kmer',
            supported: false,
            error: err instanceof Error ? err.message : String(err),
            notes: `k=${k} · sample=${usedSampleBp.toLocaleString()}bp`,
          });
        }
      }

      if (runIdRef.current !== runId) return;
      setRows(nextRows);
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (runIdRef.current === runId) {
        setRunning(false);
      }
    }
  }

  if (!import.meta.env.DEV || !isOpen('gpuWasmBenchmark')) return null;

  const rowBg = colors.backgroundAlt;
  const tableBorder = colors.borderLight;

  return (
    <Overlay id="gpuWasmBenchmark" title="GPU vs WASM BENCHMARK (Dev)" hotkey="Alt+Shift+B" size="lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
          Runs on the current phage’s first window and reports median timings. Numbers vary by browser/GPU/thermal state.
        </div>

        {error && (
          <div style={{ color: colors.error, fontFamily: 'monospace' }}>
            {error}
          </div>
        )}

        {/* Controls */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
            gap: '0.75rem',
            padding: '0.75rem',
            border: `1px solid ${tableBorder}`,
            borderRadius: '6px',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Sample bp</span>
            <input
              type="number"
              value={sampleBp}
              min={1000}
              step={1000}
              onChange={(e) => setSampleBp(Math.max(1000, Number(e.target.value) || 1000))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>k (k-mer)</span>
            <input
              type="number"
              value={k}
              min={2}
              max={12}
              step={1}
              onChange={(e) => setK(Math.max(2, Math.min(12, Number(e.target.value) || 6)))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Canonical (RC)</span>
            <input
              type="checkbox"
              checked={canonical}
              onChange={(e) => setCanonical(e.target.checked)}
              style={{ width: '18px', height: '18px' }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>MinHash hashes</span>
            <input
              type="number"
              value={minhashHashes}
              min={8}
              max={4096}
              step={8}
              onChange={(e) => setMinhashHashes(Math.max(8, Math.min(4096, Number(e.target.value) || 256)))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Runs</span>
            <input
              type="number"
              value={runs}
              min={3}
              max={15}
              step={1}
              onChange={(e) => setRuns(Math.max(3, Math.min(15, Number(e.target.value) || 7)))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>GC window</span>
            <input
              type="number"
              value={gcWindow}
              min={100}
              step={50}
              onChange={(e) => setGcWindow(Math.max(100, Number(e.target.value) || 1000))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>GC step</span>
            <input
              type="number"
              value={gcStep}
              min={1}
              step={1}
              onChange={(e) => setGcStep(Math.max(1, Number(e.target.value) || 250))}
              style={{ padding: '0.35rem', borderRadius: '4px', border: `1px solid ${tableBorder}` }}
            />
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => void runBenchmark()}
              disabled={!canRun}
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                border: `1px solid ${tableBorder}`,
                backgroundColor: canRun ? colors.accent : colors.backgroundAlt,
                color: canRun ? colors.background : colors.textMuted,
                cursor: canRun ? 'pointer' : 'not-allowed',
                fontWeight: 600,
              }}
            >
              {running ? 'Running…' : 'Run benchmark'}
            </button>
          </div>
        </div>

        {/* Meta */}
        {meta && (
          <div style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: '0.85rem' }}>
            Phage: {meta.phageName} · Genome: {meta.genomeBp.toLocaleString()} bp · Sample: {meta.sampleBp.toLocaleString()} bp
            {meta.webgpu && meta.webgpu.supported && meta.webgpu.adapterInfo?.name
              ? ` · WebGPU: ${meta.webgpu.adapterInfo.name}`
              : meta.webgpu && !meta.webgpu.supported
                ? ` · WebGPU: ${meta.webgpu.reason}`
                : ''}
          </div>
        )}

        {/* Results */}
        <div style={{ border: `1px solid ${tableBorder}`, borderRadius: '6px', overflow: 'hidden' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 90px 110px 110px 1fr',
              gap: '0',
              backgroundColor: rowBg,
              borderBottom: `1px solid ${tableBorder}`,
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              padding: '0.5rem 0.75rem',
            }}
          >
            <div style={{ color: colors.textMuted }}>Backend</div>
            <div style={{ color: colors.textMuted }}>Op</div>
            <div style={{ color: colors.textMuted }}>Warmup</div>
            <div style={{ color: colors.textMuted }}>Median</div>
            <div style={{ color: colors.textMuted }}>Notes</div>
          </div>

          {(rows.length === 0 ? [null] : rows).map((row, idx) => {
            if (!row) {
              return (
                <div key="empty" style={{ padding: '0.75rem', color: colors.textMuted, fontFamily: 'monospace' }}>
                  {repository && currentPhage ? 'Run the benchmark to see results.' : 'Select a phage to enable benchmarking.'}
                </div>
              );
            }

            const supportedColor = row.supported ? colors.success : colors.textMuted;
            const backendLabel = row.backend === 'gpu' ? 'WebGPU' : row.backend === 'wasm' ? 'WASM' : 'JS';
            const opLabel =
              row.op === 'dense-kmer' ? 'k-mer (dense)'
              : row.op === 'minhash' ? 'MinHash'
              : 'GC skew';
            const note = row.error ? `${row.notes ?? ''} ${row.error}`.trim() : row.notes ?? '';

            return (
              <div
                key={`${row.backend}-${row.op}-${idx}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 90px 110px 110px 1fr',
                  padding: '0.5rem 0.75rem',
                  borderBottom: idx === rows.length - 1 ? 'none' : `1px solid ${tableBorder}`,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                }}
              >
                <div style={{ color: supportedColor }}>{backendLabel}</div>
                <div style={{ color: colors.textDim }}>{opLabel}</div>
                <div style={{ color: colors.text }}>{formatMs(row.warmupMs)}</div>
                <div style={{ color: colors.text }}>{formatMs(row.medianMs)}</div>
                <div style={{ color: row.error ? colors.error : colors.textMuted }}>{note || '—'}</div>
              </div>
            );
          })}
        </div>
      </div>
    </Overlay>
  );
}

export default GpuWasmBenchmarkOverlay;
