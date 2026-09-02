/**
 * SRA Metadata Fetcher
 *
 * Fetches metadata (especially geographic location) for SRA runs.
 * Uses NCBI's EFetch API to get BioSample and run metadata.
 *
 * Note: SRA metadata is accessed via NCBI Entrez E-utilities
 * https://www.ncbi.nlm.nih.gov/books/NBK25499/
 */

import type { SRARunMetadata, EnvironmentalProvenanceData, APIResult } from './types';
import { throttledNCBIFetch } from './rate-limit';

const NCBI_EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const NCBI_ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';

/**
 * Parse geographic location string into coordinates
 * Examples: "USA: California", "38.5 N 121.5 W", "Germany: Berlin"
 */
function parseGeoLocation(geoStr: string): { name: string; lat?: number; lon?: number } {
  // Try to extract coordinates if present
  const coordMatch = geoStr.match(/(-?\d+\.?\d*)\s*([NS])\s+(-?\d+\.?\d*)\s*([EW])/i);
  if (coordMatch) {
    let lat = parseFloat(coordMatch[1]);
    let lon = parseFloat(coordMatch[3]);
    if (coordMatch[2].toUpperCase() === 'S') lat = -lat;
    if (coordMatch[4].toUpperCase() === 'W') lon = -lon;
    return { name: geoStr, lat, lon };
  }

  // Known location coordinates (common research locations)
  const knownLocations: Record<string, [number, number]> = {
    'usa': [39.8, -98.5],
    'united states': [39.8, -98.5],
    'california': [36.7, -119.4],
    'germany': [51.2, 10.5],
    'china': [35.9, 104.2],
    'japan': [36.2, 138.3],
    'uk': [55.4, -3.4],
    'united kingdom': [55.4, -3.4],
    'france': [46.2, 2.2],
    'australia': [-25.3, 133.8],
    'canada': [56.1, -106.3],
    'india': [20.6, 78.9],
    'brazil': [-14.2, -51.9],
    'russia': [61.5, 105.3],
    'south korea': [35.9, 127.8],
    'netherlands': [52.1, 5.3],
    'sweden': [60.1, 18.6],
    'switzerland': [46.8, 8.2],
    'spain': [40.5, -3.7],
    'italy': [41.9, 12.6],
  };

  const lowerGeo = geoStr.toLowerCase();
  for (const [location, coords] of Object.entries(knownLocations)) {
    if (lowerGeo.includes(location)) {
      return { name: geoStr, lat: coords[0], lon: coords[1] };
    }
  }

  return { name: geoStr };
}

/**
 * Fetch metadata for a single SRA run
 *
 * @param runId - SRA run accession (e.g., "SRR1234567")
 */
export async function fetchSRARunMetadata(runId: string): Promise<APIResult<SRARunMetadata>> {
  try {
    // First, get the SRA record
    const url = `${NCBI_EFETCH}?db=sra&id=${runId}&rettype=runinfo&retmode=text`;
    const response = await throttledNCBIFetch(url);

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `NCBI API returned ${response.status}`,
        },
      };
    }

    const text = await response.text();
    const lines = text.trim().split('\n');

    if (lines.length < 2) {
      return {
        success: false,
        error: { code: 'NO_DATA', message: 'No metadata found for run' },
      };
    }

    // Parse CSV header and data (handles quoted fields with commas)
    const parseCSVLine = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    };

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
    const values = parseCSVLine(lines[1]);

    const getField = (name: string): string | undefined => {
      const idx = headers.indexOf(name);
      return idx >= 0 && idx < values.length ? values[idx] : undefined;
    };

    const metadata: SRARunMetadata = {
      run_id: runId,
      biosample: getField('biosample') || '',
      bioproject: getField('bioproject') || '',
      organism: getField('scientificname') || getField('organism') || '',
      collection_date: getField('collection_date'),
      geo_loc_name: getField('geo_loc_name') || getField('sample_name'),
      isolation_source: getField('isolation_source'),
      host: getField('host'),
      library_strategy: getField('librarystrategy'),
      platform: getField('platform'),
    };

    // Try to extract coordinates from geo_loc_name
    if (metadata.geo_loc_name) {
      const parsed = parseGeoLocation(metadata.geo_loc_name);
      metadata.latitude = parsed.lat;
      metadata.longitude = parsed.lon;
    }

    return { success: true, data: metadata };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network error',
        details: error,
      },
    };
  }
}

