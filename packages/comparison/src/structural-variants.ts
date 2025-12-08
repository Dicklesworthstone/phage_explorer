import type { GeneInfo } from '@phage-explorer/core';
import type {
  StructuralVariantCall,
  StructuralVariantReport,
  StructuralVariantType,
} from './types';
import { alignSynteny } from './synteny';

interface StructuralVariantOptions {
  minGapBp?: number;
  minConfidence?: number;
  translocationDistance?: number;
  inversionMinFlip?: number;
}

const DEFAULT_OPTIONS: Required<StructuralVariantOptions> = {
  minGapBp: 500, // ignore tiny gaps likely to be annotation jitter
  minConfidence: 0.15,
  translocationDistance: 2000,
  inversionMinFlip: 3, // minimum gene index delta to flag inversion
};

type Anchor = {
  startIdxA: number;
  endIdxA: number;
  startIdxB: number;
  endIdxB: number;
};

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function geneRange(genes: GeneInfo[], startIdx: number, endIdx: number): [number, number] {
  const start = genes[startIdx]?.startPos ?? 0;
  const end = genes[endIdx]?.endPos ?? start;
  return [Math.min(start, end), Math.max(start, end)];
}

function collectGenes(
  genes: GeneInfo[],
  start: number,
  end: number
): string[] {
  return genes
    .filter(g => g.startPos >= start && g.endPos <= end)
    .map(g => g.name || g.product || g.locusTag || `gene-${g.id ?? 'unknown'}`)
    .slice(0, 8);
}

function makeCall(
  type: StructuralVariantType,
  anchor: Anchor,
  genesA: GeneInfo[],
  genesB: GeneInfo[],
  spans: { startA: number; endA: number; startB: number; endB: number },
  sizeA: number,
  sizeB: number,
  confidence: number,
  evidence: string[]
): StructuralVariantCall {
  return {
    id: `${type}-${spans.startA}-${spans.startB}-${Math.abs(sizeA - sizeB)}`,
    type,
    startA: spans.startA,
    endA: spans.endA,
    startB: spans.startB,
    endB: spans.endB,
    sizeA,
    sizeB,
    confidence: clamp01(confidence),
    anchorA: { startIdx: anchor.startIdxA, endIdx: anchor.endIdxA },
    anchorB: { startIdx: anchor.startIdxB, endIdx: anchor.endIdxB },
    evidence,
    affectedGenesA: collectGenes(genesA, spans.startA, spans.endA),
    affectedGenesB: collectGenes(genesB, spans.startB, spans.endB),
  };
}

