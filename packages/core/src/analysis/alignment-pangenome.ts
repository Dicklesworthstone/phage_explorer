/** Sequence-derived graph construction. No annotation templates, donor inference or synthetic fallback.
 * GFA 1.0 S/L/P semantics: https://gfa-spec.github.io/GFA-spec/GFA1.html
 * Input orientation/homology is supplied by the alignment, not inferred from graph topology.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const ALIGNMENT_GRAPH_LIMITS = {
  bytes: 4 * 1024 * 1024, sequences: 24, columns: 250000, cells: 4000000,
  alignmentCells: 12000000, blocks: 4000, nodes: 12000, edges: 24000, variants: 12000,
} as const;
export interface PangenomeSequence { id: string; description: string; sequence: string }
export interface PangenomeInput {
  format: 'phage-explorer-pangenome'; version: 1; name: string; source: 'local' | 'demo';
  sequences: PangenomeSequence[];
}
export interface AlignmentGraphOptions {
  referenceId: string;
  alignment: 'provided' | 'global';
  terminalGaps: 'missing' | 'alleles';
}
export interface AlignmentGraphNode {
  id: string; block: number; sequence: string; alignmentStart: number; alignmentEnd: number;
  referenceStart: number; referenceEnd: number; pathIds: string[]; core: boolean; ambiguous: boolean;
}
export interface AlignmentGraphEdge { from: string; to: string; pathIds: string[] }
export interface AlignmentGraphPath { id: string; sequenceId: string; description: string; length: number; nodes: string[] }
export interface AlignmentVariant {
  id: string; type: 'snv' | 'substitution' | 'insertion' | 'deletion' | 'replacement';
  referenceStart: number; referenceEnd: number; reference: string; alternate: string;
  pathIds: string[];
}
export interface AlignmentPangenome {
  options: AlignmentGraphOptions; alignment: PangenomeSequence[];
  referenceLength: number; nodes: AlignmentGraphNode[]; edges: AlignmentGraphEdge[];
  paths: AlignmentGraphPath[]; variants: AlignmentVariant[];
  diagnostics: {
    columns: number; blocks: number; allGapColumns: number; sharedUnambiguousBases: number;
    alignmentCells: number;
    comparisons: Array<{ pathId: string; comparableColumns: number; ambiguousColumns: number; missingTerminalColumns: number }>;
    limitations: string[];
  };
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function text(value: unknown, context: string, limit = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${context} requires ${empty ? 'at most' : '1–'}${limit} text characters without controls.`);
  }
  return value.trim();
}
function size(content: string, limit: number = ALIGNMENT_GRAPH_LIMITS.bytes): void {
  if (typeof content !== 'string' || content.length > limit || new TextEncoder().encode(content).length > limit) {
    throw new Error(`Pangenome input exceeds the ${limit / 1024 / 1024} MiB limit.`);
  }
}
/** Copy validated inputs; identifiers are unique, input order does not define graph IDs. */
export function validatePangenomeInput(value: unknown): PangenomeInput {
  if (!isObject(value) || value.format !== 'phage-explorer-pangenome' || value.version !== 1 ||
    !['local', 'demo'].includes(String(value.source)) || !Array.isArray(value.sequences) ||
    value.sequences.length < 2 || value.sequences.length > ALIGNMENT_GRAPH_LIMITS.sequences) {
    throw new Error('Pangenome input requires format version 1 and 2–24 sequences.');
  }
  let cells = 0;
  const sequences = value.sequences.map((item, i) => {
    if (!isObject(item)) throw new Error(`Sequence ${i + 1} is not an object.`);
    const id = text(item.id, 'Sequence identifier');
    if (/\s/.test(id)) throw new Error('Sequence identifiers cannot contain whitespace.');
    const description = text(item.description ?? '', 'Sequence description', 2048, true);
    if (typeof item.sequence !== 'string' || !item.sequence || item.sequence.length > ALIGNMENT_GRAPH_LIMITS.columns ||
      /[^ACGTRYSWKMBDHVN-]/i.test(item.sequence) || !/[ACGTRYSWKMBDHVN]/i.test(item.sequence)) {
      throw new Error(`Sequence ${i + 1} requires 1–250,000 IUPAC DNA/gap characters and at least one base. RNA, dots and question marks are unsupported.`);
    }
    cells += item.sequence.length;
    if (cells > ALIGNMENT_GRAPH_LIMITS.cells) throw new Error('Pangenome input exceeds 4,000,000 sequence cells.');
    return { id, description, sequence: item.sequence.toUpperCase() };
  }).sort((a, b) => order(a.id, b.id));
  if (new Set(sequences.map(s => s.id)).size !== sequences.length) throw new Error('Duplicate sequence identifiers are not allowed.');
  const input: PangenomeInput = { format: 'phage-explorer-pangenome', version: 1, name: text(value.name, 'Dataset name'),
    source: value.source as PangenomeInput['source'], sequences };
  size(JSON.stringify(input));
  return input;
}
/** FASTA is explicit sequence input, not a catalog lookup or a silent aligner invocation. */
export function parsePangenomeInput(content: string, name = 'Local pangenome sequences'): PangenomeInput {
  size(content);
  const clean = content.replace(/^\uFEFF/, '').trim();
  if (clean.startsWith('{')) return validatePangenomeInput(JSON.parse(clean));
  const rows: PangenomeSequence[] = [];
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      const header = /^>(\S+)(?:\s+(.*))?$/.exec(line);
      if (!header) throw new Error('FASTA headers require a unique identifier after >.');
      rows.push({ id: header[1], description: header[2] ?? '', sequence: '' });
      if (rows.length > ALIGNMENT_GRAPH_LIMITS.sequences) throw new Error('At most 24 sequences are supported.');
    } else {
      if (!rows.length) throw new Error('Expected multi-sequence FASTA or pangenome dataset JSON.');
      // Strip only formatting whitespace, never unknown symbols or missing bases.
      rows[rows.length - 1].sequence += line.replace(/\s/g, '');
    }
  }
  return validatePangenomeInput({ format: 'phage-explorer-pangenome', version: 1, name, source: 'local', sequences: rows });
}
export function serializePangenomeInput(input: PangenomeInput): string {
  const result = JSON.stringify(validatePangenomeInput(input), null, 2); size(result); return result;
}
export function resolveAlignmentGraphOptions(input: PangenomeInput, options: Partial<AlignmentGraphOptions> = {}): AlignmentGraphOptions {
  if (!isObject(options) || Object.keys(options).some(key => !['referenceId', 'alignment', 'terminalGaps'].includes(key))) {
    throw new Error('Unsupported pangenome parameters.');
  }
  const result = { referenceId: input.sequences[0].id, alignment: 'provided', terminalGaps: 'missing', ...options };
  if (!input.sequences.some(s => s.id === result.referenceId) || !['provided', 'global'].includes(result.alignment) ||
    !['missing', 'alleles'].includes(result.terminalGaps)) throw new Error('Invalid reference, alignment mode or terminal-gap policy.');
  return result as AlignmentGraphOptions;
}

