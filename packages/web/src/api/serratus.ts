/**
 * Serratus API Client
 *
 * Serratus is a cloud-computing infrastructure for ultra-fast alignment
 * of petabytes of sequencing data against viral reference sequences.
 *
 * API Docs: https://serratus.io/
 * Data access: https://github.com/ababaian/serratus/wiki/Access-Data-Tables
 */

import type { SerratusSequenceMatch, SerratusSearchResponse, APIResult } from './types';

const SERRATUS_API_BASE = 'https://api.serratus.io';

function buildSerratusHeaders(): HeadersInit {
  const headers: HeadersInit = { Accept: 'application/json' };
  const envVal: string = (import.meta.env.VITE_SERRATUS_AUTH as string) || '';
  if (envVal.length > 0 && typeof globalThis.btoa === 'function') {
    headers.Authorization = 'Basic ' + globalThis.btoa(envVal);
  }
  return headers;
}

function escapeODataString(input: string): string {
  return input.replace(/'/g, "''");
}

/**
 * Search Serratus database for sequences matching a viral family
 *
 * @param familyName - Viral family to search (e.g., "Siphoviridae", "Myoviridae")
 * @param limit - Maximum results to return (default 100)
 */
export async function searchByFamily(
  familyName: string,
  limit: number = 100
): Promise<APIResult<SerratusSearchResponse>> {
  try {
    // Serratus uses a SQL-like query interface
    // Query the nfamily table for matches to a viral family
    const query = encodeURIComponent(`family_name eq '${escapeODataString(familyName)}'`);
    const url = `${SERRATUS_API_BASE}/data/nfamily?$filter=${query}&$top=${limit}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: buildSerratusHeaders(),
    });

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `Serratus API returned ${response.status}: ${response.statusText}`,
        },
      };
    }

    const data = await response.json();

    // Transform Serratus response to our format
    const matches: SerratusSequenceMatch[] = (data.value || []).map((row: Record<string, unknown>) => ({
      run_id: String(row.run_id || row.sra_id || ''),
      score: Number(row.score || row.pident || 0),
      percent_identity: Number(row.pident || row.percent_identity || 0),
      family: String(row.family_name || familyName),
      coverage: Number(row.coverage || row.aln_len || 0),
    }));

    return {
      success: true,
      data: {
        matches,
        total: data['@odata.count'] || matches.length,
        query_sequence: familyName,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Failed to connect to Serratus API',
        details: error,
      },
    };
  }
}

/**
 * Search Serratus for sequences matching a specific SRA run
 *
 * @param sraId - SRA run accession (e.g., "SRR1234567")
 */
export async function getRunDetails(sraId: string): Promise<APIResult<SerratusSequenceMatch[]>> {
  try {
    const url = `${SERRATUS_API_BASE}/data/nsequence?$filter=run_id eq '${escapeODataString(sraId)}'`;

    const response = await fetch(url, {
      method: 'GET',
      headers: buildSerratusHeaders(),
    });

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `Serratus API returned ${response.status}: ${response.statusText}`,
        },
      };
    }

    const data = await response.json();

    const matches: SerratusSequenceMatch[] = (data.value || []).map((row: Record<string, unknown>) => ({
      run_id: String(row.run_id || sraId),
      score: Number(row.score || 0),
      percent_identity: Number(row.pident || 0),
      family: String(row.family_name || 'Unknown'),
      coverage: Number(row.coverage || 0),
    }));

    return { success: true, data: matches };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Failed to connect to Serratus API',
        details: error,
      },
    };
  }
}

/**
 * Search Serratus for phage-related sequences
 * Queries multiple common phage families
 *
 * @param phageName - Name of the phage to search for context
 * @param limit - Maximum total results
 */
export async function searchPhageRelated(
  phageName: string,
  limit: number = 50
): Promise<APIResult<SerratusSearchResponse>> {
  // Common bacteriophage families to search
  const phageFamilies = [
    'Siphoviridae',
    'Myoviridae',
    'Podoviridae',
    'Herelleviridae',
    'Autographiviridae',
    'Drexlerviridae',
    'Demerecviridae',
  ];

  try {
    // Build a compound query for phage families
    const familyFilters = phageFamilies.map(f => `family_name eq '${escapeODataString(f)}'`).join(' or ');
    const query = encodeURIComponent(familyFilters);
    const url = `${SERRATUS_API_BASE}/data/nfamily?$filter=${query}&$top=${limit}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: buildSerratusHeaders(),
    });

    if (!response.ok) {
      // Try alternative endpoint if main one fails
      return searchByFamily('Caudovirales', limit);
    }

    const data = await response.json();

    const matches: SerratusSequenceMatch[] = (data.value || []).map((row: Record<string, unknown>) => ({
      run_id: String(row.run_id || row.sra_id || ''),
      score: Number(row.score || row.pident || 0),
      percent_identity: Number(row.pident || 0),
      family: String(row.family_name || 'Unknown'),
      coverage: Number(row.coverage || 0),
    }));

    return {
      success: true,
      data: {
        matches,
        total: data['@odata.count'] || matches.length,
        query_sequence: phageName,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Failed to connect to Serratus API',
        details: error,
      },
    };
  }
}

/**
 * Get SRA run IDs that contain sequences from a specific viral family
 * These can be cross-referenced with SRA metadata for geographic info
 *
 * @param familyName - Viral family name
 * @param minScore - Minimum match score (0-100)
 * @param limit - Maximum results
 */
export async function getSRARunsForFamily(
  familyName: string,
  minScore: number = 50,
  limit: number = 200
): Promise<APIResult<string[]>> {
  try {
    const query = encodeURIComponent(`family_name eq '${escapeODataString(familyName)}' and score ge ${minScore}`);
    const url = `${SERRATUS_API_BASE}/data/nfamily?$filter=${query}&$top=${limit}&$select=run_id`;

    const response = await fetch(url, {
      method: 'GET',
      headers: buildSerratusHeaders(),
    });

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: `HTTP_${response.status}`,
          message: `Serratus API returned ${response.status}`,
        },
      };
    }

    const rawRows: Array<Record<string, unknown>> = data.value || [];
    const runIds: string[] = [];
    for (let i = 0; i < rawRows.length; i++) {
      const id = String(rawRows[i]?.run_id || '');
      if (id.length > 0) runIds.push(id);
    }

    return { success: true, data: runIds };
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
