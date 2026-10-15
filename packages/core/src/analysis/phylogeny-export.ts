/** Interoperable views of a computed phylogeny. Replay untrusted records before exporting. */
import type { AlignedPhylogenyExperiment } from './aligned-phylogeny';

export const PHYLOGENY_EXPORT_FORMATS = ['newick', 'distances-tsv', 'splits-tsv', 'alignment-fasta'] as const;
export type PhylogenyExportFormat = typeof PHYLOGENY_EXPORT_FORMATS[number];

/** Use the same unrooted bipartition from either side of an edge. */
function splitKey(side: readonly string[], all: readonly string[]): string {
  const one = [...side].sort(), members = new Set(one), two = all.filter(id => !members.has(id)).sort();
  const a = JSON.stringify(one), b = JSON.stringify(two);
  return one.length < two.length || one.length === two.length && a < b ? a : b;
}

/** Internal node labels are bootstrap percentages, NOT ancestral names or probabilities. */
export function exportSupportedNewick(experiment: AlignedPhylogenyExperiment): string {
  const { tree, taxa, splits, bootstrap } = experiment.result;
  const links = tree.nodes.map(() => [] as Array<{ node: number; length: number }>);
  for (const edge of tree.edges) {
    links[edge.a].push({ node: edge.b, length: edge.length });
    links[edge.b].push({ node: edge.a, length: edge.length });
  }
  const support = new Map(splits.map(split => [splitKey(split.side, taxa), split.support]));
  const render = (id: number, parent: number): { text: string; leaves: string[] } => {
    const label = tree.nodes[id].label;
    if (label !== null) return { text: `'${label.replace(/'/g, "''")}'`, leaves: [label] };
    const leaves: string[] = [];
    const children = links[id].filter(link => link.node !== parent).map(link => {
      const child = render(link.node, id);
      leaves.push(...child.leaves);
      const fraction = tree.nodes[link.node].label === null && bootstrap.supportAvailable
        ? support.get(splitKey(child.leaves, taxa)) : null;
      const annotation = fraction === null || fraction === undefined ? '' : String(Number((100 * fraction).toPrecision(10)));
      return `${child.text}${annotation}:${Object.is(link.length, -0) ? 0 : link.length}`;
    });
    return { text: `(${children.join(',')})`, leaves };
  };
  // Explicitly unrooted: the serialization root is not an inferred ancestor.
  return `[&U]${render(tree.serializationRoot, -1).text};\n`;
}

export function exportPhylogeny(experiment: AlignedPhylogenyExperiment, format: PhylogenyExportFormat): string {
  if (format === 'newick') return exportSupportedNewick(experiment);
  if (format === 'alignment-fasta') return experiment.source.fasta;
  const { result, options, record } = experiment;
  const metadata = `# method\t${record.method.id}\n# method_version\t${record.method.version}\n# result_id\t${record.resultId}\n# distance_method\t${options.distance}\n# used_sites\t${result.usedSites}\n`;
  if (format === 'distances-tsv') {
    return metadata + ['taxon\t' + result.taxa.join('\t'), ...result.taxa.map((id, i) =>
      [id, ...result.distances[i]].join('\t'))].join('\n') + '\n';
  }
  if (format === 'splits-tsv') {
    const header = 'side_json\tother_side_json\tbranch_length\tbootstrap_count\tbootstrap_requested\tbootstrap_completed\tbootstrap_saturated\tsupport_fraction';
    return metadata + [header, ...result.splits.map(split => [JSON.stringify(split.side), JSON.stringify(split.other), split.length,
      split.bootstrapCount ?? '', result.bootstrap.requested, result.bootstrap.completed, result.bootstrap.saturated,
      split.support ?? ''].join('\t'))].join('\n') + '\n';
  }
  throw new Error('Unsupported phylogeny export format.');
}
