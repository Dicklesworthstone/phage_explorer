/** Fixed-root temporal diagnostics for an explicitly supplied, date-independent phylogram.
 * This is not a tree estimator, molecular-clock calibration, skyline or dN/dS analysis.
 * Root-to-tip diagnostics: Rambaut et al. (2016), doi:10.1093/ve/vew007.
 * Newick dialect: PHYLIP/Olsen; quoted labels retain underscores, unquoted ones do not.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const TEMPORAL_LIMITS = { bytes: 2 * 1024 * 1024, tips: 500, depth: 64, nodes: 1000, permutations: 9999 } as const;
export type CollectionDate = number | string | { lower: number; upper: number } | null;
export interface TemporalSample {
  id: string;
  accession: string | null;
  collectionDate: CollectionDate;
  dateSource: string;
  permutationGroup: string | null;
}
export interface TemporalDataset {
  format: 'phage-explorer-temporal-signal';
  version: 1;
  name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string | null; license: string };
  tree: { newick: string; units: 'substitutions/site'; inferredWithoutDates: true;
    method: string; rooting: string; alignmentProvenance: string };
  samples: TemporalSample[];
}
export interface TemporalNode { label: string | null; length: number; children: TemporalNode[] }
export interface TemporalOptions { permutations: number; seed: number; permutationScheme: 'unrestricted' | 'within-groups'; excludedSamples: string[] }
export interface TemporalTip {
  id: string; accession: string | null; distance: number; date: number | null;
  dateRange: { lower: number; upper: number } | null; dateSource: string | null;
  group: string | null; exclusion: string | null;
}
export interface TemporalRegression {
  slope: number; meanDate: number; meanDistance: number; r: number; r2: number;
  sumSquaredResiduals: number; xIntercept: number | null;
  residuals: Array<{ id: string; date: number; distance: number; predicted: number; residual: number; leverage: number; leaveOneOutSlope: number | null }>;
  leaveOneOutSlopeRange: [number, number] | null;
}
export interface TemporalResult {
  options: TemporalOptions; tips: TemporalTip[]; regression: TemporalRegression | null;
  unavailableReason: string | null;
  randomization: { mode: 'exact' | 'monte-carlo'; draws: number; extreme: number; tailFraction: number; groups: number } | null;
  randomizationUnavailableReason: string | null;
  clockCalibrated: false; warnings: string[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, context: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${context} requires nonempty text without control characters (maximum ${max}).`);
  }
  return value.trim();
}
function bytes(content: string): void {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > TEMPORAL_LIMITS.bytes) throw new Error('Temporal input exceeds the 2 MiB limit.');
}
function fields(value: Record<string, unknown>, allowed: string[], context: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unsupported ${context} field.`);
}

/** Require explicit nonnegative branch lengths; absent lengths are not zero measurements. */
export function parseTemporalNewick(content: string): TemporalNode {
  bytes(content);
  let at = 0, nodes = 0, tips = 0;
  const labels = new Set<string>();
  const skip = () => {
    while (at < content.length) {
      if (/\s/.test(content[at])) { at++; continue; }
      if (content[at] !== '[') break;
      const start = at++; let depth = 1;
      while (at < content.length && depth) {
        if (content[at] === '[') depth++;
        if (content[at] === ']') depth--;
        if (depth > 16) throw new Error('Newick comment nesting exceeds the limit.');
        at++;
      }
      if (depth) throw new Error('Unclosed Newick comment.');
      if (/^\[\s*&U\s*\]$/i.test(content.slice(start, at))) throw new Error('The Newick marks this tree as unrooted. Supply an explicitly rooted phylogram.');
    }
  };
  const label = (): string | null => {
    skip(); let value = '';
    if (content[at] === "'") {
      at++; let closed = false;
      while (at < content.length) {
        const c = content[at++];
        if (c === "'") {
          if (content[at] === "'") { value += "'"; at++; } else { closed = true; break; }
        } else value += c;
      }
      if (!closed) throw new Error('Unclosed quoted Newick label.');
      return text(value, 'Newick label', 256);
    }
    while (at < content.length && !/[\s(),:;\[\]']/.test(content[at])) value += content[at++];
    return value ? text(value.replaceAll('_', ' '), 'Newick label', 256) : null;
  };
  const subtree = (depth: number): TemporalNode => {
    if (depth > TEMPORAL_LIMITS.depth || ++nodes > TEMPORAL_LIMITS.nodes) throw new Error('Newick tree exceeds depth/node limits.');
    skip(); const children: TemporalNode[] = [];
    if (content[at] === '(') {
      at++;
      while (true) {
        children.push(subtree(depth + 1)); skip();
        if (content[at] === ',') { at++; continue; }
        if (content[at++] !== ')') throw new Error('Expected a comma or closing parenthesis in Newick.');
        break;
      }
      if (children.length < 2) throw new Error('Internal Newick nodes require at least two children.');
    }
    const name = label(); skip();
    let length = 0;
    if (content[at] === ':') {
      at++; skip(); const start = at;
      while (at < content.length && !/[\s,);\[\]]/.test(content[at])) at++;
      const token = content.slice(start, at);
      if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) throw new Error('Branch lengths must be explicit nonnegative numbers.');
      length = Number(token);
      if (!Number.isFinite(length) || length > 1e6) throw new Error('Branch length is nonfinite or exceeds the supported range.');
    } else if (depth > 0) throw new Error('Every non-root branch needs an explicit length in substitutions/site.');
    if (!children.length) {
      if (!name || labels.has(name)) throw new Error('Newick tips require unique nonempty labels. Quote underscores to preserve literal sample IDs.');
      labels.add(name);
      if (++tips > TEMPORAL_LIMITS.tips) throw new Error('Temporal analysis supports at most 500 tips.');
    }
    return { label: name, length, children };
  };
  const root = subtree(0); skip();
  if (content[at++] !== ';') throw new Error('Newick tree must end with a semicolon.');
  skip();
  if (at !== content.length) throw new Error('Only one Newick tree is supported.');
  if (root.length !== 0) throw new Error('A nonzero root stem is unsupported; distances start at the supplied root.');
  if (!root.children.length) throw new Error('A rooted tree requires at least two tips.');
  return root;
}
export function temporalTreeTips(root: TemporalNode): Array<{ id: string; distance: number }> {
  const result: Array<{ id: string; distance: number }> = [];
  const visit = (node: TemporalNode, distance: number) => {
    const total = distance + node.length;
    if (!Number.isFinite(total)) throw new Error('Nonfinite root-to-tip distance.');
    if (!node.children.length) result.push({ id: node.label!, distance: total });
    else node.children.forEach(child => visit(child, total));
  };
  visit(root, 0); return result;
}

const yearValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 3001;
/** Calendar years/months are intervals, never silently converted into exact collection dates. */
export function collectionDateRange(value: CollectionDate): { lower: number; upper: number } | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!yearValue(value)) throw new Error('Decimal collection year must be between 1000 and 3001.');
    return { lower: value, upper: value };
  }
  if (object(value)) {
    fields(value, ['lower', 'upper'], 'collection-date interval');
    if (!yearValue(value.lower) || !yearValue(value.upper) || value.lower > value.upper) throw new Error('Invalid collection-date interval.');
    return { lower: value.lower, upper: value.upper };
  }
  if (typeof value !== 'string') throw new Error('Unsupported collection date.');
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) throw new Error('Use an ISO collection date, a numeric decimal year, or an explicit lower/upper interval.');
  const year = Number(match[1]), month = Number(match[2] ?? 1), day = Number(match[3] ?? 1);
  if (year < 1000 || year > 3000 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid collection date.');
  const date = Date.UTC(year, month - 1, day);
  if (new Date(date).getUTCMonth() !== month - 1 || new Date(date).getUTCDate() !== day) throw new Error('Invalid calendar collection date.');
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  const lower = year + (date - start) / (end - start);
  return { lower, upper: match[3] ? lower : match[2] ? year + (Date.UTC(year, month, 1) - start) / (end - start) : year + 1 };
}
export function validateTemporalDataset(value: unknown): TemporalDataset {
  if (!object(value) || value.format !== 'phage-explorer-temporal-signal' || value.version !== 1 || !object(value.source) || !object(value.tree)) throw new Error('Unsupported temporal dataset format/version.');
  fields(value, ['format', 'version', 'name', 'source', 'tree', 'samples'], 'temporal dataset');
  fields(value.source, ['kind', 'description', 'reference', 'license'], 'source');
  fields(value.tree, ['newick', 'units', 'inferredWithoutDates', 'method', 'rooting', 'alignmentProvenance'], 'tree');
  if (!['local', 'demo'].includes(String(value.source.kind)) || value.tree.units !== 'substitutions/site' || value.tree.inferredWithoutDates !== true) {
    throw new Error('Supply local/demo provenance and a substitutions/site phylogram inferred and rooted without using these dates; time-scaled/circular clock inputs are not supported.');
  }
  if (typeof value.tree.newick !== 'string') throw new Error('Newick text is required.');
  const tips = temporalTreeTips(parseTemporalNewick(value.tree.newick));
  if (!Array.isArray(value.samples) || value.samples.length > TEMPORAL_LIMITS.tips) throw new Error('Provide at most 500 sample metadata rows.');
  const ids = new Set<string>();
  const samples = value.samples.map(row => {
    if (!object(row)) throw new Error('Sample metadata rows must be objects.');
    fields(row, ['id', 'accession', 'collectionDate', 'dateSource', 'permutationGroup'], 'sample');
    const id = text(row.id, 'Sample ID', 256);
    if (ids.has(id) || !tips.some(tip => tip.id === id)) throw new Error('Sample IDs must be unique and match tree tips exactly; unquoted Newick underscores mean spaces.');
    ids.add(id);
    collectionDateRange(row.collectionDate as CollectionDate);
    return { id, accession: row.accession === null || row.accession === undefined ? null : text(row.accession, 'Accession', 256),
      collectionDate: analysisJson(row.collectionDate) as CollectionDate, dateSource: text(row.dateSource, 'Collection-date source'),
      permutationGroup: row.permutationGroup === null || row.permutationGroup === undefined ? null : text(row.permutationGroup, 'Permutation group', 256) };
  });
  const dataset: TemporalDataset = { format: 'phage-explorer-temporal-signal', version: 1, name: text(value.name, 'Dataset name'),
    source: { kind: value.source.kind as 'local' | 'demo', description: text(value.source.description, 'Source description'),
      reference: value.source.reference === null ? null : text(value.source.reference, 'Source reference'), license: text(value.source.license, 'Source license/permissions') },
    tree: { newick: value.tree.newick, units: 'substitutions/site', inferredWithoutDates: true,
      method: text(value.tree.method, 'Tree method'), rooting: text(value.tree.rooting, 'Rooting method'), alignmentProvenance: text(value.tree.alignmentProvenance, 'Alignment/tree input provenance') }, samples };
  bytes(JSON.stringify(dataset)); return dataset;
}

