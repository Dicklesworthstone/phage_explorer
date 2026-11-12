/** Explicit root hypotheses on a verified NJ tree, without estimating a biological root. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createAlignedPhylogenyExperiment, replayAlignedPhylogenyExperiment, parseAlignedDNA, PHYLOGENY_LIMITS,
  type AlignedPhylogenyExperiment, type NeighborJoiningTree, type PhylogenyOptions, type PhylogenySource } from './aligned-phylogeny';
import { createAncestralRecord, parseAncestralFasta, reconstructAncestors, resolveAncestralOptions, validateAncestralDataset,
  type AncestralDataset, type AncestralOptions, type AncestralResult } from './ancestral-reconstruction';

export const ROOTED_PHYLOGENY_METHOD = { id: 'explicit-outgroup-rooted-nj', version: '1.0.0', implementation: 'typescript' } as const;
export interface OutgroupRooting {
  outgroup: string[];
  /** Fraction along the separating edge, measured from its outgroup-side endpoint. No default. */
  fractionFromOutgroup: number;
  evidence: string;
  /** User assertion about both the outgroup choice and placement, not an automated verification. */
  dateIndependent: true;
}
export interface RootedPhylogenyResult {
  tree: NeighborJoiningTree;
  newick: string;
  sourceResultId: string;
  rooting: OutgroupRooting;
  originalEdge: { outgroupNode: number; ingroupNode: number; length: number };
  distancePreservation: { pairs: number; maxAbsoluteDifference: number };
  warnings: string[];
}
export interface RootedPhylogenyExperiment {
  record: AnalysisRecord;
  unrooted: AlignedPhylogenyExperiment;
  result: RootedPhylogenyResult;
}
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Rooting cancelled.', 'AbortError'); };
export function resolveOutgroupRooting(input: OutgroupRooting): OutgroupRooting {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('|') !== 'dateIndependent|evidence|fractionFromOutgroup|outgroup') {
    throw new Error('Supply an explicit outgroup, fractionFromOutgroup, evidence and dateIndependent declaration.');
  }
  if (!Array.isArray(input.outgroup) || !input.outgroup.length || input.outgroup.length > PHYLOGENY_LIMITS.taxa - 2
    || Array.from(input.outgroup).some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id))
    || new Set(input.outgroup).size !== input.outgroup.length) throw new Error('Outgroup IDs must be nonempty, unique, bounded FASTA identifiers.');
  if (typeof input.fractionFromOutgroup !== 'number' || !Number.isFinite(input.fractionFromOutgroup)
    || input.fractionFromOutgroup <= 0 || input.fractionFromOutgroup >= 1) throw new Error('Root fraction must be strictly between 0 and 1; no midpoint is assumed.');
  if (typeof input.evidence !== 'string' || !input.evidence.trim() || new TextEncoder().encode(input.evidence).length > 2000) {
    throw new Error('Provide 1–2000 UTF-8 bytes of rooting evidence, including the branch-placement rationale.');
  }
  if (input.dateIndependent !== true) throw new Error('Declare that outgroup choice and root placement did not use collection dates.');
  return { outgroup: [...input.outgroup].sort(lexical), fractionFromOutgroup: input.fractionFromOutgroup,
    evidence: input.evidence.trim(), dateIndependent: true };
}
function linksFor(tree: NeighborJoiningTree) {
  const links = tree.nodes.map(() => [] as Array<{ node: number; length: number }>);
  for (const edge of tree.edges) {
    links[edge.a].push({ node: edge.b, length: edge.length }); links[edge.b].push({ node: edge.a, length: edge.length });
  }
  return links;
}
function pairPaths(tree: NeighborJoiningTree, leaves: number[]): number[] {
  const links = linksFor(tree), paths: number[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const distances = new Map<number, number>();
    const walk = (id: number, parent: number, distance: number): void => {
      distances.set(id, distance);
      for (const next of links[id]) if (next.node !== parent) walk(next.node, id, distance + next.length);
    };
    walk(leaves[i], -1, 0);
    for (let j = i + 1; j < leaves.length; j++) paths.push(distances.get(leaves[j])!);
  }
  return paths;
}
/** Called only with freshly inferred/replayed core output, never an imported graph object. */
function placeRoot(unrooted: AlignedPhylogenyExperiment, rooting: OutgroupRooting): RootedPhylogenyResult {
  const original = unrooted.result.tree, taxa = new Set(unrooted.result.taxa), wanted = new Set(rooting.outgroup);
  if (rooting.outgroup.some(id => !taxa.has(id))) throw new Error('Every outgroup ID must occur in the original alignment.');
  if (taxa.size - wanted.size < 2) throw new Error('Retain at least two ingroup taxa.');
  if (original.edges.some(edge => !Number.isFinite(edge.length) || edge.length < 0)) {
    throw new Error('Rooting requires nonnegative original branch lengths. Negative NJ limbs, including roundoff negatives, are not clipped or refitted.');
  }
  const links = linksFor(original);
  const collect = (id: number, parent: number): string[] => original.nodes[id].label !== null ? [original.nodes[id].label!]
    : links[id].filter(next => next.node !== parent).flatMap(next => collect(next.node, id));
  let cut = -1, outgroupNode = -1, ingroupNode = -1;
  for (let i = 0; i < original.edges.length; i++) {
    const edge = original.edges[i], a = collect(edge.a, edge.b), b = collect(edge.b, edge.a);
    const matches = (side: string[]) => side.length === wanted.size && side.every(id => wanted.has(id));
    if (matches(a)) { cut = i; outgroupNode = edge.a; ingroupNode = edge.b; break; }
    if (matches(b)) { cut = i; outgroupNode = edge.b; ingroupNode = edge.a; break; }
  }
  if (cut < 0) throw new Error('The selected outgroup is not separated from the ingroup by one tree edge; no topology is rearranged.');
  const length = original.edges[cut].length;
  if (length <= 0) throw new Error('The separating edge has zero length; it cannot identify a root placement.');
  const outLength = length * rooting.fractionFromOutgroup, inLength = length - outLength;
  if (outLength <= 0 || inLength <= 0) throw new Error('Root placement is not representable at this numeric precision.');
  const root = original.nodes.length;
  const tree: NeighborJoiningTree = { ...original, serializationRoot: root,
    nodes: [...original.nodes.map(node => ({ ...node })), { id: root, label: null }],
    edges: [...original.edges.filter((_, i) => i !== cut).map(edge => ({ ...edge })),
      { a: root, b: outgroupNode, length: outLength }, { a: root, b: ingroupNode, length: inLength }] };
  const rootedLinks = linksFor(tree);
  const render = (id: number, parent: number): string => tree.nodes[id].label !== null ? `'${tree.nodes[id].label}'`
    : '(' + rootedLinks[id].filter(next => next.node !== parent).map(next => `${render(next.node, id)}:${Object.is(next.length, -0) ? 0 : next.length}`).join(',') + ')';
  const leaves = original.nodes.filter(node => node.label !== null).map(node => node.id);
  const before = pairPaths(original, leaves), after = pairPaths(tree, leaves);
  const maxAbsoluteDifference = Math.max(...before.map((value, i) => Math.abs(value - after[i])));
  const tolerance = Number.EPSILON * 256 * Math.max(...before);
  if (!Number.isFinite(maxAbsoluteDifference) || maxAbsoluteDifference > tolerance) throw new Error('Root placement did not preserve original pairwise path lengths.');
  return { tree, newick: render(root, -1) + ';', sourceResultId: unrooted.record.resultId, rooting,
    originalEdge: { outgroupNode, ingroupNode, length }, distancePreservation: { pairs: before.length, maxAbsoluteDifference }, warnings: [
      'The root is a user-specified hypothesis. Neither the outgroup nor the position along its separating branch is inferred or independently verified.',
      'The fraction is measured from the outgroup-side endpoint. Even 0.5 is a chosen placement, not evidence of the true root position.',
      'No collection dates are used by this operation. Date-independence of the user decision is asserted by the user, not tested.',
      'All taxa, topology and pairwise path lengths are retained. Only the separating edge is subdivided; no branch lengths are clipped or refitted.',
      'Original alignment, complete-deletion, distance-model and sampling assumptions still apply. p-distance branch units remain observed differences, not calibrated time.',
      'Bootstrap support belongs to the original unrooted splits and supplies no root-placement support. Zero-length resolutions remain unresolved.',
      'Rooting does not validate a clock, infer dates, estimate populations or establish biological ancestry. Downstream inferences are conditional on the supplied root.',
    ] };
}
async function bindRoot(unrooted: AlignedPhylogenyExperiment, rooting: OutgroupRooting, signal?: AbortSignal): Promise<RootedPhylogenyExperiment> {
  active(signal);
  const result = placeRoot(unrooted, rooting);
  const record = await createAnalysisRecord({ method: ROOTED_PHYLOGENY_METHOD,
    inputs: unrooted.record.inputs.map(({ sha256: _sha, ...input }) => input),
    parameters: analysisJson({ phylogeny: unrooted.options, rooting }) as AnalysisRecord['parameters'], seed: unrooted.options.seed,
    references: [...unrooted.record.references, { id: 'https://phylipweb.github.io/phylip/doc/main.html', version: '3.69',
      description: 'PHYLIP Outgroup option: root placement on a specified separating branch; placement is distinct from unrooted inference.' }],
    fields: { rooting: { kind: 'sequence-score', label: 'Explicit user-conditioned outgroup root with unchanged sequence-distance paths',
      units: 'dimensionless', value: analysisJson(result), coverage: { available: unrooted.result.taxa.length, total: unrooted.result.taxa.length, unit: 'records' }, limitations: result.warnings } } });
  active(signal); return { record, unrooted, result };
}
/** Snapshot the decision first, then verify and recompute the entire original experiment. */
export async function rootAlignedPhylogenyExperiment(content: string, supplied: OutgroupRooting, signal?: AbortSignal): Promise<RootedPhylogenyExperiment> {
  active(signal); const rooting = resolveOutgroupRooting(supplied);
  return bindRoot(await replayAlignedPhylogenyExperiment(content, signal), rooting, signal);
}
/** Derived records retain the original alignment and options, not a trusted cached tree. */
export async function replayRootedPhylogenyExperiment(content: string, signal?: AbortSignal): Promise<RootedPhylogenyExperiment> {
  active(signal);
  const saved = await parseAnalysisRecord(content, { methodId: ROOTED_PHYLOGENY_METHOD.id, methodVersion: ROOTED_PHYLOGENY_METHOD.version });
  if (saved.inputs.length !== 1 || saved.inputs[0].id !== 'alignment' || Object.keys(saved.parameters).sort().join('|') !== 'phylogeny|rooting') {
    throw new Error('Rooted replay requires the original alignment, phylogeny settings and explicit rooting decision.');
  }
  const options = saved.parameters.phylogeny;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).sort().join('|') !== 'bootstrap|deletion|distance|seed') {
    throw new Error('Rooted replay requires every original phylogeny option.');
  }
  const rooting = resolveOutgroupRooting(saved.parameters.rooting as unknown as OutgroupRooting);
  const unrooted = await createAlignedPhylogenyExperiment(saved.inputs[0].data as unknown as PhylogenySource, options as unknown as PhylogenyOptions, signal);
  const replayed = await bindRoot(unrooted, rooting, signal);
  if (replayed.record.cacheKey !== saved.cacheKey || replayed.record.resultId !== saved.resultId) throw new Error('Recomputed rooted phylogeny differs from the saved experiment.');
  return replayed;
}

