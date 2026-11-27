/** Source-backed protein inputs. Availability never grants host-range or docking inference. */
import type { GeneInfo, PhageFull } from './types';
import { analysisJson } from './analysis-result';
import { reconstructCdsReference } from './analysis/cds-consequences';

export interface ProteinReferenceSource {
  id: string;
  uri: string;
  version: string;
  retrievedAt: string;
  license: 'CC-BY-4.0' | 'CC0-1.0' | 'MIT';
  sha256: string;
}
export interface ReferenceProtein {
  id: string;
  accession: string;
  organism: string;
  sequence: string;
  sequenceSha256: string;
  sourceId: string;
}
export interface ProteinEmbeddingSpace {
  model: string;
  revision: string;
  weightsSha256: string;
  tokenizerSha256: string;
  configSha256: string;
  dimensions: number;
  implementation: string;
  precision: 'fp32';
  pooling: 'attention-mean-including-special-tokens-l2';
}
export interface ReferenceEmbedding {
  proteinId: string;
  /** One-based inclusive protein interval actually consumed by the model. */
  start: number;
  end: number;
  sequenceSha256: string;
  spaceSha256: string;
  vector: number[];
}
export interface ReferenceChain {
  proteinId: string;
  sourceId: string;
  pdbId: string;
  entryVersion: string;
  assemblyId: string;
  entityId: string;
  labelAsymId: string;
  authAsymId: string;
  /** Exact mapped one-based inclusive source-protein interval. */
  start: number;
  end: number;
  sequence: string;
  /** Only observed model-1 C-alpha atoms; absent residues are not interpolated. */
  coordinates: Array<{
    labelSeqId: number;
    authSeqId: number;
    insertionCode: string;
    aminoAcid: string;
    x: number;
    y: number;
    z: number;
  }>;
}
export interface ProteinReferenceBundle {
  format: 'phage-explorer-protein-reference';
  version: 1;
  id: string;
  bundleSha256: string;
  sources: ProteinReferenceSource[];
  proteins: ReferenceProtein[];
  cds: {
    genomeAccession: string;
    proteinId: string;
    proteinAccession: string;
    locusTag: string;
    startPos: number;
    endPos: number;
    strand: '+' | '-';
    codonStart: 1 | 2 | 3;
    translationTable: 1 | 11;
  };
  embeddingSpace: ProteinEmbeddingSpace;
  embeddings: ReferenceEmbedding[];
  chains: ReferenceChain[];
  alignment: {
    method: 'needleman-wunsch-linear';
    match: number;
    mismatch: number;
    gap: number;
    rows: Array<{ proteinId: string; alignedSequence: string }>;
  };
  /** Published domain/loop assignments, not inferred Pfam-pair probabilities. */
  domainInteractions: Array<{
    phageProteinId: string;
    hostProteinId: string;
    phageDomain: string;
    hostDomain: string;
    phageLoops: string[];
    hostLoops: string[];
    sourceId: string;
    sourceSection: string;
    pdbId: string;
    method: 'published-cryo-em-complex';
  }>;
  /** This records a deposited complex, not a predicted affinity or host range. */
  evidence: {
    phageProteinId: string;
    hostProteinId: string;
    sourceId: string;
    publicationDoi: string;
    experimentalHost: string;
    experimentalHostSourceId: string;
    method: 'deposited-complex';
  };
}

export interface ProteinReferenceRepository {
  getPhageById(id: number): Promise<PhageFull | null>;
  getSequenceWindow(id: number, start: number, end: number): Promise<string>;
}
export type ProteinReferenceInputs =
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; bundle: ProteinReferenceBundle; gene: GeneInfo;
      protein: ReferenceProtein; host: ReferenceProtein;
      chains: ReferenceChain[]; embeddings: ReferenceEmbedding[] };

/** A supplied alignment is useful evidence without a deposited complex. It has
 * its own contract: FASTA labels do not establish accessions, CDS mappings,
 * structures, embeddings or experimentally demonstrated interactions.
 */
