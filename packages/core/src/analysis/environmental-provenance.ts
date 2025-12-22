/**
 * Environmental & Geospatial Provenance Map
 *
 * Maps phages to metagenomic hits across biomes/locations to infer
 * habitat, ecological niche, and novelty.
 *
 * In a production environment, this would query Mash/FracMinHash sketch
 * indexes of public metagenomes (IMG/VR, MGnify). This implementation
 * provides demo data and analysis patterns.
 */

// =============================================================================
// Types
// =============================================================================

/** Biome classification */
export type BiomeType =
  | 'gut'
  | 'marine'
  | 'freshwater'
  | 'soil'
  | 'hot_spring'
  | 'wastewater'
  | 'clinical'
  | 'food'
  | 'unknown';

/** Geographic region */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  country: string;
  region?: string;
}

/** A metagenomic hit with containment score */
export interface MetagenomeHit {
  /** Metagenome accession or ID */
  metagenomeId: string;
  /** Source database (e.g., IMG/VR, MGnify) */
  source: 'IMG/VR' | 'MGnify' | 'VIROME' | 'other';
  /** Containment score (0-1): fraction of query k-mers in metagenome */
  containment: number;
  /** Jaccard similarity (0-1) */
  jaccard?: number;
  /** Biome classification */
  biome: BiomeType;
  /** Geographic origin */
  location: GeoLocation;
  /** Sample date if available */
  sampleDate?: string;
  /** Sample description */
  description?: string;
}

/** Biome distribution summary */
export interface BiomeDistribution {
  biome: BiomeType;
  /** Maximum containment in this biome */
  maxContainment: number;
  /** Number of hits in this biome */
  hitCount: number;
  /** Average containment across hits */
  avgContainment: number;
}

/** Novelty assessment */
export interface NoveltyScore {
  /** Overall novelty (1 - max_containment) */
  score: number;
  /** Novelty classification */
  classification: 'novel' | 'rare' | 'uncommon' | 'known' | 'well_characterized';
  /** Number of metagenome hits */
  totalHits: number;
  /** Max containment found */
  maxContainment: number;
  /** Interpretation text */
  interpretation: string;
}

