/** Local sample observations, without inferred geographic positions or ecological mechanisms.
 * Query and source identities are supplied explicitly; this module never searches a catalog or URL.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisField, type AnalysisRecord } from '../analysis-result';
import { validateAbundanceDataset, type AbundanceDataset } from './abundance';
import { BIOME_NAMES, type BiomeType } from './environmental-provenance';

export const ENVIRONMENTAL_LIMITS = { bytes: 4 * 1024 * 1024, samples: 5000 } as const;
export const ENVIRONMENTAL_METHOD = {
  id: 'local-environmental-evidence', version: '1.0.0',
  implementation: 'Declared sample occurrence, observed abundance means and reported coordinates; no ecological or novelty inference',
} as const;

export interface EnvironmentalSample {
  id: string;
  accession: string | null;
  biome: BiomeType;
  country: string | null;
  location: { latitude: number; longitude: number; uncertaintyKm: number | null } | null;
  /** YYYY, YYYY-MM or YYYY-MM-DD. Partial dates retain their stated precision. */
  collectionDate: string | null;
  occurrence: 'detected' | 'not-detected' | 'not-assayed';
  /** Null means unmeasured, not zero. Presence-only records never have abundance. */
  abundance: number | null;
}
export interface EnvironmentalDataset {
  format: 'phage-explorer-environmental'; version: 1; name: string;
  query: { id: string; label: string; accession: string | null };
  source: { kind: 'local' | 'external' | 'demo'; study: string; reference: string | null; version: string; license: string | null };
  measurement: { type: 'presence' | 'counts' | 'relative-abundance'; method: string; normalization: string };
  samples: EnvironmentalSample[];
}
export interface EnvironmentalAnalysis {
  totals: { samples: number; assayed: number; detected: number; notDetected: number; notAssayed: number; located: number; dated: number };
  biomes: Array<{ biome: BiomeType; samples: number; assayed: number; detected: number; notDetected: number; notAssayed: number;
    detectionFraction: number | null; meanAbundance: number | null; abundanceSamples: number }>;
  locations: Array<{ sampleId: string; latitude: number; longitude: number; uncertaintyKm: number | null;
    occurrence: EnvironmentalSample['occurrence'] }>;
  warnings: string[];
}

