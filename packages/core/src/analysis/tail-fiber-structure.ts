/**
 * tail-fiber-structure.ts
 *
 * Roadmap #3: Structural Epitope Clash Map (Tail Fiber Host Range Analyzer)
 *
 * Combines structural biophysics and sequence entropy to model phage tail fiber
 * receptor-binding domains (RBDs):
 * 1. Per-position Shannon entropy H(i) across homologs to locate conserved anchors vs hypervariable tips.
 * 2. Modular domain boundary detection (N-terminal anchor, shaft repeats, distal RBD).
 * 3. Structural stability (Delta-Delta-G alanine scanning), surface exposure (SASA), and electrostatics.
 * 4. Bacterial surface receptor clash & affinity scoring (LamB, OmpC, TonB/FhuA, BtuB, LPS).
 * 5. In-silico point mutation simulator and modular chimera swap recommendations.
 */

import type { PhageFull, GeneInfo } from '../types';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { parseProteinReferenceBundle, type ProteinReferenceBundle, type ReferenceChain } from '../protein-reference';

/** Descriptive measurements from supplied homologs and observed coordinates.
 * The illustrative model below remains a separate, explicitly opted-in method.
 */
export const PROTEIN_STRUCTURE_METHOD = { id: 'mapped-protein-reference-evidence', version: '1',
  implementation: 'TypeScript unweighted observed-column Shannon entropy and mapped model-1 C-alpha Euclidean distances' };
export const PROTEIN_STRUCTURE_LIMITS = { referenceBytes: 512 * 1024, pairChecks: 20_000_000, contacts: 20_000 } as const;
export interface ProteinStructureOptions {
  proteinId?: string;
  chainLabelAsymId?: string | null;
  contactScope?: 'chain' | 'assembly';
  contactCutoffAngstrom?: number;
  minSequenceSeparation?: number;
}
export interface ResolvedProteinStructureOptions {
  proteinId: string; chainLabelAsymId: string | null; contactScope: 'chain' | 'assembly';
  contactCutoffAngstrom: number; minSequenceSeparation: number;
}
export type ReferenceChainCoordinate = ReferenceChain['coordinates'][number];
export interface ResidueIdentity {
  proteinId: string; labelAsymId: string; authAsymId: string; proteinPosition: number;
  labelSeqId: number; authSeqId: number; insertionCode: string; aminoAcid: string;
}
export interface ProteinStructureResult {
  protein: { id: string; accession: string; length: number };
  chain: { pdbId: string; entryVersion: string; assemblyId: string; labelAsymId: string;
    authAsymId: string; start: number; end: number; observedResidues: number } | null;
  alignment: { rows: number; columns: number; targetPresent: boolean };
  residues: Array<{
    position: number; aminoAcid: string;
    alignment: { column: number; observed: number; total: number; gaps: number; entropyBits: number | null } | null;
    coordinate: ReferenceChainCoordinate | null; intrachainNeighbors: number | null;
    interchainNeighbors: number | null; comparedResidues: number | null;
    nearestNonlocalDistanceAngstrom: number | null;
  }>;
  contacts: Array<{ kind: 'intrachain' | 'interchain'; query: ResidueIdentity; partner: ResidueIdentity; distanceAngstrom: number }>;
  coverage: { proteinResidues: number; alignmentResidues: number; entropyResidues: number;
    insufficientAlignmentResidues: number; coordinateResidues: number; unmappedResidues: number;
    intrachainContacts: number; interchainContacts: number };
  limitations: string[];
}
export interface ProteinStructureExperiment {
  reference: ProteinReferenceBundle; options: ResolvedProteinStructureOptions;
  result: ProteinStructureResult; record: AnalysisRecord;
}
const PROTEIN_STRUCTURE_REFERENCE = { id: 'mapped-protein-reference-conventions', version: '1',
  description: 'One-based protein and alignment positions; label sequence IDs map through the declared chain interval. Author residue numbers and insertion codes retain source conventions. Entropy excludes gaps and requires at least two observations. Contacts include each eligible pair once within an inclusive C-alpha distance cutoff.' };
const PROTEIN_STRUCTURE_LIMITATIONS = [
  'Entropy is unweighted finite-sample diversity in the supplied alignment, in bits. Gaps are missing observations; fewer than two observed residues yields no entropy. This is not population conservation or a calibrated evolutionary constraint.',
  'Distances are Euclidean separations in Angstroms between observed model-1 C-alpha atoms. Missing residues, atoms, chains and assembly symmetry mates are not generated. Missing geometry is null, not zero.',
  'Within-chain pairs exclude positions closer than minSequenceSeparation in the source protein. Assembly scope compares the selected chain with other supplied chains in the same validated coordinate frame; no other chain pairs are evaluated.',
  'C-alpha proximity does not establish atom clashes, solvent accessibility, affinity, docking energy, mutation effects or host range. Zero retained contacts only describes these supplied coordinates and this cutoff.',
  'The reference snapshot retains source attribution and experimental context. Checksums identify content; they do not authenticate a source. This method alone does not verify the declared CDS against a selected genome.',
];
const proteinCanonical = (value: unknown): string => JSON.stringify(analysisJson(value));
const proteinObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function proteinActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Protein structure experiment cancelled.', 'AbortError');
}

/** Bound JSON before cloning or serialization: repeated long source IDs may
 * expand a small reference into a very large contact export. No complete output
 * string is allocated here; repeated string sizes are cached.
 */
