/** Complete annotated-CDS exports from one exact local or captured catalog genome.
 * Translation is shared with the selected-CDS/consequence views. This does not
 * discover genes, infer recoding, or turn a conceptual protein into an assay.
 */
import { importLocalGenomes, GENOME_IMPORT_LIMITS, type GenomeInput } from './genome-import';
import { extractCdsReferenceDna, reconstructCdsReference } from './analysis/cds-consequences';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from './analysis-result';

export const GENOME_CDS_LIMITS = {
  inputBytes: GENOME_IMPORT_LIMITS.bytes, recordBytes: 10 * 1024 * 1024,
  rows: 12000, extractedBases: 8000000, outputBytes: 10 * 1024 * 1024,
} as const;
export const GENOME_CDS_METHOD = {
  id: 'genome-annotated-cds-export', version: '1',
  implementation: 'exact source reimport; mapped CDS transcript reconstruction; explicit NCBI translation tables; per-feature unavailability and source-bound sequence exports',
} as const;
const REFERENCES = [
  { id: 'INSDC-feature-table', version: 'location-and-codon-start', description: 'Annotated transcript segments in biological order; codon_start is applied once to the complete transcript.' },
  { id: 'NCBI-genetic-codes', version: '1/4/11/15/25', description: 'Explicit supported translation tables and table-specific initiators; unsupported recoding and exceptional annotations remain unavailable.' },
];
const LIMITATIONS = [
  'Only mapped CDS annotations are exported. No open reading frames or missing genes are inferred; importer warnings describe source annotations excluded from mapping and the exact original input is retained.',
  'CDS DNA follows annotated transcript segments and codon_start. It can remain available when conceptual protein translation is unsupported, incomplete or ambiguous.',
  'Conceptual proteins use explicit supported genetic codes and initiation rules. Unsupported exceptions, pseudogenes, internal stops and contradictory deposited translations are not replaced with guessed proteins.',
  'The terminal * is a translated stop codon and is retained in protein FASTA. These sequences do not establish expression, protein function, host range or biological activity.',
  'Checksums bind the supplied source, selection and result; they do not authenticate annotation provenance. Replay reparses the embedded source and recomputes every selected CDS.',
];

export interface GenomeCdsOptions { record?: string | null; geneIds?: number[] | null }
export interface GenomeCdsResult {
  source: {
    name: string; accession: string; contentId: string; sequenceSha256: string;
    genomeLength: number; format: 'fasta' | 'genbank' | 'catalog-snapshot';
  };
  rows: Array<{
    id: string; geneId: number; name: string | null; locusTag: string | null; product: string | null;
    segments: Array<{ start: number; end: number; strand: '+' | '-'; partial5Prime?: true; partial3Prime?: true }>;
    partial5Prime?: true; partial3Prime?: true;
    codonStart: number; geneticCode: number; cds: string | null; protein: string | null;
    cdsSha256: string | null; proteinSha256: string | null;
    extractionReasons: string[]; translationReasons: string[];
  }>;
  summary: {
    mappedCds: number; selectedCds: number; cdsAvailable: number; proteinsAvailable: number;
    cdsUnavailable: number; proteinsUnavailable: number;
  };
  importWarnings: string[];
  limitations: string[];
}
export interface GenomeCdsExperiment {
  input: GenomeInput;
  options: { record: string; geneIds: number[] | null };
  result: GenomeCdsResult;
  record: AnalysisRecord;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Genome CDS export cancelled.', 'AbortError');
}
function snapshotInput(value: GenomeInput): GenomeInput {
  if (!object(value) || Object.keys(value).some(key => key !== 'name' && key !== 'text')
    || typeof value.name !== 'string' || value.name.length > 2000 || typeof value.text !== 'string') {
    throw new Error('Genome CDS export requires an exact named local input.');
  }
  if (value.text.length > GENOME_CDS_LIMITS.inputBytes
    || new TextEncoder().encode(value.text).length > GENOME_CDS_LIMITS.inputBytes) throw new Error('Genome input exceeds 10 MiB.');
  return { name: value.name, text: value.text };
}
function snapshotOptions(value: GenomeCdsOptions = {}): Required<GenomeCdsOptions> {
  if (!object(value) || Object.keys(value).some(key => key !== 'record' && key !== 'geneIds')) {
    throw new Error('Unsupported genome CDS selection fields.');
  }
  const record = value.record ?? null, ids = value.geneIds ?? null;
  if (record !== null && (typeof record !== 'string' || !record.trim() || record.length > 2000
    || /[\u0000-\u001f\u007f-\u009f]/.test(record))) throw new Error('Choose a nonempty genome accession or complete content ID.');
  if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > GENOME_CDS_LIMITS.rows
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)) {
    throw new Error('Choose distinct positive mapped CDS IDs, or omit geneIds to export all mapped CDS.');
  }
  return { record, geneIds: ids === null ? null : [...ids].sort((a, b) => a - b) };
}
async function sequenceHash(sequence: string | null): Promise<string | null> {
  if (sequence === null) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sequence));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

