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