function proteinJsonBudget(value: unknown, limit: number, pretty = false): void {
  let bytes = 0;
  const strings = new Map<string, number>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > limit) throw new Error('Protein structure JSON exceeds its ' + limit / 1024 + ' KiB output/input limit.');
  };
  const string = (text: string) => {
    if (text.length > limit) { add(text.length); return; }
    let size = strings.get(text);
    if (size === undefined) {
      size = new TextEncoder().encode(JSON.stringify(text)).length;
      strings.set(text, size);
    }
    add(size);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error('Protein structure JSON exceeds the nesting limit.');
    if (typeof item === 'string') { string(item); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) {
      add(JSON.stringify(item).length); return;
    }
    const array = Array.isArray(item);
    if (!array && (!proteinObject(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw new Error('Protein structure inputs require finite numbers and plain JSON values.');
    }
    const entries: unknown[] = array ? item : Object.entries(item as Record<string, unknown>).filter(([, member]) => member !== undefined);
    add(2);
    for (let index = 0; index < entries.length; index++) {
      if (index) add(1);
      if (pretty) add(1 + 2 * (depth + 1));
      if (array) visit(entries[index], depth + 1);
      else {
        const [key, member] = entries[index] as [string, unknown];
        string(key); add(pretty ? 2 : 1); visit(member, depth + 1);
      }
    }
    if (pretty && entries.length) add(1 + 2 * depth);
  };
  visit(value, 0);
}
function proteinOptionKeys(options: unknown): asserts options is ProteinStructureOptions {
  if (!proteinObject(options) || Object.keys(options).some(key => !['proteinId', 'chainLabelAsymId', 'contactScope', 'contactCutoffAngstrom', 'minSequenceSeparation'].includes(key))) {
    throw new Error('Unsupported protein structure options.');
  }
}

/** Validate the bundle first with parseProteinReferenceBundle. An omitted chain
 * never chooses an arbitrary structural copy among several mapped chains.
 */
export function resolveProteinStructureOptions(reference: ProteinReferenceBundle, options: ProteinStructureOptions = {}): ResolvedProteinStructureOptions {
  proteinOptionKeys(options);
  const proteinId = options.proteinId === undefined ? reference.cds.proteinId : options.proteinId;
  if (typeof proteinId !== 'string' || !reference.proteins.some(protein => protein.id === proteinId)) throw new Error('Choose a protein ID present in the reference snapshot.');
  const chains = reference.chains.filter(chain => chain.proteinId === proteinId);
  if (options.chainLabelAsymId === undefined && chains.length > 1) throw new Error('Several mapped chains exist; choose an explicit label chain ID or null for alignment only.');
  const chainLabelAsymId = options.chainLabelAsymId === undefined ? chains[0]?.labelAsymId ?? null : options.chainLabelAsymId;
  if (chainLabelAsymId !== null && (typeof chainLabelAsymId !== 'string' || !chains.some(chain => chain.labelAsymId === chainLabelAsymId))) throw new Error('The selected label chain ID must map to the selected source protein.');
  const contactScope = options.contactScope === undefined ? 'assembly' : options.contactScope;
  const contactCutoffAngstrom = options.contactCutoffAngstrom === undefined ? 8 : options.contactCutoffAngstrom;
  const minSequenceSeparation = options.minSequenceSeparation === undefined ? 3 : options.minSequenceSeparation;
  if (contactScope !== 'chain' && contactScope !== 'assembly') throw new Error('Choose chain or assembly contact scope.');
  if (typeof contactCutoffAngstrom !== 'number' || !Number.isFinite(contactCutoffAngstrom) || contactCutoffAngstrom <= 0 || contactCutoffAngstrom > 30) throw new Error('Contact cutoff must be greater than zero and at most 30 Angstroms.');
  if (!Number.isSafeInteger(minSequenceSeparation) || minSequenceSeparation < 1 || minSequenceSeparation > 10_000) throw new Error('Minimum sequence separation must be an integer from 1 to 10,000 residues.');
  return { proteinId, chainLabelAsymId, contactScope, contactCutoffAngstrom, minSequenceSeparation };
}

function proteinStructureResult(reference: ProteinReferenceBundle, options: ResolvedProteinStructureOptions, signal?: AbortSignal): ProteinStructureResult {
  const protein = reference.proteins.find(item => item.id === options.proteinId)!;
  const chain = options.chainLabelAsymId === null ? null : reference.chains.find(item => item.labelAsymId === options.chainLabelAsymId)!;
  const partners = chain && options.contactScope === 'assembly' ? reference.chains.filter(item => item !== chain) : [];
  const atoms = chain ? [...chain.coordinates].sort((a, b) => a.labelSeqId - b.labelSeqId) : [];
  const pairChecks = atoms.length * (atoms.length - 1) / 2 + atoms.length * partners.reduce((sum, item) => sum + item.coordinates.length, 0);
  if (pairChecks > PROTEIN_STRUCTURE_LIMITS.pairChecks) throw new Error('Protein geometry exceeds 20,000,000 pair checks. Select chain-only scope or a smaller explicit reference.');
  const residues: ProteinStructureResult['residues'] = Array.from(protein.sequence, (aminoAcid, i) => ({
    position: i + 1, aminoAcid, alignment: null, coordinate: null, intrachainNeighbors: null,
    interchainNeighbors: null, comparedResidues: null, nearestNonlocalDistanceAngstrom: null,
  }));
  const rows = reference.alignment.rows, target = rows.find(row => row.proteinId === protein.id);
  if (target) {
    let position = 0;
    for (let column = 0; column < target.alignedSequence.length; column++) {
      if (column % 256 === 0) proteinActive(signal);
      if (target.alignedSequence[column] === '-') continue;
      const counts = new Map<string, number>();
      let observed = 0;
      for (const row of rows) {
        const aa = row.alignedSequence[column];
        if (aa !== '-') { counts.set(aa, (counts.get(aa) ?? 0) + 1); observed++; }
      }
      let entropyBits: number | null = null;
      if (observed >= 2) {
        entropyBits = 0;
        for (const count of counts.values()) { const p = count / observed; entropyBits -= p * Math.log2(p); }
      }
      residues[position++].alignment = { column: column + 1, observed, total: rows.length, gaps: rows.length - observed, entropyBits };
    }
  }
  const identity = (source: ReferenceChain, atom: ReferenceChainCoordinate): ResidueIdentity => ({
    proteinId: source.proteinId, labelAsymId: source.labelAsymId, authAsymId: source.authAsymId,
    proteinPosition: source.start + atom.labelSeqId - 1, labelSeqId: atom.labelSeqId,
    authSeqId: atom.authSeqId, insertionCode: atom.insertionCode, aminoAcid: atom.aminoAcid,
  });
  const contacts: ProteinStructureResult['contacts'] = [];
  let checks = 0, intrachainContacts = 0, interchainContacts = 0;
  if (chain) {
    for (const atom of atoms) Object.assign(residues[chain.start + atom.labelSeqId - 2], {
      coordinate: { ...atom }, intrachainNeighbors: 0, interchainNeighbors: options.contactScope === 'assembly' ? 0 : null, comparedResidues: 0,
    });
    const compare = (a: ReferenceChainCoordinate, b: ReferenceChainCoordinate, other: ReferenceChain, kind: 'intrachain' | 'interchain') => {
      if (checks++ % 2048 === 0) proteinActive(signal);
      const distanceAngstrom = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (!Number.isFinite(distanceAngstrom)) throw new Error('The supplied coordinates produce a nonfinite C-alpha distance.');
      const left = residues[chain.start + a.labelSeqId - 2];
      const update = (residue: typeof left) => {
        residue.comparedResidues!++;
        residue.nearestNonlocalDistanceAngstrom = residue.nearestNonlocalDistanceAngstrom === null ? distanceAngstrom : Math.min(residue.nearestNonlocalDistanceAngstrom, distanceAngstrom);
      };
      update(left);
      const right = kind === 'intrachain' ? residues[chain.start + b.labelSeqId - 2] : null;
      if (right) update(right);
      if (distanceAngstrom > options.contactCutoffAngstrom) return;
      if (contacts.length === PROTEIN_STRUCTURE_LIMITS.contacts) throw new Error('Protein geometry exceeds 20,000 contacts. Reduce the cutoff or supplied coordinate panel; results are never truncated.');
      contacts.push({ kind, query: identity(chain, a), partner: identity(other, b), distanceAngstrom });
      if (right) { left.intrachainNeighbors!++; right.intrachainNeighbors!++; intrachainContacts++; }
      else { left.interchainNeighbors!++; interchainContacts++; }
    };
    for (let i = 0; i < atoms.length; i++) {
      proteinActive(signal);
      for (let j = i + 1; j < atoms.length; j++) if (atoms[j].labelSeqId - atoms[i].labelSeqId >= options.minSequenceSeparation) compare(atoms[i], atoms[j], chain, 'intrachain');
      for (const partner of partners) for (const atom of partner.coordinates) compare(atoms[i], atom, partner, 'interchain');
    }
  }
  const alignmentResidues = residues.filter(residue => residue.alignment !== null).length;
  const entropyResidues = residues.filter(residue => residue.alignment !== null && residue.alignment.entropyBits !== null).length;
  const result: ProteinStructureResult = { protein: { id: protein.id, accession: protein.accession, length: protein.sequence.length },
    chain: chain ? { pdbId: chain.pdbId, entryVersion: chain.entryVersion, assemblyId: chain.assemblyId,
      labelAsymId: chain.labelAsymId, authAsymId: chain.authAsymId, start: chain.start, end: chain.end, observedResidues: atoms.length } : null,
    alignment: { rows: rows.length, columns: rows[0].alignedSequence.length, targetPresent: !!target }, residues, contacts,
    coverage: { proteinResidues: residues.length, alignmentResidues, entropyResidues, insufficientAlignmentResidues: alignmentResidues - entropyResidues,
      coordinateResidues: atoms.length, unmappedResidues: residues.length - atoms.length, intrachainContacts, interchainContacts },
    limitations: [...PROTEIN_STRUCTURE_LIMITATIONS],
  };
  if (!chain) result.limitations.push('No chain was selected for this protein; all geometry is unavailable.');
  if (!target) result.limitations.push('The selected protein is absent from the supplied alignment; all alignment metrics are unavailable.');
  if (options.contactScope === 'chain') result.limitations.push('Only within-chain geometry was requested. Interchain neighbors are unavailable; an aggregate contact count of zero does not mean other chains were compared.');
  return result;
}

export async function createProteinStructureExperiment(input: unknown, config: ProteinStructureOptions = {}, signal?: AbortSignal): Promise<ProteinStructureExperiment> {
  proteinActive(signal);
  proteinJsonBudget(input, PROTEIN_STRUCTURE_LIMITS.referenceBytes);
  // Validate raw keys before analysisJson can omit undefined unknown properties.
  // Snapshot options before asynchronous reference checksum validation.
  proteinOptionKeys(config);
  const suppliedOptions = analysisJson(config) as unknown as ProteinStructureOptions;
  const reference = await parseProteinReferenceBundle(input);
  proteinActive(signal);
  const options = resolveProteinStructureOptions(reference, suppliedOptions);
  const result = proteinStructureResult(reference, options, signal);
  const recordOptions = { method: PROTEIN_STRUCTURE_METHOD,
    inputs: [{ id: 'reference', accession: result.protein.accession, source: 'external' as const,
      description: 'Exact versioned protein reference snapshot with complete source proteins, homolog alignment, observed C-alpha coordinates, mappings and source attribution. No selected genome verification is implied.', data: reference }],
    parameters: { ...options }, seed: null, references: [PROTEIN_STRUCTURE_REFERENCE], fields: {
      structure: { kind: 'sequence-score' as const, label: 'Mapped alignment diversity and observed C-alpha geometry', units: 'records' as const,
        value: result, limitations: [...result.limitations],
        coverage: { available: result.residues.filter(residue => residue.coordinate !== null || residue.alignment !== null && residue.alignment.entropyBits !== null).length,
          total: result.residues.length, unit: 'residues' as const } },
    },
  };
  // Match the portable serializer's pretty-print size, including its hashes.
  proteinJsonBudget({ ...recordOptions, format: 'phage-explorer-analysis', version: 1, cacheKey: '0'.repeat(64), resultId: '0'.repeat(64),
    inputs: recordOptions.inputs.map(item => ({ ...item, sha256: '0'.repeat(64) })) }, 10 * 1024 * 1024, true);
  const record = await createAnalysisRecord({ ...recordOptions,
    inputs: recordOptions.inputs.map(item => ({ ...item, data: analysisJson(item.data) })),
    fields: { structure: { ...recordOptions.fields.structure, value: analysisJson(result) } } });
  proteinActive(signal);
  return { reference, options, result, record };
}

/** Checksums alone cannot validate geometry: recompute every field and compare
 * the complete evidence contract, parameters and source identity.
 */
export async function replayProteinStructureExperiment(content: string, signal?: AbortSignal): Promise<ProteinStructureExperiment> {
  proteinActive(signal);
  const saved = await parseAnalysisRecord(content, { methodId: PROTEIN_STRUCTURE_METHOD.id, methodVersion: PROTEIN_STRUCTURE_METHOD.version });
  proteinActive(signal);
  if (proteinCanonical(saved.method) !== proteinCanonical(PROTEIN_STRUCTURE_METHOD) || proteinCanonical(saved.references) !== proteinCanonical([PROTEIN_STRUCTURE_REFERENCE]) ||
    saved.seed !== null || saved.inputs.length !== 1 || saved.inputs[0].id !== 'reference') throw new Error('Protein structure method, references, seed or exact input contract differs.');
  const fresh = await createProteinStructureExperiment(saved.inputs[0].data, saved.parameters, signal);
  if (proteinCanonical(fresh.options) !== proteinCanonical(saved.parameters)) throw new Error('All effective protein structure settings must be explicit.');
  if (fresh.record.cacheKey !== saved.cacheKey || fresh.record.resultId !== saved.resultId) throw new Error('Fresh protein structure calculation or source evidence differs from the saved experiment.');
  return fresh;
}

/** For results from the producer or successful replay. This is not an
 * alternative to verifying an imported experiment.
 */
export function proteinStructureResultFromRecord(record: AnalysisRecord): ProteinStructureResult {
  const value = record.fields.structure?.value;
  if (proteinCanonical(record.method) !== proteinCanonical(PROTEIN_STRUCTURE_METHOD) || !proteinObject(value) ||
    !proteinObject(value.protein) || !proteinObject(value.alignment) || !proteinObject(value.coverage) ||
    !Array.isArray(value.residues) || !Array.isArray(value.contacts) || !Array.isArray(value.limitations)) throw new Error('Expected a produced or replayed protein structure result.');
  return structuredClone(value) as unknown as ProteinStructureResult;
}
function proteinTsvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+@-]/.test(value) ? "'" + value : value;
  return /[\t\r\n"]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
export function exportProteinStructureTsv(record: AnalysisRecord, section: 'residues' | 'contacts' = 'residues'): string {
  proteinJsonBudget(record, 10 * 1024 * 1024, true);
  const result = proteinStructureResultFromRecord(record);
  const reference = record.inputs[0]?.data as unknown as ProteinReferenceBundle;
  if (record.inputs.length !== 1 || record.inputs[0].id !== 'reference' || reference?.format !== 'phage-explorer-protein-reference') throw new Error('Protein structure export requires the exact reference snapshot.');
  const comments = ['# method=' + record.method.id + '; version=' + record.method.version + '; result=' + record.resultId + '; inputSha256=' + record.inputs[0].sha256,
    '# protein=' + proteinCanonical(result.protein) + '; chain=' + proteinCanonical(result.chain) + '; options=' + proteinCanonical(record.parameters),
    '# source_attribution=' + proteinCanonical(reference.sources),
    '# Protein, alignment-column and label-sequence positions are one-based. Author residue numbers and insertion codes retain the deposited convention, including negative numbers.',
    '# Distances are observed C-alpha separations in Angstroms; entropy is unweighted observed-column diversity in bits, requiring two non-gap observations. Empty cells are unavailable, not zero.',
    '# Supplied-chain proximity is not atom clashes, SASA, affinity, docking energy, mutation effects or host range. No missing coordinates or assembly copies are inferred.',
    '# limitations=' + proteinCanonical(result.limitations)];
  let header: string[], rows: Array<Array<string | number | null>>;
  if (section === 'residues') {
    header = ['protein_position_1based', 'amino_acid', 'alignment_column_1based', 'observed_rows', 'total_rows', 'gaps', 'entropy_bits',
      'label_seq_id', 'auth_seq_id', 'insertion_code', 'x_angstrom', 'y_angstrom', 'z_angstrom', 'intrachain_neighbors', 'interchain_neighbors', 'compared_residues', 'nearest_nonlocal_distance_angstrom'];
    rows = result.residues.map(residue => [residue.position, residue.aminoAcid, residue.alignment?.column ?? null,
      residue.alignment?.observed ?? null, residue.alignment?.total ?? null, residue.alignment?.gaps ?? null, residue.alignment?.entropyBits ?? null,
      residue.coordinate?.labelSeqId ?? null, residue.coordinate?.authSeqId ?? null, residue.coordinate?.insertionCode ?? null,
      residue.coordinate?.x ?? null, residue.coordinate?.y ?? null, residue.coordinate?.z ?? null, residue.intrachainNeighbors,
      residue.interchainNeighbors, residue.comparedResidues, residue.nearestNonlocalDistanceAngstrom]);
  } else if (section === 'contacts') {
    header = ['kind', 'query_protein', 'query_label_chain', 'query_author_chain', 'query_protein_position_1based', 'query_label_seq_id', 'query_auth_seq_id', 'query_insertion_code', 'query_amino_acid',
      'partner_protein', 'partner_label_chain', 'partner_author_chain', 'partner_protein_position_1based', 'partner_label_seq_id', 'partner_auth_seq_id', 'partner_insertion_code', 'partner_amino_acid', 'distance_angstrom'];
    const cells = (identity: ResidueIdentity) => [identity.proteinId, identity.labelAsymId, identity.authAsymId, identity.proteinPosition, identity.labelSeqId, identity.authSeqId, identity.insertionCode, identity.aminoAcid];
    rows = result.contacts.map(contact => [contact.kind, ...cells(contact.query), ...cells(contact.partner), contact.distanceAngstrom]);
  } else throw new Error('Choose residues or contacts for protein structure TSV export.');
  return [...comments, header.join('\t'), ...rows.map(row => row.map(proteinTsvCell).join('\t'))].join('\n') + '\n';
}

export type TailFiberDomainType = 'n_anchor' | 'shaft' | 'distal_rbd';

export interface FiberDomain {
  type: TailFiberDomainType;
  name: string;
  startResidue: number; // 1-indexed
  endResidue: number;   // 1-indexed
  length: number;
  meanEntropy: number;
  meanSasa: number;
  meanDdg: number;
  structuralClass: string;
  description: string;
}

export interface ResidueEpitopeMetric {
  position: number; // 1-indexed amino acid
  aminoAcid: string;
  entropy: number; // Shannon entropy H(i) in bits [0 .. 4.32]
  sasa: number; // Solvent accessible surface area [0 .. 100%]
  ddgAlaScan: number; // kcal/mol (>2.0 structurally critical/intolerant, 0..1.5 tolerant, <0 destabilizing WT)
  charge: number; // Formal charge at pH 7.4 (-1, 0, +1)
  hydropathy: number; // Kyte-Doolittle scale (-4.5 .. +4.5)
  domain: TailFiberDomainType;
  isHypervariableEpitope: boolean; // Hotspot for diversifying selection (arms race)
  isEssentialAnchor: boolean; // Structurally constrained residue
  clashRisk: 'low' | 'moderate' | 'high' | 'critical';
}

export interface BacterialReceptorTarget {
  id: string;
  name: string;
  category: 'porin' | 'transporter' | 'polysaccharide' | 'appendage';
  chargeProfile: 'predominantly_negative' | 'zwitterionic' | 'amphipathic_polar' | 'hydrophobic_groove';
  primaryHost: string;
  keyResiduesOrEpitopes: string[];
  stericTolerance: number; // 0..1 scale
}

export interface ReceptorBindingScore {
  receptorId: string;
  receptorName: string;
  category: string;
  affinityScore: number; // 0..100
  electrostaticFit: number; // -1..+1
  stericClashScore: number; // 0 (no clash) .. 100 (severe collision)
  compatibilityRank: number;
  interactionEvidence: string[];
}

export interface MutationSimulationResult {
  position: number;
  wildType: string;
  mutant: string;
  ddgDelta: number; // Stability shift (kcal/mol)
  clashPenalty: number; // 0..100
  affinityDeltas: Record<string, number>; // receptorId -> delta %
  predictedHostImpact: string;
}

export interface ChimeraEngineeringSuggestion {
  donorPhage: string;
  donorProtein: string;
  junctionResidue: number;
  rbdRange: [number, number];
  targetReceptor: string;
  predictedHost: string;
  feasibilityScore: number; // 0..100
  rationale: string;
}

export interface TailFiberStructuralAnalysis {
  /** This model has no measured structure, homolog alignment or calibrated affinity. */
  source: 'demonstration';
  assumptions: string;
  phageId: number;
  phageName: string;
  geneId: number;
  geneName: string;
  locusTag: string;
  product: string;
  sequenceLength: number;
  domains: FiberDomain[];
  residues: ResidueEpitopeMetric[];
  meanEntropy: number;
  hypervariableHotspots: number[];
  receptorScores: ReceptorBindingScore[];
  predictedHosts: {
    hostName: string;
    confidence: number;
    primaryReceptors: string[];
  }[];
  chimeraSuggestions: ChimeraEngineeringSuggestion[];
  summary: string;
}

/** Descriptors calculated directly from an explicitly supplied protein sequence. */
export interface TailFiberSequenceAnalysis {
  phageId: number;
  geneId: number;
  geneName: string;
  sequence: string;
  residues: Array<{ position: number; aminoAcid: string; hydropathy: number | null }>;
  meanHydropathy: number | null;
  method: string;
}

export function analyzeTailFiberSequence(
  phage: PhageFull,
  gene: GeneInfo | null | undefined,
  sequence: string | null | undefined
): TailFiberSequenceAnalysis | null {
  if (!gene || !sequence) return null;
  const protein = sequence.toUpperCase().replace(/\*$/, '');
  if (!protein || !/^[ACDEFGHIKLMNPQRSTVWYXBZJUO]+$/.test(protein)) return null;
  const residues = Array.from(protein, (aminoAcid, index) => ({
    position: index + 1,
    aminoAcid,
    hydropathy: KYTE_DOOLITTLE[aminoAcid] ?? null,
  }));
  // Unknown residues are missing observations, not neutral hydropathy.
  const known = residues.filter((r): r is typeof r & { hydropathy: number } => r.hydropathy !== null);
  return {
    phageId: phage.id,
    geneId: gene.id,
    geneName: gene.name ?? gene.locusTag ?? `gene_${gene.id}`,
    sequence: protein,
    residues,
    meanHydropathy: known.length === residues.length
      ? known.reduce((sum, r) => sum + r.hydropathy, 0) / known.length : null,
    method: 'Kyte–Doolittle residue hydropathy from the supplied protein sequence; no structural or host-range inference.',
  };
}

// Kyte-Doolittle hydropathy scale
export const KYTE_DOOLITTLE: Record<string, number> = {
  I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8,
  G: -0.4, T: -0.7, S: -0.8, W: -0.9, Y: -1.3, P: -1.6,
  H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5,
};

// Formal charge at physiological pH (7.4)
export const RESIDUE_CHARGES: Record<string, number> = {
  R: 1.0, K: 1.0, H: 0.1,
  D: -1.0, E: -1.0,
  A: 0, C: 0, F: 0, G: 0, I: 0, L: 0, M: 0, N: 0, P: 0, Q: 0, S: 0, T: 0, V: 0, W: 0, Y: 0,
};

// Baseline alanine-scanning Delta-Delta-G free energy perturbation (kcal/mol)
export const ALANINE_SCAN_BASELINE_DDG: Record<string, number> = {
  W: 4.2, F: 3.8, Y: 3.2, L: 3.5, I: 3.4, V: 2.8, M: 2.6,
  R: 3.0, K: 2.2, H: 1.8, D: 2.0, E: 1.9, Q: 1.5, N: 1.4,
  P: 3.5, C: 2.5, T: 1.2, S: 0.9, G: 0.0, A: 0.0,
};

// Canonical bacterial surface receptors
export const BACTERIAL_SURFACE_RECEPTORS: BacterialReceptorTarget[] = [
  {
    id: 'lamb',
    name: 'LamB (maltoporin)',
    category: 'porin',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Loop L6', 'Loop L9', 'Aromatic vestibule (Y118, W358)'],
    stericTolerance: 0.65,
  },
  {
    id: 'ompc',
    name: 'OmpC (outer membrane porin C)',
    category: 'porin',
    chargeProfile: 'predominantly_negative',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Extracellular loop L4', 'Loop L5', 'Acidic pocket (D192, E201)'],
    stericTolerance: 0.55,
  },
  {
    id: 'tonb_fhua',
    name: 'FhuA / TonB-dependent receptor',
    category: 'transporter',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Gating loop 4', 'Cork domain apex', 'Ferric-hydroxamate groove'],
    stericTolerance: 0.50,
  },
  {
    id: 'btub',
    name: 'BtuB (vitamin B12 transporter)',
    category: 'transporter',
    chargeProfile: 'amphipathic_polar',
    primaryHost: 'Escherichia coli',
    keyResiduesOrEpitopes: ['Extracellular loops 2 & 3', 'Cobalamin vestibule'],
    stericTolerance: 0.60,
  },
  {
    id: 'lps_core',
    name: 'LPS Core / O-Antigen',
    category: 'polysaccharide',
    chargeProfile: 'predominantly_negative',
    primaryHost: 'Salmonella / E. coli / Pseudomonas',
    keyResiduesOrEpitopes: ['Heptose phosphate core', 'O-antigen repeat units', 'KDO sugar'],
    stericTolerance: 0.85,
  },
  {
    id: 'type_iv_pilus',
    name: 'Type IV Pilus (PilA)',
    category: 'appendage',
    chargeProfile: 'hydrophobic_groove',
    primaryHost: 'Pseudomonas aeruginosa',
    keyResiduesOrEpitopes: ['PilA helical groove', 'C-terminal receptor loop'],
    stericTolerance: 0.45,
  },
];

/**
 * Identify whether a gene represents a tail fiber or receptor-binding protein
 */
export function isTailFiberCandidate(gene: GeneInfo): boolean {
  const combined = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
  if (/\b(tail\s*fiber|tail\s*fibre|tailspike|tail\s*spike|receptor[- ]binding|rbp|gp37|gp38|gp12|gpj|fibritin|baseplate\s*wedge)\b/i.test(combined)) {
    return true;
  }
  if (gene.domains) {
    const pfam = gene.domains.join(' ');
    if (/PF03906|PF06605|PF07484|PF09404|PF10531|PF13885/i.test(pfam)) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate per-position Shannon entropy H(i) = -Sum p(a) * log2(p(a))
 */
export function calculatePositionEntropy(column: string[]): number {
  const validChars = column.filter((c) => c !== '-' && c !== 'X' && c !== '*' && c !== ' ' && c !== '');
  if (validChars.length <= 1) return 0.0;

  const counts: Record<string, number> = {};
  for (const c of validChars) {
    counts[c] = (counts[c] ?? 0) + 1;
  }

  let entropy = 0.0;
  const total = validChars.length;
  for (const count of Object.values(counts)) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return Math.round(entropy * 1000) / 1000;
}

/**
 * Generate empirical/simulated homolog alignment columns for target fiber sequence
 * anchored by tail fiber structural domain rules (conserved N-terminal anchor,
 * repetitive shaft, hypervariable distal tip).
 */
export function generateFiberHomologColumns(sequence: string): string[][] {
  const n = sequence.length;
  const columns: string[][] = [];

  for (let i = 0; i < n; i++) {
    const wt = sequence[i].toUpperCase();
    const relPos = (i + 1) / Math.max(1, n);

    // Structural constraint model:
    // N-anchor (relPos < 0.25): highly conserved (low variability)
    // Shaft (0.25 <= relPos < 0.65): moderate variability, coiled-coil periodicity
    // Distal RBD (relPos >= 0.65): high diversification rate under immune / host receptor arms race
    let mutationProb = 0.05;
    if (relPos >= 0.65) {
      mutationProb = 0.55 + 0.35 * Math.sin(i * 0.7); // High entropy peaks in loops
    } else if (relPos >= 0.25) {
      mutationProb = 0.20 + 0.15 * (i % 7 === 0 || i % 7 === 3 ? 0.05 : 0.30); // heptad repeat pattern
    }

    const col: string[] = [wt];
    const candidateAAs = ['A', 'S', 'T', 'N', 'D', 'E', 'K', 'R', 'Q', 'V', 'L', 'I', 'F', 'Y'];

    // Sample 12 homologous sequences
    for (let s = 0; s < 12; s++) {
      const rand = ((i * 37 + s * 19 + wt.charCodeAt(0)) % 100) / 100;
      if (rand < mutationProb) {
        const altIdx = (i * 7 + s * 13 + rand * 100) % candidateAAs.length;
        col.push(candidateAAs[Math.floor(altIdx)]);
      } else {
        col.push(wt);
      }
    }
    columns.push(col);
  }

  return columns;
}

/**
 * Smooth an array using a moving average window
 */
function smoothArray(arr: number[], windowSize: number): number[] {
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j];
      count++;
    }
    result.push(sum / count);
  }
  return result;
}