export function analyzeStructuralVariants(
  sequenceA: string,
  sequenceB: string,
  genesA: GeneInfo[] = [],
  genesB: GeneInfo[] = [],
  options: StructuralVariantOptions = {}
): StructuralVariantReport {
  const cfg = { ...DEFAULT_OPTIONS, ...options };

  if (genesA.length < 2 || genesB.length < 2) {
    return {
      calls: [],
      counts: { deletion: 0, insertion: 0, inversion: 0, duplication: 0, translocation: 0 },
      anchorsUsed: 0,
    };
  }

  const synteny = alignSynteny(genesA, genesB);
  const blocks = [...synteny.blocks].sort((a, b) => a.startIdxA - b.startIdxA);

  if (blocks.length < 2) {
    return {
      calls: [],
      counts: { deletion: 0, insertion: 0, inversion: 0, duplication: 0, translocation: 0 },
      anchorsUsed: blocks.length,
    };
  }

  const calls: StructuralVariantCall[] = [];

  for (let i = 0; i < blocks.length - 1; i++) {
    const current = blocks[i];
    const next = blocks[i + 1];

    const [currStartA, currEndA] = geneRange(genesA, current.startIdxA, current.endIdxA);
    const [currStartB, currEndB] = geneRange(genesB, current.startIdxB, current.endIdxB);
    const [nextStartA, nextEndA] = geneRange(genesA, next.startIdxA, next.endIdxA);
    const [nextStartB, nextEndB] = geneRange(genesB, next.startIdxB, next.endIdxB);

    const gapA = Math.max(0, nextStartA - currEndA);
    const gapB = Math.max(0, nextStartB - currEndB);
    const avgGap = (gapA + gapB) / 2;

    const anchor: Anchor = {
      startIdxA: current.endIdxA,
      endIdxA: next.startIdxA,
      startIdxB: current.endIdxB,
      endIdxB: next.startIdxB,
    };

    // Inversion: order flips between anchors
    if (nextStartB < currStartB - cfg.inversionMinFlip) {
      const spanA = [currEndA, nextStartA] as [number, number];
      const spanB = [nextStartB, currEndB] as [number, number];
      const sizeA = Math.abs(spanA[1] - spanA[0]);
      const sizeB = Math.abs(spanB[1] - spanB[0]);
      const confidence = clamp01(0.6 + 0.4 * (1 - Math.abs(sizeA - sizeB) / Math.max(sizeA, sizeB, 1)));
      calls.push(
        makeCall(
          'inversion',
          anchor,
          genesA,
          genesB,
          {
            startA: Math.min(...spanA),
            endA: Math.max(...spanA),
            startB: Math.min(...spanB),
            endB: Math.max(...spanB),
          },
          sizeA,
          sizeB,
          confidence,
          ['anchor order flip']
        )
      );
      continue;
    }

    // Large asymmetric gaps => insertion/deletion
    if (gapA > cfg.minGapBp || gapB > cfg.minGapBp) {
      const sizeDiff = Math.abs(gapA - gapB);
      const larger = Math.max(gapA, gapB);
      const rel = larger === 0 ? 0 : sizeDiff / larger;
      if (rel > 0.3) {
        const isDeletionInB = gapA > gapB;
        const type: StructuralVariantType = isDeletionInB ? 'deletion' : 'insertion';
        const spanA = [currEndA, nextStartA];
        const spanB = [currEndB, nextStartB];
        const sizeA = gapA;
        const sizeB = gapB;
        const confidence = clamp01(0.5 + rel * 0.5);
        calls.push(
          makeCall(
            type,
            anchor,
            genesA,
            genesB,
            {
              startA: Math.min(...spanA),
              endA: Math.max(...spanA),
              startB: Math.min(...spanB),
              endB: Math.max(...spanB),
            },
            sizeA,
            sizeB,
            confidence,
            [
              `gapA=${gapA}`,
              `gapB=${gapB}`,
              isDeletionInB ? 'missing sequence in genome B' : 'extra sequence in genome B',
            ]
          )
        );
        continue;
      }
    }

    // Re-ordered distant anchors => translocation
    const deltaA = nextStartA - currStartA;
    const deltaB = nextStartB - currStartB;
    const distanceDiff = Math.abs(Math.abs(deltaA) - Math.abs(deltaB));
    if (distanceDiff > cfg.translocationDistance && avgGap > cfg.minGapBp) {
      const spanA = [currEndA, nextStartA];
      const spanB = [currEndB, nextStartB];
      const sizeA = Math.abs(spanA[1] - spanA[0]);
      const sizeB = Math.abs(spanB[1] - spanB[0]);
      const confidence = clamp01(0.4 + Math.min(distanceDiff / 10000, 0.6));
      calls.push(
        makeCall(
          'translocation',
          anchor,
          genesA,
          genesB,
          {
            startA: Math.min(...spanA),
            endA: Math.max(...spanA),
            startB: Math.min(...spanB),
            endB: Math.max(...spanB),
          },
          sizeA,
          sizeB,
          confidence,
          ['anchor spacing mismatch', `|Δ|=${distanceDiff}`]
        )
      );
      continue;
    }

    // Small asymmetric gain suggest duplication
    if (avgGap > 0 && Math.abs(gapA - gapB) / Math.max(avgGap, 1) < 0.25 && avgGap > cfg.minGapBp / 2) {
      const spanA = [currEndA, nextStartA];
      const spanB = [currEndB, nextStartB];
      const sizeA = gapA;
      const sizeB = gapB;
      const confidence = clamp01(0.3 + (avgGap / (cfg.minGapBp * 2)));
      calls.push(
        makeCall(
          'duplication',
          anchor,
          genesA,
          genesB,
          {
            startA: Math.min(...spanA),
            endA: Math.max(...spanA),
            startB: Math.min(...spanB),
            endB: Math.max(...spanB),
          },
          sizeA,
          sizeB,
          confidence,
          ['similar gap sizes, possible tandem duplication']
        )
      );
    }
  }

  // Filter low-confidence calls
  const filtered = calls.filter(c => c.confidence >= cfg.minConfidence);
  const counts = filtered.reduce<Record<StructuralVariantType, number>>(
    (acc, c) => {
      acc[c.type] += 1;
      return acc;
    },
    { deletion: 0, insertion: 0, inversion: 0, duplication: 0, translocation: 0 }
  );

  return {
    calls: filtered,
    counts,
    anchorsUsed: blocks.length,
  };
}

