/**
 * Neighbor joining of explicitly aligned DNA, not a molecular-clock estimator.
 * Saitou & Nei (1987), doi:10.1093/oxfordjournals.molbev.a040454.
 * Site resampling: Felsenstein (1985), doi:10.1111/j.1558-5646.1985.tb00420.x.
 * A shared complete-deletion mask retains homologous A/C/G/T columns in every
 * taxon. This module does not align sequences or establish their homology.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

export const ALIGNED_PHYLOGENY_METHOD = { id: 'aligned-dna-neighbor-joining', version: '1.0.0', implementation: 'typescript' } as const;
export const PHYLOGENY_LIMITS = { bytes: 2 * 1024 * 1024, taxa: 64, sites: 100000, bootstrap: 200, work: 100000000 } as const;
export interface AlignedTaxon { id: string; sequence: string }
export interface PhylogenySource { name: string; fasta: string; kind: 'local' | 'demo'; reference: string }
export interface PhylogenyOptions { distance: 'p-distance' | 'jc69'; deletion: 'complete'; bootstrap: number; seed: number }
export interface PhylogenyNode { id: number; label: string | null }
export interface PhylogenyEdge { a: number; b: number; length: number }
/** Flat storage keeps long, unbalanced trees within the shared JSON depth bound. */
export interface NeighborJoiningTree { nodes: PhylogenyNode[]; edges: PhylogenyEdge[]; serializationRoot: number; tiedSteps: number }
export interface PhylogenySplit { side: string[]; other: string[]; length: number; bootstrapCount: number | null; support: number | null }
export interface AlignedPhylogenyResult {
  taxa: string[]; alignmentSites: number; usedSites: number; excludedColumns: number[]; variableSites: number;
  distances: number[][]; tree: NeighborJoiningTree; splits: PhylogenySplit[]; newick: string;
  bootstrap: { requested: number; completed: number; saturated: number; supportAvailable: boolean };
  negativeEdges: number; zeroEdges: number; distanceResidualRMSE: number; warnings: string[];
}
export interface AlignedPhylogenyExperiment { record: AnalysisRecord; source: PhylogenySource; options: PhylogenyOptions; result: AlignedPhylogenyResult }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const identifier = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id);
function boundedText(text: unknown, limit: number, label: string): asserts text is string {
  if (typeof text !== 'string' || text.length > limit || new TextEncoder().encode(text).length > limit) throw new Error(`${label} exceeds the ${limit}-byte UTF-8 limit.`);
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Phylogeny cancelled.', 'AbortError'); }
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
}
export function resolvePhylogenyOptions(input: Partial<PhylogenyOptions> = {}): PhylogenyOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['distance', 'deletion', 'bootstrap', 'seed'].includes(key))) throw new Error('Unsupported phylogeny options.');
  const options = { distance: 'p-distance', deletion: 'complete', bootstrap: 0, seed: 1, ...input } as PhylogenyOptions;
  if (options.distance !== 'p-distance' && options.distance !== 'jc69') throw new Error('Choose p-distance or jc69.');
  if (options.deletion !== 'complete') throw new Error('Only explicit complete-column deletion is supported.');
  integer(options.bootstrap, 0, PHYLOGENY_LIMITS.bootstrap, 'Bootstrap count');
  if (options.bootstrap > 0 && options.bootstrap < 20) throw new Error('Use at least 20 bootstrap replicates, or 0 to disable support.');
  integer(options.seed, 0, 0xffffffff, 'Seed');
  return options;
}
export function parseAlignedDNA(fasta: string): AlignedTaxon[] {
  boundedText(fasta, PHYLOGENY_LIMITS.bytes, 'Alignment');
  const taxa: AlignedTaxon[] = [];
  for (const [index, raw] of fasta.replace(/^\uFEFF/, '').split(/\r\n?|\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      const id = line.slice(1).split(/\s/)[0];
      if (!identifier(id)) throw new Error(`Line ${index + 1}: use a unique FASTA ID of 1–80 letters, digits, dots, hyphens or underscores.`);
      if (taxa.some(taxon => taxon.id === id)) throw new Error(`Duplicate FASTA ID: ${id}`);
      if (taxa.length >= PHYLOGENY_LIMITS.taxa) throw new Error(`At most ${PHYLOGENY_LIMITS.taxa} taxa are supported.`);
      taxa.push({ id, sequence: '' });
    } else {
      if (!taxa.length) throw new Error(`Line ${index + 1}: expected a FASTA header.`);
      const sequence = line.replace(/[ \t]/g, '').toUpperCase();
      if (!/^[ACGTRYSWKMBDHVN?\-]+$/.test(sequence)) throw new Error(`Line ${index + 1}: expected aligned DNA (IUPAC, '-' gaps or '?' missing values).`);
      const taxon = taxa[taxa.length - 1];
      if (taxon.sequence.length + sequence.length > PHYLOGENY_LIMITS.sites) throw new Error(`At most ${PHYLOGENY_LIMITS.sites} aligned sites are supported.`);
      taxon.sequence += sequence;
    }
  }
  if (taxa.length < 3) throw new Error('Provide at least three aligned DNA taxa.');
  const length = taxa[0].sequence.length;
  if (!length || taxa.some(taxon => taxon.sequence.length !== length)) throw new Error('All FASTA records must contain the same nonzero number of aligned columns; no alignment is inferred.');
  return taxa.sort((a, b) => compare(a.id, b.id));
}

