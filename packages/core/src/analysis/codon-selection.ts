/** Explicit homologous, coding-oriented alignments only. NG86-style equal-weight
 * counting with sense-only shortest paths, then separate JC69 corrections.
 * A descriptive pairwise dN/dS is not a test of selection or a branch estimate.
 * References: Nei & Gojobori 1986, doi:10.1093/oxfordjournals.molbev.a040410;
 * NCBI genetic codes, 2024-09-23. Stop-path convention is recorded explicitly.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const CODON_SELECTION_LIMITS = { bytes: 2 * 1024 * 1024, samples: 32, codons: 30000, pairs: 128, windows: 4096 } as const;
export const CODON_GENETIC_CODES = [1, 4, 11, 15, 25] as const;
export type CodonGeneticCode = typeof CODON_GENETIC_CODES[number];
export interface CodonSequence { id: string; description: string; sequence: string }
export interface CodonAlignmentInput {
  format: 'phage-explorer-codon-alignment'; version: 1; name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string; license: string };
  alignment: { fasta: string; homologousCodons: true; orientation: 'coding-5to3'; frame: 0;
    geneticCode: CodonGeneticCode; method: string; reference: string };
}
export interface CodonSelectionOptions {
  comparison: 'reference' | 'all-pairs'; referenceId: string | null;
  startCodon: number; endCodon: number; windowCodons: number;
  missing: 'pairwise' | 'complete';
}
export type CodonExclusion = 'gap' | 'ambiguous' | 'stop' | 'no-sense-path' | 'complete-deletion';
export interface CodonCounts {
  retained: number; excluded: Record<CodonExclusion, number>;
  synonymousSites: number; nonsynonymousSites: number;
  synonymousDifferences: number; nonsynonymousDifferences: number;
  pathFilteredCodons: number; rejectedPaths: number;
}
export interface CodonDistance { value: number | null; proportion: number | null; status: 'ok' | 'no-sites' | 'saturated' }
export interface CodonEstimate extends CodonCounts {
  startCodon: number; endCodon: number; dN: CodonDistance; dS: CodonDistance;
  omega: number | null; unavailableReason: string | null;
}
export interface CodonPairResult { left: string; right: string; overall: CodonEstimate; windows: CodonEstimate[] }
export interface CodonSelectionResult {
  options: CodonSelectionOptions; geneticCode: CodonGeneticCode; alignmentCodons: number;
  sequences: Array<{ id: string; description: string; aminoAcids: string }>;
  pairs: CodonPairResult[]; warnings: string[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) throw new Error(`${label} requires nonempty text without control characters.`);
  return v.trim();
}
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error(`Unsupported ${label} field.`);
}
function size(v: string): void {
  if (new TextEncoder().encode(v).length > CODON_SELECTION_LIMITS.bytes) throw new Error('Codon alignment input exceeds 2 MiB.');
}
function codeTable(code: CodonGeneticCode): Readonly<Record<string, string>> {
  if (!(CODON_GENETIC_CODES as readonly number[]).includes(code)) throw new Error('Unsupported genetic code; use 1, 4, 11, 15 or 25 explicitly.');
  // NCBI order: first, second and third bases each in TCAG order.
  const amino = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
  const table: Record<string, string> = Object.create(null); let at = 0;
  for (const a of 'TCAG') for (const b of 'TCAG') for (const c of 'TCAG') table[a + b + c] = amino[at++];
  if (code === 4) table.TGA = 'W';
  if (code === 15) table.TAG = 'Q';
  if (code === 25) table.TGA = 'G';
  return table;
}
export function translateSelectionCodon(codon: string, code: CodonGeneticCode): string {
  return codeTable(code)[codon.toUpperCase()] ?? 'X';
}
/** Do not strip punctuation/bases or align equal-length raw genomes implicitly. */
export function parseCodonAlignmentFasta(content: string): CodonSequence[] {
  if (typeof content !== 'string') throw new Error('Aligned FASTA text is required.');
  size(content);
  const result: CodonSequence[] = [], ids = new Set<string>(); let current: CodonSequence | null = null;
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('>')) {
      const header = text(line.slice(1), 'FASTA header'), id = header.split(/\s/)[0];
      if (id.length > 256 || ids.has(id)) throw new Error('FASTA IDs must be unique and at most 256 characters.');
      ids.add(id); current = { id, description: header, sequence: '' }; result.push(current);
      if (result.length > CODON_SELECTION_LIMITS.samples) throw new Error('Use at most 32 coding sequences.');
    } else {
      if (!current || !/^[ACGTRYSWKMBDHVN-]+$/i.test(line)) throw new Error('FASTA sequence lines require DNA/IUPAC or gap symbols without embedded whitespace.');
      current.sequence += line.toUpperCase();
      if (current.sequence.length > 3 * CODON_SELECTION_LIMITS.codons) throw new Error('Alignment exceeds 30000 codons.');
    }
  }
  const width = result[0]?.sequence.length ?? 0;
  if (result.length < 2 || !width || width % 3 || result.some(row => row.sequence.length !== width)) {
    throw new Error('Supply 2–32 aligned coding sequences of equal nonzero length divisible by three.');
  }
  for (const row of result) for (let i = 0; i < width; i += 3) {
    const codon = row.sequence.slice(i, i + 3);
    if (codon.includes('-') && codon !== '---') throw new Error(`Partial-codon gap in ${row.id} at alignment codon ${i / 3 + 1}; frameshifts are unsupported.`);
  }
  return result;
}
export function validateCodonAlignment(value: unknown): CodonAlignmentInput {
  if (!object(value) || value.format !== 'phage-explorer-codon-alignment' || value.version !== 1 || !object(value.source) || !object(value.alignment)) throw new Error('Unsupported codon-alignment format/version.');
  keys(value, ['format', 'version', 'name', 'source', 'alignment'], 'dataset');
  keys(value.source, ['kind', 'description', 'reference', 'license'], 'source');
  keys(value.alignment, ['fasta', 'homologousCodons', 'orientation', 'frame', 'geneticCode', 'method', 'reference'], 'alignment');
  const a = value.alignment, s = value.source;
  if (!['local', 'demo'].includes(String(s.kind)) || a.homologousCodons !== true || a.orientation !== 'coding-5to3' || a.frame !== 0) {
    throw new Error('Declare homologous codons in coding 5′→3′ orientation starting at frame zero. Equal lengths, gene names or genomic coordinates do not establish an alignment.');
  }
  codeTable(a.geneticCode as CodonGeneticCode); parseCodonAlignmentFasta(a.fasta as string);
  const input: CodonAlignmentInput = { format: 'phage-explorer-codon-alignment', version: 1, name: text(value.name, 'Dataset name'),
    source: { kind: s.kind as 'local' | 'demo', description: text(s.description, 'Source description'), reference: text(s.reference, 'Source reference'), license: text(s.license, 'License/permissions') },
    alignment: { fasta: a.fasta as string, homologousCodons: true, orientation: 'coding-5to3', frame: 0,
      geneticCode: a.geneticCode as CodonGeneticCode, method: text(a.method, 'Alignment method'), reference: text(a.reference, 'Homology/CDS provenance') } };
  size(JSON.stringify(input)); return input;
}
export function resolveCodonSelectionOptions(input: CodonAlignmentInput, settings: unknown = {}): CodonSelectionOptions {
  if (!object(settings)) throw new Error('Codon settings must be an object.');
  keys(settings, ['comparison', 'referenceId', 'startCodon', 'endCodon', 'windowCodons', 'missing'], 'codon setting');
  const rows = parseCodonAlignmentFasta(input.alignment.fasta), total = rows[0].sequence.length / 3;
  const comparison = settings.comparison ?? 'reference', missing = settings.missing ?? 'pairwise';
  const referenceId = comparison === 'reference' ? settings.referenceId ?? rows[0].id : settings.referenceId ?? null;
  if (!['reference', 'all-pairs'].includes(String(comparison)) || !['pairwise', 'complete'].includes(String(missing)) ||
    comparison === 'reference' && !rows.some(row => row.id === referenceId) || comparison === 'all-pairs' && referenceId !== null) throw new Error('Use an existing reference ID or all-pairs with no reference, and pairwise/complete deletion.');
  const startCodon = settings.startCodon ?? 0, endCodon = settings.endCodon ?? total, windowCodons = settings.windowCodons ?? 50;
  if (![startCodon, endCodon, windowCodons].every(Number.isSafeInteger) || Number(startCodon) < 0 || Number(endCodon) > total || Number(endCodon) <= Number(startCodon) || Number(windowCodons) < 1 || Number(windowCodons) > 10000) throw new Error('Use a valid zero-based half-open codon range and window size 1–10000.');
  const pairs = comparison === 'reference' ? rows.length - 1 : rows.length * (rows.length - 1) / 2;
  if (pairs > CODON_SELECTION_LIMITS.pairs || pairs * Math.ceil((Number(endCodon) - Number(startCodon)) / Number(windowCodons)) > CODON_SELECTION_LIMITS.windows) throw new Error('Request exceeds the 128-pair/4096-window budget. Select a reference, narrower range or larger windows. No partial result was computed.');
  return { comparison: comparison as CodonSelectionOptions['comparison'], referenceId: referenceId as string | null,
    startCodon: Number(startCodon), endCodon: Number(endCodon), windowCodons: Number(windowCodons), missing: missing as CodonSelectionOptions['missing'] };
}
const empty = (): CodonCounts => ({ retained: 0, excluded: { gap: 0, ambiguous: 0, stop: 0, 'no-sense-path': 0, 'complete-deletion': 0 },
  synonymousSites: 0, nonsynonymousSites: 0, synonymousDifferences: 0, nonsynonymousDifferences: 0, pathFilteredCodons: 0, rejectedPaths: 0 });
