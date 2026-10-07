/**
 * Reference-backed codon adaptation, separate from the illustrative host model.
 * Sharp & Li (1987), doi:10.1093/nar/15.3.1281: normalize counts within synonymous
 * families and take a geometric mean, excluding Met, Trp and termination codons.
 * The optional 0.5 replacement applies to REPORTED zero counts, never missing data.
 */
import { CODON_TABLE } from '../codons';
import { replayCodonReferenceCorpus, type CodonReferenceCorpus } from './codon-reference-corpus';
import { extractGeneSequence } from './codon-pair-adaptation';
import { getGeneMapSegments } from '../genome-import';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import type { GeneInfo, PhageFull } from '../types';

export const CODON_REFERENCE_LIMITS = { bytes: 128 * 1024, bases: 5_000_000, genes: 20_000, extractedBases: 25_000_000 } as const;
export const CODON_REFERENCE_METHOD = { id: 'reference-codon-adaptation', version: '1', implementation: 'JavaScript reference-count CAI over annotated CDS' } as const;
export type ZeroCountReplacement = 0 | 0.5;
export interface CodonReference {
  format: 'phage-explorer-codon-reference';
  version: 1;
  name: string;
  organism: string;
  geneticCode: 1 | 11;
  source: { citation: string; version: string };
  /** Omitted codons are unavailable, NOT zero. Units are integer codon counts. */
  counts: Record<string, number>;
}
export interface CodonReferenceWeights {
  weights: Record<string, number | null>;
  coveredFamilies: string[];
  missingFamilies: string[];
}
export interface ReferenceCodonScore {
  cai: number | null;
  completeCodons: number;
  eligibleCodons: number;
  scoredCodons: number;
  ambiguousCodons: number;
  singleCodonAminoAcids: number;
  stopCodons: number;
  internalStops: number;
  trailingBases: number;
  zeroWeightCodons: number;
  missingReferenceCodons: Record<string, number>;
  reasons: string[];
}
export interface ReferenceCodonGene extends ReferenceCodonScore {
  geneId: number;
  label: string;
  startPos: number;
  endPos: number;
  strand: string;
}
export interface ReferenceCodonAnalysis {
  reference: CodonReference;
  zeroCountReplacement: ZeroCountReplacement;
  referenceCoverage: CodonReferenceWeights;
  genes: ReferenceCodonGene[];
  /** Codon-weighted geometric mean of fully scorable genes ONLY. Coverage is mandatory. */
  summary: { cai: number | null; scoredGenes: number; totalGenes: number; scoredCodons: number };
}
export interface ReferenceCodonGenome {
  id: number;
  name: string;
  accession: string;
  source: 'local' | 'catalog';
  genes: GeneInfo[];
}
export interface ReferenceCodonOptions { geneIds?: number[] | null; zeroCountReplacement?: ZeroCountReplacement }
export interface ReferenceCodonExperiment { analysis: ReferenceCodonAnalysis; record: AnalysisRecord }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const families = new Map<string, string[]>();
for (const [codon, aminoAcid] of Object.entries(CODON_TABLE)) {
  if (aminoAcid === '*' || aminoAcid === 'M' || aminoAcid === 'W') continue;
  families.set(aminoAcid, [...(families.get(aminoAcid) ?? []), codon]);
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).sort().join('|') !== [...allowed].sort().join('|')) throw new Error(`${label}: unsupported or missing fields.`);
}
function printable(value: unknown, label: string, maximum = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must contain 1–${maximum} printable characters.`);
  }
  return value;
}
function policy(value: unknown): asserts value is ZeroCountReplacement {
  if (value !== 0 && value !== 0.5) throw new Error('Zero-count replacement must be 0 or 0.5.');
}
export function parseCodonReference(content: string): CodonReference {
  if (new TextEncoder().encode(content).length > CODON_REFERENCE_LIMITS.bytes) throw new Error('Codon reference exceeds the 128 KiB limit.');
  const value: unknown = JSON.parse(content);
  if (!object(value)) throw new Error('Expected a codon reference JSON object.');
  exactKeys(value, ['format', 'version', 'name', 'organism', 'geneticCode', 'source', 'counts'], 'Codon reference');
  if (value.format !== 'phage-explorer-codon-reference' || value.version !== 1) throw new Error('Unsupported codon reference format/version.');
  if (value.geneticCode !== 1 && value.geneticCode !== 11) throw new Error('Only genetic codes 1 and 11 are supported.');
  printable(value.name, 'Reference name'); printable(value.organism, 'Reference organism');
  if (!object(value.source)) throw new Error('Reference citation and version are required.');
  exactKeys(value.source, ['citation', 'version'], 'Reference source');
  printable(value.source.citation, 'Reference citation', 2000); printable(value.source.version, 'Reference version');
  if (!object(value.counts) || !Object.keys(value.counts).length) throw new Error('Provide reported codon counts, not weights or frequencies.');
  let total = 0;
  const counts: Record<string, number> = {};
  for (const codon of Object.keys(value.counts).sort()) {
    const count = value.counts[codon];
    if (!/^[ACGT]{3}$/.test(codon) || !Number.isSafeInteger(count) || Number(count) < 0) throw new Error(`Invalid reported count for ${codon}. Use uppercase DNA codons and non-negative integers.`);
    total += Number(count);
    if (!Number.isSafeInteger(total)) throw new Error('Reference total exceeds the safe integer range.');
    counts[codon] = Number(count);
  }
  if (total === 0) throw new Error('Reference counts contain no observations.');
  return { format: 'phage-explorer-codon-reference', version: 1, name: value.name as string, organism: value.organism as string,
    geneticCode: value.geneticCode, source: { citation: value.source.citation as string, version: value.source.version as string }, counts };
}
/** Validate public object inputs too; caller mutation cannot change an in-flight experiment. */
function copyReference(reference: CodonReference): CodonReference {
  return parseCodonReference(JSON.stringify(analysisJson(reference)));
}
export function buildCodonReferenceWeights(reference: CodonReference, zeroCountReplacement: ZeroCountReplacement = 0.5): CodonReferenceWeights {
  policy(zeroCountReplacement);
  const checked = copyReference(reference);
  const weights: Record<string, number | null> = {};
  const coveredFamilies: string[] = [], missingFamilies: string[] = [];
  for (const [aminoAcid, codons] of families) {
    const covered = codons.every(codon => Object.hasOwn(checked.counts, codon)) && codons.some(codon => checked.counts[codon] > 0);
    (covered ? coveredFamilies : missingFamilies).push(aminoAcid);
    // An entirely unobserved family cannot become perfect adaptation via pseudocounts.
    const maximum = covered ? Math.max(...codons.map(codon => checked.counts[codon])) : 0;
    for (const codon of codons) weights[codon] = covered ? (checked.counts[codon] === 0 ? zeroCountReplacement : checked.counts[codon]) / maximum : null;
  }
  return { weights, coveredFamilies: coveredFamilies.sort(), missingFamilies: missingFamilies.sort() };
}
function scoreSequence(sequence: string, reference: CodonReferenceWeights): ReferenceCodonScore {
  const score: ReferenceCodonScore = { cai: null, completeCodons: Math.floor(sequence.length / 3), eligibleCodons: 0, scoredCodons: 0,
    ambiguousCodons: 0, singleCodonAminoAcids: 0, stopCodons: 0, internalStops: 0, trailingBases: sequence.length % 3,
    zeroWeightCodons: 0, missingReferenceCodons: {}, reasons: [] };
  let logSum = 0;
  for (let offset = 0; offset + 3 <= sequence.length; offset += 3) {
    // Never filter ambiguity or uppercase Unicode expansions across coordinates.
    const original = sequence.slice(offset, offset + 3);
    if (!/^[ACGT]{3}$/i.test(original)) { score.ambiguousCodons++; continue; }
    const codon = original.toUpperCase(), aminoAcid = CODON_TABLE[codon];
    if (aminoAcid === '*') {
      score.stopCodons++;
      if (offset + 3 !== sequence.length) score.internalStops++;
      continue;
    }
    if (aminoAcid === 'M' || aminoAcid === 'W') { score.singleCodonAminoAcids++; continue; }
    score.eligibleCodons++;
    const weight = reference.weights[codon];
    if (weight === null || weight === undefined) { score.missingReferenceCodons[codon] = (score.missingReferenceCodons[codon] ?? 0) + 1; continue; }
    score.scoredCodons++;
    if (weight === 0) score.zeroWeightCodons++; else logSum += Math.log(weight);
  }
  if (score.trailingBases) score.reasons.push('Incomplete terminal codon.');
  if (score.ambiguousCodons) score.reasons.push('Unresolved triplets remain in the coding sequence.');
  if (score.internalStops) score.reasons.push('Internal stop codon; translation exceptions are not modeled.');
  if (!score.eligibleCodons) score.reasons.push('No resolved synonymous-choice codons (Met, Trp and stops are excluded).');
  if (score.scoredCodons < score.eligibleCodons) score.reasons.push('The reference does not cover every consumed synonymous family.');
  if (!score.reasons.length) score.cai = score.zeroWeightCodons ? 0 : Math.exp(logSum / score.scoredCodons);
  return score;
}
export function scoreCodonReferenceSequence(sequence: string, reference: CodonReference, zeroCountReplacement: ZeroCountReplacement = 0.5): ReferenceCodonScore {
  if (typeof sequence !== 'string' || sequence.length > CODON_REFERENCE_LIMITS.bases) throw new Error('Coding sequence exceeds the 5,000,000-base limit.');
  return scoreSequence(sequence, buildCodonReferenceWeights(reference, zeroCountReplacement));
}
export function referenceGenomeFromPhage(phage: PhageFull): ReferenceCodonGenome {
  return { id: phage.id, name: phage.name, accession: phage.accession, source: phage.localGenome ? 'local' : 'catalog', genes: phage.genes };
}
function validateGenome(value: unknown, sequence: unknown): asserts value is ReferenceCodonGenome {
  if (!object(value) || !Number.isSafeInteger(value.id) || !['local', 'catalog'].includes(String(value.source))) throw new Error('Invalid reference-analysis genome identity.');
  printable(value.name, 'Genome name', 2000); printable(value.accession, 'Genome accession', 2000);
  if (typeof sequence !== 'string' || !sequence.length || sequence.length > CODON_REFERENCE_LIMITS.bases) throw new Error('Supply 1–5,000,000 genome bases.');
  if (!Array.isArray(value.genes) || value.genes.length > CODON_REFERENCE_LIMITS.genes) throw new Error('Too many coding annotations.');
  const ids = new Set<number>();
  for (const gene of value.genes) {
    if (!object(gene) || !Number.isSafeInteger(gene.id) || ids.has(Number(gene.id))
      || !Number.isSafeInteger(gene.startPos) || !Number.isSafeInteger(gene.endPos)
      || !(gene.qualifiers == null || object(gene.qualifiers))) throw new Error('Invalid or duplicate coding annotation.');
    ids.add(Number(gene.id));
  }
}
function normalizeOptions(options: ReferenceCodonOptions): { geneIds: number[] | null; zeroCountReplacement: ZeroCountReplacement } {
  const zeroCountReplacement = options.zeroCountReplacement ?? 0.5;
  policy(zeroCountReplacement);
  const geneIds = options.geneIds ?? null;
  if (geneIds !== null && (!Array.isArray(geneIds) || geneIds.length === 0 || geneIds.length > CODON_REFERENCE_LIMITS.genes
    || !geneIds.every(Number.isSafeInteger) || new Set(geneIds).size !== geneIds.length)) throw new Error('Select unique coding gene IDs or all CDS.');
  return { geneIds: geneIds === null ? null : [...geneIds].sort((a, b) => a - b), zeroCountReplacement };
}
function analyze(genome: ReferenceCodonGenome, sequence: string, reference: CodonReference, options: ReturnType<typeof normalizeOptions>): ReferenceCodonAnalysis {
  validateGenome(genome, sequence);
  const candidates = genome.genes.filter(gene => !gene.type || gene.type === 'CDS');
  if (options.geneIds?.some(id => !candidates.some(gene => gene.id === id))) throw new Error('A selected CDS is missing or is not a coding annotation.');
  const selected = options.geneIds === null ? candidates : candidates.filter(gene => options.geneIds!.includes(gene.id));
  if (!selected.length) throw new Error('No coding annotations are available; FASTA alone does not establish CDS coordinates.');
  const referenceCoverage = buildCodonReferenceWeights(reference, options.zeroCountReplacement);
  let extracted = 0;
  const genes = selected.map((gene): ReferenceCodonGene => {
    let reason: string | null = null;
    const qualifiers = gene.qualifiers ?? {};
    if (Object.hasOwn(qualifiers, 'pseudo') || Object.hasOwn(qualifiers, 'pseudogene')) reason = 'Pseudogene annotations are not scored.';
    if (qualifiers.transl_except || qualifiers.exception) reason = 'Translation exceptions require a supported recoding model.';
    if (qualifiers.transl_table && !['1', '11'].includes(String(qualifiers.transl_table))) reason = 'Unsupported CDS genetic code.';
    // Check duplicated/joined annotation expansion BEFORE allocating the transcript.
    if (!reason) {
      const raw = qualifiers._segments;
      if (Array.isArray(raw) && raw.length > CODON_REFERENCE_LIMITS.genes) throw new Error('Too many joined CDS segments.');
      const segments = getGeneMapSegments(gene);
      const length = segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
      if (!Number.isSafeInteger(length) || extracted + length > CODON_REFERENCE_LIMITS.extractedBases) throw new Error('Combined annotated CDS exceeds the 25,000,000-base analysis limit.');
    }
    const coding = reason ? '' : extractGeneSequence(gene, sequence);
    if (!reason && !coding) reason = 'Missing or unsupported CDS coordinates, strand, join or codon_start.';
    extracted += coding.length;
    if (extracted > CODON_REFERENCE_LIMITS.extractedBases) throw new Error('Combined annotated CDS exceeds the 25,000,000-base analysis limit.');
    const scored = scoreSequence(coding, referenceCoverage);
    if (reason) scored.reasons = [reason];
    return { ...scored, geneId: gene.id, label: gene.locusTag ?? gene.name ?? `CDS ${gene.id}`, startPos: gene.startPos, endPos: gene.endPos, strand: gene.strand ?? '+' };
  });
  const available = genes.filter(gene => gene.cai !== null);
  const scoredCodons = available.reduce((total, gene) => total + gene.scoredCodons, 0);
  const pooled = scoredCodons === 0 ? null : available.some(gene => gene.cai === 0) ? 0
    : Math.exp(available.reduce((sum, gene) => sum + gene.scoredCodons * Math.log(gene.cai!), 0) / scoredCodons);
  return { reference, zeroCountReplacement: options.zeroCountReplacement, referenceCoverage, genes,
    summary: { cai: pooled, scoredGenes: available.length, totalGenes: genes.length, scoredCodons } };
}
const limitations = [
  'Reference counts and attribution are supplied by the user and are not independently verified.',
  'CAI is a reference-relative sequence score, not a measurement of expression, tRNA abundance, infectivity, host range or host switching.',
  'Missing or wholly unobserved synonymous families have no weights. Reported zeros alone receive the selected replacement.',
  'Met, Trp and terminal stop codons are excluded. Ambiguous triplets, partial terminal codons, internal stops and unsupported CDS prevent a full gene score.',
  'The pooled value is a codon-weighted geometric mean over fully scorable CDS only; overlapping CDS may count the same genomic bases more than once.',
];
/** Count-only JSON retains its existing contract. A corpus experiment is freshly
 * replayed before its counts can enter a score; its original source travels with
 * the query experiment, not a path that could change on another machine.
 */
export async function resolveCodonReferenceInput(content: string): Promise<{ reference: CodonReference; corpus?: CodonReferenceCorpus }> {
  if (typeof content !== 'string' || content.length > 10 * 1024 * 1024 || new TextEncoder().encode(content).length > 10 * 1024 * 1024) throw new Error('Reference input exceeds 10 MiB.');
  const value: unknown = JSON.parse(content);
  if (object(value) && value.format === 'phage-explorer-analysis') {
    const corpus = await replayCodonReferenceCorpus(content);
    return { reference: corpus.reference, corpus };
  }
  return { reference: parseCodonReference(content) };
}
export const CODON_REFERENCE_SOURCE_METHOD = { ...CODON_REFERENCE_METHOD, version: '2',
  implementation: 'reference-count CAI after fresh original-GenBank corpus replay' };
export async function createReferenceCodonExperiment(genome: ReferenceCodonGenome, sequence: string, referenceText: string,
  options: ReferenceCodonOptions = {}): Promise<ReferenceCodonExperiment> {
  // Snapshot before any hashing awaits; a changed reference/selection cannot relabel results.
  const captured = analysisJson({ genome, sequence, referenceText, options: normalizeOptions(options) }) as unknown as {
    genome: ReferenceCodonGenome; sequence: string; referenceText: string; options: ReturnType<typeof normalizeOptions>;
  };
  const { reference, corpus } = await resolveCodonReferenceInput(captured.referenceText);
  const evidenceLimits = corpus ? [
    'Reference counts are recomputed from the embedded original GenBank corpus. Attribution and selection suitability remain author assertions.',
    ...limitations.slice(1), 'Corpus exclusions and overlapping-CDS policies remain those in the embedded source experiment.',
  ] : limitations;
  const analysis = analyze(captured.genome, captured.sequence, reference, captured.options);
  const coverage = { available: analysis.summary.scoredGenes, total: analysis.summary.totalGenes, unit: 'genes' as const };
  const record = await createAnalysisRecord({ method: corpus ? CODON_REFERENCE_SOURCE_METHOD : CODON_REFERENCE_METHOD, seed: null,
    inputs: [
      { id: 'genome', accession: captured.genome.accession, source: captured.genome.source, description: 'Exact genome used for annotated CDS extraction.', data: captured.sequence },
      { id: 'annotations', accession: captured.genome.accession, source: captured.genome.source, description: 'Genome identity and original CDS annotations, including joined segments and translation qualifiers.', data: analysisJson(captured.genome) },
      { id: 'reference', accession: null, source: 'local', description: corpus ? 'Original source-backed reference experiment; source, selections and counts are recomputed before scoring.' : 'Exact user-supplied codon-count reference JSON; citation and version are asserted by its author.', data: captured.referenceText },
    ], parameters: captured.options,
    references: [{ id: '10.1093/nar/15.3.1281', version: '1987', description: 'Sharp and Li: synonymous-family relative adaptiveness and geometric-mean CAI.' },
      { id: reference.name, version: reference.source.version, description: reference.source.citation },
      ...(corpus ? [{ id: corpus.record.method.id, version: corpus.record.resultId, description: 'Exact freshly recomputed source-corpus result identity.' }] : [])],
    fields: {
      geneScores: { label: 'Reference-relative CAI and per-CDS coverage', kind: 'sequence-score', units: 'records', coverage, limitations: evidenceLimits, value: analysisJson(analysis.genes) },
      referenceWeights: { label: 'Weights derived from reported counts', kind: 'sequence-score', units: 'records',
        coverage: { available: analysis.referenceCoverage.coveredFamilies.length, total: families.size, unit: 'records' }, limitations: evidenceLimits, value: analysisJson(analysis.referenceCoverage) },
      pooledCai: analysis.summary.cai === null
        ? { label: 'Pooled CAI', kind: 'unavailable', units: null, coverage, limitations: evidenceLimits, value: null, missingInputs: ['At least one fully resolved supported CDS and complete nonempty reference families for all of its eligible codons.'] }
        : { label: 'Pooled CAI over fully scorable CDS', kind: 'sequence-score', units: 'fraction', coverage, limitations: evidenceLimits, value: analysis.summary.cai },
      summary: { label: 'Scored CDS and codon totals', kind: 'sequence-score', units: 'records', coverage, limitations: evidenceLimits, value: analysisJson(analysis.summary) },
    } });
  return { analysis, record };
}
/** Re-run extraction and scoring from original inputs; never trust imported displayed scores. */
export async function replayReferenceCodonExperiment(content: string): Promise<ReferenceCodonExperiment> {
  const record = await parseAnalysisRecord(content, { methodId: CODON_REFERENCE_METHOD.id });
  if (![CODON_REFERENCE_METHOD.version, CODON_REFERENCE_SOURCE_METHOD.version].includes(record.method.version)) throw new Error('Unsupported reference-analysis method version.');
  if (record.inputs.length !== 3) throw new Error('Unexpected reference-analysis inputs.');
  const sequence = record.inputs.find(input => input.id === 'genome')?.data;
  const genome = record.inputs.find(input => input.id === 'annotations')?.data;
  const reference = record.inputs.find(input => input.id === 'reference')?.data;
  if (typeof reference !== 'string') throw new Error('The original reference JSON is missing.');
  validateGenome(genome, sequence);
  exactKeys(record.parameters, ['geneIds', 'zeroCountReplacement'], 'Analysis parameters');
  const options = normalizeOptions(record.parameters as unknown as ReferenceCodonOptions);
  const fresh = await createReferenceCodonExperiment(genome, sequence as string, reference, options);
  if (fresh.record.cacheKey !== record.cacheKey || fresh.record.resultId !== record.resultId) throw new Error('Recomputed inputs, method or scores differ from the saved experiment.');
  return fresh;
}
