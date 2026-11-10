import { describe, expect, it } from 'bun:test';
import { environmentalDatasetFromSra, fetchPublicEnvironmentalContext } from './environmental-evidence';
import { parseReportedCoordinates, fetchSRARunMetadata, fetchSRARunMetadataBatch, processProvenanceData } from './sra-metadata';
import { resetNCBIRateLimit, throttledNCBIFetch } from './rate-limit';
import { analyzeEnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';
import type { SRARunMetadata } from './types';

const metadata = (run_id: string, fields: Partial<SRARunMetadata> = {}): SRARunMetadata =>
  ({ run_id, biosample: 'SAMN1', bioproject: 'PRJNA1', organism: 'metagenome', ...fields });
const version = '2026-11-10T00:00:00.000Z';
async function withFetch(replacement: typeof fetch, action: () => Promise<void>) {
  const original = globalThis.fetch; globalThis.fetch = replacement; resetNCBIRateLimit();
  try { await action(); } finally { globalThis.fetch = original; resetNCBIRateLimit(); }
}

describe('public metadata remains unassayed sample context', () => {
  it('preserves individual samples, missing locations, uncertainty and partial dates without inventing occurrence', () => {
    const dataset = environmentalDatasetFromSra([
      metadata('SRR1', { geo_loc_name: 'USA: California', isolation_source: 'wastewater', collection_date: '2024' }),
      metadata('SRR2', { latitude: 38.5, longitude: -121.5, isolation_source: 'freshwater', collection_date: '2024-02' }),
      metadata('ERR3', { isolation_source: 'water', collection_date: 'not collected' }),
    ], 5, version);
    expect(dataset.query.accession).toBeNull(); expect(dataset.source.kind).toBe('external');
    expect(dataset.samples.map(row => row.occurrence)).toEqual(['not-assayed', 'not-assayed', 'not-assayed']);
    expect(dataset.samples.map(row => row.biome)).toEqual(['wastewater', 'freshwater', 'unknown']);
    expect(dataset.samples.map(row => row.collectionDate)).toEqual(['2024', '2024-02', null]);
    expect(dataset.samples[0].location).toBeNull();
    expect(dataset.samples[1].location).toEqual({ latitude: 38.5, longitude: -121.5, uncertaintyKm: null });
    const result = analyzeEnvironmentalDataset(dataset);
    expect(result.totals).toEqual({ samples: 3, assayed: 0, detected: 0, notDetected: 0, notAssayed: 3, located: 1, dated: 2 });
    expect(result.biomes.every(row => row.detectionFraction === null && row.meanAbundance === null)).toBe(true);
    expect(dataset.source.study).toContain('3 returned of 5 requested');
  });
  it('rejects duplicate runs, incomplete coordinate pairs and invalid supplied dates', () => {
    expect(() => environmentalDatasetFromSra([metadata('SRR1'), metadata('SRR1')], 2, version)).toThrow(/Duplicate/);
    expect(() => environmentalDatasetFromSra([metadata('SRR1', { latitude: 10 })], 1, version)).toThrow();
    expect(() => environmentalDatasetFromSra([metadata('SRR1', { collection_date: '2023-02-29' })], 1, version)).toThrow(/date/);
  });
  it('only parses actual coordinate pairs, including hemisphere signs and the equator', () => {
    expect(parseReportedCoordinates('38.5 N 121.5 W')).toEqual({ latitude: 38.5, longitude: -121.5 });
    expect(parseReportedCoordinates('12.5 S 45.75 E')).toEqual({ latitude: -12.5, longitude: 45.75 });
    expect(parseReportedCoordinates('-12.5,45.75')).toEqual({ latitude: -12.5, longitude: 45.75 });
    expect(parseReportedCoordinates('0 0')).toEqual({ latitude: 0, longitude: 0 });
    for (const input of ['USA: California', 'Germany: Berlin', 'water', '-10 S 20 E', '91 N 10 E', '0,181', '', ',']) {
      expect(parseReportedCoordinates(input)).toBeNull();
    }
  });
  it('uses reported lat_lon fields without geocoding sample names or countries', async () => {
    await withFetch((async () => new Response('Run,BioSample,BioProject,ScientificName,geo_loc_name,lat_lon,collection_date\nSRR1,SAMN1,PRJNA1,metagenome,USA: California,38.5 N 121.5 W,2024-02')) as typeof fetch, async () => {
      const result = await fetchSRARunMetadata('SRR1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toMatchObject({ run_id: 'SRR1', latitude: 38.5, longitude: -121.5, collection_date: '2024-02' });
    });
    await withFetch((async () => new Response('Run,sample_name,geo_loc_name\nSRR2,Germany: Berlin,USA: California')) as typeof fetch, async () => {
      const result = await fetchSRARunMetadata('SRR2');
      expect(result.success).toBe(true);
      if (result.success) { expect(result.data.latitude).toBeUndefined(); expect(result.data.longitude).toBeUndefined(); }
    });
  });
  it('public lookup has no genome argument and returns an error rather than a demonstration', async () => {
    const requested: string[] = [];
    await withFetch((async input => { requested.push(String(input)); throw new Error('offline fixture'); }) as typeof fetch, async () => {
      await expect(fetchPublicEnvironmentalContext(new AbortController().signal)).rejects.toThrow(/failed/);
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every(url => !url.includes('private-genome'))).toBe(true);
  });
  it('aborts queued metadata work before it can issue another request', async () => {
    let calls = 0;
    await withFetch((async () => { calls++; return new Response('ok'); }) as typeof fetch, async () => {
      await throttledNCBIFetch('https://example.invalid/first');
      const controller = new AbortController();
      const queued = throttledNCBIFetch('https://example.invalid/second', controller.signal);
      controller.abort(); await expect(queued).rejects.toThrow(); expect(calls).toBe(1);
      await expect(fetchSRARunMetadataBatch(['SRR1'], 0)).rejects.toThrow(/batch size/);
      await expect(fetchPublicEnvironmentalContext(controller.signal)).rejects.toThrow(); expect(calls).toBe(1);
    });
  });
  it('keeps distinct reported sites in the legacy adapter and retains unlocated samples in its total', () => {
    const result = processProvenanceData([
      metadata('SRR1', { geo_loc_name: 'USA', latitude: 10, longitude: 20 }),
      metadata('SRR2', { geo_loc_name: 'USA', latitude: 11, longitude: 21 }),
      metadata('SRR3', { geo_loc_name: 'Germany' }),
      metadata('SRR4', { latitude: 0, longitude: 0 }),
    ]);
    expect(result.totalSamples).toBe(4);
    expect(result.locations.map(location => [location.latitude, location.longitude, location.runIds]))
      .toEqual([[10, 20, ['SRR1']], [11, 21, ['SRR2']], [0, 0, ['SRR4']]]);
    expect(result.locations[2].name).toBe('SRR4');
  });

  it('selects the exact response accession and rejects missing, duplicate or malformed run rows', async () => {
    const responses = [
      'Run,geo_loc_name\nSRR999,Wrong location\nSRR123,"USA: site ""A"", north"',
      'Run,geo_loc_name\nSRR999,Wrong location',
      'Run,geo_loc_name\nSRR123,USA\nSRR123,Canada',
      'Run,geo_loc_name\nSRR123,"unclosed',
      'geo_loc_name\nUSA',
      'Run,run,geo_loc_name\nSRR123,SRR123,USA',
      'Run,geo_loc_name\nSRR123,USA,extra',
    ];
    await withFetch((async () => new Response(responses.shift()!)) as typeof fetch, async () => {
      const matched = await fetchSRARunMetadata('SRR123');
      expect(matched.success).toBe(true);
      if (!matched.success) throw new Error('Expected exact run match');
      expect(matched.data).toMatchObject({ run_id: 'SRR123', geo_loc_name: 'USA: site "A", north' });
      while (responses.length) {
        resetNCBIRateLimit();
        const rejected = await fetchSRARunMetadata('SRR123');
        expect(rejected.success).toBe(false);
        if (rejected.success) throw new Error('An unverified row must not become sample evidence');
        expect(['RUN_ID_MISMATCH', 'INVALID_RUN_METADATA']).toContain(rejected.error.code);
      }
    });
  });
});
