/** Portable analysis results. Checksums identify content; they do not certify scientific accuracy. */
export type AnalysisJson = null | boolean | number | string | AnalysisJson[] | { [key: string]: AnalysisJson };
export type AnalysisUnits = 'count' | 'base-pairs' | 'residues' | 'fraction' | 'percent' | 'bits' | 'score' |
  'minutes' | 'PFU/mL' | 'arbitrary-flux' | 'model-flux' | 'records' | 'dimensionless';
export type ScoreUnits = 'count' | 'base-pairs' | 'residues' | 'fraction' | 'percent' | 'bits' | 'score' | 'records' | 'dimensionless';
export type ObservationUnits = Exclude<AnalysisUnits, 'score' | 'arbitrary-flux' | 'model-flux'>;

export interface AnalysisCoverage { available: number; total: number; unit: 'bases' | 'residues' | 'genes' | 'reactions' | 'records' }
interface FieldContext { label: string; limitations: string[]; coverage: AnalysisCoverage }
export type AnalysisField = FieldContext & (
  | { kind: 'observation'; value: AnalysisJson; units: ObservationUnits; sourceInput: string }
  | { kind: 'sequence-score'; value: AnalysisJson; units: ScoreUnits }
  | { kind: 'fitted-estimate'; value: AnalysisJson; units: ObservationUnits; fit: {
      dataInput: string; objective: string;
      uncertainty: { kind: 'not-estimated' } | { kind: 'interval'; method: string; level: number; lower: number; upper: number };
    } }
  | { kind: 'simulation' | 'demo'; value: AnalysisJson; units: AnalysisUnits; assumptions: string[] }
  | { kind: 'unavailable'; value: null; units: null; missingInputs: string[] }
);

export interface AnalysisInput {
  id: string;
  accession: string | null;
  source: 'catalog' | 'local' | 'external' | 'demo';
  description: string;
  data: AnalysisJson;
  sha256: string;
}
export interface AnalysisRecord {
  format: 'phage-explorer-analysis';
  version: 1;
  method: { id: string; version: string; implementation: string };
  inputs: AnalysisInput[];
  parameters: { [key: string]: AnalysisJson };
  seed: string | number | null;
  references: { id: string; version: string; description: string }[];
  fields: Record<string, AnalysisField>;
  /** Method, exact inputs, parameters, seed and reference versions. */
  cacheKey: string;
  /** Also binds output values and their evidence descriptions. */
  resultId: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const SCORE_UNITS: readonly string[] = ['count', 'base-pairs', 'residues', 'fraction', 'percent', 'bits', 'score', 'records', 'dimensionless'];
const UNITS: readonly string[] = [...SCORE_UNITS, 'minutes', 'PFU/mL', 'arbitrary-flux', 'model-flux'];
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** Snapshot plain data before hashing; reject nonfinite or non-JSON results instead of silently changing them. */
export function analysisJson(value: unknown, depth = 0): AnalysisJson {
  if (depth > 64) throw new Error('Analysis data exceeds the nesting limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => analysisJson(item, depth + 1));
  if (object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, analysisJson(value[key], depth + 1)]));
  }
  throw new Error('Analysis data must contain finite numbers and plain JSON values.');
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(analysisJson(value)));
  if (bytes.length > MAX_BYTES) throw new Error('Analysis record exceeds the 10 MiB limit.');
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateRecord(value: unknown): asserts value is AnalysisRecord {
  function invalid(detail: string): never { throw new Error(`Invalid analysis record: ${detail}`); }
  if (!object(value) || value.format !== 'phage-explorer-analysis' || value.version !== 1) invalid('unsupported format/version.');
  if (!object(value.method) || !text(value.method.id) || !text(value.method.version) || !text(value.method.implementation)) invalid('method and version are required.');
  if (!Array.isArray(value.inputs) || value.inputs.length === 0 || value.inputs.some(input => !object(input) ||
    !text(input.id) || !text(input.description) || !['catalog', 'local', 'external', 'demo'].includes(String(input.source)) ||
    !(input.accession === null || text(input.accession)) || !Object.hasOwn(input, 'data') || !hash(input.sha256))) invalid('input identity is incomplete.');
  const inputs = value.inputs as unknown as AnalysisInput[];
  if (new Set(inputs.map(input => input.id)).size !== inputs.length) invalid('duplicate input IDs.');
  if (!object(value.parameters) || !(value.seed === null || typeof value.seed === 'string' || typeof value.seed === 'number' && Number.isFinite(value.seed))) invalid('parameters and explicit seed are required.');
  if (!Array.isArray(value.references) || value.references.some(ref => !object(ref) || !text(ref.id) || !text(ref.version) || !text(ref.description))) invalid('reference versions are required.');
  if (!object(value.fields) || Object.keys(value.fields).length === 0) invalid('no fields.');
  for (const [name, field] of Object.entries(value.fields)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name) || !object(field) || !text(field.label) || !texts(field.limitations) ||
      !object(field.coverage) || !Number.isSafeInteger(field.coverage.available) || !Number.isSafeInteger(field.coverage.total) ||
      Number(field.coverage.available) < 0 || Number(field.coverage.total) < Number(field.coverage.available) ||
      !['bases', 'residues', 'genes', 'reactions', 'records'].includes(String(field.coverage.unit))) invalid(`invalid field ${name}.`);
    if (field.kind === 'unavailable') {
      if (field.value !== null || field.units !== null || !texts(field.missingInputs) || field.missingInputs.length === 0) invalid(`${name} must explain its missing input.`);
      continue;
    }
    if (!Object.hasOwn(field, 'value') || !UNITS.includes(String(field.units))) invalid(`${name} requires a value and supported units.`);
    if (field.kind === 'sequence-score') {
      if (!SCORE_UNITS.includes(String(field.units)) || field.limitations.length === 0 || Object.hasOwn(field, 'confidence')) invalid(`${name} is a score, not a calibrated measurement/probability.`);
    } else if (field.kind === 'observation') {
      const input = inputs.find(input => input.id === field.sourceInput);
      if (!input || input.source === 'demo' || Object.hasOwn(field, 'confidence') || ['score', 'arbitrary-flux', 'model-flux'].includes(String(field.units))) invalid(`${name} lacks a non-demo observation source and observational units.`);
    } else if (field.kind === 'fitted-estimate') {
      const fit = field.fit;
      if (!object(fit) || !text(fit.objective) || !inputs.some(input => input.id === fit.dataInput && input.source !== 'demo') || !object(fit.uncertainty) ||
        Object.hasOwn(field, 'confidence') || ['score', 'arbitrary-flux', 'model-flux'].includes(String(field.units))) invalid(`${name} lacks fit evidence and observational units.`);
      const interval = fit.uncertainty;
      if (interval.kind !== 'not-estimated' && !(interval.kind === 'interval' && text(interval.method) &&
        Number.isFinite(interval.level) && Number(interval.level) > 0 && Number(interval.level) < 1 &&
        Number.isFinite(interval.lower) && Number.isFinite(interval.upper) && Number(interval.lower) <= Number(interval.upper))) invalid(`${name} has unsupported uncertainty.`);
    } else if (field.kind === 'simulation' || field.kind === 'demo') {
      if (!texts(field.assumptions) || field.assumptions.length === 0 || field.limitations.length === 0) invalid(`${name} must state model assumptions and limits.`);
    } else invalid(`${name} has an unsupported evidence kind.`);
  }
  if (!hash(value.cacheKey) || !hash(value.resultId)) invalid('missing record checksums.');
}