export const ROOTED_ANCESTRAL_METHOD = { id: 'rooted-nj-ancestral', version: '1.0.0', implementation: 'typescript' } as const;
export interface RootedAncestralSource { content: string; license: string }
export interface PreparedRootedAncestral {
  input: AncestralDataset;
  rootedSource: RootedAncestralSource;
  rootedResultId: string;
  unrootedResultId: string;
}
export interface RootedAncestralExperiment extends PreparedRootedAncestral {
  result: AncestralResult;
  record: AnalysisRecord;
}

/** Derive a fixed substitution-length tree and the SAME alignment columns.
 * Original bytes, header descriptions and the entire inference/root decision
 * remain in rootedSource. FASTA IDs, case, row order and line formatting are
 * normalized to the ancestral parser's exact-tip contract; no columns or taxa
 * are removed, including sites omitted from the parent distance calculation.
 */
export async function prepareRootedAncestralDataset(content: string, license: string,
  signal?: AbortSignal): Promise<PreparedRootedAncestral> {
  active(signal);
  if (typeof license !== 'string' || !license.trim() || license.length > 2000
    || new TextEncoder().encode(license).length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(license)) {
    throw new Error('State the alignment license or usage permission; it is not supplied by the phylogeny record.');
  }
  if (typeof content !== 'string' || content.length > 10 * 1024 * 1024
    || new TextEncoder().encode(content).length > 10 * 1024 * 1024) {
    throw new Error('Rooted phylogeny exceeds the 10 MiB limit.');
  }
  const rooted = await replayRootedPhylogenyExperiment(content.replace(/^\uFEFF/, ''), signal);
  active(signal);
  if (rooted.unrooted.options.distance !== 'jc69' && rooted.unrooted.options.distance !== 'k80') {
    throw new Error('Ancestral handoff requires model-corrected substitution/site branches. Re-infer with JC69 or K80; p-distance is not silently relabeled.');
  }
  const { source, options } = rooted.unrooted;
  const rootedResultId = rooted.record.resultId, unrootedResultId = rooted.unrooted.record.resultId;
  const singleLine = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  const input = validateAncestralDataset({ format: 'phage-explorer-ancestral', version: 1, name: singleLine(source.name),
    source: { kind: source.kind, description: `Conditional reconstruction from verified rooted phylogeny ${rootedResultId}.`,
      reference: singleLine(source.reference), license: license.trim() },
    tree: { newick: rooted.result.newick, units: 'substitutions/site',
      method: `${options.distance.toUpperCase()} neighbor joining ${rooted.unrooted.record.method.version}; original substitution-length branches, not a dated/clock-fitted tree.`,
      rooting: `User-specified root ${rootedResultId}; ${rooted.result.rooting.outgroup.length} outgroup tips; fraction ${rooted.result.rooting.fractionFromOutgroup} from outgroup endpoint. Full choice and evidence retained in the parent.` },
    alignment: { fasta: parseAlignedDNA(source.fasta).map(row => `>${row.id}\n${row.sequence}`).join('\n') + '\n', homologous: true,
      method: 'Original user-supplied homologous columns; normalized FASTA IDs, case, row order and line formatting. No realignment, taxon removal or site deletion.',
      reference: singleLine(source.reference) } });
  active(signal);
  return { input, rootedResultId, unrootedResultId,
    rootedSource: { content: serializeAnalysisRecord(rooted.record), license: license.trim() } };
}