/** Exact NJ reduction. Signed limbs are retained, not clipped to make a tree look valid. */
export function neighborJoining(ids: readonly string[], distances: readonly (readonly number[])[]): NeighborJoiningTree {
  integer(ids.length, 3, PHYLOGENY_LIMITS.taxa, 'Taxon count');
  if (Array.from(ids).some(id => !identifier(id)) || new Set(ids).size !== ids.length) throw new Error('Neighbor joining requires unique valid taxon IDs.');
  if (distances.length !== ids.length) throw new Error('Distance matrix dimensions differ from taxa.');
  for (let i = 0; i < ids.length; i++) {
    if (!Array.isArray(distances[i]) || distances[i].length !== ids.length) throw new Error('Distance matrix must be square.');
    for (let j = 0; j < ids.length; j++) {
      const value = distances[i][j];
      if (!Number.isFinite(value) || value < 0 || value > 1e6 || (i === j && value !== 0) || value !== distances[j]?.[i]) throw new Error('Distances must be finite, nonnegative, bounded, symmetric, and zero on the diagonal.');
    }
  }
  const order = Array.from(ids, (_, i) => i).sort((a, b) => compare(ids[a], ids[b]));
  const nodes: PhylogenyNode[] = order.map((original, id) => ({ id, label: ids[original] }));
  const edges: PhylogenyEdge[] = [];
  const capacity = ids.length * 2;
  const matrix = Array.from({ length: capacity }, () => Array<number>(capacity).fill(0));
  order.forEach((a, i) => order.forEach((b, j) => { matrix[i][j] = distances[a][b]; }));
  let active = order.map((_, i) => i), tiedSteps = 0;
  while (active.length > 3) {
    const m = active.length;
    const sums = active.map(a => active.reduce((sum, b) => sum + matrix[a][b], 0));
    const candidates: Array<{ i: number; j: number; q: number }> = [];
    let minimum = Infinity, magnitude = 0;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      const q = (m - 2) * matrix[active[i]][active[j]] - sums[i] - sums[j];
      minimum = Math.min(minimum, q); magnitude = Math.max(magnitude, Math.abs(q));
      candidates.push({ i, j, q });
    }
    const tolerance = Number.EPSILON * 64 * magnitude;
    const tied = candidates.filter(candidate => candidate.q <= minimum + tolerance);
    if (tied.length > 1) tiedSteps++;
    const { i, j } = tied[0], a = active[i], b = active[j], joined = nodes.length;
    const left = (matrix[a][b] + (sums[i] - sums[j]) / (m - 2)) / 2;
    nodes.push({ id: joined, label: null });
    edges.push({ a: joined, b: a, length: left }, { a: joined, b, length: matrix[a][b] - left });
    const remaining = active.filter(id => id !== a && id !== b);
    for (const other of remaining) matrix[joined][other] = matrix[other][joined] = (matrix[a][other] + matrix[b][other] - matrix[a][b]) / 2;
    active = [...remaining, joined];
  }
  const [a, b, c] = active, root = nodes.length;
  const left = (matrix[a][b] + matrix[a][c] - matrix[b][c]) / 2;
  nodes.push({ id: root, label: null });
  edges.push({ a: root, b: a, length: left }, { a: root, b, length: matrix[a][b] - left }, { a: root, b: c, length: matrix[a][c] - left });
  return { nodes, edges, serializationRoot: root, tiedSteps };
}
function adjacency(tree: NeighborJoiningTree): Array<Array<{ node: number; edge: PhylogenyEdge }>> {
  const links = tree.nodes.map(() => [] as Array<{ node: number; edge: PhylogenyEdge }>);
  for (const edge of tree.edges) { links[edge.a].push({ node: edge.b, edge }); links[edge.b].push({ node: edge.a, edge }); }
  return links;
}
function treeSplits(tree: NeighborJoiningTree, epsilon: number): PhylogenySplit[] {
  const links = adjacency(tree), all = tree.nodes.flatMap(node => node.label === null ? [] : [node.label]).sort(compare);
  const collect = (id: number, parent: number): string[] => tree.nodes[id].label !== null ? [tree.nodes[id].label!] : links[id].filter(link => link.node !== parent).flatMap(link => collect(link.node, id));
  return tree.edges.filter(edge => edge.length > epsilon && tree.nodes[edge.a].label === null && tree.nodes[edge.b].label === null).map(edge => {
    const one = collect(edge.a, edge.b).sort(compare), members = new Set(one), two = all.filter(id => !members.has(id));
    const first = one.length < two.length || one.length === two.length && compare(JSON.stringify(one), JSON.stringify(two)) < 0;
    return { side: first ? one : two, other: first ? two : one, length: edge.length, bootstrapCount: null, support: null };
  }).sort((a, b) => compare(JSON.stringify(a.side), JSON.stringify(b.side)));
}
function newickFor(tree: NeighborJoiningTree): string {
  const links = adjacency(tree);
  const render = (id: number, parent: number): string => {
    const label = tree.nodes[id].label;
    if (label !== null) return `'${label}'`;
    return '(' + links[id].filter(link => link.node !== parent).map(link => `${render(link.node, id)}:${Object.is(link.edge.length, -0) ? 0 : link.edge.length}`).join(',') + ')';
  };
  return render(tree.serializationRoot, -1) + ';';
}
function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
class SaturatedDistance extends Error {}
function distanceMatrix(taxa: AlignedTaxon[], sites: number[], options: PhylogenyOptions, weights?: Uint32Array): number[][] {
  const matrix = taxa.map(() => taxa.map(() => 0));
  for (let a = 0; a < taxa.length; a++) for (let b = a + 1; b < taxa.length; b++) {
    let differences = 0;
    for (let i = 0; i < sites.length; i++) if (taxa[a].sequence[sites[i]] !== taxa[b].sequence[sites[i]]) differences += weights ? weights[i] : 1;
    const p = differences / sites.length;
    if (options.distance === 'jc69' && p >= 0.75) throw new SaturatedDistance(`JC69 is undefined at divergence >= 0.75 (${taxa[a].id}, ${taxa[b].id}). No finite branch estimate is available.`);
    matrix[a][b] = matrix[b][a] = options.distance === 'jc69' ? -0.75 * Math.log1p(-4 * p / 3) : p;
  }
  return matrix;
}
function treeResidual(tree: NeighborJoiningTree, distances: number[][]): number {
  const links = adjacency(tree), n = distances.length; let sse = 0, count = 0;
  for (let leaf = 0; leaf < n; leaf++) {
    const walk = (id: number, parent: number, length: number): void => {
      if (id > leaf && id < n) { sse += (length - distances[leaf][id]) ** 2; count++; }
      for (const link of links[id]) if (link.node !== parent) walk(link.node, id, length + link.edge.length);
    };
    walk(leaf, -1, 0);
  }
  return Math.sqrt(sse / count);
}
export function inferAlignedPhylogeny(fasta: string, supplied: Partial<PhylogenyOptions> = {}, signal?: AbortSignal): AlignedPhylogenyResult {
  abort(signal);
  const taxa = parseAlignedDNA(fasta), options = resolvePhylogenyOptions(supplied), length = taxa[0].sequence.length;
  const sites: number[] = [], excludedColumns: number[] = []; let variableSites = 0;
  for (let column = 0; column < length; column++) {
    if (taxa.some(taxon => !'ACGT'.includes(taxon.sequence[column]))) { excludedColumns.push(column); continue; }
    sites.push(column);
    if (taxa.some(taxon => taxon.sequence[column] !== taxa[0].sequence[column])) variableSites++;
  }
  if (!sites.length) throw new Error('No complete A/C/G/T alignment columns remain. Missing or ambiguous bases are not matches.');
  const pairs = taxa.length * (taxa.length - 1) / 2;
  const work = (options.bootstrap + 1) * (sites.length * pairs + taxa.length ** 3);
  if (work > PHYLOGENY_LIMITS.work) throw new Error('Requested alignment/bootstrap exceeds the computation budget; reduce taxa, sites or bootstrap count explicitly.');
  const ids = taxa.map(taxon => taxon.id), distances = distanceMatrix(taxa, sites, options), tree = neighborJoining(ids, distances);
  const epsilonFor = (matrix: number[][]) => Number.EPSILON * 256 * Math.max(...matrix.flat());
  const epsilon = epsilonFor(distances), splits = treeSplits(tree, epsilon), counts = new Map(splits.map(split => [JSON.stringify(split.side), 0]));
  const random = randomFor(options.seed); let completed = 0, saturated = 0;
  for (let replicate = 0; replicate < options.bootstrap; replicate++) {
    abort(signal);
    const weights = new Uint32Array(sites.length);
    for (let draw = 0; draw < sites.length; draw++) weights[Math.floor(random() * sites.length)]++;
    try {
      const bootDistances = distanceMatrix(taxa, sites, options, weights);
      const found = treeSplits(neighborJoining(ids, bootDistances), epsilonFor(bootDistances));
      for (const split of found) { const key = JSON.stringify(split.side); if (counts.has(key)) counts.set(key, counts.get(key)! + 1); }
      completed++;
    } catch (error) { if (error instanceof SaturatedDistance) saturated++; else throw error; }
  }
  const supportAvailable = options.bootstrap > 0 && saturated === 0;
  if (supportAvailable) for (const split of splits) { split.bootstrapCount = counts.get(JSON.stringify(split.side))!; split.support = split.bootstrapCount / completed; }
  const negativeEdges = tree.edges.filter(edge => edge.length < -epsilon).length;
  const zeroEdges = tree.edges.filter(edge => Math.abs(edge.length) <= epsilon).length;
  const warnings = [
    'User-supplied alignment homology, sampling and provenance are not independently verified. This method does not perform sequence alignment.',
    'Neighbor joining gives an unrooted distance tree. Its serialization root is arbitrary, not an ancestor, outgroup or collection date.',
    'No molecular clock, transmission history, host range, immune escape or population-size estimate is inferred.',
    'Common complete deletion removes every column with a gap, missing value or ambiguous DNA in any taxon. Indels contribute no distance.',
    'Bootstrap proportions resample retained alignment columns and count positive-length unrooted bipartitions, not probabilities that a clade is true. Linked sites and recombination can invalidate independent-site interpretation.',
    options.distance === 'jc69' ? 'JC69 assumes equal base frequencies and substitution rates; saturated distances cannot be estimated.' : 'p-distance is the observed difference fraction; multiple substitutions at a site are not corrected.',
  ];
  if (excludedColumns.length) warnings.push(`${excludedColumns.length} columns were excluded (0-based positions are retained in the result).`);
  if (!variableSites) warnings.push('No variable usable sites: all taxa are unresolved; zero-length binary resolutions have no supported splits.');
  if (tree.tiedSteps) warnings.push('NJ encountered equal minimum criteria. Deterministic tie-breaking is not independent evidence of a resolved topology.');
  if (negativeEdges) warnings.push('Negative NJ branch lengths are preserved and reported, not clipped. This tree is not suitable for tools requiring nonnegative branch lengths.');
  if (saturated) warnings.push(`${saturated} bootstrap samples had saturated JC69 distances. All split supports are withheld rather than conditioning on successful samples.`);
  abort(signal);
  return { taxa: ids, alignmentSites: length, usedSites: sites.length, excludedColumns, variableSites, distances, tree, splits, newick: newickFor(tree),
    bootstrap: { requested: options.bootstrap, completed, saturated, supportAvailable }, negativeEdges, zeroEdges, distanceResidualRMSE: treeResidual(tree, distances), warnings };
}
function validateSource(input: PhylogenySource): PhylogenySource {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join('|') !== 'fasta|kind|name|reference') throw new Error('Supply name, fasta, kind and reference for the alignment source.');
  boundedText(input.name, 200, 'Source name'); boundedText(input.reference, 2000, 'Source reference'); boundedText(input.fasta, PHYLOGENY_LIMITS.bytes, 'Alignment');
  if (!input.name.trim() || !input.reference.trim() || !['local', 'demo'].includes(input.kind)) throw new Error('Specify local/demo provenance and a nonempty source name and reference.');
  return { name: input.name, fasta: input.fasta, kind: input.kind, reference: input.reference };
}
export async function createAlignedPhylogenyExperiment(input: PhylogenySource, supplied: Partial<PhylogenyOptions> = {}, signal?: AbortSignal): Promise<AlignedPhylogenyExperiment> {
  const source = validateSource(input), options = resolvePhylogenyOptions(supplied), result = inferAlignedPhylogeny(source.fasta, options, signal);
  const record = await createAnalysisRecord({ method: ALIGNED_PHYLOGENY_METHOD,
    inputs: [{ id: 'alignment', accession: null, source: source.kind, description: 'Original aligned DNA FASTA and submitted provenance', data: analysisJson(source) }],
    parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: options.seed,
    references: [{ id: '10.1093/oxfordjournals.molbev.a040454', version: '1987', description: 'Saitou and Nei: neighbor joining' },
      { id: '10.1111/j.1558-5646.1985.tb00420.x', version: '1985', description: 'Felsenstein: site bootstrap for phylogenies' }],
    fields: { phylogeny: { kind: 'sequence-score', label: 'Alignment-derived unrooted distance tree and split resampling frequencies', units: 'dimensionless',
      value: analysisJson(result), coverage: { available: result.usedSites, total: result.alignmentSites, unit: 'bases' }, limitations: result.warnings } } });
  abort(signal); return { record, source, options, result };
}
/** Verify content hashes AND recompute all outputs. Self-consistent forged output is not accepted. */
export async function replayAlignedPhylogenyExperiment(content: string, signal?: AbortSignal): Promise<AlignedPhylogenyExperiment> {
  abort(signal);
  const saved = await parseAnalysisRecord(content, { methodId: ALIGNED_PHYLOGENY_METHOD.id, methodVersion: ALIGNED_PHYLOGENY_METHOD.version });
  abort(signal);
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'alignment' || Object.keys(saved.parameters).sort().join('|') !== 'bootstrap|deletion|distance|seed') throw new Error('Experiment requires one original alignment and all explicit options.');
  const experiment = await createAlignedPhylogenyExperiment(saved.inputs[0].data as unknown as PhylogenySource, saved.parameters as unknown as PhylogenyOptions, signal);
  if (experiment.record.cacheKey !== saved.cacheKey || experiment.record.resultId !== saved.resultId) throw new Error('Recomputed phylogeny differs from the saved experiment.');
  return experiment;
}
