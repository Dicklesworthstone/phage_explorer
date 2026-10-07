/** Haploid VCF 4.3 from an accepted multiple alignment, not a read-based caller.
 * Specification: https://github.com/samtools/hts-specs/blob/master/VCFv4.3.tex
 * Unknown sequence is never a reference genotype. Overlapping padded events are
 * combined into one multiallelic locus; alleles are not repeat-left-normalized.
 */
import { validatePangenomeInput, resolveAlignmentGraphOptions, type AlignmentPangenome,
  type PangenomeSequence } from './alignment-pangenome';

export const PANGENOME_VCF_LIMITS = { bytes: 10 * 1024 * 1024, work: 64000000 } as const;
interface Span { start: number; end: number }
interface AlignmentInput {
  reference: PangenomeSequence; queries: PangenomeSequence[];
  columns: number; positions: Int32Array; previousBase: Int32Array; nextBase: Int32Array;
  bounds: Span[]; missingTerminals: boolean;
}
const resolved = (base: string): boolean => base === 'A' || base === 'C' || base === 'G' || base === 'T';
const bounds = (sequence: string): Span => ({ start: sequence.search(/[^-]/), end: sequence.search(/-*$/) });
function checkedAlignment(graph: AlignmentPangenome): AlignmentInput {
  const input = validatePangenomeInput({ format: 'phage-explorer-pangenome', version: 1,
    name: 'VCF alignment', source: 'local', sequences: graph.alignment });
  const options = resolveAlignmentGraphOptions(input, graph.options);
  const reference = input.sequences.find(s => s.id === options.referenceId)!;
  const queries = input.sequences.filter(s => s.id !== options.referenceId);
  const columns = reference.sequence.length;
  if (input.sequences.some(s => s.sequence.length !== columns)) throw new Error('VCF export requires equal-column accepted alignment rows.');
  const positions = new Int32Array(columns + 1), previousBase = new Int32Array(columns + 1), nextBase = new Int32Array(columns + 1);
  let previous = -1, next = -1;
  for (let c = 0; c < columns; c++) {
    previousBase[c] = previous;
    positions[c + 1] = positions[c] + (reference.sequence[c] === '-' ? 0 : 1);
    if (reference.sequence[c] !== '-') previous = c;
  }
  previousBase[columns] = previous; nextBase[columns] = -1;
  for (let c = columns - 1; c >= 0; c--) {
    if (reference.sequence[c] !== '-') next = c;
    nextBase[c] = next;
  }
  if (positions[columns] !== graph.referenceLength || columns !== graph.diagnostics.columns) {
    throw new Error('VCF reference length or alignment metadata is inconsistent.');
  }
  const refBounds = bounds(reference.sequence);
  return { reference, queries, columns, positions, previousBase, nextBase,
    bounds: queries.map(s => {
      const own = bounds(s.sequence);
      return { start: Math.max(refBounds.start, own.start), end: Math.min(refBounds.end, own.end) };
    }), missingTerminals: options.terminalGaps === 'missing' };
}
const encoded = (value: string): string => encodeURIComponent(value);
function referenceFasta(input: AlignmentInput): string {
  const dna = input.reference.sequence.replaceAll('-', '');
  const lines = [`>reference original_id_uri=${encoded(input.reference.id)}`];
  for (let start = 0; start < dna.length; start += 80) lines.push(dna.slice(start, start + 80));
  return lines.join('\n') + '\n';
}
/** Matching contig name and the submitted reference's ungapped coordinate system. */
export function exportPangenomeReferenceFasta(graph: AlignmentPangenome): string {
  return referenceFasta(checkedAlignment(graph));
}

/** Emit variant-only, haploid GT records. A dot is unknown/uncovered sequence,
 * never a negative result. No read depths, quality values or filter passes are
 * invented. The supplied result identity is metadata, not a verification step;
 * callers loading saved JSON must use replayAlignmentPangenome first.
 */