/**
 * Detect domain boundaries: N-terminal anchor, shaft, distal RBD
 */
export function detectFiberDomainBoundaries(
  sequenceLength: number,
  smoothedEntropy: number[],
  _hydropathy: number[]
): FiberDomain[] {
  const len = Math.max(sequenceLength, smoothedEntropy.length);
  if (len < 15) {
    return [
      {
        type: 'distal_rbd',
        name: 'Receptor-Binding Domain',
        startResidue: 1,
        endResidue: len,
        length: len,
        meanEntropy: 1.5,
        meanSasa: 50,
        meanDdg: 1.5,
        structuralClass: 'Globular / Beta-sheet',
        description: 'Short peptide tail fiber fragment',
      },
    ];
  }

  // Anchor boundary: typically 15-28% of sequence where entropy stays low
  let anchorEnd = Math.floor(len * 0.22);
  // Find local gradient peak near 15%-30%
  let maxGrad = 0;
  for (let i = Math.floor(len * 0.15); i < Math.floor(len * 0.32); i++) {
    const grad = Math.abs(smoothedEntropy[i] - smoothedEntropy[Math.max(0, i - 10)]);
    if (grad > maxGrad) {
      maxGrad = grad;
      anchorEnd = i;
    }
  }

  // Shaft boundary: typically 55-75% of sequence where entropy transitions to high hypervariable peak
  let shaftEnd = Math.floor(len * 0.65);
  maxGrad = 0;
  for (let i = Math.floor(len * 0.55); i < Math.floor(len * 0.78); i++) {
    const grad = smoothedEntropy[i] - (smoothedEntropy[Math.max(0, i - 15)] ?? 0);
    if (grad > maxGrad) {
      maxGrad = grad;
      shaftEnd = i;
    }
  }

  if (anchorEnd < 5) anchorEnd = Math.max(5, Math.floor(len * 0.2));
  if (shaftEnd <= anchorEnd + 10) shaftEnd = anchorEnd + Math.max(10, Math.floor((len - anchorEnd) / 2));
  if (shaftEnd >= len - 5) shaftEnd = Math.max(anchorEnd + 5, len - 10);

  const anchorSlice = smoothedEntropy.slice(0, anchorEnd);
  const shaftSlice = smoothedEntropy.slice(anchorEnd, shaftEnd);
  const rbdSlice = smoothedEntropy.slice(shaftEnd, len);

  const mean = (a: number[]) => (a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0);

  return [
    {
      type: 'n_anchor',
      name: 'N-Terminal Anchor',
      startResidue: 1,
      endResidue: anchorEnd,
      length: anchorEnd,
      meanEntropy: Math.round(mean(anchorSlice) * 100) / 100,
      meanSasa: 22.4,
      meanDdg: 3.4,
      structuralClass: 'Conserved Baseplate / Collar Wedge',
      description: 'Attaches tail fiber securely to the virion baseplate complex; strictly conserved against mutations.',
    },
    {
      type: 'shaft',
      name: 'Central Shaft & Fibritin Repeats',
      startResidue: anchorEnd + 1,
      endResidue: shaftEnd,
      length: shaftEnd - anchorEnd,
      meanEntropy: Math.round(mean(shaftSlice) * 100) / 100,
      meanSasa: 41.5,
      meanDdg: 2.1,
      structuralClass: 'Fibrous Coiled-Coil / Heptad Repeats',
      description: 'Extended rigid mechanical arm projecting the receptor-binding domain away from the capsid shell.',
    },
    {
      type: 'distal_rbd',
      name: 'Distal Receptor-Binding Domain (RBD)',
      startResidue: shaftEnd + 1,
      endResidue: len,
      length: len - shaftEnd,
      meanEntropy: Math.round(mean(rbdSlice) * 100) / 100,
      meanSasa: 68.2,
      meanDdg: 1.2,
      structuralClass: 'Beta-Sandwich / Hypervariable Loops',
      description: 'The molecular key conferring bacterial host specificity; subject to intense diversifying selection.',
    },
  ];
}

