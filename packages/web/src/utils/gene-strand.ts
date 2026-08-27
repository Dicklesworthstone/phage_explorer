import type { GeneInfo } from '@phage-explorer/core';

export type GeneStrandDirection = 'forward' | 'reverse' | 'unknown';

export interface GeneStrandSummary {
  forward: number;
  reverse: number;
  unknown: number;
}

const FORWARD_STRANDS = new Set(['+', '+1', '1', 'forward', 'plus']);
const REVERSE_STRANDS = new Set(['-', '-1', 'reverse', 'minus']);

export function classifyGeneStrand(strand: string | null | undefined): GeneStrandDirection {
  const normalized = strand?.trim().toLowerCase() ?? '';
  if (FORWARD_STRANDS.has(normalized)) return 'forward';
  if (REVERSE_STRANDS.has(normalized)) return 'reverse';
  return 'unknown';
}

export function summarizeGeneStrands(genes: readonly Pick<GeneInfo, 'strand'>[]): GeneStrandSummary {
  const summary: GeneStrandSummary = { forward: 0, reverse: 0, unknown: 0 };

  for (const gene of genes) {
    summary[classifyGeneStrand(gene.strand)] += 1;
  }

  return summary;
}

export function formatGeneStrand(strand: string | null | undefined): string {
  switch (classifyGeneStrand(strand)) {
    case 'forward':
      return 'Forward (+)';
    case 'reverse':
      return 'Reverse (−)';
    default:
      return 'Unknown';
  }
}