export interface ProteinAlignmentInput {
  format: 'phage-explorer-protein-alignment';
  version: 1;
  name: string;
  source: { kind: 'local' | 'demo'; description: string; reference: string | null };
  rows: Array<{ id: string; description: string; alignedSequence: string }>;
}
export const PROTEIN_ALIGNMENT_LIMITS = { bytes: 2 * 1024 * 1024, rows: 256, columns: 20_000, cells: 1_000_000 } as const;
const alignmentObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function alignmentKeys(value: Record<string, unknown>, names: readonly string[], label: string): void {
  if (Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) {
    throw new Error(label + ' has missing or unsupported fields.');
  }
}
function alignmentText(value: unknown, label: string, empty = false, maximum = 512): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(label + ' must be plain text, at most ' + maximum + ' characters.');
  }
  return value;
}
export function validateProteinAlignmentInput(value: unknown): ProteinAlignmentInput {
  if (!alignmentObject(value) || value.format !== 'phage-explorer-protein-alignment' || value.version !== 1) {
    throw new Error('Unsupported protein alignment format/version.');
  }
  alignmentKeys(value, ['format', 'version', 'name', 'source', 'rows'], 'Protein alignment');
  const name = alignmentText(value.name, 'Alignment name');
  if (!alignmentObject(value.source)) throw new Error('Protein alignment source attribution is required.');
  alignmentKeys(value.source, ['kind', 'description', 'reference'], 'Alignment source');
  if (value.source.kind !== 'local' && value.source.kind !== 'demo') throw new Error('Alignment source must be local or demo.');
  const source: ProteinAlignmentInput['source'] = { kind: value.source.kind,
    description: alignmentText(value.source.description, 'Source description'),
    reference: value.source.reference === null ? null : alignmentText(value.source.reference, 'Source reference') };
  if (!Array.isArray(value.rows) || value.rows.length < 2 || value.rows.length > PROTEIN_ALIGNMENT_LIMITS.rows) {
    throw new Error('Provide 2–256 aligned protein records.');
  }
  const seen = new Set<string>(); let width = 0;
  const rows = value.rows.map((row, index): ProteinAlignmentInput['rows'][number] => {
    if (!alignmentObject(row)) throw new Error('Each protein alignment row must be an object.');
    alignmentKeys(row, ['id', 'description', 'alignedSequence'], 'Alignment row');
    const id = alignmentText(row.id, 'Protein record ID', false, 120);
    if (/\s/.test(id) || seen.has(id)) throw new Error('Protein record IDs must be unique and cannot contain whitespace.');
    seen.add(id);
    const description = alignmentText(row.description, 'Protein record description', true);
    const sequence = row.alignedSequence;
    if (typeof sequence !== 'string' || sequence.length < 1 || sequence.length > PROTEIN_ALIGNMENT_LIMITS.columns ||
        !/^[ACDEFGHIKLMNPQRSTVWYXBZJ-]+$/.test(sequence) || !/[A-Z]/.test(sequence)) {
      throw new Error('Each aligned protein requires 1–20,000 uppercase amino-acid/gap columns and at least one residue. Use canonical amino acids, X/B/Z/J for unknown residues, and - for gaps; stops and dots are unsupported.');
    }
    if (index === 0) width = sequence.length;
    if (sequence.length !== width) throw new Error('Protein FASTA rows must already be aligned to the same number of columns.');
    return { id, description, alignedSequence: sequence };
  });
  if (width * rows.length > PROTEIN_ALIGNMENT_LIMITS.cells) throw new Error('Protein alignment exceeds 1,000,000 cells.');
  for (let column = 0; column < width; column++) {
    if (rows.every(row => row.alignedSequence[column] === '-')) throw new Error('Protein alignment contains an all-gap column at ' + (column + 1) + '.');
  }
  const result: ProteinAlignmentInput = { format: 'phage-explorer-protein-alignment', version: 1, name, source, rows };
  if (new TextEncoder().encode(JSON.stringify(result)).length > PROTEIN_ALIGNMENT_LIMITS.bytes) throw new Error('Protein alignment exceeds 2 MiB.');
  return result;
}

/** Import a complete supplied alignment; never align, fill, truncate or fetch
 * sequences implicitly. The canonical rows and declared source are retained in
 * every experiment. Whitespace and letter case are formatting, not residues.
 */
export function parseProteinAlignmentFasta(content: string, name: string,
  source: ProteinAlignmentInput['source'] = { kind: 'local', description: name, reference: null }): ProteinAlignmentInput {
  if (typeof content !== 'string' || content.length > PROTEIN_ALIGNMENT_LIMITS.bytes ||
      new TextEncoder().encode(content).length > PROTEIN_ALIGNMENT_LIMITS.bytes) throw new Error('Protein alignment exceeds 2 MiB.');
  const rows: ProteinAlignmentInput['rows'] = [];
  for (const line of content.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('>')) {
      const header = line.slice(1).trim();
      const split = header.search(/\s/);
      rows.push({ id: split < 0 ? header : header.slice(0, split), description: split < 0 ? '' : header.slice(split).trim(), alignedSequence: '' });
      if (rows.length > PROTEIN_ALIGNMENT_LIMITS.rows) throw new Error('Provide at most 256 aligned protein records.');
    } else {
      if (!rows.length) throw new Error('Expected aligned protein FASTA beginning with a >record header.');
      rows[rows.length - 1].alignedSequence += line.replace(/[ \t]/g, '').toUpperCase();
      if (rows[rows.length - 1].alignedSequence.length > PROTEIN_ALIGNMENT_LIMITS.columns) throw new Error('Protein alignment exceeds 20,000 columns.');
    }
  }
  return validateProteinAlignmentInput({ format: 'phage-explorer-protein-alignment', version: 1, name, source, rows });
}

