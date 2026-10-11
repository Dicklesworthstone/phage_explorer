/** Explicit root hypotheses on a verified NJ tree, without estimating a biological root. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { createAlignedPhylogenyExperiment, replayAlignedPhylogenyExperiment, PHYLOGENY_LIMITS,
  type AlignedPhylogenyExperiment, type NeighborJoiningTree, type PhylogenyOptions, type PhylogenySource } from './aligned-phylogeny';

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