/** Snapshot before awaits. Hash/import the genome once, never once per CDS. */
export async function createGenomeCdsExperiment(raw: GenomeInput, settings: GenomeCdsOptions = {}, signal?: AbortSignal): Promise<GenomeCdsExperiment> {
  check(signal);
  const input = snapshotInput(raw), requested = snapshotOptions(settings);
  const parsed = await importLocalGenomes(input);
  check(signal);
  const matches = parsed.genomes.filter(genome => requested.record === null
    || genome.phage.accession === requested.record || genome.phage.localGenome!.contentId === requested.record);
  if (matches.length !== 1) throw new Error('Choose exactly one genome record by accession or complete content ID; multi-record inputs are never selected implicitly.');
  const genome = matches[0], identity = genome.phage.localGenome!;
  const mapped = genome.phage.genes.filter(gene => gene.type?.toUpperCase() === 'CDS').sort((a, b) => a.id - b.id);
  const selectedIds = requested.geneIds === null ? null : new Set(requested.geneIds);
  const chosen = selectedIds === null ? mapped : mapped.filter(gene => selectedIds.has(gene.id));
  if (requested.geneIds !== null && chosen.length !== requested.geneIds.length) throw new Error('Every selected gene ID must be a mapped CDS in the exact chosen genome.');
  if (chosen.length > GENOME_CDS_LIMITS.rows) throw new Error('CDS export exceeds 12,000 rows. Select a smaller explicit set; no CDS was silently omitted.');
  const options = { record: identity.contentId, geneIds: requested.geneIds };
  const rows: GenomeCdsResult['rows'] = [];
  let extractedBases = 0;
  for (const gene of chosen) {
    check(signal);
    const dna = extractCdsReferenceDna(gene, genome.sequence);
    extractedBases += dna.cds?.length ?? 0;
    if (extractedBases > GENOME_CDS_LIMITS.extractedBases) throw new Error('CDS export exceeds 8,000,000 extracted bases. Select fewer CDS; no partial export was produced.');
    const translated = reconstructCdsReference(gene, genome.sequence);
    const extractionReasons = dna.cds === null ? [...dna.reasons] : [];
    if (dna.cds === '') extractionReasons.push('No annotated bases remain after codon_start.');
    const translationReasons = [...new Set([...extractionReasons, ...dna.reasons, ...translated.reasons])];
    const cds = extractionReasons.length ? null : dna.cds;
    const protein = translationReasons.length ? null : translated.protein;
    const [cdsSha256, proteinSha256] = await Promise.all([sequenceHash(cds), sequenceHash(protein)]);
    check(signal);
    rows.push({ id: `cds-${identity.contentId}-${gene.id}`, geneId: gene.id,
      name: gene.name, locusTag: gene.locusTag, product: gene.product,
      segments: cds === null ? [] : dna.segments, codonStart: translated.codonStart, geneticCode: translated.geneticCode,
      ...(dna.partial5Prime ? { partial5Prime: true as const } : {}),
      ...(dna.partial3Prime ? { partial3Prime: true as const } : {}),
      cds, protein, cdsSha256, proteinSha256, extractionReasons, translationReasons });
    // Permit cancellation and UI updates between bounded chunks, even when a
    // runtime resolves WebCrypto hashes without yielding to its event loop.
    if (rows.length % 32 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); check(signal); }
  }
  const cdsAvailable = rows.filter(row => row.cds !== null).length;
  const proteinsAvailable = rows.filter(row => row.protein !== null).length;
  const result: GenomeCdsResult = {
    source: { name: genome.phage.name, accession: genome.phage.accession, contentId: identity.contentId,
      sequenceSha256: identity.sequenceSha256, genomeLength: genome.sequence.length, format: identity.format },
    rows, summary: { mappedCds: mapped.length, selectedCds: rows.length, cdsAvailable, proteinsAvailable,
      cdsUnavailable: rows.length - cdsAvailable, proteinsUnavailable: rows.length - proteinsAvailable },
    importWarnings: [...genome.warnings], limitations: [...LIMITATIONS],
  };
  check(signal);
  const record = await createAnalysisRecord({ method: GENOME_CDS_METHOD,
    inputs: [{ id: 'genome', accession: result.source.accession, source: 'local',
      description: 'Exact supplied genome source, including original annotations and unsupported features; catalog copies retain their declared provenance.', data: analysisJson(input) }],
    parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: null, references: REFERENCES,
    fields: { cds: { kind: 'sequence-score', label: 'Mapped annotated CDS DNA, conceptual proteins and explicit unavailable rows', units: 'records',
      value: analysisJson(result), coverage: { available: proteinsAvailable, total: rows.length, unit: 'genes' }, limitations: [...LIMITATIONS] } },
  });
  check(signal);
  return { input, options, result, record };
}

