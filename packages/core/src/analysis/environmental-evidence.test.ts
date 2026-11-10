import { describe, expect, it } from 'bun:test';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import type { AbundanceDataset } from './abundance';
import { analyzeEnvironmentalDataset, createDemoEnvironmentalDataset, createEnvironmentalAnalysisRecord, environmentalBiome,
  environmentalDatasetFromAbundance, environmentalEvidenceTsv, ENVIRONMENTAL_LIMITS, ENVIRONMENTAL_METHOD,
  parseEnvironmentalDataset, replayEnvironmentalAnalysisRecord, serializeEnvironmentalDataset, validateEnvironmentalDataset,
  type EnvironmentalDataset, type EnvironmentalSample } from './environmental-evidence';

function fixture(): EnvironmentalDataset {
  const sample = (id: string, occurrence: EnvironmentalSample['occurrence'], abundance: number | null,
    extra: Partial<EnvironmentalSample> = {}): EnvironmentalSample => ({ id, accession: null, biome: 'freshwater', country: null,
    location: null, collectionDate: null, occurrence, abundance, ...extra });
  return { format: 'phage-explorer-environmental', version: 1, name: 'Attributed assay fixture',
    query: { id: 'query-1', label: 'Explicit test query', accession: 'local:query-1' },
    source: { kind: 'local', study: 'Independent sample-summary arithmetic fixture', reference: 'Test fixture, not empirical research',
      version: 'test-1', license: 'CC0 synthetic test inputs' },
    measurement: { type: 'counts', method: 'Counts from a declared per-sample assay', normalization: 'Counts per equal-volume sample' },
    samples: [
      sample('A', 'detected', 6, { accession: 'sample:A', country: 'Exampleland',
        location: { latitude: 0, longitude: 0, uncertaintyKm: 10 }, collectionDate: '2000-02-29' }),
      sample('B', 'not-detected', 0, { country: 'Country without coordinates', collectionDate: '2024' }),
      sample('C', 'detected', null, { collectionDate: '2024-03' }),
      sample('D', 'not-assayed', null, { biome: 'soil', location: { latitude: -90, longitude: 180, uncertaintyKm: null } }),
      sample('E', 'detected', 2),
    ],
  };
}
function abundanceFixture(): AbundanceDataset {
  return { format: 'phage-explorer-abundance', version: 1, name: 'Community panel', units: 'counts',
    source: { kind: 'local', description: 'Attributed community count matrix', reference: 'local-study:1' },
    table: { taxa: ['q', 'other'], samples: ['s1', 's2', 's3', 's4'], counts: [[2, 0, 5, 0], [8, 4, 5, 0]] },
    // Deliberately shuffled; never zip metadata positions to table columns.
    metadata: [
      { sampleId: 's3', habitat: 'wastewater', latitude: '-12.5', longitude: '1e2', uncertaintyKm: '3.5', collectionDate: '2020-02' },
      { sampleId: 's1', habitat: 'Freshwater', country: 'France', collectionDate: '2020', accession: 'local:s1' },
      { sampleId: 's2', habitat: 'water', country: 'USA' },
    ] };
}
async function rehash(record: AnalysisRecord): Promise<AnalysisRecord> {
  return createAnalysisRecord({ method: record.method,
    inputs: record.inputs.map(({ sha256: _sha256, ...input }) => input), parameters: record.parameters, seed: record.seed,
    references: record.references, fields: record.fields });
}

