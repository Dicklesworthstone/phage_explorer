/**
 * PhylodynamicsOverlay
 *
 * Interactive visualization of phylodynamic analysis:
 * - Phylogenetic tree (UPGMA)
 * - Root-to-tip regression (molecular clock)
 * - Coalescent skyline (effective population size Ne(t))
 *
 * Hotkey: Ctrl+Shift+Y (phylod[Y]namics)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../../db';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useHotkey } from '../../hooks/useHotkey';
import { ActionIds } from '../../keyboard';
import {
  analyzePhylodynamics,
  computeAlignmentFreeDistanceMatrix,
  generateDemoPhylodynamicsData,
  type PhylodynamicsResult,
  type TreeNode,
  type DatedSequence,
} from '@phage-explorer/core';
import {
  SketchCache,
  estimateJaccard,
  initMinHashWasm,
  MINHASH_DEFAULT_K,
} from '@phage-explorer/comparison';
import { AnalysisPanelSkeleton } from '../ui/Skeleton';
import {
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
} from './primitives';
import {
  fetchDatedPhageSequences,
  fetchSequencesFasta,
  getPhageSearchTerms,
  getCached,
  setCache,
  generateCacheKey,
} from '../../api';

interface PhylodynamicsOverlayProps {
  repository: PhageRepository | null;
  currentPhage: PhageFull | null;
}

type ViewMode = 'tree' | 'clock' | 'skyline';
type DataSource = 'loading' | 'real' | 'demo' | 'error';

export function PhylodynamicsOverlay({
  currentPhage,
}: PhylodynamicsOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const treeCanvasRef = useRef<HTMLCanvasElement>(null);
  const clockCanvasRef = useRef<HTMLCanvasElement>(null);
  const skylineCanvasRef = useRef<HTMLCanvasElement>(null);

  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('tree');
  const [result, setResult] = useState<PhylodynamicsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('loading');
  const [apiMessage, setApiMessage] = useState<string>('');
  const [sequenceCount, setSequenceCount] = useState<number>(0);

  // Track if overlay is open to avoid stale closure issues
  const wasOpenRef = useRef(false);
  const lastAnalyzedKeyRef = useRef<string | null>(null);

  // Hotkey: Ctrl+Shift+Y (phylod[Y]namics)
  useHotkey(
    ActionIds.OverlayPhylodynamics,
    useCallback(() => toggle('phylodynamics'), [toggle]),
    { modes: ['NORMAL'] }
  );

  // Run analysis when overlay opens
  useEffect(() => {
    const nowOpen = isOpen('phylodynamics');
    const justOpened = nowOpen && !wasOpenRef.current;
    wasOpenRef.current = nowOpen;

    if (!nowOpen) {
      return;
    }

    const phageKey = String(currentPhage?.id ?? 'demo');
    const phageName = currentPhage?.name ?? 'bacteriophage';
    const shouldRun = justOpened || lastAnalyzedKeyRef.current !== phageKey || !result;
    if (!shouldRun) return;

    setLoading(true);
    setError(null);
    setDataSource('loading');
    setApiMessage('');

    let cancelled = false;

    const runAnalysis = async () => {
      try {
        lastAnalyzedKeyRef.current = phageKey;

        // Check cache first
        const cacheKey = generateCacheKey('phylodynamics', { phageKey, phageName });
        const cached = getCached<{ result: PhylodynamicsResult; source: 'real' | 'demo'; count: number }>(cacheKey);
        if (cached) {
          if (cancelled) return;
          setResult(cached.result);
          setDataSource(cached.source);
          setSequenceCount(cached.count);
          setApiMessage(cached.source === 'real' ? 'Data loaded from cache' : '');
          setLoading(false);
          return;
        }

        // Try real API: Search NCBI for dated phage sequences
        let usedRealData = false;
        try {
          // Get search terms for this phage
          const searchTerms = getPhageSearchTerms(phageName);
          setApiMessage(`Searching NCBI for dated ${searchTerms[0]} sequences...`);

          // Try each search term until we get results
          for (const term of searchTerms) {
            const ncbiResult = await fetchDatedPhageSequences(term, 30);
            if (cancelled) return;

            if (ncbiResult.success && ncbiResult.data.sequences.length >= 5) {
              setApiMessage(`Found ${ncbiResult.data.sequences.length} dated sequences. Building phylogeny...`);

              // Fetch the ACTUAL sequences.
              //
              // This used to be `generatePseudoSequence(seq.accession, ...)`, a
              // hash of the accession string, with the comment "Real sequences
              // would need alignment which is expensive". The alignment concern
              // was real -- Jukes-Cantor needs aligned equal-length sequences,
              // and aligning 30 phage genomes in a browser is not practical --
              // but the resolution was to synthesise the input and keep the
              // "REAL DATA" banner over a tree, clock rate and skyline computed
              // entirely from hashes.
              //
              // Alignment-free Mash distance removes the constraint that forced
              // the shortcut, so the real sequences can be used directly. The
              // matrix is built below and passed into the analysis; without
              // that, the tree would silently fall back to Jukes-Cantor and
              // compare non-homologous columns of unaligned genomes.
              setApiMessage(`Fetching ${ncbiResult.data.sequences.length} sequences from NCBI...`);
              const accessions = ncbiResult.data.sequences.map(seq => seq.accession);
              const fastaResult = await fetchSequencesFasta(accessions);
              if (cancelled) return;

              if (!fastaResult.success || fastaResult.data.size < 5) {
                // Not enough real sequence to build a tree on. Fall through to
                // the demo path, which is clearly labelled, rather than
                // synthesising input and calling it real.
                break;
              }

              const datedSequences: DatedSequence[] = ncbiResult.data.sequences
                .map(seq => {
                  const bare = seq.accession.split('.')[0];
                  const sequence = fastaResult.data.get(bare) ?? fastaResult.data.get(seq.accession);
                  if (!sequence) return null;
                  return {
                    id: seq.accession,
                    date: seq.collectionDate.getFullYear() + seq.collectionDate.getMonth() / 12,
                    sequence,
                  };
                })
                .filter((d): d is DatedSequence => d !== null);

              if (datedSequences.length < 5) break;

              // Alignment-free distances from MinHash sketches.
              //
              // This is the step that makes the real sequences usable. Every
              // number below it -- tree, clock rate, skyline -- is derived from
              // this matrix, so if the sketches cannot be built there is no
              // honest analysis to show and the demo path is the correct
              // outcome.
              await initMinHashWasm();
              if (cancelled) return;
              const sketches = new SketchCache();
              let sketchesOk = true;
              for (const d of datedSequences) {
                if (!sketches.getOrBuild(d.id, d.sequence)) {
                  sketchesOk = false;
                  break;
                }
              }
              if (!sketchesOk) break;

              const distances = computeAlignmentFreeDistanceMatrix(
                datedSequences,
                (a, b) => {
                  const sa = sketches.get(a.id);
                  const sb = sketches.get(b.id);
                  if (!sa || !sb) return 0;
                  return estimateJaccard(sa.signature, sb.signature);
                },
                MINHASH_DEFAULT_K
              );

              // Run phylodynamic analysis
              const analysisResult = analyzePhylodynamics(datedSequences, {
                runClock: true,
                runSkyline: true,
                runSelection: true,
                distances,
              });

              if (cancelled) return;
              setResult(analysisResult);
              setDataSource('real');
              // Report what was ANALYSED, not what was found. These differ
              // whenever a fetch returns fewer sequences than the search did,
              // and the banner used to quote the larger number.
              setSequenceCount(datedSequences.length);
              const years = datedSequences.map(d => Math.floor(d.date));
              setApiMessage(
                `Analysis based on ${datedSequences.length} dated sequences from NCBI ` +
                `(${Math.min(...years)}-${Math.max(...years)})`
              );
              usedRealData = true;

              // Cache the result
              setCache(
                cacheKey,
                { result: analysisResult, source: 'real' as const, count: datedSequences.length },
                { ttl: 24 * 60 * 60 * 1000 }
              );
              break;
            }
          }
        } catch {
          // API failed, will fall back to demo data
        }

        // Fallback to demo data if real API didn't work
        if (!usedRealData) {
          if (cancelled) return;
          setApiMessage('Using demonstration data (no dated sequences found or API unavailable)');

          // Generate synthetic dated sequences using phage ID as seed for consistency
          const seed = currentPhage?.id ?? 1;
          const seqLength = Math.min(300, Math.floor((currentPhage?.genomeLength ?? 30000) / 100));
          const sequences: DatedSequence[] = generateDemoPhylodynamicsData(15, seqLength, seed);

          const analysisResult = analyzePhylodynamics(sequences, {
            runClock: true,
            runSkyline: true,
            runSelection: true,
          });

          if (cancelled) return;
          setResult(analysisResult);
          setDataSource('demo');
          setSequenceCount(15);

          // Cache demo result with shorter TTL
          setCache(cacheKey, { result: analysisResult, source: 'demo' as const, count: 15 }, { ttl: 60 * 60 * 1000 });
        }
      } catch (err) {
        if (cancelled) return;
        setResult(null);
        setDataSource('error');
        setError(err instanceof Error ? err.message : 'Phylodynamics analysis failed.');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    runAnalysis();

    return () => {
      cancelled = true;
    };
  }, [isOpen, result, currentPhage]);

  // Generate pseudo-sequence from accession for analysis
  // This creates a deterministic sequence that can be used for tree building
  // NOTE: generatePseudoSequence used to live here. It turned an accession
  // string into a short run of bases by hashing, and the real-data path fed its
  // output to the tree builder, the molecular clock, the skyline and dN/dS --
  // under a green "REAL DATA" banner. Deleted rather than kept behind a flag:
  // there is no circumstance in which a hash of an identifier should reach an
  // analysis that reports substitutions per site per year.

  // Draw phylogenetic tree
  useEffect(() => {
    if (!isOpen('phylodynamics') || viewMode !== 'tree') return;
    if (!treeCanvasRef.current || !result) return;

    const canvas = treeCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { tree } = result;
      const padding = 40;
      const treeWidth = width - padding * 2;
      const treeHeight = height - padding * 2;

      // Collect leaf nodes for positioning
      const leaves: TreeNode[] = [];
      const collectLeaves = (node: TreeNode): void => {
        if (node.isLeaf) leaves.push(node);
        node.children.forEach(collectLeaves);
      };
      collectLeaves(tree.root);

      if (leaves.length === 0) return;

      // Assign y positions to leaves
      const leafSpacing = treeHeight / (leaves.length + 1);
      const leafY = new Map<string, number>();
      leaves.forEach((leaf, i) => {
        leafY.set(leaf.id, padding + (i + 1) * leafSpacing);
      });

      // Calculate internal node y as mean of children
      const nodeY = new Map<string, number>();
      const calcY = (node: TreeNode): number => {
        if (node.isLeaf) {
          const y = leafY.get(node.id) ?? height / 2;
          nodeY.set(node.id, y);
          return y;
        }
        const childYs = node.children.map(calcY);
        const y = childYs.reduce((a, b) => a + b, 0) / childYs.length;
        nodeY.set(node.id, y);
        return y;
      };
      calcY(tree.root);

      // Calculate x from heights (normalized)
      const maxHeight = tree.height || 1;
      const scaleX = (h: number) => padding + (h / maxHeight) * treeWidth;

      // Draw tree edges
      ctx.strokeStyle = colors.primary;
      ctx.lineWidth = 2;

      const drawNode = (node: TreeNode, parentX: number | null, parentY: number | null): void => {
        const x = scaleX(node.height);
        const y = nodeY.get(node.id) ?? height / 2;

        if (parentX !== null && parentY !== null) {
          // Horizontal line from parent
          ctx.beginPath();
          ctx.moveTo(parentX, parentY);
          ctx.lineTo(parentX, y);
          ctx.stroke();

          // Vertical line to node
          ctx.beginPath();
          ctx.moveTo(parentX, y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }

        // Draw children
        node.children.forEach(child => drawNode(child, x, y));

        // Draw leaf labels
        if (node.isLeaf) {
          ctx.fillStyle = colors.accent;
          ctx.font = '10px monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const label = node.sequence?.id ?? node.id;
          ctx.fillText(label.slice(0, 12), x + 5, y);
        } else {
          // Internal node dot
          ctx.fillStyle = colors.primary;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      drawNode(tree.root, null, null);

      // Time axis
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, height - padding / 2);
      ctx.lineTo(width - padding, height - padding / 2);
      ctx.stroke();

      ctx.fillStyle = colors.textDim;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('← Past', padding + 40, height - padding / 2 + 12);
      ctx.fillText('Present →', width - padding - 40, height - padding / 2 + 12);
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [isOpen, viewMode, result, colors]);

  // Draw root-to-tip regression (molecular clock)
  useEffect(() => {
    if (!isOpen('phylodynamics') || viewMode !== 'clock') return;
    if (!clockCanvasRef.current || !result?.clockRegression) return;

    const canvas = clockCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { clockRegression } = result;
      if (!clockRegression || clockRegression.residuals.length === 0) {
        ctx.fillStyle = colors.textMuted;
        ctx.textAlign = 'center';
        ctx.font = '14px monospace';
        ctx.fillText('Insufficient data for clock analysis', width / 2, height / 2);
        return;
      }

      const padding = 50;
      const plotWidth = width - padding * 2;
      const plotHeight = height - padding * 2;

      // Root-to-tip regression plots: x = collection date, y = root-to-tip distance.
      // clockRegression.residuals only contains distances, so we pull dates from the tree leaves.
      const leafDateById = new Map<string, number>();
      const collectLeafDates = (node: TreeNode): void => {
        if (node.isLeaf) {
          const date = node.sequence?.date;
          if (typeof date === 'number' && Number.isFinite(date)) {
            leafDateById.set(node.id, date);
          }
          return;
        }
        node.children.forEach(collectLeafDates);
      };
      collectLeafDates(result.tree.root);

	      const points = clockRegression.residuals
	        .map((r) => {
	          const date = leafDateById.get(r.id);
	          if (date === undefined) return null;
	          return { id: r.id, date, distance: r.observed, expected: r.expected };
	        })
	        .filter((p): p is { id: string; date: number; distance: number; expected: number } => p !== null);

      if (points.length < 2) {
        ctx.fillStyle = colors.textMuted;
        ctx.textAlign = 'center';
        ctx.font = '14px monospace';
        ctx.fillText('Insufficient dated sequences for clock analysis', width / 2, height / 2);
        return;
      }

      const dates = points.map((p) => p.date);
      const distances = points.map((p) => p.distance);
      const minDate = Math.min(...dates);
      const maxDate = Math.max(...dates);
      const minDist = 0;
      const maxDist = Math.max(0.001, ...distances) * 1.1;

      const scaleX = (d: number) => padding + ((d - minDate) / (maxDate - minDate || 1)) * plotWidth;
      const scaleY = (v: number) => height - padding - ((v - minDist) / (maxDist - minDist || 1)) * plotHeight;

      const intercept =
        clockRegression.rate > 0 ? -clockRegression.rate * clockRegression.rootAge : points[0].expected;
      const predict = (date: number) => clockRegression.rate * date + intercept;

      // Draw regression line
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleX(minDate), scaleY(predict(minDate)));
      ctx.lineTo(scaleX(maxDate), scaleY(predict(maxDate)));
      ctx.stroke();

      // Draw data points
      ctx.fillStyle = colors.primary;
      for (const p of points) {
        const x = scaleX(p.date);
        const y = scaleY(p.distance);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Axes
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, padding);
      ctx.lineTo(padding, height - padding);
      ctx.lineTo(width - padding, height - padding);
      ctx.stroke();

      // Labels
      ctx.fillStyle = colors.textDim;
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Collection Date (Year)', width / 2, height - 10);

      ctx.save();
      ctx.translate(15, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Root-to-Tip Distance', 0, 0);
      ctx.restore();

      // R² annotation
      ctx.fillStyle = colors.accent;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`R² = ${clockRegression.r2.toFixed(3)}`, width - padding - 10, padding + 20);
      ctx.fillText(`Rate = ${(clockRegression.rate * 1000).toFixed(3)} ×10⁻³ sub/site/yr`, width - padding - 10, padding + 36);
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [isOpen, viewMode, result, colors]);

  // Draw coalescent skyline
  useEffect(() => {
    if (!isOpen('phylodynamics') || viewMode !== 'skyline') return;
    if (!skylineCanvasRef.current || !result?.skyline) return;

    const canvas = skylineCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);

      const { skyline } = result;
      if (!skyline || skyline.intervals.length === 0) {
        ctx.fillStyle = colors.textMuted;
        ctx.textAlign = 'center';
        ctx.font = '14px monospace';
        ctx.fillText('Skyline requires clock-calibrated tree', width / 2, height / 2);
        return;
      }

      const padding = 50;
      const plotWidth = width - padding * 2;
      const plotHeight = height - padding * 2;

      // Data ranges (log scale for Ne)
      const maxTime = skyline.timeSpan || 1;
      const neValues = skyline.intervals.map(i => i.ne).filter(v => v > 0);
      const minNe = Math.max(1, Math.min(...neValues));
      const maxNe = Math.max(...neValues) * 1.2;
      const logMin = Math.log10(minNe);
      const logMax = Math.log10(maxNe);

      const scaleX = (t: number) => padding + (t / maxTime) * plotWidth;
      const scaleY = (ne: number) => {
        const logNe = Math.log10(Math.max(1, ne));
        return height - padding - ((logNe - logMin) / (logMax - logMin || 1)) * plotHeight;
      };

      // Draw skyline as step function
      ctx.strokeStyle = colors.success;
      ctx.lineWidth = 2;
      ctx.beginPath();

      let started = false;
      for (const interval of skyline.intervals) {
        const x1 = scaleX(interval.startTime);
        const x2 = scaleX(interval.endTime);
        const y = scaleY(interval.ne);

        if (!started) {
          ctx.moveTo(x1, y);
          started = true;
        } else {
          ctx.lineTo(x1, y);
        }
        ctx.lineTo(x2, y);
      }
      ctx.stroke();

      // Fill under curve
      ctx.fillStyle = colors.success + '33'; // 20% opacity
      ctx.beginPath();
      started = false;
      for (const interval of skyline.intervals) {
        const x1 = scaleX(interval.startTime);
        const x2 = scaleX(interval.endTime);
        const y = scaleY(interval.ne);

        if (!started) {
          ctx.moveTo(x1, height - padding);
          ctx.lineTo(x1, y);
          started = true;
        } else {
          ctx.lineTo(x1, y);
        }
        ctx.lineTo(x2, y);
      }
      // Close path
      const lastInterval = skyline.intervals[skyline.intervals.length - 1];
      if (lastInterval) {
        ctx.lineTo(scaleX(lastInterval.endTime), height - padding);
      }
      ctx.closePath();
      ctx.fill();

      // Axes
      ctx.strokeStyle = colors.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding, padding);
      ctx.lineTo(padding, height - padding);
      ctx.lineTo(width - padding, height - padding);
      ctx.stroke();

      // Labels
      ctx.fillStyle = colors.textDim;
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Time (Years Before Present)', width / 2, height - 10);

      ctx.save();
      ctx.translate(15, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Effective Pop. Size Ne (log)', 0, 0);
      ctx.restore();

      // Lineage count annotation
      ctx.fillStyle = colors.accent;
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      for (const interval of skyline.intervals) {
        if (interval.lineages >= 2) {
          const x = scaleX((interval.startTime + interval.endTime) / 2);
          const y = scaleY(interval.ne) - 10;
          ctx.fillText(`k=${interval.lineages}`, x - 10, y);
        }
      }
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [isOpen, viewMode, result, colors]);

  if (!isOpen('phylodynamics')) return null;

  return (
    <Overlay id="phylodynamics" title="PHYLODYNAMIC TRAJECTORY EXPLORER" size="xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%' }}>
        {/* Data source banner */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: dataSource === 'real' ? colors.success + '22' : colors.warning + '22',
            border: `1px solid ${dataSource === 'real' ? colors.success : colors.warning}`,
            borderRadius: '4px',
            color: colors.text,
            fontSize: '0.85rem',
          }}
        >
          {dataSource === 'loading' && (
            <>
              <strong style={{ color: colors.accent }}>LOADING</strong>: {apiMessage || 'Searching NCBI for dated sequences...'}
            </>
          )}
          {dataSource === 'real' && (
            <>
              <strong style={{ color: colors.success }}>REAL DATA</strong>: {apiMessage || `Analysis based on ${sequenceCount} dated sequences from NCBI GenBank.`}
            </>
          )}
          {dataSource === 'demo' && (
            <>
              <strong style={{ color: colors.warning }}>DEMO MODE</strong>: {apiMessage || 'Phylodynamics requires dated sequence samples from multiple time points. Using synthetic data to demonstrate the analysis pipeline.'}
            </>
          )}
          {dataSource === 'error' && (
            <>
              <strong style={{ color: colors.error }}>ERROR</strong>: Failed to fetch data. Showing demo visualization.
            </>
          )}
        </div>

        {/* Info banner */}
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '4px',
            color: colors.textDim,
            fontSize: '0.9rem',
          }}
        >
          <strong style={{ color: colors.accent }}>Phylodynamics</strong>: Time-scaled
          evolutionary analysis using UPGMA trees, molecular clock regression, and
          coalescent skyline for effective population size.
        </div>

        {/* View mode tabs */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['tree', 'clock', 'skyline'] as ViewMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '0.5rem 1rem',
                border: `1px solid ${viewMode === mode ? colors.accent : colors.borderLight}`,
                borderRadius: '4px',
                backgroundColor: viewMode === mode ? colors.accent + '22' : 'transparent',
                color: viewMode === mode ? colors.accent : colors.text,
                cursor: 'pointer',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                textTransform: 'uppercase',
              }}
            >
              {mode === 'tree' && '🌳 Tree'}
              {mode === 'clock' && '⏱ Clock'}
              {mode === 'skyline' && '📈 Skyline'}
            </button>
          ))}
        </div>

        {/* Canvas area */}
        {loading ? (
          <OverlayLoadingState message={apiMessage || 'Searching NCBI for dated sequences...'}>
            <AnalysisPanelSkeleton />
          </OverlayLoadingState>
        ) : error ? (
          <OverlayErrorState
            message="Phylodynamic analysis failed"
            details={error}
          />
        ) : !result ? (
          <OverlayEmptyState
            message="No analysis data available"
            hint="Select a phage to analyze phylodynamic trajectories."
          />
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: '300px',
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            <canvas
              ref={treeCanvasRef}
              role="img"
              aria-label="UPGMA phylogenetic tree showing evolutionary relationships between phage sequences"
              style={{
                width: '100%',
                height: '100%',
                display: viewMode === 'tree' ? 'block' : 'none',
              }}
            />
            <canvas
              ref={clockCanvasRef}
              role="img"
              aria-label="Root-to-tip regression plot for molecular clock analysis showing divergence over time"
              style={{
                width: '100%',
                height: '100%',
                display: viewMode === 'clock' ? 'block' : 'none',
              }}
            />
            <canvas
              ref={skylineCanvasRef}
              role="img"
              aria-label="Coalescent skyline plot showing estimated effective population size over time"
              style={{
                width: '100%',
                height: '100%',
                display: viewMode === 'skyline' ? 'block' : 'none',
              }}
            />
          </div>
        )}

        {/* Stats footer */}
        {result && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0.5rem',
              backgroundColor: colors.backgroundAlt,
              borderRadius: '4px',
              fontSize: '0.8rem',
              fontFamily: 'monospace',
            }}
          >
            <span style={{ color: colors.textDim }}>
              Leaves: <strong style={{ color: colors.text }}>{result.tree.leafCount}</strong>
            </span>
            <span style={{ color: colors.textDim }}>
              Clock R²:{' '}
              <strong
                style={{
                  color: (result.clockRegression?.r2 ?? 0) > 0.7 ? colors.success : colors.warning,
                }}
              >
                {result.clockRegression?.r2.toFixed(3) ?? 'N/A'}
              </strong>
            </span>
            <span style={{ color: colors.textDim }}>
              dN/dS:{' '}
              <strong
                style={{
                  color:
                    (result.selection?.treeDnDs ?? 1) > 1
                      ? colors.error
                      : (result.selection?.treeDnDs ?? 1) < 1
                        ? colors.primary
                        : colors.text,
                }}
              >
                {result.selection?.treeDnDs.toFixed(3) ?? 'N/A'}
              </strong>
            </span>
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default PhylodynamicsOverlay;
