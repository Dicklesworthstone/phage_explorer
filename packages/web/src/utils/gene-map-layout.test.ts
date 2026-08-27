import { describe, expect, it } from 'bun:test';
import {
  GENE_MAP_FORWARD_TRACK,
  GENE_MAP_REVERSE_TRACK,
  GENE_MAP_UNKNOWN_TRACK,
  getGeneMapTrackDirectionAtY,
} from './gene-map-layout';

describe('gene-map tracks', () => {
  it('keeps the three strand states visually distinct', () => {
    expect(GENE_MAP_FORWARD_TRACK.y + GENE_MAP_FORWARD_TRACK.height)
      .toBeLessThan(GENE_MAP_REVERSE_TRACK.y);
    expect(GENE_MAP_REVERSE_TRACK.y + GENE_MAP_REVERSE_TRACK.height)
      .toBeLessThan(GENE_MAP_UNKNOWN_TRACK.y);
  });

  it('maps pointer coordinates to the correct strand track', () => {
    expect(getGeneMapTrackDirectionAtY(16)).toBe('forward');
    expect(getGeneMapTrackDirectionAtY(36)).toBe('reverse');
    expect(getGeneMapTrackDirectionAtY(52)).toBe('unknown');
    expect(getGeneMapTrackDirectionAtY(26)).toBeNull();
    expect(getGeneMapTrackDirectionAtY(Number.NaN)).toBeNull();
  });
});