describe('environmental observation summaries', () => {
  it('uses independent occurrence and abundance denominators and retains missing evidence', () => {
    const result = analyzeEnvironmentalDataset(fixture());
    expect(result.totals).toEqual({ samples: 5, assayed: 4, detected: 3, notDetected: 1, notAssayed: 1, located: 2, dated: 3 });
    expect(result.biomes).toEqual([
      { biome: 'freshwater', samples: 4, assayed: 4, detected: 3, notDetected: 1, notAssayed: 0,
        detectionFraction: 3 / 4, meanAbundance: 8 / 3, abundanceSamples: 3 },
      { biome: 'soil', samples: 1, assayed: 0, detected: 0, notDetected: 0, notAssayed: 1,
        detectionFraction: null, meanAbundance: null, abundanceSamples: 0 },
    ]);
    expect(result.locations).toEqual([
      { sampleId: 'A', latitude: 0, longitude: 0, uncertaintyKm: 10, occurrence: 'detected' },
      { sampleId: 'D', latitude: -90, longitude: 180, uncertaintyKm: null, occurrence: 'not-assayed' },
    ]);
    expect(result.warnings.join(' ')).toContain('denominators are smaller');
    expect(result.warnings.join(' ')).toContain('not habitat preference');
  });

  it('does not infer coordinates, complete dates, containment or novelty', () => {
    const dataset = validateEnvironmentalDataset(fixture()), result = analyzeEnvironmentalDataset(dataset);
    expect(dataset.samples[1].location).toBeNull();
    expect(dataset.samples.map(sample => sample.collectionDate)).toEqual(['2000-02-29', '2024', '2024-03', null, null]);
    expect(result).not.toHaveProperty('novelty');
    expect(result).not.toHaveProperty('primaryHabitat');
    expect(result.locations).toHaveLength(2);
    expect(result.locations[1].uncertaintyKm).toBeNull();
  });

  it('presence observations never become abundance or ecological probabilities', () => {
    const dataset = fixture(); dataset.measurement.type = 'presence'; dataset.samples.forEach(sample => sample.abundance = null);
    const result = analyzeEnvironmentalDataset(dataset);
    expect(result.biomes[0].detectionFraction).toBe(0.75);
    expect(result.biomes.every(biome => biome.meanAbundance === null && biome.abundanceSamples === 0)).toBe(true);
  });

  it('does not renormalize a selected query’s relative abundances over samples', () => {
    const dataset = fixture(); dataset.measurement.type = 'relative-abundance';
    dataset.samples[0].abundance = 0.25; dataset.samples[4].abundance = 0.5;
    const result = analyzeEnvironmentalDataset(dataset);
    expect(result.biomes[0].meanAbundance).toBe(0.25); // (0.25 + observed zero + 0.5) / 3.
    expect(result.warnings.join(' ')).toContain('not absolute abundance or sequence containment');
  });

  it('zero observations and no assay coverage remain unavailable rather than negative findings', () => {
    const dataset = fixture(); dataset.samples = [];
    const empty = analyzeEnvironmentalDataset(dataset);
    expect(empty.totals).toEqual({ samples: 0, assayed: 0, detected: 0, notDetected: 0, notAssayed: 0, located: 0, dated: 0 });
    expect(empty.biomes).toEqual([]); expect(empty.locations).toEqual([]);
    expect(empty.warnings.join(' ')).toContain('No sample observations');
    dataset.samples = [fixture().samples[3]];
    expect(analyzeEnvironmentalDataset(dataset).biomes[0].detectionFraction).toBeNull();
  });

  it('observed zeros enter means while missing abundance does not', () => {
    const dataset = fixture(); dataset.samples = [dataset.samples[1], { ...dataset.samples[2], occurrence: 'not-detected' }];
    const result = analyzeEnvironmentalDataset(dataset);
    expect(result.biomes[0]).toMatchObject({ detected: 0, notDetected: 2, detectionFraction: 0, meanAbundance: 0, abundanceSamples: 1 });
  });

  it('returns snapshots, leaving both input and subsequently computed outputs independent', () => {
    const input = fixture(), validated = validateEnvironmentalDataset(input), result = analyzeEnvironmentalDataset(input);
    input.query.label = 'Changed'; input.samples[0].location!.latitude = 50; input.samples[0].abundance = 999;
    expect(validated.query.label).toBe('Explicit test query'); expect(validated.samples[0].abundance).toBe(6);
    expect(result.locations[0].latitude).toBe(0); expect(result.biomes[0].meanAbundance).toBe(8 / 3);
  });
});

