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
 * Parse reported coordinates only. A country or city name is not a measured
 * sampling position, and must never become a country-centroid map marker.
 */
export function parseReportedCoordinates(geoStr: string): { latitude: number; longitude: number } | null {
  const coordMatch = geoStr.trim().match(/^(\d+(?:\.\d+)?)\s*([NS])\s*[,;]?\s+(\d+(?:\.\d+)?)\s*([EW])$/i);
  if (coordMatch) {
    const latitude = Number(coordMatch[1]) * (coordMatch[2].toUpperCase() === 'S' ? -1 : 1);
    const longitude = Number(coordMatch[3]) * (coordMatch[4].toUpperCase() === 'W' ? -1 : 1);
    return latitude <= 90 && latitude >= -90 && longitude <= 180 && longitude >= -180 ? { latitude, longitude } : null;
  }
  const signed = geoStr.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)$/);
  if (signed) {
    const latitude = Number(signed[1]), longitude = Number(signed[2]);
    return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
  }
  return null;
}

/**
 * Fetch metadata for a single SRA run
 *
 * @param runId - SRA run accession (e.g., "SRR1234567")
 */
export async function fetchSRARunMetadata(runId: string, signal?: AbortSignal): Promise<APIResult<SRARunMetadata>> {
  signal?.throwIfAborted();
  if (!/^(SRR|ERR|DRR)\d+$/.test(runId)) return { success: false, error: { code: 'INVALID_RUN', message: 'An SRA run accession is required.' } };
  try {
    // First, get the SRA record
    const url = `${NCBI_EFETCH}?db=sra&id=${runId}&rettype=runinfo&retmode=text`;
    const response = await throttledNCBIFetch(url, signal);

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
    const lines = text.trim().split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length < 2) {
      return {
        success: false,
        error: { code: 'NO_DATA', message: 'No metadata found for run' },
      };
    }

    // Select a verified Run identity, never relabel the first response row.
    // Unsupported multiline or malformed CSV is rejected rather than guessing.
    const parseCSVLine = (line: string): string[] | null => {
      const result: string[] = [];
      let current = '', inQuotes = false, closedQuote = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
          if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
          else if (char === '"') { inQuotes = false; closedQuote = true; }
          else current += char;
        } else if (char === ',') {
          result.push(current.trim()); current = ''; closedQuote = false;
        } else if (char === '"' && current.trim() === '' && !closedQuote) {
          current = ''; inQuotes = true;
        } else if (char === '"' || closedQuote && char.trim() !== '') return null;
        else current += char;
      }
      if (inQuotes) return null;
      result.push(current.trim());
      return result;
    };
    const parsed = lines.map(parseCSVLine);
    const headers = parsed[0]?.map(header => header.toLowerCase());
    if (!headers || new Set(headers).size !== headers.length || !headers.includes('run')
      || parsed.some(row => row === null || row.length !== headers.length)) {
      return { success: false, error: { code: 'INVALID_RUN_METADATA', message: 'SRA returned malformed or ambiguous run metadata.' } };
    }
    const runColumn = headers.indexOf('run');
    const matches = parsed.slice(1).filter((row): row is string[] => row !== null && row[runColumn] === runId);
    if (matches.length !== 1) {
      return { success: false, error: { code: 'RUN_ID_MISMATCH', message: 'SRA metadata must contain exactly one row for the requested run accession.' } };
    }
    const values = matches[0];

    const getField = (name: string): string | undefined => {
      const idx = headers.indexOf(name);
      return idx >= 0 && idx < values.length ? values[idx] : undefined;
    };

    const metadata: SRARunMetadata = {
      run_id: values[runColumn],
      biosample: getField('biosample') || '',
      bioproject: getField('bioproject') || '',
      organism: getField('scientificname') || getField('organism') || '',
      collection_date: getField('collection_date'),
      geo_loc_name: getField('geo_loc_name'),
      isolation_source: getField('isolation_source'),
      host: getField('host'),
      library_strategy: getField('librarystrategy'),
      platform: getField('platform'),
    };

    const explicitPair = getField('latitude') && getField('longitude')
      ? `${getField('latitude')},${getField('longitude')}` : '';
    const coordinates = parseReportedCoordinates(getField('lat_lon') || explicitPair || metadata.geo_loc_name || '');
    if (coordinates) Object.assign(metadata, coordinates);

    return { success: true, data: metadata };
  } catch (error) {
    signal?.throwIfAborted();
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
  batchSize: number = 3,
  signal?: AbortSignal
): Promise<APIResult<SRARunMetadata[]>> {
  signal?.throwIfAborted();
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('SRA batch size must be between 1 and 10.');
  const results: SRARunMetadata[] = [];
  const errors: string[] = [];

  // Process in batches
  for (let i = 0; i < runIds.length; i += batchSize) {
    signal?.throwIfAborted();
    const batch = runIds.slice(i, i + batchSize);

    // Fetch batch in parallel
    const batchResults = await Promise.all(
      batch.map(id => fetchSRARunMetadata(id, signal))
    );

    for (const result of batchResults) {
      if (result.success) {
        results.push(result.data);
      } else if (!result.success) {
        errors.push(result.error.message);
      }
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
    name: string;
    lat: number;
    lon: number;
    samples: SRARunMetadata[];
  }>();

  const isolationSourceCounts: Record<string, number> = {};
  const allDates: string[] = [];

  for (const m of metadata) {
    // Preserve actual positions even when only a lat_lon field was reported.
    // Group by coordinates, not country: different sample sites stay distinct.
    const supplied = typeof m.latitude === 'number' && typeof m.longitude === 'number'
      && Number.isFinite(m.latitude) && Number.isFinite(m.longitude)
      && Math.abs(m.latitude) <= 90 && Math.abs(m.longitude) <= 180
      ? { latitude: m.latitude, longitude: m.longitude } : null;
    const coordinates = supplied ?? parseReportedCoordinates(m.geo_loc_name ?? '');
    if (coordinates) {
      const key = `${coordinates.latitude},${coordinates.longitude}`;
      const existing = locationMap.get(key);
      if (existing) existing.samples.push(m);
      else locationMap.set(key, { name: m.geo_loc_name || m.run_id,
        lat: coordinates.latitude, lon: coordinates.longitude, samples: [m] });
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
  const locations = Array.from(locationMap.values()).map(data => {
    const sources = data.samples
      .map(s => s.isolation_source)
      .filter((s): s is string => !!s);
    const dates = data.samples
      .map(s => s.collection_date)
      .filter((d): d is string => !!d)
      .sort();

    return {
      name: data.name,
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