/** Quoted CSV/TSV sample metadata; a missing date is explicit, never a zero or submission date. */
export function parseTemporalSampleTable(content: string): TemporalSample[] {
  bytes(content); const source = content.replace(/^\uFEFF/, '');
  const delimiter = source.split(/[\r\n]/, 1)[0].includes('\t') ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  const finish = () => { row.push(cell); cell = ''; closed = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === delimiter) finish();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; finish(); rows.push(row); row = []; }
    else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === '"' || closed) throw new Error('Malformed quoted metadata field.');
    else cell += c;
    if (rows.length > 501 || row.length > 5) throw new Error('Sample table exceeds supported dimensions.');
  }
  if (quoted) throw new Error('Unclosed quoted metadata field.');
  if (cell || row.length || closed) { finish(); rows.push(row); }
  const header = rows.shift()?.map(item => item.trim()) ?? [];
  if (!['sampleId', 'collectionDate', 'dateSource'].every(key => header.includes(key)) || new Set(header).size !== header.length ||
    header.some(key => !['sampleId', 'collectionDate', 'dateSource', 'accession', 'permutationGroup'].includes(key))) throw new Error('Metadata requires sampleId,collectionDate,dateSource; optional accession,permutationGroup.');
  return rows.map((cells, index) => {
    if (cells.length !== header.length) throw new Error(`Sample row ${index + 2} has the wrong column count.`);
    const values = Object.fromEntries(header.map((key, j) => [key, cells[j].trim()]));
    const raw = values.collectionDate;
    const date = !raw ? null : /^\d{4}\.\d+$/.test(raw) ? Number(raw) : raw;
    collectionDateRange(date);
    return { id: values.sampleId, accession: values.accession || null, collectionDate: date, dateSource: values.dateSource, permutationGroup: values.permutationGroup || null };
  });
}
export function resolveTemporalOptions(settings: Partial<TemporalOptions> = {}): TemporalOptions {
  if (!object(settings)) throw new Error('Temporal parameters must be an object.');
  fields(settings, ['permutations', 'seed', 'permutationScheme', 'excludedSamples'], 'temporal parameter');
  const options = { permutations: 999, seed: 42, permutationScheme: 'unrestricted' as const, excludedSamples: [], ...settings };
  if (!Number.isInteger(options.permutations) || options.permutations < 19 || options.permutations > TEMPORAL_LIMITS.permutations ||
    !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff || !['unrestricted', 'within-groups'].includes(options.permutationScheme) ||
    !Array.isArray(options.excludedSamples) || options.excludedSamples.length > TEMPORAL_LIMITS.tips) throw new Error('Permutations require 19–9999, seed a uint32, and a supported grouping/exclusion policy.');
  const excluded = options.excludedSamples.map(id => text(id, 'Excluded sample', 256));
  if (new Set(excluded).size !== excluded.length) throw new Error('Duplicate excluded sample IDs.');
  return { ...options, excludedSamples: excluded };
}
function regression(dates: number[], distances: number[]) {
  const n = dates.length, mx = dates.reduce((a, b) => a + b, 0) / n, my = distances.reduce((a, b) => a + b, 0) / n;
  const x = dates.map(v => v - mx), y = distances.map(v => v - my);
  const xx = x.reduce((sum, v) => sum + v * v, 0), yy = y.reduce((sum, v) => sum + v * v, 0);
  const xy = x.reduce((sum, v, i) => sum + v * y[i], 0);
  if (!(xx > 1e-20) || !(yy > 1e-24 * Math.max(1, ...distances.map(v => v * v)))) return null;
  return { mx, my, x, xx, slope: xy / xx, r: Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))) };
}
function seededRandom(seed: number): () => number {
  let cursor = seed >>> 0;
  return () => { cursor = (cursor + 0x6d2b79f5) >>> 0; let t = Math.imul(cursor ^ cursor >>> 15, 1 | cursor); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function analyzeTemporalSignal(value: TemporalDataset, settings: Partial<TemporalOptions> = {}): TemporalResult {
  const dataset = validateTemporalDataset(value), options = resolveTemporalOptions(settings);
  const metadata = new Map(dataset.samples.map(sample => [sample.id, sample]));
  const treeTips = temporalTreeTips(parseTemporalNewick(dataset.tree.newick));
  if (options.excludedSamples.some(id => !treeTips.some(tip => tip.id === id))) throw new Error('Excluded sample does not exist in this tree.');
  const tips: TemporalTip[] = treeTips.map(tip => {
    const sample = metadata.get(tip.id), range = sample ? collectionDateRange(sample.collectionDate) : null;
    return { ...tip, accession: sample?.accession ?? null, date: range && range.lower === range.upper ? range.lower : null,
      dateRange: range, dateSource: sample?.dateSource ?? null, group: sample?.permutationGroup ?? null,
      exclusion: options.excludedSamples.includes(tip.id) ? 'Explicit user exclusion' : !sample ? 'Missing sample metadata' : !range ? 'Missing collection date' : range.lower !== range.upper ? 'Uncertain collection date; not replaced by a midpoint' : null };
  });
  const retained = tips.filter(tip => !tip.exclusion), dates = retained.map(tip => tip.date!), distances = retained.map(tip => tip.distance);
  const warnings = [
    'Root-to-tip regression is exploratory. Shared ancestry makes tips non-independent; no ordinary regression confidence interval or calibrated clock/ancestor date is claimed.',
    'The supplied root and branch lengths are held fixed. Their uncertainty and alignment/recombination/model errors are not estimated; supplied provenance is not independently verified.',
    'Randomization is a conditional date-label diagnostic, not proof of temporal signal. Its interpretation requires dates to be exchangeable within the chosen groups; phylogenetic clustering and sampling design can violate this.',
    'Uncertain dates are excluded, not treated as exact interval midpoints. ISO days use UTC day starts and decimal years use the actual calendar-year length.',
    'No skyline, effective population size, selection estimate or clock-calibrated tree is produced.',
  ];
  if (dataset.source.kind === 'demo') warnings.unshift('Explicit synthetic teaching input; not measured phage evolution.');
  const accessions = dataset.samples.map(s => s.accession).filter((v): v is string => v !== null);
  if (new Set(accessions).size < accessions.length) warnings.push('Some accessions repeat across sample IDs. Check repeated sampling and biological independence.');
  const result: TemporalResult = { options, tips, regression: null, unavailableReason: null, randomization: null, randomizationUnavailableReason: null, clockCalibrated: false, warnings };
  if (retained.length < 4) { result.unavailableReason = 'At least four tips with exact, sourced collection dates are required.'; return result; }
  const fit = regression(dates, distances);
  if (!fit) { result.unavailableReason = new Set(dates).size < 2 ? 'Collection dates do not vary.' : 'Root-to-tip distances do not vary (an ultrametric tree cannot establish temporal accumulation this way).'; return result; }
  const residuals = retained.map((tip, i) => {
    const predicted = fit.my + fit.slope * (tip.date! - fit.mx);
    const loo = regression(dates.filter((_, j) => i !== j), distances.filter((_, j) => i !== j));
    return { id: tip.id, date: tip.date!, distance: tip.distance, predicted, residual: tip.distance - predicted, leverage: 1 / retained.length + fit.x[i] ** 2 / fit.xx, leaveOneOutSlope: loo?.slope ?? null };
  });
  const loo = residuals.map(row => row.leaveOneOutSlope).filter((v): v is number => v !== null);
  result.regression = { slope: fit.slope, meanDate: fit.mx, meanDistance: fit.my, r: fit.r, r2: fit.r ** 2,
    sumSquaredResiduals: residuals.reduce((sum, row) => sum + row.residual ** 2, 0), xIntercept: fit.slope > 0 ? fit.mx - fit.my / fit.slope : null,
    residuals, leaveOneOutSlopeRange: loo.length ? [Math.min(...loo), Math.max(...loo)] : null };
  if (fit.slope <= 0) warnings.push('The slope is nonpositive: this fixed-root diagnostic does not support positive temporal accumulation.');
  const groups = new Map<string, number[]>();
  retained.forEach((tip, i) => {
    if (options.permutationScheme === 'within-groups' && !tip.group) throw new Error('Within-group randomization requires a group for every retained dated tip.');
    const key = options.permutationScheme === 'unrestricted' ? 'all' : tip.group!;
    groups.set(key, [...groups.get(key) ?? [], i]);
  });
  const blocks = [...groups.values()];
  if (blocks.every(indices => new Set(indices.map(i => dates[i])).size < 2)) { result.randomizationUnavailableReason = 'No collection-date variation can be permuted within the selected groups.'; return result; }
  let count = 1;
  for (const block of blocks) for (let i = 2; i <= block.length && count <= options.permutations; i++) count *= i;
  const exact = count <= options.permutations, working = [...dates]; let draws = 0, extreme = 0;
  const evaluate = () => { draws++; const r = regression(working, distances)!.r; if (r >= fit.r - 1e-12) extreme++; };
  if (exact) {
    // Only blocks with >1 member need recursion. The factorial cap bounds it.
    const variable = blocks.filter(block => block.length > 1);
    const visit = (b: number, at: number) => {
      if (b === variable.length) { evaluate(); return; }
      const indices = variable[b];
      if (at === indices.length) { visit(b + 1, 0); return; }
      for (let i = at; i < indices.length; i++) {
        const left = indices[at], right = indices[i];
        [working[left], working[right]] = [working[right], working[left]];
        visit(b, at + 1);
        [working[left], working[right]] = [working[right], working[left]];
      }
    };
    visit(0, 0);
  } else {
    const random = seededRandom(options.seed);
    for (let b = 0; b < options.permutations; b++) {
      dates.forEach((date, i) => { working[i] = date; });
      for (const block of blocks) for (let i = block.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1)), left = block[i], right = block[j];
        [working[left], working[right]] = [working[right], working[left]];
      }
      evaluate();
    }
  }
  result.randomization = { mode: exact ? 'exact' : 'monte-carlo', draws, extreme, tailFraction: exact ? extreme / draws : (extreme + 1) / (draws + 1), groups: blocks.length };
  return result;
}
const METHOD = { id: 'fixed-root-temporal-signal', version: '1', implementation: 'Explicit Newick path sums; centered OLS; leave-one-tip-out sensitivity; signed-r date-label enumeration or seeded within-block permutation' };
const REFERENCES = [{ id: 'root-to-tip', version: 'Rambaut-et-al-2016-vew007', description: 'Exploratory regression on a fixed, date-independent phylogram; shared ancestry prevents ordinary regression significance claims.' },
  { id: 'newick', version: 'Olsen-1990', description: 'Quoted labels and branch lengths; unquoted underscores denote spaces. All non-root lengths required; nonzero root stems rejected.' }];