describe('strict local environmental input boundaries', () => {
  it('round-trips supported input without normalizing away query labels or sample identity', () => {
    const dataset = fixture(); dataset.query.label = '  locally declared label  '; dataset.samples[0].id = ' id with spaces ';
    expect(parseEnvironmentalDataset(serializeEnvironmentalDataset(dataset))).toEqual(dataset);
  });

  it.each(['0000', '1900-02-29', '2023-02-29', '2024-04-31', '2024-00', '2024-13', '2024-01-00', '2024-1', '2024-01-01T00:00:00Z', ' 2024'])('rejects invalid or overprecise collection date %s', date => {
    const dataset = fixture(); dataset.samples[0].collectionDate = date;
    expect(() => validateEnvironmentalDataset(dataset)).toThrow(/date/);
  });

  it.each(['0001', '1900-02-28', '2000-02-29', '2024-02-29', '9999-12-31', '2024-12'])('preserves valid Gregorian precision %s', date => {
    const dataset = fixture(); dataset.samples[0].collectionDate = date;
    expect(validateEnvironmentalDataset(dataset).samples[0].collectionDate).toBe(date);
  });

  it('rejects malformed sample dimensions, identifiers, controls and unknown fields', () => {
    const bad: unknown[] = [
      { ...fixture(), samples: {} }, { ...fixture(), samples: [fixture().samples[0], fixture().samples[0]] },
      { ...fixture(), samples: [{ ...fixture().samples[0], country: '' }] },
      { ...fixture(), samples: [{ ...fixture().samples[0], id: 'a\tb' }] },
      { ...fixture(), samples: [{ ...fixture().samples[0], extra: 1 }] },
      { ...fixture(), query: { ...fixture().query, extra: true } },
      { ...fixture(), source: { ...fixture().source, uploadUrl: 'https://example.invalid' } },
      { ...fixture(), measurement: { ...fixture().measurement, units: 'reads' } },
      { ...fixture(), extra: true },
    ];
    for (const value of bad) expect(() => validateEnvironmentalDataset(value)).toThrow();
    const missing = structuredClone(fixture()) as unknown as Record<string, unknown>;
    delete missing.query;
    expect(() => validateEnvironmentalDataset(missing)).toThrow(/missing/);
  });

  it('rejects unknown versions, units and source or occurrence categories', () => {
    for (const value of [
      { ...fixture(), version: 2 }, { ...fixture(), measurement: { ...fixture().measurement, type: 'PFU/mL' } },
      { ...fixture(), source: { ...fixture().source, kind: 'catalog' } },
      { ...fixture(), samples: [{ ...fixture().samples[0], occurrence: 'absent' }] },
      { ...fixture(), samples: [{ ...fixture().samples[0], biome: 'arbitrary-biome' }] },
    ]) expect(() => validateEnvironmentalDataset(value)).toThrow();
  });

  it('rejects invalid coordinates and precision without substituting a geographic estimate', () => {
    const original = fixture().samples[0].location!;
    for (const location of [
      { ...original, latitude: 90.1 }, { ...original, longitude: -180.1 }, { ...original, latitude: NaN },
      { ...original, uncertaintyKm: -1 }, { ...original, uncertaintyKm: Infinity }, { ...original, latitude: '1' },
      { latitude: 1, longitude: 2 }, { ...original, centroid: true },
    ]) expect(() => validateEnvironmentalDataset({ ...fixture(), samples: [{ ...fixture().samples[0], location }] })).toThrow();
  });

  it('refuses imputed missing observations and inconsistent zero or positive abundances', () => {
    for (const sample of [
      { ...fixture().samples[0], occurrence: 'not-assayed', abundance: 0 },
      { ...fixture().samples[0], occurrence: 'detected', abundance: 0 },
      { ...fixture().samples[0], occurrence: 'not-detected', abundance: 2 },
      { ...fixture().samples[0], abundance: -1 }, { ...fixture().samples[0], abundance: 0.5 },
      { ...fixture().samples[0], abundance: Infinity }, { ...fixture().samples[0], abundance: 1e12 + 1 },
    ]) expect(() => validateEnvironmentalDataset({ ...fixture(), samples: [sample] })).toThrow();
    expect(() => validateEnvironmentalDataset({ ...fixture(), measurement: { ...fixture().measurement, type: 'presence' } })).toThrow(/Presence/);
    expect(() => validateEnvironmentalDataset({ ...fixture(), measurement: { ...fixture().measurement, type: 'relative-abundance' } })).toThrow(/Abundance/);
  });

  it('bounds sample count and UTF-8 input, including whitespace before JSON parsing', () => {
    expect(() => parseEnvironmentalDataset(' '.repeat(ENVIRONMENTAL_LIMITS.bytes + 1))).toThrow(/4 MiB/);
    expect(() => parseEnvironmentalDataset('é'.repeat(ENVIRONMENTAL_LIMITS.bytes / 2 + 1))).toThrow(/4 MiB/);
    expect(() => validateEnvironmentalDataset({ ...fixture(), samples: Array(ENVIRONMENTAL_LIMITS.samples + 1).fill(fixture().samples[0]) })).toThrow(/5000/);
  });
});