const BIOMES = Object.keys(BIOME_NAMES) as BiomeType[];
const MAX_COUNT = 1e12; // At 5,000 samples the integer sum remains exactly representable.
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function fields(value: unknown, names: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${context} has missing or unsupported fields.`);
  }
}
function text(value: unknown, context: string, limit = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${context} requires nonempty text of at most ${limit} characters without controls.`);
  }
  // Preserve supplied identifiers and descriptions, including intentional surrounding spaces.
  return value;
}
function nullableText(value: unknown, context: string, limit = 512): string | null {
  return value === null ? null : text(value, context, limit);
}
function finite(value: unknown, lower: number, upper: number, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lower || value > upper) {
    throw new Error(`${context} requires a finite number between ${lower} and ${upper}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}
function bytes(content: string): void {
  if (typeof content !== 'string' || content.length > ENVIRONMENTAL_LIMITS.bytes ||
    new TextEncoder().encode(content).byteLength > ENVIRONMENTAL_LIMITS.bytes) {
    throw new Error('Environmental input exceeds the 4 MiB UTF-8 limit.');
  }
}
function collectionDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) {
    throw new Error('Collection date must be null or a Gregorian YYYY, YYYY-MM or YYYY-MM-DD date.');
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12))) throw new Error('Invalid Gregorian collection date.');
  if (day !== undefined) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (day < 1 || day > days) throw new Error('Invalid Gregorian collection date.');
  }
  return value;
}

/** Validate and snapshot all inputs before computation or asynchronous hashing. */
export function validateEnvironmentalDataset(value: unknown): EnvironmentalDataset {
  fields(value, ['format', 'version', 'name', 'query', 'source', 'measurement', 'samples'], 'Environmental dataset');
  if (value.format !== 'phage-explorer-environmental' || value.version !== 1) throw new Error('Unsupported environmental dataset format/version.');
  fields(value.query, ['id', 'label', 'accession'], 'Environmental query');
  fields(value.source, ['kind', 'study', 'reference', 'version', 'license'], 'Environmental source');
  fields(value.measurement, ['type', 'method', 'normalization'], 'Environmental measurement');
  if (!['local', 'external', 'demo'].includes(value.source.kind as string)) throw new Error('Unsupported environmental source kind.');
  if (!['presence', 'counts', 'relative-abundance'].includes(value.measurement.type as string)) throw new Error('Unsupported environmental measurement type.');
  if (!Array.isArray(value.samples) || value.samples.length > ENVIRONMENTAL_LIMITS.samples) {
    throw new Error(`Environmental samples must be an array of at most ${ENVIRONMENTAL_LIMITS.samples} records.`);
  }
  const type = value.measurement.type as EnvironmentalDataset['measurement']['type'];
  const seen = new Set<string>();
  const samples = value.samples.map((sample, index): EnvironmentalSample => {
    const context = `Environmental sample ${index + 1}`;
    fields(sample, ['id', 'accession', 'biome', 'country', 'location', 'collectionDate', 'occurrence', 'abundance'], context);
    const id = text(sample.id, `${context} ID`);
    if (seen.has(id)) throw new Error(`Duplicate environmental sample ID: ${id}`);
    seen.add(id);
    if (!BIOMES.includes(sample.biome as BiomeType)) throw new Error(`${context} has an unsupported biome.`);
    if (!['detected', 'not-detected', 'not-assayed'].includes(sample.occurrence as string)) throw new Error(`${context} has an unsupported occurrence status.`);
    let location: EnvironmentalSample['location'] = null;
    if (sample.location !== null) {
      fields(sample.location, ['latitude', 'longitude', 'uncertaintyKm'], `${context} location`);
      location = { latitude: finite(sample.location.latitude, -90, 90, 'Latitude'),
        longitude: finite(sample.location.longitude, -180, 180, 'Longitude'),
        uncertaintyKm: sample.location.uncertaintyKm === null ? null : finite(sample.location.uncertaintyKm, 0, 40075, 'Location uncertainty in km') };
    }
    let abundance: number | null = null;
    if (sample.abundance !== null) {
      if (type === 'presence') throw new Error('Presence-only records require null abundance; presence is not a numerical abundance.');
      if (sample.occurrence === 'not-assayed') throw new Error('Not-assayed samples require null abundance, not an imputed zero.');
      abundance = finite(sample.abundance, 0, type === 'counts' ? MAX_COUNT : 1, 'Abundance');
      if (type === 'counts' && !Number.isSafeInteger(abundance)) throw new Error('Count abundance must be an integer.');
      if ((sample.occurrence === 'detected') !== (abundance > 0)) {
        throw new Error('Positive abundance requires detected occurrence; zero abundance requires not-detected occurrence.');
      }
    }
    return { id, accession: nullableText(sample.accession, `${context} accession`), biome: sample.biome as BiomeType,
      country: nullableText(sample.country, `${context} country`), location, collectionDate: collectionDate(sample.collectionDate),
      occurrence: sample.occurrence as EnvironmentalSample['occurrence'], abundance };
  });
  const result: EnvironmentalDataset = {
    format: 'phage-explorer-environmental', version: 1, name: text(value.name, 'Environmental dataset name'),
    query: { id: text(value.query.id, 'Query ID'), label: text(value.query.label, 'Query label'),
      accession: nullableText(value.query.accession, 'Query accession') },
    source: { kind: value.source.kind as EnvironmentalDataset['source']['kind'], study: text(value.source.study, 'Study/source description', 2048),
      reference: nullableText(value.source.reference, 'Study reference', 2048), version: text(value.source.version, 'Source version'),
      license: nullableText(value.source.license, 'Source license', 4096) },
    measurement: { type, method: text(value.measurement.method, 'Observation method', 2048),
      normalization: text(value.measurement.normalization, 'Abundance normalization/denominator', 2048) }, samples,
  };
  bytes(JSON.stringify(result));
  return result;
}

export function parseEnvironmentalDataset(content: string): EnvironmentalDataset {
  bytes(content);
  return validateEnvironmentalDataset(JSON.parse(content));
}
export function serializeEnvironmentalDataset(dataset: EnvironmentalDataset): string {
  const content = JSON.stringify(validateEnvironmentalDataset(dataset), null, 2);
  bytes(content);
  return content;
}

function analyzeValidatedDataset(dataset: EnvironmentalDataset): EnvironmentalAnalysis {
  const totals: EnvironmentalAnalysis['totals'] = { samples: dataset.samples.length, assayed: 0, detected: 0,
    notDetected: 0, notAssayed: 0, located: 0, dated: 0 };
  const groups = new Map<BiomeType, EnvironmentalSample[]>();
  const locations: EnvironmentalAnalysis['locations'] = [];
  for (const sample of dataset.samples) {
    if (sample.occurrence === 'not-assayed') totals.notAssayed++;
    else { totals.assayed++; if (sample.occurrence === 'detected') totals.detected++; else totals.notDetected++; }
    if (sample.collectionDate !== null) totals.dated++;
    if (sample.location !== null) {
      totals.located++;
      locations.push({ sampleId: sample.id, ...sample.location, occurrence: sample.occurrence });
    }
    const group = groups.get(sample.biome) ?? [];
    group.push(sample); groups.set(sample.biome, group);
  }
  const biomes: EnvironmentalAnalysis['biomes'] = BIOMES.filter(biome => groups.has(biome)).map(biome => {
    const samples = groups.get(biome)!;
    const detected = samples.filter(sample => sample.occurrence === 'detected').length;
    const notDetected = samples.filter(sample => sample.occurrence === 'not-detected').length;
    const assayed = detected + notDetected;
    const observed = samples.flatMap(sample => sample.abundance === null ? [] : [sample.abundance]);
    // Compensated summation also keeps small relative abundances in the mean.
    let sum = 0, compensation = 0;
    for (const abundance of observed) { const adjusted = abundance - compensation; const next = sum + adjusted;
      compensation = next - sum - adjusted; sum = next; }
    return { biome, samples: samples.length, assayed, detected, notDetected, notAssayed: samples.length - assayed,
      detectionFraction: assayed ? detected / assayed : null, meanAbundance: observed.length ? sum / observed.length : null,
      abundanceSamples: observed.length };
  });
  const warnings = [
    'These are supplied observations for the declared query and sampled panel. Source attribution and assay claims are not independently authenticated.',
    'Detection fractions use assayed samples only. Not-detected means no detection under the supplied method, not biological absence; not-assayed is missing evidence.',
    'Biome sample counts and detection fractions describe this sampling design, not habitat preference, global prevalence, host range, ecological mechanism or sequence novelty.',
    'Reported coordinates are not inferred from country names. Null coordinate uncertainty is unknown precision, not zero uncertainty; partial collection dates are not expanded.',
  ];
  if (dataset.source.kind === 'demo') warnings.push('Every observation in this dataset is an explicitly selected synthetic example; none describes the selected catalog phage.');
  if (!dataset.source.reference) warnings.push('No external study reference was supplied.');
  if (!dataset.source.license) warnings.push('No source license or reuse permission was supplied.');
  if (!totals.samples) warnings.push('No sample observations were supplied. No occurrence or geographic conclusion is available.');
  else if (!totals.assayed) warnings.push('No samples were assayed for this query; every detection fraction is unavailable.');
  if (totals.located < totals.samples) warnings.push(`${totals.samples - totals.located} sample(s) lack reported coordinates and are omitted from location plotting, not the sample summaries.`);
  if (totals.dated < totals.samples) warnings.push(`${totals.samples - totals.dated} sample(s) have no collection date.`);
  if (dataset.measurement.type === 'presence') warnings.push('Presence-only observations have no abundance values or abundance means.');
  else {
    const absent = dataset.samples.filter(sample => sample.occurrence !== 'not-assayed' && sample.abundance === null).length;
    warnings.push(`Mean abundance uses only supplied ${dataset.measurement.type} values under the declared normalization; missing values are excluded, never replaced with zeros.`);
    if (absent) warnings.push(`${absent} assayed sample(s) have a declared occurrence but no measured abundance; abundance denominators are smaller than occurrence denominators.`);
    if (dataset.measurement.type === 'relative-abundance') warnings.push('Relative abundances depend on the supplied sample denominator. They are compositional values, not absolute abundance or sequence containment.');
  }
  return { totals, biomes, locations, warnings };
}

export function analyzeEnvironmentalDataset(dataset: EnvironmentalDataset): EnvironmentalAnalysis {
  return analyzeValidatedDataset(validateEnvironmentalDataset(dataset));
}

function verifyAnalysis(dataset: EnvironmentalDataset, supplied: EnvironmentalAnalysis): EnvironmentalAnalysis {
  const actual = analyzeValidatedDataset(dataset);
  if (JSON.stringify(analysisJson(supplied)) !== JSON.stringify(analysisJson(actual))) {
    throw new Error('Environmental analysis differs from freshly summarized input observations.');
  }
  return actual;
}

/** Bind observations and summaries together; a caller cannot export stale or invented summaries. */
export async function createEnvironmentalAnalysisRecord(dataset: EnvironmentalDataset, analysis: EnvironmentalAnalysis): Promise<AnalysisRecord> {
  const data = validateEnvironmentalDataset(dataset), result = verifyAnalysis(data, analysis);
  const field = (label: string, value: unknown, available: number): AnalysisField => {
    const common = { label, value: analysisJson(value), units: 'records' as const,
      coverage: { available, total: result.totals.samples, unit: 'records' as const }, limitations: result.warnings };
    return data.source.kind === 'demo'
      ? { ...common, kind: 'demo', assumptions: ['All observations are explicitly declared synthetic format examples.'] }
      : { ...common, kind: 'observation', sourceInput: 'dataset' };
  };
  return createAnalysisRecord({ method: ENVIRONMENTAL_METHOD,
    inputs: [{ id: 'dataset', accession: data.query.accession, source: data.source.kind,
      description: `${data.name}: ${data.source.study}`, data: analysisJson(data) }],
    parameters: {}, seed: null,
    references: [{ id: 'supplied-study', version: data.source.version, description: data.source.reference ?? data.source.study }],
    fields: { environment: field('Supplied environmental observations, sample summaries and reported coordinates', result, result.totals.assayed) },
  });
}

/** Verify hashes, then recompute every summary. A correctly rehashed forgery still fails replay. */
export async function replayEnvironmentalAnalysisRecord(content: string): Promise<{
  dataset: EnvironmentalDataset; analysis: EnvironmentalAnalysis; record: AnalysisRecord;
}> {
  const saved = await parseAnalysisRecord(content, { methodId: ENVIRONMENTAL_METHOD.id, methodVersion: ENVIRONMENTAL_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'dataset') throw new Error('Unsupported environmental evidence input contract.');
  const dataset = validateEnvironmentalDataset(saved.inputs[0].data), analysis = analyzeValidatedDataset(dataset);
  const record = await createEnvironmentalAnalysisRecord(dataset, analysis);
  if (serializeAnalysisRecord(saved) !== serializeAnalysisRecord(record)) {
    throw new Error('Recomputed environmental evidence differs from the saved analysis or producer contract.');
  }
  return { dataset, analysis, record };
}

/** Export every sample, including zeros, unassayed samples and missing coordinates/abundances. */
export function environmentalEvidenceTsv(dataset: EnvironmentalDataset, analysis: EnvironmentalAnalysis): string {
  const data = validateEnvironmentalDataset(dataset), result = verifyAnalysis(data, analysis);
  const cell = (value: string | number | null): string => value === null ? '' : typeof value === 'number' ? String(value) :
    value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    `# ${ENVIRONMENTAL_METHOD.id} ${ENVIRONMENTAL_METHOD.version}`,
    `# dataset=${JSON.stringify(data.name)}`,
    `# query=${JSON.stringify(data.query)}`,
    `# source=${JSON.stringify(data.source)}`,
    `# measurement=${JSON.stringify(data.measurement)}`,
    `# totals=${JSON.stringify(result.totals)}`,
    '# Empty fields are unavailable, not zero. Assayed-sample detection fractions are not ecological prevalence.',
    ...result.warnings.map(warning => `# ${warning}`),
    ['sample_id', 'sample_accession', 'biome', 'country', 'latitude', 'longitude', 'uncertainty_km',
      'collection_date', 'occurrence', 'abundance', 'abundance_units'].join('\t'),
    ...data.samples.map(sample => [sample.id, sample.accession, sample.biome, sample.country,
      sample.location?.latitude ?? null, sample.location?.longitude ?? null, sample.location?.uncertaintyKm ?? null,
      sample.collectionDate, sample.occurrence, sample.abundance, data.measurement.type].map(cell).join('\t')),
  ].join('\n') + '\n';
}