/** Exact unit-cost global edit alignment. Traceback ties: diagonal, reference base/gap, gap/query base.
 * This bounded locus aligner is not affine-gap, rearrangement-aware or a whole-genome aligner.
 */
export function alignPangenomePair(reference: string, query: string): { reference: string; query: string; distance: number } {
  if (!reference || !query || /[^ACGTRYSWKMBDHVN]/.test(reference + query)) throw new Error('Global alignment requires uppercase ungapped IUPAC DNA.');
  if (reference.length > ALIGNMENT_GRAPH_LIMITS.columns || query.length > ALIGNMENT_GRAPH_LIMITS.columns) throw new Error('Sequence is too long.');
  if (reference === query) return { reference, query, distance: 0 };
  const width = query.length + 1, cells = (reference.length + 1) * width;
  if (cells > ALIGNMENT_GRAPH_LIMITS.alignmentCells) throw new Error('Global alignment exceeds 12,000,000 DP cells. Supply an external alignment for whole genomes.');
  const trace = new Uint8Array(cells);
  let previous = Uint32Array.from({ length: width }, (_, j) => j), next = new Uint32Array(width);
  for (let j = 1; j < width; j++) trace[j] = 2;
  for (let i = 1; i <= reference.length; i++) {
    next[0] = i; trace[i * width] = 1;
    for (let j = 1; j < width; j++) {
      const diagonal = previous[j - 1] + (reference[i - 1] === query[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1, insertion = next[j - 1] + 1;
      const best = Math.min(diagonal, deletion, insertion);
      next[j] = best; trace[i * width + j] = best === diagonal ? 0 : best === deletion ? 1 : 2;
    }
    [previous, next] = [next, previous];
  }
  const distance = previous[query.length], a: string[] = [], b: string[] = [];
  let i = reference.length, j = query.length;
  while (i || j) {
    const move = trace[i * width + j];
    if (move === 0) { a.push(reference[--i]); b.push(query[--j]); }
    else if (move === 1) { a.push(reference[--i]); b.push('-'); }
    else { a.push('-'); b.push(query[--j]); }
  }
  return { reference: a.reverse().join(''), query: b.reverse().join(''), distance };
}
function prepareAlignment(input: PangenomeInput, options: AlignmentGraphOptions): { rows: PangenomeSequence[]; cells: number } {
  if (options.alignment === 'provided') {
    if (input.sequences.some(s => s.sequence.length !== input.sequences[0].sequence.length)) {
      throw new Error('A supplied alignment requires equal column counts. Choose global locus alignment for unaligned input.');
    }
    return { rows: input.sequences, cells: 0 };
  }
  if (input.sequences.some(s => s.sequence.includes('-'))) throw new Error('Global locus alignment accepts ungapped sequences only.');
  const reference = input.sequences.find(s => s.id === options.referenceId)!.sequence;
  const cells = input.sequences.reduce((n, s) => n + (s.sequence === reference ? 0 : (reference.length + 1) * (s.sequence.length + 1)), 0);
  if (cells > ALIGNMENT_GRAPH_LIMITS.alignmentCells) throw new Error('Global locus alignment exceeds the total 12,000,000 DP-cell budget. Import a supplied alignment instead.');
  const pairs = input.sequences.map(row => {
    const pair = alignPangenomePair(reference, row.sequence);
    const insertions = Array<string>(reference.length + 1).fill(''), bases: string[] = [];
    let at = 0;
    for (let column = 0; column < pair.reference.length; column++) {
      if (pair.reference[column] === '-') insertions[at] += pair.query[column];
      else { bases.push(pair.query[column]); at++; }
    }
    return { row, insertions, bases };
  });
  const widths = Array.from({ length: reference.length + 1 }, (_, at) => Math.max(...pairs.map(pair => pair.insertions[at].length)));
  const columns = reference.length + widths.reduce((a, b) => a + b, 0);
  if (columns > ALIGNMENT_GRAPH_LIMITS.columns || columns * pairs.length > ALIGNMENT_GRAPH_LIMITS.cells) throw new Error('The merged alignment exceeds column/cell limits.');
  // Independent insertions at the same reference boundary are left-justified.
  // This deterministic display convention does NOT assert their mutual homology.
  return { cells, rows: pairs.map(({ row, insertions, bases }) => ({ ...row,
    sequence: widths.map((width, at) => insertions[at].padEnd(width, '-') + (bases[at] ?? '')).join('') })) };
}
const known = (base: string) => base === 'A' || base === 'C' || base === 'G' || base === 'T' || base === '-';
function bounds(sequence: string): [number, number] {
  let first = 0, last = sequence.length - 1;
  while (sequence[first] === '-') first++;
  while (sequence[last] === '-') last--;
  return [first, last];
}

/** Compress adjacent columns with the same path partition into sequence nodes.
 * A gap skips the corresponding node. Every stored path spells the exact ungapped input.
 */
export function buildAlignmentPangenome(value: PangenomeInput, settings: Partial<AlignmentGraphOptions> = {}): AlignmentPangenome {
  const input = validatePangenomeInput(value), options = resolveAlignmentGraphOptions(input, settings);
  const { rows, cells } = prepareAlignment(input, options);
  const ref = rows.find(s => s.id === options.referenceId)!.sequence, columns = ref.length;
  const referenceOffsets = new Uint32Array(columns + 1);
  for (let c = 0; c < columns; c++) referenceOffsets[c + 1] = referenceOffsets[c] + (ref[c] === '-' ? 0 : 1);
  const paths: AlignmentGraphPath[] = rows.map((s, i) => ({ id: `p${i + 1}`, sequenceId: s.id,
    description: s.description, length: s.sequence.replaceAll('-', '').length, nodes: [] }));
  const nodes: AlignmentGraphNode[] = [], edges = new Map<string, AlignmentGraphEdge>();
  let start = 0, lastKey = '', blocks = 0, allGapColumns = 0;
  const flush = (end: number) => {
    if (!lastKey || end === start) return;
    if (++blocks > ALIGNMENT_GRAPH_LIMITS.blocks) throw new Error('Graph exceeds 4,000 blocks. Analyze a smaller aligned region.');
    const groups = new Map<string, number[]>();
    rows.forEach((row, i) => {
      const allele = row.sequence.slice(start, end).replaceAll('-', '');
      if (allele) groups.set(allele, [...(groups.get(allele) ?? []), i]);
    });
    for (const [sequence, members] of [...groups].sort(([a], [b]) => order(a, b))) {
      if (nodes.length >= ALIGNMENT_GRAPH_LIMITS.nodes) throw new Error('Graph exceeds 12,000 sequence nodes. Analyze a smaller region.');
      const id = `s${nodes.length + 1}`, ambiguous = /[^ACGT]/.test(sequence);
      nodes.push({ id, block: blocks - 1, sequence, alignmentStart: start, alignmentEnd: end,
        referenceStart: referenceOffsets[start], referenceEnd: referenceOffsets[end], pathIds: members.map(i => paths[i].id),
        core: members.length === rows.length && !ambiguous, ambiguous });
      for (const i of members) {
        const path = paths[i], prior = path.nodes[path.nodes.length - 1];
        if (prior) {
          const key = `${prior}:${id}`, edge = edges.get(key) ?? { from: prior, to: id, pathIds: [] };
          edge.pathIds.push(path.id); edges.set(key, edge);
          if (edges.size > ALIGNMENT_GRAPH_LIMITS.edges) throw new Error('Graph exceeds 24,000 links. Analyze a smaller region.');
        }
        path.nodes.push(id);
      }
    }
  };
  for (let c = 0; c < columns; c++) {
    const chars = rows.map(row => row.sequence[c]);
    if (chars.every(char => char === '-')) { flush(c); lastKey = ''; start = c + 1; allGapColumns++; continue; }
    const first = new Map<string, number>();
    // Do not merge a shared unknown base into a known shared sequence node.
    const key = `${chars.some(char => !known(char)) ? 'ambiguous' : 'known'}:` + chars.map((char, i) => {
      if (!first.has(char)) first.set(char, i);
      return char === '-' ? 'gap' : first.get(char);
    }).join(',');
    if (key !== lastKey) { flush(c); start = c; lastKey = key; }
  }
  flush(columns);

  const variants = new Map<string, AlignmentVariant>();
  const comparisons: AlignmentPangenome['diagnostics']['comparisons'] = [];
  const [refFirst, refLast] = bounds(ref);
  rows.forEach((row, index) => {
    if (row.id === options.referenceId) return;
    const pathId = paths[index].id, [queryFirst, queryLast] = bounds(row.sequence);
    const comparison = { pathId, comparableColumns: 0, ambiguousColumns: 0, missingTerminalColumns: 0 };
    let runStart = -1, referenceAllele = '', alternate = '';
    const finish = () => {
      if (runStart < 0) return;
      let position = referenceOffsets[runStart];
      // Minimal local allele representation, not repeat-aware left normalization.
      while (referenceAllele && alternate && referenceAllele.at(-1) === alternate.at(-1)) {
        referenceAllele = referenceAllele.slice(0, -1); alternate = alternate.slice(0, -1);
      }
      let prefix = 0;
      while (prefix < referenceAllele.length && prefix < alternate.length && referenceAllele[prefix] === alternate[prefix]) prefix++;
      referenceAllele = referenceAllele.slice(prefix); alternate = alternate.slice(prefix); position += prefix;
      if (referenceAllele !== alternate) {
        const type = !referenceAllele ? 'insertion' : !alternate ? 'deletion' : referenceAllele.length === alternate.length
          ? referenceAllele.length === 1 ? 'snv' : 'substitution' : 'replacement';
        const key = JSON.stringify([position, referenceAllele, alternate]);
        const variant: AlignmentVariant = variants.get(key) ?? { id: '', type, referenceStart: position,
          referenceEnd: position + referenceAllele.length, reference: referenceAllele, alternate, pathIds: [] };
        variant.pathIds.push(pathId); variants.set(key, variant);
        if (variants.size > ALIGNMENT_GRAPH_LIMITS.variants) throw new Error('Graph exceeds 12,000 reference-relative variants. Analyze a smaller region.');
      }
      runStart = -1; referenceAllele = ''; alternate = '';
    };
    for (let c = 0; c < columns; c++) {
      const a = ref[c], b = row.sequence[c];
      if (a === '-' && b === '-') continue;
      if (!known(a) || !known(b)) { finish(); comparison.ambiguousColumns++; continue; }
      if (options.terminalGaps === 'missing' && (c < Math.max(refFirst, queryFirst) || c > Math.min(refLast, queryLast))) {
        finish(); comparison.missingTerminalColumns++; continue;
      }
      comparison.comparableColumns++;
      if (a === b) finish();
      else {
        if (runStart < 0) runStart = c;
        if (a !== '-') referenceAllele += a;
        if (b !== '-') alternate += b;
      }
    }
    finish(); comparisons.push(comparison);
  });
  const sorted = [...variants.values()].sort((a, b) => a.referenceStart - b.referenceStart || a.referenceEnd - b.referenceEnd || order(a.alternate, b.alternate));
  sorted.forEach((variant, i) => { variant.id = `v${i + 1}`; variant.pathIds = [...new Set(variant.pathIds)]; });
  return { options, alignment: rows, referenceLength: referenceOffsets[columns], nodes, edges: [...edges.values()], paths, variants: sorted,
    diagnostics: { columns, blocks, allGapColumns, alignmentCells: cells, comparisons,
      sharedUnambiguousBases: nodes.filter(node => node.core).reduce((n, node) => n + node.sequence.length, 0),
      limitations: [
        'Sequence differences are conditional on the supplied orientation/alignment. No donors, gene impacts, inversions, recombination breakpoints or population frequencies are inferred.',
        'Adjacent unequal alignment columns form one local allele; alleles are not repeat-aware left-normalized or a VCF representation. Input sample counts are not prevalence estimates.',
        'IUPAC ambiguity is retained in graph paths but excluded from variant calls. A gap is not an ambiguous nucleotide.',
        options.terminalGaps === 'missing' ? 'Terminal gaps are treated as missing coverage and excluded from variant calls.' : 'Terminal gaps are treated as alleles by explicit user choice; incomplete assemblies can create false terminal differences.',
        options.alignment === 'global' ? 'Exact unit-cost global locus alignment with deterministic tie-breaking; independent insertion slots are left-justified, without asserting insertion homology. Not a whole-genome rearrangement aligner.' : 'The input is interpreted as an existing multiple-sequence alignment; equal column counts alone do not establish biological homology.',
        'Shared bases are exact unambiguous nodes traversed by every supplied sequence, not a universal species core genome.',
      ] } };
}

/** GFA 1.0 zero-overlap sequence graph, with stable ASCII path IDs and reversible label comments. */
export function exportAlignmentGfa(graph: AlignmentPangenome): string {
  const ascii = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return ['H\tVN:Z:1.0', '# Alignment-derived sequence graph. See the analysis record for reference-relative calls and missingness policies.',
    ...graph.paths.map(p => `# path-label\t${p.id}\t${ascii({ id: p.sequenceId, description: p.description })}`),
    ...graph.nodes.map(n => `S\t${n.id}\t${n.sequence}`),
    ...graph.edges.map(e => `L\t${e.from}\t+\t${e.to}\t+\t0M`),
    ...graph.paths.map(p => `P\t${p.id}\t${p.nodes.map(id => `${id}+`).join(',')}\t*`), ''].join('\n');
}
export function exportPangenomeAlignment(graph: AlignmentPangenome): string {
  return graph.alignment.map(s => `>${s.id}${s.description ? ` ${s.description}` : ''}\n${s.sequence.match(/.{1,80}/g)!.join('\n')}\n`).join('');
}
const METHOD = { id: 'alignment-pangenome', version: '2', implementation: 'column-partition sequence DAG; exact reference-relative alleles; optional unit-edit global star alignment' };
const REFERENCES = [{ id: 'gfa', version: '1.0', description: 'Sequence segments S, zero-overlap links L and fully spelled input paths P; ASCII path names.' }];
export async function createAlignmentPangenomeRecord(input: PangenomeInput, graph: AlignmentPangenome): Promise<AnalysisRecord> {
  const data = validatePangenomeInput(input);
  const coverage = { available: graph.paths.length, total: data.sequences.length, unit: 'records' as const };
  const field = (label: string, value: unknown) => data.source === 'demo'
    ? { label, value: analysisJson(value), kind: 'demo' as const, units: 'records' as const, coverage,
      limitations: graph.diagnostics.limitations, assumptions: ['Explicit synthetic sequence fixture, not catalog-derived evidence.'] }
    : { label, value: analysisJson(value), kind: 'sequence-score' as const, units: 'records' as const, coverage, limitations: graph.diagnostics.limitations };
  return createAnalysisRecord({ method: METHOD, references: REFERENCES, seed: null,
    inputs: [{ id: 'sequences', accession: null, source: data.source, description: data.name, data: analysisJson(data) }],
    parameters: { ...graph.options }, fields: {
      graph: field('Alignment-derived sequence graph and exact input paths', { nodes: graph.nodes, edges: graph.edges, paths: graph.paths }),
      variants: field('Reference-relative sequence differences (0-based half-open coordinates)', graph.variants),
      diagnostics: field('Alignment, comparison coverage and supported interpretation', { referenceLength: graph.referenceLength, ...graph.diagnostics }),
    } });
}
export async function replayAlignmentPangenome(content: string): Promise<{ input: PangenomeInput; graph: AlignmentPangenome; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: METHOD.id, methodVersion: METHOD.version });
  if (saved.method.implementation !== METHOD.implementation || JSON.stringify(analysisJson(saved.references)) !== JSON.stringify(analysisJson(REFERENCES)) ||
    saved.seed !== null || saved.inputs.length !== 1 || saved.inputs[0].id !== 'sequences') throw new Error('Pangenome method, reference or input contract differs.');
  const input = validatePangenomeInput(saved.inputs[0].data);
  const graph = buildAlignmentPangenome(input, saved.parameters as Partial<AlignmentGraphOptions>);
  const record = await createAlignmentPangenomeRecord(input, graph);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) throw new Error('Recomputed pangenome graph or variants differ from the saved result.');
  return { input, graph, record };
}