/** A local coordinate file is independent of a deposited interaction reference.
 * The supplied offset maps label_seq_id 1 to proteinStart; author residue numbers
 * are labels only. No sequence alignment, accession or assembly is inferred.
 */
export interface ProteinCoordinateInput {
  format: 'phage-explorer-protein-coordinates';
  version: 1;
  name: string;
  source: ProteinAlignmentInput['source'];
  protein: { id: string; description: string; sequence: string };
  structure: { format: 'mmcif'; content: string; labelAsymId: string; proteinStart: number;
    model: number; alternateLocation: string | null };
}
export const PROTEIN_COORDINATE_LIMITS = { bytes: 4 * 1024 * 1024, proteinBytes: 128 * 1024,
  residues: 20_000, observedResidues: 4096, columns: 128 } as const;
export interface ParsedProteinCoordinates {
  input: ProteinCoordinateInput;
  chain: Pick<ReferenceChain, 'proteinId' | 'labelAsymId' | 'authAsymId' | 'start' | 'coordinates'>;
  selection: { dataBlock: string; model: number; alternateLocation: string | null;
    minimumLabelSeqId: number; maximumLabelSeqId: number; omittedAlternateAtoms: number; zeroOccupancyAtoms: number };
}

export function validateProteinCoordinateInput(value: unknown): ProteinCoordinateInput {
  if (!alignmentObject(value) || value.format !== 'phage-explorer-protein-coordinates' || value.version !== 1) {
    throw new Error('Unsupported protein coordinate format/version.');
  }
  alignmentKeys(value, ['format', 'version', 'name', 'source', 'protein', 'structure'], 'Protein coordinate input');
  const name = alignmentText(value.name, 'Coordinate input name');
  if (!alignmentObject(value.source)) throw new Error('Coordinate source attribution is required.');
  alignmentKeys(value.source, ['kind', 'description', 'reference'], 'Coordinate source');
  if (value.source.kind !== 'local' && value.source.kind !== 'demo') throw new Error('Coordinate source must be local or demo.');
  const source: ProteinCoordinateInput['source'] = { kind: value.source.kind,
    description: alignmentText(value.source.description, 'Source description'),
    reference: value.source.reference === null ? null : alignmentText(value.source.reference, 'Source reference') };
  if (!alignmentObject(value.protein)) throw new Error('A supplied protein sequence is required.');
  alignmentKeys(value.protein, ['id', 'description', 'sequence'], 'Coordinate protein');
  const id = alignmentText(value.protein.id, 'Protein record ID', false, 120);
  if (/\s/.test(id)) throw new Error('Protein record IDs cannot contain whitespace.');
  const description = alignmentText(value.protein.description, 'Protein record description', true);
  const sequence = value.protein.sequence;
  if (typeof sequence !== 'string' || sequence.length < 1 || sequence.length > PROTEIN_COORDINATE_LIMITS.residues || !AA.test(sequence)) {
    throw new Error('Supply 1–20,000 canonical uppercase amino acids; gaps, stops and unknown residues cannot establish an exact coordinate mapping.');
  }
  if (!alignmentObject(value.structure)) throw new Error('A local mmCIF structure and explicit chain mapping are required.');
  alignmentKeys(value.structure, ['format', 'content', 'labelAsymId', 'proteinStart', 'model', 'alternateLocation'], 'Coordinate structure');
  const structure = value.structure;
  if (structure.format !== 'mmcif' || typeof structure.content !== 'string' || !structure.content.trim() ||
      structure.content.length > PROTEIN_COORDINATE_LIMITS.bytes || new TextEncoder().encode(structure.content).length > PROTEIN_COORDINATE_LIMITS.bytes) {
    throw new Error('Supply an mmCIF text file of at most 4 MiB.');
  }
  const labelAsymId = alignmentText(structure.labelAsymId, 'Label chain ID', false, 128);
  if (/\s/.test(labelAsymId) || ['.', '?'].includes(labelAsymId)) throw new Error('Choose an explicit mmCIF label_asym_id.');
  if (!integer(structure.proteinStart, 1, sequence.length)) throw new Error('The protein position corresponding to label_seq_id 1 must lie within the supplied protein.');
  if (!integer(structure.model, 1, 9999)) throw new Error('Choose a model number from 1 to 9999.');
  const alternateLocation = structure.alternateLocation === null ? null : alignmentText(structure.alternateLocation, 'Alternate location ID', false, 16);
  if (alternateLocation !== null && (/\s/.test(alternateLocation) || ['.', '?'].includes(alternateLocation))) throw new Error('An alternate location must be an explicit ID, or null for unambiguous atoms only.');
  const input: ProteinCoordinateInput = { format: 'phage-explorer-protein-coordinates', version: 1, name, source,
    protein: { id, description, sequence }, structure: { format: 'mmcif', content: structure.content, labelAsymId,
      proteinStart: structure.proteinStart, model: structure.model, alternateLocation } };
  if (new TextEncoder().encode(JSON.stringify(input)).length > PROTEIN_COORDINATE_LIMITS.bytes) throw new Error('Protein coordinate input, including sequence and escaped mmCIF text, exceeds 4 MiB.');
  return input;
}