function exclusion(codon: string, table: Readonly<Record<string, string>>): CodonExclusion | null {
  if (codon === '---') return 'gap';
  if (!/^[ACGT]{3}$/.test(codon)) return 'ambiguous';
  return table[codon] === '*' ? 'stop' : null;
}
/** All three alternatives at each position contribute; stop neighbours count as nonsynonymous opportunities. */
function opportunities(codon: string, table: Readonly<Record<string, string>>): number {
  let syn = 0;
  for (let i = 0; i < 3; i++) for (const base of 'ACGT') {
    if (base !== codon[i] && table[codon.slice(0, i) + base + codon.slice(i + 1)] === table[codon]) syn++;
  }
  return syn / 3;
}
export interface CodonContribution { synonymousSites: number; nonsynonymousSites: number; synonymousDifferences: number;
  nonsynonymousDifferences: number; acceptedPaths: number; rejectedPaths: number }
function contribution(a: string, b: string, table: Readonly<Record<string, string>>): CodonContribution | null {
  if (exclusion(a, table) || exclusion(b, table)) return null;
  const positions = [0, 1, 2].filter(i => a[i] !== b[i]);
  let syn = 0, paths = 0, rejected = 0;
  const visit = (current: string, remaining: number[], count: number) => {
    if (!remaining.length) { syn += count; paths++; return; }
    for (const pos of remaining) {
      const next = current.slice(0, pos) + b[pos] + current.slice(pos + 1);
      const rest = remaining.filter(i => i !== pos);
      // Count every discarded complete ordering (there are at most 3! paths).
      if (table[next] === '*') { rejected += rest.length === 2 ? 2 : 1; continue; }
      visit(next, rest, count + Number(table[current] === table[next]));
    }
  };
  visit(a, positions, 0);
  if (!paths) return null;
  const synonymousSites = (opportunities(a, table) + opportunities(b, table)) / 2;
  return { synonymousSites, nonsynonymousSites: 3 - synonymousSites,
    synonymousDifferences: syn / paths, nonsynonymousDifferences: positions.length - syn / paths,
    acceptedPaths: paths, rejectedPaths: rejected };
}
export function countCodonPair(a: string, b: string, code: CodonGeneticCode): CodonContribution | null {
  if (!/^[ACGTRYSWKMBDHVN-]{3}$/i.test(a) || !/^[ACGTRYSWKMBDHVN-]{3}$/i.test(b)) throw new Error('Expected two three-base DNA codons.');
  return contribution(a.toUpperCase(), b.toUpperCase(), codeTable(code));
}
function distance(differences: number, sites: number): CodonDistance {
  if (!(sites > 0)) return { value: null, proportion: null, status: 'no-sites' };
  const p = differences / sites;
  return p >= 0.75 ? { value: null, proportion: p, status: 'saturated' }
    : { value: -0.75 * Math.log1p(-4 * p / 3) || 0, proportion: p, status: 'ok' };
}
function estimate(count: CodonCounts, startCodon: number, endCodon: number): CodonEstimate {
  const dN = distance(count.nonsynonymousDifferences, count.nonsynonymousSites), dS = distance(count.synonymousDifferences, count.synonymousSites);
  const reason = !count.retained ? 'No comparable sense codons.' : dS.status !== 'ok' ? `Synonymous distance is ${dS.status}.` :
    dN.status !== 'ok' ? `Nonsynonymous distance is ${dN.status}.` : dS.value === 0 ? 'No synonymous changes; dN/dS is undefined, not 1 or an arbitrary large number.' : null;
  return { ...count, startCodon, endCodon, dN, dS, omega: reason ? null : dN.value! / dS.value!, unavailableReason: reason };
}
function add(target: CodonCounts, source: CodonCounts): void {
  target.retained += source.retained;
  for (const k of Object.keys(source.excluded) as CodonExclusion[]) target.excluded[k] += source.excluded[k];
  for (const k of ['synonymousSites', 'nonsynonymousSites', 'synonymousDifferences', 'nonsynonymousDifferences', 'pathFilteredCodons', 'rejectedPaths'] as const) target[k] += source[k];
}
export function analyzeCodonSelection(value: CodonAlignmentInput, settings: unknown = {}, progress: (phase: string) => void = () => {}): CodonSelectionResult {
  const input = validateCodonAlignment(value), options = resolveCodonSelectionOptions(input, settings);
  const rows = parseCodonAlignmentFasta(input.alignment.fasta), table = codeTable(input.alignment.geneticCode);
  const pairIds: [number, number][] = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (options.comparison === 'all-pairs' || rows[i].id === options.referenceId || rows[j].id === options.referenceId) {
      pairIds.push(rows[j].id === options.referenceId ? [j, i] : [i, j]);
    }
  }
  const masked = new Set<number>();
  if (options.missing === 'complete') for (let k = options.startCodon; k < options.endCodon; k++) {
    if (rows.some(row => exclusion(row.sequence.slice(3 * k, 3 * k + 3), table))) masked.add(k);
  }
  const cache = new Map<string, CodonContribution | null>();
  const pairs = pairIds.map(([i, j], index): CodonPairResult => {
    progress(`Comparing coding pair ${index + 1}/${pairIds.length}`);
    const overall = empty(), windows: CodonEstimate[] = [];
    for (let start = options.startCodon; start < options.endCodon; start += options.windowCodons) {
      const end = Math.min(options.endCodon, start + options.windowCodons), count = empty();
      for (let k = start; k < end; k++) {
        if ((k - options.startCodon) % 1024 === 0) progress(`Coding pair ${index + 1}/${pairIds.length}, alignment codon ${k + 1}`);
        const a = rows[i].sequence.slice(3 * k, 3 * k + 3), b = rows[j].sequence.slice(3 * k, 3 * k + 3);
        const why = exclusion(a, table) ?? exclusion(b, table);
        if (why) { count.excluded[why]++; continue; }
        if (masked.has(k)) { count.excluded['complete-deletion']++; continue; }
        const key = a + b;
        if (!cache.has(key)) cache.set(key, contribution(a, b, table));
        const item = cache.get(key);
        if (!item) { count.excluded['no-sense-path']++; continue; }
        count.retained++;
        count.synonymousSites += item.synonymousSites; count.nonsynonymousSites += item.nonsynonymousSites;
        count.synonymousDifferences += item.synonymousDifferences; count.nonsynonymousDifferences += item.nonsynonymousDifferences;
        count.pathFilteredCodons += Number(item.rejectedPaths > 0); count.rejectedPaths += item.rejectedPaths;
      }
      add(overall, count); windows.push(estimate(count, start, end));
    }
    return { left: rows[i].id, right: rows[j].id, overall: estimate(overall, options.startCodon, options.endCodon), windows };
  });
  return { options, geneticCode: input.alignment.geneticCode, alignmentCodons: rows[0].sequence.length / 3,
    sequences: rows.map(row => ({ id: row.id, description: row.description,
      aminoAcids: row.sequence.match(/.../g)!.map(c => c === '---' ? '-' : table[c] ?? 'X').join('') })), pairs,
    warnings: [
      'Conditional pairwise counting, not a statistical test of selection, branch-specific inference, fitness prediction or proof of homology. No adaptive/purifying classification or confidence interval is assigned.',
      'Homology, coding orientation, reading frame, genetic code and source are declarations supplied by the user, not inferred from equal length, reference names or a whole-genome comparison.',
      'Equal mutation opportunities at each codon position; synonymous opportunities averaged over both sense codons. Stop-producing neighbours count as nonsynonymous opportunities. Changes average only shortest paths with sense-codon intermediates.',
      'Sense-only shortest-path counting is an explicit NG86-style convention; implementations that include stop intermediates can differ. No transition bias, codon-frequency model, recombination, phylogeny or ancestral branch assignment is fitted.',
      'Gapped, ambiguous and stop-containing codons are excluded with counts, never translated as ordinary residues. Complete deletion additionally masks a column in all pairs when any supplied sequence is unusable there.',
      'JC69 corrections are applied separately to pooled synonymous and nonsynonymous counts/sites. Saturation is unavailable, not clamped. Overall estimates pool evidence and do not average window ratios.',
      'Coordinates are zero-based half-open alignment codons (multiply by three for alignment columns), not genomic locations. Codon gaps are not removed; partial-codon gaps/frameshifts are rejected.',
      'Initiation-codon recoding is not modelled. Windows are descriptive and pairs share ancestry; many large ratios are not multiple independent demonstrations of adaptation.',
      ...(input.source.kind === 'demo' ? ['Explicit synthetic demonstration; no empirical sequence or organism-specific inference.'] : []),
    ] };
}
const METHOD = { id: 'aligned-codon-dnds', version: '1', implementation: 'NG86-style equal opportunities; mean sense-only shortest paths; pooled JC69; explicit table and deletion masks' };
export function createCodonSelectionRecord(value: CodonAlignmentInput, result: CodonSelectionResult): Promise<AnalysisRecord> {
  const input = validateCodonAlignment(value);
  const coverage = { available: result.pairs.reduce((n, p) => n + p.overall.retained, 0), total: result.pairs.length * (result.options.endCodon - result.options.startCodon), unit: 'records' as const };
  const context = { label: 'Conditional aligned-CDS pairwise dN/dS, counts and window diagnostics', value: analysisJson(result), units: 'dimensionless' as const, coverage, limitations: result.warnings };
  return createAnalysisRecord({ method: METHOD, inputs: [{ id: 'codonAlignment', accession: null, source: input.source.kind, description: input.name, data: analysisJson(input) }],
    parameters: analysisJson(result.options) as AnalysisRecord['parameters'], seed: null,
    references: [{ id: 'NG86', version: '1986', description: 'Nei and Gojobori; doi:10.1093/oxfordjournals.molbev.a040410. Sense-only path convention specified in the implementation.' },
      { id: 'NCBI-translation-tables', version: '2024-09-23', description: `Explicit table ${input.alignment.geneticCode}; https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi` }],
    fields: { comparisons: input.source.kind === 'demo' ? { ...context, kind: 'demo', assumptions: ['Supplied synthetic codon alignment and the recorded counting model.'] }
      : { ...context, kind: 'fitted-estimate', fit: { dataInput: 'codonAlignment', objective: 'Equal-opportunity sense-path counts with separate JC69 corrections; no selection hypothesis test.', uncertainty: { kind: 'not-estimated' } } } } });
}
export async function replayCodonSelectionRecord(content: string, progress: (phase: string) => void = () => {}): Promise<{ input: CodonAlignmentInput; result: CodonSelectionResult; record: AnalysisRecord }> {
  const saved = await parseAnalysisRecord(content, { methodId: METHOD.id, methodVersion: METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'codonAlignment') throw new Error('Unsupported codon comparison input contract.');
  const input = validateCodonAlignment(saved.inputs[0].data), result = analyzeCodonSelection(input, saved.parameters, progress);
  const record = await createCodonSelectionRecord(input, result);
  if (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) throw new Error('Fresh codon comparison differs from the saved evidence.');
  return { input, result, record };
}