function cacheIdentity(record: AnalysisRecord): unknown {
  return { format: record.format, version: record.version, method: record.method,
    inputs: record.inputs.map(({ data: _data, ...identity }) => identity),
    parameters: record.parameters, seed: record.seed, references: record.references };
}

export async function createAnalysisRecord(options: Omit<AnalysisRecord, 'format' | 'version' | 'cacheKey' | 'resultId' | 'inputs'> & {
  inputs: Omit<AnalysisInput, 'sha256'>[];
}): Promise<AnalysisRecord> {
  // Copy before the first await so a selection or parameter change cannot alter this result's inputs.
  const record = analysisJson({ ...options, format: 'phage-explorer-analysis', version: 1,
    cacheKey: '0'.repeat(64), resultId: '0'.repeat(64), inputs: options.inputs.map(input => ({ ...input, sha256: '0'.repeat(64) })) });
  validateRecord(record);
  for (const input of record.inputs) input.sha256 = await digest(input.data);
  record.cacheKey = await digest(cacheIdentity(record));
  record.resultId = await digest({ cacheKey: record.cacheKey, fields: record.fields });
  serializeAnalysisRecord(record);
  return record;
}

export function serializeAnalysisRecord(record: AnalysisRecord): string {
  validateRecord(record);
  const result = JSON.stringify(analysisJson(record), null, 2);
  if (new TextEncoder().encode(result).length > MAX_BYTES) throw new Error('Analysis record exceeds the 10 MiB limit.');
  return result;
}

/** Validate shape and all content identities before any imported data is applied. */
export async function parseAnalysisRecord(content: string, expected?: { methodId?: string; methodVersion?: string; cacheKey?: string }): Promise<AnalysisRecord> {
  if (new TextEncoder().encode(content).length > MAX_BYTES) throw new Error('Analysis record exceeds the 10 MiB limit.');
  const record: unknown = JSON.parse(content);
  validateRecord(record);
  analysisJson(record);
  if (expected?.methodId && record.method.id !== expected.methodId || expected?.methodVersion && record.method.version !== expected.methodVersion) throw new Error('Analysis method/version is incompatible.');
  for (const input of record.inputs) if (await digest(input.data) !== input.sha256) throw new Error(`Analysis input checksum mismatch: ${input.id}`);
  if (await digest(cacheIdentity(record)) !== record.cacheKey || expected?.cacheKey && record.cacheKey !== expected.cacheKey) throw new Error('Analysis input, parameter or reference identity differs.');
  if (await digest({ cacheKey: record.cacheKey, fields: record.fields }) !== record.resultId) throw new Error('Analysis result checksum mismatch.');
  return record;
}