export function prepareProteinCoordinateInput(content: string, fasta: string, name: string,
  mapping: { labelAsymId: string; proteinStart: number; model?: number; alternateLocation?: string | null },
  source: ProteinCoordinateInput['source'] = { kind: 'local', description: name, reference: null }): ProteinCoordinateInput {
  if (typeof fasta !== 'string' || fasta.length > PROTEIN_COORDINATE_LIMITS.proteinBytes ||
      new TextEncoder().encode(fasta).length > PROTEIN_COORDINATE_LIMITS.proteinBytes) throw new Error('Protein FASTA exceeds 128 KiB.');
  if (!alignmentObject(mapping) || Object.keys(mapping).some(key => !['labelAsymId', 'proteinStart', 'model', 'alternateLocation'].includes(key))) throw new Error('Unsupported protein coordinate mapping.');
  let protein: ProteinCoordinateInput['protein'] | null = null;
  for (const line of fasta.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('>')) {
      if (protein) throw new Error('Supply exactly one protein FASTA record for the selected chain.');
      const header = line.slice(1).trim(), split = header.search(/\s/);
      protein = { id: split < 0 ? header : header.slice(0, split), description: split < 0 ? '' : header.slice(split).trim(), sequence: '' };
    } else {
      if (!protein) throw new Error('Expected protein FASTA beginning with a >record header.');
      protein.sequence += line.replace(/[ \t]/g, '').toUpperCase();
      if (protein.sequence.length > PROTEIN_COORDINATE_LIMITS.residues) throw new Error('Protein sequence exceeds 20,000 residues.');
    }
  }
  return validateProteinCoordinateInput({ format: 'phage-explorer-protein-coordinates', version: 1, name, source, protein,
    structure: { format: 'mmcif', content, labelAsymId: mapping.labelAsymId, proteinStart: mapping.proteinStart,
      model: mapping.model ?? 1, alternateLocation: mapping.alternateLocation ?? null } });
}

interface CoordinateCifToken { text: string; bare: boolean }
/** Streaming CIF1 tokens support wrapped loops, quotes and semicolon text without
 * building a token array for the complete file. Category/item names are case-insensitive.
 * https://mmcif.wwpdb.org/docs/tutorials/mechanics/pdbx-mmcif-syntax.html
 */
function* coordinateCifTokens(content: string): Generator<CoordinateCifToken> {
  let i = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < content.length) {
    if (/\s/.test(content[i])) { i++; continue; }
    if (content[i] === '#') { while (i < content.length && content[i] !== '\n') i++; continue; }
    if (content[i] === ';' && (i === 0 || content[i - 1] === '\n')) {
      const start = ++i;
      while (i < content.length && !(content[i] === ';' && content[i - 1] === '\n')) i++;
      if (i === content.length) throw new Error('Unclosed mmCIF semicolon text.');
      const text = content.slice(start, i++);
      if (i < content.length && !/\s/.test(content[i]) && content[i] !== '#') throw new Error('Invalid mmCIF semicolon delimiter.');
      yield { text, bare: false }; continue;
    }
    const quote = content[i];
    if (quote === "'" || quote === '"') {
      const start = ++i;
      while (i < content.length && !(content[i] === quote && (i + 1 === content.length || /\s/.test(content[i + 1])))) {
        if (content[i] === '\n' || content[i] === '\r') throw new Error('Quoted mmCIF values cannot span lines; use semicolon text.');
        i++;
      }
      if (i === content.length) throw new Error('Unclosed quoted mmCIF value.');
      yield { text: content.slice(start, i++), bare: false }; continue;
    }
    const start = i;
    while (i < content.length && !/\s/.test(content[i])) i++;
    yield { text: content.slice(start, i), bare: true };
  }
}
const COORDINATE_AA3: Record<string, string> = { ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V' };
const cifControl = (token: CoordinateCifToken | undefined): boolean => !!token?.bare &&
  (/^_|^data_|^save_|^global_$/i.test(token.text) || /^(loop_|stop_)$/i.test(token.text));
const cifNumber = (value: string, label: string): number => {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error('Invalid finite mmCIF ' + label + '.');
  }
  return Number(value);
};

/** Only the explicit model and label chain enter geometry. Polymer indices include
 * missing coordinates; author numbers never determine sequence placement.
 * https://mmcif.wwpdb.org/docs/user-guide/resources/coordinate_section.html
 */
