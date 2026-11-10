/** Explicit public metadata context. No selected phage identifier or bases are sent. */
import { environmentalBiome, validateEnvironmentalDataset, type EnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';
import { searchPhageRelated } from './serratus';
import { fetchSRARunMetadataBatch } from './sra-metadata';
import type { SRARunMetadata } from './types';

const missing = (value: string | undefined): string | null => {
  const text = value?.trim();
  return !text || /^(missing|not provided|not collected|not applicable|unknown|na|n\/a)$/i.test(text) ? null : text;
};

export function environmentalDatasetFromSra(rows: readonly SRARunMetadata[], requestedRuns: number,
  retrievedAt: string): EnvironmentalDataset {
  if (!Number.isSafeInteger(requestedRuns) || requestedRuns < rows.length || requestedRuns > 50) {
    throw new Error('Public environmental context requires a bounded, explicit requested-run count.');
  }
  // Deliberately retain each run, including unlocated and undated samples.
  // A name/family metadata search has not assayed this dataset's query genome.
  return validateEnvironmentalDataset({
    format: 'phage-explorer-environmental', version: 1,
    name: 'Public phage-family context',
    query: { id: 'public-phage-family-context', label: 'Broad phage families; no selected-genome occurrence test', accession: null },
    source: { kind: 'external', study: `Serratus phage-family context and NCBI SRA metadata: ${rows.length} returned of ${requestedRuns} requested runs. Metadata is not a genome match or a representative environmental survey.`,
      reference: 'https://www.ncbi.nlm.nih.gov/sra', version: retrievedAt, license: null },
    measurement: { type: 'presence', method: 'No query-specific assay; public family-search metadata only', normalization: 'Not applicable; no abundance measurements' },
    samples: rows.map(row => ({ id: row.run_id, accession: row.run_id,
      biome: environmentalBiome(row.isolation_source ?? ''), country: missing(row.geo_loc_name),
      location: row.latitude === undefined && row.longitude === undefined ? null : {
        latitude: row.latitude, longitude: row.longitude, uncertaintyKm: null,
      }, collectionDate: missing(row.collection_date), occurrence: 'not-assayed', abundance: null })),
  });
}

/** Called only after the user chooses a public lookup. Cancel aborts the owned requests. */
export async function fetchPublicEnvironmentalContext(signal: AbortSignal): Promise<EnvironmentalDataset> {
  signal.throwIfAborted();
  const search = await searchPhageRelated('Broad public phage-family context', 50, signal);
  signal.throwIfAborted();
  if (!search.success) throw new Error(`Public family lookup failed: ${search.error.message}`);
  const ids = [...new Set(search.data.matches.map(match => match.run_id).filter(id => /^(SRR|ERR|DRR)\d+$/.test(id)))].slice(0, 50);
  if (!ids.length) throw new Error('The public family lookup returned no supported SRA run identifiers. No synthetic samples were substituted.');
  const metadata = await fetchSRARunMetadataBatch(ids, 3, signal);
  signal.throwIfAborted();
  if (!metadata.success) throw new Error(`Public SRA metadata lookup failed: ${metadata.error.message}`);
  if (!metadata.data.length) throw new Error('No SRA sample metadata was returned. No synthetic samples were substituted.');
  return environmentalDatasetFromSra(metadata.data, ids.length, new Date().toISOString());
}