/** Reparse/recompute instead of trusting validly rehashed imported output. */
export async function replayGenomeCdsExperiment(content: string, signal?: AbortSignal): Promise<GenomeCdsExperiment> {
  check(signal);
  const saved = await parseAnalysisRecord(content, { methodId: GENOME_CDS_METHOD.id, methodVersion: GENOME_CDS_METHOD.version });
  check(signal);
  const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
  if (!same(saved.method, GENOME_CDS_METHOD) || !same(saved.references, REFERENCES) || saved.seed !== null
    || saved.inputs.length !== 1 || saved.inputs[0].id !== 'genome' || saved.inputs[0].source !== 'local'
    || Object.keys(saved.parameters).length !== 2 || !Object.hasOwn(saved.parameters, 'record') || !Object.hasOwn(saved.parameters, 'geneIds')
    || typeof saved.parameters.record !== 'string' || !/^[a-f0-9]{64}$/.test(saved.parameters.record)) {
    throw new Error('Genome CDS method, source or effective selection contract differs.');
  }
  const fresh = await createGenomeCdsExperiment(saved.inputs[0].data as unknown as GenomeInput, saved.parameters as GenomeCdsOptions, signal);
  if (saved.resultId !== fresh.record.resultId || saved.cacheKey !== fresh.record.cacheKey) {
    throw new Error('Recomputed genome CDS sequences, omissions or source identity differ from the saved result.');
  }
  return fresh;
}

