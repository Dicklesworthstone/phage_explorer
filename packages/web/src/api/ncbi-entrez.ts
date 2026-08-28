/**
 * NCBI Entrez API Client for Phylodynamics
 *
 * Fetches dated viral sequences from GenBank/NCBI for temporal analysis.
 * Phylodynamics requires sequences with collection dates to infer
 * evolutionary dynamics and estimate divergence times.
 *
 * API Docs: https://www.ncbi.nlm.nih.gov/books/NBK25499/
 */

import type { NCBISequenceRecord, NCBIESearchResult, PhylodynamicsData, APIResult } from './types';
import { throttledNCBIFetch } from './rate-limit';

const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const ESEARCH = `${NCBI_BASE}/esearch.fcgi`;
const ESUMMARY = `${NCBI_BASE}/esummary.fcgi`;
const EFETCH = `${NCBI_BASE}/efetch.fcgi`;

/**
 * Search NCBI Nucleotide database for viral sequences
 *
 * @param query - Search query (e.g., "Siphoviridae", "T4 phage")
 * @param filters - Additional search filters
 */
export async function searchNucleotide(
  query: string,
  filters: {
    hasCollectionDate?: boolean;
    minLength?: number;
    maxLength?: number;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  } = {}
): Promise<APIResult<NCBIESearchResult>> {
  try {
    const {
      hasCollectionDate = true,
      minLength,
      maxLength,
      dateFrom,
      dateTo,
      limit = 100,
    } = filters;

    // Build search query
    const searchTerms = [query];

    // Filter for viral sequences
    searchTerms.push('(viruses[filter] OR phage[Title])');

    // Require collection date for phylodynamics
    if (hasCollectionDate) {
      searchTerms.push('collection_date[All Fields]');
    }

    // Sequence length filters
    if (minLength) {
      searchTerms.push(`${minLength}:999999999[Sequence Length]`);
    }
    if (maxLength) {
      searchTerms.push(`1:${maxLength}[Sequence Length]`);
    }

    // Date range filters
    if (dateFrom || dateTo) {
      const from = dateFrom || '1900/01/01';
      const to = dateTo || '3000/01/01';
      searchTerms.push(`${from}:${to}[PDAT]`);
    }

    const searchQuery = encodeURIComponent(searchTerms.join(' AND '));
    const url = `${ESEARCH}?db=nucleotide&term=${searchQuery}&retmax=${limit}&retmode=json&usehistory=y`;

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
    const result = data.esearchresult;

    return {
      success: true,
      data: {
        count: parseInt(result.count, 10),
        retmax: parseInt(result.retmax, 10),
        retstart: parseInt(result.retstart, 10),
        ids: result.idlist || [],
        query_translation: result.querytranslation,
      },
    };
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
 * Fetch sequence summaries from NCBI
 *
 * @param ids - Array of NCBI sequence IDs (GI numbers or accessions)
 */
export async function fetchSequenceSummaries(
  ids: string[]
): Promise<APIResult<NCBISequenceRecord[]>> {
  if (ids.length === 0) {
    return { success: true, data: [] };
  }

  try {
    const idList = ids.join(',');
    const url = `${ESUMMARY}?db=nucleotide&id=${idList}&retmode=json`;

    const response = await throttledNCBIFetch(url);

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `NCBI ESummary returned ${response.status}`,
        },
      };
    }

    const data = await response.json();
    const result = data.result;

    if (!result) {
      return {
        success: false,
        error: { code: 'NO_RESULTS', message: 'No results returned' },
      };
    }

    const records: NCBISequenceRecord[] = [];

    for (const id of ids) {
      const doc = result[id];
      if (!doc) continue;

      // Parse subtype/subname for metadata
      const subtypes = (doc.subtype || '').split('|');
      const subnames = (doc.subname || '').split('|');

      const getSubfield = (field: string): string | undefined => {
        const idx = subtypes.indexOf(field);
        return idx >= 0 ? subnames[idx] : undefined;
      };

      records.push({
        accession: doc.caption || id,
        title: doc.title || '',
        organism: doc.organism || '',
        collection_date: getSubfield('collection_date'),
        country: getSubfield('country'),
        host: getSubfield('host'),
        isolation_source: getSubfield('isolation_source'),
        sequence_length: doc.slen || 0,
        create_date: doc.createdate || '',
        update_date: doc.updatedate || '',
      });
    }

    return { success: true, data: records };
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
 * Fetch GenBank flat file for detailed metadata parsing
 *
 * @param accession - GenBank accession number
 */
export async function fetchGenBankRecord(
  accession: string
): Promise<APIResult<{ features: Record<string, string>; sequence?: string }>> {
  try {
    const url = `${EFETCH}?db=nucleotide&id=${accession}&rettype=gb&retmode=text`;

    const response = await throttledNCBIFetch(url);

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `NCBI EFetch returned ${response.status}`,
        },
      };
    }

    const text = await response.text();

    // Parse key features from GenBank format
    const features: Record<string, string> = {};

    // Extract /collection_date
    const dateMatch = text.match(/\/collection_date="([^"]+)"/);
    if (dateMatch) features.collection_date = dateMatch[1];

    // Extract /country
    const countryMatch = text.match(/\/country="([^"]+)"/);
    if (countryMatch) features.country = countryMatch[1];

    // Extract /host
    const hostMatch = text.match(/\/host="([^"]+)"/);
    if (hostMatch) features.host = hostMatch[1];

    // Extract /isolation_source
    const sourceMatch = text.match(/\/isolation_source="([^"]+)"/);
    if (sourceMatch) features.isolation_source = sourceMatch[1];

    // Extract /organism
    const orgMatch = text.match(/\/organism="([^"]+)"/);
    if (orgMatch) features.organism = orgMatch[1];

    // Extract /lat_lon
    const latLonMatch = text.match(/\/lat_lon="([^"]+)"/);
    if (latLonMatch) features.lat_lon = latLonMatch[1];

    return { success: true, data: { features } };
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
 * Parse collection date string into Date object
 * Handles various formats: "2020-05-15", "May-2020", "2020", etc.
 */
function parseCollectionDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Try ISO format first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) return isoDate;

  // Try "YYYY" format
  const yearMatch = dateStr.match(/^(\d{4})$/);
  if (yearMatch) {
    return new Date(parseInt(yearMatch[1], 10), 6, 1); // Middle of year
  }

  // Try "Mon-YYYY" format
  const monthYearMatch = dateStr.match(/^(\w+)-(\d{4})$/);
  if (monthYearMatch) {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[monthYearMatch[1].toLowerCase().slice(0, 3)];
    const year = parseInt(monthYearMatch[2], 10);
    if (month !== undefined) {
      return new Date(year, month, 15); // Middle of month
    }
  }

  // Try "DD-Mon-YYYY" format
  const fullMatch = dateStr.match(/^(\d{1,2})-(\w+)-(\d{4})$/);
  if (fullMatch) {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const day = parseInt(fullMatch[1], 10);
    const month = months[fullMatch[2].toLowerCase().slice(0, 3)];
    const year = parseInt(fullMatch[3], 10);
    if (month !== undefined) {
      return new Date(year, month, day);
    }
  }

  return null;
}

/**
 * Search and fetch dated phage sequences for phylodynamics
 *
 * @param phageName - Name or family of phage to search
 * @param limit - Maximum sequences to fetch
 */