describe('explicit abundance-to-environment integration', () => {
  it('selects an exact taxon, joins shuffled metadata by sample ID and preserves units and zeros', () => {
    const input = abundanceFixture(), result = environmentalDatasetFromAbundance(input, 'q');
    expect(result.query).toEqual({ id: 'q', label: 'q', accession: null });
    expect(result.source).toMatchObject({ study: 'Community panel: Attributed community count matrix', reference: 'local-study:1', license: null });
    expect(result.measurement.type).toBe('counts');
    expect(result.samples.map(s => [s.id, s.abundance, s.occurrence, s.biome])).toEqual([
      ['s1', 2, 'detected', 'freshwater'], ['s2', 0, 'not-detected', 'unknown'],
      ['s3', 5, 'detected', 'wastewater'], ['s4', 0, 'not-detected', 'unknown'],
    ]);
    expect(result.samples[0]).toMatchObject({ country: 'France', location: null, collectionDate: '2020', accession: 'local:s1' });
    expect(result.samples[1].location).toBeNull();
    expect(result.samples[2].location).toEqual({ latitude: -12.5, longitude: 100, uncertaintyKm: 3.5 });
    expect(result.samples[2].collectionDate).toBe('2020-02');
    expect(() => environmentalDatasetFromAbundance(input, 'Q')).toThrow(/exact taxon/);
    expect(() => environmentalDatasetFromAbundance(input, 'q ')).toThrow(/exact taxon/);
  });

  it('retains each relative-abundance column denominator rather than converting it into containment', () => {
    const input = abundanceFixture(); input.units = 'relative-abundance'; input.table.counts = [[0.2, 0, 0.5, 0], [0.8, 1, 0.5, 0]];
    const result = environmentalDatasetFromAbundance(input, 'q');
    expect(result.samples.map(s => s.abundance)).toEqual([0.2, 0, 0.5, 0]);
    expect(result.measurement.type).toBe('relative-abundance');
    expect(result.measurement.normalization).toContain('No rescaling');
  });

  it('preserves valid maximum-length taxon identifiers without overflowing an invented dataset title', () => {
    const input = abundanceFixture(), taxon = 'q'.repeat(512); input.table.taxa[0] = taxon;
    const result = environmentalDatasetFromAbundance(input, taxon);
    expect(result.query.id).toBe(taxon); expect(result.name).toBe(input.name);
  });

  it('recognizes explicit water categories without guessing for generic or ambiguous descriptions', () => {
    expect(['freshwater', 'wastewater', 'hot_spring', 'sea water', 'water', 'underground water', 'constructor', '__proto__'].map(environmentalBiome))
      .toEqual(['freshwater', 'wastewater', 'hot_spring', 'marine', 'unknown', 'unknown', 'unknown', 'unknown']);
  });

  it('rejects supplied malformed coordinates, incomplete coordinate pairs and invalid dates', () => {
    for (const metadata of [
      { latitude: '1' }, { longitude: 1 }, { uncertaintyKm: '4' }, { latitude: '', longitude: '1' },
      { latitude: '12 degrees north', longitude: '1' }, { latitude: '0x10', longitude: '1' },
      { latitude: 91, longitude: 1 }, { latitude: 1, longitude: 2, uncertaintyKm: -1 },
      { collectionDate: '2023-02-29' }, { country: 3 }, { habitat: 3 },
    ]) {
      const input = abundanceFixture(); input.metadata = [{ sampleId: 's1', ...metadata }];
      expect(() => environmentalDatasetFromAbundance(input, 'q')).toThrow();
    }
  });

  it('does not silently make missing abundance observations into zeros', () => {
    const input = abundanceFixture() as unknown as { table: { counts: unknown[][] } };
    input.table.counts[0][0] = null;
    expect(() => environmentalDatasetFromAbundance(input as unknown as AbundanceDataset, 'q')).toThrow(/missing values are not zeros/);
  });
});