/**
 * Calculate per-residue biophysical and structural metrics
 */
export function calculateResidueEpitopeMetrics(
  sequence: string,
  domains: FiberDomain[],
  entropies: number[]
): ResidueEpitopeMetric[] {
  const residues: ResidueEpitopeMetric[] = [];
  const n = sequence.length;

  for (let i = 0; i < n; i++) {
    const pos = i + 1;
    const aa = sequence[i].toUpperCase();
    const entropy = entropies[i] ?? 0;
    const kd = KYTE_DOOLITTLE[aa] ?? 0;
    const charge = RESIDUE_CHARGES[aa] ?? 0;
    const baseDdg = ALANINE_SCAN_BASELINE_DDG[aa] ?? 1.5;

    // Determine domain
    let domainType: TailFiberDomainType = 'shaft';
    for (const d of domains) {
      if (pos >= d.startResidue && pos <= d.endResidue) {
        domainType = d.type;
        break;
      }
    }

    // Surface exposure (SASA) proxy: hydrophilic residues and RBD loop positions have higher SASA
    let sasa = Math.max(5, Math.min(95, 50 - kd * 8 + (domainType === 'distal_rbd' ? 25 : domainType === 'n_anchor' ? -20 : 0)));
    // Modulation with entropy (flexible variable regions are typically surface loops)
    sasa = Math.round(Math.max(5, Math.min(98, sasa + entropy * 8)));

    // Structural stability (Delta-Delta-G Ala scan)
    // Buried core residues have high Delta-Delta-G; surface residues have lower Delta-Delta-G
    let ddg = baseDdg * (1 - sasa / 120);
    if (domainType === 'n_anchor') ddg += 1.0;
    if (aa === 'P' || aa === 'G') {
      // Proline / Glycine in structured regions have high conformational penalty
      ddg = Math.max(ddg, 2.5);
    }
    ddg = Math.round(ddg * 10) / 10;

    const isHypervariableEpitope = domainType === 'distal_rbd' && entropy > 2.2 && sasa > 50;
    const isEssentialAnchor = domainType === 'n_anchor' && entropy < 1.0 && ddg > 2.5;

    let clashRisk: ResidueEpitopeMetric['clashRisk'] = 'low';
    if (ddg > 3.0) {
      clashRisk = 'critical'; // Intolerant core packing
    } else if (ddg > 2.0) {
      clashRisk = 'high';
    } else if (sasa < 25) {
      clashRisk = 'moderate';
    }

    residues.push({
      position: pos,
      aminoAcid: aa,
      entropy,
      sasa,
      ddgAlaScan: ddg,
      charge,
      hydropathy: kd,
      domain: domainType,
      isHypervariableEpitope,
      isEssentialAnchor,
      clashRisk,
    });
  }

  return residues;
}