const token = (value: string | number | null) => encodeURIComponent(value === null ? '' : String(value));
function checkedOutput(content: string): string {
  if (content.length > GENOME_CDS_LIMITS.outputBytes || new TextEncoder().encode(content).length > GENOME_CDS_LIMITS.outputBytes) {
    throw new Error('CDS export exceeds 10 MiB. Select fewer CDS; no partial export was produced.');
  }
  return content;
}
/** Export accepted results only. Replay saved JSON before calling this exporter. */
export function exportGenomeCdsFasta(experiment: GenomeCdsExperiment, molecule: 'cds' | 'protein'): string {
  if (molecule !== 'cds' && molecule !== 'protein') throw new Error('Choose CDS or protein FASTA.');
  const { result, record } = experiment, rows = result.rows.filter(row => row[molecule] !== null && row[molecule]!.length > 0);
  if (!rows.length) throw new Error(`No supported ${molecule === 'cds' ? 'CDS DNA' : 'protein'} sequences are available. Export the JSON or table report to inspect every omission.`);
  const lines: string[] = [];
  let bytes = 0;
  const append = (line: string) => {
    bytes += new TextEncoder().encode(line).length + 1;
    if (bytes > GENOME_CDS_LIMITS.outputBytes) throw new Error('CDS FASTA exceeds 10 MiB. Select fewer CDS; no partial export was produced.');
    lines.push(line);
  };
  for (const row of rows) {
    const location = row.segments.map(part => `${part.start + 1}..${part.end}(${part.strand})`).join(',');
    append(`>${row.id}|${molecule} accession=${token(result.source.accession)} gene_id=${row.geneId}`
      + ` locus_tag=${token(row.locusTag)} gene=${token(row.name)} product=${token(row.product)}`
      + ` location_1based=${token(location)} codon_start=${row.codonStart} transl_table=${row.geneticCode}`
      + (row.partial5Prime || row.partial3Prime
        ? ` partial_5prime=${!!row.partial5Prime} partial_3prime=${!!row.partial3Prime}` : '')
      + ` genome_sha256=${result.source.sequenceSha256} sequence_sha256=${molecule === 'cds' ? row.cdsSha256 : row.proteinSha256}`
      + ` exported=${rows.length} omitted=${result.rows.length - rows.length} result_id=${record.resultId}`);
    const sequence = row[molecule]!;
    for (let at = 0; at < sequence.length; at += 80) append(sequence.slice(at, at + 80));
  }
  return checkedOutput(lines.join('\n') + '\n');
}

/** All mapped rows, including unavailable DNA/proteins. JSON escaping protects
 * row/column boundaries; formula-like labels also receive a leading apostrophe.
 * The analysis record retains the exact original labels.
 */
export function exportGenomeCdsTable(experiment: GenomeCdsExperiment): string {
  const { result, record } = experiment;
  const cell = (value: unknown) => value === null ? '' : JSON.stringify(
    typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? "'" + value : value,
  );
  const lines = [
    '# Mapped annotated CDS export. Text cells are JSON strings; blank sequence lengths/hashes are unavailable, not zero.',
    '# Formula-like text labels are prefixed with an apostrophe. Exact original labels are retained in the analysis JSON.',
    '# result_id=' + record.resultId,
    '# source=' + JSON.stringify(result.source),
    '# summary=' + JSON.stringify(result.summary),
    ...result.importWarnings.map(warning => '# import_warning=' + JSON.stringify(warning)),
    ...result.limitations.map(limit => '# limitation=' + JSON.stringify(limit)),
    ['id', 'gene_id', 'locus_tag', 'gene', 'product', 'segments_0based_half_open', 'codon_start', 'transl_table',
      'cds_bases', 'protein_symbols', 'cds_sha256', 'protein_sha256', 'extraction_reasons', 'translation_reasons'].join('\t'),
    ...result.rows.map(row => [row.id, row.geneId, row.locusTag, row.name, row.product, row.segments,
      row.codonStart, row.geneticCode, row.cds?.length ?? null, row.protein?.length ?? null,
      row.cdsSha256, row.proteinSha256, row.extractionReasons, row.translationReasons].map(cell).join('\t')),
  ];
  return checkedOutput(lines.join('\n') + '\n');
}
