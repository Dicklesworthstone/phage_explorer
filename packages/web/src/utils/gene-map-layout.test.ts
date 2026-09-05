import { describe, expect, it } from 'bun:test';
import {
  GENE_MAP_FORWARD_TRACK,
  GENE_MAP_REVERSE_TRACK,
  GENE_MAP_UNKNOWN_TRACK,
  getGeneMapTrackDirectionAtY,
} from './gene-map-layout';
import { importLocalGenomes, getGeneMapSegments } from '@phage-explorer/core';

describe('gene-map tracks', () => {
  it('renders reverse joined CDS segments without filling their intervening bases', async () => {
    const input = 'LOCUS       X 24 bp DNA circular\nFEATURES             Location/Qualifiers\n     CDS             complement(join(1..6,19..24))\nORIGIN\n        1 atgaaacccgggtttaaaccctag\n//\n';
    const { genomes } = await importLocalGenomes({ name: 'x.gb', text: input });
    const segments = getGeneMapSegments(genomes[0].phage.genes[0]);
    expect(segments).toEqual([{ start: 18, end: 24, strand: '-' }, { start: 0, end: 6, strand: '-' }]);
    expect(segments.some(segment => segment.start <= 12 && segment.end > 12)).toBe(false);
  });
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
