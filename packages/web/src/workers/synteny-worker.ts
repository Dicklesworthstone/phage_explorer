import type { GeneInfo } from '@phage-explorer/core';
import { alignSynteny, type SyntenyAnalysis, type SyntenyBlock } from '@phage-explorer/comparison';

interface PhageDescriptor {
  id: number;
  name: string;
  length?: number | null;
}

interface SyntenyJob {
  query: PhageDescriptor;
  reference: PhageDescriptor;
  genesQuery: GeneInfo[];
  genesReference: GeneInfo[];
}

interface SyntenyHeatmap {
  rows: number;
  cols: number;
  values: Float32Array;
  min: number;
  max: number;
}

interface SyntenyBlockBp {
  startIdxQuery: number;
  endIdxQuery: number;
  startIdxReference: number;
  endIdxReference: number;
  startBpQuery: number;
  endBpQuery: number;
  startBpReference: number;
  endBpReference: number;
  score: number;
  orientation: SyntenyBlock['orientation'];
}

interface SyntenyStats {
  blockCount: number;
  globalScore: number;
  dtwDistance: number;
  coverageQuery: number;
  coverageReference: number;
}

interface WorkerResponse {
  ok: boolean;
  analysis?: SyntenyAnalysis;
  blocksBp?: SyntenyBlockBp[];
  heatmap?: SyntenyHeatmap;
  stats?: SyntenyStats;
  error?: string;
}

function toLabel(gene: GeneInfo | undefined): string {
  return (gene?.product || gene?.name || gene?.locusTag || '').toLowerCase();
}

function geneSimilarity(a: GeneInfo, b: GeneInfo): number {
  const nameA = toLabel(a);
  const nameB = toLabel(b);
  if (!nameA || !nameB) return 0;
  if (nameA === nameB) return 1;
  if (nameA.includes(nameB) || nameB.includes(nameA)) return 0.8;

  const termsA = nameA.split(/[\s-]+/).filter((t) => t.length > 3);
  const termsB = nameB.split(/[\s-]+/).filter((t) => t.length > 3);
  const common = termsA.filter((t) => termsB.includes(t));
  if (common.length > 0) return 0.5;

  return 0;
}

function buildHeatmap(genesA: GeneInfo[], genesB: GeneInfo[]): SyntenyHeatmap {
  const rows = genesA.length;
  const cols = genesB.length;
  const values = new Float32Array(rows * cols);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sim = geneSimilarity(genesA[r], genesB[c]);
      const idx = r * cols + c;
      values[idx] = sim;
      if (sim < min) min = sim;
      if (sim > max) max = sim;
    }
  }

  // Normalize bounds in case of empty genes
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 1;

  return { rows, cols, values, min, max };
}

function toBpBlocks(analysis: SyntenyAnalysis, genesA: GeneInfo[], genesB: GeneInfo[]): SyntenyBlockBp[] {
  return analysis.blocks.map((block) => {
    const startGeneA = genesA[block.startIdxA];
    const endGeneA = genesA[block.endIdxA];
    const startGeneB = genesB[block.startIdxB];
    const endGeneB = genesB[block.endIdxB];

    const startBpQuery = Math.min(startGeneA?.startPos ?? 0, endGeneA?.startPos ?? 0);
    const endBpQuery = Math.max(startGeneA?.endPos ?? 0, endGeneA?.endPos ?? 0);
    const startBpReference = Math.min(startGeneB?.startPos ?? 0, endGeneB?.startPos ?? 0);
    const endBpReference = Math.max(startGeneB?.endPos ?? 0, endGeneB?.endPos ?? 0);

    return {
      startIdxQuery: block.startIdxA,
      endIdxQuery: block.endIdxA,
      startIdxReference: block.startIdxB,
      endIdxReference: block.endIdxB,
      startBpQuery,
      endBpQuery,
      startBpReference,
      endBpReference,
      score: block.score,
      orientation: block.orientation,
    };
  });
}

function sumCoverage(segments: Array<{ start: number; end: number }>): number {
  const filtered = segments
    .map((s) => ({
      start: Math.min(s.start, s.end),
      end: Math.max(s.start, s.end),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let currentStart = -1;
  let currentEnd = -1;

  for (const seg of filtered) {
    if (currentStart < 0) {
      currentStart = seg.start;
      currentEnd = seg.end;
      continue;
    }
    if (seg.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, seg.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = seg.start;
      currentEnd = seg.end;
    }
  }

  if (currentStart >= 0 && currentEnd > currentStart) {
    total += currentEnd - currentStart;
  }

  return total;
}

self.onmessage = (event: MessageEvent<SyntenyJob>) => {
  const job = event.data;
  const message: WorkerResponse = { ok: false };

  try {
    if (!job || !job.genesQuery?.length || !job.genesReference?.length) {
      throw new Error('Missing gene data for synteny analysis');
    }

    const analysis = alignSynteny(job.genesQuery, job.genesReference);
    const heatmap = buildHeatmap(job.genesQuery, job.genesReference);
    const blocksBp = toBpBlocks(analysis, job.genesQuery, job.genesReference);

    const coverageQuery = sumCoverage(blocksBp.map((b) => ({ start: b.startBpQuery, end: b.endBpQuery })));
    const coverageReference = sumCoverage(blocksBp.map((b) => ({ start: b.startBpReference, end: b.endBpReference })));

    const stats: SyntenyStats = {
      blockCount: blocksBp.length,
      globalScore: analysis.globalScore,
      dtwDistance: analysis.dtwDistance,
      coverageQuery,
      coverageReference,
    };

    message.ok = true;
    message.analysis = analysis;
    message.blocksBp = blocksBp;
    message.heatmap = heatmap;
    message.stats = stats;

    const transferList: Transferable[] = [];
    if (heatmap.values?.buffer) {
      transferList.push(heatmap.values.buffer);
    }

    (self as any).postMessage(message, transferList);
    return;
  } catch (err) {
    console.error('Synteny worker error:', err);
    message.error = err instanceof Error ? err.message : 'Synteny computation failed';
  }

  (self as any).postMessage(message);
};