/**
 * Score structural compatibility against canonical bacterial surface receptors
 */
export function scoreReceptorBinding(
  residues: ResidueEpitopeMetric[],
  _domains: FiberDomain[]
): ReceptorBindingScore[] {
  const rbdResidues = residues.filter((r) => r.domain === 'distal_rbd');
  const rbdRes = rbdResidues.length > 0 ? rbdResidues : residues;

  // Compute RBD electrostatic sum & hydrophobic ratio
  let netRbdCharge = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let aromaticCount = 0;
  let hydrophobicCount = 0;

  for (const r of rbdRes) {
    netRbdCharge += r.charge;
    if (r.charge > 0) positiveCount++;
    if (r.charge < 0) negativeCount++;
    if (['F', 'W', 'Y'].includes(r.aminoAcid)) aromaticCount++;
    if (r.hydropathy > 1.0) hydrophobicCount++;
  }

  const scores: ReceptorBindingScore[] = [];

  for (const receptor of BACTERIAL_SURFACE_RECEPTORS) {
    let affinity = 50;
    let electrostaticFit = 0.0;
    let stericClash = 20;
    const evidence: string[] = [];

    switch (receptor.id) {
      case 'lamb': {
        // LamB favors aromatic loops (Trp, Tyr) fitting into the maltoporin greasy slide
        const aromaticDensity = aromaticCount / Math.max(1, rbdRes.length);
        if (aromaticDensity > 0.07) {
          affinity += 30;
          evidence.push(`Enriched aromatic residues (${aromaticCount} Y/W/F) compatible with maltoporin vestibule`);
        } else {
          affinity -= 10;
        }
        electrostaticFit = Math.min(1.0, Math.max(-1.0, 0.4 + netRbdCharge * 0.05));
        stericClash = 15;
        break;
      }
      case 'ompc': {
        // OmpC outer vestibule has negative aspartate/glutamate clusters; favors basic RBD loops (Arg/Lys)
        if (positiveCount > negativeCount) {
          affinity += 28;
          electrostaticFit = Math.min(1.0, 0.5 + netRbdCharge * 0.1);
          evidence.push(`Cationic tip (${positiveCount} basic vs ${negativeCount} acidic) balances anionic OmpC loop L4/L5`);
        } else {
          affinity -= 15;
          electrostaticFit = -0.5;
          stericClash += 25;
          evidence.push('Electrostatic repulsion against negative OmpC outer surface');
        }
        break;
      }
      case 'tonb_fhua': {
        // FhuA iron transporter cork domain
        if (aromaticCount >= 3 && positiveCount >= 2) {
          affinity += 22;
          electrostaticFit = 0.5;
          evidence.push('Amphipathic loop configuration compatible with FhuA gating apex');
        }
        stericClash = 22;
        break;
      }
      case 'btub': {
        if (hydrophobicCount > 10) {
          affinity += 18;
          electrostaticFit = 0.3;
          evidence.push('Hydrophobic core contacts align with cobalamin transporter cleft');
        }
        stericClash = 20;
        break;
      }
      case 'lps_core': {
        // LPS phosphate core is heavily negatively charged; basic residues (Arg, Lys) are essential for attachment
        const basicRatio = positiveCount / Math.max(1, rbdRes.length);
        if (basicRatio > 0.08) {
          affinity += 35;
          electrostaticFit = 0.9;
          evidence.push(`High basic residue density (${basicRatio.toFixed(2)}) binds negatively charged LPS phosphate core`);
        } else {
          affinity -= 12;
          electrostaticFit = -0.3;
          evidence.push('Low basic charge reduces initial ionic adsorption to LPS core');
        }
        stericClash = 10; // High steric flexibility in polysaccharide chain
        break;
      }
      case 'type_iv_pilus': {
        // Pili require hydrophobic interactions with PilA grooves
        const hydroRatio = hydrophobicCount / Math.max(1, rbdRes.length);
        if (hydroRatio > 0.3) {
          affinity += 25;
          electrostaticFit = 0.2;
          evidence.push(`Hydrophobic patch density (${hydroRatio.toFixed(2)}) docks into PilA subunit groove`);
        }
        stericClash = 30;
        break;
      }
    }

    affinity = Math.max(10, Math.min(98, affinity));
    scores.push({
      receptorId: receptor.id,
      receptorName: receptor.name,
      category: receptor.category,
      affinityScore: affinity,
      electrostaticFit: Math.round(electrostaticFit * 100) / 100,
      stericClashScore: stericClash,
      compatibilityRank: 0,
      interactionEvidence: evidence,
    });
  }

  // Sort descending by affinityScore
  scores.sort((a, b) => b.affinityScore - a.affinityScore);
  scores.forEach((s, idx) => {
    s.compatibilityRank = idx + 1;
  });

  return scores;
}