/**
 * Fetch metadata for multiple SRA runs in batch
 * Batches requests to avoid rate limiting
 *
 * @param runIds - Array of SRA run accessions
 * @param batchSize - Number of concurrent requests (default 3 for NCBI limits)
 */
export async function fetchSRARunMetadataBatch(
  runIds: string[],
  batchSize: number = 3
): Promise<APIResult<SRARunMetadata[]>> {
  const results: SRARunMetadata[] = [];
  const errors: string[] = [];

  // Process in batches
  for (let i = 0; i < runIds.length; i += batchSize) {
    const batch = runIds.slice(i, i + batchSize);

    // Fetch batch in parallel
    const batchResults = await Promise.all(
      batch.map(id => fetchSRARunMetadata(id))
    );

    for (const result of batchResults) {
      if (result.success) {
        results.push(result.data);
      } else if (!result.success) {
        errors.push(result.error.message);
      }
    }

    // Small delay between batches
    if (i + batchSize < runIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (results.length === 0 && errors.length > 0) {
    return {
      success: false,
      error: {
        code: 'ALL_FAILED',
        message: `All ${errors.length} requests failed`,
        details: errors,
      },
    };
  }

  return { success: true, data: results };
}

/**
 * Search SRA for runs related to a phage family
 * Returns run IDs that can be used with fetchSRARunMetadataBatch
 *
 * @param query - Search query (e.g., "Siphoviridae", "bacteriophage")
 * @param limit - Maximum results
 */
export async function searchSRARuns(
  query: string,
  limit: number = 50
): Promise<APIResult<string[]>> {
  try {
    const searchQuery = encodeURIComponent(`${query}[Organism] AND metagenome[Filter]`);
    const url = `${NCBI_ESEARCH}?db=sra&term=${searchQuery}&retmax=${limit}&retmode=json`;

    const response = await throttledNCBIFetch(url);

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `NCBI ESearch returned ${response.status}`,
        },
      };
    }

    const data = await response.json();
    const ids: string[] = data.esearchresult?.idlist || [];

    return { success: true, data: ids };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Network error',
        details: error,
      },
    };
  }
}

/**
 * Process SRA metadata into environmental provenance data
 * Aggregates by location and isolation source
 *
 * @param metadata - Array of SRA run metadata
 */
export function processProvenanceData(
  metadata: SRARunMetadata[]
): EnvironmentalProvenanceData {
  // Group by location
  const locationMap = new Map<string, {
    lat: number;
    lon: number;
    samples: SRARunMetadata[];
  }>();

  const isolationSourceCounts: Record<string, number> = {};
  const allDates: string[] = [];

  for (const m of metadata) {
    // Process location
    if (m.geo_loc_name) {
      const parsed = parseGeoLocation(m.geo_loc_name);
      const key = parsed.name.split(':')[0].trim(); // Use country as key

      if (parsed.lat !== undefined && parsed.lon !== undefined) {
        const existing = locationMap.get(key);
        if (existing) {
          existing.samples.push(m);
        } else {
          locationMap.set(key, {
            lat: parsed.lat,
            lon: parsed.lon,
            samples: [m],
          });
        }
      }
    }

    // Count isolation sources
    if (m.isolation_source) {
      const source = m.isolation_source.toLowerCase();
      isolationSourceCounts[source] = (isolationSourceCounts[source] || 0) + 1;
    }

    // Collect dates
    if (m.collection_date) {
      allDates.push(m.collection_date);
    }
  }

  // Build locations array
  const locations = Array.from(locationMap.entries()).map(([name, data]) => {
    const sources = data.samples
      .map(s => s.isolation_source)
      .filter((s): s is string => !!s);
    const dates = data.samples
      .map(s => s.collection_date)
      .filter((d): d is string => !!d)
      .sort();

    return {
      name,
      latitude: data.lat,
      longitude: data.lon,
      sampleCount: data.samples.length,
      isolationSources: [...new Set(sources)],
      runIds: data.samples.map(s => s.run_id).filter((r): r is string => !!r),
      dateRange: dates.length > 0
        ? { earliest: dates[0], latest: dates[dates.length - 1] }
        : undefined,
    };
  });

  // Calculate overall date range
  const sortedDates = allDates.sort();
  const dateRange = sortedDates.length > 0
    ? { earliest: sortedDates[0], latest: sortedDates[sortedDates.length - 1] }
    : undefined;

  return {
    locations,
    isolationSourceBreakdown: isolationSourceCounts,
    totalSamples: metadata.length,
    dateRange,
  };
}