const HABITATS: Record<string, BiomeType> = {
  gut: 'gut', 'gut microbiome': 'gut', intestinal: 'gut', feces: 'gut', faeces: 'gut',
  marine: 'marine', ocean: 'marine', 'ocean water': 'marine', sea: 'marine', seawater: 'marine', 'sea water': 'marine',
  freshwater: 'freshwater', 'fresh water': 'freshwater', lake: 'freshwater', river: 'freshwater', 'lake water': 'freshwater', 'river water': 'freshwater',
  soil: 'soil', rhizosphere: 'soil', 'hot spring': 'hot_spring', 'hot springs': 'hot_spring', thermal: 'hot_spring', 'thermal spring': 'hot_spring',
  wastewater: 'wastewater', 'waste water': 'wastewater', sewage: 'wastewater', 'sewage water': 'wastewater', sludge: 'wastewater',
  clinical: 'clinical', 'clinical isolate': 'clinical', hospital: 'clinical',
  food: 'food', fermented: 'food', 'food / fermented': 'food', dairy: 'food', unknown: 'unknown',
};

/** Recognized labels only. Generic water and unrecognized descriptions remain unknown. */
export function environmentalBiome(value: string): BiomeType {
  if (typeof value !== 'string') throw new Error('Habitat must be text.');
  const key = value.trim().toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  return Object.hasOwn(HABITATS, key) ? HABITATS[key] : 'unknown';
}