export async function fetchDatedPhageSequences(
  phageName: string,
  limit: number = 100
): Promise<APIResult<PhylodynamicsData>> {
  // Step 1: Search for sequences
  const searchResult = await searchNucleotide(phageName, {
    hasCollectionDate: true,
    limit,
  });

  if (!searchResult.success) {
    return {
      success: false,
      error: searchResult.error,
    };
  }

  if (searchResult.data.ids.length === 0) {
    return {
      success: false,
      error: {
        code: 'NO_SEQUENCES',
        message: `No dated sequences found for "${phageName}"`,
      },
    };
  }

  // Step 2: Fetch summaries in batches
  const batchSize = 50;
  const allRecords: NCBISequenceRecord[] = [];

  for (let i = 0; i < searchResult.data.ids.length; i += batchSize) {
    const batch = searchResult.data.ids.slice(i, i + batchSize);
    const summaryResult = await fetchSequenceSummaries(batch);

    if (summaryResult.success) {
      allRecords.push(...summaryResult.data);
    }
  }

  // Step 3: Process into phylodynamics data
  const sequences: PhylodynamicsData['sequences'] = [];
  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    if (!record.collection_date) continue;
    const date = parseCollectionDate(record.collection_date);
    if (!date) continue;

    const sequence: PhylodynamicsData['sequences'][number] = {
      accession: record.accession,
      organism: record.organism,
      collectionDate: date,
      sequenceLength: record.sequence_length,
    };
    if (record.country) sequence.country = record.country;
    if (record.host) sequence.host = record.host;

    sequences.push(sequence);
  }
  sequences.sort((a, b) => a.collectionDate.getTime() - b.collectionDate.getTime());

  if (sequences.length === 0) {
    return {
      success: false,
      error: {
        code: 'NO_DATED_SEQUENCES',
        message: 'Found sequences but none had parseable collection dates',
      },
    };
  }

  // Calculate statistics
  const countryCounts: Record<string, number> = {};
  const hostCounts: Record<string, number> = {};
  const temporalBins = new Map<string, number>();

  for (const seq of sequences) {
    if (seq.country) {
      const country = seq.country.split(':')[0].trim();
      countryCounts[country] = (countryCounts[country] || 0) + 1;
    }
    if (seq.host) {
      hostCounts[seq.host] = (hostCounts[seq.host] || 0) + 1;
    }

    // Bin by month for temporal distribution
    const monthKey = `${seq.collectionDate.getFullYear()}-${String(seq.collectionDate.getMonth() + 1).padStart(2, '0')}`;
    temporalBins.set(monthKey, (temporalBins.get(monthKey) || 0) + 1);
  }

  const temporalCoverage = Array.from(temporalBins.entries())
    .map(([key, count]) => ({
      date: new Date(key + '-01'),
      count,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    success: true,
    data: {
      sequences,
      timeRange: {
        earliest: sequences[0].collectionDate,
        latest: sequences[sequences.length - 1].collectionDate,
      },
      countryBreakdown: countryCounts,
      hostBreakdown: hostCounts,
      temporalCoverage,
    },
  };
}

/**
 * Get phage-related search terms for common phage families
 */
export function getPhageSearchTerms(phageName: string): string[] {
  const phageNameLower = phageName.toLowerCase();

  // Map common phage names to their families
  const phageFamilies: Record<string, string[]> = {
    't4': ['T4 phage', 'Myoviridae', 'Tevenvirinae'],
    't7': ['T7 phage', 'Autographiviridae'],
    'lambda': ['Lambda phage', 'Siphoviridae', 'Lambdavirus'],
    'phi': ['Phi phage', 'bacteriophage phi'],
    'p1': ['P1 phage', 'Myoviridae'],
    'p22': ['P22 phage', 'Podoviridae'],
    'mu': ['Mu phage', 'Myoviridae'],
    'ms2': ['MS2 phage', 'Leviviridae'],
    'qbeta': ['Qbeta phage', 'Leviviridae'],
    'phi29': ['phi29 phage', 'Podoviridae'],
    'spbeta': ['SPbeta phage', 'Siphoviridae'],
    'felix': ['Felix O1', 'Myoviridae'],
    'twort': ['Twort phage', 'Herelleviridae'],
  };

  for (const [key, terms] of Object.entries(phageFamilies)) {
    if (phageNameLower.includes(key)) {
      return terms;
    }
  }

  // Default to generic bacteriophage search
  return [phageName, 'bacteriophage', 'phage'];
}