/** Complete provenance analysis result */
export interface ProvenanceResult {
  /** Novelty assessment */
  novelty: NoveltyScore;
  /** Biome distribution */
  biomeDistribution: BiomeDistribution[];
  /** Top metagenome hits */
  topHits: MetagenomeHit[];
  /** Geographic heat map data (lat, lon, intensity) */
  geoHeatmap: Array<{ lat: number; lon: number; intensity: number }>;
  /** Primary habitat inference */
  primaryHabitat: BiomeType;
  /** Ecological interpretation */
  ecologicalContext: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Biome display names */
export const BIOME_NAMES: Record<BiomeType, string> = {
  gut: 'Gut Microbiome',
  marine: 'Marine',
  freshwater: 'Freshwater',
  soil: 'Soil',
  hot_spring: 'Hot Spring / Thermal',
  wastewater: 'Wastewater / Sewage',
  clinical: 'Clinical Isolate',
  food: 'Food / Fermented',
  unknown: 'Unknown',
};

/** Biome colors for visualization */
export const BIOME_COLORS: Record<BiomeType, string> = {
  gut: '#e74c3c',       // Red
  marine: '#3498db',    // Blue
  freshwater: '#1abc9c', // Teal
  soil: '#8b4513',      // Brown
  hot_spring: '#e67e22', // Orange
  wastewater: '#9b59b6', // Purple
  clinical: '#e91e63',  // Pink
  food: '#27ae60',      // Green
  unknown: '#95a5a6',   // Gray
};

// =============================================================================
// Novelty Classification
// =============================================================================

/**
 * Classify novelty based on max containment
 */
function classifyNovelty(maxContainment: number): NoveltyScore['classification'] {
  if (maxContainment < 0.1) return 'novel';
  if (maxContainment < 0.3) return 'rare';
  if (maxContainment < 0.5) return 'uncommon';
  if (maxContainment < 0.7) return 'known';
  return 'well_characterized';
}

/**
 * Get novelty interpretation text
 */
function getNoveltyInterpretation(
  classification: NoveltyScore['classification'],
  primaryBiome: BiomeType
): string {
  const biomeName = BIOME_NAMES[primaryBiome].toLowerCase();

  switch (classification) {
    case 'novel':
      return `This phage shows minimal similarity to known metagenomes, suggesting it represents a novel lineage not previously captured in ${biomeName} or other environments.`;
    case 'rare':
      return `This phage has low representation in public metagenomes, indicating it may be a rare variant or from an undersampled niche within ${biomeName} environments.`;
    case 'uncommon':
      return `This phage shows moderate similarity to metagenomes, primarily from ${biomeName} samples. It may represent a specialized lineage.`;
    case 'known':
      return `This phage is well-represented in ${biomeName} metagenomes, indicating it circulates commonly in this environment.`;
    case 'well_characterized':
      return `This phage is highly similar to sequences in public metagenomes, particularly from ${biomeName}. It belongs to a well-studied lineage.`;
  }
}

// =============================================================================
// Core Analysis Functions
// =============================================================================

/**
 * Compute novelty score from metagenome hits
 */
export function computeNoveltyScore(hits: MetagenomeHit[]): NoveltyScore {
  if (hits.length === 0) {
    return {
      score: 1.0,
      classification: 'novel',
      totalHits: 0,
      maxContainment: 0,
      interpretation: 'No metagenomic matches found. This phage appears to be entirely novel.',
    };
  }

  const maxContainment = Math.max(...hits.map(h => h.containment));
  const classification = classifyNovelty(maxContainment);
  const primaryBiome = hits.reduce((best, h) =>
    h.containment > best.containment ? h : best
  ).biome;

  return {
    score: 1 - maxContainment,
    classification,
    totalHits: hits.length,
    maxContainment,
    interpretation: getNoveltyInterpretation(classification, primaryBiome),
  };
}

/**
 * Compute biome distribution from hits
 */
export function computeBiomeDistribution(hits: MetagenomeHit[]): BiomeDistribution[] {
  const biomes = new Map<BiomeType, MetagenomeHit[]>();

  for (const hit of hits) {
    const existing = biomes.get(hit.biome) ?? [];
    existing.push(hit);
    biomes.set(hit.biome, existing);
  }

  const distribution: BiomeDistribution[] = [];

  for (const [biome, biomeHits] of biomes) {
    const containments = biomeHits.map(h => h.containment);
    distribution.push({
      biome,
      maxContainment: Math.max(...containments),
      hitCount: biomeHits.length,
      avgContainment: containments.reduce((a, b) => a + b, 0) / containments.length,
    });
  }

  // Sort by max containment descending
  distribution.sort((a, b) => b.maxContainment - a.maxContainment);

  return distribution;
}

/**
 * Generate geographic heatmap data
 */
export function computeGeoHeatmap(
  hits: MetagenomeHit[]
): Array<{ lat: number; lon: number; intensity: number }> {
  // Group hits by approximate location (1 degree grid)
  const grid = new Map<string, { lat: number; lon: number; containments: number[] }>();

  for (const hit of hits) {
    const { latitude, longitude } = hit.location;
    const key = `${Math.round(latitude)},${Math.round(longitude)}`;

    const existing = grid.get(key);
    if (existing) {
      existing.containments.push(hit.containment);
    } else {
      grid.set(key, {
        lat: latitude,
        lon: longitude,
        containments: [hit.containment],
      });
    }
  }

  return Array.from(grid.values()).map(({ lat, lon, containments }) => ({
    lat,
    lon,
    intensity: Math.max(...containments),
  }));
}

/**
 * Infer ecological context from distribution
 */
function inferEcologicalContext(
  biomeDistribution: BiomeDistribution[],
  novelty: NoveltyScore
): string {
  if (biomeDistribution.length === 0) {
    return 'Ecological context unknown due to lack of metagenomic matches.';
  }

  const primary = biomeDistribution[0];
  const biomeName = BIOME_NAMES[primary.biome];

  if (biomeDistribution.length === 1) {
    return `This phage appears specialized for ${biomeName.toLowerCase()} environments with no significant presence in other habitats.`;
  }

  const secondary = biomeDistribution[1];
  const secondaryName = BIOME_NAMES[secondary.biome];

  if (primary.maxContainment - secondary.maxContainment < 0.1) {
    return `This phage shows broad ecological distribution, with similar prevalence in ${biomeName.toLowerCase()} and ${secondaryName.toLowerCase()} environments.`;
  }

  return `This phage is primarily associated with ${biomeName.toLowerCase()} (${(primary.maxContainment * 100).toFixed(0)}% containment) with secondary presence in ${secondaryName.toLowerCase()} (${(secondary.maxContainment * 100).toFixed(0)}% containment).`;
}

/**
 * Run complete provenance analysis
 */
export function analyzeProvenance(hits: MetagenomeHit[]): ProvenanceResult {
  const novelty = computeNoveltyScore(hits);
  const biomeDistribution = computeBiomeDistribution(hits);
  const geoHeatmap = computeGeoHeatmap(hits);

  // Sort hits by containment
  const sortedHits = [...hits].sort((a, b) => b.containment - a.containment);
  const topHits = sortedHits.slice(0, 10);

  const primaryHabitat = biomeDistribution.length > 0
    ? biomeDistribution[0].biome
    : 'unknown';

  const ecologicalContext = inferEcologicalContext(biomeDistribution, novelty);

  return {
    novelty,
    biomeDistribution,
    topHits,
    geoHeatmap,
    primaryHabitat,
    ecologicalContext,
  };
}

// =============================================================================
// Demo Data Generation
// =============================================================================

/** Demo location pool */
const DEMO_LOCATIONS: Array<{ location: GeoLocation; biome: BiomeType }> = [
  { location: { latitude: 37.7749, longitude: -122.4194, country: 'USA', region: 'California' }, biome: 'gut' },
  { location: { latitude: 51.5074, longitude: -0.1278, country: 'UK', region: 'England' }, biome: 'wastewater' },
  { location: { latitude: 52.5200, longitude: 13.4050, country: 'Germany', region: 'Berlin' }, biome: 'gut' },
  { location: { latitude: 35.6762, longitude: 139.6503, country: 'Japan', region: 'Tokyo' }, biome: 'gut' },
  { location: { latitude: -23.5505, longitude: -46.6333, country: 'Brazil', region: 'Sao Paulo' }, biome: 'freshwater' },
  { location: { latitude: 39.9042, longitude: 116.4074, country: 'China', region: 'Beijing' }, biome: 'soil' },
  { location: { latitude: -33.9249, longitude: 18.4241, country: 'South Africa', region: 'Cape Town' }, biome: 'marine' },
  { location: { latitude: 55.7558, longitude: 37.6173, country: 'Russia', region: 'Moscow' }, biome: 'wastewater' },
  { location: { latitude: 19.4326, longitude: -99.1332, country: 'Mexico', region: 'Mexico City' }, biome: 'gut' },
  { location: { latitude: -34.6037, longitude: -58.3816, country: 'Argentina', region: 'Buenos Aires' }, biome: 'freshwater' },
  { location: { latitude: 64.1466, longitude: -21.9426, country: 'Iceland', region: 'Reykjavik' }, biome: 'hot_spring' },
  { location: { latitude: 1.3521, longitude: 103.8198, country: 'Singapore' }, biome: 'marine' },
  { location: { latitude: 41.9028, longitude: 12.4964, country: 'Italy', region: 'Rome' }, biome: 'food' },
  { location: { latitude: 48.8566, longitude: 2.3522, country: 'France', region: 'Paris' }, biome: 'clinical' },
  { location: { latitude: -37.8136, longitude: 144.9631, country: 'Australia', region: 'Melbourne' }, biome: 'gut' },
];

/**
 * Generate demo metagenome hits for a phage
 *
 * @param phageName Phage name/ID for seeded randomness
 * @param rng Optional random number generator
 * @returns Array of demo metagenome hits
 */
export function generateDemoProvenanceData(
  phageName: string = 'demo',
  rng: () => number = Math.random
): MetagenomeHit[] {
  // Use phage name to seed some variation
  const seed = phageName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const seededRng = () => {
    const x = Math.sin(seed + rng() * 1000) * 10000;
    return x - Math.floor(x);
  };

  // Determine primary biome based on phage name
  const biomes: BiomeType[] = ['gut', 'marine', 'freshwater', 'soil', 'wastewater'];
  const primaryBiome = biomes[seed % biomes.length];

  // Generate 5-15 hits
  const numHits = 5 + Math.floor(seededRng() * 11);
  const hits: MetagenomeHit[] = [];

  for (let i = 0; i < numHits; i++) {
    const locationData = DEMO_LOCATIONS[Math.floor(seededRng() * DEMO_LOCATIONS.length)];

    // Bias containment toward primary biome
    let containment = seededRng() * 0.6 + 0.1; // 0.1-0.7 base
    if (locationData.biome === primaryBiome) {
      containment = Math.min(0.95, containment + 0.2); // Boost for primary biome
    }

    // First hit is always highest containment
    if (i === 0) {
      containment = 0.65 + seededRng() * 0.3; // 0.65-0.95
    }

    const sources: MetagenomeHit['source'][] = ['IMG/VR', 'MGnify', 'VIROME'];
    const source = sources[Math.floor(seededRng() * sources.length)];

    // Generate sample date in last 5 years
    const year = 2020 + Math.floor(seededRng() * 5);
    const month = 1 + Math.floor(seededRng() * 12);
    const sampleDate = `${year}-${String(month).padStart(2, '0')}`;

    hits.push({
      metagenomeId: `${source}_${year}${String(i).padStart(4, '0')}`,
      source,
      containment: Math.round(containment * 100) / 100,
      jaccard: Math.round(containment * 0.7 * 100) / 100,
      biome: locationData.biome,
      location: locationData.location,
      sampleDate,
      description: `${BIOME_NAMES[locationData.biome]} sample from ${locationData.location.country}`,
    });
  }

  // Sort by containment descending
  hits.sort((a, b) => b.containment - a.containment);

  return hits;
}

// =============================================================================
// Utility: World Map ASCII Art
// =============================================================================

/**
 * Generate a simple ASCII world map with hit markers
 *
 * @param hits Metagenome hits with locations
 * @param width Map width in characters
 * @param height Map height in characters
 * @returns ASCII art world map string
 */
export function generateAsciiWorldMap(
  hits: MetagenomeHit[],
  width: number = 60,
  height: number = 20
): string {
  // Simple equirectangular projection
  const map: string[][] = Array.from({ length: height }, () =>
    Array(width).fill(' ')
  );

  // Convert lat/lon to map coordinates
  const latToY = (lat: number) => Math.floor((90 - lat) / 180 * height);
  const lonToX = (lon: number) => Math.floor((lon + 180) / 360 * width);

  // Draw basic continents outline (simplified)
  const continentPoints = [
    // North America
    { lat: 40, lon: -100 }, { lat: 45, lon: -90 }, { lat: 50, lon: -100 },
    // South America
    { lat: -10, lon: -60 }, { lat: -30, lon: -65 },
    // Europe
    { lat: 50, lon: 10 }, { lat: 55, lon: 20 },
    // Africa
    { lat: 10, lon: 20 }, { lat: -20, lon: 25 },
    // Asia
    { lat: 40, lon: 100 }, { lat: 55, lon: 80 },
    // Australia
    { lat: -25, lon: 135 },
  ];

  for (const { lat, lon } of continentPoints) {
    const y = latToY(lat);
    const x = lonToX(lon);
    if (y >= 0 && y < height && x >= 0 && x < width) {
      map[y][x] = '.';
    }
  }

  // Plot hits with intensity markers
  const hitsByLocation = new Map<string, { containment: number; biome: BiomeType }>();

  for (const hit of hits) {
    const y = latToY(hit.location.latitude);
    const x = lonToX(hit.location.longitude);
    const key = `${x},${y}`;

    const existing = hitsByLocation.get(key);
    if (!existing || hit.containment > existing.containment) {
      hitsByLocation.set(key, { containment: hit.containment, biome: hit.biome });
    }
  }

  for (const [key, { containment }] of hitsByLocation) {
    const [xStr, yStr] = key.split(',');
    const x = parseInt(xStr, 10);
    const y = parseInt(yStr, 10);

    if (y >= 0 && y < height && x >= 0 && x < width) {
      // Use different markers based on containment
      if (containment > 0.7) {
        map[y][x] = '\u25CF'; // Filled circle
      } else if (containment > 0.4) {
        map[y][x] = '\u25CB'; // Empty circle
      } else {
        map[y][x] = '\u00B7'; // Middle dot
      }
    }
  }

  return map.map(row => row.join('')).join('\n');
}
