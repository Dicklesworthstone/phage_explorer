/**
 * Imported categorical host-range observations, never annotation-derived scores.
 * Assays and conditions are kept separate. A positive spot-clearing observation
 * does not establish productive infection; see doi:10.1371/journal.pone.0118557.
 * Coverage is descriptive of these observations, not cocktail compatibility,
 * clinical efficacy, or a prediction about untested strains.
 */
export const HOST_RANGE_METHOD = 'categorical-host-range-v1' as const;
export const HOST_RANGE_LIMITS = { bytes: 2_000_000, observations: 5000, phages: 128, hosts: 256, contexts: 64 } as const;
export type HostRangeAssay = 'plaque' | 'spot';
export type HostRangeOutcome = 'positive' | 'negative' | 'indeterminate';
export type HostRangeStatus = HostRangeOutcome | 'mixed' | 'insufficient' | 'untested';
export interface HostRangeObservation {
  phageId: string;
  hostId: string;
  assay: HostRangeAssay;
  condition: string;
  replicate: string;
  outcome: HostRangeOutcome;
  source: string;
}
export interface HostRangeQuery {
  assay: HostRangeAssay;
  condition: string;
  minReplicates: number;
  phageIds: string[];
  hostIds: string[];
}
export interface HostRangeExperiment {
  schemaVersion: 1;
  method: typeof HOST_RANGE_METHOD;
  title: string;
  provenance: 'user-supplied' | 'synthetic';
  observations: HostRangeObservation[];
  query: HostRangeQuery;
  selectedPhageIds: string[];
  maxSize: number;
}
export interface HostRangeCell {
  phageId: string;
  hostId: string;
  status: HostRangeStatus;
  positive: number;
  negative: number;
  indeterminate: number;
  observationIndices: number[];
}
export interface HostRangeMatrix {
  query: HostRangeQuery;
  cells: HostRangeCell[][];
  includedObservations: number;
  excludedObservations: number;
  warnings: string[];
}
export interface HostRangeCoverage {
  selectedPhageIds: string[];
  supportedHostIds: string[];
  negativeHostIds: string[];
  unresolvedHostIds: string[];
  coverageFraction: number;
}
export interface HostRangeSelection extends HostRangeCoverage {
  algorithm: 'deterministic-greedy-observed-coverage';
  optimalityProven: false;
  steps: Array<{ phageId: string; newlySupportedHostIds: string[] }>;
}
const COLUMNS = ['phage_id', 'host_id', 'assay', 'condition', 'replicate', 'outcome', 'source'];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const key = (...values: string[]): string => JSON.stringify(values);
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be nonempty text without control characters (up to ${max} characters).`);
  }
  return value.trim();
}
function assay(value: unknown): HostRangeAssay {
  if (value !== 'plaque' && value !== 'spot') throw new Error('Assay must be plaque or spot; mixed endpoints are not pooled.');
  return value;
}
function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length > HOST_RANGE_LIMITS.bytes || new TextEncoder().encode(value).byteLength > HOST_RANGE_LIMITS.bytes) {
    throw new Error('Host-range input exceeds the 2 MB UTF-8 limit.');
  }
  return value.replace(/^\uFEFF/, '');
}
export function validateHostRangeObservations(input: unknown): HostRangeObservation[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > HOST_RANGE_LIMITS.observations) throw new Error('Provide 1–5000 host-range observations.');
  const identities = new Set<string>();
  const phages = new Set<string>();
  const hosts = new Set<string>();
  const contexts = new Set<string>();
  const rows = Array.from(input, (raw, index): HostRangeObservation => {
    const value = record(raw, `Observation ${index + 1}`);
    const row: HostRangeObservation = {
      phageId: text(value.phageId, 'Phage ID'), hostId: text(value.hostId, 'Host strain ID'), assay: assay(value.assay),
      condition: text(value.condition, 'Assay condition', 500), replicate: text(value.replicate, 'Replicate ID'),
      outcome: value.outcome as HostRangeOutcome, source: text(value.source, 'Observation source', 2000),
    };
    if (!['positive', 'negative', 'indeterminate'].includes(row.outcome)) throw new Error(`Observation ${index + 1}: outcome must be positive, negative, or indeterminate.`);
    // A repeated line cannot inflate evidence, nor silently override a contrary result.
    const identity = key(row.phageId, row.hostId, row.assay, row.condition, row.source, row.replicate);
    if (identities.has(identity)) throw new Error(`Observation ${index + 1}: duplicate assay/source/replicate identity.`);
    identities.add(identity); phages.add(row.phageId); hosts.add(row.hostId); contexts.add(key(row.assay, row.condition));
    return row;
  });
  if (phages.size > HOST_RANGE_LIMITS.phages || hosts.size > HOST_RANGE_LIMITS.hosts || contexts.size > HOST_RANGE_LIMITS.contexts) {
    throw new Error('Dataset exceeds 128 phages, 256 host strains, or 64 assay/condition contexts.');
  }
  return rows;
}

/** Bounded strict CSV/TSV parser, including quoted delimiters and escaped quotes. */
export function parseHostRangeCSV(input: string): HostRangeObservation[] {
  const source = boundedText(input);
  const firstLine = source.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  const finishRow = () => {
    row.push(field); field = '';
    if (row.some(value => value !== '')) records.push(row);
    row = [];
    if (records.length > HOST_RANGE_LIMITS.observations + 1) throw new Error('Provide at most 5000 observations.');
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += ch;
      continue;
    }
    if (ch === delimiter) { row.push(field); field = ''; state = 'plain'; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      finishRow(); state = 'plain';
    } else if (ch === '"' && field === '' && state === 'plain') state = 'quoted';
    else {
      if (state === 'closed' || ch === '"') throw new Error('Malformed CSV: unexpected character around a quoted field.');
      field += ch;
    }
    if (row.length >= COLUMNS.length) throw new Error('CSV contains too many columns.');
  }
  if (state === 'quoted') throw new Error('Malformed CSV: unterminated quoted field.');
  if (field || row.length || state === 'closed') finishRow();
  const header = records.shift()?.map(value => value.trim());
  if (!header || header.length !== COLUMNS.length || header.some((value, i) => value !== COLUMNS[i])) {
    throw new Error(`Expected CSV/TSV header: ${COLUMNS.join(',')}`);
  }
  return validateHostRangeObservations(records.map((values, i) => {
    if (values.length !== COLUMNS.length) throw new Error(`Record ${i + 2}: expected seven columns, including explicit outcome and source.`);
    return { phageId: values[0], hostId: values[1], assay: values[2], condition: values[3], replicate: values[4], outcome: values[5], source: values[6] };
  }));
}

export function hostRangeContexts(input: readonly HostRangeObservation[]): Array<{ assay: HostRangeAssay; condition: string }> {
  const rows = validateHostRangeObservations(input);
  const contexts = new Map<string, { assay: HostRangeAssay; condition: string }>();
  for (const row of rows) contexts.set(key(row.assay, row.condition), { assay: row.assay, condition: row.condition });
  return [...contexts.entries()].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}
function idList(input: unknown, name: string, allowed: Set<string>): string[] {
  if (!Array.isArray(input) || !input.length || input.length > allowed.size) throw new Error(`${name} must be a nonempty list of dataset IDs.`);
  const ids = Array.from(input, value => text(value, name));
  if (new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) throw new Error(`${name} contains duplicate or unknown IDs.`);
  return ids.sort(compare);
}
function queryFor(input: unknown, rows: HostRangeObservation[]): HostRangeQuery {
  const value = record(input, 'Query');
  const query: HostRangeQuery = {
    assay: assay(value.assay), condition: text(value.condition, 'Assay condition', 500),
    minReplicates: value.minReplicates as number,
    phageIds: idList(value.phageIds, 'Phage IDs', new Set(rows.map(row => row.phageId))),
    hostIds: idList(value.hostIds, 'Host IDs', new Set(rows.map(row => row.hostId))),
  };
  if (!Number.isInteger(query.minReplicates) || query.minReplicates < 1 || query.minReplicates > 100) throw new Error('Minimum replicates must be an integer from 1 to 100.');
  if (!rows.some(row => row.assay === query.assay && row.condition === query.condition)) throw new Error('The requested assay/condition does not occur in this dataset.');
  return query;
}
export function buildHostRangeMatrix(input: readonly HostRangeObservation[], suppliedQuery: HostRangeQuery): HostRangeMatrix {
  const rows = validateHostRangeObservations(input);
  const query = queryFor(suppliedQuery, rows);
  const byPair = new Map<string, HostRangeCell>();
  const cells = query.phageIds.map(phageId => query.hostIds.map(hostId => {
    const cell: HostRangeCell = { phageId, hostId, status: 'untested', positive: 0, negative: 0, indeterminate: 0, observationIndices: [] };
    byPair.set(key(phageId, hostId), cell); return cell;
  }));
  let includedObservations = 0;
  rows.forEach((row, index) => {
    if (row.assay !== query.assay || row.condition !== query.condition) return;
    const cell = byPair.get(key(row.phageId, row.hostId));
    if (!cell) return;
    cell[row.outcome]++; cell.observationIndices.push(index); includedObservations++;
  });
  for (const cell of byPair.values()) {
    if (cell.positive && cell.negative) cell.status = 'mixed';
    else if (cell.indeterminate) cell.status = 'indeterminate';
    else if (cell.positive >= query.minReplicates) cell.status = 'positive';
    else if (cell.negative >= query.minReplicates) cell.status = 'negative';
    else if (cell.positive || cell.negative) cell.status = 'insufficient';
  }
  return { query, cells, includedObservations, excludedObservations: rows.length - includedObservations,
    warnings: [
      'These are user-reported assay outcomes, not independently verified observations or clinical recommendations.',
      'Only the exact selected assay and condition are pooled. Host strain IDs are not collapsed into species names.',
      'Replicate IDs must represent independent observations. Labels alone cannot establish independence.',
      'Mixed, indeterminate, insufficient, and untested cells never count as supported coverage. Negative means negative under the recorded assay conditions only.',
      query.assay === 'spot' ? 'Spot clearing is not proof of productive infection; spot coverage describes clearing observations only.' : 'Plaque coverage describes reported plaque outcomes; it does not establish mixture compatibility, in-vivo efficacy, or safety.',
    ] };
}
function coverageFor(matrix: HostRangeMatrix, suppliedIds: readonly string[]): HostRangeCoverage {
  if (!Array.isArray(suppliedIds)) throw new Error('Selected phages must be an array.');
  const selected = Array.from(suppliedIds);
  if (new Set(selected).size !== selected.length || selected.some(id => !matrix.query.phageIds.includes(id))) throw new Error('Selected phages contain duplicate or unknown candidate IDs.');
  selected.sort(compare);
  const indices = selected.map(id => matrix.query.phageIds.indexOf(id));
  const supportedHostIds: string[] = [], negativeHostIds: string[] = [], unresolvedHostIds: string[] = [];
  matrix.query.hostIds.forEach((host, column) => {
    const statuses = indices.map(index => matrix.cells[index][column].status);
    if (statuses.includes('positive')) supportedHostIds.push(host);
    else if (statuses.length && statuses.every(status => status === 'negative')) negativeHostIds.push(host);
    else unresolvedHostIds.push(host);
  });
  return { selectedPhageIds: selected, supportedHostIds, negativeHostIds, unresolvedHostIds, coverageFraction: supportedHostIds.length / matrix.query.hostIds.length };
}
export function evaluateHostRangeCoverage(input: readonly HostRangeObservation[], query: HostRangeQuery, selectedIds: readonly string[]): HostRangeCoverage {
  return coverageFor(buildHostRangeMatrix(input, query), selectedIds);
}
/** Maximum-coverage heuristic over reported positives; NOT compatibility inference. */
export function selectHostRangeCoverage(input: readonly HostRangeObservation[], query: HostRangeQuery, maxSize: number): HostRangeSelection {
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 10) throw new Error('Maximum selection size must be an integer from 1 to 10.');
  const matrix = buildHostRangeMatrix(input, query);
  const selected: string[] = [];
  const covered = new Set<string>();
  const steps: HostRangeSelection['steps'] = [];
  while (selected.length < maxSize) {
    let best: { phageId: string; newlySupportedHostIds: string[] } | undefined;
    matrix.query.phageIds.forEach((phageId, index) => {
      if (selected.includes(phageId)) return;
      const gain = matrix.cells[index].filter(cell => cell.status === 'positive' && !covered.has(cell.hostId)).map(cell => cell.hostId);
      if (gain.length && (!best || gain.length > best.newlySupportedHostIds.length)) best = { phageId, newlySupportedHostIds: gain };
    });
    if (!best) break;
    selected.push(best.phageId); best.newlySupportedHostIds.forEach(host => covered.add(host)); steps.push(best);
  }
  return { ...coverageFor(matrix, selected), algorithm: 'deterministic-greedy-observed-coverage', optimalityProven: false, steps };
}
export function parseHostRangeExperiment(input: string): HostRangeExperiment {
  const value = record(JSON.parse(boundedText(input)), 'Experiment');
  if (value.schemaVersion !== 1 || value.method !== HOST_RANGE_METHOD) throw new Error('Unsupported host-range experiment version or method.');
  if (value.provenance !== 'user-supplied' && value.provenance !== 'synthetic') throw new Error('Explicit user-supplied or synthetic provenance is required.');
  const observations = validateHostRangeObservations(value.observations);
  const query = queryFor(value.query, observations);
  if (!Number.isInteger(value.maxSize) || (value.maxSize as number) < 1 || (value.maxSize as number) > 10) throw new Error('Saved maximum selection size must be an integer from 1 to 10.');
  if (!Array.isArray(value.selectedPhageIds)) throw new Error('Saved selected phage IDs are required.');
  const selectedPhageIds = coverageFor(buildHostRangeMatrix(observations, query), value.selectedPhageIds).selectedPhageIds;
  return { schemaVersion: 1, method: HOST_RANGE_METHOD, title: text(value.title, 'Experiment title'), provenance: value.provenance,
    observations, query, selectedPhageIds, maxSize: value.maxSize as number };
}
/** Saved result fields are ignored on replay. Validate numbers before JSON coercion. */
export function serializeHostRangeExperiment(input: HostRangeExperiment): string {
  const observations = validateHostRangeObservations(input.observations);
  const query = queryFor(input.query, observations);
  const experiment = parseHostRangeExperiment(JSON.stringify({ ...input, observations, query }));
  // Do not duplicate a potentially large sparse matrix. Every cell can be
  // reconstructed from the saved inputs; retain the selected-set result.
  const output = JSON.stringify({ ...experiment,
    result: evaluateHostRangeCoverage(experiment.observations, experiment.query, experiment.selectedPhageIds),
  }, null, 2);
  boundedText(output);
  return output;
}
