/**
 * Unit tests for Environmental & Geospatial Provenance Map
 */

import { describe, it, expect } from 'bun:test';
import {
  computeNoveltyScore,
  computeBiomeDistribution,
  computeGeoHeatmap,
  analyzeProvenance,
  generateDemoProvenanceData,
  generateAsciiWorldMap,
  BIOME_NAMES,
  BIOME_COLORS,
  type MetagenomeHit,
  type BiomeType,
} from './environmental-provenance';

const createMockHit = (overrides: Partial<MetagenomeHit> = {}): MetagenomeHit => ({
  metagenomeId: 'TEST_001',
  source: 'IMG/VR',
  containment: 0.5,
  biome: 'gut',
  location: {
    latitude: 40.0,
    longitude: -100.0,
    country: 'USA',
    region: 'Midwest',
  },
  sampleDate: '2023-06',
  description: 'Test sample',
  ...overrides,
});

describe('computeNoveltyScore', () => {
  it('returns no score for no hits, rather than calling the phage novel', () => {
    // This test previously asserted score 1.0 / 'novel' for an empty hit list,
    // locking in the defect. An empty search supports no conclusion: it is
    // equally consistent with a genuinely novel phage and with an API that
    // returned nothing. Reporting "entirely novel" from zero evidence is the
    // strongest possible claim made on the weakest possible basis.
    expect(computeNoveltyScore([])).toBeNull();
  });

  it('returns no score when hits exist but none carry a containment', () => {
    // The live failure this fixes. SRA metadata yields locations and sample
    // counts but never sequences, so the overlay built hits with containment 0
    // and every phage in the catalogue rendered as "100% NOVEL" beneath a green
    // REAL DATA banner. Null means not measured; 0 means measured and absent.
    const hits = [
      createMockHit({ containment: null }),
      createMockHit({ containment: null, biome: 'marine' }),
    ];
    expect(computeNoveltyScore(hits)).toBeNull();
  });

  it('still scores when only some hits carry a containment', () => {
    // The discrimination check. If the guard above were implemented as "any
    // null anywhere means null", a single unmeasured hit would suppress a real
    // result, which is the opposite failure.
    const hits = [
      createMockHit({ containment: null }),
      createMockHit({ containment: 0.6, biome: 'marine' }),
    ];
    const result = computeNoveltyScore(hits);
    expect(result).not.toBeNull();
    expect(result!.maxContainment).toBeCloseTo(0.6, 5);
    expect(result!.totalHits).toBe(1); // counts measured hits, not all hits
  });

  it('classifies as novel for low containment', () => {
    const hits = [createMockHit({ containment: 0.05 })];
    const result = computeNoveltyScore(hits);
    expect(result!.classification).toBe('novel');
    expect(result!.score).toBeCloseTo(0.95, 2);
  });

  it('classifies as rare for containment 0.1-0.3', () => {
    const hits = [createMockHit({ containment: 0.2 })];
    const result = computeNoveltyScore(hits);
    expect(result!.classification).toBe('rare');
  });

  it('classifies as uncommon for containment 0.3-0.5', () => {
    const hits = [createMockHit({ containment: 0.4 })];
    const result = computeNoveltyScore(hits);
    expect(result!.classification).toBe('uncommon');
  });

  it('classifies as known for containment 0.5-0.7', () => {
    const hits = [createMockHit({ containment: 0.6 })];
    const result = computeNoveltyScore(hits);
    expect(result!.classification).toBe('known');
  });

  it('classifies as well_characterized for containment >= 0.7', () => {
    const hits = [createMockHit({ containment: 0.85 })];
    const result = computeNoveltyScore(hits);
    expect(result!.classification).toBe('well_characterized');
  });

  it('uses max containment across multiple hits', () => {
    const hits = [
      createMockHit({ containment: 0.3 }),
      createMockHit({ containment: 0.8 }),
      createMockHit({ containment: 0.5 }),
    ];
    const result = computeNoveltyScore(hits);
    expect(result!.maxContainment).toBe(0.8);
    expect(result!.classification).toBe('well_characterized');
  });

  it('provides interpretation text', () => {
    const hits = [createMockHit({ containment: 0.75, biome: 'marine' })];
    const result = computeNoveltyScore(hits);
    expect(result!.interpretation).toContain('marine');
    expect(result!.interpretation.length).toBeGreaterThan(20);
  });
});