function metadataNumber(value: unknown, context: string): number {
  if (typeof value === 'number') return finite(value, -Number.MAX_VALUE, Number.MAX_VALUE, context);
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    throw new Error(`${context} must be a finite decimal number.`);
  }
  return finite(Number(value), -Number.MAX_VALUE, Number.MAX_VALUE, context);
}

/** Explicitly select one taxon; join metadata by sample ID and retain supplied units without rescaling. */
export function environmentalDatasetFromAbundance(input: AbundanceDataset, taxon: string): EnvironmentalDataset {
  const dataset = validateAbundanceDataset(input);
  const row = dataset.table.taxa.indexOf(taxon);
  if (row < 0) throw new Error('Select an exact taxon identifier from the supplied abundance dataset.');
  const metadata = new Map(dataset.metadata.map(sample => [sample.sampleId, sample]));
  const samples = dataset.table.samples.map((id, index): EnvironmentalSample => {
    const supplied = metadata.get(id);
    const hasLatitude = supplied !== undefined && Object.hasOwn(supplied, 'latitude');
    const hasLongitude = supplied !== undefined && Object.hasOwn(supplied, 'longitude');
    const hasUncertainty = supplied !== undefined && Object.hasOwn(supplied, 'uncertaintyKm');
    if (hasLatitude !== hasLongitude || (hasUncertainty && !hasLatitude)) throw new Error(`Sample ${id} requires both latitude and longitude for reported location metadata.`);
    const location = hasLatitude ? { latitude: metadataNumber(supplied!.latitude, 'Metadata latitude'),
      longitude: metadataNumber(supplied!.longitude, 'Metadata longitude'),
      uncertaintyKm: hasUncertainty ? metadataNumber(supplied!.uncertaintyKm, 'Metadata uncertaintyKm') : null } : null;
    const habitat = supplied?.habitat;
    if (habitat !== undefined && typeof habitat !== 'string') throw new Error(`Sample ${id} habitat must be text.`);
    const biome = habitat === undefined ? 'unknown' : environmentalBiome(habitat);
    const abundance = dataset.table.counts[row][index];
    return { id, accession: supplied?.accession === undefined ? null : text(supplied.accession, 'Metadata sample accession'), biome,
      country: supplied?.country === undefined ? null : text(supplied.country, 'Metadata country'), location,
      collectionDate: supplied?.collectionDate === undefined ? null : collectionDate(supplied.collectionDate),
      occurrence: abundance === null ? 'not-assayed' : abundance > 0 ? 'detected' : 'not-detected', abundance };
  });
  return validateEnvironmentalDataset({ format: 'phage-explorer-environmental', version: 1,
    name: dataset.name,
    query: { id: taxon, label: taxon, accession: null },
    source: { kind: dataset.source.kind, study: dataset.source.study ?? `${dataset.name}: ${dataset.source.description}`, reference: dataset.source.reference,
      version: dataset.source.version ?? `phage-explorer-abundance/v${dataset.version}`, license: dataset.source.license ?? null },
    measurement: { type: dataset.units, method: 'Explicit selected row of the supplied abundance table; no sequence or taxonomic matching.',
      normalization: dataset.normalization
        ? `Declared ${dataset.normalization.kind}: ${dataset.normalization.description} Original supplied observations; no rescaling or imputation. This source declaration is not independently verified.`
        : dataset.units === 'counts' ? 'Original supplied counts; no rescaling. Count denominator and collection effort are not established by the table format.'
          : dataset.version === 2 ? 'Original supplied relative abundances; complete nonempty columns sum to one. Incomplete columns retain their reported fractions and missing observations. No rescaling or absolute-abundance inference.'
            : 'Original supplied relative abundances; each nonempty input column sums to one. No rescaling or absolute-abundance inference.' }, samples });
}