export function exportPangenomeVcf(graph: AlignmentPangenome, resultId?: string): string {
  if (resultId !== undefined && !/^[a-f0-9]{64}$/.test(resultId)) throw new Error('VCF result identity must be a SHA-256 hex digest.');
  const input = checkedAlignment(graph), { reference, queries, columns, positions } = input;
  let work = 0;
  const spend = (amount = 1): void => {
    work += amount;
    if (work > PANGENOME_VCF_LIMITS.work) throw new Error('VCF export work limit exceeded; export a smaller aligned region. No partial VCF was produced.');
  };
  const observed = (q: number, c: number): boolean => !input.missingTerminals
    || c >= input.bounds[q].start && c < input.bounds[q].end;
  // One end per start avoids O(samples * columns) event objects. SNVs remain
  // separate; contiguous indels form runs. All-gap columns do not split a run.
  const ends = new Int32Array(columns);
  const add = (start: number, end: number): void => { ends[start] = Math.max(ends[start], end); };
  for (let q = 0; q < queries.length; q++) {
    const seq = queries[q].sequence;
    let run: Span | null = null, kind = '';
    const flush = () => { if (run) add(run.start, run.end); run = null; kind = ''; };
    for (let c = 0; c < columns; c++) {
      spend();
      const a = reference.sequence[c], b = seq[c];
      if (a === '-' && b === '-') { if (run) run.end = c + 1; continue; }
      if (!observed(q, c) || a !== '-' && !resolved(a) || b !== '-' && !resolved(b) || a === b) { flush(); continue; }
      if (a !== '-' && b !== '-') { flush(); add(c, c + 1); continue; }
      const nextKind = a === '-' ? 'insertion' : 'deletion';
      if (run && kind === nextKind) run.end = c + 1;
      else { flush(); run = { start: c, end: c + 1 }; kind = nextKind; }
    }
    flush();
  }
  const merge = (spans: Span[]): Span[] => {
    const merged: Span[] = [];
    for (const span of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
      spend();
      const previous = merged[merged.length - 1];
      if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
      else merged.push({ ...span });
    }
    return merged;
  };
  let spans = merge(Array.from(ends, (end, start) => ({ start, end })).filter(s => s.end > 0));
  const alleles = (span: Span): { ref: string; samples: Array<string | null> } => {
    const ref = reference.sequence.slice(span.start, span.end).replaceAll('-', '');
    spend(span.end - span.start);
    if (/[^ACGT]/.test(ref)) throw new Error('A VCF allele or padding base contains unresolved reference sequence; select a resolved aligned region.');
    const samples = queries.map((query, q) => {
      let allele = '';
      for (let c = span.start; c < span.end; c++) {
        spend();
        const base = query.sequence[c];
        // Columns empty in both rows carry no sequence/coverage claim.
        if (base === '-' && reference.sequence[c] === '-') continue;
        if (!observed(q, c) || base !== '-' && !resolved(base)) return null;
        if (base !== '-') allele += base;
      }
      return allele;
    });
    return { ref, samples };
  };
  // VCF requires a padding base for empty REF/ALT. Padding can overlap another
  // event, including another sample's longer deletion, so merge and repeat.
  // Every non-final pass grows a span or reduces their count; work is bounded.
  while (true) {
    let changed = false, unpadded = false;
    for (const span of spans) {
      const value = alleles(span);
      if (value.ref && !value.samples.includes('')) continue;
      const before = input.previousBase[span.start];
      if (before >= 0) span.start = before;
      else {
        const after = input.nextBase[span.end];
        // Another event may pad INTO this whole-reference deletion. Merge
        // first; the resulting replacement may have no empty allele at all.
        if (after < 0) { unpadded = true; continue; }
        span.end = after + 1;
      }
      changed = true;
    }
    if (!changed) {
      if (unpadded) throw new Error('Cannot pad a whole-reference deletion without a reference base.');
      break;
    }
    spans = merge(spans);
  }
  const lines = [
    '##fileformat=VCFv4.3',
    '##source=PhageExplorerAlignmentExport',
    `##contig=<ID=reference,length=${graph.referenceLength}>`,
    `##phage_explorer_reference_id_uri="${encoded(reference.id)}"`,
    `##phage_explorer_terminal_gaps=${graph.options.terminalGaps}`,
    `##phage_explorer_alignment=${graph.options.alignment}`,
    `##phage_explorer_normalization=${graph.options.normalization ?? 'none'}`,
    '##phage_explorer_interpretation="Alignment-conditional haploid alleles; no read-based calling, quality calibration or repeat left-normalization. Variant-only: absence is not a coverage assertion."',
    '##INFO=<ID=AC,Number=A,Type=Integer,Description="Alternate allele counts among callable query sequences">',
    '##INFO=<ID=AN,Number=1,Type=Integer,Description="Number of callable haploid query sequences">',
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Haploid allele index; dot means unresolved or missing coverage across the complete padded locus">',
    ...(resultId ? [`##phage_explorer_result=${resultId}`] : []),
    ...queries.map((query, q) => `##SAMPLE=<ID=query${q + 1},Description="Original sequence identifier (URI encoded): ${encoded(query.id)}">`),
    ['#CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO', 'FORMAT', ...queries.map((_, q) => `query${q + 1}`)].join('\t'),
  ];
  // All metadata is ASCII because original identifiers are URI encoded.
  let bytes = lines.reduce((n, line) => n + line.length + 1, 0), previousEnd = 0;
  for (const span of spans) {
    const value = alleles(span), alternatives = [...new Set(value.samples.filter((a): a is string => a !== null && a !== value.ref))].sort();
    // Opposing gap placements can spell exactly the reference after grouping.
    // This is not a variant. Missing observations, however, cannot prove that.
    if (!alternatives.length && value.samples.every(a => a === value.ref)) continue;
    if (!alternatives.length) throw new Error('A variant has no fully observed query allele after combining or padding its locus; export a smaller region or the alignment instead.');
    const start = positions[span.start], end = positions[span.end];
    if (start < previousEnd || !value.ref || alternatives.some(a => !a)) throw new Error('VCF loci could not be represented without overlapping or empty alleles.');
    previousEnd = end;
    const genotypes = value.samples.map(a => a === null ? '.' : a === value.ref ? '0' : String(alternatives.indexOf(a) + 1));
    const counts = alternatives.map((_, i) => genotypes.filter(g => g === String(i + 1)).length);
    const an = genotypes.filter(g => g !== '.').length;
    const line = ['reference', String(start + 1), '.', value.ref, alternatives.join(','), '.', '.',
      `AC=${counts.join(',')};AN=${an}`, 'GT', ...genotypes].join('\t');
    bytes += line.length + 1;
    if (bytes > PANGENOME_VCF_LIMITS.bytes) throw new Error('VCF export exceeds 10 MiB; select fewer sequences or a smaller aligned region.');
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}