export function parseProteinCoordinates(value: unknown): ParsedProteinCoordinates {
  const input = validateProteinCoordinateInput(value), { structure, protein } = input;
  const iterator = coordinateCifTokens(structure.content);
  let token = iterator.next().value as CoordinateCifToken | undefined;
  const advance = () => { token = iterator.next().value as CoordinateCifToken | undefined; };
  let dataBlock = '', atomLoop = false, omittedAlternateAtoms = 0, zeroOccupancyAtoms = 0, requestedAlternateSeen = false;
  const coordinates: ReferenceChain['coordinates'] = [], positions = new Set<number>(), authors = new Set<string>(), authorPositions = new Set<string>();
  while (token) {
    const keyword = token.bare ? token.text.toLowerCase() : '';
    if (keyword.startsWith('data_')) {
      if (dataBlock || keyword.length === 5) throw new Error('Supply one named mmCIF data block; multiple structures cannot share a coordinate frame implicitly.');
      dataBlock = token.text.slice(5); advance(); continue;
    }
    if (!dataBlock) throw new Error('Expected a named mmCIF data_ block.');
    if (keyword === 'loop_') {
      advance(); const headers: string[] = [];
      while (token?.bare && token.text.startsWith('_')) {
        const header = token.text.toLowerCase();
        if (headers.includes(header) || headers.length === PROTEIN_COORDINATE_LIMITS.columns) throw new Error('Repeated or excessive mmCIF loop columns.');
        headers.push(header); advance();
      }
      if (!headers.length || headers.some(header => header.split('.')[0] !== headers[0].split('.')[0])) throw new Error('An mmCIF loop requires unique columns from one category.');
      const atoms = headers[0].startsWith('_atom_site.');
      if (atoms && atomLoop) throw new Error('Multiple atom_site loops are ambiguous.');
      const columns: Record<string, number> = {};
      if (atoms) {
        atomLoop = true;
        for (const name of ['group_pdb', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
          'label_seq_id', 'auth_asym_id', 'auth_seq_id', 'pdbx_pdb_ins_code', 'cartn_x', 'cartn_y', 'cartn_z', 'occupancy', 'pdbx_pdb_model_num']) {
          columns[name] = headers.indexOf('_atom_site.' + name);
          if (columns[name] < 0) throw new Error('Missing required mmCIF atom_site column: ' + name + '.');
        }
      }
      let row: string[] = [], rowCount = 0;
      while (token && !cifControl(token)) {
        row.push(token.text); advance();
        if (row.length !== headers.length) continue;
        const field = (name: string) => row[columns[name]];
        rowCount++;
        if (atoms && field('label_asym_id') === structure.labelAsymId && field('label_atom_id') === 'CA') {
          const model = cifNumber(field('pdbx_pdb_model_num'), 'model number');
          if (!Number.isSafeInteger(model) || model < 1) throw new Error('Invalid integer mmCIF model number.');
          if (model === structure.model) {
            const occupancy = cifNumber(field('occupancy'), 'occupancy');
            if (occupancy < 0 || occupancy > 1) throw new Error('C-alpha occupancy must lie between zero and one.');
            if (occupancy === 0) zeroOccupancyAtoms++;
            else {
              const alternate = ['.', '?'].includes(field('label_alt_id')) ? null : field('label_alt_id');
              if (alternate && structure.alternateLocation === null) throw new Error('Alternate C-alpha positions require an explicit alternate location ID.');
              if (alternate && alternate !== structure.alternateLocation) omittedAlternateAtoms++;
              else {
                if (alternate) requestedAlternateSeen = true;
                const labelSeqId = cifNumber(field('label_seq_id'), 'label sequence ID'), authSeqId = cifNumber(field('auth_seq_id'), 'author sequence ID');
                const aminoAcid = COORDINATE_AA3[field('label_comp_id')];
                const position = structure.proteinStart + labelSeqId - 1;
                if (field('group_pdb') !== 'ATOM' || field('type_symbol') !== 'C' || !aminoAcid) throw new Error('Selected C-alpha atoms must be canonical ATOM amino-acid residues; modified residues are unsupported.');
                if (!Number.isSafeInteger(labelSeqId) || labelSeqId < 1 || !Number.isSafeInteger(authSeqId) || position > protein.sequence.length ||
                    protein.sequence[position - 1] !== aminoAcid) throw new Error('The explicit label-sequence mapping does not match the supplied protein at label position ' + labelSeqId + '.');
                const authAsymId = alignmentText(field('auth_asym_id'), 'Author chain ID', false, 128);
                if (['.', '?'].includes(authAsymId)) throw new Error('An explicit author chain ID is required.');
                const insertionCode = ['.', '?'].includes(field('pdbx_pdb_ins_code')) ? '' : alignmentText(field('pdbx_pdb_ins_code'), 'Insertion code', false, 4);
                const authorKey = JSON.stringify([authSeqId, insertionCode]);
                if (positions.has(labelSeqId) || authorPositions.has(authorKey)) throw new Error('Duplicate or ambiguous C-alpha residue identity.');
                positions.add(labelSeqId); authorPositions.add(authorKey); authors.add(authAsymId);
                coordinates.push({ labelSeqId, authSeqId, insertionCode, aminoAcid,
                  x: cifNumber(field('cartn_x'), 'x coordinate'), y: cifNumber(field('cartn_y'), 'y coordinate'), z: cifNumber(field('cartn_z'), 'z coordinate') });
                if (coordinates.length > PROTEIN_COORDINATE_LIMITS.observedResidues) throw new Error('Selected chain exceeds 4,096 C-alpha residues.');
              }
            }
          }
        }
        row = [];
      }
      if (row.length || !rowCount) throw new Error('Incomplete or empty mmCIF loop.');
      continue;
    }
    if (keyword.startsWith('_')) {
      if (keyword.startsWith('_atom_site.')) throw new Error('Coordinate atoms must be supplied in an atom_site loop.');
      advance(); if (!token || cifControl(token)) throw new Error('Missing mmCIF data item value.');
      advance(); continue;
    }
    throw new Error('Unsupported mmCIF control or value outside a data item/loop.');
  }
  if (!atomLoop || !coordinates.length || authors.size !== 1) throw new Error('No uniquely identified C-alpha chain remains for the selected model, label chain and alternate location.');
  if (structure.alternateLocation !== null && !requestedAlternateSeen) throw new Error('The requested alternate location is absent from the selected chain/model.');
  coordinates.sort((a, b) => a.labelSeqId - b.labelSeqId);
  return { input, chain: { proteinId: protein.id, labelAsymId: structure.labelAsymId, authAsymId: [...authors][0], start: structure.proteinStart, coordinates },
    selection: { dataBlock, model: structure.model, alternateLocation: structure.alternateLocation,
      minimumLabelSeqId: coordinates[0].labelSeqId, maximumLabelSeqId: coordinates[coordinates.length - 1].labelSeqId,
      omittedAlternateAtoms, zeroOccupancyAtoms } };
}