describe('environmental evidence identity and portable exports', () => {
  it('round-trips typed evidence by fresh computation without original object identity', async () => {
    const dataset = fixture(), analysis = analyzeEnvironmentalDataset(dataset), record = await createEnvironmentalAnalysisRecord(dataset, analysis);
    const replay = await replayEnvironmentalAnalysisRecord(serializeAnalysisRecord(record));
    expect(replay).toEqual({ dataset, analysis, record });
    expect(record.method).toEqual(ENVIRONMENTAL_METHOD);
    expect(record.inputs[0]).toMatchObject({ id: 'dataset', source: 'local', accession: 'local:query-1' });
    expect(record.parameters).toEqual({}); expect(record.seed).toBeNull();
    expect(record.fields.environment).toMatchObject({ kind: 'observation', sourceInput: 'dataset', value: analysis });
  });

  it('binds changed observations, attribution, uncertainty, query identity and date precision', async () => {
    const first = fixture(), initial = await createEnvironmentalAnalysisRecord(first, analyzeEnvironmentalDataset(first));
    const mutations: Array<(input: EnvironmentalDataset) => void> = [
      input => { input.samples[0].abundance = 7; }, input => { input.source.version = 'test-2'; },
      input => { input.samples[0].location!.uncertaintyKm = null; }, input => { input.query.id = 'query-2'; },
      input => { input.samples[0].collectionDate = '2000-02'; },
    ];
    for (const mutation of mutations) {
      const changed = fixture(); mutation(changed);
      const record = await createEnvironmentalAnalysisRecord(changed, analyzeEnvironmentalDataset(changed));
      expect(record.cacheKey).not.toBe(initial.cacheKey); expect(record.resultId).not.toBe(initial.resultId);
    }
  });

  it('refuses stale or invented summaries at producer and TSV boundaries', async () => {
    const dataset = fixture(), analysis = analyzeEnvironmentalDataset(dataset); analysis.totals.detected = 999;
    await expect(createEnvironmentalAnalysisRecord(dataset, analysis)).rejects.toThrow(/freshly summarized/);
    expect(() => environmentalEvidenceTsv(dataset, analysis)).toThrow(/freshly summarized/);
  });

  it('rejects stale hashes and freshly rehashed false numerical results', async () => {
    const dataset = fixture(), analysis = analyzeEnvironmentalDataset(dataset), record = await createEnvironmentalAnalysisRecord(dataset, analysis);
    const tampered = structuredClone(record);
    tampered.fields.environment.value = analysisJson({ ...analysis, totals: { ...analysis.totals, detected: 5000 } });
    await expect(replayEnvironmentalAnalysisRecord(serializeAnalysisRecord(tampered))).rejects.toThrow(/checksum/);
    const forged = await rehash(tampered);
    await expect(parseAnalysisRecord(serializeAnalysisRecord(forged))).resolves.toBeDefined();
    await expect(replayEnvironmentalAnalysisRecord(serializeAnalysisRecord(forged))).rejects.toThrow(/Recomputed/);
  });

  it('rejects unsupported producer versions and altered computation contracts even with valid hashes', async () => {
    const dataset = fixture(), analysis = analyzeEnvironmentalDataset(dataset), record = await createEnvironmentalAnalysisRecord(dataset, analysis);
    for (const change of [
      (r: AnalysisRecord) => { r.method.version = '2'; },
      (r: AnalysisRecord) => { r.method.implementation = 'Another implementation'; },
      (r: AnalysisRecord) => { r.parameters = { assumeZeroForMissing: true }; },
      (r: AnalysisRecord) => { r.seed = 42; },
      (r: AnalysisRecord) => { r.references[0].version = 'forged'; },
    ]) {
      const tampered = structuredClone(record); change(tampered);
      await expect(replayEnvironmentalAnalysisRecord(serializeAnalysisRecord(await rehash(tampered)))).rejects.toThrow();
    }
  });

  it('labels every synthetic record field as demonstration evidence', async () => {
    const dataset = createDemoEnvironmentalDataset(), record = await createEnvironmentalAnalysisRecord(dataset, analyzeEnvironmentalDataset(dataset));
    expect(dataset.source.kind).toBe('demo'); expect(dataset.query.id).toBe('synthetic-query');
    expect(record.inputs[0].source).toBe('demo');
    expect(Object.values(record.fields).every(field => field.kind === 'demo')).toBe(true);
    expect((await replayEnvironmentalAnalysisRecord(serializeAnalysisRecord(record))).record.resultId).toBe(record.resultId);
  });

  it('exports all observations with source, units and distinct zero/missing cells', () => {
    const dataset = fixture(), report = environmentalEvidenceTsv(dataset, analyzeEnvironmentalDataset(dataset));
    expect(report).toContain('"reference":"Test fixture, not empirical research"');
    expect(report).toContain('"normalization":"Counts per equal-volume sample"');
    const rows = report.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual(['A', 'sample:A', 'freshwater', 'Exampleland', '0', '0', '10', '2000-02-29', 'detected', '6', 'counts']);
    expect(rows[2][7]).toBe('2024'); expect(rows[2][9]).toBe('0');
    expect(rows[3][9]).toBe(''); expect(rows[4][8]).toBe('not-assayed'); expect(rows[4][9]).toBe('');
  });
});