/** Portable lineage binds original aligned DNA, the explicit root and the
 * conditional reconstruction. Replay verifies every numerical stage; a cached
 * rooted Newick or a time-scaled tree cannot replace the parent experiment.
 */
export async function createRootedAncestralExperiment(content: string, license: string,
  supplied: Partial<AncestralOptions> = {}, signal?: AbortSignal,
  progress: (phase: string) => void = () => {}): Promise<RootedAncestralExperiment> {
  active(signal);
  const settings = structuredClone(supplied);
  const report = (phase: string) => { active(signal); progress(phase); active(signal); };
  report('Recomputing original aligned phylogeny and explicit root');
  const prepared = await prepareRootedAncestralDataset(content, license, signal);
  const options = resolveAncestralOptions(parseAncestralFasta(prepared.input.alignment.fasta)[0].sequence.length, settings);
  const result = reconstructAncestors(prepared.input, options, report);
  const parent = JSON.parse(prepared.rootedSource.content) as AnalysisRecord;
  result.warnings.push(
    'The original alignment, neighbor-joining settings and explicit root are retained and recomputed on replay. Reproducibility does not establish homology or root accuracy.',
    'Reconstruction uses the original alignment columns, including columns excluded from distance inference. Its recorded gap/window policy applies separately.',
    'The ancestral substitution model is a separate recorded assumption; the tree distance model does not supply ancestral model parameters. No dating fit or calendar-year branches are reused.',
    ...parent.fields.rooting.limitations,
  );
  active(signal);
  const reconstruction = await createAncestralRecord(prepared.input, result);
  active(signal);
  const record = await createAnalysisRecord({ method: ROOTED_ANCESTRAL_METHOD,
    inputs: [...reconstruction.inputs.map(({ sha256: _sha, ...input }) => input),
      { id: 'rootedPhylogeny', accession: null, source: parent.inputs[0].source,
        description: 'Verified original alignment, phylogeny settings and explicit rooting decision', data: analysisJson(parent) }],
    parameters: reconstruction.parameters, seed: parent.seed,
    references: [...parent.references, ...reconstruction.references],
    fields: { ...reconstruction.fields, lineage: { kind: 'sequence-score', label: 'Verified parent identities', units: 'records',
      value: analysisJson({ rootedResultId: prepared.rootedResultId, unrootedResultId: prepared.unrootedResultId }),
      coverage: { available: 2, total: 2, unit: 'records' },
      limitations: ['Parent verification establishes a reproducible computation, not biological homology, root truth or empirical confidence.'] } } });
  active(signal);
  return { ...prepared, result, record };
}

export async function replayRootedAncestralExperiment(content: string, signal?: AbortSignal,
  progress: (phase: string) => void = () => {}): Promise<RootedAncestralExperiment> {
  active(signal);
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''), { methodId: ROOTED_ANCESTRAL_METHOD.id, methodVersion: ROOTED_ANCESTRAL_METHOD.version });
  active(signal);
  if (saved.inputs.length !== 2 || saved.inputs[0].id !== 'alignmentTree' || saved.inputs[1].id !== 'rootedPhylogeny') {
    throw new Error('Linked ancestral replay requires the original rooted phylogeny and derived alignment/tree input.');
  }
  const input = validateAncestralDataset(saved.inputs[0].data);
  const replayed = await createRootedAncestralExperiment(JSON.stringify(saved.inputs[1].data), input.source.license,
    saved.parameters, signal, progress);
  if (saved.cacheKey !== replayed.record.cacheKey || saved.resultId !== replayed.record.resultId) {
    throw new Error('Fresh linked ancestral evidence differs from the saved experiment.');
  }
  return replayed;
}
