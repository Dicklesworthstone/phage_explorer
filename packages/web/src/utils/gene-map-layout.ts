import type { GeneStrandDirection } from './gene-strand';
import type { GeneInfo } from '@phage-explorer/core';

/** Preserve transcript segments so an intron or circular-origin gap is not painted as CDS. */
export function getGeneMapSegments(gene: GeneInfo): { start: number; end: number; strand: GeneInfo['strand'] }[] {
  const segments = gene.qualifiers?._segments;
  if (Array.isArray(segments)) {
    return segments.filter((segment): segment is { start: number; end: number; strand: '+' | '-' } => {
      if (!segment || typeof segment !== 'object') return false;
      const value = segment as Record<string, unknown>;
      return typeof value.start === 'number' && Number.isSafeInteger(value.start) && value.start >= 0 &&
        typeof value.end === 'number' && Number.isSafeInteger(value.end) && value.end > value.start &&
        (value.strand === '+' || value.strand === '-');
    });
  }
  return [{ start: Math.min(gene.startPos, gene.endPos), end: Math.max(gene.startPos, gene.endPos), strand: gene.strand }];
}

export interface GeneMapTrackLayout {
  y: number;
  height: number;
}

export const GENE_MAP_FORWARD_TRACK: GeneMapTrackLayout = Object.freeze({ y: 10, height: 12 });
export const GENE_MAP_REVERSE_TRACK: GeneMapTrackLayout = Object.freeze({ y: 30, height: 12 });
export const GENE_MAP_UNKNOWN_TRACK: GeneMapTrackLayout = Object.freeze({ y: 46, height: 12 });

const TRACKS: Readonly<Record<GeneStrandDirection, GeneMapTrackLayout>> = Object.freeze({
  forward: GENE_MAP_FORWARD_TRACK,
  reverse: GENE_MAP_REVERSE_TRACK,
  unknown: GENE_MAP_UNKNOWN_TRACK,
});

export function getGeneMapTrack(direction: GeneStrandDirection): GeneMapTrackLayout {
  return TRACKS[direction];
}

export function getGeneMapTrackDirectionAtY(y: number): GeneStrandDirection | null {
  if (!Number.isFinite(y)) return null;

  for (const direction of ['forward', 'reverse', 'unknown'] as const) {
    const track = TRACKS[direction];
    if (y >= track.y && y <= track.y + track.height) return direction;
  }

  return null;
}
