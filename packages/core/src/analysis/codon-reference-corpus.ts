/** Source-derived codon counts, not an inferred highly-expressed reference set.
 * Reuses the GenBank parser and the CDS consequence engine's transcript rules.
 * INSDC CDS/codon_start: https://www.insdc.org/submitting-standards/feature-table/
 */
import { CODON_TABLE } from '../codons';
import { GENOME_IMPORT_LIMITS, getGeneMapSegments, importLocalGenomes, type GenomeInput } from '../genome-import';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { reconstructCdsReference, type CdsReference } from './cds-consequences';
import type { CodonReference } from './codon-reference';

export const CODON_CORPUS_LIMITS = { genes: 20000, extractedBases: 25000000 } as const;
export const CODON_CORPUS_METHOD = { id: 'genbank-codon-reference', version: '1',
  implementation: 'source-reparsed mapped CDS census; shared transcript validation; exact integer codon counts' } as const;
export interface CodonCorpusOptions {
  name: string; organism: string; citation: string; version: string; geneticCode: 1 | 11;
  /** Omission selects all GenBank records. An accession must resolve uniquely. */
  record?: string | null;
  /** Numeric IDs are scoped to one selected record; null selects all mapped CDS. */
  geneIds?: number[] | null;
  unavailable?: 'reject' | 'exclude';
}
export interface CodonCorpusGene {
  contentId: string; geneId: number; name: string; geneticCode: number; codonStart: number;
  segments: CdsReference['segments']; status: 'counted' | 'excluded'; codons: number; reasons: string[];
}
export interface CodonReferenceCorpus {
  reference: CodonReference;
  genes: CodonCorpusGene[];
  sources: Array<{ contentId: string; accession: string; warnings: string[]; unmappedCds: number }>;
  summary: { records: number; selectedMappedCds: number; countedCds: number; excludedMappedCds: number;
    unmappedCds: number; codons: number; terminalStops: number };
  record: AnalysisRecord;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function printable(value: unknown, maximum: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${name} needs 1–${maximum} printable characters.`);
  }
  return value;
}
export function resolveCodonCorpusOptions(value: CodonCorpusOptions): Required<CodonCorpusOptions> {
  if (!object(value) || Object.keys(value).some(key => !['name', 'organism', 'citation', 'version', 'geneticCode', 'record', 'geneIds', 'unavailable'].includes(key))) {
    throw new Error('Unsupported codon corpus options.');
  }
  if (value.geneticCode !== 1 && value.geneticCode !== 11) throw new Error('Choose genetic code 1 or 11 explicitly.');
  const unavailable = value.unavailable ?? 'reject';
  if (unavailable !== 'reject' && unavailable !== 'exclude') throw new Error('Unavailable CDS policy must be reject or exclude.');
  const geneIds = value.geneIds ?? null;
  if (geneIds !== null && (!Array.isArray(geneIds) || !geneIds.length || geneIds.length > CODON_CORPUS_LIMITS.genes
      || geneIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(geneIds).size !== geneIds.length)) {
    throw new Error('Select distinct positive mapped CDS IDs, or all mapped CDS.');
  }
  return { name: printable(value.name, 300, 'Reference name'), organism: printable(value.organism, 300, 'Reference organism'),
    citation: printable(value.citation, 2000, 'Corpus citation'), version: printable(value.version, 200, 'Corpus version'),
    geneticCode: value.geneticCode, record: value.record == null ? null : printable(value.record, 2000, 'Record selector'),
    geneIds: geneIds === null ? null : [...geneIds].sort((a, b) => a - b), unavailable };
}
const LIMITATIONS = [
  'Counts describe only the explicitly selected mapped CDS in this submitted corpus. Organism, citation and suitability are user assertions; high expression, host compatibility and representativeness are not inferred.',
  'Each accepted annotation contributes its original in-frame DNA triplets, including initiator, Met, Trp and terminal stop codons. Downstream CAI excludes Met, Trp and stops. Overlapping distinct CDS are counted separately; duplicate transcript coordinates/frame in one record are excluded or rejected.',
  'All 64 codons are reported: zero means no occurrence in the accepted CDS, not absence from the organism. Invalid selected CDS contribute no partial counts. Parser-unmapped CDS are reported separately, not silently counted as analyzed genes.',
  'Genetic codes 1 and 11 only; the annotation table (default 1) must equal the declared corpus table. Unsupported recoding, ambiguity, incomplete codons, internal stops and inconsistent deposited translations are rejected or explicitly excluded.',
  'Joined, reverse-strand and circular-origin CDS follow the deposited transcript order and codon_start. Whole-CDS completeness, biological function and expression are not established by a triplet count.',
  'Replay reparses original source and recounts before comparing full evidence identity. A checksum neither authenticates the author nor validates the biological choice of a reference corpus.',
];

export async function createCodonReferenceCorpus(input: GenomeInput, settings: CodonCorpusOptions): Promise<CodonReferenceCorpus> {
  // Capture all mutable values before the parser's first hashing await.
  if (!object(input) || Object.keys(input).some(key => key !== 'name' && key !== 'text') || typeof input.text !== 'string'
      || input.text.length > GENOME_IMPORT_LIMITS.bytes) throw new Error('Supply a bounded original GenBank or local-bundle input.');
  const source = { name: printable(input.name, 2000, 'Input name'), text: input.text };
  const options = resolveCodonCorpusOptions(settings);
  const parsed = await importLocalGenomes(source);
  const selected = parsed.genomes.filter(g => options.record === null || g.phage.accession === options.record || g.phage.localGenome?.contentId === options.record)
    .sort((a, b) => a.phage.localGenome!.contentId < b.phage.localGenome!.contentId ? -1 : 1);
  if (!selected.length || options.record !== null && selected.length !== 1) throw new Error('Record selector must resolve uniquely; use a full content ID when accessions collide.');
  if (selected.some(g => g.phage.localGenome?.format !== 'genbank')) throw new Error('A count corpus requires GenBank CDS, not FASTA-inferred reading frames. Select a GenBank record.');
  if (options.geneIds !== null && selected.length !== 1) throw new Error('Mapped CDS IDs require a single selected record.');
  const identities = selected.map(g => g.phage.localGenome!.contentId);
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate content-identified records would double-count the corpus.');
  const counts = Object.fromEntries(Object.keys(CODON_TABLE).sort().map(codon => [codon, 0]));
  const genes: CodonCorpusGene[] = [], sources: CodonReferenceCorpus['sources'] = [];
  let extractedBases = 0, terminalStops = 0;
  for (const genome of selected) {
    const contentId = genome.phage.localGenome!.contentId;
    // Repeated semantic qualifiers cannot be attributed safely to mapped gene IDs
    // by the current parser. Do not silently use its viewer-first-value convention.
    if (genome.warnings.some(w => w.startsWith('CDS: repeated /'))) throw new Error('Repeated CDS qualifiers need source correction before building a count reference.');
    const unmappedCds = genome.warnings.filter(w => w.startsWith('CDS ') && w.includes('excluded from the gene map')).length;
    if (unmappedCds && options.geneIds === null && options.unavailable === 'reject') {
      throw new Error('The source has unmapped CDS. Select mapped CDS explicitly or choose exclusion with an audited report.');
    }
    sources.push({ contentId, accession: genome.phage.accession, warnings: [...genome.warnings], unmappedCds });
    const candidates = genome.phage.genes.filter(g => g.type === 'CDS');
    if (options.geneIds?.some(id => !candidates.some(g => g.id === id))) throw new Error('A selected mapped CDS ID is missing from this record.');
    const chosen = candidates.filter(g => options.geneIds === null || options.geneIds.includes(g.id)).sort((a, b) => a.id - b.id);
    if (!chosen.length) throw new Error('A selected record has no mapped CDS to count.');
    if (genes.length + chosen.length > CODON_CORPUS_LIMITS.genes) throw new Error('Corpus exceeds 20,000 selected mapped CDS.');
    const seenTranscripts = new Set<string>();
    for (const gene of chosen) {
      const raw = getGeneMapSegments(gene);
      extractedBases += raw.reduce((total, segment) => total + segment.end - segment.start, 0);
      if (!Number.isSafeInteger(extractedBases) || extractedBases > CODON_CORPUS_LIMITS.extractedBases) {
        throw new Error('Corpus exceeds the 25,000,000 extracted-base budget. Select fewer CDS.');
      }
      const transcript = reconstructCdsReference(gene, genome.sequence);
      const reasons = [...transcript.reasons];
      if (transcript.geneticCode !== options.geneticCode) reasons.push('Annotation genetic code differs from the declared corpus code.');
      const key = JSON.stringify([raw, transcript.codonStart]);
      if (seenTranscripts.has(key)) reasons.push('Duplicate transcript coordinates and frame in this record.');
      // Only a usable predecessor owns a locus: an excluded pseudogene does not
      // prevent a later validated annotation of the same coordinates from counting.
      if (!reasons.length) seenTranscripts.add(key);
      const row: CodonCorpusGene = { contentId, geneId: gene.id, name: transcript.name, geneticCode: transcript.geneticCode,
        codonStart: transcript.codonStart, segments: transcript.segments, status: reasons.length ? 'excluded' : 'counted',
        codons: reasons.length ? 0 : transcript.cds!.length / 3, reasons };
      genes.push(row);
      if (reasons.length) {
        if (options.unavailable === 'reject') throw new Error(`CDS ${gene.id} in ${genome.phage.accession} cannot be counted: ${reasons.join(' ')}`);
        continue;
      }
      const cds = transcript.cds!;
      for (let offset = 0; offset < cds.length; offset += 3) counts[cds.slice(offset, offset + 3)]++;
      if (CODON_TABLE[cds.slice(-3)] === '*') terminalStops++;
    }
  }
  const codons = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (!codons) throw new Error('No valid selected CDS contributed codons; no reference was produced.');
  const reference: CodonReference = { format: 'phage-explorer-codon-reference', version: 1,
    name: options.name, organism: options.organism, geneticCode: options.geneticCode,
    source: { citation: options.citation, version: options.version }, counts };
  const countedCds = genes.filter(g => g.status === 'counted').length;
  const summary = { records: sources.length, selectedMappedCds: genes.length, countedCds,
    excludedMappedCds: genes.length - countedCds, unmappedCds: sources.reduce((n, s) => n + s.unmappedCds, 0), codons, terminalStops };
  const coverage = { available: countedCds, total: genes.length, unit: 'genes' as const };
  const field = (label: string, value: unknown) => ({ label, value: analysisJson(value), kind: 'sequence-score' as const,
    units: 'records' as const, coverage, limitations: LIMITATIONS });
  const record = await createAnalysisRecord({ method: CODON_CORPUS_METHOD, seed: null,
    inputs: [{ id: 'source', accession: null, source: 'local', description: 'Exact original GenBank or source bundle, freshly reparsed during replay.', data: analysisJson(source) }],
    parameters: analysisJson(options) as AnalysisRecord['parameters'],
    references: [{ id: 'insdc-feature-table', version: 'CDS-codon-start-1-2-3', description: 'Deposited CDS segments, genetic code and codon_start; no gene prediction.' }],
    fields: { reference: field('Raw integer counts and asserted reference metadata', reference),
      genes: field('Selected mapped CDS and explicit exclusions', genes), sources: field('Record identities and parser coverage warnings', sources),
      summary: field('Counted, excluded and unmapped CDS coverage', summary) } });
  return { reference, genes, sources, summary, record };
}
export async function replayCodonReferenceCorpus(content: string): Promise<CodonReferenceCorpus> {
  const saved = await parseAnalysisRecord(content, { methodId: CODON_CORPUS_METHOD.id, methodVersion: CODON_CORPUS_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'source') throw new Error('Corpus replay needs the exact original source.');
  const fresh = await createCodonReferenceCorpus(saved.inputs[0].data as unknown as GenomeInput, saved.parameters as unknown as CodonCorpusOptions);
  if (fresh.record.cacheKey !== saved.cacheKey || fresh.record.resultId !== saved.resultId) throw new Error('Recomputed corpus inputs, selection, counts or coverage differ from the saved result.');
  return fresh;
}
/** Portable input for the existing CAI consumer, with a link to the full audit.
 * Keep the corpus experiment too: counts JSON alone cannot replay its extraction.
 */
export function exportCodonCorpusReference(corpus: CodonReferenceCorpus): string {
  return JSON.stringify({ ...corpus.reference, source: { ...corpus.reference.source,
    version: `${corpus.reference.source.version}; corpus-sha256:${corpus.record.resultId}` } }, null, 2);
}