describe('computeBiomeDistribution', () => {
  it('returns empty array for no hits', () => {
    const result = computeBiomeDistribution([]);
    expect(result).toEqual([]);
  });

  it('groups hits by biome', () => {
    const hits = [
      createMockHit({ biome: 'gut', containment: 0.8 }),
      createMockHit({ biome: 'gut', containment: 0.6 }),
      createMockHit({ biome: 'marine', containment: 0.5 }),
    ];
    const result = computeBiomeDistribution(hits);

    expect(result!.length).toBe(2);
    const gutBiome = result.find(b => b.biome === 'gut');
    const marineBiome = result.find(b => b.biome === 'marine');

    expect(gutBiome?.hitCount).toBe(2);
    expect(gutBiome?.maxContainment).toBe(0.8);
    expect(marineBiome?.hitCount).toBe(1);
  });

  it('sorts by max containment descending', () => {
    const hits = [
      createMockHit({ biome: 'soil', containment: 0.3 }),
      createMockHit({ biome: 'marine', containment: 0.9 }),
      createMockHit({ biome: 'gut', containment: 0.6 }),
    ];
    const result = computeBiomeDistribution(hits);

    expect(result[0].biome).toBe('marine');
    expect(result[1].biome).toBe('gut');
    expect(result[2].biome).toBe('soil');
  });

  it('computes average containment correctly', () => {
    const hits = [
      createMockHit({ biome: 'gut', containment: 0.4 }),
      createMockHit({ biome: 'gut', containment: 0.6 }),
    ];
    const result = computeBiomeDistribution(hits);

    expect(result[0].avgContainment).toBeCloseTo(0.5, 2);
  });
});

describe('computeGeoHeatmap', () => {
  it('returns empty array for no hits', () => {
    const result = computeGeoHeatmap([]);
    expect(result).toEqual([]);
  });

  it('groups nearby locations', () => {
    const hits = [
      createMockHit({
        location: { latitude: 40.4, longitude: -100.4, country: 'USA' },
        containment: 0.8,
      }),
      createMockHit({
        location: { latitude: 40.3, longitude: -100.3, country: 'USA' },
        containment: 0.6,
      }),
    ];
    const result = computeGeoHeatmap(hits);

    // Both round to (40, -100) so should be in same grid cell
    expect(result.length).toBe(1);
    expect(result[0].intensity).toBe(0.8); // Max of 0.8 and 0.6
  });

  it('separates distant locations', () => {
    const hits = [
      createMockHit({
        location: { latitude: 40.0, longitude: -100.0, country: 'USA' },
        containment: 0.7,
      }),
      createMockHit({
        location: { latitude: -30.0, longitude: 150.0, country: 'Australia' },
        containment: 0.5,
      }),
    ];
    const result = computeGeoHeatmap(hits);

    expect(result.length).toBe(2);
  });

  it('uses containment as intensity', () => {
    const hits = [
      createMockHit({
        location: { latitude: 50.0, longitude: 10.0, country: 'Germany' },
        containment: 0.65,
      }),
    ];
    const result = computeGeoHeatmap(hits);

    expect(result[0].intensity).toBe(0.65);
  });
});

describe('analyzeProvenance', () => {
  it('returns complete analysis result', () => {
    const hits = [
      createMockHit({ biome: 'gut', containment: 0.7 }),
      createMockHit({ biome: 'marine', containment: 0.4 }),
    ];
    const result = analyzeProvenance(hits);

    expect(result.novelty).toBeDefined();
    expect(result.biomeDistribution).toBeDefined();
    expect(result.topHits).toBeDefined();
    expect(result.geoHeatmap).toBeDefined();
    expect(result.primaryHabitat).toBe('gut');
    expect(result.ecologicalContext).toBeDefined();
  });

  it('limits topHits to 10', () => {
    const hits = Array.from({ length: 15 }, (_, i) =>
      createMockHit({ metagenomeId: `TEST_${i}`, containment: i / 20 })
    );
    const result = analyzeProvenance(hits);

    expect(result.topHits.length).toBe(10);
  });

  it('sorts topHits by containment descending', () => {
    const hits = [
      createMockHit({ metagenomeId: 'A', containment: 0.3 }),
      createMockHit({ metagenomeId: 'B', containment: 0.9 }),
      createMockHit({ metagenomeId: 'C', containment: 0.6 }),
    ];
    const result = analyzeProvenance(hits);

    expect(result.topHits[0].metagenomeId).toBe('B');
    expect(result.topHits[1].metagenomeId).toBe('C');
    expect(result.topHits[2].metagenomeId).toBe('A');
  });

  it('identifies primary habitat as unknown for empty hits', () => {
    const result = analyzeProvenance([]);
    expect(result.primaryHabitat).toBe('unknown');
  });

  it('provides ecological context interpretation', () => {
    const hits = [
      createMockHit({ biome: 'gut', containment: 0.8 }),
      createMockHit({ biome: 'wastewater', containment: 0.3 }),
    ];
    const result = analyzeProvenance(hits);

    expect(result.ecologicalContext).toContain('gut');
    expect(result.ecologicalContext.length).toBeGreaterThan(20);
  });
});