/** Transparent format example. Its identities and observations never depend on the selected phage. */
export function createDemoEnvironmentalDataset(): EnvironmentalDataset {
  return validateEnvironmentalDataset({ format: 'phage-explorer-environmental', version: 1,
    name: 'Synthetic environmental format example', query: { id: 'synthetic-query', label: 'Synthetic query — no catalog association', accession: null },
    source: { kind: 'demo', study: 'Hand-constructed synthetic samples illustrating zeros, missing values and location/date precision.',
      reference: null, version: '1', license: 'CC0 for this synthetic example only' },
    measurement: { type: 'counts', method: 'Invented illustrative counts, not an experimental assay.', normalization: 'Synthetic counts per example sample; no real sampling denominator.' },
    samples: [
      { id: 'DEMO-1', accession: null, biome: 'marine', country: null, location: { latitude: 0, longitude: 0, uncertaintyKm: 100 }, collectionDate: '2000', occurrence: 'detected', abundance: 12 },
      { id: 'DEMO-2', accession: null, biome: 'freshwater', country: null, location: null, collectionDate: '2000-02-29', occurrence: 'not-detected', abundance: 0 },
      { id: 'DEMO-3', accession: null, biome: 'wastewater', country: null, location: { latitude: 1, longitude: 1, uncertaintyKm: null }, collectionDate: null, occurrence: 'not-assayed', abundance: null },
      { id: 'DEMO-4', accession: null, biome: 'soil', country: null, location: null, collectionDate: '2000-03', occurrence: 'detected', abundance: 3 },
      { id: 'DEMO-5', accession: null, biome: 'marine', country: null, location: null, collectionDate: null, occurrence: 'detected', abundance: null },
    ],
  });
}