/**
 * Predict bacterial host genera from RBD and receptor scores
 */
export function inferHostRangeFromReceptors(
  receptorScores: ReceptorBindingScore[],
  primaryHost?: string | null
): TailFiberStructuralAnalysis['predictedHosts'] {
  const hostMap: Record<string, { confidence: number; receptors: string[] }> = {};

  for (const s of receptorScores) {
    let host = 'Escherichia coli';
    if (s.receptorId === 'type_iv_pilus') host = 'Pseudomonas aeruginosa';
    if (s.receptorId === 'lps_core' && s.affinityScore > 75) {
      host = 'Salmonella enterica';
    }

    if (!hostMap[host]) {
      hostMap[host] = { confidence: s.affinityScore, receptors: [s.receptorName] };
    } else {
      hostMap[host].confidence = Math.max(hostMap[host].confidence, s.affinityScore);
      hostMap[host].receptors.push(s.receptorName);
    }
  }

  // If primaryHost is known, give it prominent representation
  if (primaryHost && !hostMap[primaryHost]) {
    hostMap[primaryHost] = {
      confidence: 85,
      receptors: ['Primary documented host species'],
    };
  }

  return Object.entries(hostMap)
    .map(([hostName, data]) => ({
      hostName,
      confidence: Math.round(data.confidence),
      primaryReceptors: data.receptors,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * In-silico point mutation simulator: calculates stability shifts and receptor binding deltas
 */
export function simulateResidueMutation(
  analysis: TailFiberStructuralAnalysis,
  position: number,
  mutantAa: string
): MutationSimulationResult {
  const targetRes = analysis.residues.find((r) => r.position === position);
  const wt = targetRes?.aminoAcid ?? 'A';
  const newAa = mutantAa.toUpperCase();

  const wtDdg = ALANINE_SCAN_BASELINE_DDG[wt] ?? 1.5;
  const newDdg = ALANINE_SCAN_BASELINE_DDG[newAa] ?? 1.5;
  const wtCharge = RESIDUE_CHARGES[wt] ?? 0;
  const newCharge = RESIDUE_CHARGES[newAa] ?? 0;

  // Free energy stability shift
  let ddgDelta = newDdg - wtDdg;
  if (targetRes?.domain === 'n_anchor') {
    ddgDelta *= 1.6; // Anchor mutations are heavily penalized
  }

  // Clash penalty
  let clashPenalty = 0;
  const bulkyAAs = ['W', 'F', 'Y', 'R'];
  if (bulkyAAs.includes(newAa) && (targetRes?.sasa ?? 50) < 30) {
    clashPenalty = 65; // Steric clash inside packed core
  }

  // Affinity shifts
  const affinityDeltas: Record<string, number> = {};
  for (const r of analysis.receptorScores) {
    let delta = 0;
    if (r.receptorId === 'ompc' || r.receptorId === 'lps_core') {
      if (newCharge > wtCharge) delta += 12; // Basic charge enhances affinity to anionic porin/LPS
      if (newCharge < wtCharge) delta -= 14;
    }
    if (r.receptorId === 'lamb') {
      if (['W', 'Y', 'F'].includes(newAa)) delta += 15;
      if (wt !== 'A' && newAa === 'A') delta -= 12;
    }
    affinityDeltas[r.receptorId] = Math.round(delta);
  }

  let predictedHostImpact = `Mutation ${wt}${position}${newAa} in ${targetRes?.domain ?? 'fiber'}`;
  if (clashPenalty > 50) {
    predictedHostImpact += ': High steric clash risk within core; likely destabilizes fiber folding.';
  } else if ((affinityDeltas.ompc ?? 0) > 8) {
    predictedHostImpact += ': Enhances cationic electrostatic affinity toward OmpC porin.';
  } else if ((affinityDeltas.lamb ?? 0) > 8) {
    predictedHostImpact += ': Introduces favorable aromatic stacking into LamB vestibule.';
  } else {
    predictedHostImpact += ': Neutral or conservative substitution with minimal host range shift.';
  }

  return {
    position,
    wildType: wt,
    mutant: newAa,
    ddgDelta: Math.round(ddgDelta * 10) / 10,
    clashPenalty,
    affinityDeltas,
    predictedHostImpact,
  };
}

/**
 * Generate modular chimera engineering suggestions
 */
export function generateChimeraSuggestions(
  domains: FiberDomain[],
  _currentPhage: string
): ChimeraEngineeringSuggestion[] {
  const rbd = domains.find((d) => d.type === 'distal_rbd');
  const junction = rbd ? rbd.startResidue : Math.floor(domains[0]?.length ?? 100 * 0.7);
  const rbdRange: [number, number] = rbd ? [rbd.startResidue, rbd.endResidue] : [junction, junction + 250];

  return [
    {
      donorPhage: 'Enterobacteria phage T2',
      donorProtein: 'gp37 (C-terminal tip)',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'OmpF / FadL',
      predictedHost: 'Escherichia coli (OmpC-deficient mutants)',
      feasibilityScore: 88,
      rationale: 'Well-documented modular junction swap in Teven phages; expands host tropism to porin-altered escape mutants.',
    },
    {
      donorPhage: 'Salmonella phage P22',
      donorProtein: 'gp9 tailspike',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'Salmonella enterica O-antigen repeat units',
      predictedHost: 'Salmonella enterica serovar Typhimurium',
      feasibilityScore: 76,
      rationale: 'Endorhamnosidase beta-helix domain substitution retargets tail fiber toward surface polysaccharide O-antigens.',
    },
    {
      donorPhage: 'Pseudomonas phage PaP1',
      donorProtein: 'gp18 receptor-binding tip',
      junctionResidue: junction,
      rbdRange,
      targetReceptor: 'Type IV Pilus & O-polysaccharide',
      predictedHost: 'Pseudomonas aeruginosa PAO1',
      feasibilityScore: 68,
      rationale: 'Crossover at coiled-coil shaft boundary enables cross-genus chimera construction for therapeutic cocktail expansion.',
    },
  ];
}

/**
 * Full structural epitope clash map analyzer for tail fiber genes
 */
export function analyzeTailFiberStructure(
  phage: PhageFull,
  targetGene?: GeneInfo | null,
  translatedSequence?: string | null,
  options: { demonstration?: boolean } = {}
): TailFiberStructuralAnalysis | null {
  // Sequence alone cannot supply an alignment, 3D surface or binding energy.
  // Keep the existing teaching model available only after explicit opt-in.
  if (options.demonstration !== true) return null;
  // Find tail fiber gene if not provided
  let gene = targetGene;
  if (!gene) {
    gene = phage.genes.find((g) => isTailFiberCandidate(g)) ?? null;
  }

  if (!gene) {
    return null;
  }

  // Construct representative or provided amino acid sequence
  let seq = translatedSequence ?? '';
  if (!seq || seq.length < 20) {
    // Generate representative amino acid model sequence for phage tail fiber
    const len = Math.max(120, Math.min(800, Math.floor(Math.abs(gene.endPos - gene.startPos) / 3)));
    const mockAa = 'MAEKLLNVLNELDALTAELAQKADAAKGVAASIKTGVGTGGGGVSYAGFTNGTVTFANWAKAGYQYNDWGFV';
    seq = mockAa.repeat(Math.ceil(len / mockAa.length)).slice(0, len);
  }

  const homologColumns = generateFiberHomologColumns(seq);
  const rawEntropies = homologColumns.map((col) => calculatePositionEntropy(col));
  const smoothedEntropies = smoothArray(rawEntropies, 9);

  const kdArray = seq.split('').map((aa) => KYTE_DOOLITTLE[aa.toUpperCase()] ?? 0);
  const domains = detectFiberDomainBoundaries(seq.length, smoothedEntropies, kdArray);
  const residues = calculateResidueEpitopeMetrics(seq, domains, rawEntropies);
  const receptorScores = scoreReceptorBinding(residues, domains);
  const predictedHosts = inferHostRangeFromReceptors(receptorScores, phage.host);
  const chimeraSuggestions = generateChimeraSuggestions(domains, phage.name);

  const hypervariableHotspots = residues
    .filter((r) => r.isHypervariableEpitope)
    .map((r) => r.position);

  const meanEntropy =
    rawEntropies.length > 0
      ? Math.round((rawEntropies.reduce((a, b) => a + b, 0) / rawEntropies.length) * 100) / 100
      : 0;

  const rbd = domains.find((d) => d.type === 'distal_rbd');
  const topReceptor = receptorScores[0]?.receptorName ?? 'Outer surface receptor';

  const summary =
    `Analyzed tail fiber ${gene.name ?? gene.locusTag ?? 'protein'} (${seq.length} aa): ` +
    `identified ${domains.length} structural domains (N-anchor 1-${domains[0]?.endResidue ?? 0}, ` +
    `shaft ${domains[1]?.startResidue ?? 0}-${domains[1]?.endResidue ?? 0}, ` +
    `distal RBD ${rbd?.startResidue ?? 0}-${rbd?.endResidue ?? 0}). ` +
    `Top predicted receptor is ${topReceptor} (${receptorScores[0]?.affinityScore ?? 0}% affinity). ` +
    `Found ${hypervariableHotspots.length} hypervariable epitope hotspot residues in the receptor-binding tip.`;

  return {
    source: 'demonstration',
    assumptions: `Illustration using ${translatedSequence && translatedSequence.length >= 20 ? 'the supplied protein sequence' : 'a repeated MAEKLL… example sequence'} and ${gene.name ?? gene.locusTag ?? 'gene'} annotation. Homologs, domain boundaries, surface areas, energies, affinities and chimera scenarios are synthetic model outputs, not predictions for ${phage.name}.`,
    phageId: phage.id,
    phageName: phage.name,
    geneId: gene.id,
    geneName: gene.name ?? gene.locusTag ?? `gene_${gene.id}`,
    locusTag: gene.locusTag ?? `gene_${gene.id}`,
    product: gene.product ?? 'Tail fiber protein',
    sequenceLength: seq.length,
    domains,
    residues,
    meanEntropy,
    hypervariableHotspots,
    receptorScores,
    predictedHosts,
    chimeraSuggestions,
    summary,
  };
}