export async function createTemporalRecord(input: TemporalDataset, result: TemporalResult): Promise<AnalysisRecord> {
  const dataset = validateTemporalDataset(input);
  const coverage = { available: result.tips.filter(tip => !tip.exclusion).length, total: result.tips.length, unit: 'records' as const };
  const fitted = (label: string, value: unknown) => dataset.source.kind === 'demo'
    ? { label, kind: 'demo' as const, value: analysisJson(value), units: 'records' as const, coverage, limitations: result.warnings, assumptions: ['Explicit synthetic teaching dataset.'] }
    : { label, kind: 'fitted-estimate' as const, value: analysisJson(value), units: 'records' as const, coverage, limitations: result.warnings,
      fit: { dataInput: 'datedTree', objective: 'Explore the relationship of exact collection dates to supplied fixed-root genetic distances; slope units are substitutions/site/year.', uncertainty: { kind: 'not-estimated' as const } } };
  return createAnalysisRecord({ method: METHOD, inputs: [{ id: 'datedTree', accession: null, source: dataset.source.kind, description: dataset.source.description, data: analysisJson(dataset) }],
    parameters: analysisJson(result.options) as AnalysisRecord['parameters'], seed: result.options.seed, references: REFERENCES,
    fields: { tips: fitted('Tree-tip distances, date provenance and explicit exclusions', result.tips),
      regression: result.regression ? fitted('Descriptive root-to-tip slope, residuals and leave-one-out sensitivity', result.regression)
        : { label: 'Temporal regression unavailable', kind: 'unavailable', value: null, units: null, coverage, limitations: result.warnings, missingInputs: [result.unavailableReason!] },
      randomization: result.randomization ? fitted('Conditional signed-correlation date-label tail fraction (not clock validation)', result.randomization)
        : { label: 'Date-label randomization unavailable', kind: 'unavailable', value: null, units: null, coverage, limitations: result.warnings, missingInputs: [result.unavailableReason ?? result.randomizationUnavailableReason!] } } });
}
export async function replayTemporalRecord(content: string): Promise<{ dataset: TemporalDataset; result: TemporalResult; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: METHOD.id, methodVersion: METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'datedTree') throw new Error('Unsupported dated-tree input contract.');
  const dataset = validateTemporalDataset(saved.inputs[0].data);
  const result = analyzeTemporalSignal(dataset, saved.parameters as Partial<TemporalOptions>);
  const record = await createTemporalRecord(dataset, result);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) throw new Error('Fresh temporal diagnostic differs from the saved result or reference contract.');
  return { dataset, result, record };
}