const AA = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 512 * 1024;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown, low: number, high: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;

export async function proteinReferenceSha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function proteinReferenceContentHash(value: unknown): Promise<string> {
  return proteinReferenceSha256(JSON.stringify(analysisJson(value)));
}

/** Validate all retained inputs before exposing a successful partial report. Hashes are identity, not authentication. */
export async function parseProteinReferenceBundle(value: unknown): Promise<ProteinReferenceBundle> {
  const plain = analysisJson(value);
  if (new TextEncoder().encode(JSON.stringify(plain)).length > MAX_BYTES) throw new Error('Protein reference exceeds 512 KiB.');
  const bundle = plain as unknown as ProteinReferenceBundle;
  const fail = (reason: string): never => { throw new Error(`Invalid protein reference: ${reason}`); };
  try {
    if (!bundle || bundle.format !== 'phage-explorer-protein-reference' || bundle.version !== 1 ||
        !text(bundle.id) || !HASH.test(bundle.bundleSha256)) fail('format or content identity.');
    const { bundleSha256, ...payload } = bundle;
    if (await proteinReferenceContentHash(payload) !== bundleSha256) fail('bundle checksum mismatch.');
    if (!Array.isArray(bundle.sources) || bundle.sources.length < 1 || bundle.sources.length > 16 ||
        !Array.isArray(bundle.proteins) || bundle.proteins.length < 2 || bundle.proteins.length > 8) fail('source/protein count.');
    const sources = new Set<string>();
    for (const source of bundle.sources) {
      if (!text(source.id) || sources.has(source.id) || !text(source.version) ||
          !HASH.test(source.sha256) || !Number.isFinite(Date.parse(source.retrievedAt)) ||
          !['CC-BY-4.0', 'CC0-1.0', 'MIT'].includes(source.license) ||
          new URL(source.uri).protocol !== 'https:') fail('source provenance.');
      sources.add(source.id);
    }
    const proteins = new Map<string, ReferenceProtein>();
    for (const protein of bundle.proteins) {
      if (!text(protein.id) || proteins.has(protein.id) || !text(protein.accession) ||
          !text(protein.organism) || !sources.has(protein.sourceId) ||
          !AA.test(protein.sequence) || protein.sequence.length > 10_000 ||
          await proteinReferenceSha256(protein.sequence) !== protein.sequenceSha256) fail('protein identity/sequence.');
      proteins.set(protein.id, protein);
    }
    const cds = bundle.cds;
    if (!cds || !text(cds.genomeAccession) || !text(cds.proteinAccession) || !text(cds.locusTag) ||
        !proteins.has(cds.proteinId) || !integer(cds.startPos, 0, 5_000_000) ||
        !integer(cds.endPos, cds.startPos + 1, 5_000_000) || !['+', '-'].includes(cds.strand) ||
        !integer(cds.codonStart, 1, 3) || ![1, 11].includes(cds.translationTable)) fail('CDS identity/interval.');
    const space = bundle.embeddingSpace;
    if (!space || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(space.model) || !/^[a-f0-9]{40}$/.test(space.revision) ||
        !HASH.test(space.weightsSha256) || !HASH.test(space.tokenizerSha256) || !HASH.test(space.configSha256) ||
        !integer(space.dimensions, 1, 2048) || !text(space.implementation) || space.precision !== 'fp32' ||
        space.pooling !== 'attention-mean-including-special-tokens-l2' || !bundle.sources.some(source =>
          source.sha256 === space.weightsSha256 && source.version === space.revision &&
          source.uri === `https://huggingface.co/${space.model}/resolve/${space.revision}/model.safetensors`)) fail('embedding model identity.');
    const spaceHash = await proteinReferenceContentHash(space);
    const seenEmbeddings = new Set<string>();
    if (!Array.isArray(bundle.embeddings) || bundle.embeddings.length < 2 || bundle.embeddings.length > 8) fail('embedding count.');
    for (const embedding of bundle.embeddings) {
      const protein = proteins.get(embedding.proteinId);
      if (!protein || seenEmbeddings.has(embedding.proteinId) ||
          !integer(embedding.start, 1, protein.sequence.length) ||
          !integer(embedding.end, embedding.start, protein.sequence.length) ||
          await proteinReferenceSha256(protein.sequence.slice(embedding.start - 1, embedding.end)) !== embedding.sequenceSha256 ||
          embedding.spaceSha256 !== spaceHash || !Array.isArray(embedding.vector) ||
          embedding.vector.length !== space.dimensions || embedding.vector.some(x => !Number.isFinite(x)) ||
          Math.abs(Math.hypot(...embedding.vector) - 1) > 0.0001) fail('embedding coverage/model/dimensions.');
      seenEmbeddings.add(embedding.proteinId);
    }
    if (!Array.isArray(bundle.chains) || bundle.chains.length < 2 || bundle.chains.length > 8) fail('chain count.');
    const chains = new Set<string>();
    for (const chain of bundle.chains) {
      const protein = proteins.get(chain.proteinId);
      const key = `${chain.pdbId}:${chain.assemblyId}:${chain.labelAsymId}`;
      if (!protein || !sources.has(chain.sourceId) || chains.has(key) || !/^[0-9][A-Za-z0-9]{3}$/.test(chain.pdbId) ||
          !text(chain.entryVersion) || !text(chain.assemblyId) || !text(chain.entityId) ||
          !text(chain.labelAsymId) || !text(chain.authAsymId) ||
          !integer(chain.start, 1, protein.sequence.length) || !integer(chain.end, chain.start, protein.sequence.length) ||
          protein.sequence.slice(chain.start - 1, chain.end) !== chain.sequence ||
          !Array.isArray(chain.coordinates) || chain.coordinates.length === 0 || chain.coordinates.length > 4096) fail('chain identity/coverage.');
      chains.add(key);
      const positions = new Set<number>();
      for (const atom of chain.coordinates) {
        if (!integer(atom.labelSeqId, 1, chain.sequence.length) || positions.has(atom.labelSeqId) ||
            !Number.isSafeInteger(atom.authSeqId) || typeof atom.insertionCode !== 'string' || atom.insertionCode.length > 4 ||
            atom.aminoAcid !== chain.sequence[atom.labelSeqId - 1] ||
            ![atom.x, atom.y, atom.z].every(Number.isFinite)) fail('observed chain residue/coordinate.');
        positions.add(atom.labelSeqId);
      }
    }
    const alignment = bundle.alignment;
    if (!alignment || alignment.method !== 'needleman-wunsch-linear' ||
        ![alignment.match, alignment.mismatch, alignment.gap].every(Number.isFinite) ||
        alignment.match <= 0 || alignment.mismatch > 0 || alignment.gap >= 0 ||
        !Array.isArray(alignment.rows) || alignment.rows.length < 2 || alignment.rows.length > 8) fail('alignment method/rows.');
    const width = alignment.rows[0].alignedSequence.length;
    const rows = new Set<string>();
    for (const row of alignment.rows) {
      const protein = proteins.get(row.proteinId);
      if (!protein || rows.has(row.proteinId) || width > 20_000 || row.alignedSequence.length !== width ||
          !/^[ACDEFGHIKLMNPQRSTVWY-]+$/.test(row.alignedSequence) ||
          row.alignedSequence.replace(/-/g, '') !== protein.sequence) fail('alignment source/gaps/length.');
      rows.add(row.proteinId);
    }
    for (let column = 0; column < width; column++) {
      if (alignment.rows.every(row => row.alignedSequence[column] === '-')) fail('all-gap alignment column.');
    }
    const evidence = bundle.evidence;
    if (!evidence || evidence.method !== 'deposited-complex' || !sources.has(evidence.sourceId) ||
        !text(evidence.experimentalHost) || !sources.has(evidence.experimentalHostSourceId) ||
        evidence.phageProteinId !== cds.proteinId || evidence.hostProteinId === evidence.phageProteinId ||
        !proteins.has(evidence.hostProteinId) || !/^10\.\d{4,9}\/.+/.test(evidence.publicationDoi) ||
        !rows.has(cds.proteinId)) fail('deposited-complex/alignment identity.');
    for (const proteinId of [evidence.phageProteinId, evidence.hostProteinId]) {
      if (!seenEmbeddings.has(proteinId) || !bundle.chains.some(chain => chain.proteinId === proteinId)) fail('missing input for complex partner.');
    }
    if (!Array.isArray(bundle.domainInteractions) || bundle.domainInteractions.length < 1 ||
        bundle.domainInteractions.length > 8) fail('domain interaction evidence count.');
    for (const interaction of bundle.domainInteractions) {
      if (interaction.method !== 'published-cryo-em-complex' || !sources.has(interaction.sourceId) ||
          interaction.phageProteinId !== evidence.phageProteinId || interaction.hostProteinId !== evidence.hostProteinId ||
          !text(interaction.phageDomain) || !text(interaction.hostDomain) || !text(interaction.sourceSection) ||
          ![interaction.phageLoops, interaction.hostLoops].every(loops => Array.isArray(loops) &&
            loops.length > 0 && loops.length <= 16 && loops.every(text) && new Set(loops).size === loops.length) ||
          !bundle.chains.some(chain => chain.pdbId === interaction.pdbId)) fail('domain interaction source/partners.');
    }
    // Separate assemblies or coordinate frames cannot establish a common complex.
    if (new Set(bundle.chains.map(chain => `${chain.pdbId}:${chain.entryVersion}:${chain.assemblyId}:${chain.sourceId}`)).size !== 1) fail('mixed structural assemblies.');
    return bundle;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid protein reference:')) throw error;
    return fail('malformed nested input.');
  }
}