describe('generateDemoProvenanceData', () => {
  it('generates array of hits', () => {
    const data = generateDemoProvenanceData('test-phage');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('generates between 5-15 hits', () => {
    const data = generateDemoProvenanceData('test');
    expect(data.length).toBeGreaterThanOrEqual(5);
    expect(data.length).toBeLessThanOrEqual(15);
  });

  it('generates hits sorted by containment', () => {
    const data = generateDemoProvenanceData('phage-123');
    for (let i = 1; i < data.length; i++) {
      expect(data[i - 1].containment!).toBeGreaterThanOrEqual(data[i].containment!);
    }
  });

  it('generates valid biome types', () => {
    const validBiomes = Object.keys(BIOME_NAMES);
    const data = generateDemoProvenanceData('test');

    for (const hit of data) {
      expect(validBiomes).toContain(hit.biome);
    }
  });

  it('generates valid sources', () => {
    const validSources = ['IMG/VR', 'MGnify', 'VIROME'];
    const data = generateDemoProvenanceData('test');

    for (const hit of data) {
      expect(validSources).toContain(hit.source);
    }
  });

  it('generates valid locations with country', () => {
    const data = generateDemoProvenanceData('test');

    for (const hit of data) {
      expect(hit.location.country).toBeDefined();
      expect(hit.location.latitude).toBeGreaterThanOrEqual(-90);
      expect(hit.location.latitude).toBeLessThanOrEqual(90);
      expect(hit.location.longitude).toBeGreaterThanOrEqual(-180);
      expect(hit.location.longitude).toBeLessThanOrEqual(180);
    }
  });

  it('generates containment between 0 and 1', () => {
    const data = generateDemoProvenanceData('test');

    for (const hit of data) {
      expect(hit.containment).toBeGreaterThan(0);
      expect(hit.containment).toBeLessThanOrEqual(1);
    }
  });

  it('produces different results for different phage names', () => {
    const data1 = generateDemoProvenanceData('phage-alpha');
    const data2 = generateDemoProvenanceData('phage-beta');

    // At least one property should differ
    const same = data1.length === data2.length &&
      data1.every((h, i) => h.containment === data2[i].containment);
    expect(same).toBe(false);
  });
});

describe('generateAsciiWorldMap', () => {
  it('returns string of correct dimensions', () => {
    const hits = [createMockHit()];
    const map = generateAsciiWorldMap(hits, 40, 15);
    const lines = map.split('\n');

    expect(lines.length).toBe(15);
    for (const line of lines) {
      expect(line.length).toBe(40);
    }
  });

  it('returns empty map for no hits', () => {
    const map = generateAsciiWorldMap([], 30, 10);
    expect(map).toBeDefined();
    expect(map.split('\n').length).toBe(10);
  });

  it('places markers at hit locations', () => {
    const hits = [
      createMockHit({
        location: { latitude: 0, longitude: 0, country: 'Test' },
        containment: 0.8,
      }),
    ];
    const map = generateAsciiWorldMap(hits, 60, 20);

    // Should contain a marker character
    expect(map).toMatch(/[\u25CF\u25CB\u00B7]/);
  });

  it('uses different markers based on containment', () => {
    // This is a visual test - just ensure it doesn't crash
    const hits = [
      createMockHit({ containment: 0.9 }), // High - filled circle
      createMockHit({ containment: 0.5 }), // Medium - empty circle
      createMockHit({ containment: 0.2 }), // Low - dot
    ];
    const map = generateAsciiWorldMap(hits, 60, 20);
    expect(map).toBeDefined();
  });
});

describe('BIOME_NAMES', () => {
  it('has names for all biome types', () => {
    const biomes: BiomeType[] = [
      'gut', 'marine', 'freshwater', 'soil', 'hot_spring',
      'wastewater', 'clinical', 'food', 'unknown',
    ];

    for (const biome of biomes) {
      expect(BIOME_NAMES[biome]).toBeDefined();
      expect(typeof BIOME_NAMES[biome]).toBe('string');
    }
  });
});

describe('BIOME_COLORS', () => {
  it('has colors for all biome types', () => {
    const biomes: BiomeType[] = [
      'gut', 'marine', 'freshwater', 'soil', 'hot_spring',
      'wastewater', 'clinical', 'food', 'unknown',
    ];

    for (const biome of biomes) {
      expect(BIOME_COLORS[biome]).toBeDefined();
      expect(BIOME_COLORS[biome]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