/** Offline repository seam. Private sequences are never uploaded or queried against a remote service. */
export async function loadProteinReferenceInputs(
  repository: ProteinReferenceRepository,
  phageId: number,
  value: unknown
): Promise<ProteinReferenceInputs> {
  const unavailable = (reason: string): ProteinReferenceInputs => ({ status: 'unavailable', reason });
  const phage = await repository.getPhageById(phageId);
  if (!phage) return unavailable('Selected genome is unavailable.');
  if (phage.localGenome) return unavailable('References are not automatically applied to private imported genomes.');
  let bundle: ProteinReferenceBundle;
  try { bundle = await parseProteinReferenceBundle(value); }
  catch (error) { return unavailable(error instanceof Error ? error.message : 'Invalid protein reference.'); }
  if (phage.accession !== bundle.cds.genomeAccession) return unavailable('No versioned protein reference for this genome accession.');
  const candidates = phage.genes.filter(gene => gene.type === 'CDS' &&
    gene.qualifiers?.protein_id === bundle.cds.proteinAccession);
  if (candidates.length !== 1) return unavailable('A unique deposited CDS/protein accession is required.');
  const gene = candidates[0];
  const cds = bundle.cds;
  if (!integer(phage.genomeLength, 1, 5_000_000)) return unavailable('A bounded complete genome is required.');
  if (gene.startPos !== cds.startPos || gene.endPos !== cds.endPos || gene.strand !== cds.strand ||
      Number(gene.qualifiers?.codon_start ?? 1) !== cds.codonStart ||
      Number(gene.qualifiers?.transl_table ?? 1) !== cds.translationTable ||
      gene.qualifiers?.transl_except || gene.qualifiers?.exception || gene.qualifiers?._partial || gene.qualifiers?.partial ||
      typeof gene.qualifiers?._location === 'string' && /[<>]/.test(gene.qualifiers._location)) {
    return unavailable('CDS coordinates, strand or translation semantics do not match the reference.');
  }
  const protein = bundle.proteins.find(row => row.id === cds.proteinId)!;
  const deposited = gene.qualifiers?.translation;
  if (typeof deposited !== 'string' || deposited.replace(/\s/g, '').toUpperCase() !== protein.sequence) {
    return unavailable('The complete deposited translation does not match the source protein.');
  }
  // Consume the actual genome through the same repository, not a duplicate reference DNA string.
  const genome = await repository.getSequenceWindow(phage.id, 0, phage.genomeLength ?? 0);
  if (genome.length !== phage.genomeLength) return unavailable('Actual genome sequence coverage is incomplete.');
  const reconstructed = reconstructCdsReference({ ...gene,
    qualifiers: { ...gene.qualifiers, translation: deposited.replace(/\s/g, '').toUpperCase() } }, genome.toUpperCase());
  if (reconstructed.reasons.length || reconstructed.protein?.replace(/\*$/, '') !== protein.sequence) {
    return unavailable('Actual genomic CDS translation does not match the deposited protein.');
  }
  return { status: 'ready', bundle, gene, protein,
    host: bundle.proteins.find(row => row.id === bundle.evidence.hostProteinId)!,
    chains: bundle.chains, embeddings: bundle.embeddings };
}
